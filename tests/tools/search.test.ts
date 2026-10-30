// The search tool's own work, which is the same whichever backend answered:
// cutting a result down to what was asked for, making sense of the limits a
// model gave, and sending a search for a pattern somewhere other than the
// search by meaning.
//
// The backends themselves are tested where they live (../search/embeddings
// and ../search/ripgrep), and what the tool does with what they return is
// tested through it in ../search/index.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../src/search/results';
import type { ToolContext, Tool } from '../../src/types';

const embeddings = vi.hoisted(() => ({ search: vi.fn(), order: vi.fn() }));
vi.mock('../../src/search/embeddings', () => embeddings);
const ripgrep = vi.hoisted(() => ({
  keywordSearch: vi.fn(),
  regexSearch: vi.fn(),
  definitionSearch: vi.fn(),
  keywords: (query: string) => query.split(' '),
}));
vi.mock('../../src/search/ripgrep', () => ripgrep);
vi.mock('../../src/sandbox/docker', () => ({ WORKDIR: '/workspace' }));

import { looksLikePattern, symbolIn, tools, trim } from '../../src/tools/search';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const signal = new AbortController().signal;
const context: ToolContext = { signal, threadId: THREAD, workspace: '/projects/demo' };
const searchCode = tools.find((t) => t.name === 'search_workspace') as Tool;
// A run of consecutive lines, as a backend hands one over
const block = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ line: from + i, text: `line ${from + i}` }));
const found = (files: SearchResult['files']): SearchResult => ({ files, indexed: 100 });
// The limits trim() wants, with the ones a test isn't about left wide open
const asking = (over: Partial<Parameters<typeof trim>[1]> = {}) => ({
  limit: 100,
  maxPerFile: 100,
  context: 1,
  pathsOnly: false,
  ...over,
});
const linesOf = (result: SearchResult) => result.files.flatMap((file) => file.blocks.flat());

beforeEach(() => {
  vi.clearAllMocks();
  embeddings.search.mockReset();
  embeddings.search.mockResolvedValue(found([]));
  embeddings.order.mockReset();
  // Left in the order they came unless a test says the meaning moved them
  embeddings.order.mockImplementation((_where: unknown, _query: string, paths: string[]) => Promise.resolve(paths));
  ripgrep.keywordSearch.mockReset();
  ripgrep.regexSearch.mockReset();
  ripgrep.definitionSearch.mockReset();
  // Nothing is declared unless a test says so: a search whose query names
  // something looks that up as well (see symbolIn)
  ripgrep.definitionSearch.mockResolvedValue(found([]));
});

