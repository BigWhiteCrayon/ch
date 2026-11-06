import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  Classification,
  HarnessEvent,
  HarnessRequest,
  RawReply,
  ToolImage,
  Usage,
} from '../../src/types';
import { collect, from, model, unwrapped } from '../helpers';

// What the harness talks to. Everything that reaches a model, a container or
// the disk is mocked; the pure modules it reasons with — phases, grounding,
// thoughts, the router, the tool registry, the price list — are the real ones,
// so that what is asserted here is the harness driving them rather than a
// second copy of their rules kept in this file.
const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  stream: vi.fn(),
  isFast: vi.fn(),
  approvalCeiling: vi.fn(),
  classify: vi.fn(),
  decide: vi.fn(),
  compact: vi.fn(),
  nearlyFull: vi.fn(),
  size: vi.fn(),
  readContext: vi.fn(),
  keepFindings: vi.fn(),
  setWorkspace: vi.fn(),
  sync: vi.fn(),
  syncReport: vi.fn(),
  projectDue: vi.fn(),
  projectSurvey: vi.fn(),
  projectGet: vi.fn(),
  projectSurveying: vi.fn(),
  projectLooking: vi.fn(),
  projectPrompt: vi.fn(),
  notesCount: vi.fn(),
  notesPrompt: vi.fn(),
  subagentsPrompt: vi.fn(),
  reviewComments: vi.fn(),
  stillRunning: vi.fn(),
  waitFor: vi.fn(),
  subagentReport: vi.fn(),
  // What has been written to this reply, where it is an agent subagent's (see
  // subagents/mailbox.ts). A fake letterbox: what is worth asserting here is
  // what the harness does with a letter, the box itself being tested in
  // ../subagents/mailbox.test.ts.
  letters: vi.fn(),
}));

vi.mock('../../src/llm', () => ({
  listModels: mocks.listModels,
  stream: mocks.stream,
  isFast: mocks.isFast,
  approvalCeiling: mocks.approvalCeiling,
}));
vi.mock('../../src/harness/classifier', () => ({
  classify: mocks.classify,
  DEFAULT_CATEGORY: 'general',
  DEFAULT_EFFORT: 'medium',
  WORKSPACE_DEFAULT_CATEGORY: 'coding',
}));
vi.mock('../../src/harness/planner', () => ({ decide: mocks.decide }));
vi.mock('../../src/harness/compactor', () => ({
  compact: mocks.compact,
  nearlyFull: mocks.nearlyFull,
  size: mocks.size,
}));
vi.mock('../../src/sandbox', () => ({
  PROMPT: 'SANDBOX PROMPT',
  workspacePrompt: (workspace: string, changes: string) => `WORKSPACE PROMPT ${workspace} changes=${changes}`,
  readContext: mocks.readContext,
  keepFindings: mocks.keepFindings,
  setWorkspace: mocks.setWorkspace,
  changes: { sync: mocks.sync, report: mocks.syncReport },
}));
vi.mock('../../src/harness/project', () => ({
  due: mocks.projectDue,
  survey: mocks.projectSurvey,
  get: mocks.projectGet,
  surveying: mocks.projectSurveying,
  looking: mocks.projectLooking,
  prompt: mocks.projectPrompt,
  OWN_COPY: 'OWN COPY',
}));
vi.mock('../../src/harness/notes', () => ({ count: mocks.notesCount, prompt: mocks.notesPrompt }));
vi.mock('../../src/subagents', () => ({
  prompt: mocks.subagentsPrompt,
  reviewComments: mocks.reviewComments,
  stillRunning: mocks.stillRunning,
  waitFor: mocks.waitFor,
  report: mocks.subagentReport,
  TOOL_NAME: 'hand_to_subagent',
  WAIT_TOOL: 'wait_for_subagents',
  MESSAGE_TOOL: 'message_subagent',
  MAX_HANDOUT_DEPTH: 2,
  // The agent kind, for a reply that is one: what it is told it is, and what
  // it may use. The real list is tested in ../subagents/kinds.test.ts; this
  // one refuses a single tool, so that the harness asking the kind at all can
  // be told from the harness having its own idea of what a subagent may do.
  AGENT: { prompt: 'AGENT PROMPT', allows: (tool: { name: string }) => tool.name !== 'record' },
  PLAIN: 'PLAIN PROMPT',
  mailbox: {
    take: mocks.letters,
    WROTE_TO_YOU: (said: string) => `WRITTEN: ${said}`,
    answered: (said: string, calls: { name: string }[]) => said || `called ${calls.map((one) => one.name).join(',')}`,
    ANSWERED: 'ANSWERED: not your report',
  },
}));
vi.mock('../../src/tools/sandbox', () => ({
  ADD_TO_CONTEXT: 'add_to_context',
  toolsPrompt: (names: string[]) => `TOOLS PROMPT ${names.join(',')}`,
}));

import * as cachelock from '../../src/llm/cachelock';
import * as log from '../../src/log';
import {
  ANNOUNCED,
  APPROVAL_TIMEOUT_MS,
  EARLIER,
  OUT_OF_ROOM,
  SET_ASIDE,
  announcing,
  answerApproval,
  answerQuestion,
  maxSteps,
  pickedUp,
  run,
  setAside,
  tools,
} from '../../src/harness';
import { ORDER, PROMPTS as PHASE_PROMPTS, spent as phaseSpent } from '../../src/harness/phases';
import { MAX_GRANTS, TOOL_NAME as MORE_TOOL } from '../../src/harness/allowance';
import { tool as askTool } from '../../src/tools/ask';
import { tool as moreTool } from '../../src/tools/steps';

const opus = model({
  id: 'opus',
  name: 'Opus',
  provider: 'anthropic',
  local: false,
  sophistication: 4,
  default: true,
});
const small = model({ id: 'llama:3b', sophistication: 1 });
// A model that says how much room it has, which is what turns on everything
// bounded by the window: condensing, and the finding-out step's allowance
const roomy = model({ id: 'llama:3b', sophistication: 1, contextWindow: 32000 });

const needs = (sophistication: number, over: Partial<Classification> = {}): Classification =>
  ({
    category: 'question',
    effort: 'low',
    sophistication,
    model: 'llama:3b',
    ...over,
  }) as Classification;

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const WORKSPACE = '/projects/demo';
const ask: HarnessRequest = { thread: THREAD, messages: [{ role: 'user', content: 'hi' }] };
const coding: HarnessRequest = { ...ask, workspace: WORKSPACE };
const signal = () => new AbortController().signal;

// The request passed to each llm.stream call, copied as it was at that moment
// (the harness keeps adding to the same `messages` array)
const snapshots: ChatRequest[] = [];
function onStream(reply: (request: ChatRequest) => AsyncIterable<ChatEvent>) {
  mocks.stream.mockImplementation((request: ChatRequest) => {
    snapshots.push(structuredClone(request));
    return reply(request);
  });
}
// Each call to llm.stream replays the next scripted reply
function script(...replies: ChatEvent[][]) {
  const queue = [...replies];
  onStream(() => from(queue.shift() ?? []));
}

const text = (delta: string): ChatEvent => ({ type: 'text', delta });
// What a pass has used so far, as a provider that counts while it writes
// reports it (see TokensEvent)
const sofar = (input: number, output: number, estimated = false): ChatEvent =>
  ({ type: 'tokens', usage: { input, output }, ...(estimated ? { estimated: true } : {}) }) as ChatEvent;
const reasoning = (delta: string): ChatEvent => ({ type: 'reasoning', delta });
const done = (stopReason = 'end_turn', usage: Usage = { input: 1, output: 2 }, raw?: RawReply): ChatEvent =>
  ({ type: 'done', stopReason, usage, ...(raw ? { raw } : {}) }) as ChatEvent;
const call = (id: string, name: string, input: Record<string, unknown> | null = {}): ChatEvent => ({
  type: 'tool_call',
  id,
  name,
  input,
});

// A whole reply in one pass. It has to write something for the user: a pass
// that writes nothing is asked again for its answer (see NO_ANSWER), which is
// tested where that behaviour belongs rather than tripped over everywhere else.
const answer = (said = 'Done.'): ChatEvent[] => [text(said), done()];

const types = (events: HarnessEvent[]) => events.map((e) => e.type);
const only = <T extends HarnessEvent['type']>(events: HarnessEvent[], type: T) =>
  events.filter((e) => e.type === type) as Extract<HarnessEvent, { type: T }>[];
const system = (at = 0) => snapshots[at].system ?? '';
const last = () => snapshots.at(-1)!;

// A tool registered for the test, returning what it is told to
function register(name: string, run: (input: Record<string, unknown>, context: unknown) => unknown, over = {}) {
  tools.register({
    name,
    description: `Does ${name}.`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    run,
    ...over,
  });
}

beforeEach(() => {
  tools.clear();
  snapshots.length = 0;
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.listModels.mockResolvedValue({ models: [opus, small], providers: [] });
  mocks.isFast.mockReturnValue(false);
  mocks.approvalCeiling.mockReturnValue(5);
  mocks.classify.mockResolvedValue(needs(1));
  mocks.decide.mockResolvedValue({ plan: true });
  mocks.compact.mockImplementation((messages: unknown) => ({ messages, usage: { input: 0, output: 0 } }));
  mocks.nearlyFull.mockReturnValue(false);
  mocks.size.mockReturnValue(100);
  mocks.readContext.mockResolvedValue('');
  mocks.keepFindings.mockResolvedValue(true);
  mocks.projectDue.mockReturnValue(false);
  mocks.projectGet.mockReturnValue('');
  mocks.projectSurveying.mockReturnValue(false);
  mocks.projectLooking.mockReturnValue([]);
  mocks.projectPrompt.mockImplementation((note: string) => `PROJECT PROMPT ${note}`);
  mocks.notesCount.mockReturnValue(0);
  mocks.notesPrompt.mockImplementation((kept: number) => `NOTES PROMPT ${kept}`);
  mocks.subagentsPrompt.mockReturnValue('');
  mocks.stillRunning.mockReturnValue([]);
  mocks.letters.mockReturnValue([]);
  mocks.sync.mockResolvedValue({ pulled: [], merged: [], clashes: [] });
  mocks.syncReport.mockReturnValue('SYNCED');
});

describe('maxSteps', () => {
  it('gives a reply more rounds the more effort its message calls for', () => {
    expect(maxSteps('low', false)).toBe(10);
    expect(maxSteps('medium', false)).toBe(20);
    expect(maxSteps('high', false)).toBe(40);
  });

  // Finding, reading and changing files all take tool calls, so a thread with
  // a workspace is given six times as many
  it('gives a thread with a workspace six times as many', () => {
    expect(maxSteps('low', true)).toBe(60);
    expect(maxSteps('medium', true)).toBe(120);
    expect(maxSteps('high', true)).toBe(240);
  });
});

describe('announcing', () => {
  it.each([
    'I need to find where toast notifications are implemented',
    "I'll search the codebase for the timer",
    'Let me look at how this is wired up',
    'First, I should check the renderer',
    'I am going to examine the sandbox code',
  ])('reads "%s" as a model saying what it is about to do', (said) => {
    expect(announcing(said)).toBe(true);
  });

  // A report of looking already done is not an announcement: badgering a model
  // that has searched and read and then summarised would be worse than taking
  // what it said
  it.each([
    'I checked where they are implemented, and they are in renderer.ts',
    'The timer is in renderer.ts at line 1988',
    '',
    '   ',
  ])('does not read "%s" as one', (said) => {
    expect(announcing(said)).toBe(false);
  });

  it('does not read an answer of any substance as one, however it opens', () => {
    expect(announcing(`Let me explain. ${'The timer works like this. '.repeat(40)}`)).toBe(false);
  });

  // The intention and the looking have to be in the same sentence, or any
  // answer that happens to say both words would set the model off again
  it('wants the intention and the looking in one sentence', () => {
    expect(announcing('I should answer now. Searching is done.')).toBe(false);
  });
});

describe('pickedUp', () => {
  it('gives the model an account of what it had done, and tells it to carry on', () => {
    const said = pickedUp({ did: ['read_file src/a.ts — 40 lines', 'run_command npm test — passed'] });
    expect(said).toContain('The app closed while you were working on this message');
    expect(said).toContain('- read_file src/a.ts — 40 lines');
    expect(said).toContain('- run_command npm test — passed');
    expect(said).toContain('The container you work in is kept when the app closes');
    expect(said).toContain('Do not do again what the list shows as done');
  });

  it('says to start again when nothing it did was recorded', () => {
    const said = pickedUp({ did: [] });
    expect(said).toContain('Nothing you did had been recorded');
    expect(said).not.toContain('Everything in that list happened');
  });

  // What it wrote is already on screen, so it carries on from where it stops
  // rather than writing the answer twice
  it('tells it to carry on from what it had already written, where it wrote any', () => {
    expect(pickedUp({ did: [], text: 'The timer is' })).toContain('Carry on from where it');
    expect(pickedUp({ did: [] })).not.toContain('Carry on from where it');
  });
});

