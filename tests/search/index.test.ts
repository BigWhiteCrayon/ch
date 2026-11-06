import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../../src/types';
import { unwrapped } from '../helpers';

const embeddings = vi.hoisted(() => ({
  search: vi.fn(),
  configure: vi.fn(),
  adopt: vi.fn(),
  start: vi.fn(),
  forgetThread: vi.fn(),
}));
vi.mock('../../src/search/embeddings', () => embeddings);
const ripgrep = vi.hoisted(() => ({
  keywordSearch: vi.fn(),
  regexSearch: vi.fn(),
  keywords: (query: string) => query.split(' '),
}));
vi.mock('../../src/search/ripgrep', () => ripgrep);
vi.mock('../../src/sandbox/docker', () => ({ WORKDIR: '/workspace' }));
const fs = vi.hoisted(() => ({ rmSync: vi.fn() }));
vi.mock('fs', () => ({ default: fs, ...fs }));

import * as search from '../../src/search';
import { pathFilter, registerTools, tools } from '../../src/tools/search';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const signal = new AbortController().signal;
const context = { signal, threadId: THREAD, workspace: '/projects/demo' };
const searchCode = tools.find((t) => t.name === 'search_workspace') as Tool;
const line = (n: number, text: string) => ({ line: n, text });
// What the embeddings fail with when Ollama hasn't got the model
const NOT_INSTALLED = 'The embedding model "nomic-embed-text" is not installed. Run: ollama pull nomic-embed-text';
const many2 = (path: string, count: number) => ({
  path,
  blocks: Array.from({ length: count }, (_, i) => [line(i + 1, `match ${i}`)]),
});

beforeEach(() => {
  vi.clearAllMocks();
  embeddings.search.mockReset();
  embeddings.search.mockResolvedValue({ files: [], indexed: 100 });
  ripgrep.keywordSearch.mockReset();
  ripgrep.regexSearch.mockReset();
});

describe('the search a workspace gets', () => {
  it('says where the vectors are kept, and which Ollama makes them', () => {
    search.init('/userData');
    expect(embeddings.configure).toHaveBeenCalledWith({ dir: '/userData' });
    // The clones the search this replaced kept are dead weight now
    expect(fs.rmSync).toHaveBeenCalledWith('/userData/search', { recursive: true, force: true });
    const local = { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '' };
    search.configure(local);
    expect(embeddings.configure).toHaveBeenLastCalledWith({ local });
  });

  it("gives an opened thread its own copy of the workspace's index, and gets the workspace indexed", () => {
    search.open(THREAD, '/projects/demo');
    expect(embeddings.adopt).toHaveBeenCalledWith({ workspace: '/projects/demo', thread: THREAD });
    expect(embeddings.start).toHaveBeenCalledWith('/projects/demo');
  });

  it("forgets a deleted thread's copy, and leaves the workspace's for the threads that share it", () => {
    search.close(THREAD);
    expect(embeddings.forgetThread).toHaveBeenCalledWith(THREAD);
  });
});