describe('cutting a result down to what was asked for', () => {
  it('spends the whole limit across the files, in the order they came in', () => {
    const result = trim(
      found([
        { path: 'a.ts', blocks: [block(1, 3)] },
        { path: 'b.ts', blocks: [block(10, 3)] },
      ]),
      asking({ limit: 4 })
    );
    // The likest file first, and what was left of the limit on the next one
    expect(result.files.map(({ path }) => path)).toEqual(['a.ts', 'b.ts']);
    expect(linesOf(result)).toHaveLength(4);
    expect(result.files[1].blocks.flat()).toEqual([{ line: 10, text: 'line 10' }]);
  });

  it('leaves out the files there was no limit left for, rather than showing them empty', () => {
    const result = trim(
      found([
        { path: 'a.ts', blocks: [block(1, 3)] },
        { path: 'b.ts', blocks: [block(10, 3)] },
      ]),
      asking({ limit: 3 })
    );
    expect(result.files.map(({ path }) => path)).toEqual(['a.ts']);
  });

  it('takes no more than maxPerFile from one file, so a busy file cannot fill the answer', () => {
    const result = trim(
      found([
        { path: 'a.ts', blocks: [block(1, 5)] },
        { path: 'b.ts', blocks: [block(10, 5)] },
      ]),
      asking({ maxPerFile: 2 })
    );
    expect(result.files.map((file) => file.blocks.flat().length)).toEqual([2, 2]);
  });

  it('joins runs that overlap before counting them, so a line is neither shown nor charged for twice', () => {
    // Pieces of a file overlap on purpose (see chunks.OVERLAP), so two of them
    // matching in the same place arrive as two runs with lines in common
    const result = trim(found([{ path: 'a.ts', blocks: [block(1, 3), block(3, 3)] }]), asking());
    expect(linesOf(result).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps only the files the path covers, and counts the limit over those alone', () => {
    const result = trim(
      found([
        { path: 'lib/b.ts', blocks: [block(1, 2)] },
        { path: 'src/a.ts', blocks: [block(1, 2)] },
      ]),
      asking({ path: 'src' })
    );
    expect(result.files.map(({ path }) => path)).toEqual(['src/a.ts']);
  });

  it('counts the limit as files, not lines, when only the paths were wanted', () => {
    const result = trim(
      found([
        { path: 'a.ts', blocks: [block(1, 9)] },
        { path: 'b.ts', blocks: [] },
        { path: 'c.ts', blocks: [] },
      ]),
      asking({ limit: 2, pathsOnly: true })
    );
    expect(result.files.map(({ path }) => path)).toEqual(['a.ts', 'b.ts']);
  });

  it('says how much is indexed whatever it cut, since that is why an answer may be short', () => {
    const result = trim({ files: [{ path: 'a.ts', blocks: [block(1, 9)] }], indexed: 40 }, asking({ limit: 1 }));
    expect(result.indexed).toBe(40);
  });
});

describe('the limits a model gave', () => {
  const limitFor = async (input: Record<string, unknown>) => {
    await searchCode.run({ query: 'q', ...input }, context);
    return embeddings.search.mock.calls.at(-1)![2] as { limit: number; maxPerFile: number };
  };

  it('allows what it allows, and no more', async () => {
    expect((await limitFor({ max_results: 999 })).limit).toBe(100);
    expect((await limitFor({ max_per_file: 999 })).maxPerFile).toBe(100);
  });

  it('takes a nonsense limit for a mistake, and uses the default rather than the smallest it could', async () => {
    // Not a request for one line: a model that asked for "lots" wants the
    // usual answer, not the least this tool can return
    expect((await limitFor({ max_results: 'lots' })).limit).toBe(20);
    expect((await limitFor({ max_results: 0 })).limit).toBe(20);
    expect((await limitFor({ max_results: -5 })).limit).toBe(20);
    expect((await limitFor({ max_per_file: -5 })).maxPerFile).toBe(10);
  });

  it('rounds a limit that is nearly a number to the number it is nearly', async () => {
    expect((await limitFor({ max_results: 7.4 })).limit).toBe(7);
  });
});

describe('a search for a pattern rather than for a meaning', () => {
  it('matches the pattern against the text of the files, and does not ask the embeddings at all', async () => {
    ripgrep.regexSearch.mockResolvedValue(
      found([{ path: 'src/api.ts', blocks: [[{ line: 3, text: 'await fetch(url);' }]] }])
    );
    const output = await searchCode.run({ query: 'await\\s+fetch\\(', regex: true }, context);
    expect(output).toBe('src/api.ts\n  3: await fetch(url);');
    expect(ripgrep.regexSearch).toHaveBeenCalledWith(
      '/projects/demo',
      'await\\s+fetch\\(',
      { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false, path: undefined, thread: THREAD },
      signal
    );
    expect(embeddings.search).not.toHaveBeenCalled();
  });

  it('cuts the answer to the limits the same way, whichever backend found it', async () => {
    ripgrep.regexSearch.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [block(1, 30)] }]));
    const output = (await searchCode.run({ query: 'TODO', regex: true, max_results: 2 }, context)) as string;
    expect(output.match(/^ {2}\d+: /gm)).toHaveLength(2);
  });

  it('reports a pattern ripgrep refused, rather than quietly answering by meaning instead', async () => {
    ripgrep.regexSearch.mockRejectedValue(new Error('ripgrep could not run the search: error: unclosed group'));
    // Answering a different question would be worse than failing: a model that
    // asked for a pattern has no way of telling it got matches for the words
    await expect(searchCode.run({ query: 'fetch(', regex: true }, context)).rejects.toThrow('unclosed group');
    expect(embeddings.search).not.toHaveBeenCalled();
    expect(ripgrep.keywordSearch).not.toHaveBeenCalled();
  });

  it('searches by meaning when the pattern flag is not set, and does not reach for ripgrep', async () => {
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 1, text: 'found it' }]] }]));
    await searchCode.run({ query: 'where is fetching done' }, context);
    expect(ripgrep.regexSearch).not.toHaveBeenCalled();
    expect(embeddings.search).toHaveBeenCalled();
  });

  it('still wants a query, pattern or no pattern', async () => {
    await expect(searchCode.run({ query: '  ', regex: true }, context)).rejects.toThrow('non-empty string');
    expect(ripgrep.regexSearch).not.toHaveBeenCalled();
  });
});

