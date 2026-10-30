import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatEvent, ChatRequest, HarnessEvent, ToolContext } from '../../src/types';
import { from, model, unwrapped } from '../helpers';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), listModels: vi.fn(), isFast: vi.fn() }));
vi.mock('../../src/llm', () => mocks);
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../src/log', () => log);
// Its own note, which it is given at the start of a run (see readContext)
const sandbox = vi.hoisted(() => ({ readContext: vi.fn() }));
vi.mock('../../src/sandbox', () => sandbox);

import {
  CODER,
  EXPLORER,
  REVIEWER,
  TOOL_NAME,
  WORKER,
  byName,
  parse,
  prompt,
  reviewComments,
} from '../../src/subagents';
import { forgetThread, stepsFor, stillRunning, waitFor } from '../../src/subagents/run';
import * as mailbox from '../../src/subagents/mailbox';
import { tool } from '../../src/tools/subagents';
import * as cachelock from '../../src/llm/cachelock';
import * as tools from '../../src/harness/tools';
import { SUBAGENT_PROMPT } from '../../src/harness/notes';
import * as discoveries from '../../src/harness/discoveries';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const small = model({ id: 'llama:3b', sophistication: 1 });

// Every event the subagents reported, and the requests they made
const seen: HarnessEvent[] = [];
const requests = () => mocks.stream.mock.calls.map(([request]) => request as ChatRequest);
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  threadId: THREAD,
  model: { provider: 'local', model: 'llama:3b' },
  emit: (event) => seen.push(event),
});

const text = (delta: string): ChatEvent => ({ type: 'text', delta });
const done = (stopReason = 'end_turn', usage?: { input: number; output: number }): ChatEvent => ({
  type: 'done',
  stopReason,
  usage,
});
const call = (id: string, name: string, input: Record<string, unknown> = {}): ChatEvent => ({
  type: 'tool_call',
  id,
  name,
  input,
});
// Replies by the task each subagent was given, so the order they run in
// doesn't decide which reply they get
function answers(byTask: Record<string, ChatEvent[][]>) {
  const left = new Map(Object.entries(byTask).map(([task, replies]) => [task, [...replies]]));
  mocks.stream.mockImplementation((request: ChatRequest) => {
    const task = String(request.messages[0].content);
    const queue = [...left].find(([key]) => task.includes(key))?.[1];
    return from(queue?.shift() ?? [text('nothing'), done()]);
  });
}
// Whether a request is one of the rounds that asks for the report rather than
// for more work. Its tools no longer say — they are the same on every round
// now (see tools in run.ts) — so what it was told is what tells them apart.
const reportAsked = (request: ChatRequest) => {
  const last = String(request.messages.at(-1)?.content ?? '');
  return last.includes('Report what you have found now') || last.includes('You stopped without reporting anything');
};
const task = (name: string, what: string) => ({ name, task: what });
const run = (tasks: unknown, ctx = context()) => tool.run({ tasks }, ctx) as Promise<string>;
const updates = (id?: string) =>
  seen
    .filter((e) => e.type === 'subagent_update' && (!id || e.id === id))
    .map((e) => (e as { event: AgentEvent }).event)
    .map((event) => {
      if (event.type === 'thought') return event.text;
      if (event.type === 'condensing') return 'condensing';
      if (event.type === 'condensed') return event.changed ? 'condensed' : 'condensed (unchanged)';
      if (event.type === 'shortening') return 'shortening';
      if (event.type === 'progress') return `progress ${event.percent}`;
      if (event.type === 'tool_call') return `${event.name}(${JSON.stringify(event.input ?? {})})`;
      return `${event.isError ? 'failed' : 'returned'}: ${event.output}`;
    });

beforeEach(() => {
  seen.length = 0;
  sandbox.readContext.mockReset();
  sandbox.readContext.mockResolvedValue('');
  mocks.stream.mockReset();
  mocks.listModels.mockResolvedValue({ models: [small], providers: [] });
  tools.clear();
  answers({});
});

describe('a reviewer', () => {
  const comment = (id: string, body: string) => ({ id, body });

  it('is told it has one comment, that others have the rest, and to reply to its own', () => {
    expect(unwrapped(REVIEWER.prompt)).toContain('You are a reviewer');
    expect(unwrapped(REVIEWER.prompt)).toContain('one of those comments');
    expect(unwrapped(REVIEWER.prompt)).toContain('Other reviewers have the others');
    expect(unwrapped(REVIEWER.prompt)).toContain('reply_to_comment');
    expect(unwrapped(REVIEWER.prompt)).toContain('Do not change anything the comment is not about');
    // What it says to the user is the point, not what it reports back
    expect(unwrapped(REVIEWER.prompt)).toContain('That reply is what the user reads');
  });

  it('runs one per comment, at once, each told only its own', async () => {
    answers({ c1: [[text('Renamed it.'), done()]], c2: [[text('It is for the cache.'), done()]] });
    const report = await reviewComments(
      [
        comment('c1', '[c1] src/a.ts, line 3\n> const x = 1\nMe: rename this'),
        comment('c2', '[c2] src/b.ts\nMe: what is this for?'),
      ],
      context()
    );
    expect(requests()).toHaveLength(2);
    for (const request of requests()) expect(request.system).toContain(REVIEWER.prompt);
    // Each sees its own comment and no other
    const [first, second] = requests().map((r) => String(r.messages[0].content));
    expect(first).toContain('rename this');
    expect(first).not.toContain('what is this for?');
    expect(second).toContain('what is this for?');
    // ...and each is named by the comment it answered
    expect(report).toContain('## c1\n\nRenamed it.');
    expect(report).toContain('## c2\n\nIt is for the cache.');
  });

  it('shows up as a reviewer in the thread, under the comment id', async () => {
    answers({ c1: [[text('Done.'), done()]] });
    await reviewComments([comment('c1', '[c1] src/a.ts\nMe: fix this')], context());
    expect(seen.find((e) => e.type === 'subagent')).toMatchObject({ kind: 'reviewer', name: 'c1' });
  });

  it('may reply to the comment it was given', async () => {
    tools.register({
      name: 'reply_to_comment',
      description: 'Reply.',
      inputSchema: { type: 'object' },
      needsReview: true,
      run: () => 'Reply posted.',
    });
    answers({ c1: [[text('Done.'), done()]] });
    await reviewComments([comment('c1', '[c1] src/a.ts\nMe: fix this')], context());
    expect(requests()[0].tools?.map((t) => t.name)).toContain('reply_to_comment');
  });
});

describe('being told to break the work up', () => {
  it('is only said to a model capable enough to break a problem up well', () => {
    // 3 and up: a large local model, or a mid-tier hosted one
    expect(unwrapped(prompt(5))).not.toBe('');
    expect(unwrapped(prompt(4))).not.toBe('');
    expect(unwrapped(prompt(3))).not.toBe('');
    expect(unwrapped(prompt(2))).toBe('');
    expect(unwrapped(prompt(1))).toBe('');
  });

  it('is not said to a model whose level is not known', () => {
    expect(unwrapped(prompt(undefined))).toBe('');
  });

  it('is not said to a model with no tools to hand anything to', () => {
    expect(unwrapped(prompt(5, false))).toBe('');
  });

  // Each step that holds tools has its own account of what it hands out, in the
  // terms of that step, and two accounts of it is how one of them ends up
  // untrue: the doing step holds no tool that writes a file, so being told to
  // keep the hard parts for itself is being told to keep what it cannot make
  // (see PROMPTS.execute in ../../src/harness/phases.ts)
  it('is not said in a step of a coding change, which says it for itself', () => {
    for (const phase of ['explore', 'execute'] as const) {
      expect(unwrapped(prompt(5, true, phase)), phase).toBe('');
    }
    // ...and is still said to a reply that is not worked through in steps
    expect(unwrapped(prompt(5, true, undefined))).not.toBe('');
  });

  it('tells it to look at the whole job first, and to split nothing that is really one piece', () => {
    const said = unwrapped(prompt(5));
    expect(said).toContain('look at the whole of it');
    expect(said).toContain('work out which parts do not depend on each other');
    // The split that costs more than it saves, named so it can be refused
    expect(said).toContain('nothing that is really one piece');
  });

  it('says what makes a piece worth handing out: that it is plainer than the whole', () => {
    const said = unwrapped(prompt(5));
    expect(said).toContain('plainer than the whole');
    expect(said).toContain('needs to know nothing about the rest of the job');
    // ...with examples, since "independent" alone is not something to act on
    for (const kind of ['reading how one thing works', 'the same small change in each of', 'used anywhere']) {
      expect(said).toContain(kind);
    }
  });

  it('says what to keep for itself: the parts that need the whole picture', () => {
    const said = unwrapped(prompt(5));
    expect(said).toContain('need the whole picture');
    expect(said).toContain('deciding the shape of the answer');
    expect(said).toContain('the last word on what the user gets');
  });

  // How to write one piece — which kind it wants, that a subagent cannot see
  // this conversation, not handing out what one tool call would do, not giving
  // two of them the same file — is in the handout tool's own description, which
  // is in front of the model at the moment it writes the piece. Said here as
  // well it was paid for twice on every round, and naming the kinds in two
  // places is what let this contradict the step that may send only one of them
  // (see ../tools/subagents.test.ts, which holds these).
  it('names the tool, and leaves what goes in a piece to the tool itself', () => {
    const said = unwrapped(prompt(5));
    expect(said).toContain(TOOL_NAME);
    for (const elsewhere of [
      'cannot see this conversation',
      'Say which kind of subagent each piece wants',
      'a coder to make a change',
      'the same file to write',
      'single tool call',
    ]) {
      expect(said).not.toContain(elsewhere);
    }
  });

  it('says to use the findings for the part only it can do', () => {
    expect(unwrapped(prompt(5))).toContain('use them to do the part only you can do');
  });
});