describe('pathFilter', () => {
  it.each([
    // A pattern with no glob characters is a path prefix
    ['src', 'src/a.ts', true],
    ['src', 'srcx/a.ts', false],
    ['src', 'src', true],
    ['./src/', 'src/a.ts', true],
    ['a.ts', 'a.ts', true],
    // One with no slash matches at any depth, as it does in ripgrep
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/deep/a.ts', true],
    ['*.ts', 'notes.txt', false],
    ['*.{ts,js}', 'src/a.ts', true],
    ['*.{ts,js}', 'src/a.js', true],
    ['*.{ts,js}', 'src/a.py', false],
    // * stays within one path segment; ** crosses them
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['src/**/*.ts', 'src/deep/a.ts', true],
    ['src/**', 'src/deep/a.ts', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
  ])('matches %j against %j as %j', (pattern, path, expected) => {
    expect(pathFilter(pattern)(path)).toBe(expected);
  });
});

describe('the search tool', () => {
  it('is only for threads that have a workspace', () => {
    expect(searchCode.needsWorkspace).toBe(true);
    expect(searchCode.inputSchema).toMatchObject({ type: 'object', required: ['query'] });
  });

  it('registers with the registry it is given', () => {
    const registry = { register: vi.fn() };
    registerTools(registry);
    expect(registry.register.mock.calls.map(([t]) => t.name)).toEqual(['search_workspace']);
  });

  it("searches the thread's workspace and lists the matching lines by file", async () => {
    embeddings.search.mockResolvedValue({
      files: [
        {
          path: 'src/settings.ts',
          blocks: [
            [line(11, 'const FILE = "settings.json";'), line(12, 'export function load() {')],
            [line(40, 'save();')],
          ],
        },
        { path: 'src/main.ts', blocks: [[line(7, "import * as settings from './settings';")]] },
      ],
      indexed: 100,
    });
    await expect(searchCode.run({ query: 'where are settings loaded' }, context)).resolves.toBe(
      [
        'src/settings.ts',
        '  11: const FILE = "settings.json";',
        '  12: export function load() {',
        '  …',
        '  40: save();',
        '',
        'src/main.ts',
        "  7: import * as settings from './settings';",
      ].join('\n')
    );
    expect(embeddings.search).toHaveBeenCalledWith(
      { workspace: '/projects/demo', thread: THREAD },
      'where are settings loaded',
      // One line more from each file than is shown, so a file cut short is known to be (see trim)
      { limit: 20, maxPerFile: 11, context: 1, pathsOnly: false, path: undefined, ignoreCase: false, thread: THREAD },
      signal
    );
  });

  it.each([
    [5, 5],
    [1000, 100],
    [-3, 20],
    ['many', 20],
  ])('asks for max_results %j as %i lines', async (asked, limit) => {
    await searchCode.run({ query: 'q', max_results: asked }, context);
    expect(embeddings.search.mock.calls[0][2].limit).toBe(limit);
  });

  describe('keeping the answer to the size asked for', () => {
    // Three files, each with more matches than a small limit allows
    const many = (path: string, from: number, count: number) => ({
      path,
      blocks: Array.from({ length: count }, (_, i) => [line(from + i * 10, `match ${i}`)]),
    });
    const lines = (output: string) => output.split('\n').filter((row) => /^ {2}\d+:/.test(row));

    beforeEach(() => {
      embeddings.search.mockResolvedValue({
        files: [many('a.ts', 1, 8), many('b.ts', 1, 8), many('c.ts', 1, 8)],
        indexed: 100,
      });
    });

    it('returns no more lines than max_results, however many came back', async () => {
      const output = (await searchCode.run({ query: 'q', max_results: 5 }, context)) as string;
      expect(lines(output)).toHaveLength(5);
    });

    it('takes no more than max_per_file from any one file, so one busy file cannot fill it', async () => {
      const output = (await searchCode.run({ query: 'q', max_per_file: 2 }, context)) as string;
      expect(lines(output)).toHaveLength(6);
      expect(output).toContain('a.ts');
      expect(output).toContain('c.ts');
    });

    it('asks for the context lines wanted, and for none when told 0', async () => {
      await searchCode.run({ query: 'q', context_lines: 4 }, context);
      expect(embeddings.search.mock.calls[0][2].context).toBe(4);
      await searchCode.run({ query: 'q', context_lines: 0 }, context);
      expect(embeddings.search.mock.calls[1][2].context).toBe(0);
      // More than this tool allows, and nonsense, both fall back
      await searchCode.run({ query: 'q', context_lines: 99 }, context);
      expect(embeddings.search.mock.calls[2][2].context).toBe(5);
      await searchCode.run({ query: 'q', context_lines: -1 }, context);
      expect(embeddings.search.mock.calls[3][2].context).toBe(1);
    });

    it('lists the paths alone when asked, with no lines and no context', async () => {
      const output = (await searchCode.run({ query: 'q', paths_only: true, context_lines: 3 }, context)) as string;
      expect(output).toBe('a.ts\nb.ts\nc.ts');
      expect(embeddings.search.mock.calls[0][2]).toMatchObject({ pathsOnly: true, context: 0 });
    });

    it('counts max_results as files when only the paths are wanted', async () => {
      const output = (await searchCode.run({ query: 'q', paths_only: true, max_results: 2 }, context)) as string;
      expect(output.startsWith('a.ts\nb.ts\n\n')).toBe(true);
      // ...and says the third was left out, so the list is not taken for all there is
      expect(unwrapped(output)).toContain('at least 1 further, left out by max_results (2)');
    });
  });

  // Pieces of a file overlap on purpose (see chunks.OVERLAP), so two of them
  // matching in the same place used to be shown twice over, and to be charged
  // against the limits twice over with them
  describe('runs of lines that overlap', () => {
    it('shows a line once, however many pieces it matched in', async () => {
      embeddings.search.mockResolvedValue({
        files: [
          {
            path: 'a.ts',
            blocks: [
              [line(10, 'ten'), line(11, 'eleven'), line(12, 'twelve')],
              [line(11, 'eleven'), line(12, 'twelve')],
            ],
          },
        ],
        indexed: 100,
      });
      const output = (await searchCode.run({ query: 'q' }, context)) as string;
      expect(output).toBe('a.ts\n  10: ten\n  11: eleven\n  12: twelve');
    });

    it('joins a run that carries on from another, and keeps the ones that stand apart', async () => {
      embeddings.search.mockResolvedValue({
        files: [
          {
            path: 'a.ts',
            blocks: [[line(10, 'ten')], [line(11, 'eleven')], [line(40, 'forty')]],
          },
        ],
        indexed: 100,
      });
      const output = (await searchCode.run({ query: 'q' }, context)) as string;
      expect(output).toBe('a.ts\n  10: ten\n  11: eleven\n  …\n  40: forty');
    });

    it('spends the limit on lines the model has not been shown', async () => {
      embeddings.search.mockResolvedValue({
        files: [
          {
            path: 'a.ts',
            blocks: [[line(1, 'one')], [line(1, 'one')], [line(50, 'fifty')]],
          },
        ],
        indexed: 100,
      });
      const output = (await searchCode.run({ query: 'q', max_results: 2 }, context)) as string;
      expect(output).toBe('a.ts\n  1: one\n  …\n  50: fifty');
    });
  });

  describe('searching only part of the workspace', () => {
    beforeEach(() => {
      embeddings.search.mockResolvedValue({
        files: [
          { path: 'src/search/index.ts', blocks: [[line(1, 'a')]] },
          { path: 'src/llm/index.ts', blocks: [[line(2, 'b')]] },
          { path: 'tests/search/index.test.ts', blocks: [[line(3, 'c')]] },
        ],
        indexed: 100,
      });
    });

    const found = async (path: string) => {
      const output = (await searchCode.run({ query: 'q', path }, context)) as string;
      return output.split('\n').filter((row) => !/^ {2}\d+:/.test(row) && row);
    };

    it('keeps only what a directory covers', async () => {
      await expect(found('src/search')).resolves.toEqual(['src/search/index.ts']);
    });

    it('keeps only what a glob matches, at any depth when it has no slash', async () => {
      await expect(found('*.test.ts')).resolves.toEqual(['tests/search/index.test.ts']);
      await expect(found('src/**/index.ts')).resolves.toEqual(['src/search/index.ts', 'src/llm/index.ts']);
    });

    it('gives the embeddings the path to narrow by, rather than asking for more to make up for it', async () => {
      await searchCode.run({ query: 'q', path: 'src', max_results: 10 }, context);
      const asked = embeddings.search.mock.calls[0][2];
      // Asked for exactly what was wanted: the files the path rules out are
      // left out before any of them is read from the container
      expect(asked).toMatchObject({ limit: 10, path: ['src'] });
      expect(asked.keep('src/a.ts')).toBe(true);
      expect(asked.keep('tests/a.ts')).toBe(false);
      // ...and still returns no more than was asked for
      embeddings.search.mockResolvedValue({ files: [many2('src/a.ts', 30)], indexed: 100 });
      const output = (await searchCode.run({ query: 'q', path: 'src', max_results: 3 }, context)) as string;
      expect(output.split('\n').filter((row) => /^ {2}\d+:/.test(row))).toHaveLength(3);
    });

    it('rejects a path that is not a string', async () => {
      await expect(searchCode.run({ query: 'q', path: 7 }, context)).rejects.toThrow(
        '"path" must be a path, a glob, or a list of them.'
      );
    });
  });

  it('says when nothing matched', async () => {
    await expect(searchCode.run({ query: 'q' }, context)).resolves.toBe('No matches.');
  });

  it('warns that results may be incomplete while the workspace is still being indexed', async () => {
    embeddings.search.mockResolvedValue({ files: [], indexed: 41.6 });
    const output = await searchCode.run({ query: 'q' }, context);
    expect(output).toMatch(/^No matches yet\./);
    expect(output).toContain('still being indexed (about 42% done)');
  });

  it('truncates very long results', async () => {
    embeddings.search.mockResolvedValue({
      files: [{ path: 'big.ts', blocks: [[line(1, 'x'.repeat(30000))]] }],
      indexed: 100,
    });
    const output = (await searchCode.run({ query: 'q' }, context)) as string;
    expect(output.length).toBeLessThan(21000);
    expect(output).toMatch(/\[results truncated\]$/);
  });

  it.each([{}, { query: '' }, { query: '   ' }, { query: 7 }])('rejects the input %j', async (input) => {
    await expect(searchCode.run(input, context)).rejects.toThrow('"query" must be a non-empty string.');
  });

  it('refuses in a thread without a workspace', async () => {
    await expect(searchCode.run({ query: 'q' }, { signal, threadId: THREAD })).rejects.toThrow(
      'This thread has no workspace to search.'
    );
    expect(embeddings.search).not.toHaveBeenCalled();
  });
});

describe('when the search by meaning does not answer', () => {
  // A failure is remembered per workspace, so each test has a workspace of its own
  let workspaces = 0;
  let context: { signal: AbortSignal; threadId: string; workspace: string };

  beforeEach(() => {
    context = { signal, threadId: THREAD, workspace: `/projects/demo-${++workspaces}` };
    embeddings.search.mockRejectedValue(new Error(NOT_INSTALLED));
  });

  it('falls back on plain keyword matches, and says that is what they are', async () => {
    ripgrep.keywordSearch.mockResolvedValue({
      files: [{ path: 'src/settings.ts', blocks: [[line(12, 'export function load() {')]] }],
      indexed: 100,
    });
    const output = await searchCode.run({ query: 'settings load', max_results: 5 }, context);
    expect(ripgrep.keywordSearch).toHaveBeenCalledWith(
      context.workspace,
      'settings load',
      { limit: 5, maxPerFile: 11, context: 1, pathsOnly: false, path: undefined, ignoreCase: false, thread: THREAD },
      signal
    );
    // What it says: that the answer is keyword matches, and which words they are
    expect(unwrapped(output as string)).toContain(`the search by meaning did not answer (${NOT_INSTALLED})`);
    expect(unwrapped(output as string)).toContain('plain keyword matches for: settings, load.');
    // ...followed by the matches themselves
    expect(output).toContain('src/settings.ts\n  12: export function load() {');
  });

  it('asks the search by meaning again on the very next search, rather than writing the workspace off', async () => {
    const inWorkspace = { ...context, workspace: '/projects/slow' };
    ripgrep.keywordSearch.mockResolvedValue({ files: [], indexed: 100 });
    await searchCode.run({ query: 'q' }, inWorkspace);
    await searchCode.run({ query: 'q' }, inWorkspace);
    await searchCode.run({ query: 'q' }, inWorkspace);
    // Each search tries it: what stopped it answering was most likely Ollama,
    // and Ollama comes back
    expect(embeddings.search).toHaveBeenCalledTimes(3);
    expect(ripgrep.keywordSearch).toHaveBeenCalledTimes(3);
  });

  it('goes back to the search by meaning as soon as it answers again', async () => {
    const inWorkspace = { ...context, workspace: '/projects/flaky' };
    ripgrep.keywordSearch.mockResolvedValue({ files: [], indexed: 100 });
    await searchCode.run({ query: 'q' }, inWorkspace);
    embeddings.search.mockResolvedValue({
      files: [{ path: 'src/a.ts', blocks: [[line(1, 'found it')]] }],
      indexed: 100,
    });
    const output = await searchCode.run({ query: 'q' }, inWorkspace);
    expect(output).toBe('src/a.ts\n  1: found it');
    expect(output).not.toContain('keyword matches');
  });

  it("reports the search's own failure when keyword matches can't be had either", async () => {
    ripgrep.keywordSearch.mockRejectedValue(new Error('ripgrep (rg) is not installed.'));
    await expect(searchCode.run({ query: 'q' }, context)).rejects.toThrow('is not installed');
  });

  it('does not fall back for a search the user cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchCode.run({ query: 'q' }, { ...context, signal: controller.signal })).rejects.toThrow(
      'is not installed'
    );
    expect(ripgrep.keywordSearch).not.toHaveBeenCalled();
  });
});