describe('pieces that matched and could not be read', () => {
  // The search by meaning finds a piece and then goes for its lines, so it
  // can have found something and have nothing to show. Saying "No matches."
  // for that sends the model off to look elsewhere for what was found here.
  it('says what became of them instead of answering that there were no matches', async () => {
    embeddings.search.mockResolvedValue({ files: [], indexed: 100, unread: 3 });
    const output = String(await searchCode.run({ query: 'alpha' }, context));
    expect(output).not.toBe('No matches.');
    expect(output).toContain('3 pieces of code matched');
    expect(output).toContain('could not be read');
    // What to do about it, since searching again for the same thing is not it
    expect(output).toContain('Read the files you expected this to be in');
  });

  it('says it of one piece in the singular, the number being the point', async () => {
    embeddings.search.mockResolvedValue({ files: [], indexed: 100, unread: 1 });
    const output = String(await searchCode.run({ query: 'alpha' }, context));
    expect(output).toContain('1 piece of code matched');
    expect(output).toContain('its lines');
  });

  it('notes the ones it could not read under the ones it could', async () => {
    embeddings.search.mockResolvedValue({
      files: [{ path: 'a.ts', blocks: [block(1, 2)] }],
      indexed: 100,
      unread: 2,
    });
    const output = String(await searchCode.run({ query: 'alpha' }, context));
    // The matches are the answer; what is missing is said under them, so it
    // is not taken for all there was
    expect(output).toContain('a.ts');
    expect(output).toContain('2 further pieces of code matched');
  });

  it('still says there were no matches when there were none', async () => {
    embeddings.search.mockResolvedValue({ files: [], indexed: 100, unread: 0 });
    await expect(searchCode.run({ query: 'alpha' }, context)).resolves.toBe('No matches.');
  });
});

describe('reading a query that is a pattern', () => {
  it('knows one from a question', () => {
    // The ones a model wrote in the reply this was taken from
    expect(looksLikePattern('^type Thread = |interface Thread$')).toBe(true);
    expect(looksLikePattern('export.*Thread = |interface Thread')).toBe(true);
    expect(looksLikePattern('await\\s+fetch\\(')).toBe(true);
    expect(looksLikePattern('TODO|FIXME')).toBe(true);
    expect(looksLikePattern('[A-Z]\\w+Error')).toBe(true);
    expect(looksLikePattern('handle(Request|Response)')).toBe(true);
    expect(looksLikePattern('a{2,3}')).toBe(true);
  });

  it('leaves a question alone, however it is punctuated', () => {
    expect(looksLikePattern('where are API keys stored')).toBe(false);
    expect(looksLikePattern('how does main.ts work?')).toBe(false);
    expect(looksLikePattern('the *fast* path, e.g. a cached thread')).toBe(false);
    expect(looksLikePattern('thread list sidebar display filtering workspace')).toBe(false);
  });

  it('matches it as a pattern without being told to, and says that is what it did', async () => {
    ripgrep.regexSearch.mockResolvedValue(
      found([{ path: 'src/renderer.ts', blocks: [[{ line: 134, text: 'interface Thread {' }]] }])
    );
    const output = String(await searchCode.run({ query: '^interface Thread' }, context));
    expect(output).toContain('reads as a regular expression');
    expect(output).toContain('134: interface Thread {');
    // A model that cannot tell which search answered cannot steer the next one
    expect(output).toContain('regex: false');
    expect(embeddings.search).not.toHaveBeenCalled();
  });

  it('answers by meaning when the pattern matches nothing, rather than saying nothing matched', async () => {
    ripgrep.regexSearch.mockResolvedValue(found([]));
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 1, text: 'close enough' }]] }]));
    const output = String(await searchCode.run({ query: 'archive|archived$' }, context));
    expect(output).toContain('nothing in the files matches it as one');
    expect(output).toContain('1: close enough');
  });

  it('answers by meaning when the pattern will not run, and says why', async () => {
    ripgrep.regexSearch.mockRejectedValue(new Error('ripgrep could not run the search: unclosed group'));
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 1, text: 'close enough' }]] }]));
    const output = String(await searchCode.run({ query: 'fetch\\(|get\\(' }, context));
    expect(output).toContain('unclosed group');
    expect(output).toContain('1: close enough');
  });

  it('insists on meaning when regex is false, pattern or no pattern', async () => {
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 1, text: 'by meaning' }]] }]));
    const output = String(await searchCode.run({ query: 'TODO|FIXME', regex: false }, context));
    expect(ripgrep.regexSearch).not.toHaveBeenCalled();
    expect(output).toBe('src/a.ts\n  1: by meaning');
  });
});

