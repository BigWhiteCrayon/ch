import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest, FileChange } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), stream: vi.fn(), list: vi.fn() }));
vi.mock('../../src/llm', () => ({ listModels: mocks.listModels, stream: mocks.stream }));
vi.mock('../../src/sandbox/changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sandbox/changes')>()),
  list: mocks.list,
}));

import { PROMPT, batch, combine, parse, pickModel, verify } from '../../src/harness/verifier';

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
    expect(sent()).toMatchObject({ provider: 'local', model: 'qwen:32b', system: PROMPT, brief: true });
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
