// Running an agent subagent: the kind that goes through the whole of the reply
// flow rather than the small loop the other kinds share (see
// ../../src/subagents/thread.ts). What it is allowed and what it is told are
// tested in ./kinds.test.ts.
//
// The flow itself is mocked here, which is the point of the test: what is
// worth checking is what the agent asks the flow for, what it does with what
// comes back, and that a job it has answered stays for as long as the model
// that sent it has anything more to say to it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { from, model } from '../helpers';
import type { HarnessEvent, HarnessRequest, ToolContext } from '../../src/types';

const harness = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/harness', () => harness);
const mocks = vi.hoisted(() => ({ stream: vi.fn(), listModels: vi.fn(), isFast: vi.fn() }));
vi.mock('../../src/llm', () => mocks);
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../src/log', () => log);

import { AGENT } from '../../src/subagents/agent';
import { work } from '../../src/subagents/thread';
import * as mailbox from '../../src/subagents/mailbox';

const THREAD = '7c1f9f1a-6d3e-4a2f-9ad6-1f0a1c3b5e77';
const ROUTED = { provider: 'local', model: 'qwen:14b' };

const seen: HarnessEvent[] = [];
const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  threadId: THREAD,
  workspace: '/projects/demo',
  model: ROUTED,
  emit: (event) => seen.push(event),
  ...over,
});
const piece = (over: Record<string, unknown> = {}) => ({
  name: 'the importer',
  task: 'Move the importer onto the new parser.',
  kind: AGENT,
  ...over,
});
// What the flow was asked for, in the order it was asked
const asked = () => harness.run.mock.calls.map(([request]) => request as HarnessRequest);
// Every turn the flow is to answer, in order. A turn that is not scripted
// answers with nothing, which is what a flow that fell over does.
const turns = (...replies: HarnessEvent[][]) => {
  const left = [...replies];
  harness.run.mockImplementation(() => from(left.shift() ?? []));
};
const text = (delta: string): HarnessEvent => ({ type: 'text', delta });
const DONE: HarnessEvent = { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 };
const answer = (said: string): HarnessEvent[] => [text(said), DONE];

afterEach(() => {
  seen.length = 0;
  mailbox.forget(THREAD);
});

describe('what it asks the reply flow for', () => {
  it('is the job as the request, in the thread it was sent from, with no ceiling on its rounds', async () => {
    turns(answer('Moved it; the tests pass.'));
    const found = await work(piece(), context(), ROUTED, []);
    expect(found).toEqual({
      name: 'the importer',
      task: 'Move the importer onto the new parser.',
      text: 'Moved it; the tests pass.',
      isError: false,
    });
    const [request] = asked();
    expect(request.thread).toBe(THREAD);
    expect(request.workspace).toBe('/projects/demo');
    expect(request.messages).toEqual([{ role: 'user', content: 'Move the importer onto the new parser.' }]);
    // The written form of "no turn limit" (see HarnessRequest.rounds)
    expect(request.rounds).toBe(Infinity);
  });

  it('says it is a subagent, and under what name, which is what its own note is kept under', async () => {
    turns(answer('done'));
    await work(piece(), context(), ROUTED, []);
    expect(asked()[0].agent).toEqual({ name: 'the importer', depth: 1 });
  });

  // An agent that hands out work of its own has to know where it stands, or
  // the chain of subagents has no bottom (see MAX_HANDOUT_DEPTH)
  it('stands one further down than whoever sent it', async () => {
    turns(answer('done'));
    await work(piece(), context({ depth: 1 }), ROUTED, []);
    expect(asked()[0].agent?.depth).toBe(2);
  });

  // A rating is the sender saying how capable a model this needs, which is the
  // same thing a model the user picked by hand says (see modelFor)
  it('pins the model where the piece was rated, and lets the flow route it where it was not', async () => {
    turns(answer('done'));
    await work(piece({ complexity: 4 }), context(), ROUTED, []);
    expect(asked()[0]).toMatchObject({ provider: 'local', model: 'qwen:14b' });
    harness.run.mockClear();
    turns(answer('done'));
    await work(piece(), context(), ROUTED, []);
    expect(asked()[0].provider).toBeUndefined();
    expect(asked()[0].model).toBeUndefined();
  });

  // Where the app is picking it up where it closed on it, what it had done is
  // handed to the flow, which splices it in the same way a thread's reply is
  // picked up (see subagents/thread.ts)
  it('is given what it had done, where the app is picking it up', async () => {
    const resumed = { did: ['read_file("a.ts") returned: the file'], text: 'Reading a.ts now.' };
    turns(answer('Moved it; the tests pass.'));
    await work(piece(), context({ resumed }), ROUTED, []);
    expect(asked()[0].resumed).toEqual(resumed);
  });
});