describe('where something is defined', () => {
  const declared = found([{ path: 'src/renderer.ts', blocks: [[{ line: 134, text: 'interface Thread {' }]] }]);

  it('takes the name out of a query that is asking for one', () => {
    // Every one of these was asked in the reply this was written for, and the
    // answer wanted was the same each time
    expect(symbolIn('Thread type definition interface class')).toBe('Thread');
    expect(symbolIn('Thread interface type id workspace name messages')).toBe('Thread');
    expect(symbolIn('type Thread interface state threads')).toBe('Thread');
    expect(symbolIn('where is renderThreadList defined')).toBe('renderThreadList');
    expect(symbolIn('Thread')).toBe('Thread');
  });

  it('takes no name out of a question about what the code does', () => {
    expect(symbolIn('where are API keys stored')).toBeUndefined();
    expect(symbolIn('thread list sidebar display filtering workspace')).toBeUndefined();
    expect(symbolIn('how the sidebar draws its groups')).toBeUndefined();
    // Too short to be worth looking for, as a keyword would be
    expect(symbolIn('q')).toBeUndefined();
  });

  it('lists the declarations above the matches by meaning, unasked', async () => {
    ripgrep.definitionSearch.mockResolvedValue(declared);
    embeddings.search.mockResolvedValue(found([{ path: 'src/types.ts', blocks: [[{ line: 754, text: 'about it' }]] }]));
    const output = String(await searchCode.run({ query: 'interface Thread' }, context));
    expect(output).toContain('declare `Thread`');
    expect(output.indexOf('134: interface Thread {')).toBeLessThan(output.indexOf('754: about it'));
    expect(output).toContain('by meaning');
    expect(ripgrep.definitionSearch).toHaveBeenCalledWith(
      '/projects/demo',
      'Thread',
      expect.objectContaining({ limit: 8, maxPerFile: 8, thread: THREAD }),
      signal
    );
  });

  it('answers with the declarations alone when they are what was asked for', async () => {
    ripgrep.definitionSearch.mockResolvedValue(declared);
    const output = String(await searchCode.run({ query: 'Thread', definition: true }, context));
    expect(output).toContain('134: interface Thread {');
    expect(embeddings.search).not.toHaveBeenCalled();
    // What was asked for, so it gets the limits that were asked for
    expect(ripgrep.definitionSearch).toHaveBeenCalledWith(
      '/projects/demo',
      'Thread',
      expect.objectContaining({ limit: 20, maxPerFile: 10 }),
      signal
    );
  });

  it('says nothing declares the name, then answers by meaning rather than leaving it there', async () => {
    ripgrep.definitionSearch.mockResolvedValue(found([]));
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 9, text: 'uses it' }]] }]));
    const output = String(await searchCode.run({ query: 'Archived', definition: true }, context));
    expect(output).toContain('nothing in the files declares `Archived`');
    expect(output).toContain('9: uses it');
  });

  it('says which name to pass when the query names no one thing', async () => {
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 9, text: 'uses it' }]] }]));
    const output = String(await searchCode.run({ query: 'threads archiving sidebar', definition: true }, context));
    expect(output).toContain('does not name one thing');
    expect(ripgrep.definitionSearch).not.toHaveBeenCalled();
    expect(output).toContain('9: uses it');
  });

  it('is not the search that fails when the definition search does', async () => {
    ripgrep.definitionSearch.mockRejectedValue(new Error('ripgrep (rg) is not installed.'));
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 9, text: 'by meaning' }]] }]));
    const output = String(await searchCode.run({ query: 'interface Thread' }, context));
    expect(output).toBe('src/a.ts\n  9: by meaning');
  });
});