describe('setAside', () => {
  const noted = (id: string) => ({
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id, name: 'add_to_context', input: {} }],
  });
  const result = (id: string, content: string) => ({
    role: 'tool' as const,
    toolCallId: id,
    name: 'read_file',
    content,
    isError: false,
  });

  // Once a note has been written, everything read before writing it is covered
  // by the note, and the text of those results can go
  it('sets aside the results the model had read when it wrote its note', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      result('r1', 'first file'),
      result('r2', 'second file'),
      noted('n1'),
      result('r3', 'read after the note'),
    ];
    expect(setAside(messages, 1)).toBe(2);
    expect(messages[1].content).toBe(SET_ASIDE);
    expect(messages[2].content).toBe(SET_ASIDE);
    // What it has not written about is left exactly as it is
    expect(messages[4].content).toBe('read after the note');
  });

  it('leaves everything alone when no note was written: a model that writes none works blind', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }, result('r1', 'first file')];
    expect(setAside(messages, 1)).toBe(0);
    expect(messages[1].content).toBe('first file');
  });

  it('does not touch the conversation before this reply started', () => {
    const messages = [result('r0', 'from an earlier reply'), noted('n1')];
    expect(setAside(messages, 1)).toBe(0);
    expect(messages[0].content).toBe('from an earlier reply');
  });

  it('counts the last note, so a second note covers what came before it', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      result('r1', 'one'),
      noted('n1'),
      result('r2', 'two'),
      noted('n2'),
    ];
    expect(setAside(messages, 1)).toBe(2);
    expect(messages[3].content).toBe(SET_ASIDE);
  });

  it('does not count a result it has already set aside', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }, result('r1', SET_ASIDE), noted('n1')];
    expect(setAside(messages, 1)).toBe(0);
  });
});