describe('the tool it offers', () => {
  it('is named for what it is for, and says why a piece is better done apart', () => {
    expect(tool.name).toBe('hand_to_subagent');
    expect(tool.description).toContain('same container on the same files');
    expect(tool.description).toContain('do not depend on each other');
    // What handing a piece out is really for: the piece is done by someone
    // holding only the piece
    expect(unwrapped(tool.description)).toContain('starts with nothing but the task you write for it');
    expect(unwrapped(tool.description)).toContain('holding the whole conversation alongside it');
    // ...and the speed is said second, not first
    expect(unwrapped(tool.description)).toContain('They also run at the same time');
    expect(tool.description).not.toMatch(/up to \d+ pieces/);
    expect(tool.inputSchema).toMatchObject({ required: ['tasks'] });
  });

  it.each([
    [undefined, '"tasks" must be a non-empty array'],
    [[], '"tasks" must be a non-empty array'],
    [[{ name: 'a' }], 'Task 1 has no "task" to do.'],
    [[{ name: 'a', task: '  ' }], 'Task 1 has no "task" to do.'],
  ])('refuses the tasks %j', async (tasks, message) => {
    await expect(run(tasks)).rejects.toThrow(message);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('runs as many pieces as it is given, there being no number that is too many', async () => {
    const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`, `do ${i}`));
    answers(Object.fromEntries(many.map(({ task: what }) => [what, [[text('Done.'), done()]]])));
    await run(many);
    expect(seen.filter((event) => event.type === 'subagent')).toHaveLength(12);
  });

  it('names a piece that was given none, rather than refusing it', async () => {
    await run([{ task: 'look around' }]);
    expect(seen[0]).toMatchObject({ type: 'subagent', name: 'task 1' });
  });

  it('refuses when there is no model to run them with', async () => {
    await expect(run([task('a', 'do a')], { ...context(), model: undefined })).rejects.toThrow(
      'No model is available to run subagents.'
    );
  });

  it("is given its own note at the start of a run, and nobody else's", async () => {
    sandbox.readContext.mockImplementation(async (_thread: string, agent: string) =>
      agent === 'a' ? 'What a kept.' : ''
    );
    answers({ 'do a': [[text('Done.'), done()]], 'do b': [[text('Done.'), done()]] });
    await run([task('a', 'do a'), task('b', 'do b')]);
    expect(sandbox.readContext).toHaveBeenCalledWith(THREAD, 'a');
    expect(sandbox.readContext).toHaveBeenCalledWith(THREAD, 'b');

    const systems = requests().map(({ system }) => String(system));
    // The one with a note is told it, and told it is nobody else's
    const withNote = systems.find((one) => one.includes('What a kept.'))!;
    expect(withNote).toContain('Nobody else can write to it.');
    // The one without is given its prompt and nothing more
    expect(systems.filter((one) => one.includes('What a kept.'))).toHaveLength(1);
  });

  it('passes the subagent doing the work to every tool it calls', async () => {
    const seenAgents: (string | undefined)[] = [];
    tools.register({
      name: 'look',
      description: 'Look.',
      inputSchema: { type: 'object' },
      run: (_input, ctx) => {
        seenAgents.push(ctx.agent);
        return 'looked';
      },
    });
    answers({
      'do a': [
        [call('t1', 'look', {}), done('tool_use')],
        [text('A done.'), done()],
      ],
      'do b': [
        [call('t2', 'look', {}), done('tool_use')],
        [text('B done.'), done()],
      ],
    });
    await run([task('a', 'do a'), task('b', 'do b')]);
    expect(seenAgents.sort()).toEqual(['a', 'b']);
  });

  it('refuses an explorer in a thread with no workspace, rather than sending it nowhere', async () => {
    await expect(run([{ ...task('look', 'look around'), kind: 'explorer' }])).rejects.toThrow(
      'The "explorer" kind of subagent works in the workspace the thread was started in, and this thread has none.'
    );
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('runs an explorer in a thread that has a workspace', async () => {
    answers({ 'look around': [[text('Found it.'), done()]] });
    const report = await run([{ ...task('look', 'look around'), kind: 'explorer' }], {
      ...context(),
      workspace: '/projects/demo',
    });
    expect(report).toBe('## look\n\nFound it.');
    expect(requests()[0].system).toContain(EXPLORER.prompt);
  });

  // The general instruction is to keep what you find by writing it into your
  // reply, since nothing else keeps it (see harness/discoveries.ts). An
  // explorer's findings have a better home than that — the workspace's notes,
  // which outlive the thread — and its report is deliberately a level up from
  // them, so telling it the general thing would tell it to undo its own
  // prompt (see Kind.saysNotes).
  it('spares the kinds that write notes the general instruction to keep findings in the reply', async () => {
    // A tool both kinds may use, so that each is given the part of the prompt
    // that only a subagent with tools is given at all
    tools.register({ name: 'read_file', description: 'Reads.', inputSchema: { type: 'object' }, run: () => 'Read.' });
    answers({
      'look around': [[text('Found it.'), done()]],
      'check it': [[text('Checked.'), done()]],
    });
    await run([{ ...task('look', 'look around'), kind: 'explorer' }, task('other', 'check it')], {
      ...context(),
      workspace: '/projects/demo',
    });
    const systems = requests().map(({ system }) => String(system));
    const kept = 'Write down what you find out as you go, in your reply';
    expect(systems.find((said) => said.includes(EXPLORER.prompt))).not.toContain(kept);
    // ...while a worker, whose findings have nowhere else to go, is told it
    expect(systems.find((said) => said.startsWith(WORKER.prompt))).toContain(kept);
    // The line asserted above is the one the module actually says
    expect(discoveries.prompt('local')).toContain(kept);
  });

  it('runs each task as the kind it asks for, and defaults to a worker', async () => {
    answers({ 'write it': [[text('Written.'), done()]], 'check it': [[text('Checked.'), done()]] });
    await run([{ ...task('code', 'write it'), kind: 'coder' }, task('other', 'check it')]);
    // Each is told what its kind is told, with what every subagent is told
    // after it (see OWN_NOTE in run.ts)
    const systems = requests().map(({ system }) => String(system));
    expect(systems.some((said) => said.startsWith(CODER.prompt))).toBe(true);
    expect(systems.some((said) => said.startsWith(WORKER.prompt))).toBe(true);
  });

  it('asks how much is left now and then, and keeps the answer out of the work', async () => {
    // Three rounds of tool calls, so the third is the one that is asked
    const round = (id: string): ChatEvent[] => [call(id, 'look', {}), done('tool_use')];
    tools.register({ name: 'look', description: 'Looks.', inputSchema: { type: 'object' }, run: () => 'Looked.' });
    answers({
      'do a': [
        round('n1'),
        round('n2'),
        [text('Remaining: 25%\nStill reading.'), ...round('n3')],
        [text('Done.'), done()],
      ],
    });
    await run([task('a', 'do a')]);

    // Asked in a turn of its own, the instructions being the same at every
    // step of a run: they sign the model's thinking (see tell in run.ts)
    const systems = requests().map((request) => unwrapped(String(request.system)));
    expect(new Set(systems).size).toBe(1);
    expect(systems[2]).not.toContain('Remaining: NN%');
    // Asked after the second round of calls and before the third, once, and
    // left in the conversation as any other turn is
    const conversation = requests().at(-1)!.messages;
    // prettier-ignore
    expect(conversation.map(({ role }) => role))
      .toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user', 'assistant', 'tool']);
    expect(String(conversation[5].content)).toContain('Remaining: NN%');
    expect(conversation.filter((m) => String(m.content).includes('Remaining: NN%'))).toHaveLength(1);
    // What it said is a status for the window...
    expect(seen).toContainEqual({
      type: 'subagent_update',
      id: expect.any(String),
      event: { type: 'progress', percent: 75 },
    });
    // ...and is taken out of what it said, which is its own work
    expect(updates()).toContain('Still reading.');
    expect(updates().join(' ')).not.toContain('Remaining:');
  });

  it('tells each kind how much room its report has, in its own figure', async () => {
    answers({ 'write it': [[text('Written.'), done()]], 'check it': [[text('Checked.'), done()]] });
    await run([{ ...task('code', 'write it'), kind: 'coder' }, task('other', 'check it')]);
    // The limit is enforced by cutting the report, so a kind that is not told
    // its own figure runs past it and stops mid-sentence (see room in run.ts)
    const systems = requests().map((request) => unwrapped(String(request.system)));
    expect(systems[0]).toContain(`fit in ${CODER.result} characters`);
    expect(systems[1]).toContain(`fit in ${WORKER.result} characters`);
    for (const said of systems) expect(said).toContain('cut off mid-sentence');
  });

  it('tells each piece how many rounds it has, in its own figure', async () => {
    answers({ 'write it': [[text('Written.'), done()]], 'check it': [[text('Checked.'), done()]] });
    await run([{ ...task('code', 'write it'), kind: 'coder' }, task('other', 'check it')]);
    // Told for the same reason the report length is: the limit is enforced by
    // taking the tools away, so a piece that is not told its own figure finds
    // it out by being cut off (see rounds in run.ts)
    const systems = requests().map((request) => unwrapped(String(request.system)));
    expect(systems[0]).toContain(`You have ${CODER.steps} rounds of tool calls`);
    expect(systems[1]).toContain(`You have ${WORKER.steps} rounds of tool calls`);
    for (const said of systems) expect(said).toContain('a ceiling, not a target');
  });

  it('tells it the number it actually has, not its kind’s, where the effort changes it', async () => {
    answers({ 'do a': [[text('Done.'), done()]] });
    // A piece of low effort gets half its kind's rounds (see stepsFor)
    await run([{ ...task('a', 'do a'), effort: 'low' }]);
    expect(unwrapped(String(requests()[0].system))).toContain(
      `You have ${Math.round(WORKER.steps / 2)} rounds of tool calls`
    );
  });

  it('runs an explorer on a local model, leaving the hosted ones for the thread', async () => {
    const big = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
    const mid = model({ id: 'qwen:32b', sophistication: 3 });
    mocks.listModels.mockResolvedValue({ models: [big, mid, small], providers: [] });
    answers({ 'look around': [[text('Found it.'), done()]] });
    await run([{ ...task('look', 'look around'), kind: 'explorer', complexity: 4 }], {
      ...context(),
      workspace: '/projects/demo',
    });
    // Rated 4, which nothing local meets: it gives up the level rather than
    // the queue (see Prefer in subagents/kind.ts)
    expect(requests()[0]).toMatchObject({ provider: 'local', model: 'qwen:32b' });
  });

  it('runs a worker wherever the rating sends it, exploring being the exception', async () => {
    const big = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
    const mid = model({ id: 'qwen:32b', sophistication: 3 });
    mocks.listModels.mockResolvedValue({ models: [big, mid, small], providers: [] });
    answers({ 'do a': [[text('Done.'), done()]] });
    await run([{ ...task('a', 'do a'), complexity: 4 }]);
    expect(requests()[0]).toMatchObject({ provider: 'anthropic', model: 'opus' });
  });

  it('tells every kind to report in plain prose, since a model reads it', async () => {
    answers({ 'do a': [[text('Done.'), done()]] });
    await run([task('a', 'do a')]);
    const said = unwrapped(String(requests()[0].system));
    expect(said).toContain('Write your report as plain prose');
    expect(said).toContain('No Markdown');
    // ...and only the report: what it writes through a tool is that tool's
    expect(said).toContain("is that tool's business and not covered here");
  });

  // A report long enough to stand as one: a shortening that comes back a
  // fraction of the room it was given has thrown the report away rather than
  // shortened it, and is not taken (see KEEPS in run.ts)
  const report = (tag: string, length: number) => `${tag} ${'x'.repeat(length)}`;

  it('asks a subagent that ran over its limit to shorten its own report', async () => {
    const long = report('OVERLONG', WORKER.result);
    const short = report('SHORTENED', 2000);
    answers({ 'do a': [[text(long), done()]], OVERLONG: [[text(short), done()]] });
    const report_ = await run([task('a', 'do a')]);
    expect(report_).toBe(`## a\n\n${short}`);

    // It is given its own words and the limit and nothing else: no task, no
    // tool results, nothing of its kind's prompt to be drawn back into
    const asked = requests()[1];
    expect(asked.messages).toHaveLength(1);
    expect(asked.messages[0].content).toBe(long);
    expect(asked.tools ?? []).toHaveLength(0);
    // ...and how far over it is, which is a target rather than a complaint
    expect(unwrapped(String(asked.system))).toContain(`has to fit in ${WORKER.result}`);
    expect(unwrapped(String(asked.system))).toContain(`it is ${long.length} characters`);
    expect(String(asked.system)).not.toContain(WORKER.prompt);
    expect(String(asked.system)).not.toContain('do a');
    // ...and the thread is told why there are two reports in its work
    expect(updates()).toContain('shortening');
  });

  it('keeps the report it had when shortening it comes back no shorter', async () => {
    const long = `OVERLONG ${'x'.repeat(WORKER.result)}`;
    answers({ 'do a': [[text(long), done()]], OVERLONG: [[text(''), done()]] });
    const report = await run([task('a', 'do a')]);
    // Cut, as before: losing the report to the business of shortening it
    // would be worse than printing it long
    expect(report).toBe(`## a\n\n${long.slice(0, WORKER.result)}`);
  });

  // A model often takes a long report most of the way down and stops short of
  // the limit. Cutting there throws away the end of a report that one more ask
  // would have made fit, and the end is where it says what it found.
  it('asks again while the report is still over, starting from the shortest it has', async () => {
    const long = report('OVERLONG', 6000);
    const still = report('STILLOVER', 5000);
    const fits = report('FITS', 3000);
    answers({
      'do a': [[text(long), done()]],
      OVERLONG: [[text(still), done()]],
      STILLOVER: [[text(fits), done()]],
    });
    expect(await run([task('a', 'do a')])).toBe(`## a\n\n${fits}`);

    // Each ask is given what the last one managed, not the whole thing again
    expect(requests()).toHaveLength(3);
    expect(requests()[1].messages[0].content).toBe(long);
    expect(requests()[2].messages[0].content).toBe(still);
    // ...and it stops as soon as it fits, rather than using up its asks
    expect(updates().filter((update) => update === 'shortening')).toHaveLength(1);
  });

  it('cuts the end off only once it has run out of asks', async () => {
    const stages = [6000, 5500, 5200, 5000].map((n, i) => report(`STAGE${i}`, n));
    answers({
      'do a': [[text(stages[0]), done()]],
      STAGE0: [[text(stages[1]), done()]],
      STAGE1: [[text(stages[2]), done()]],
      STAGE2: [[text(stages[3]), done()]],
    });
    const report_ = await run([task('a', 'do a')]);
    // Three asks, and the shortest of them cut where it still would not fit
    expect(requests()).toHaveLength(4);
    expect(report_).toBe(`## a\n\n${stages[3].slice(0, WORKER.result)}`);
  });

  it('keeps the shortest it got when a later ask comes back with nothing', async () => {
    const long = report('OVERLONG', 6000);
    const still = report('STILLOVER', 5000);
    answers({
      'do a': [[text(long), done()]],
      OVERLONG: [[text(still), done()]],
      STILLOVER: [[text(''), done()]],
    });
    expect(await run([task('a', 'do a')])).toBe(`## a\n\n${still.slice(0, WORKER.result)}`);
  });

  // It was asked to lose nothing it means, so a reply that is a fraction of
  // the room it was given has not shortened the report, it has thrown it away
  it('will not take a shortening that has gutted the report, and asks again', async () => {
    const long = report('OVERLONG', 6000);
    const kept = report('KEPT', 3000);
    answers({
      'do a': [[text(long), done()]],
      OVERLONG: [
        [text('Short enough.'), done()],
        [text(kept), done()],
      ],
    });
    expect(await run([task('a', 'do a')])).toBe(`## a\n\n${kept}`);
    // The second ask started from the report, not from what was thrown away
    expect(requests()[2].messages[0].content).toBe(long);
  });

  it('does not ask for a shorter report when what it wrote already fits', async () => {
    answers({ 'do a': [[text('Short.'), done()]] });
    await run([task('a', 'do a')]);
    expect(requests()).toHaveLength(1);
    expect(updates()).not.toContain('shortening');
  });

  it('tells every kind that the note it keeps is its own, and routes it there', async () => {
    answers({
      'do a': [
        [call('n1', 'add_to_context', { content: 'found it' }), done('tool_use')],
        [text('Done.'), done()],
      ],
    });
    const seenContexts: ToolContext[] = [];
    tools.register({
      name: 'add_to_context',
      description: 'Adds to the note.',
      inputSchema: { type: 'object' },
      run: (_input, ctx) => {
        seenContexts.push(ctx);
        return 'Added.';
      },
    });
    await run([task('a', 'do a')]);

    const said = unwrapped(String(requests()[0].system));
    expect(said).toContain('You have a context note of your own');
    expect(said).toContain('not the thread’s, and not any other subagent’s'.replace(/’/g, "'"));
    expect(said).toContain('Add to it with add_to_context as you go');
    // ...and what it writes goes to its own file, by the name it is known by
    expect(seenContexts[0].agent).toBe('a');
  });

  it('says when it has condensed what it found, once it has been cut off with nothing written', async () => {
    let asked = 0;
    mocks.stream.mockImplementation(() => from(++asked === 1 ? [done('length')] : [text('Found it.'), done()]));
    await run([task('a', 'do a')]);
    const said = updates();
    expect(said.indexOf('condensing')).toBeGreaterThanOrEqual(0);
    // Said again when it is over, whether or not anything came of it
    expect(said[said.indexOf('condensing') + 1]).toMatch(/^condensed/);
  });

  it('says a subagent was cut off, rather than that it reported nothing', async () => {
    const controller = new AbortController();
    mocks.stream.mockImplementation(() => {
      controller.abort();
      return from([call('c1', 'read_file'), done('tool_use')]);
    });
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => '' });
    const said = await run([task('a', 'do a')], { ...context(), signal: controller.signal });

    // What happened was the clock, not the model: saying so is the difference
    // between looking at the deadline and looking at the prompt
    expect(said).toContain('was cut off before it could report');
    expect(said).toContain('whoever sent it ran out of time');
    expect(said).toContain('It was on round 1 of');
    // ...and it stopped there, rather than working through the rounds it had
    // left, each one a call the provider refuses as it is made
    expect(requests()).toHaveLength(1);
    expect(said).not.toContain('finished without reporting anything');
  });

  it('still says so plainly when it had the time and used none of it', async () => {
    answers({ 'do a': [[done('end_turn')], [done('end_turn')]] });
    const said = await run([task('a', 'do a')]);
    expect(said).toContain('finished without reporting anything');
  });

  it('refuses a kind there is no such thing as, and says which there are', async () => {
    await expect(run([{ ...task('a', 'do a'), kind: 'architect' }])).rejects.toThrow(
      'Task 1 asks for a "architect" subagent; there is only: coder, explorer, worker, agent.'
    );
  });

  it('will not be asked for a reviewer: one is sent per comment, never chosen', async () => {
    await expect(run([{ ...task('a', 'do a'), kind: 'reviewer' }])).rejects.toThrow('there is only: coder, explorer');
    expect(byName('reviewer')).toBeUndefined();
  });
});