describe('what the window is shown of it', () => {
  it('names it as a subagent before it starts, and says what it came back with', async () => {
    turns(answer('Moved it.'));
    await work(piece({ complexity: 3, effort: 'high' }), context(), ROUTED, []);
    expect(seen.filter((e) => e.type === 'subagent')).toEqual([
      {
        type: 'subagent',
        id: expect.any(String),
        name: 'the importer',
        task: 'Move the importer onto the new parser.',
        kind: 'agent',
        complexity: 3,
        effort: 'high',
        model: 'qwen:14b',
      },
    ]);
    expect(seen.filter((e) => e.type === 'subagent_done')).toEqual([
      { type: 'subagent_done', id: expect.any(String), text: 'Moved it.', isError: false },
    ]);
  });

  // The row is written before the flow has routed anything, so a piece that
  // carried no rating has no model to name until the flow says
  it('leaves the model off the row where the flow is the one choosing it, and says it when it has', async () => {
    turns([
      { type: 'model', provider: 'local', model: 'qwen:14b', name: 'Qwen 14B', sophistication: 3, reason: 'rated' },
      ...answer('done'),
    ]);
    await work(piece(), context(), ROUTED, []);
    expect(seen.find((e) => e.type === 'subagent')).not.toHaveProperty('model');
    expect(thoughts()).toContain('Answering on Qwen 14B.');
  });

  it('passes its work on in the shape a subagent’s work is already shown in', async () => {
    turns([
      { type: 'thought', text: 'The importer reads the old parser twice.' },
      { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/import.ts' } },
      { type: 'tool_result', id: 'c1', name: 'read_file', output: '...', isError: false },
      { type: 'condensing' },
      { type: 'condensed', changed: true },
      ...answer('done'),
    ]);
    await work(piece(), context(), ROUTED, []);
    const updates = seen.filter((e) => e.type === 'subagent_update').map((e) => e.event.type);
    expect(updates).toEqual(['thought', 'tool_call', 'tool_result', 'condensing', 'condensed']);
  });

  // A tab has thoughts and tool calls to show and nothing else, so the two
  // things a thread shows as things of their own are said as lines
  it('says the step it has reached, and the plan it wrote, as thoughts', async () => {
    turns([{ type: 'phase', phase: 'execute' }, { type: 'plan', text: 'Rewrite the importer.' }, ...answer('done')]);
    await work(piece(), context(), ROUTED, []);
    expect(thoughts()).toEqual(['Making the change.', 'Rewrite the importer.']);
  });

  // Its own subagents report through the thread rather than through it: a tab
  // inside a tab is a place nobody looks
  it('passes the subagents it hands out to the thread, beside itself', async () => {
    const started: HarnessEvent = { type: 'subagent', id: 'inner', name: 'the tests', task: 't', kind: 'coder' };
    turns([started, { type: 'subagent_done', id: 'inner', text: 'wrote them', isError: false }, ...answer('done')]);
    await work(piece(), context(), ROUTED, []);
    expect(seen.filter((e) => e.type === 'subagent').map((e) => e.id)).toContain('inner');
    expect(seen.filter((e) => e.type === 'subagent_done').map((e) => e.id)).toContain('inner');
  });

  it('charges what it spends to its own row, and leaves its subagents’ charged to theirs', async () => {
    turns([
      { type: 'usage', kind: 'reply', provider: 'local', model: 'qwen:14b', usage: { input: 10, output: 2 } },
      {
        type: 'usage',
        subagent: 'inner',
        kind: 'subagent',
        provider: 'local',
        model: 'q',
        usage: { input: 1, output: 1 },
      },
      ...answer('done'),
    ]);
    await work(piece(), context(), ROUTED, []);
    const row = seen.find((e) => e.type === 'subagent')?.id;
    const charged = seen.filter((e) => e.type === 'usage').map((e) => e.subagent);
    expect(charged).toEqual([row, 'inner']);
  });
});

describe('when something goes wrong', () => {
  it('brings the failure back as its finding rather than throwing it at whoever sent it', async () => {
    turns([{ type: 'error', code: 'other', message: 'The model stopped without finishing.' }]);
    const found = await work(piece(), context(), ROUTED, []);
    expect(found.isError).toBe(true);
    expect(found.text).toContain('The model stopped without finishing.');
  });

  it('does the same where the flow itself fell over', async () => {
    harness.run.mockImplementation(() => {
      throw new Error('No models available.');
    });
    const found = await work(piece(), context(), ROUTED, []);
    expect(found).toMatchObject({ isError: true, text: 'No models available.' });
  });

  it('says so where it finished and wrote nothing', async () => {
    turns([DONE]);
    const found = await work(piece(), context(), ROUTED, []);
    expect(found).toMatchObject({ isError: true, text: 'The agent finished without reporting anything.' });
  });

  // It was working when the time ran out, which is not the same as having
  // stopped: what it had written is worth having either way
  it('says it was cut off where the work was stopped, and keeps what it had written', async () => {
    const stopped = new AbortController();
    stopped.abort();
    turns([text('Half of it is done.'), DONE]);
    const found = await work(piece(), context({ signal: stopped.signal }), ROUTED, []);
    expect(found.text).toContain('The agent was cut off before it reported');
    // What it had got as far as writing is worth having either way
    expect(found.text).toContain('Half of it is done.');
  });
});

describe('staying for whatever else there is to say', () => {
  it('ends with its job where the model that sent it is waiting on it', async () => {
    turns(answer('Moved it.'));
    const found = await work(piece(), context(), ROUTED, []);
    expect(found.text).toBe('Moved it.');
    expect(asked()).toHaveLength(1);
    // Nothing is left listening: there is nobody to write to it
    expect(mailbox.listening(THREAD)).toEqual([]);
  });

  it('waits to be written to where it was started without waiting, and answers in a turn of its own', async () => {
    turns(answer('Moved it.'), answer('Dropped the legacy path too.'));
    const running = work(piece({ blocking: false }), context(), ROUTED, []);
    // It has answered its job and is waiting, so it can be written to
    await vi.waitUntil(() => mailbox.listening(THREAD).includes('the importer'));
    await vi.waitUntil(() => asked().length === 1);
    const back = await mailbox.send(THREAD, 'the importer', 'Drop the legacy path as well.', context().signal);
    expect(back).toBe('Dropped the legacy path too.');
    // The second turn carries what it answered before and what was written to
    // it, so it is working from where it left off
    const second = asked()[1].messages;
    expect(second[0]).toEqual({ role: 'user', content: 'Move the importer onto the new parser.' });
    expect(second[1]).toEqual({ role: 'assistant', content: 'Moved it.' });
    expect(String(second[2].content)).toContain('Drop the legacy path as well.');
    // Collecting it is what lets it go, and what it last said is its finding
    mailbox.release(THREAD, 'the importer');
    await expect(running).resolves.toMatchObject({ text: 'Dropped the legacy path too.', isError: false });
  });

  it('stops waiting when the work is stopped, rather than waiting on a model that has gone', async () => {
    const stopping = new AbortController();
    turns(answer('Moved it.'));
    const running = work(piece({ blocking: false }), context({ signal: stopping.signal }), ROUTED, []);
    await vi.waitUntil(() => mailbox.listening(THREAD).includes('the importer'));
    stopping.abort();
    await expect(running).resolves.toMatchObject({ isError: false });
  });
});

describe('a report longer than there is room for', () => {
  it('is cut where it cannot be made to fit, rather than going back over the limit', async () => {
    // Nothing comes back from the asking, so what it wrote stands and the cut
    // is the backstop (see shorten in ../../src/subagents/run.ts)
    mocks.stream.mockImplementation(() => from([]));
    mocks.listModels.mockResolvedValue({ models: [model({ id: 'qwen:14b' })], providers: [] });
    turns(answer('x'.repeat(AGENT.result + 500)));
    const found = await work(piece(), context(), ROUTED, []);
    expect(found.text).toHaveLength(AGENT.result);
    expect(seen.filter((e) => e.type === 'subagent_done')).toEqual([
      { type: 'subagent_done', id: expect.any(String), text: expect.any(String), isError: false, cut: true },
    ]);
  });
});

// The lines its tab shows, in order
function thoughts(): string[] {
  return seen
    .filter((e) => e.type === 'subagent_update' && e.event.type === 'thought')
    .map((e) => (e as { event: { text: string } }).event.text);
}
