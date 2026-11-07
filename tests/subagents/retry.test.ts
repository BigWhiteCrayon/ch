import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), listModels: vi.fn() }));
vi.mock('../../src/llm', () => mocks);
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../src/log', () => log);
// The thread's container: what the retry runs in, and the note it is given
const sandbox = vi.hoisted(() => ({ readContext: vi.fn(), setWorkspace: vi.fn() }));
vi.mock('../../src/sandbox', () => sandbox);

import { retry } from '../../src/subagents/retry';
import { RETRY_LEVEL } from '../../src/subagents';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const small = model({ id: 'llama:3b', sophistication: 1 });
const big = model({ id: 'opus', name: 'Opus', provider: 'anthropic', local: false, sophistication: RETRY_LEVEL });

const text = (delta: string): ChatEvent => ({ type: 'text', delta });
const done = (stopReason = 'end_turn'): ChatEvent => ({ type: 'done', stopReason });
const requests = () => mocks.stream.mock.calls.map(([request]) => request as ChatRequest);

const asked = {
  thread: THREAD,
  workspace: '/projects/demo',
  id: 's1',
  name: 'tests',
  task: 'read the tests',
  kind: 'worker',
};
// What the subagent said while it worked
const seen: AgentEvent[] = [];
const run = (what = asked) => retry(what, (event) => seen.push(event), new AbortController().signal);

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.listModels.mockReset();
  sandbox.setWorkspace.mockReset();
  sandbox.readContext.mockResolvedValue('');
  mocks.listModels.mockResolvedValue({ models: [big, small], providers: [] });
  mocks.stream.mockImplementation(() => from([text('They use vitest.'), done()]));
  seen.length = 0;
});

describe('running one subagent again', () => {
  it('runs the piece of work it is given, and gives back what came of it', async () => {
    expect(await run()).toEqual({ text: 'They use vitest.', isError: false });
    // The subagent was given its task and nothing else to go on
    expect(String(requests()[0].messages[0].content)).toContain('read the tests');
  });

  it('runs it in the thread’s own container, on the files that thread has', async () => {
    await run();
    expect(sandbox.setWorkspace).toHaveBeenCalledWith(THREAD, '/projects/demo');
  });

  it('leaves the container alone for a thread that was started in no workspace', async () => {
    await run({ ...asked, workspace: undefined });
    expect(sandbox.setWorkspace).not.toHaveBeenCalled();
  });

  it('picks a capable model for it now, rather than whichever one asked for it then', async () => {
    await run();
    expect(requests()[0]).toMatchObject({ provider: 'anthropic', model: 'opus' });
  });

  it('says so, without running anything, when there is no model to run it on', async () => {
    mocks.listModels.mockResolvedValue({ models: [], providers: [] });
    expect(await run()).toEqual({ text: 'No models available.', isError: true });
    expect(requests()).toEqual([]);
  });

  it('passes its work on as it happens, in the events a subagent reports by', async () => {
    mocks.stream.mockImplementation(() =>
      from([
        { type: 'reasoning', delta: 'Reading them now. ' } as ChatEvent,
        { type: 'reasoning', delta: 'They look like vitest.' } as ChatEvent,
        text('They use vitest.'),
        done(),
      ])
    );
    await run();
    expect(seen).toContainEqual({ type: 'thought', text: 'Reading them now. They look like vitest.' });
  });

  it('is the kind of subagent it was, and the ordinary kind when that is not known', async () => {
    await run({ ...asked, kind: 'explorer' });
    expect(String(requests()[0].system)).toContain('explorer');
    mocks.stream.mockClear();
    await run({ ...asked, kind: 'no-such-kind' });
    expect(requests()).toHaveLength(1);
  });

  it('can be a reviewer, which is a kind no model is ever allowed to ask for', async () => {
    await run({ ...asked, kind: 'reviewer' });
    expect(String(requests()[0].system)).toContain('comment');
  });

  it('gives back what went wrong rather than throwing it at the window', async () => {
    mocks.stream.mockImplementation(() => {
      throw new Error('Docker is not running.');
    });
    expect(await run()).toEqual({ text: 'Docker is not running.', isError: true });
  });

  // A run that picks a subagent up where the app closed on it is given what it
  // had done, so the piece is carried on rather than started over (see
  // subagents/retry.ts)
  it('carries on from what it had done, where the app is picking it up', async () => {
    await run({
      ...asked,
      resumed: { did: ['read_file("a.ts") returned: the file'], text: 'Reading a.ts now.' },
    });
    const request = requests()[0];
    // Its task is still the first thing it is given
    expect(request.messages[0]).toEqual({ role: 'user', content: 'read the tests' });
    // ...and what it had done goes in front of it, so it carries on
    expect(request.messages[1]).toEqual({ role: 'assistant', content: 'Reading a.ts now.' });
    const picked = String(request.messages.at(-1)?.content ?? '');
    expect(picked).toContain('read_file');
    expect(picked).toContain('Carry on');
  });
});