describe("what a subagent is told about the workspace's notes", () => {
  // The real pair, by name: what is said depends on the tools being there to
  // use (see notesFor in run.ts), and nothing else about them matters here
  const notesTools = () => {
    for (const name of ['search_workspace_notes', 'add_workspace_note']) {
      tools.register({
        name,
        description: 'Notes.',
        inputSchema: { type: 'object' },
        needsWorkspace: true,
        run: () => '',
      });
    }
  };
  const said = () => requests().map((request) => unwrapped(String(request.system)));

  it('tells a coder and a worker to look there before they go looking themselves', async () => {
    notesTools();
    answers({ 'write it': [[text('Written.'), done()]], 'check it': [[text('Checked.'), done()]] });
    await run([{ ...task('code', 'write it'), kind: 'coder' }, task('other', 'check it')], {
      ...context(),
      workspace: '/projects/demo',
    });
    // Every kind that has the tools is told it, not only the one sent to
    // explore: a coder works out the command the tests need on its way to
    // making one change, and nobody is sent to find that out again
    for (const one of said()) {
      expect(one).toContain(unwrapped(SUBAGENT_PROMPT));
      expect(one).toContain('Search them before you go looking yourself');
      // Every finding, not only what it searched for and did not find
      expect(one).toContain('Write back every finding');
      expect(one).toContain('not only the ones that fill a gap you went looking for');
    }
  });

  it('says nothing of them in a thread with no workspace, there being none to search', async () => {
    notesTools();
    answers({ 'check it': [[text('Checked.'), done()]] });
    await run([task('other', 'check it')]);
    // The tools are filtered out of what it is offered, so being told to use
    // them would cost it a round to find that out (see specsFor)
    expect(said()[0]).not.toContain('Search them before you go looking yourself');
  });

  it('says nothing of them to a kind that cannot use them, either', async () => {
    answers({ 'check it': [[text('Checked.'), done()]] });
    await run([task('other', 'check it')], { ...context(), workspace: '/projects/demo' });
    expect(said()[0]).not.toContain('Search them before you go looking yourself');
  });

  it('leaves an explorer to its own prompt, which is about the notes already', async () => {
    notesTools();
    answers({ 'look around': [[text('Found it.'), done()]] });
    await run([{ ...task('look', 'look around'), kind: 'explorer' }], {
      ...context(),
      workspace: '/projects/demo',
    });
    // It would otherwise be told the general thing straight after the
    // particular one (see Kind.saysNotes)
    expect(said()[0]).not.toContain(unwrapped(SUBAGENT_PROMPT));
    expect(said()[0]).toContain('Start with search_workspace_notes');
  });
});