describe('classification and routing', () => {
  it('classifies, routes to a model that suits the message, then answers', async () => {
    script([text('Hello'), done()]);
    const events = await collect(run(ask, signal()));

    expect(types(events)).toEqual(['classification', 'model', 'step', 'text', 'usage', 'done']);
    expect(events[0]).toEqual({ type: 'classification', ...needs(1) });
    expect(events[1]).toEqual({
      type: 'model',
      provider: 'local',
      model: 'llama:3b',
      name: 'llama:3b',
      sophistication: 1,
      reason: 'matched',
    });
    expect(events[3]).toEqual({ type: 'text', delta: 'Hello' });
    // What this pass itself cost, reported as it ends rather than at the end
    // of the reply, so a thread's total grows as the work happens
    expect(events[4]).toMatchObject({ type: 'usage', purpose: 'reply', input: 1, output: 2 });
    expect(events[5]).toEqual({ type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 2 }, steps: 1 });
    expect(snapshots[0]).toMatchObject({ provider: 'local', model: 'llama:3b' });
    // The classifier is given the models to pick from, and the thread's note
    expect(mocks.classify.mock.calls[0][1]).toEqual([opus, small]);
  });

  // ---- The count while a pass is still being written (see TokensEvent)
  //
  // A pass reports what it used when it ends, which on a local model is a
  // minute of nothing moving. A provider that counts as it goes has those
  // counts passed on meanwhile, priced the same way, for the window to show.
  it('passes on what a pass has used so far, priced as the finished pass is', async () => {
    script([sofar(1000, 0), text('Hello'), sofar(1000, 40), done('end_turn', { input: 1000, output: 42 })]);
    const events = await collect(run(ask, signal()));

    expect(types(events)).toEqual(['classification', 'model', 'step', 'tokens', 'text', 'tokens', 'usage', 'done']);
    expect(only(events, 'tokens')).toEqual([
      { type: 'tokens', purpose: 'reply', provider: 'local', model: 'llama:3b', input: 1000, output: 0, cost: 0 },
      { type: 'tokens', purpose: 'reply', provider: 'local', model: 'llama:3b', input: 1000, output: 40, cost: 0 },
    ]);
    // ...and the pass's own count still arrives at the end, which is the one
    // that gets recorded
    expect(only(events, 'usage')[0]).toMatchObject({ purpose: 'reply', input: 1000, output: 42 });
  });

  it('marks a count nobody counted as the estimate it is', async () => {
    script([sofar(500, 10, true), text('Hi'), done()]);
    expect(only(await collect(run(ask, signal())), 'tokens')).toEqual([
      {
        type: 'tokens',
        purpose: 'reply',
        provider: 'local',
        model: 'llama:3b',
        input: 500,
        output: 10,
        cost: 0,
        estimated: true,
      },
    ]);
  });

  it('routes a demanding request to a more capable model', async () => {
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(events[1]).toMatchObject({ type: 'model', model: 'opus', reason: 'matched' });
    expect(snapshots[0]).toMatchObject({ provider: 'anthropic', model: 'opus' });
  });

  it('falls back to the default model, category and effort when classification fails', async () => {
    mocks.classify.mockResolvedValue({ failed: true, reason: 'timeout' });
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(events[0]).toEqual({ type: 'classification', failed: true, reason: 'timeout' });
    expect(events[1]).toMatchObject({ type: 'model', model: 'opus', reason: 'unclassified' });
    // DEFAULT_CATEGORY, which is 'general' outside a workspace
    expect(system()).toContain('This is a general request');
  });

  // A thread with a workspace is most likely there to change code, so an
  // unclassifiable message in one is treated as a coding task
  it('treats an unclassifiable message in a workspace as a coding task', async () => {
    mocks.classify.mockResolvedValue({ failed: true, reason: 'timeout' });
    script(answer());
    await collect(run(coding, signal()));
    expect(system()).toContain('This is a coding task');
  });

  it("serves the user's own pick regardless of the classification", async () => {
    mocks.classify.mockResolvedValue(needs(5));
    script(answer());
    const events = await collect(run({ ...ask, provider: 'local', model: 'llama:3b' }, signal()));
    expect(events[1]).toMatchObject({ type: 'model', model: 'llama:3b', reason: 'picked' });
  });

  it('reports why no model is available, and asks none', async () => {
    mocks.listModels.mockResolvedValue({
      models: [],
      providers: [
        { id: 'anthropic', name: 'Anthropic', ok: false, error: 'No API key.' },
        { id: 'local', name: 'Local', ok: true },
      ],
    });
    mocks.classify.mockResolvedValue({ failed: true, reason: 'No models available.' });
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'other',
      message: 'No models available.\nAnthropic: No API key.',
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('stops before answering if cancelled during classification', async () => {
    const controller = new AbortController();
    mocks.classify.mockImplementation(async () => {
      controller.abort();
      return { failed: true, reason: 'aborted' };
    });
    const events = await collect(run(ask, controller.signal));
    expect(types(events)).toEqual(['classification', 'done']);
    expect(events[1]).toMatchObject({ stopReason: 'cancelled', steps: 0 });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('reports what classifying cost, where the classifier said what it used', async () => {
    mocks.classify.mockResolvedValue(
      needs(1, { provider: 'local', model: 'llama:3b', usage: { input: 120, output: 3 } })
    );
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(only(events, 'usage')[0]).toMatchObject({
      purpose: 'classification',
      provider: 'local',
      model: 'llama:3b',
      input: 120,
      output: 3,
    });
  });

  // The model that would classify is busy with a request already in progress,
  // which the user is told about rather than left waiting through
  it('says so when classifying has to wait its turn', async () => {
    mocks.classify.mockImplementation(async (_ask, _models, _signal, queued: () => void) => {
      queued();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return needs(1);
    });
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(types(events).slice(0, 2)).toEqual(['queued', 'classification']);
  });

  // A reply picked up after the app closed keeps the rating the message was
  // given the first time: the window still shows it, so nothing is announced
  it('reuses the rating a resumed message already had, and does not classify again', async () => {
    script(answer());
    const resumed = { did: [], classification: needs(1, { category: 'question' }) };
    const events = await collect(run({ ...ask, resumed }, signal()));
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(types(events)).not.toContain('classification');
    expect(events[0]).toMatchObject({ type: 'model' });
  });

  it('classifies again when what the resumed reply kept had failed', async () => {
    script(answer());
    const resumed = { did: [], classification: { failed: true, reason: 'timeout' } as Classification };
    await collect(run({ ...ask, resumed }, signal()));
    expect(mocks.classify).toHaveBeenCalled();
  });

  // A first look at a workspace is a long job on the local models, which serve
  // one request at a time, so a reply made while one is running goes to a
  // hosted model rather than queueing behind a job nobody is waiting for
  it('prefers a hosted model while a workspace is being looked at', async () => {
    mocks.projectLooking.mockReturnValue(['/other/workspace']);
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(events[1]).toMatchObject({ type: 'model', model: 'opus' });
  });

  it('prefers a hosted model in fast mode, for the speed of it', async () => {
    mocks.isFast.mockReturnValue(true);
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(events[1]).toMatchObject({ type: 'model', model: 'opus' });
  });

  // ---- A model above the approval ceiling waits for the user's say-so

  // The answer comes after the event has been handed on, as it does from the
  // window, so it is given a turn later than the one the event is read in
  async function approving(request: typeof ask, answered: boolean | 'abort') {
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    for await (const event of run(request, controller.signal, 'request-1')) {
      events.push(event);
      if (event.type !== 'approval') continue;
      setTimeout(() => (answered === 'abort' ? controller.abort() : answerApproval('request-1', answered)), 0);
    }
    return events;
  }

  it('asks before using a model above the ceiling, and keeps it when approved', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const events = await approving(ask, true);
    expect(types(events)).toEqual(['classification', 'approval', 'model', 'step', 'text', 'usage', 'done']);
    expect(events[1]).toEqual({
      type: 'approval',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      ceiling: 3,
      fallbackName: 'llama:3b',
      timeoutMs: APPROVAL_TIMEOUT_MS,
    });
    expect(events[2]).toMatchObject({ type: 'model', model: 'opus', reason: 'matched' });
    expect(snapshots[0]).toMatchObject({ provider: 'anthropic', model: 'opus' });
  });

  it('uses the best model within the ceiling when the user does not approve', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const events = await approving(ask, false);
    expect(events[2]).toMatchObject({ type: 'model', model: 'llama:3b', sophistication: 1, reason: 'not_approved' });
    expect(snapshots[0]).toMatchObject({ provider: 'local', model: 'llama:3b' });
  });

  // The user may have walked away from the window, so the question is not
  // waited on for ever
  it('uses the best model within the ceiling when nobody answers in time', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    vi.useFakeTimers();
    try {
      const events: HarnessEvent[] = [];
      const reply = (async () => {
        for await (const event of run(ask, signal(), 'request-1')) events.push(event);
      })();
      // Up to the question, which is where it stops to wait
      for (let i = 0; i < 20 && !events.some((e) => e.type === 'approval'); i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(types(events)).toEqual(['classification', 'approval']);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
      await reply;
      expect(events[2]).toMatchObject({ type: 'model', model: 'llama:3b', reason: 'not_approved' });
      expect(snapshots[0]).toMatchObject({ provider: 'local', model: 'llama:3b' });
      // Nothing is left waiting, so an answer that comes late does nothing
      expect(() => answerApproval('request-1', true)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting until the time is up', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    vi.useFakeTimers();
    try {
      const events: HarnessEvent[] = [];
      const reply = (async () => {
        for await (const event of run(ask, signal(), 'request-1')) events.push(event);
      })();
      for (let i = 0; i < 20 && !events.some((e) => e.type === 'approval'); i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1);
      expect(types(events)).toEqual(['classification', 'approval']);
      answerApproval('request-1', true);
      await reply;
      expect(events.find((e) => e.type === 'model')).toMatchObject({ type: 'model', model: 'opus' });
    } finally {
      vi.useRealTimers();
    }
  });

  // A reply picked up after the app closed keeps the answer already given, so
  // the user is not asked about the same model twice
  it('reuses an approval given before the app closed, without asking again', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const resumed = { did: [], approval: { provider: 'anthropic', model: 'opus', approved: true } };
    const events = await collect(run({ ...ask, resumed }, signal(), 'request-1'));
    expect(types(events)).not.toContain('approval');
    expect(events.find((e) => e.type === 'model')).toMatchObject({ type: 'model', model: 'opus', reason: 'matched' });
    expect(snapshots[0]).toMatchObject({ provider: 'anthropic', model: 'opus' });
  });

  it('reuses a refusal given before the app closed, and does not ask again', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const resumed = { did: [], approval: { provider: 'anthropic', model: 'opus', approved: false } };
    const events = await collect(run({ ...ask, resumed }, signal(), 'request-1'));
    expect(types(events)).not.toContain('approval');
    expect(events.find((e) => e.type === 'model')).toMatchObject({
      type: 'model',
      model: 'llama:3b',
      reason: 'not_approved',
    });
    expect(snapshots[0]).toMatchObject({ provider: 'local', model: 'llama:3b' });
  });

  it('asks again when the saved approval was for a different model', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const resumed = { did: [], approval: { provider: 'anthropic', model: 'sonnet', approved: true } };
    const events = await approving({ ...ask, resumed }, true);
    expect(types(events)).toContain('approval');
    expect(events.find((e) => e.type === 'model')).toMatchObject({ type: 'model', model: 'opus', reason: 'matched' });
  });

  it('does not ask when the model is within the ceiling', async () => {
    mocks.approvalCeiling.mockReturnValue(4);
    mocks.classify.mockResolvedValue(needs(4));
    script(answer());
    const events = await collect(run(ask, signal(), 'request-1'));
    expect(types(events)).toEqual(['classification', 'model', 'step', 'text', 'usage', 'done']);
  });

  it("does not ask about the user's own pick", async () => {
    mocks.approvalCeiling.mockReturnValue(0);
    script(answer());
    const events = await collect(run({ ...ask, provider: 'anthropic', model: 'opus' }, signal(), 'request-1'));
    expect(only(events, 'approval')).toEqual([]);
    expect(events[1]).toMatchObject({ type: 'model', model: 'opus', reason: 'picked' });
  });

  it('stops if cancelled while waiting to be told', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    const events = await approving(ask, 'abort');
    expect(types(events)).toEqual(['classification', 'approval', 'done']);
    expect(events[2]).toMatchObject({ stopReason: 'cancelled', steps: 0 });
    expect(mocks.stream).not.toHaveBeenCalled();
    // Nothing is left waiting, so a late answer does nothing
    expect(() => answerApproval('request-1', true)).not.toThrow();
  });

  it('ignores an answer for a request that is not waiting', () => {
    expect(() => answerApproval('nobody', true)).not.toThrow();
  });

  // ---- A model that stops to ask the user something

  // As for approving: the answer is given a turn after the event is read
  async function questioning(answered: string | 'abort', request = ask) {
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    for await (const event of run(request, controller.signal, 'request-1')) {
      events.push(event);
      if (event.type !== 'question') continue;
      setTimeout(() => (answered === 'abort' ? controller.abort() : answerQuestion('request-1', answered)), 0);
    }
    return events;
  }
  const asks = (input: Record<string, unknown> = { question: 'Which one?', options: ['A', 'B'] }) => [
    call('q1', 'ask_user', input),
    done('tool_use'),
  ];

  it('holds the reply until the user answers, and gives the model the answer', async () => {
    tools.register(askTool);
    script(asks(), answer());
    const events = await questioning('B, please');
    expect(only(events, 'question')).toEqual([{ type: 'question', question: 'Which one?', options: ['A', 'B'] }]);
    expect(types(events).indexOf('question')).toBeGreaterThan(types(events).indexOf('tool_call'));
    expect(only(events, 'tool_result')).toMatchObject([{ name: 'ask_user', output: 'The user answered: B, please' }]);
    expect(snapshots[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'The user answered: B, please' });
  });

  it('asks two questions of one round one after the other', async () => {
    tools.register(askTool);
    script(
      [
        call('q1', 'ask_user', { question: 'First?' }),
        call('q2', 'ask_user', { question: 'Second?' }),
        done('tool_use'),
      ],
      answer()
    );
    const events = await questioning('yes');
    expect(only(events, 'question').map((e) => e.question)).toEqual(['First?', 'Second?']);
    expect(only(events, 'tool_result').map((e) => e.output)).toEqual([
      'The user answered: yes',
      'The user answered: yes',
    ]);
  });

  it('stops if cancelled while the user is being waited on', async () => {
    tools.register(askTool);
    script(asks(), answer());
    const events = await questioning('abort');
    expect(only(events, 'tool_result')).toMatchObject([
      { name: 'ask_user', isError: true, output: 'The reply was stopped before the user answered.' },
    ]);
    // Nothing is left waiting, so a late answer does nothing
    expect(() => answerQuestion('request-1', 'late')).not.toThrow();
  });

  it('does not take an empty answer, or one for a request that is not waiting', () => {
    expect(() => answerQuestion('nobody', 'yes')).not.toThrow();
    expect(() => answerQuestion('request-1', '  ')).not.toThrow();
  });

  it('offers the question to the planning step, and to nothing else there', async () => {
    tools.register(askTool);
    register('get_time', () => '12:00');
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    script(answer('found'), answer('the plan'), answer('done'), answer('Done.'));
    await collect(run({ ...coding, plan: 'always' }, signal(), 'request-1'));
    const offered = snapshots.map((s) => (s.tools ?? []).map((t) => t.name));
    expect(offered[1]).toEqual(['ask_user']);
    expect(offered[0]).toContain('ask_user');
    expect(offered[2]).toContain('ask_user');
    expect(offered[3]).toEqual([]);
  });

  it('does not offer the question where there is no way to be answered', async () => {
    tools.register(askTool);
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(ask, signal()));
    expect(snapshots[0].tools?.map((t) => t.name)).toEqual(['get_time']);
  });

  // What a tool is told to hold its own work below: the level of the model on
  // the thread, not the level the classifier asked for. The two part when the
  // request is routed down, and a coder piece held below the rating rather
  // than below the model would be handed to that model's own equal (see capped
  // in ../../src/subagents/run.ts).
  const levelled = async (request: HarnessRequest) => {
    let told: number | undefined;
    register('get_time', (_input, context) => {
      told = (context as { sophistication?: number }).sophistication;
      return '12:00';
    });
    script([call('c1', 'get_time'), done('tool_use')], answer());
    await collect(run(request, signal()));
    return told;
  };

  it('tells a tool the level of the model answering, not the level asked for', async () => {
    mocks.approvalCeiling.mockReturnValue(3);
    mocks.classify.mockResolvedValue(needs(4));
    expect(await levelled(ask)).toBe(1);
  });

  it('tells it the rating itself where the model chosen meets the rating', async () => {
    mocks.classify.mockResolvedValue(needs(4));
    expect(await levelled(ask)).toBe(4);
  });

  it('falls back to the rating for a picked model the list does not know', async () => {
    mocks.classify.mockResolvedValue(needs(3));
    expect(await levelled({ ...ask, provider: 'anthropic', model: 'mystery' })).toBe(3);
  });

  it('tells it nothing where neither the model nor the classifier has a level', async () => {
    mocks.classify.mockResolvedValue({ failed: true });
    expect(await levelled({ ...ask, provider: 'anthropic', model: 'mystery' })).toBeUndefined();
  });

  // A workspace nobody has looked at yet is looked at, and the reply does not
  // wait for it: the look takes as long as the project is big
  it('starts a first look at an unvisited workspace without waiting for it', async () => {
    mocks.projectDue.mockReturnValue(true);
    mocks.projectSurvey.mockReturnValue(new Promise(() => {}));
    script(answer());
    const events = await collect(run(coding, signal()));
    expect(mocks.projectSurvey).toHaveBeenCalledWith(WORKSPACE, THREAD);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('what the model is told', () => {
  it('sends the base prompt, the task prompt and how to write, and no tools, when there are none', async () => {
    script(answer());
    await collect(run(ask, signal()));
    expect(system()).toContain('You are a coding agent');
    expect(system()).toContain('This is a question');
    expect(system()).toContain('Write what the user will read in Markdown');
    expect(snapshots[0].tools).toEqual([]);
    // Everything that only means something to a model holding a tool is left out
    expect(system()).not.toContain('SANDBOX PROMPT');
    expect(system()).not.toContain('TOOLS PROMPT');
    expect(system()).not.toContain('After every tool call');
    // The context note goes with them. It is written and read through tools,
    // so a reply that has none has no note to carry and none to add to.
    expect(mocks.readContext).not.toHaveBeenCalled();
  });

  it.each([
    ['question', 'This is a question'],
    ['general', 'This is a general request'],
    ['coding', 'This is a coding task'],
    ['suggestion', 'This is a suggestion'],
  ])('tells a %s task what kind of task it is', async (category, said) => {
    mocks.classify.mockResolvedValue(needs(1, { category: category as never }));
    script(answer());
    await collect(run(ask, signal()));
    expect(system()).toContain(said);
  });

  // A reply worked through in steps is told about the step it is in instead:
  // being told to write a plan while holding the tools to skip it is the
  // problem the steps were made to fix
  it('tells a coding reply how to go about it, where it is not worked through in steps', async () => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    script(answer());
    await collect(run(ask, signal()));
    expect(system()).toContain('Go about solving this in discrete steps');
  });

  it('offers the registered tools, with the tool and sandbox instructions', async () => {
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(ask, signal()));
    expect(snapshots[0].tools).toEqual([
      {
        name: 'get_time',
        description: 'Does get_time.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
    expect(system()).toContain('After every tool call');
    expect(system()).toContain('TOOLS PROMPT get_time');
    expect(system()).toContain('SANDBOX PROMPT');
    // What it is told about keeping what it finds, which is per provider
    expect(system()).toContain('Write down what you find out');
  });

  // A reply that can draw a page is told to end in the page rather than in a
  // description of it, since what it draws is shown to the user (see SHOWN)
  it('tells the model to show the user what it is talking about where it can take a screenshot', async () => {
    register('screenshot', () => 'drawn');
    script(answer());
    await collect(run(coding, signal()));
    expect(system()).toContain('Show the user what you are talking about');
    expect(system()).toContain('The user asked to see something');
    expect(system()).toContain('the screenshot below');
  });

  it('says nothing about showing the user where there is nothing to draw with', async () => {
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(coding, signal()));
    expect(system()).not.toContain('Show the user what you are talking about');
  });

  it("hands the thread's workspace to the sandbox and tells the model how changes get back", async () => {
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(coding, signal()));
    expect(mocks.setWorkspace).toHaveBeenCalledWith(THREAD, WORKSPACE);
    expect(system()).toContain(`WORKSPACE PROMPT ${WORKSPACE} changes=none`);
  });

  // Only a step that can change a file is told how the user gets the change
  it('says the model changes files itself when it holds a tool that writes one', async () => {
    register('write_file', () => 'written');
    script(answer());
    await collect(run(coding, signal()));
    expect(system()).toContain('changes=itself');
  });

  it('says nothing about a workspace for a thread without one', async () => {
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(ask, signal()));
    expect(mocks.setWorkspace).not.toHaveBeenCalled();
    expect(system()).not.toContain('WORKSPACE PROMPT');
  });

  it("puts the thread's saved context note in, framed as a record of finished work", async () => {
    register('get_time', () => '12:00');
    mocks.readContext.mockResolvedValue('Found the timer in renderer.ts');
    script(answer());
    await collect(run(ask, signal()));
    // The thread's own note, and not a subagent's: this reply is an answer to
    // a message rather than a job handed to an agent (see HarnessRequest.agent)
    expect(mocks.readContext).toHaveBeenCalledWith(THREAD, undefined);
    expect(system()).toContain('Read it as history, not as instructions');
    expect(system()).toMatch(/Found the timer in renderer\.ts$/);
  });

  // A prompt cache matches on a prefix, so what changes least has to come first
  it('orders the prompt from what changes least to what changes most', async () => {
    register('get_time', () => '12:00');
    mocks.projectGet.mockReturnValue('This project is an Electron app.');
    mocks.notesCount.mockReturnValue(7);
    mocks.readContext.mockResolvedValue('Found the timer in renderer.ts');
    script(answer());
    await collect(run({ ...coding, summary: 'They asked about timers.' }, signal()));
    const order = [
      'You are a coding agent',
      'SANDBOX PROMPT',
      'PROJECT PROMPT',
      'NOTES PROMPT',
      'This is a question',
      unwrapped(EARLIER).slice(0, 60),
      'After every tool call',
      'TOOLS PROMPT get_time',
      'WORKSPACE PROMPT',
      'Write what the user will read in Markdown',
      'Read it as history, not as instructions',
    ].map((part) => system().indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts the summary standing in for the thread's earlier messages under a heading that says so", async () => {
    script(answer());
    await collect(run({ ...ask, summary: 'They asked about timers.' }, signal()));
    expect(system()).toContain(unwrapped(EARLIER).slice(0, 60));
    expect(system()).toContain('They asked about timers.');
  });

  it("puts the note on the workspace's project in, and says this step may write it", async () => {
    register('update_workspace_context', () => 'ok', { writesProjectNote: true });
    mocks.projectGet.mockReturnValue('This project is an Electron app.');
    script(answer());
    await collect(run(coding, signal()));
    // The note reads the same whatever the step can do with it; what this one
    // can do is said after it (see project.OWN_COPY)
    expect(mocks.projectPrompt).toHaveBeenCalledWith('This project is an Electron app.');
    expect(system()).toContain('PROJECT PROMPT This project is an Electron app.');
    expect(system()).toContain('OWN COPY');
  });

  it('says nothing about writing the note to a step that does not hold the tool for it', async () => {
    register('get_time', () => '12:00');
    mocks.projectGet.mockReturnValue('An Electron app.');
    script(answer());
    await collect(run(coding, signal()));
    expect(mocks.projectPrompt).toHaveBeenCalledWith('An Electron app.');
    expect(system()).not.toContain('OWN COPY');
  });

  // Searching and writing notes is all tools, so a model that cannot call one
  // has nothing to do with them but be told they exist
  it("tells a model with tools how many of the workspace's notes it can search", async () => {
    register('get_time', () => '12:00');
    mocks.notesCount.mockReturnValue(7);
    script(answer());
    await collect(run(coding, signal()));
    expect(mocks.notesCount).toHaveBeenCalledWith(WORKSPACE, THREAD);
    expect(system()).toContain('NOTES PROMPT 7');
  });

  it('says nothing about notes to a thread with no workspace to keep them in', async () => {
    register('get_time', () => '12:00');
    script(answer());
    await collect(run(ask, signal()));
    expect(system()).not.toContain('NOTES PROMPT');
  });

  describe('while a first look at the workspace is going on', () => {
    beforeEach(() => mocks.projectSurveying.mockReturnValue(true));

    it('tells the thread what is happening and to keep what it finds to itself', async () => {
      register('get_time', () => '12:00');
      script(answer());
      await collect(run(coding, signal()));
      expect(system()).toContain('Nobody has worked in this workspace before');
      expect(system()).toContain('Write what you work out into your own context note');
    });

    // The look is writing that note, and a thread that has just met the
    // workspace has nothing to add that the look is not finding out properly
    it('keeps back the tools that write the note on the project', async () => {
      register('update_workspace_context', () => 'ok', { writesProjectNote: true });
      register('get_time', () => '12:00');
      script(answer());
      await collect(run(coding, signal()));
      expect(snapshots[0].tools!.map((t) => t.name)).toEqual(['get_time']);
    });

    it('does not offer to update a note there is no settled version of yet', async () => {
      register('update_workspace_context', () => 'ok', { writesProjectNote: true });
      mocks.projectGet.mockReturnValue('Half-read note.');
      script(answer());
      await collect(run(coding, signal()));
      expect(mocks.projectPrompt).toHaveBeenCalledWith('Half-read note.');
      expect(system()).not.toContain('OWN COPY');
    });
  });

  // The instructions are built once per step and reused all the way through
  // it: a local server reads only what was added to the end of a prompt it has
  // seen, and rebuilding the head makes it read the whole thing again
  it('sends one step the same instructions on every round of it', async () => {
    register('get_time', () => '12:00');
    script([text('Looking.'), call('c1', 'get_time'), done('tool_use')], answer());
    await collect(run(ask, signal()));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].system).toBe(snapshots[0].system);
  });

  // ...and while they are the same, a local model is kept for this reply rather
  // than handed to whatever else is waiting for it (see src/llm/cachelock.ts)
  describe('keeping a local model for the reply', () => {
    const held = cachelock.modelKey('local', 'llama:3b');

    it('keeps it where every round only adds to what the model has read', async () => {
      register('get_time', () => '12:00');
      cachelock.held(held, THREAD);
      script([text('Looking.'), call('c1', 'get_time'), done('tool_use')], answer());
      await collect(run(ask, signal()));
      expect(cachelock.holder(held)).toBe(THREAD);
    });

    // A pass that wrote nothing is asked again for its answer, which puts a
    // message in behind the ones the model has already read: from there it
    // reads the conversation again whatever else happens, so the model is
    // worth more to whatever is waiting than it is to this reply
    it('gives it up where the reply pushes a message in among those already read', async () => {
      cachelock.held(held, THREAD);
      script([done()], answer());
      await collect(run(ask, signal()));
      expect(cachelock.holder(held)).toBeUndefined();
    });
  });

  // One read per set of instructions, not one per round: the note is read
  // where the prompt is built, and the prompt is built once for the step (see
  // the round-to-round test above, and the per-phase one under the steps)
  it('reads the context note once for a reply that is not worked through in steps', async () => {
    register('get_time', () => '12:00');
    script([text('Looking.'), call('c1', 'get_time'), done('tool_use')], answer());
    await collect(run(ask, signal()));
    expect(mocks.readContext).toHaveBeenCalledTimes(1);
  });

  it('ties the log lines about a reply together under the request it was for', async () => {
    const info = vi.spyOn(log, 'info');
    script(answer());
    await collect(run(ask, signal(), 'req-1'));
    expect(info).toHaveBeenCalledWith('route', expect.objectContaining({ request: 'req-1', thread: THREAD }));
  });
});

