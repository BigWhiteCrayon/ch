import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest, FileChange } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  stream: vi.fn(),
  list: vi.fn(),
  snapshot: vi.fn(),
  revert: vi.fn(),
  findings: vi.fn(),
}));
vi.mock('../../src/llm', () => ({ listModels: mocks.listModels, stream: mocks.stream }));
vi.mock('../../src/sandbox/changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sandbox/changes')>()),
  list: mocks.list,
  snapshot: mocks.snapshot,
  revert: mocks.revert,
}));
vi.mock('../../src/subagents', () => ({ findings: mocks.findings, TESTER: { name: 'tester' } }));

import { PROMPT, batch, combine, parse, pickModel, report, testTask, verify } from '../../src/harness/verifier';

const small = model({ id: 'llama3.2:3b', sophistication: 2 });
const mid = model({ id: 'qwen:32b', sophistication: 4 });
const sonnet = model({ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', local: false, sophistication: 4 });
const opus = model({ id: 'opus', name: 'Opus', provider: 'anthropic', local: false, sophistication: 5 });
const all = [small, sonnet, opus, mid];

const sent = (call = 0) => mocks.stream.mock.calls[call][0] as ChatRequest;
const content = (call = 0) => sent(call).messages[0].content as string;
const file = (path: string, diff: string): FileChange => ({ path, status: 'modified', binary: false, diff });
const replyWith = (...events: ChatEvent[]) => mocks.stream.mockImplementation(() => from(events));
const request = {
  thread: 't1',
  request: 'Add a flag',
  output: 'Done, I added it.',
  provider: 'local',
  model: 'qwen:32b',
};

beforeEach(() => {
  mocks.listModels.mockReset();
  mocks.stream.mockReset();
  mocks.list.mockReset();
  mocks.snapshot.mockReset().mockResolvedValue('tree-before');
  mocks.revert.mockReset().mockResolvedValue(true);
  mocks.findings.mockReset();
  mocks.listModels.mockResolvedValue({ models: all, providers: [] });
  mocks.list.mockResolvedValue({
    files: [{ path: 'src/a.ts', status: 'modified', binary: false, diff: '@@ -1 +1 @@\n-a\n+b' }],
  });
  replyWith({ type: 'text', delta: 'PASS' }, { type: 'done', stopReason: 'stop' });
});

describe('pickModel', () => {
  it('picks the least capable model that is as capable as the writer, a local one on a tie', () => {
    expect(pickModel(all, { provider: 'local', model: 'qwen:32b' })).toBe(mid);
    expect(pickModel(all, { provider: 'anthropic', model: 'sonnet' })).toBe(mid);
    expect(pickModel(all, { provider: 'local', model: 'llama3.2:3b' })).toBe(small);
  });

  it('goes higher when nothing else is as capable', () => {
    expect(pickModel(all, { provider: 'anthropic', model: 'opus' })).toBe(opus);
    expect(pickModel([small, opus], { provider: 'local', model: 'llama3.2:3b' })).toBe(small);
    expect(pickModel([small, opus], { provider: 'anthropic', model: 'opus' })).toBe(opus);
  });

  it('uses the most capable model when the writer is not known', () => {
    expect(pickModel(all)).toBe(opus);
    expect(pickModel(all, { provider: 'local', model: 'gone' })).toBe(opus);
    expect(pickModel([])).toBeUndefined();
  });

  it('leaves the list as it was', () => {
    const models = [...all];
    pickModel(models, { provider: 'local', model: 'qwen:32b' });
    expect(models).toEqual(all);
  });
});

describe('parse', () => {
  it.each(['PASS', '  pass.\n', '**PASS**', '## Pass\nNothing wrong.', '`PASS`'])('reads %j as a pass', (reply) => {
    expect(parse(reply)).toEqual({ passed: true, problems: '' });
  });

  it('reads what follows PROBLEMS as the problems', () => {
    expect(parse('PROBLEMS\n- No test.\n- Wrong file.\n')).toEqual({
      passed: false,
      problems: '- No test.\n- Wrong file.',
    });
    expect(parse('**Problems:**\n- No test.')).toEqual({ passed: false, problems: '- No test.' });
    expect(parse('PROBLEMS: it forgot b.ts')).toEqual({ passed: false, problems: 'it forgot b.ts' });
  });

  it('reads the verdict a model reasoned its way to, rather than only its first line', () => {
    const reply = [
      'Looking at the diffs for the upload feature, I need to check correctness and completeness.',
      '',
      '**Bug found:** the drop handler never calls preventDefault().',
      '',
      'PROBLEMS',
      '- src/renderer/attachments.ts: the drop listener does not call e.preventDefault().',
    ].join('\n');
    expect(parse(reply)).toEqual({
      passed: false,
      problems: '- src/renderer/attachments.ts: the drop listener does not call e.preventDefault().',
    });
    expect(parse('I checked every diff and the wiring holds up.\n\nPASS')).toEqual({ passed: true, problems: '' });
  });

  it('keeps looking above a line that says PROBLEMS and names none', () => {
    const verdict = parse('PROBLEMS\n- No test.\n\nPROBLEMS');
    expect(verdict?.passed).toBe(false);
    expect(verdict?.problems).toContain('- No test.');
  });

  it.each(['', 'Looks fine to me', 'PROBLEMS', 'PASSING\n- no'])('cannot read %j', (reply) => {
    expect(parse(reply)).toBeNull();
  });
});

describe('batch', () => {
  it('fills a batch up to the budget and starts another', () => {
    const files = [file('a', 'x'.repeat(60)), file('b', 'y'.repeat(50)), file('c', 'z'.repeat(10))];
    expect(batch(files, 100).map((group) => group.map((f) => f.path))).toEqual([['a'], ['b', 'c']]);
  });

  it('never splits a file, however long its diff', () => {
    const files = [file('big', 'x'.repeat(500)), file('small', 'y')];
    expect(batch(files, 100).map((group) => group.map((f) => f.path))).toEqual([['big'], ['small']]);
  });

  it('keeps everything, in the order it came, in as few batches as fit', () => {
    const files = Array.from({ length: 9 }, (_, i) => file(`f${i}`, 'x'.repeat(10)));
    const batches = batch(files, 30);
    expect(batches.flat()).toEqual(files);
    expect(batches).toHaveLength(3);
  });

  it('has nothing to do with no files', () => {
    expect(batch([], 100)).toEqual([]);
  });
});

describe('combine', () => {
  it('passes only where every batch did, and keeps what each one found', () => {
    expect(
      combine([
        { passed: true, problems: '' },
        { passed: true, problems: '' },
      ])
    ).toEqual({
      passed: true,
      problems: '',
    });
    expect(
      combine([
        { passed: true, problems: '' },
        { passed: false, problems: '- b.ts is untouched.' },
        { passed: false, problems: '- c.ts has no test.' },
      ])
    ).toEqual({ passed: false, problems: '- b.ts is untouched.\n- c.ts has no test.' });
  });
});

describe('verify', () => {
  it('asks a model as capable as the writer about the request, reply and diffs, and returns a pass', async () => {
    const result = await verify(request);
    expect(result).toEqual({ passed: true, problems: '', model: 'qwen:32b', usage: undefined });
    expect(mocks.list).toHaveBeenCalledWith('t1');
    expect(sent()).toMatchObject({ provider: 'local', model: 'qwen:32b', system: PROMPT, brief: true, think: true });
    expect(PROMPT).toContain('You have no tools here');
    expect(content()).toContain('<request>\nAdd a flag\n</request>');
    expect(content()).toContain('<reply>\nDone, I added it.\n</reply>');
    expect(content()).toContain('## src/a.ts (modified)\n@@ -1 +1 @@\n-a\n+b');
  });

  it('returns the problems the reviewer found', async () => {
    replyWith({ type: 'text', delta: 'PROBLEMS\n- b.ts' }, { type: 'text', delta: ' is untouched.' });
    await expect(verify(request)).resolves.toMatchObject({ passed: false, problems: '- b.ts is untouched.' });
  });

  it('cuts what is very long', async () => {
    await verify({ ...request, request: 'x'.repeat(5000) });
    expect(content()).toContain(`${'x'.repeat(4000)} [...]`);
  });

  it('throws when the changes cannot be told, or there are none', async () => {
    mocks.list.mockResolvedValue({ files: [], unavailable: 'The container is not running.' });
    await expect(verify(request)).rejects.toThrow('The container is not running.');
    mocks.list.mockResolvedValue({ files: [] });
    await expect(verify(request)).rejects.toThrow('There are no changes to review.');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('asks for room enough to think in', async () => {
    await verify(request);
    expect(sent().maxTokens).toBeGreaterThanOrEqual(8000);
  });

  it('throws when the reviewer was cut off for room, even where a verdict can be read', async () => {
    // A verdict was written and the reply ran out mid-way through the problems.
    // Showing those as the review would pass off a part of it as the whole.
    replyWith({ type: 'text', delta: 'PROBLEMS\n- b.ts is untou' }, { type: 'done', stopReason: 'length' });
    await expect(verify(request)).rejects.toThrow('The reviewer ran out of room before it finished.');

    // Spent on thinking, with nothing written at all
    replyWith({ type: 'done', stopReason: 'length' });
    await expect(verify(request)).rejects.toThrow('The reviewer ran out of room before it finished.');
  });

  it('says a reviewer that ran out of time ran out of time', async () => {
    // Cut off mid-verdict, which is not a reply that could not be read: the
    // model was still working on one
    replyWith({ type: 'reasoning', delta: 'Checking the wiring...' }, { type: 'done', stopReason: 'cancelled' });
    await expect(verify(request)).rejects.toThrow('The reviewer did not reach a verdict within 30 minutes.');
  });

  it('gives an online model ten minutes, a local one thirty', async () => {
    // Cut off mid-verdict, which is not a reply that could not be read
    const cancel = () =>
      replyWith({ type: 'reasoning', delta: 'Checking the wiring...' }, { type: 'done', stopReason: 'cancelled' });
    mocks.listModels.mockResolvedValue({ models: [sonnet], providers: [] });
    cancel();
    await expect(verify(request)).rejects.toThrow('The reviewer did not reach a verdict within 10 minutes.');

    mocks.listModels.mockResolvedValue({ models: [mid], providers: [] });
    cancel();
    await expect(verify(request)).rejects.toThrow('The reviewer did not reach a verdict within 30 minutes.');
  });

  it('does not spend its limit waiting its turn', async () => {
    vi.useFakeTimers();
    try {
      let waitedOut = false;
      mocks.stream.mockImplementation((_request: ChatRequest, signal: AbortSignal) =>
        (async function* (): AsyncGenerator<ChatEvent> {
          // Nine minutes behind a reply, which is inside no limit of its own
          await vi.advanceTimersByTimeAsync(540_000);
          yield { type: 'waited', ms: 540_000 };
          // ...then nine minutes of reviewing, which the limit allows in full
          await vi.advanceTimersByTimeAsync(540_000);
          waitedOut = signal.aborted;
          yield { type: 'text', delta: 'PASS' };
          yield { type: 'done', stopReason: 'stop' };
        })()
      );
      await expect(verify(request)).resolves.toMatchObject({ passed: true });
      expect(waitedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reviews a large change a batch of files at a time, each batch told every path', async () => {
    const files = [file('src/a.ts', 'x'.repeat(15000)), file('src/b.ts', 'y'.repeat(15000))];
    mocks.list.mockResolvedValue({ files });
    await expect(verify(request)).resolves.toMatchObject({ passed: true });

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    // Each batch holds its own diffs and nobody else's
    expect(content(0)).toContain('## src/a.ts (modified)');
    expect(content(0)).not.toContain('## src/b.ts (modified)');
    expect(content(1)).toContain('## src/b.ts (modified)');
    expect(content(1)).not.toContain('## src/a.ts (modified)');
    // ...and both are told the whole change, so neither reports the other as missing
    for (const call of [0, 1]) {
      expect(content(call)).toContain('<files>\nsrc/a.ts (modified)\nsrc/b.ts (modified)\n</files>');
    }
  });

  it('tells the reviewer about files that changed beyond the ones listed', async () => {
    mocks.list.mockResolvedValue({ files: [file('src/a.ts', '@@')], more: 2 });
    await verify(request);
    expect(content()).toContain('2 more changed files not listed.');
  });

  it('is told that workspace notes are never among the changed files', () => {
    expect(PROMPT).toContain('Workspace notes are kept outside the project');
  });

  it('is told to check the diffs, with the reply as context only', () => {
    // The prompt is wrapped across lines, so compare it with the line breaks made into spaces
    const flat = PROMPT.replace(/\n/g, ' ');
    expect(flat).toContain('The diffs are what you are checking.');
    expect(flat).toContain('is only there for context');
    expect(flat).not.toContain('claimed and not done');
  });

  it('adds up what the batches found and what they cost', async () => {
    mocks.list.mockResolvedValue({ files: [file('src/a.ts', 'x'.repeat(15000)), file('src/b.ts', 'y'.repeat(15000))] });
    mocks.stream
      .mockImplementationOnce(() =>
        from([
          { type: 'text', delta: 'PASS' },
          { type: 'done', stopReason: 'stop', usage: { input: 100, output: 10, cacheRead: 5 } },
        ] as ChatEvent[])
      )
      .mockImplementationOnce(() =>
        from([
          { type: 'text', delta: 'PROBLEMS\n- b.ts is untouched.' },
          { type: 'done', stopReason: 'stop', usage: { input: 200, output: 20, cacheRead: 7 } },
        ] as ChatEvent[])
      );
    const result = await verify(request);
    expect(result).toMatchObject({ passed: false, problems: '- b.ts is untouched.' });
    expect(result.usage).toMatchObject({ input: 300, output: 30, cacheRead: 12 });
  });

  it('counts the files it did not reach rather than passing over them quietly', async () => {
    // Eleven batches' worth, of which ten are reviewed
    const files = Array.from({ length: 11 }, (_, i) => file(`src/f${i}.ts`, 'x'.repeat(20000)));
    mocks.list.mockResolvedValue({ files, more: 3 });
    const result = await verify(request);
    expect(mocks.stream).toHaveBeenCalledTimes(10);
    // The one batch left over, and the files that were never listed at all
    expect(result.unreviewed).toBe(4);
  });

  it('says nothing about unreviewed files when it saw them all', async () => {
    await expect(verify(request)).resolves.toMatchObject({ unreviewed: undefined });
  });

  it('gives up the whole review when any one batch is cut off for room', async () => {
    mocks.list.mockResolvedValue({ files: [file('src/a.ts', 'x'.repeat(15000)), file('src/b.ts', 'y'.repeat(15000))] });
    mocks.stream
      .mockImplementationOnce(() =>
        from([
          { type: 'text', delta: 'PASS' },
          { type: 'done', stopReason: 'stop' },
        ] as ChatEvent[])
      )
      .mockImplementationOnce(() =>
        from([
          { type: 'text', delta: 'PROBLEMS\n- b.ts is unt' },
          { type: 'done', stopReason: 'length' },
        ] as ChatEvent[])
      );
    await expect(verify(request)).rejects.toThrow('The reviewer ran out of room before it finished.');
  });

  it('throws when there is no model, or it fails, or its reply is unreadable', async () => {
    mocks.listModels.mockResolvedValue({ models: [], providers: [] });
    await expect(verify(request)).rejects.toThrow('There is no model to review the changes with.');

    mocks.listModels.mockResolvedValue({ models: all, providers: [] });
    replyWith({ type: 'error', message: 'Rate limited.' } as ChatEvent);
    await expect(verify(request)).rejects.toThrow('Rate limited.');

    replyWith({ type: 'text', delta: 'Hmm, hard to say.' }, { type: 'done', stopReason: 'stop' });
    await expect(verify(request)).rejects.toThrow("The reviewer's reply could not be read.");
  });
});

describe('report', () => {
  it('reads what the reviewer checked, above its verdict, without the heading it was asked for', () => {
    expect(report('Checked:\n- ran npm test: 3 passed\n- sent "hi": it echoed\nPASS')).toEqual({
      passed: true,
      problems: '',
      checked: '- ran npm test: 3 passed\n- sent "hi": it echoed',
    });
    expect(report('**Checked:**\n- ran it\n\nPROBLEMS\n- It crashed on an empty message.')).toEqual({
      passed: false,
      problems: '- It crashed on an empty message.',
      checked: '- ran it',
    });
    expect(report('Checked:\n- nothing yet')).toBeNull();
  });
});

describe('testTask', () => {
  it('gives the tester the request, the reply as context, every path, and the diffs', () => {
    const task = testTask({ ...request, workspace: '/w' }, { files: [file('src/a.ts', '@@ -1 +1 @@\n-a\n+b')] });
    expect(task).toContain('<request>\nAdd a flag\n</request>');
    expect(task).toContain('<reply>\nDone, I added it.\n</reply>');
    expect(task).toContain('src/a.ts (modified)');
    expect(task).toContain('+b');
    expect(task).toContain('only what the model said it did');
    expect(task).not.toContain('thread_diff');
  });

  it('cuts the diffs short past a budget, and says where the rest is', () => {
    const task = testTask({ ...request, workspace: '/w' }, { files: [file('big.ts', `+${'x'.repeat(50000)}`)] });
    expect(task.length).toBeLessThan(45000);
    expect(task).toContain('read the rest with thread_diff');
  });
});

// In a thread with a workspace, the changes are tried: by a tester subagent in
// the thread's container (see ../../src/subagents/tester.ts)
describe('verify, in a thread with a workspace', () => {
  const inWorkspace = { ...request, workspace: '/projects/demo' };
  const found = (text: string, isError = false) =>
    mocks.findings.mockResolvedValue([{ name: 'review', task: '', text, isError }]);

  it("sends a tester into the thread's container, and returns its verdict and what it checked", async () => {
    found('Checked:\n- ran npm test: 12 passed\n- in the app, sent "hi": it echoed\n\nPASS');
    const verdict = await verify(inWorkspace);
    expect(verdict).toMatchObject({
      passed: true,
      problems: '',
      tested: true,
      model: mid.name,
      checked: '- ran npm test: 12 passed\n- in the app, sent "hi": it echoed',
    });
    const [[tasks, context]] = mocks.findings.mock.calls;
    expect(tasks).toEqual([{ name: 'review', task: expect.stringContaining('Add a flag'), kind: { name: 'tester' } }]);
    expect(context).toMatchObject({
      threadId: 't1',
      workspace: '/projects/demo',
      model: { provider: mid.provider, model: mid.id },
      sophistication: mid.sophistication,
    });
    // Not the review by reading alone
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('returns the problems it found, each with how it saw it', async () => {
    found('Checked:\n- sent "" in the app\nPROBLEMS\n- An empty message crashes the reply: sent "" and saw TypeError.');
    expect(await verify(inWorkspace)).toMatchObject({
      passed: false,
      problems: '- An empty message crashes the reply: sent "" and saw TypeError.',
      tested: true,
    });
  });

  it("puts the thread's files back as they were before it, in case a command it ran wrote some", async () => {
    found('Checked:\n- built it\nPASS');
    await verify(inWorkspace);
    expect(mocks.snapshot).toHaveBeenCalledWith('t1');
    expect(mocks.revert).toHaveBeenCalledWith('t1', 'tree-before');
  });

  it('leaves the files alone after a reply has begun on the thread, or with nothing to go back to', async () => {
    found('Checked:\n- built it\nPASS');
    await verify(inWorkspace, { untouched: () => false });
    expect(mocks.revert).not.toHaveBeenCalled();
    // Going back to no snapshot would be going back to the container as it was made, the reply's changes and all
    mocks.snapshot.mockResolvedValue(null);
    await verify(inWorkspace);
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it('adds up what its calls cost, as the review', async () => {
    mocks.findings.mockImplementation(async (_tasks, context) => {
      for (const input of [1000, 2500]) {
        context.emit({
          type: 'usage',
          purpose: 'subagent',
          provider: mid.provider,
          model: mid.id,
          input,
          output: 100,
          cost: 0,
        });
      }
      context.emit({
        type: 'tokens',
        purpose: 'subagent',
        provider: mid.provider,
        model: mid.id,
        input: 9,
        output: 9,
        cost: 0,
      });
      return [{ name: 'review', task: '', text: 'Checked:\n- ran it\nPASS', isError: false }];
    });
    const verdict = await verify(inWorkspace);
    expect(verdict.usage).toMatchObject({ purpose: 'verification', model: mid.id, input: 3500, output: 200 });
  });

  it('reviews by reading the diffs where the tester came back with no verdict, or failed', async () => {
    found('I looked around but ran out of rounds.');
    expect(await verify(inWorkspace)).toMatchObject({ passed: true, problems: '' });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    found('The model could not be reached.', true);
    const read = await verify(inWorkspace);
    expect(read.tested).toBeUndefined();
    mocks.findings.mockRejectedValue(new Error('No model is available to run subagents.'));
    expect(await verify(inWorkspace)).toMatchObject({ passed: true });
    // ...and the files are put back each time all the same
    expect(mocks.revert).toHaveBeenCalledTimes(3);
  });
});