describe('running the pieces', () => {
  it('runs them at once, in the same container, and brings back what each found', async () => {
    answers({
      'read the tests': [[text('The tests use vitest.'), done()]],
      'read the build': [[text('It builds with tsc.'), done()]],
    });
    const report = await run([task('tests', 'read the tests'), task('build', 'read the build')]);

    expect(report).toBe('## tests\n\nThe tests use vitest.\n\n## build\n\nIt builds with tsc.');
    // Both were under way before either had answered
    expect(requests()).toHaveLength(2);
    // Each is told it is one of several, working on the same files
    for (const request of requests()) {
      expect(request.system).toContain(WORKER.prompt);
      expect(request.system).toContain('same container, on the same files');
      expect(request.model).toBe('llama:3b');
    }
  });

  // A local model keeps the work it did on one prompt, and these are prompts of
  // their own: the thread that handed the work out has nothing more to send
  // until they come back, and each of them wants the model in turn rather than
  // a round each (see src/llm/cachelock.ts)
  describe('taking their turn at a local model', () => {
    const held = cachelock.modelKey('local', 'llama:3b');

    it('gives up what the thread was holding, so the first of them starts at once', async () => {
      answers({ 'read the tests': [[text('The tests use vitest.'), done()]] });
      cachelock.held(held, THREAD);
      await run([task('tests', 'read the tests')]);
      expect(cachelock.holder(held)).toBeUndefined();
    });

    it('gives up its own when it has finished, so the next one has the model', async () => {
      answers({ 'read the tests': [[text('The tests use vitest.'), done()]] });
      // Its own prompt is kept under its own key (see ChatRequest.cacheKey)
      cachelock.held(held, `${THREAD}/tests`);
      await run([task('tests', 'read the tests')]);
      expect(requests()[0].cacheKey).toBe(`${THREAD}/tests`);
      expect(cachelock.holder(held)).toBeUndefined();
    });
  });

  it('reports each one starting, what it does, and what it brought back', async () => {
    answers({
      'look around': [[{ type: 'reasoning', delta: 'Starting on it.' } as ChatEvent, text('I looked.'), done()]],
    });
    await run([task('looking', 'look around')]);
    const started = seen.find((e) => e.type === 'subagent') as { id: string; name: string; task: string };
    expect(started).toMatchObject({ name: 'looking', task: 'look around' });
    // Its own reasoning is what is shown of its work as it goes
    expect(updates(started.id)).toEqual(['Starting on it.']);
    expect(seen.at(-1)).toEqual({ type: 'subagent_done', id: started.id, text: 'I looked.', isError: false });
  });

  it('lets go of a thought as soon as its report starts, not after it', async () => {
    // One short paragraph of reasoning, which is most of it: nothing tells the
    // buffer it is over except the words beginning (see ../../src/harness/thoughts.ts)
    answers({
      'look around': [
        [
          { type: 'reasoning', delta: 'I will search first. ' } as ChatEvent,
          { type: 'reasoning', delta: 'Then read what it points at.' } as ChatEvent,
          text('I looked.'),
          done(),
        ],
      ],
    });
    await run([task('looking', 'look around')]);
    const started = seen.find((e) => e.type === 'subagent') as { id: string };
    // Said while it worked, not handed over with the report at the end
    const atDone = seen.findIndex((e) => e.type === 'subagent_done');
    const atThought = seen.findIndex((e) => e.type === 'subagent_update');
    expect(atThought).toBeLessThan(atDone);
    expect(updates(started.id)).toEqual(['I will search first. Then read what it points at.']);
  });

  it('brings back what it wrote, and not its reasoning', async () => {
    answers({
      'look around': [[{ type: 'reasoning', delta: 'Thinking.' } as ChatEvent, text('The finding.'), done()]],
    });
    expect(await run([task('a', 'look around')])).toBe('## a\n\nThe finding.');
  });

  it('gives each piece the same tools, except the one that would send out more', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => '' });
    tools.register(tool);
    await run([task('a', 'do a')]);
    expect(requests()[0].tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('leaves out a tool that needs a workspace when the thread has none', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => '' });
    tools.register({
      name: 'search_workspace',
      description: 'Search.',
      inputSchema: { type: 'object' },
      needsWorkspace: true,
      run: () => '',
    });
    await run([task('a', 'do a')]);
    expect(requests()[0].tools?.map((t) => t.name)).toEqual(['read_file']);

    mocks.stream.mockClear();
    await run([task('a', 'do a')], { ...context(), workspace: '/projects/demo' });
    expect(requests()[0].tools?.map((t) => t.name)).toEqual(['read_file', 'search_workspace']);
  });

  it('runs the tools it calls and decides again with what came back', async () => {
    const read = vi.fn(() => 'export const parse = () => {};');
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: read });
    answers({
      'read the parser': [
        [call('c1', 'read_file', { path: 'parser.ts' }), done('tool_use')],
        [text('It exports parse.'), done()],
      ],
    });
    const report = await run([task('parser', 'read the parser')]);

    expect(read).toHaveBeenCalledWith({ path: 'parser.ts' }, expect.objectContaining({ threadId: THREAD }));
    expect(report).toBe('## parser\n\nIt exports parse.');
    // What it called and what came back are in its own account of its work
    expect(updates()).toEqual(['read_file({"path":"parser.ts"})', 'returned: export const parse = () => {};']);
    // Its second decision sees its own call and the result
    expect(requests()[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('gives a subagent’s tools what they need to report, and says how deep it is', async () => {
    const seenContexts: ToolContext[] = [];
    tools.register({
      name: 'read_file',
      description: 'Read.',
      inputSchema: { type: 'object' },
      run: (_input, ctx) => {
        seenContexts.push(ctx);
        return '';
      },
    });
    answers({
      'do a': [
        [call('c1', 'read_file'), done('tool_use')],
        [text('Done.'), done()],
      ],
    });
    await run([task('a', 'do a')]);
    // Its own calls are its own: they are reported as its work, not the
    // thread's (see says in run.ts). What the context carries is for the one
    // tool that hands work out, whose subagents report for themselves.
    expect(seen.filter((e) => e.type === 'tool_call')).toEqual([]);
    expect(seenContexts[0].emit).toBeDefined();
    // One below whoever sent it, which is what settles how much further it
    // can hand work out (see MAX_HANDOUT_DEPTH)
    expect(seenContexts[0].depth).toBe(1);
    expect(seenContexts[0].agent).toBe('a');
  });

  it('lets an explorer split its area again, and reports what it sends as work of its own', async () => {
    // The tools an explorer has here: something to read with, and the one it
    // hands work out with
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => '' });
    tools.register(tool);
    // The explorer it is given hands two pieces out rather than reading them
    answers({
      'look at src': [
        [
          call('c1', TOOL_NAME, {
            tasks: [
              { name: 'the parser', task: 'read the parser', kind: 'explorer' },
              { name: 'the lexer', task: 'read the lexer', kind: 'explorer' },
            ],
          }),
          done('tool_use'),
        ],
        [text('Split it in two.'), done()],
      ],
      'read the parser': [[text('It is recursive descent.'), done()]],
      'read the lexer': [[text('It is a table.'), done()]],
    });
    await run([{ name: 'src', task: 'look at src', kind: 'explorer' }], {
      ...context(),
      workspace: '/projects/demo',
    });

    // All three report for themselves, so all three are visible
    expect(seen.filter((e) => e.type === 'subagent').map((e) => (e as { name: string }).name)).toEqual([
      'src',
      'the parser',
      'the lexer',
    ]);
    expect(seen.filter((e) => e.type === 'subagent_done').map((e) => (e as { text: string }).text)).toEqual([
      'It is recursive descent.',
      'It is a table.',
      'Split it in two.',
    ]);
  });

  it('stops the splitting at the bottom, so that it cannot go on for ever', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => '' });
    tools.register(tool);
    // What each of them was offered, by the task it was given
    const offered = new Map<string, string[]>();
    const hands = (name: string, task: string) =>
      [call(`c-${name}`, TOOL_NAME, { tasks: [{ name, task, kind: 'explorer' }] }), done('tool_use')] as ChatEvent[];
    answers({
      'look at src': [hands('the parser', 'read the parser'), [text('Split it.'), done()]],
      'read the parser': [hands('its tables', 'read its tables'), [text('Split that too.'), done()]],
      'read its tables': [[text('They are tables.'), done()]],
    });
    const scripted = mocks.stream.getMockImplementation() as (request: ChatRequest) => unknown;
    mocks.stream.mockImplementation((request: ChatRequest) => {
      const asked = String(request.messages[0].content);
      for (const task of ['look at src', 'read the parser', 'read its tables']) {
        if (asked.includes(task) && !offered.has(task))
          offered.set(
            task,
            (request.tools ?? []).map((t) => t.name)
          );
      }
      return scripted(request);
    });
    await run([{ name: 'src', task: 'look at src', kind: 'explorer' }], {
      ...context(),
      workspace: '/projects/demo',
    });

    // One deep and two deep may still split; three deep has nobody to send
    expect(offered.get('look at src')).toContain(TOOL_NAME);
    expect(offered.get('read the parser')).toContain(TOOL_NAME);
    expect(offered.get('read its tables')).not.toContain(TOOL_NAME);
    // ...and can still do the reading it was sent for
    expect(offered.get('read its tables')).toContain('read_file');
  });

  it('sends each piece to the model its rating calls for, not to whoever handed it out', async () => {
    // A big model and a small one, as a user with a key has
    mocks.listModels.mockResolvedValue({
      models: [model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 }), small],
      providers: [],
    });
    answers({ 'read one file': [[text('Read it.'), done()]], 'work out the design': [[text('Designed.'), done()]] });
    await run([
      { name: 'easy', task: 'read one file', complexity: 1 },
      { name: 'hard', task: 'work out the design', complexity: 4 },
    ]);

    const asked = requests().map((request) => `${request.model}: ${String(request.messages[0].content)}`);
    expect(asked).toEqual(['llama:3b: read one file', 'opus: work out the design']);
  });

  it('leaves a piece with no rating to whoever handed it out, as it always was', async () => {
    mocks.listModels.mockResolvedValue({
      models: [model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 }), small],
      providers: [],
    });
    answers({ 'do a': [[text('Done.'), done()]] });
    await run([task('a', 'do a')]);
    // The context's model, which is what the reply is being answered by
    expect(requests()[0].model).toBe('llama:3b');
  });

  it('says what each piece was rated and what is doing it, as a thread is told of its reply', async () => {
    answers({ 'do a': [[text('Done.'), done()]] });
    await run([{ name: 'a', task: 'do a', complexity: 2, effort: 'low' }]);
    expect(seen.find((e) => e.type === 'subagent')).toMatchObject({
      name: 'a',
      complexity: 2,
      effort: 'low',
      model: 'llama:3b',
    });
  });

  it('gives a piece the rounds its effort calls for, around its kind’s own budget', () => {
    const piece = (over: Record<string, unknown>) => ({ name: 'a', task: 'do a', kind: WORKER, ...over });
    expect(stepsFor(piece({}))).toBe(WORKER.steps);
    expect(stepsFor(piece({ effort: 'medium' }))).toBe(WORKER.steps);
    expect(stepsFor(piece({ effort: 'low' }))).toBe(Math.round(WORKER.steps / 2));
    expect(stepsFor(piece({ effort: 'high' }))).toBe(WORKER.steps * 2);
    // ...and a number asked for by name beats both (see project.ts)
    expect(stepsFor(piece({ effort: 'low', steps: 50 }))).toBe(50);
  });

  // Effort is rated by how much looking a piece needs, and a coder has to make
  // the change and check it whatever the looking comes to: half of its budget
  // is fewer rounds than its own instructions take (see CODER.least)
  it('will not take a kind under the rounds it can be done in at all', () => {
    const coding = (over: Record<string, unknown>) => ({ name: 'a', task: 'do a', kind: CODER, ...over });
    expect(stepsFor(coding({ effort: 'low' }))).toBe(CODER.least);
    expect(CODER.least).toBeLessThan(CODER.steps);
    // The floor is a floor and nothing else: what effort asks for above it
    // still stands
    expect(stepsFor(coding({ effort: 'medium' }))).toBe(CODER.steps);
    expect(stepsFor(coding({ effort: 'high' }))).toBe(CODER.steps * 2);
    // ...and a number asked for by name still beats it
    expect(stepsFor(coding({ effort: 'low', steps: 2 }))).toBe(2);
  });

  // Every batch refused in one run of the log had been written out as a string
  // instead of sent as an array, and broken in the same way while it was: the
  // enums came through unquoted. The tasks are all there, so they are read
  // rather than thrown away with the plan (see ../../src/subagents/index.ts).
  describe('an array the model wrote out as a string', () => {
    it('reads the tasks out of it, unquoted enums and all', () => {
      const tasks = JSON.stringify([
        { name: 'entry-file', kind: 'coder', complexity: 3, effort: 'medium', task: 'do a' },
        { name: 'build-config', kind: 'coder', complexity: 2, effort: 'low', task: 'do b' },
      ])
        .replace('"medium"', 'medium')
        .replace('"low"', 'low');
      expect(parse({ tasks })).toMatchObject([
        { name: 'entry-file', task: 'do a', complexity: 3, effort: 'medium' },
        { name: 'build-config', task: 'do b', complexity: 2, effort: 'low' },
      ]);
    });

    it('leaves a task’s own prose alone while it repairs the JSON around it', () => {
      const said = 'Rate it so: effort: medium, and complexity: 3, then report back.';
      const tasks = JSON.stringify([{ name: 'a', task: said, effort: 'high' }]).replace('"high"', 'high');
      expect(parse({ tasks })[0].task).toBe(said);
    });

    it('says that it arrived as a string when it cannot be read, so the model has something to change', () => {
      expect(() => parse({ tasks: '[{"name":"a","task":"do a"' })).toThrow('arrived as a string');
      expect(() => parse({ tasks: 'not json at all' })).toThrow('real array');
    });

    it('still refuses a string that reads as something other than an array', () => {
      expect(() => parse({ tasks: '{"name":"a","task":"do a"}' })).toThrow('arrived as a string');
      expect(() => parse({ tasks: '[]' })).toThrow('non-empty array');
    });
  });

  it('takes a rating only when it is one, rather than refusing the whole call over it', async () => {
    const parsed = parse({
      tasks: [
        { name: 'a', task: 'do a', complexity: 9, effort: 'enormous' },
        { name: 'b', task: 'do b', complexity: 2.5 },
        { name: 'c', task: 'do c', complexity: 3, effort: 'high' },
      ],
    });
    expect(parsed.map((one) => [one.complexity, one.effort])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [3, 'high'],
    ]);
  });

  describe('a piece handed out without waiting for it', () => {
    // Holds a subagent open until the test lets it finish
    const held = () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (release = resolve));
      return { waiting, release };
    };

    it('returns at once, and says what is still running and how to collect it', async () => {
      const slow = held();
      mocks.stream.mockImplementation(async function* (request: ChatRequest) {
        if (String(request.messages[0].content).includes('the slow one')) await slow.waiting;
        yield text('Done.');
        yield done();
      });
      const said = await run([
        { name: 'quick', task: 'do the quick one', complexity: 1 },
        { name: 'slow', task: 'do the slow one', blocking: false },
      ]);

      // Back before the slow one has finished, with the quick one's finding
      expect(said).toContain('## quick');
      expect(said).toContain('Still working, and not waited for: slow');
      expect(said).toContain('wait_for_subagent');
      expect(stillRunning(THREAD)).toEqual(['slow']);

      slow.release();
      const [found] = await waitFor(THREAD, ['slow']);
      expect(found).toMatchObject({ name: 'slow', text: 'Done.', isError: false });
      expect(stillRunning(THREAD)).toEqual([]);
    });

    it('is started all the same, not merely planned', async () => {
      const asked: string[] = [];
      mocks.stream.mockImplementation((request: ChatRequest) => {
        asked.push(String(request.messages[0].content));
        return from([text('Done.'), done()]);
      });
      await run([{ name: 'later', task: 'look it up', blocking: false }]);
      expect(asked).toEqual(['look it up']);
      await waitFor(THREAD);
    });

    it('is collected by name, or all of them at once', async () => {
      answers({ 'do a': [[text('A.'), done()]], 'do b': [[text('B.'), done()]] });
      await run([
        { name: 'a', task: 'do a', blocking: false },
        { name: 'b', task: 'do b', blocking: false },
      ]);
      expect(stillRunning(THREAD)).toEqual(['a', 'b']);

      expect((await waitFor(THREAD, ['b'])).map((one) => one.text)).toEqual(['B.']);
      expect(stillRunning(THREAD)).toEqual(['a']);
      // Nothing named: everything still out
      expect((await waitFor(THREAD)).map((one) => one.text)).toEqual(['A.']);
      expect(stillRunning(THREAD)).toEqual([]);
    });

    it('says so when asked for something nobody is running, rather than waiting for ever', async () => {
      answers({ 'do a': [[text('A.'), done()]] });
      await run([{ name: 'a', task: 'do a', blocking: false }]);
      const [found] = await waitFor(THREAD, ['nobody']);
      expect(found).toMatchObject({ name: 'nobody', isError: true });
      expect(found.text).toContain('Still out: a');
      await waitFor(THREAD);
    });

    it('is kept apart from another thread’s, so neither collects the other’s', async () => {
      answers({ 'do a': [[text('A.'), done()]], 'do b': [[text('B.'), done()]] });
      await run([{ name: 'a', task: 'do a', blocking: false }]);
      await run([{ name: 'b', task: 'do b', blocking: false }], { ...context(), threadId: 'another-thread' });
      expect(stillRunning(THREAD)).toEqual(['a']);
      expect(stillRunning('another-thread')).toEqual(['b']);
      await waitFor(THREAD);
      await waitFor('another-thread');
    });

    it('is forgotten with the thread it belonged to', async () => {
      answers({ 'do a': [[text('A.'), done()]] });
      await run([{ name: 'a', task: 'do a', blocking: false }]);
      forgetThread(THREAD);
      expect(stillRunning(THREAD)).toEqual([]);
    });
  });

  it('reports what each subagent used, so its tokens are counted', async () => {
    answers({ 'do a': [[text('Found it.'), done('end_turn', { input: 300, output: 40 })]] });
    await run([task('a', 'do a')]);
    expect(seen.filter((e) => e.type === 'usage')).toEqual([
      {
        type: 'usage',
        purpose: 'subagent',
        provider: 'local',
        model: 'llama:3b',
        input: 300,
        output: 40,
        cost: 0,
        // ...and how long it took, which is counted with it: a thread waits
        // on its subagents as much as on its own replies (see Latency)
        latency: { totalMs: expect.any(Number) },
        subagent: expect.any(String),
      },
    ]);
  });

  it('says which subagent used the tokens, by the id it announced itself with', async () => {
    answers({
      'do a': [[text('A.'), done('end_turn', { input: 3, output: 1 })]],
      'do b': [[text('B.'), done('end_turn', { input: 5, output: 2 })]],
    });
    await run([task('a', 'do a'), task('b', 'do b')]);
    const started = seen.filter((e) => e.type === 'subagent') as { id: string; name: string }[];
    const used = seen.filter((e) => e.type === 'usage') as { subagent: string; input: number }[];
    const idOf = (name: string) => started.find((e) => e.name === name)?.id;
    expect(used.find((e) => e.input === 3)?.subagent).toBe(idOf('a'));
    expect(used.find((e) => e.input === 5)?.subagent).toBe(idOf('b'));
    expect(idOf('a')).not.toBe(idOf('b'));
  });

  it('times each of its calls apart from the wait behind another request, as a reply does', async () => {
    answers({
      'do a': [
        [{ type: 'queued' }, { type: 'waited', ms: 900 }, text('Found it.'), done('end_turn', { input: 1, output: 2 })],
      ],
    });
    await run([task('a', 'do a')]);
    const [used] = seen.filter((e) => e.type === 'usage');
    // The queueing is reported, and is not counted as the model being slow
    expect(used).toMatchObject({ latency: { queuedMs: 900 } });
    expect((used as { latency: { totalMs: number } }).latency.totalMs).toBeLessThan(900);
  });
});