describe('which tools a reply is offered', () => {
  it('offers a tool that needs a workspace only in a thread that has one, and gives it the workspace', async () => {
    const search = vi.fn(() => 'src/a.ts');
    register('search_code', search, { needsWorkspace: true });
    register('get_time', () => '12:00');

    script(answer());
    await collect(run(ask, signal()));
    expect(last().tools!.map((t) => t.name)).toEqual(['get_time']);

    snapshots.length = 0;
    script([call('c1', 'search_code', { q: 'timer' }), done('tool_use')], answer());
    await collect(run(coding, signal()));
    expect(snapshots[0].tools!.map((t) => t.name)).toEqual(['search_code', 'get_time']);
    expect(search).toHaveBeenCalledWith(
      { q: 'timer' },
      expect.objectContaining({ threadId: THREAD, workspace: WORKSPACE })
    );
  });

  it('offers a tool for general chats only in a thread that has no workspace', async () => {
    register('create_workspace', () => 'made', { generalOnly: true });
    register('get_time', () => '12:00');

    script(answer());
    await collect(run(ask, signal()));
    expect(last().tools!.map((t) => t.name)).toEqual(['create_workspace', 'get_time']);

    snapshots.length = 0;
    script(answer());
    await collect(run(coding, signal()));
    expect(snapshots[0].tools!.map((t) => t.name)).toEqual(['get_time']);
  });

  it('offers a tool that needs review comments only when the message carries them', async () => {
    register('reply_to_comment', () => 'ok', { needsReview: true });
    register('get_time', () => '12:00');

    script(answer());
    await collect(run(ask, signal()));
    expect(last().tools!.map((t) => t.name)).toEqual(['get_time']);

    snapshots.length = 0;
    mocks.reviewComments.mockResolvedValue('answered');
    script(answer());
    await collect(run({ ...ask, review: true }, signal()));
    expect(snapshots[0].tools!.map((t) => t.name)).toContain('reply_to_comment');
  });

  // A tool whose bounds change with the step says so for that step, rather
  // than describing every step's in all of them
  it('lets a tool describe itself for the step and the window it is offered in', async () => {
    register('read_file', () => 'contents', {
      describe: (phase?: string, window?: number) => `read for ${phase ?? 'no phase'} in ${window ?? 'no window'}`,
      schemaFor: () => ({ type: 'object', properties: { path: { type: 'string' } } }),
    });
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    script(answer());
    await collect(run(ask, signal()));
    expect(snapshots[0].tools).toEqual([
      {
        name: 'read_file',
        description: 'read for no phase in 32000',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });
});

describe('the decision loop with tools', () => {
  const getTime = vi.fn();

  beforeEach(() => {
    getTime.mockReset().mockImplementation(async ({ zone }: { zone: string }) => `12:00 in ${zone}`);
    register('get_time', getTime);
  });

  it('runs a tool the model calls, feeds the result back, and lets it decide again', async () => {
    const raw = { provider: 'anthropic', content: [{ type: 'thinking' }] };
    script(
      [text('Checking.'), call('c1', 'get_time', { zone: 'Paris' }), done('tool_use', { input: 10, output: 5 }, raw)],
      [text('It is noon.'), done('end_turn', { input: 20, output: 3 })]
    );
    const controller = new AbortController();
    const events = await collect(run(ask, controller.signal));

    expect(types(events).slice(2)).toEqual([
      'step',
      'text',
      'usage',
      'tool_call',
      'tool_result',
      'step',
      'text',
      'usage',
      'done',
    ]);
    expect(only(events, 'tool_call')[0]).toEqual({
      type: 'tool_call',
      id: 'c1',
      name: 'get_time',
      input: { zone: 'Paris' },
    });
    expect(only(events, 'tool_result')[0]).toEqual({
      type: 'tool_result',
      id: 'c1',
      name: 'get_time',
      output: '12:00 in Paris',
      isError: false,
    });
    // The totals the reply ends on are every pass added up
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { input: 30, output: 8 }, steps: 2 });
    expect(getTime).toHaveBeenCalledWith(
      { zone: 'Paris' },
      expect.objectContaining({ signal: controller.signal, threadId: THREAD })
    );
    // The second decision sees the model's own reply, with the provider's own
    // form of it kept so that nothing in it is lost, and then the result
    expect(snapshots[1].messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [{ id: 'c1', name: 'get_time', input: { zone: 'Paris' } }],
        raw,
      },
      { role: 'tool', toolCallId: 'c1', name: 'get_time', content: '12:00 in Paris', isError: false },
    ]);
  });

  it('runs parallel tool calls together and reports results in call order', async () => {
    const order: string[] = [];
    getTime.mockImplementation(async ({ zone }: { zone: string }) => {
      order.push(`start ${zone}`);
      await new Promise((resolve) => setTimeout(resolve, zone === 'Paris' ? 20 : 0));
      order.push(`end ${zone}`);
      return zone;
    });
    script(
      [call('c1', 'get_time', { zone: 'Paris' }), call('c2', 'get_time', { zone: 'Tokyo' }), done('tool_use')],
      answer()
    );
    const events = await collect(run(ask, signal()));
    expect(order).toEqual(['start Paris', 'start Tokyo', 'end Tokyo', 'end Paris']);
    expect(only(events, 'tool_result').map((e) => e.id)).toEqual(['c1', 'c2']);
  });

  it('turns a non-string tool result into JSON', async () => {
    getTime.mockResolvedValue({ hour: 12 });
    script([call('c1', 'get_time'), done('tool_use')], answer());
    const events = await collect(run(ask, signal()));
    expect(only(events, 'tool_result')[0]).toMatchObject({ output: '{"hour":12}' });
  });

  it.each([
    [
      'a tool that throws',
      () => getTime.mockRejectedValue(new Error('clock broken')),
      call('c1', 'get_time'),
      'clock broken',
    ],
    // With the tools there are, so that a model which invented a name from the
    // shape of the others has what it needed (see noSuchTool in harness/tools)
    [
      'a tool that does not exist',
      () => {},
      call('c1', 'missing'),
      'There is no tool named "missing". The tools you have are: get_time.',
    ],
    ['input that was not valid JSON', () => {}, call('c1', 'get_time', null), 'The tool input was not valid JSON.'],
  ])('reports %s back to the model as an error result', async (_name, arrange, toolCall, message) => {
    arrange();
    script([toolCall, done('tool_use')], [text('Sorry.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(only(events, 'tool_result')[0]).toMatchObject({ output: message, isError: true });
    expect(snapshots[1].messages.at(-1)).toMatchObject({ role: 'tool', content: message, isError: true });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  // A tool may say what it is doing while it runs, as the subagent tool does,
  // so its events are passed on as they arrive rather than after it returns
  it('passes on what a tool reports while it runs, before the tool has returned', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    register('slow', async (_input, context) => {
      (context as { emit: (e: HarnessEvent) => void }).emit({ type: 'progress', percent: 50 });
      await held;
      return 'finished';
    });
    script([call('c1', 'slow'), done('tool_use')], answer());

    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of run(ask, signal())) {
        events.push(event);
        if (event.type === 'progress') release();
      }
    })();
    await running;
    const progress = types(events).indexOf('progress');
    expect(progress).toBeGreaterThan(-1);
    expect(progress).toBeLessThan(types(events).indexOf('tool_result'));
  });

  it('does not run tools when the reply was cut off rather than finished', async () => {
    script([text('As far as I got.'), call('c1', 'get_time'), done('max_tokens')]);
    const events = await collect(run(ask, signal()));
    expect(getTime).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_tokens', steps: 1 });
  });

  it('stops after the rounds the message was given, and says that is why', async () => {
    const limit = maxSteps('low', false);
    onStream(() => from([call('c', 'get_time'), done('tool_use', { input: 1, output: 1 })]));
    const warn = vi.spyOn(log, 'warn');
    const events = await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(limit);
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'max_steps',
      usage: { input: limit, output: limit },
      steps: limit,
    });
    expect(warn).toHaveBeenCalledWith('request.max_steps', expect.objectContaining({ effort: 'low', limit }));
  });

  // Some small local models reject a request that carries tools at all, so the
  // reply falls back to a plain answer rather than failing the message
  it('retries without tools when the model rejects them', async () => {
    script(
      [{ type: 'error', code: 'other', status: 400, message: 'does not support tools' }],
      [text('Plain.'), done()]
    );
    const events = await collect(run(ask, signal()));
    expect(only(events, 'step')).toEqual([
      { type: 'step', step: 1 },
      { type: 'step', step: 1 },
    ]);
    expect(snapshots[1].tools).toEqual([]);
    expect(snapshots[1].system).not.toContain('SANDBOX PROMPT');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('does not retry other errors, or a 400 once tools have already been used', async () => {
    script([{ type: 'error', code: 'rate_limit', status: 429, message: 'slow down' }]);
    let events = await collect(run(ask, signal()));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'rate_limit' });
    expect(mocks.stream).toHaveBeenCalledTimes(1);

    mocks.stream.mockClear();
    script(
      [call('c1', 'get_time'), done('tool_use')],
      [{ type: 'error', code: 'other', status: 400, message: 'too long' }]
    );
    events = await collect(run(ask, signal()));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'too long' });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  // The provider turned the request away and it is being made again, which is
  // said in the thread because a reply that stops for half a minute should say why
  it('passes on that the provider turned the request away', async () => {
    script([{ type: 'rate_limited', attempt: 1, waitMs: 2000 } as ChatEvent, text('Hi.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(types(events)).toContain('rate_limited');
  });

  // Waiting behind another request, or behind the conversation a local model is
  // holding its prompt for, is said in the thread: a reply that has not started
  // yet is either waiting or broken, and from outside the two look alike (see
  // src/llm/cachelock.ts). The model it is waiting for is named, since that is
  // what the window has to say; what the wait came to is reported with the
  // tokens instead, where it is kept off the model's own timings.
  it('passes on the wait for its turn at the model, and that the turn came', async () => {
    script([{ type: 'queued' } as ChatEvent, { type: 'waited', ms: 500 } as ChatEvent, text('Hi.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(events).toContainEqual({ type: 'queued', model: 'llama:3b' });
    expect(events).toContainEqual({ type: 'waited', ms: 500 });
  });

  it('reports a model that stops without finishing', async () => {
    script([text('partial')]);
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'other', message: 'The model stopped without finishing.' });
  });

  it('passes a cancelled reply straight through, without asking it for an answer', async () => {
    script([text('part'), done('cancelled')]);
    const events = await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'cancelled' });
  });

  // An error arriving with some of the reply already written is the stream
  // ending badly rather than the request failing, and what was written is
  // worth more to the user than the message is
  it('keeps what arrived when the stream ends badly after the model had written something', async () => {
    script([text('Half an answer.'), { type: 'error', code: 'other', message: 'parse failed' }]);
    const events = await collect(run(ask, signal()));
    expect(only(events, 'text')[0]).toEqual({ type: 'text', delta: 'Half an answer.' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('still runs a round of tool calls that arrived before the stream broke', async () => {
    script(
      [call('c1', 'get_time', { zone: 'Rome' }), { type: 'error', code: 'other', message: 'parse failed' }],
      answer()
    );
    const events = await collect(run(ask, signal()));
    expect(getTime).toHaveBeenCalled();
    expect(only(events, 'tool_result')[0]).toMatchObject({ output: '12:00 in Rome' });
  });

  it('fails the message when the stream breaks with nothing written at all', async () => {
    script([{ type: 'error', code: 'overloaded', message: 'try later' }]);
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'overloaded', message: 'try later' });
  });

  // What a step offers decides what the model is shown, not what the registry
  // will answer to: a call to a tool the step was not offered is run all the
  // same, and gets a line of its own in the log
  it('runs a tool the step was not offered, and says so in the log', async () => {
    register('writes', () => 'done', { phases: [] });
    const warn = vi.spyOn(log, 'warn');
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    script([call('c1', 'writes'), done('tool_use')], [text('Found it.'), done()], [text('Plan.'), done()]);
    await collect(run(coding, signal()));
    expect(warn).toHaveBeenCalledWith('tool.unoffered', expect.objectContaining({ tool: 'writes', phase: 'explore' }));
  });
});

describe('a model that reports its own reasoning', () => {
  // The reasoning arrives on a channel of its own and is shown as thoughts,
  // gathered a paragraph at a time rather than all at the end
  it('shows it as thoughts, apart from the reply', async () => {
    script([reasoning('Looking it up.\n\nFound it.\n\n'), text('It is noon.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(only(events, 'thought')).toEqual([
      { type: 'thought', text: 'Looking it up.' },
      { type: 'thought', text: 'Found it.' },
    ]);
    expect(only(events, 'text')).toEqual([{ type: 'text', delta: 'It is noon.' }]);
  });

  // Once it starts answering, whatever reasoning is still held back is a
  // finished thought even if a buffer waiting for a paragraph cannot tell
  it('flushes a thought it was still holding when the answer starts', async () => {
    script([reasoning('A thought with no blank line after it.'), text('Answer.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(types(events).indexOf('thought')).toBeLessThan(types(events).indexOf('text'));
    expect(only(events, 'thought')).toEqual([{ type: 'thought', text: 'A thought with no blank line after it.' }]);
  });

  it('is told nothing about writing thoughts in tags, and has its reply left alone, tags and all', async () => {
    mocks.listModels.mockResolvedValue({ models: [{ ...small, reasons: true }], providers: [] });
    script([reasoning('Thinking it over.\n\n'), text('Wrap each in <thought> tags.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(unwrapped(system())).not.toContain('<thought>');
    expect(unwrapped(system())).not.toContain('in tags');
    expect(only(events, 'text')).toEqual([{ type: 'text', delta: 'Wrap each in <thought> tags.' }]);
  });

  // A reply that is all reasoning has not answered anybody: nothing of that
  // turn is kept as the assistant's, so the next message in the thread would
  // go out with the request before it looking unanswered
  it('asks once for the answer itself when the turn wrote nothing for the user', async () => {
    const info = vi.spyOn(log, 'info');
    script([reasoning('The answer is noon.'), done()], [text('It is noon.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(snapshots[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You ended that turn without writing anything for the user'),
    });
    expect(only(events, 'text')).toEqual([{ type: 'text', delta: 'It is noon.' }]);
    expect(info).toHaveBeenCalledWith('reply.no-answer', expect.objectContaining({ action: 'asked' }));
  });

  // No assistant turn goes in with the asking: there was nothing in that one
  // to keep, and an empty one is what some providers refuse
  it('sends no empty assistant turn with that asking', async () => {
    script([reasoning('Thinking.'), done()], [text('Answer.'), done()]);
    await collect(run(ask, signal()));
    expect(snapshots[1].messages.filter((m) => m.role === 'assistant')).toEqual([]);
  });

  // Asked once, and still nothing: its reasoning stands in for the answer
  // rather than leaving the turn with nothing in it
  it('takes the reasoning for the answer when asking again gets nothing either', async () => {
    const warn = vi.spyOn(log, 'warn');
    script([reasoning('The answer is noon.'), done()], [reasoning('Still thinking.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(only(events, 'text')).toEqual([{ type: 'text', delta: 'Still thinking.' }]);
    expect(warn).toHaveBeenCalledWith('reply.no-answer', expect.objectContaining({ action: 'reasoning' }));
  });

  it('ends with nothing when there was no reasoning to fall back on either', async () => {
    const warn = vi.spyOn(log, 'warn');
    script([done()], [done()]);
    const events = await collect(run(ask, signal()));
    expect(types(events)).not.toContain('text');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(warn).toHaveBeenCalledWith('reply.no-answer', expect.objectContaining({ action: 'nothing', reasoned: 0 }));
  });

  // A refusal is the model's answer, not the want of one: asking again is
  // pressing it for what it has just declined to give
  it('does not ask again when the model declined, and says so in the log', async () => {
    const warn = vi.spyOn(log, 'warn');
    script([done('refusal')]);
    const events = await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'refusal' });
    expect(warn).toHaveBeenCalledWith('reply.refused', expect.objectContaining({ step: 1 }));
  });

  // A reply that is all reasoning and then runs out of room ran out of room:
  // it does not count as having answered
  it('does not count reasoning as an answer when the reply ran out of room', async () => {
    script([reasoning('Thinking at great length.'), done('length')]);
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'other', message: OUT_OF_ROOM });
  });
});

describe('a model that says what it is about to do and then stops', () => {
  beforeEach(() => register('get_time', () => '12:00'));

  it('is asked once to make the call it described', async () => {
    const info = vi.spyOn(log, 'info');
    script([text('I need to find where the timer lives.'), done()], [text('It is in renderer.ts.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(snapshots[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'I need to find where the timer lives.', raw: undefined },
      { role: 'user', content: ANNOUNCED },
    ]);
    expect(only(events, 'text').at(-1)).toEqual({ type: 'text', delta: 'It is in renderer.ts.' });
    expect(info).toHaveBeenCalledWith('reply.announced', expect.objectContaining({ step: 1 }));
  });

  // A model that has searched and read and then says it needs one more look
  // has given an answer of a kind; badgering it would be worse than taking it
  it('is left alone once the reply has actually run something', async () => {
    script([call('c1', 'get_time'), done('tool_use')], [text('Let me check one more thing.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('is asked only once, however many times it does it', async () => {
    script(
      [text('I should look at the renderer.'), done()],
      [text('I will search for the timer.'), done()],
      [text('Third.'), done()]
    );
    await collect(run(ask, signal()));
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });
});

describe('keeping a long reply inside the window', () => {
  beforeEach(() => {
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    register('get_time', () => '12:00');
  });

  it('leaves a reply that fits alone', async () => {
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(types(events)).not.toContain('condensing');
  });

  it('condenses when the window is nearly full, and says so before and after', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    mocks.compact.mockResolvedValue({
      messages: [{ role: 'user', content: 'condensed' }],
      usage: { input: 500, output: 100 },
      findings: 'What was found.',
    });
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(types(events).slice(2, 5)).toEqual(['step', 'condensing', 'usage']);
    expect(only(events, 'condensed')).toEqual([{ type: 'condensed', changed: true }]);
    // Condensing is work for the model, so what it took is reported like any
    // other pass
    expect(only(events, 'usage')[0]).toMatchObject({ purpose: 'compaction', input: 500, output: 100 });
    expect(snapshots[0].messages).toEqual([{ role: 'user', content: 'condensed' }]);
  });

  it('says nothing came of it when it won no room back', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    script(answer());
    const events = await collect(run(ask, signal()));
    expect(only(events, 'condensed')).toEqual([{ type: 'condensed', changed: false }]);
  });

  // The findings outlive the reply only if they are written down: the message
  // they were put into goes when the reply ends
  it('keeps the findings it carried, so they outlive the reply', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    mocks.compact.mockResolvedValue({ messages: [], usage: { input: 1, output: 1 }, findings: 'Found in renderer.ts' });
    script(answer());
    await collect(run(ask, signal()));
    expect(mocks.keepFindings).toHaveBeenCalledWith(THREAD, 'Found in renderer.ts', undefined);
  });

  // Not every compaction wins much room back, and a reply left above the mark
  // would otherwise be condensed at every step for the rest of its life
  it('does not condense again until the reply has taken on more work', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    mocks.size.mockReturnValue(100);
    script([call('c1', 'get_time'), done('tool_use')], [call('c2', 'get_time'), done('tool_use')], answer());
    await collect(run(ask, signal()));
    expect(mocks.compact).toHaveBeenCalledTimes(1);
  });

  it('condenses again once it has grown by a fifth of the window', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    let at = 100;
    mocks.size.mockImplementation(() => at);
    onStream(() => {
      at += 32000; // more than the growth the gate asks for
      return from([call('c', 'get_time'), done('tool_use')]);
    });
    await collect(run(ask, signal()));
    expect(mocks.compact.mock.calls.length).toBeGreaterThan(1);
  });

  // Cut off before it wrote any of its answer: making room and trying again
  // may get an answer out of it
  it('makes room and tries again when a reply is cut off with nothing written', async () => {
    mocks.compact.mockResolvedValue({
      messages: [{ role: 'user', content: 'smaller' }],
      usage: { input: 0, output: 0 },
    });
    script([done('length')], [text('It fits now.'), done()]);
    const events = await collect(run(ask, signal()));
    expect(mocks.compact).toHaveBeenCalled();
    expect(only(events, 'text')).toEqual([{ type: 'text', delta: 'It fits now.' }]);
    // The step is taken again rather than counted twice
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 1 });
  });

  it('gives up with the out-of-room message when there was no room to win', async () => {
    const warn = vi.spyOn(log, 'warn');
    script([done('length')]);
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'other', message: OUT_OF_ROOM });
    expect(warn).toHaveBeenCalledWith('reply.empty', expect.objectContaining({ step: 1 }));
  });

  it('tries that only once', async () => {
    mocks.compact
      .mockResolvedValueOnce({ messages: [{ role: 'user', content: 'smaller' }], usage: { input: 0, output: 0 } })
      .mockImplementation((messages: unknown) => ({ messages, usage: { input: 0, output: 0 } }));
    script([done('length')], [done('length')]);
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'other', message: OUT_OF_ROOM });
  });

  // A model that does not say how large its window is cannot be measured
  // against it, and is condensed when it actually runs out instead
  it('does not measure a model that does not say how much room it has', async () => {
    mocks.listModels.mockResolvedValue({ models: [small], providers: [] });
    mocks.nearlyFull.mockReturnValue(true);
    script(answer());
    await collect(run(ask, signal()));
    expect(mocks.compact).not.toHaveBeenCalled();
  });
});

describe('a coding change worked through in discrete steps', () => {
  // The steps only happen for a coding task in a workspace, with tools to do
  // it with, that is being planned (see phases.forReply)
  const stepped: HarnessRequest = { ...coding, plan: 'always' };

  beforeEach(() => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    register('read_file', ({ path }) => `contents of ${path}`);
    register('write_file', () => 'written', { phases: ['execute'] });
  });

  it('starts in the finding-out step and says which step it is in', async () => {
    script([text('Found it.'), done()], [text('The plan.'), done()], [text('Did it.'), done()], answer('All done.'));
    const events = await collect(run(stepped, signal()));
    expect(only(events, 'phase').map((e) => e.phase)).toEqual(ORDER);
  });

  it('only offers a step the tools that step is for', async () => {
    script([text('Found it.'), done()], [text('The plan.'), done()], [text('Did it.'), done()], answer());
    await collect(run(stepped, signal()));
    // Finding out reads; it may not write until there is a plan to write from
    expect(snapshots[0].tools!.map((t) => t.name)).toEqual(['read_file']);
    // The planning step has no tools at all, which is what makes writing the
    // one thing it can do
    expect(snapshots[1].tools).toEqual([]);
    expect(snapshots[2].tools!.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(snapshots[3].tools).toEqual([]);
  });

  it('tells each step what that step is for', async () => {
    script([text('Found it.'), done()], [text('The plan.'), done()], [text('Did it.'), done()], answer());
    await collect(run(stepped, signal()));
    for (const [at, phase] of ORDER.entries()) {
      expect(unwrapped(snapshots[at].system ?? '')).toContain(unwrapped(PHASE_PROMPTS[phase]).slice(0, 50));
    }
  });

  // Everything a step did is left behind with it: what goes on is the
  // conversation up to the user's message, and then what the step wrote down
  it('carries only what a step wrote into the next one, not what its tools returned', async () => {
    script(
      [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
      [text('The timer is in src/a.ts.'), done()],
      [text('The plan.'), done()],
      [text('Did it.'), done()],
      answer()
    );
    await collect(run(stepped, signal()));
    // The planning step sees the user's message and the write-up, and none of
    // the reading the finding-out step did
    expect(snapshots[2].messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: expect.stringContaining('The timer is in src/a.ts.') },
    ]);
    expect(JSON.stringify(snapshots[2].messages)).not.toContain('contents of src/a.ts');
  });

  // The plan is the step the user is there for, so it is handed over as its
  // own thing; what the finding out and the doing step wrote are notes to
  // themselves, each written for the step after it
  it('gives the plan its own event and shows the steps that write for each other as thoughts', async () => {
    script([text('Found it.'), done()], [text('Change src/a.ts.'), done()], [text('Did it.'), done()], answer());
    const events = await collect(run(stepped, signal()));
    expect(only(events, 'plan')).toEqual([{ type: 'plan', text: 'Change src/a.ts.' }]);
    expect(only(events, 'thought')).toEqual([
      { type: 'thought', text: 'Found it.' },
      { type: 'thought', text: 'Did it.' },
    ]);
  });

  // The doing step's account is written for the answering step, which says the
  // same things to the user a moment later. Streamed into the reply as well, it
  // was answered twice over — and a doing step with nothing to hand out runs no
  // tools, so nothing broke the bubble between the two and the user read the
  // whole reply twice (the 2026-10-29 "squash everything" thread).
  it('keeps the doing step out of the reply, which is the answering step alone', async () => {
    script(
      [text('Found it.'), done()],
      [text('Change src/a.ts.'), done()],
      [text('No files changed: there was nothing to hand to a coder.'), done()],
      answer('No files changed. There was nothing to do.')
    );
    const events = await collect(run(stepped, signal()));
    // The plan's words are there because the window lifts them out of the
    // reply into the plan itself (see the 'plan' event); the doing step's are
    // nowhere in the reply at all
    expect(only(events, 'text').map((e) => e.delta)).toEqual([
      'Change src/a.ts.',
      'No files changed. There was nothing to do.',
    ]);
  });

  // What the finding-out step screenshot is shown with the plan, and not again
  // under the reply: the plan takes it, and the images event is left without it
  it('hands a screenshot taken while finding out to the plan, not to the reply again', async () => {
    const img: ToolImage = { mediaType: 'image/png', data: 'AAAA' };
    register('screenshot', () => ({ text: 'drawn', images: [img] }));
    script(
      [call('c1', 'screenshot', {}), done('tool_use')],
      [text('Found it.'), done()],
      [text('Change src/a.ts.'), done()],
      [text('Did it.'), done()],
      answer()
    );
    const events = await collect(run(stepped, signal()));
    expect(only(events, 'plan')[0].images).toEqual([img]);
    expect(only(events, 'images').flatMap((e) => e.images)).not.toContainEqual(img);
  });

  // A step's words are all the next one is given, so a step that wrote none is
  // asked for them before the reply goes on without them
  it('asks a step that wrote nothing for the words the next step needs', async () => {
    const info = vi.spyOn(log, 'info');
    script([done()], [text('Found it after all.'), done()], [text('Plan.'), done()], [text('Did.'), done()], answer());
    await collect(run(stepped, signal()));
    expect(snapshots[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You ended that step without writing down what you found'),
    });
    expect(info).toHaveBeenCalledWith('phase.empty', expect.objectContaining({ phase: 'explore' }));
  });

  it('asks the finding-out step three times, and the others once', async () => {
    script([done()], [done()], [done()], [done()], [text('At last.'), done()], answer(), answer(), answer());
    await collect(run(stepped, signal()));
    // Four tries at the finding-out step: the first and three askings
    const exploring = snapshots.filter((s) =>
      unwrapped(s.system ?? '').includes(unwrapped(PHASE_PROMPTS.explore).slice(0, 40))
    );
    expect(exploring).toHaveLength(4);
  });

  // The finding-out step has a share of the reply's rounds and no more: a
  // model with tools can always find one more thing worth reading
  it('ends the finding-out step when its rounds for looking are spent', async () => {
    const info = vi.spyOn(log, 'info');
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    onStream((request) =>
      from(
        (request.tools ?? []).length > 0 && !JSON.stringify(request.messages).includes('rounds for finding out')
          ? [call('c', 'read_file', { path: 'src/a.ts' }), done('tool_use')]
          : [text('Written up.'), done()]
      )
    );
    await collect(run(stepped, signal()));
    expect(info).toHaveBeenCalledWith('phase.spent', expect.objectContaining({ phase: 'explore', why: 'rounds' }));
    const told = snapshots.find((s) => JSON.stringify(s.messages).includes('rounds for finding out'));
    expect(told).toBeDefined();
  });

  // Writing findings down is not a round of looking: a cap that charged for it
  // would buy the shallower pass at the price of the notes
  it('does not charge a round that only wrote findings down against that share', async () => {
    register('add_to_context', () => 'noted');
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    let notes = 0;
    onStream(() => {
      notes++;
      return from(notes <= 5 ? [call(`n${notes}`, 'add_to_context'), done('tool_use')] : [text('Written up.'), done()]);
    });
    const info = vi.spyOn(log, 'info');
    await collect(run(stepped, signal()));
    expect(info).not.toHaveBeenCalledWith('phase.spent', expect.anything());
  });

  // The share is a ceiling that can be raised, because the work it is worst
  // for — cornering a fault — cannot be sized from the request (see
  // harness/allowance.ts). The step asks, is granted, and its tools answer
  // again: a grant that left the tools dead would be a grant of nothing.
  describe('rounds asked for rather than cut off at', () => {
    // The last turn in front of the model, which is how these tests tell one
    // spending of the allowance from the next: the step is told it is spent
    // once per allowance, so the telling is the newest message exactly when it
    // has just happened
    const last = (request: ChatRequest) => JSON.stringify(request.messages.at(-1) ?? '');

    const asking = (reason = 'The failure reproduces; one more run would show which call returns undefined.') => [
      call('ask', MORE_TOOL, { reason }),
      done('tool_use'),
    ];

    beforeEach(() => {
      tools.clear();
      tools.register(moreTool);
      mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    });

    it('grants the finding-out step more rounds when it asks, and its tools answer again', async () => {
      const info = vi.spyOn(log, 'info');
      const read = vi.fn(() => 'contents');
      register('read_file', read);
      let granted = false;
      onStream((request) => {
        const newest = last(request);
        if (newest.includes('rounds for finding out')) return from(asking());
        if (newest.includes('Granted:')) {
          granted = true;
          return from([call('after', 'read_file', { path: 'src/after.ts' }), done('tool_use')]);
        }
        if (granted) return from([text('Written up.'), done()]);
        return from([call('c', 'read_file', { path: 'src/a.ts' }), done('tool_use')]);
      });
      await collect(run(stepped, signal()));
      expect(info).toHaveBeenCalledWith('allowance.granted', expect.objectContaining({ scope: 'explore' }));
      // The ask itself was answered rather than dropped as a late call...
      expect(info).not.toHaveBeenCalledWith('phase.late_call', expect.anything());
      // ...and the round it bought was a round the tools really ran
      expect(read).toHaveBeenCalledWith({ path: 'src/after.ts' }, expect.anything());
    });

    // Two grants and no more: the third ask is a step that is not converging,
    // and what serves the user then is the write-up of what it ruled out
    it('refuses the ask after two grants', async () => {
      const info = vi.spyOn(log, 'info');
      register('read_file', () => 'contents');
      onStream((request) => {
        const newest = last(request);
        if (newest.includes('No more rounds')) return from([text('Written up.'), done()]);
        if (newest.includes('rounds for finding out')) return from(asking('Still cornering it.'));
        return from([call('c', 'read_file', { path: 'src/a.ts' }), done('tool_use')]);
      });
      await collect(run(stepped, signal()));
      const grants = info.mock.calls.filter(([event]) => event === 'allowance.granted');
      expect(grants).toHaveLength(MAX_GRANTS);
      expect(info).toHaveBeenCalledWith('allowance.refused', expect.objectContaining({ why: 'grants' }));
    });

    // The reply's own budget is nobody's allowance to work under, and before
    // this it ran out in silence: the loop stopped and whatever had been
    // written was what the user got, mid-change as often as not
    it('says so on the reply’s last round, and works on when the round is asked for', async () => {
      const info = vi.spyOn(log, 'info');
      register('read_file', () => 'contents');
      const bought = maxSteps('low', true);
      let asked = false;
      onStream((request) => {
        const newest = last(request);
        if (newest.includes('last round of tool calls this reply has')) {
          asked = true;
          return from(asking('The change is half made; the rest needs two rounds.'));
        }
        if (asked && newest.includes('Granted:')) return from([text('Written up.'), done()]);
        return from([call('c', 'read_file', { path: 'src/a.ts' }), done('tool_use')]);
      });
      const events = await collect(run({ ...coding, plan: 'never' }, signal()));
      expect(info).toHaveBeenCalledWith('request.last_round', expect.objectContaining({ limit: bought }));
      expect(info).toHaveBeenCalledWith('allowance.granted', expect.objectContaining({ scope: 'reply' }));
      // ...and the reply ran past the budget it was given rather than ending there
      const ended = events.find((e) => e.type === 'done') as { stopReason: string; steps: number };
      expect(ended.stopReason).not.toBe('max_steps');
      expect(ended.steps).toBeGreaterThan(bought);
    });

    // Asking is not looking. A round charged for the asking would be a round
    // of the grant spent on getting it. More asks here than the step's whole
    // allowance of rounds, so a charge for any of them would spend it.
    it('does not charge the asking against the rounds it is asking for', async () => {
      const info = vi.spyOn(log, 'info');
      let asks = 0;
      onStream(() => {
        asks++;
        return from(asks <= 12 ? asking(`Round ${asks}.`) : [text('Written up.'), done()]);
      });
      await collect(run(stepped, signal()));
      expect(info).not.toHaveBeenCalledWith('phase.spent', expect.anything());
    });
  });

  // A call made once the rounds are gone is dropped whole, with the turn that
  // made it: a call whose result never comes back is a turn some providers refuse
  it('drops a call made after the rounds are spent, rather than running it', async () => {
    const info = vi.spyOn(log, 'info');
    const read = vi.fn(() => 'contents');
    tools.clear();
    register('read_file', read);
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    onStream((request) =>
      from(
        JSON.stringify(request.messages).includes('rounds for finding out')
          ? [call('late', 'read_file', { path: 'src/z.ts' }), done('tool_use')]
          : [call('c', 'read_file', { path: 'src/a.ts' }), done('tool_use')]
      )
    );
    await collect(run(stepped, signal()));
    expect(info).toHaveBeenCalledWith('phase.late_call', expect.objectContaining({ dropped: ['read_file'] }));
    expect(read).not.toHaveBeenCalledWith({ path: 'src/z.ts' }, expect.anything());
  });

  describe('a write-up that talks about a file the step never opened', () => {
    // The planning step has no tools and the coders are sent to the files the
    // words name, so a claim from memory is the one error nothing downstream
    // can catch
    it('is sent back to read it while the step still has rounds and room', async () => {
      const info = vi.spyOn(log, 'info');
      script(
        [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
        [text('The save() function is in src/never-opened.ts.'), done()],
        [text('I checked: it is in src/a.ts.'), done()],
        [text('Plan.'), done()],
        [text('Did.'), done()],
        answer()
      );
      await collect(run(stepped, signal()));
      expect(info).toHaveBeenCalledWith('phase.ungrounded', expect.objectContaining({ phase: 'explore', asked: true }));
      expect(JSON.stringify(snapshots[2].messages)).toContain('src/never-opened.ts');
    });

    it('goes on with a caveat attached once it has been asked once already', async () => {
      script(
        [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
        [text('It is in src/never-opened.ts.'), done()],
        [text('Still src/never-opened.ts.'), done()],
        [text('Plan.'), done()],
        [text('Did.'), done()],
        answer()
      );
      await collect(run(stepped, signal()));
      // The caveat travels with the write-up into the planning step
      expect(JSON.stringify(snapshots[3].messages)).toContain('Not checked against the files');
      expect(JSON.stringify(snapshots[3].messages)).toContain('src/never-opened.ts');
    });

    it('leaves a write-up alone when it only talks about what it read', async () => {
      const info = vi.spyOn(log, 'info');
      script(
        [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
        [text('The timer is in src/a.ts.'), done()],
        [text('Plan.'), done()],
        [text('Did.'), done()],
        answer()
      );
      await collect(run(stepped, signal()));
      expect(info).not.toHaveBeenCalledWith('phase.ungrounded', expect.anything());
    });
  });

  // A refusal, a cancellation or running out of room ends the reply wherever
  // it had got to rather than moving on to the next step
  it.each(['refusal', 'cancelled'])('ends the whole reply when a step ends in a %s', async (stopReason) => {
    script([text('Part way.'), done(stopReason)]);
    const events = await collect(run(stepped, signal()));
    expect(only(events, 'phase').map((e) => e.phase)).toEqual(['explore']);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason });
  });

  it('builds each step its own instructions, so a step reads the note the one before it wrote', async () => {
    mocks.readContext.mockResolvedValueOnce('').mockResolvedValue('What finding out established.');
    script([text('Found it.'), done()], [text('Plan.'), done()], [text('Did.'), done()], answer());
    await collect(run(stepped, signal()));
    expect(mocks.readContext.mock.calls.length).toBeGreaterThan(1);
    expect(snapshots[2].system).toContain('What finding out established.');
  });
});

describe('whether a coding change is planned at all', () => {
  beforeEach(() => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    register('read_file', () => 'contents');
  });

  it('asks the planner about a task the thread has not settled either way', async () => {
    mocks.decide.mockResolvedValue({
      plan: true,
      provider: 'local',
      model: 'llama:3b',
      usage: { input: 50, output: 2 },
    });
    script([text('Found.'), done()], [text('Plan.'), done()], [text('Did.'), done()], answer());
    const events = await collect(run(coding, signal()));
    expect(mocks.decide).toHaveBeenCalled();
    expect(only(events, 'usage')[0]).toMatchObject({ purpose: 'planning', input: 50, output: 2 });
    expect(types(events)).toContain('phase');
  });

  it('answers in one run when the planner says this task does not need a plan', async () => {
    mocks.decide.mockResolvedValue({ plan: false });
    script(answer());
    const events = await collect(run(coding, signal()));
    expect(types(events)).not.toContain('phase');
  });

  it('does not ask for a thread that always plans', async () => {
    script([text('Found.'), done()], [text('Plan.'), done()], [text('Did.'), done()], answer());
    const events = await collect(run({ ...coding, plan: 'always' }, signal()));
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(types(events)).toContain('phase');
  });

  it('does not ask, and does not plan, for a thread that never does', async () => {
    script(answer());
    const events = await collect(run({ ...coding, plan: 'never' }, signal()));
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(types(events)).not.toContain('phase');
  });

  it('investigates in two steps, without asking the planner and without a plan', async () => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'question' }));
    script([text('Found.'), done()], [text('Report.'), done()]);
    const events = await collect(run({ ...coding, investigate: true }, signal()));
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(only(events, 'phase').map((e) => (e as { phase: string }).phase)).toEqual(['explore', 'report']);
    expect(only(events, 'plan')).toEqual([]);
  });

  it('investigates in two steps when the classifier judges the message one, without asking the planner', async () => {
    mocks.classify.mockResolvedValue(needs(3, { category: 'investigation' }));
    script([text('Found.'), done()], [text('Report.'), done()]);
    const events = await collect(run({ ...coding, plan: 'auto' }, signal()));
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(only(events, 'phase').map((e) => (e as { phase: string }).phase)).toEqual(['explore', 'report']);
  });

  it('only writes up an investigation the classifier judges one, in a thread with no workspace', async () => {
    mocks.classify.mockResolvedValue(needs(3, { category: 'investigation' }));
    script(answer());
    const events = await collect(run({ ...ask }, signal()));
    expect(only(events, 'phase').map((e) => (e as { phase: string }).phase)).toEqual(['report']);
  });

  it('suggests in two steps when the classifier judges the message one, without asking the planner', async () => {
    mocks.classify.mockResolvedValue(needs(3, { category: 'suggestion' }));
    script([text('Found.'), done()], [text('Suggested.'), done()]);
    const events = await collect(run({ ...coding, plan: 'auto' }, signal()));
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(only(events, 'phase').map((e) => (e as { phase: string }).phase)).toEqual(['explore', 'suggest']);
  });

  it('marks the explore phase as a suggestion when the classifier judges it one', async () => {
    mocks.classify.mockResolvedValue(needs(3, { category: 'suggestion' }));
    script([text('Found.'), done()], [text('Suggested.'), done()]);
    const events = await collect(run({ ...coding, plan: 'auto' }, signal()));
    expect(only(events, 'phase')[0]).toEqual({ type: 'phase', phase: 'explore', suggestion: true });
  });

  it('marks the explore phase as an investigation only when Investigate only is on', async () => {
    script([text('Found.'), done()], [text('Report.'), done()]);
    const investigating = await collect(run({ ...coding, investigate: true }, signal()));
    expect(only(investigating, 'phase')[0]).toEqual({ type: 'phase', phase: 'explore', investigation: true });
    script([text('Found.'), done()], [text('Plan.'), done()], [text('Did.'), done()], answer());
    const coded = await collect(run({ ...coding, plan: 'always' }, signal()));
    expect(only(coded, 'phase')[0]).toEqual({ type: 'phase', phase: 'explore' });
    expect(only(coded, 'phase')[0]).not.toHaveProperty('investigation');
  });

  it.each([
    ['a question rather than a coding task', { ...coding }, { category: 'question' }],
    ['a thread with no workspace', { ...ask }, { category: 'coding' }],
  ])('does not work %s through in steps', async (_name, request, classification) => {
    mocks.classify.mockResolvedValue(needs(1, classification as never));
    script(answer());
    const events = await collect(run({ ...request, plan: 'always' }, signal()));
    expect(types(events)).not.toContain('phase');
  });

  // A reply being picked up where the app closed on it is not started again as
  // a sequence of steps
  it('does not work a resumed reply through in steps', async () => {
    script(answer());
    const events = await collect(run({ ...coding, plan: 'always', resumed: { did: [] } }, signal()));
    expect(types(events)).not.toContain('phase');
  });
});