describe("what a pattern's own words are worth", () => {
  // The real keywords() here, since what these are about is the words a
  // pattern comes down to: the stub above splits on spaces, and a pattern
  // has none of those
  beforeEach(async () => {
    const real = await vi.importActual<typeof import('../../src/search/ripgrep')>('../../src/search/ripgrep');
    ripgrep.keywords = real.keywords;
  });
  afterEach(() => {
    ripgrep.keywords = (query: string) => query.split(' ');
  });

  const three = found([
    { path: 'src/a.ts', blocks: [[{ line: 1, text: 'interface Thread {' }]] },
    { path: 'src/b.ts', blocks: [[{ line: 2, text: 'interface Thread {' }]] },
    { path: 'src/c.ts', blocks: [[{ line: 3, text: 'interface Thread {' }]] },
  ]);

  it('orders the files it matched by what the words in it mean, and says it did', async () => {
    ripgrep.regexSearch.mockResolvedValue(three);
    embeddings.order.mockResolvedValue(['src/c.ts', 'src/a.ts', 'src/b.ts']);
    const output = String(await searchCode.run({ query: '^interface Thread|^type Thread' }, context));
    // The lines are the pattern's own; only the order comes from the meaning
    expect(output.match(/src\/\w\.ts/g)).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(output).toContain('the order the words in it mean');
    // The words, not the pattern: its punctuation is not what it was asking
    expect(embeddings.order).toHaveBeenCalledWith(
      { workspace: '/projects/demo', thread: THREAD },
      'interface thread type',
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      signal
    );
  });

  it('keeps the order ripgrep gave when the meaning cannot be had', async () => {
    ripgrep.regexSearch.mockResolvedValue(three);
    embeddings.order.mockRejectedValue(new Error('no ollama'));
    const output = String(await searchCode.run({ query: '^interface Thread|^type Thread' }, context));
    expect(output.match(/src\/\w\.ts/g)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(output).not.toContain('the order the words in it mean');
  });

  it('does not ask about an order when only one file matched', async () => {
    ripgrep.regexSearch.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [block(1, 2)] }]));
    await searchCode.run({ query: '^interface Thread' }, context);
    expect(embeddings.order).not.toHaveBeenCalled();
  });

  it('searches by meaning for the words in the pattern, not for the pattern', async () => {
    ripgrep.regexSearch.mockResolvedValue(found([]));
    embeddings.search.mockResolvedValue(found([{ path: 'src/a.ts', blocks: [[{ line: 1, text: 'close' }]] }]));
    const output = String(await searchCode.run({ query: '^export .*Thread = |interface Thread$' }, context));
    expect(embeddings.search.mock.calls.at(-1)![1]).toBe('export thread interface');
    expect(output).toContain('for the words in it');
    expect(output).toContain('1: close');
  });

  it('stops where a pattern has no words in it, rather than embedding its punctuation', async () => {
    ripgrep.regexSearch.mockResolvedValue(found([]));
    const output = String(await searchCode.run({ query: '\\d+|\\s{2,}' }, context));
    expect(output).toContain('no words');
    expect(embeddings.search).not.toHaveBeenCalled();
  });
});