// A coder piece is rated below the thread that handed it out (see capped in run.ts)
describe('how complex a coder piece may be', () => {
  const ratings = () =>
    Object.fromEntries(
      seen
        .filter((e) => e.type === 'subagent')
        .map((e) => [(e as { name: string }).name, (e as { complexity?: number }).complexity])
    );
  const coder = (name: string, complexity?: number) => ({ ...task(name, `do ${name}`), kind: 'coder', complexity });

  it('is held below the thread, and an unrated piece gets the cap', async () => {
    await run([coder('big', 5), coder('unrated'), coder('small', 2)], { ...context(), sophistication: 4 });
    expect(ratings()).toEqual({ big: 3, unrated: 3, small: 2 });
  });

  it('is never less than 1, however low the thread is rated', async () => {
    await run([coder('a', 4), coder('b')], { ...context(), sophistication: 1 });
    expect(ratings()).toEqual({ a: 1, b: 1 });
  });

  it('is left as it was in a thread that was not rated', async () => {
    await run([coder('a', 5)]);
    expect(ratings()).toEqual({ a: 5 });
  });

  it('is not held on any other kind of piece', async () => {
    await run(
      [
        { ...task('look', 'look around'), kind: 'explorer', complexity: 5 },
        { ...task('work', 'do work'), complexity: 5 },
      ],
      {
        ...context(),
        workspace: '/projects/demo',
        sophistication: 4,
      }
    );
    expect(ratings()).toEqual({ look: 5, work: 5 });
  });
});