describe('a reply the app closed on', () => {
  // The model is handed what it had written and what it had done, and carries
  // on; the conversation itself is unchanged
  it('is picked up rather than started again', async () => {
    const info = vi.spyOn(log, 'info');
    script(answer('Carrying on.'));
    const resumed = { did: ['read_file src/a.ts — 40 lines'], text: 'The timer is' };
    await collect(run({ ...ask, resumed }, signal()));
    expect(snapshots[0].messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'The timer is' },
      { role: 'user', content: expect.stringContaining('The app closed while you were working on this message') },
    ]);
    expect(snapshots[0].messages[2].content).toContain('- read_file src/a.ts — 40 lines');
    expect(info).toHaveBeenCalledWith('reply.resumed', expect.objectContaining({ did: 1, wrote: 12 }));
  });

  it('pushes no assistant turn when it had written nothing', async () => {
    script(answer());
    await collect(run({ ...ask, resumed: { did: [] } }, signal()));
    expect(snapshots[0].messages.filter((m) => m.role === 'assistant')).toEqual([]);
  });
});

describe("a message that carries the user's review comments", () => {
  // One comment per entry, each opening with its id at the start of a line,
  // which is how the window writes them (see review.comments)
  const COMMENTS = '[c1] src/a.ts line 4\nrename this\n\n[c2] src/b.ts line 9\nwhy this way?';
  const reviewing: HarnessRequest = { ...coding, review: true, messages: [{ role: 'user', content: COMMENTS }] };

  beforeEach(() => {
    register('read_file', () => 'contents');
    register('reply_to_comment', () => 'replied', { needsReview: true });
  });

  // A comment is one small, self-contained job, and the model that would work
  // through them one at a time is better spent on the summary of what was done
  it('hands every comment to a reviewer and gives the model what they did', async () => {
    const info = vi.spyOn(log, 'info');
    mocks.reviewComments.mockResolvedValue('Renamed it in src/a.ts.');
    script(answer('All handled.'));
    await collect(run(reviewing, signal()));
    expect(mocks.reviewComments.mock.calls[0][0].map((c: { id: string }) => c.id)).toEqual(['c1', 'c2']);
    expect(snapshots[0].messages.at(-1)).toEqual({
      role: 'user',
      content: 'What the reviewers did with the comments:\n\nRenamed it in src/a.ts.',
    });
    // The reviewers have been through them, so all that is left is to tell the
    // user what was done
    expect(unwrapped(system())).toContain(unwrapped('Do not go through the comments again'));
    expect(info).toHaveBeenCalledWith('review.delegated', expect.objectContaining({ comments: 2 }));
  });

  // The model answering goes through them itself, as it used to
  it('falls back to the model answering them itself when the reviewers fail', async () => {
    const warn = vi.spyOn(log, 'warn');
    mocks.reviewComments.mockRejectedValue(new Error('no container'));
    script(answer('I will handle them.'));
    await collect(run(reviewing, signal()));
    expect(warn).toHaveBeenCalledWith('review.delegated', expect.objectContaining({ error: 'no container' }));
    expect(JSON.stringify(snapshots[0].messages)).not.toContain('What the reviewers did');
    // Told to go through them itself, and to reply to each with the tool
    expect(unwrapped(system())).toContain(unwrapped('Go through every comment'));
  });

  // A comment a reviewer answered before the app closed is not sent again: its
  // answer is already under it, where the user can see it
  it('does not send a comment again that was answered before the app closed', async () => {
    mocks.reviewComments.mockResolvedValue('done');
    script(answer());
    await collect(run({ ...reviewing, resumed: { did: [], answered: ['c1'] } }, signal()));
    expect(mocks.reviewComments.mock.calls[0][0].map((c: { id: string }) => c.id)).toEqual(['c2']);
  });

  // Every one of them was answered, so what is left is the summary, exactly as
  // it is when the reviewers have just finished
  it('goes straight to the summary when every comment was already answered', async () => {
    script(answer());
    await collect(run({ ...reviewing, resumed: { did: [], answered: ['c1', 'c2'] } }, signal()));
    expect(mocks.reviewComments).not.toHaveBeenCalled();
    expect(unwrapped(system())).toContain(unwrapped('Do not go through the comments again'));
  });

  it('tells a model with no tools to answer the comments in its reply instead', async () => {
    tools.clear();
    script(answer());
    await collect(run(reviewing, signal()));
    expect(mocks.reviewComments).not.toHaveBeenCalled();
    expect(unwrapped(system())).toContain(unwrapped('Answer every comment in your reply'));
  });
});