describe('a piece that goes wrong', () => {
  it('comes back as a failure, and does not stop the others', async () => {
    answers({
      'do a': [[{ type: 'error', code: 'other', message: 'Connection lost.' }]],
      'do b': [[text('B is done.'), done()]],
    });
    const report = await run([task('a', 'do a'), task('b', 'do b')]);
    expect(report).toContain('## a (did not finish)\n\nConnection lost.');
    expect(report).toContain('## b\n\nB is done.');
    expect(seen.filter((e) => e.type === 'subagent_done')).toEqual(
      expect.arrayContaining([expect.objectContaining({ isError: true }), expect.objectContaining({ isError: false })])
    );
  });

  it('says so when a subagent finished without reporting anything, even after being asked again', async () => {
    // A step that says nothing is asked again before it is given up on (see
    // MAX_NUDGES), so the silence has to be repeated
    answers({ 'do a': [[done()], [done()]] });
    expect(await run([task('a', 'do a')])).toBe(
      '## a (did not finish)\n\nThe subagent finished without reporting anything.'
    );
  });

  it('is cut to a size the model that reads it can take', async () => {
    answers({ 'do a': [[text('x'.repeat(9000)), done()]] });
    const report = await run([task('a', 'do a')]);
    expect(report.length).toBeLessThan(4200);
  });

  it('asks again for the report when a round ends with nothing written', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => 'more' });
    // All of its answer went to its reasoning, which is shown as a thought and
    // brings nothing back: the report has to be asked for outright
    answers({
      'do a': [
        [{ type: 'reasoning', delta: 'Worked it out.' }, done()],
        [text('Here it is.'), done()],
      ],
    });
    expect(await run([task('a', 'do a')])).toBe('## a\n\nHere it is.');
    const asked = requests().at(-1)!;
    // Its tools go with it: taking them away for this round stopped nothing
    // and cost a local model the whole prompt (see tools in run.ts)
    expect(asked.tools).toEqual(requests()[0].tools);
    expect(asked.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You stopped without reporting anything'),
    });
    // Being asked again costs it none of the rounds it has for the work itself
    expect(requests()).toHaveLength(2);
  });

  it('asks again when the round it is asked in answers with a tool call', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => 'more' });
    let asked = 0;
    // Calls a tool on the round that asked for its report, where nothing it
    // calls is run, which is no report. Which round that is, is read off what
    // it was told rather than off its tools, which no longer change (see
    // tools in run.ts).
    mocks.stream.mockImplementation((request: ChatRequest) =>
      reportAsked(request) && ++asked > 1
        ? from([text('What I have.'), done()])
        : from([call('c', 'read_file'), done('tool_use')])
    );
    expect(await run([task('a', 'do a')])).toBe('## a\n\nWhat I have.');
  });

  // Six of the twenty-four coders in two days of the log came back this way:
  // a round that said what it was about to do, taken for the report because
  // nothing was called in it, and handed to the thread as a finding with
  // nothing wrong with it (see the carry-on in run.ts)
  describe('a round that says what it is going to do and does none of it', () => {
    beforeEach(() => {
      tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => 'more' });
    });

    it('is not its report: it is told to carry on, and what it does then is', async () => {
      answers({
        'do a': [
          [text('Remaining: 85%\n\nNothing is edited yet. The edit is still to do.'), done()],
          [text('I edited src/a.ts.'), done()],
        ],
      });
      expect(await run([task('a', 'do a')])).toBe('## a\n\nI edited src/a.ts.');
      const asked = requests().at(-1)!;
      // Its own words go back in with it, so that the turn it is being asked
      // about is in front of it
      expect(asked.messages.at(-2)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Nothing is edited yet'),
      });
      expect(asked.messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining('said what you were going to do rather than doing it'),
      });
    });

    it('is read as one by the line it wrote itself, wherever its rounds had got to', async () => {
      answers({
        'do a': [
          [text('Remaining: 70%\n\nI have read the file.'), done()],
          [text('Changed it.'), done()],
        ],
      });
      await run([task('a', 'do a')]);
      // ...and the line is still the ring on its tab, not a part of the work
      expect(updates()).toContain('progress 30');
      expect(requests()).toHaveLength(2);
    });

    it('is read as one by the sentence, where it wrote no line', async () => {
      answers({
        'do a': [
          [text("I'll search the codebase for the timer."), done()],
          [text('Found it.'), done()],
        ],
      });
      expect(await run([task('a', 'do a')])).toBe('## a\n\nFound it.');
    });

    // The one thing this must not do: a report of looking already done reads
    // like an announcement to nobody, and asking again for it would spend a
    // round and press the model for what it had just given
    it('is not what a finding is, however the finding opens', async () => {
      answers({ 'do a': [[text('I checked where they are implemented: src/a.ts line 7.'), done()]] });
      expect(await run([task('a', 'do a')])).toBe('## a\n\nI checked where they are implemented: src/a.ts line 7.');
      expect(requests()).toHaveLength(1);
    });

    it('is not what a progress line saying nothing is left is, either', async () => {
      answers({ 'do a': [[text('Remaining: 0%\n\nI made the change in src/a.ts.'), done()]] });
      expect(await run([task('a', 'do a')])).toBe('## a\n\nI made the change in src/a.ts.');
      expect(requests()).toHaveLength(1);
    });

    it('is taken as the report in the end, so that a model which only narrates still ends', async () => {
      answers({ 'do a': [] });
      mocks.stream.mockImplementation(() => from([text("Remaining: 90%\n\nI'll read the file next."), done()]));
      expect(await run([task('a', 'do a')])).toBe("## a\n\nI'll read the file next.");
      // Twice, and each asking costs it a round of the eight a worker has
      expect(requests()).toHaveLength(3);
    });
  });

  // A model that writes nothing for us on any round, the ones that ask for the
  // report included: every one of qwen3.5:9b's 88 turns with tools in front of
  // it went that way, so the nudge above went on another tool call and three
  // coders came back as failures over work that had landed (see the fallback
  // in run.ts)
  describe('a model that only ever answers in its reasoning', () => {
    const reads = () =>
      tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => 'more' });
    const reasons = (what: (request: ChatRequest) => string) =>
      mocks.stream.mockImplementation((request: ChatRequest) =>
        from([{ type: 'reasoning', delta: what(request) } as ChatEvent, call('c', 'read_file'), done('tool_use')])
      );

    it('takes its report from its reasoning, rather than coming back as a failure', async () => {
      reads();
      reasons((request) => (reportAsked(request) ? 'I edited src/a.ts.' : 'Still reading.'));
      const said = await run([task('a', 'do a')]);
      expect(said).toBe('## a\n\nI edited src/a.ts.');
      // Which is a report, so none of what stands in for one where there is
      // none (see account in run.ts)
      expect(said).not.toContain('did not write a report');
      expect(said).not.toContain('finished without reporting anything');
    });

    it('keeps the end of reasoning that runs long, rather than asking it to be shortened', async () => {
      reads();
      // What it settled on is at the end; the start is where it was still working it out
      reasons((request) => (reportAsked(request) ? `Start. ${'word '.repeat(5000)}I edited src/a.ts.` : 'Reading.'));
      const said = await run([task('a', 'do a')]);
      expect(said).toContain('I edited src/a.ts.');
      expect(said).not.toContain('Start.');
      // A model that reasons answers a request to shorten by reasoning again, and comes back empty
      expect(requests().some((request) => request.system.includes('is too long'))).toBe(false);
    });

    it('leaves the progress line out of it, wherever the model wrote it', async () => {
      reads();
      // The line is a status for the window, and a model that writes its
      // answer in its reasoning writes that there too (see PROGRESS in run.ts)
      reasons((request) => (reportAsked(request) ? 'What I found.\nRemaining: 40%\n' : 'Reading.'));
      expect(await run([task('a', 'do a')])).toBe('## a\n\nWhat I found.');
      expect(updates()).toContain('progress 60');
    });

    it('sends what it reasoned back as its own turn, so it is not blank', async () => {
      reads();
      answers({
        'do a': [
          [{ type: 'reasoning', delta: 'Reading src/a.ts first.' }, call('c', 'read_file'), done('tool_use')],
          [text('Done.'), done()],
        ],
      });
      await run([task('a', 'do a')]);
      // Ollama takes a `thinking` field on an assistant message and discards
      // it, so content is the only channel a local model's own words come
      // back through. A blank turn there is a model that reads its last round
      // as having done nothing, and does it again: one coder read the same
      // stretch of a file on four rounds running.
      const mine = requests()
        .at(-1)!
        .messages.filter((m) => m.role === 'assistant');
      expect(mine.at(-1)).toMatchObject({ content: 'Reading src/a.ts first.' });
    });

    it('keeps what it wrote where it wrote any, and does not add the reasoning to it', async () => {
      reads();
      answers({
        'do a': [
          [{ type: 'reasoning', delta: 'Thinking.' }, text('Reading now.'), call('c', 'read_file'), done('tool_use')],
          [text('Done.'), done()],
        ],
      });
      await run([task('a', 'do a')]);
      const mine = requests()
        .at(-1)!
        .messages.filter((m) => m.role === 'assistant');
      expect(mine.at(-1)).toMatchObject({ content: 'Reading now.' });
    });
  });

  it('asks for the findings in a turn of its own, once it is out of rounds', async () => {
    tools.register({ name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, run: () => 'more' });
    // Always calls a tool, so it never answers of its own accord until it is
    // asked outright
    mocks.stream.mockImplementation((request: ChatRequest) =>
      from(reportAsked(request) ? [text('What I have.'), done()] : [call('c', 'read_file'), done('tool_use')])
    );
    expect(await run([task('a', 'do a')])).toBe('## a\n\nWhat I have.');
    const last = requests().at(-1)!;
    // The same tools it had all along, and the same list: a list that changes
    // is a local model's prompt thrown away (see cachelock.brokeBy)
    expect(last.tools).toEqual(requests()[0].tools);
    expect(last.tools?.length).toBeGreaterThan(0);
    // Asked in a turn, the instructions being what signs its thinking and
    // having to stand still for the whole of a run (see tell in run.ts)
    const asked = String(last.messages.at(-1)!.content);
    expect(asked).toContain('Report what you have found now');
    // ...and to say what it had not settled rather than leaving it out: the
    // report is the only thing that comes back, cut off or not
    expect(asked).toContain('say that you did not confirm it');
    expect(last.system).not.toContain('Report what you have found now');
  });

  // An answer that goes wrong at the provider used to end the run where it
  // stood, however much work was behind it: one of them lost ten rounds and
  // an edit that had already landed to a parse error on its last call (see
  // the salvage in run.ts)
  describe('an answer that fails after it has already done the work', () => {
    const edits = () =>
      tools.register({ name: 'edit_file', description: 'Edit.', inputSchema: { type: 'object' }, run: () => 'edited' });
    const broke = { type: 'error', code: 'other', message: 'XML syntax error on line 10: unexpected EOF' };
    const edited = [call('c', 'edit_file', { path: 'src/a.ts' }), done('tool_use')];
    // Each reply in turn, whatever the request: these are about the order the
    // run goes in and not about what it was asked
    const replies = (...each: ChatEvent[][]) => {
      let at = 0;
      mocks.stream.mockImplementation(() => from(each[at++] ?? [text('nothing'), done()]));
    };

    it('asks for the report instead of giving the whole run up', async () => {
      edits();
      replies(edited, [broke as ChatEvent], [text('I changed src/a.ts.'), done()]);
      expect(await run([task('a', 'do a')])).toBe('## a\n\nI changed src/a.ts.');
      // Asked for the report, and told not to do the work over: the files it
      // changed are as it left them
      const asked = String(requests().at(-1)!.messages.at(-1)!.content);
      expect(asked).toContain('Something went wrong with your last answer');
      expect(asked).toContain('do not do the work again');
    });

    it('asks once, and says what it had done when that fails too', async () => {
      edits();
      replies(edited, [broke as ChatEvent], [broke as ChatEvent]);
      const said = await run([task('a', 'do a')]);
      expect(said).toContain('(did not finish)');
      expect(said).toContain('XML syntax error');
      // What it ran, since the file it edited is changed whether or not it
      // ever got round to saying so
      expect(said).toContain('edit_file on src/a.ts');
      // Asked for the report once and not again: three calls, not four
      expect(requests()).toHaveLength(3);
    });

    it('is given up on at once where there was no work behind it', async () => {
      edits();
      replies([broke as ChatEvent]);
      const said = await run([task('a', 'do a')]);
      expect(said).toContain('XML syntax error');
      // Nothing to salvage and nothing to report: asking again would only be
      // a second failure
      expect(said).not.toContain('What it did');
      expect(requests()).toHaveLength(1);
    });

    it('says what it ran, rather than nothing, where it never writes a report', async () => {
      edits();
      // Calls a tool on every round, the ones that ask for its report included
      mocks.stream.mockImplementation(() => from(edited));
      const said = await run([task('a', 'do a')]);
      expect(said).toContain('did not write a report');
      expect(said).toContain('edit_file on src/a.ts');
      expect(said).not.toContain('finished without reporting anything');
    });
  });
});