describe('bringing a thread level with its workspace', () => {
  const CLASH = { path: 'src/a.ts', reason: 'The same lines were changed in both.', copy: '' };

  beforeEach(() => {
    register('write_file', () => 'written');
    register('read_file', () => 'contents');
  });

  // The workspace does not stand still while a thread works, and a file that
  // will not go back is worth finding now, while the model still has the
  // problem in mind
  it('squares the changes with the workspace once a reply that changed files ends', async () => {
    script([call('c1', 'write_file'), done('tool_use')], answer('Changed it.'));
    const events = await collect(run(coding, signal()));
    expect(mocks.sync).toHaveBeenCalledWith(THREAD, WORKSPACE);
    expect(only(events, 'tool_call').at(-1)).toMatchObject({ name: 'sync_workspace' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('does not bother for a reply that changed nothing', async () => {
    script([call('c1', 'read_file'), done('tool_use')], answer());
    await collect(run(coding, signal()));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // A suggestion makes its change in a demo copy that is reverted (see main.ts),
  // so a sync would push a change the user was only shown back onto their
  // project: it is skipped, whatever files the suggestion touched.
  it('does not square a suggestion with the workspace, even when it changed files', async () => {
    mocks.classify.mockResolvedValue(needs(3, { category: 'suggestion' }));
    script([call('c1', 'write_file'), done('tool_use')], answer('Suggested it.'));
    await collect(run(coding, signal()));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // It thought it was finished, so it is told plainly that it is not, and what
  // finishing means now
  it('sends the model back to settle a clash rather than ending on one', async () => {
    mocks.sync
      .mockResolvedValueOnce({ pulled: [], merged: [], clashes: [CLASH] })
      .mockResolvedValue({ pulled: [], merged: ['src/a.ts'], clashes: [] });
    mocks.syncReport.mockReturnValue('src/a.ts clashes');
    script([call('c1', 'write_file'), done('tool_use')], [text('Changed it.'), done()], answer('Settled.'));
    const events = await collect(run(coding, signal()));
    expect(snapshots[2].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('it has to fit into it'),
    });
    expect(snapshots[2].messages.at(-1)!.content).toContain('src/a.ts clashes');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  // A model that answers the clash in words rather than settling it used to
  // end the reply there: the check turned on the reply having written a file
  // since, and a reply that wrote nothing was never checked again
  it('checks again even when the model answered without touching a file', async () => {
    mocks.sync
      .mockResolvedValueOnce({ pulled: [], merged: [], clashes: [CLASH] })
      .mockResolvedValue({ pulled: [], merged: [], clashes: [] });
    script([call('c1', 'write_file'), done('tool_use')], [text('Changed it.'), done()], answer('It clashes, sorry.'));
    await collect(run(coding, signal()));
    expect(mocks.sync.mock.calls.length).toBe(2);
  });

  // A model that cannot settle a clash in two goes is not going to settle it
  // in ten, and what is still wrong is in the thread either way
  it('gives up after two goes at a clash', async () => {
    mocks.sync.mockResolvedValue({ pulled: [], merged: [], clashes: [CLASH] });
    onStream(() => from([call('c', 'write_file'), done('tool_use')]));
    await collect(run(coding, signal()));
    expect(mocks.sync.mock.calls.length).toBeLessThanOrEqual(3);
  });

  // Saying nothing would leave the user to find out at the one moment this is
  // all meant to spare them: when they come to apply the work
  it('tells the user when it gives up with the clash still there', async () => {
    const warn = vi.spyOn(log, 'warn');
    mocks.sync.mockResolvedValue({ pulled: [], merged: [], clashes: [CLASH] });
    script(
      [call('c1', 'write_file'), done('tool_use')],
      [text('Changed it.'), done()],
      [text('Settled.'), done()],
      answer('Settled, really.')
    );
    const events = await collect(run(coding, signal()));
    const said = only(events, 'text')
      .map((event) => (event as { delta: string }).delta)
      .join('');
    expect(said).toContain('will not go back into your workspace');
    expect(said).toContain('src/a.ts');
    expect(warn).toHaveBeenCalledWith('reply.unsettled', expect.objectContaining({ clashes: ['src/a.ts'] }));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('work the reply handed out without waiting for it', () => {
  beforeEach(() => register('hand_to_subagent', () => 'handed out'));

  // Ending now would throw away what those subagents find and leave the thread
  // with rows that never finish
  it('collects it before the reply ends, and gives the model what came back', async () => {
    const info = vi.spyOn(log, 'info');
    mocks.stillRunning.mockReturnValueOnce([{ id: 's1' }]).mockReturnValue([]);
    mocks.waitFor.mockResolvedValue([{ id: 's1', text: 'Renamed it.' }]);
    mocks.subagentReport.mockReturnValue('s1 renamed it');
    script([text('Handed out.'), done()], answer('All in.'));
    const events = await collect(run(coding, signal()));
    expect(mocks.waitFor).toHaveBeenCalled();
    expect(only(events, 'tool_call').at(-1)).toMatchObject({ name: 'wait_for_subagents' });
    expect(snapshots[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You handed these pieces out without waiting for them'),
    });
    expect(snapshots[1].messages.at(-1)!.content).toContain('s1 renamed it');
    expect(info).toHaveBeenCalledWith('reply.gathered', expect.objectContaining({ subagents: 1 }));
  });

  it('leaves a reply with nothing outstanding alone', async () => {
    script(answer());
    await collect(run(coding, signal()));
    expect(mocks.waitFor).not.toHaveBeenCalled();
  });

  // A reply that keeps starting work as it is being ended is not finishing
  it('stops collecting after twice', async () => {
    mocks.stillRunning.mockReturnValue([{ id: 's1' }]);
    mocks.waitFor.mockResolvedValue([{ id: 's1', text: 'done' }]);
    mocks.subagentReport.mockReturnValue('report');
    script([text('One.'), done()], [text('Two.'), done()], [text('Three.'), done()], [text('Four.'), done()]);
    await collect(run(coding, signal()));
    expect(mocks.waitFor.mock.calls.length).toBe(2);
  });

  it('only collects for a reply that is ending cleanly', async () => {
    mocks.stillRunning.mockReturnValue([{ id: 's1' }]);
    script([text('Cut off.'), done('max_tokens')]);
    await collect(run(coding, signal()));
    expect(mocks.waitFor).not.toHaveBeenCalled();
  });
});

describe('gaps a reply can end in that the rounds did not cause', () => {
  beforeEach(() => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    register('read_file', ({ path }) => `contents of ${path}`);
  });

  // The share is worked out from what a round is reckoned to cost, and a read
  // can be dearer than that, so the same ending is reached by measuring
  // instead of counting
  it('ends the finding-out step when the window fills before the rounds run out', async () => {
    const info = vi.spyOn(log, 'info');
    mocks.nearlyFull.mockReturnValue(true);
    script(
      [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
      [text('Written up from what I read.'), done()],
      [text('Plan.'), done()],
      [text('Did.'), done()],
      answer()
    );
    await collect(run({ ...coding, plan: 'always' }, signal()));
    expect(info).toHaveBeenCalledWith('phase.spent', expect.objectContaining({ phase: 'explore', why: 'window' }));
    const told = snapshots.find((s) => JSON.stringify(s.messages).includes('no more room in this window'));
    expect(told).toBeDefined();
  });

  // Condensing is the wrong answer for the finding-out step twice over: what
  // it condenses away is what the step's whole output is drawn from
  it('does not condense the finding-out step, it ends it', async () => {
    mocks.nearlyFull.mockReturnValue(true);
    script(
      [call('c1', 'read_file', { path: 'src/a.ts' }), done('tool_use')],
      [text('Written up.'), done()],
      [text('Plan.'), done()],
      [text('Did.'), done()],
      answer()
    );
    const events = await collect(run({ ...coding, plan: 'always' }, signal()));
    // The planning step onwards may condense; the finding-out step never does
    const firstCondense = types(events).indexOf('condensing');
    const leftExplore = events.findIndex((e) => e.type === 'phase' && e.phase === 'plan');
    expect(firstCondense === -1 || firstCondense > leftExplore).toBe(true);
  });
});

describe('what a step may say it knows', () => {
  beforeEach(() => {
    mocks.classify.mockResolvedValue(needs(1, { category: 'coding' }));
    register('read_file', ({ path }) => `contents of ${path}`);
  });

  // A handout and a reading command both say what is inside a file the step
  // never opened for itself, so what they printed grounds a claim too
  it.each(['hand_to_subagent', 'run_reading_command'])(
    'counts a file %s reported on as one the step has had open',
    async (name) => {
      const info = vi.spyOn(log, 'info');
      register(name, () => 'src/reported.ts:12: function save() {}');
      script(
        [call('c1', name), done('tool_use')],
        [text('save() is in src/reported.ts.'), done()],
        [text('Plan.'), done()],
        [text('Did.'), done()],
        answer()
      );
      await collect(run({ ...coding, plan: 'always' }, signal()));
      expect(info).not.toHaveBeenCalledWith('phase.ungrounded', expect.anything());
    }
  );

  // A read that failed opened nothing
  it('does not count a file a failed read was aimed at', async () => {
    const info = vi.spyOn(log, 'info');
    tools.clear();
    register('read_file', ({ path }) => {
      if (path === 'src/missing.ts') throw new Error('no such file');
      return `contents of ${path}`;
    });
    script(
      [
        call('c0', 'read_file', { path: 'src/a.ts' }),
        call('c1', 'read_file', { path: 'src/missing.ts' }),
        done('tool_use'),
      ],
      [text('The timer is in src/missing.ts.'), done()],
      [text('Plan.'), done()],
      [text('Did.'), done()],
      answer()
    );
    await collect(run({ ...coding, plan: 'always' }, signal()));
    expect(info).toHaveBeenCalledWith('phase.ungrounded', expect.objectContaining({ paths: ['src/missing.ts'] }));
  });
});

describe('what a reply reports it used', () => {
  // cacheRead and cacheWrite are parts of input rather than additions to it,
  // kept so that the line ending the reply says how much it paid full price for
  it('adds up what each pass used, and says what of it was cached', async () => {
    register('get_time', () => '12:00');
    script(
      [
        call('c1', 'get_time'),
        {
          type: 'done',
          stopReason: 'tool_use',
          usage: { input: 100, output: 10, cacheRead: 80, cacheWrite: 20 },
        } as ChatEvent,
      ],
      [
        text('Noon.'),
        {
          type: 'done',
          stopReason: 'end_turn',
          usage: { input: 50, output: 5, cacheRead: 40, cacheWrite: 0 },
        } as ChatEvent,
      ]
    );
    const events = await collect(run(ask, signal()));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { input: 150, output: 15, cacheRead: 120, cacheWrite: 20 },
    });
  });

  // Most providers say nothing about caching at all, and "nothing cached" is
  // not the same answer as "no idea"
  it('leaves a cached share of none out rather than reporting a nought', async () => {
    script(answer());
    const events = await collect(run(ask, signal()));
    const ended = events.at(-1) as Extract<HarnessEvent, { type: 'done' }>;
    expect(ended.usage).toEqual({ input: 1, output: 2 });
    expect(ended.usage).not.toHaveProperty('cacheRead');
  });

  it('reports nothing for a pass the provider gave no counts for', async () => {
    script([text('Hi.'), { type: 'done', stopReason: 'end_turn' } as ChatEvent]);
    const events = await collect(run(ask, signal()));
    expect(only(events, 'usage')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { input: 0, output: 0 } });
  });

  // Logged per pass rather than per reply, because this is where a cache that
  // has stopped working shows: a loop whose cacheRead stays at nought from one
  // step to the next is paying full price for the same prompt over again
  it('logs what each pass read back from the cache and wrote into it', async () => {
    const info = vi.spyOn(log, 'info');
    register('get_time', () => '12:00');
    script(
      [
        call('c1', 'get_time'),
        { type: 'done', stopReason: 'tool_use', usage: { input: 100, output: 10, cacheRead: 80, cacheWrite: 20 } },
      ] as ChatEvent[],
      [
        text('Noon.'),
        { type: 'done', stopReason: 'end_turn', usage: { input: 120, output: 2, cacheRead: 100 } },
      ] as ChatEvent[]
    );
    await collect(run(ask, signal()));
    expect(info).toHaveBeenCalledWith(
      'llm.call',
      expect.objectContaining({ step: 1, input: 100, cacheRead: 80, cacheWrite: 20 })
    );
    expect(info).toHaveBeenCalledWith('llm.call', expect.objectContaining({ step: 2, input: 120, cacheRead: 100 }));
  });

  it('says nothing of a cache in the log where the provider reported none', async () => {
    const info = vi.spyOn(log, 'info');
    script(answer());
    await collect(run(ask, signal()));
    const line = info.mock.calls.find(([event]) => event === 'llm.call')?.[1];
    expect(line).toMatchObject({ input: 1, output: 2 });
    expect(line?.cacheRead).toBeUndefined();
    expect(line?.cacheWrite).toBeUndefined();
  });
});

// A reply that is not an answer to a message at all, but a job another reply
// handed to an agent subagent and put through this whole flow (see
// HarnessRequest.agent, and src/subagents/thread.ts for what sends it here).
describe('a reply that is an agent subagent’s', () => {
  const AS_AGENT: HarnessRequest = {
    ...coding,
    agent: { name: 'the importer', depth: 1 },
    rounds: Infinity,
    plan: 'never',
  };
  // A letter waiting in the box, and what it was answered with
  const letter = (said: string) => {
    const answer = vi.fn();
    mocks.letters.mockReturnValueOnce([{ text: said, answer }]);
    return answer;
  };

  it('is told what it is, before anything that changes with the round', async () => {
    register('read_file', () => 'contents');
    script(answer());
    await collect(run(AS_AGENT, signal()));
    expect(system()).toContain('AGENT PROMPT');
    // Second, after who the model is and before everything about the job
    expect(system().indexOf('AGENT PROMPT')).toBeLessThan(system().indexOf('SANDBOX PROMPT'));
  });

  // Its words go back to the model that sent it, which reads them as they
  // stand and renders none of it
  it('is told to write plainly, where a reply to a message is told to write Markdown', async () => {
    script(answer());
    await collect(run(AS_AGENT, signal()));
    expect(system()).toContain('PLAIN PROMPT');
    expect(system()).not.toContain('Markdown');
    snapshots.length = 0;
    script(answer());
    await collect(run(coding, signal()));
    expect(system()).toContain('Markdown');
    expect(system()).not.toContain('PLAIN PROMPT');
  });

  it('keeps its context note under its own name, nothing else being able to write to it', async () => {
    register('read_file', () => 'contents');
    script(answer());
    await collect(run(AS_AGENT, signal()));
    expect(mocks.readContext).toHaveBeenCalledWith(THREAD, 'the importer');
  });

  it('writes down what a compaction found in its own note as well', async () => {
    // Condensing needs a model that says how much room it has
    mocks.listModels.mockResolvedValue({ models: [roomy], providers: [] });
    mocks.nearlyFull.mockReturnValue(true);
    mocks.compact.mockResolvedValue({ messages: [], usage: { input: 1, output: 1 }, findings: 'Found in import.ts' });
    register('read_file', () => 'contents');
    script(answer());
    await collect(run(AS_AGENT, signal()));
    expect(mocks.keepFindings).toHaveBeenCalledWith(THREAD, 'Found in import.ts', 'the importer');
  });

  it('is refused what the kind refuses', async () => {
    register('read_file', () => 'contents');
    register('record', () => 'filmed');
    script(answer());
    await collect(run(AS_AGENT, signal()));
    const offered = last().tools?.map(({ name }) => name) ?? [];
    expect(offered).toContain('read_file');
    // What no subagent may do, whatever else it has
    expect(offered).not.toContain('record');
  });

  // Without this an agent could send agents for ever: the list a subagent run
  // through this flow is offered is built by the harness, not by specsFor
  it('is offered nothing to hand work out with at the bottom of the chain', async () => {
    register('read_file', () => 'contents');
    register('hand_to_subagent', () => 'handed out');
    register('wait_for_subagents', () => 'waited');
    register('message_subagent', () => 'wrote');
    const offered = async (depth: number) => {
      snapshots.length = 0;
      script(answer());
      await collect(run({ ...AS_AGENT, agent: { name: 'the importer', depth } }, signal()));
      return last().tools?.map(({ name }) => name) ?? [];
    };
    // Two deep it may still send: that is the chain the loop allows as well
    expect(await offered(2)).toContain('hand_to_subagent');
    // Three deep it may read, and has nobody left to send
    const bottom = await offered(3);
    expect(bottom).toContain('read_file');
    for (const name of ['hand_to_subagent', 'wait_for_subagents', 'message_subagent']) {
      expect(bottom, name).not.toContain(name);
    }
  });

  it('tells the tools it calls which subagent is calling, and how far down it stands', async () => {
    const seen: unknown[] = [];
    register('read_file', (_input, context) => {
      seen.push(context);
      return 'contents';
    });
    script([call('c1', 'read_file'), done('tool_use')], answer());
    await collect(run(AS_AGENT, signal()));
    expect(seen[0]).toMatchObject({ agent: 'the importer', depth: 1 });
  });

  // A reply gets the rounds its message's effort bought; a job gets what the
  // job takes (see HarnessRequest.rounds)
  it('takes as many rounds as the job needs, where a message’s reply is held to its effort', async () => {
    register('read_file', () => 'contents');
    mocks.classify.mockResolvedValue(needs(1, { effort: 'low' }));
    const reading = (rounds: number) => {
      let left = rounds;
      onStream(() => from(left-- > 0 ? [call(`c${left}`, 'read_file'), done('tool_use')] : answer('Moved it.')));
    };
    // Twelve rounds of reading, where a low-effort reply in a workspace has
    // sixty: the job answers on the thirteenth either way
    reading(12);
    const asAgent = only(await collect(run(AS_AGENT, signal())), 'done');
    expect(asAgent[0]).toMatchObject({ stopReason: 'end_turn', steps: 13 });

    // ...and the same script against a ceiling of three rounds stops at three
    snapshots.length = 0;
    reading(12);
    const bounded = only(await collect(run({ ...AS_AGENT, rounds: 3 }, signal())), 'done');
    expect(bounded[0]).toMatchObject({ stopReason: 'max_steps', steps: 3 });
  });

  it('reads what was written to it as a turn of its own, and answers it with what it writes', async () => {
    const answered = letter('Skip the legacy routes.');
    script(answer('Dropped them; on the v2 ones now.'));
    await collect(run(AS_AGENT, signal()));
    expect(String(snapshots[0].messages.at(-1)?.content)).toBe('WRITTEN: Skip the legacy routes.');
    expect(answered).toHaveBeenCalledWith('Dropped them; on the v2 ones now.');
  });

  it('answers it with what it called, where it read the letter and wrote nothing back', async () => {
    register('read_file', () => 'contents');
    const answered = letter('How far along are you?');
    script([call('c1', 'read_file'), done('tool_use')], answer());
    await collect(run(AS_AGENT, signal()));
    expect(answered).toHaveBeenCalledWith('called read_file');
  });

  // Reading that round as the end of the job hands the sentence it wrote for
  // whoever asked back as the whole of its work (see mailbox.ANSWERED)
  it('is told that answering is not reporting, where it answered and called nothing', async () => {
    const answered = letter('How far along are you?');
    script(answer('Two of the four files.'), answer('All four moved over.'));
    const events = await collect(run(AS_AGENT, signal()));
    expect(answered).toHaveBeenCalledWith('Two of the four files.');
    expect(String(snapshots[1].messages.at(-1)?.content)).toBe('ANSWERED: not your report');
    // ...and the job's own answer is what it said when the work was done
    expect(only(events, 'text').map((e) => e.delta)).toEqual(['Two of the four files.', 'All four moved over.']);
  });

  it('is the only kind of reply with a letterbox at all: nobody can write to a thread’s own', async () => {
    script(answer());
    await collect(run(coding, signal()));
    expect(mocks.letters).not.toHaveBeenCalled();
  });
});