// Writing to a subagent while it works, and being answered by it (see
// ../../src/subagents/mailbox.ts, where the letterbox itself is tested). The
// letter is sent from inside a tool the subagent calls, which is the real
// shape of it: whoever wrote to it is working while it works.
describe('a subagent that is written to while it works', () => {
  // Registers a tool that writes to the subagent the first time it is called,
  // and gives back whatever the subagent answers
  const writes = (said: string) => {
    let back: Promise<string> | undefined;
    tools.register({
      name: 'get_time',
      description: 'The time.',
      inputSchema: { type: 'object' },
      run: () => {
        back ??= mailbox.send(THREAD, 'one', said, new AbortController().signal);
        return '12:00';
      },
    });
    return () => back as Promise<string>;
  };
  // Each round in turn, whatever the task, and what the subagent was told last
  // in each of them. Taken as the round is made rather than read off the mock
  // afterwards: the loop keeps adding to the one messages array, so every call
  // recorded by the mock points at what it held at the end.
  const told: string[] = [];
  const last: string[] = [];
  const rounds = (...replies: ChatEvent[][]) => {
    const left = [...replies];
    told.length = 0;
    last.length = 0;
    mocks.stream.mockImplementation((request: ChatRequest) => {
      told.push(request.messages.map((one) => String(one.content)).join('\n'));
      last.push(String(request.messages.at(-1)?.content ?? ''));
      return from(left.shift() ?? [text('nothing'), done()]);
    });
  };

  it('reads it in the next round, as a turn of its own, and answers it there', async () => {
    const back = writes('Skip the legacy routes.');
    rounds(
      [call('c1', 'get_time'), done('tool_use')],
      [text('Dropped them; the v2 ones are what I am on.'), call('c2', 'get_time'), done('tool_use')],
      [text('Moved four routes over.'), done()]
    );
    const said = await run([task('one', 'move the routes over')]);

    // The letter is in front of it in the round after it was written, framed
    // as being from the assistant that sent it
    expect(last[1]).toContain('The assistant that sent you has written to you');
    expect(last[1]).toContain('Skip the legacy routes.');
    // ...and what it wrote in that round went back to whoever wrote
    await expect(back()).resolves.toBe('Dropped them; the v2 ones are what I am on.');
    // ...which is not its report: that is what it said when the work was done
    expect(said).toContain('Moved four routes over.');
  });

  // Reading that round as a report stops the work in the middle and hands the
  // sentence it wrote for whoever asked back as the whole of its work
  it('is told that answering is not reporting, where it answers and calls nothing', async () => {
    const back = writes('How far along are you?');
    rounds(
      [call('c1', 'get_time'), done('tool_use')],
      [text('Two of the four files.'), done()],
      [text('All four files moved over.'), done()]
    );
    const said = await run([task('one', 'move the routes over')]);
    await expect(back()).resolves.toBe('Two of the four files.');
    // It was told what had actually happened, and carried on
    expect(told[2]).toContain('It was not your report');
    expect(said).toContain('All four files moved over.');
    expect(said).not.toContain('Two of the four files.');
  });

  it('is answered with what it called, where it read the letter and wrote nothing back', async () => {
    const back = writes('Skip the legacy routes.');
    rounds(
      [call('c1', 'get_time'), done('tool_use')],
      [call('c2', 'get_time'), done('tool_use')],
      [text('Done.'), done()]
    );
    await run([task('one', 'move the routes over')]);
    await expect(back()).resolves.toContain('carried straight on working');
    await expect(back()).resolves.toContain('get_time');
  });

  it('answers what it never got to with its report, nothing being left waiting', async () => {
    const back = writes('Skip the legacy routes.');
    // It reports in the round that reads the letter, so the letter is never
    // answered in its own right
    rounds([call('c1', 'get_time'), done('tool_use')], [text('Moved all of them.'), done()]);
    await run([task('one', 'move the routes over')]);
    await expect(back()).resolves.toBe('Moved all of them.');
    // ...and nothing can be addressed to it any more
    expect(mailbox.listening(THREAD)).toEqual([]);
  });

  // A round cut off before the model wrote anything is condensed and tried
  // again, and a letter answered there would be answered with the nothing
  // that round produced
  it('waits for a round that says something, where the round that read it was cut off', async () => {
    const back = writes('Skip the legacy routes.');
    rounds(
      [call('c1', 'get_time'), done('tool_use')],
      // Read the letter and came back cut off, with nothing written
      [done('length')],
      [text('Dropped them; four routes moved.'), done()]
    );
    await run([task('one', 'move the routes over')]);
    await expect(back()).resolves.toBe('Dropped them; four routes moved.');
    // ...and it was not put to it twice: the letter is in its conversation
    // once, from the round it arrived in
    const letters = told[2].split('The assistant that sent you has written to you').length - 1;
    expect(letters).toBe(1);
  });

  it('is told it can be written to, whatever kind it is', async () => {
    for (const kind of [CODER, EXPLORER, WORKER]) {
      mocks.stream.mockClear();
      answers({});
      await run([{ ...task('one', 'do the thing'), kind: kind.name }], {
        ...context(),
        workspace: '/projects/demo',
      });
      const system = String(requests()[0].system ?? '');
      expect(system, kind.name).toContain('can write to you while you work');
      expect(system, kind.name).toContain('You cannot start one of these yourself');
    }
  });
});
