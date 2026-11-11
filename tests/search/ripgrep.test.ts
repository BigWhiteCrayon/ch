import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for child_process.spawn: ripgrep is not really run
const proc = vi.hoisted(() => ({
  ran: [] as { command: string; args: string[]; options: any }[],
  // What ripgrep prints, or the error that stops it from starting
  output: '',
  // What it writes to stderr, which is why it refused a pattern
  failed: '',
  // The code it exits with, when the test wants one it wouldn't get otherwise
  code: null as number | null,
  error: null as Error | null,
}));

// Given a single file to search and not asked for the path, ripgrep leaves it
// off every row the way grep does, so the fake one does too: proc.output is
// written as the rows ripgrep would print with the path, and the path is
// taken off again when the arguments say it would not have printed one. Only
// the single-file case is stood in for — a directory with no --with-filename
// would still be prefixed by the real thing, and nothing here searches one
// without the flag.
function asRipgrepPrints(output: string, args: string[]): string {
  const target = args.at(-1);
  if (args.includes('--with-filename') || args.includes('--files-with-matches') || target === '.') return output;
  return output.replace(/^[^\n]*?(?=[:-]\d+[:-])/gm, '');
}

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options: any) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    proc.ran.push({ command, args, options });
    Promise.resolve().then(() => {
      if (proc.error) return child.emit('error', proc.error);
      child.stdout.emit('data', Buffer.from(asRipgrepPrints(proc.output, args)));
      if (proc.failed) child.stderr.emit('data', Buffer.from(proc.failed));
      // Nothing matched is 1, which is not a failure
      child.emit('close', proc.code ?? (proc.output ? 0 : 1));
    });
    return child;
  },
}));

// The thread's container, which is searched instead when there is one. Only
// running the command is stood in for; quoting it is the real thing.
const container = vi.hoisted(() => ({
  ran: [] as string[],
  // What ripgrep wrote inside the container and what it exited with, or null
  // when the thread hasn't got one
  result: null as { code: number | null; data: Buffer } | null,
}));

vi.mock('../../src/sandbox/docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/sandbox/docker')>()),
  read: (_thread: string, command: string) => {
    container.ran.push(command);
    return Promise.resolve(container.result);
  },
}));

import { definitionPattern, definitionSearch, keywordSearch, keywords, regexSearch } from '../../src/search/ripgrep';

const signal = new AbortController().signal;
const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const limits = { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false };

beforeEach(() => {
  proc.ran = [];
  proc.output = '';
  proc.failed = '';
  proc.code = null;
  proc.error = null;
  container.ran = [];
  container.result = null;
});

describe('keywords', () => {
  it('takes the words worth looking for out of a question', () => {
    expect(keywords('Where are the API keys stored?')).toEqual(['api', 'keys', 'stored']);
    expect(keywords('how is it to be')).toEqual([]);
    expect(keywords('load_settings load_settings v2')).toEqual(['load_settings']);
  });
});

describe('keywordSearch', () => {
  it("looks for any of the query's keywords in the workspace, and returns the lines by file", async () => {
    proc.output =
      './src/settings.ts:12:  const apiKey = load();\n' +
      './src/settings.ts:40:save(apiKey)\n' +
      'README.md:3:API keys are stored encrypted.\n';
    const result = await keywordSearch(
      '/projects/demo',
      'where are API keys stored',
      { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false },
      signal
    );
    expect(result).toEqual({
      files: [
        {
          path: 'src/settings.ts',
          blocks: [[{ line: 12, text: 'const apiKey = load();' }], [{ line: 40, text: 'save(apiKey)' }]],
        },
        { path: 'README.md', blocks: [[{ line: 3, text: 'API keys are stored encrypted.' }]] },
      ],
      indexed: 100,
    });
    const [{ command, args, options }] = proc.ran;
    expect(command).toBe('rg');
    expect(args).toEqual(
      expect.arrayContaining(['--ignore-case', '--line-number', '--regexp', 'api|keys|stored', '.'])
    );
    expect(options.cwd).toBe('/projects/demo');
  });

  it('tells ripgrep how much of one file to read, and leaves the rest of the limits to its caller', async () => {
    proc.output = Array.from({ length: 30 }, (_, i) => `a.ts:${i + 1}:match`).join('\n');
    const { files } = await keywordSearch(
      '/projects/demo',
      'match',
      { limit: 4, maxPerFile: 6, context: 1, pathsOnly: false },
      signal
    );
    expect(proc.ran[0].args).toEqual(expect.arrayContaining(['--max-count', '6']));
    // Cutting the results to the limits is the search tool's job, so that both
    // backends are cut the same way (see search/index.ts)
    expect(files[0].blocks.flat()).toHaveLength(30);
  });

  it('asks for context lines, and keeps a run of them together as one block', async () => {
    // How ripgrep reports context: "-" for the lines around a match, ":" for it
    proc.output = 'a.ts-11-before\na.ts:12:match\na.ts-13-after\na.ts:40:far away\n';
    const { files } = await keywordSearch(
      '/projects/demo',
      'match',
      { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false },
      signal
    );
    expect(proc.ran[0].args).toEqual(expect.arrayContaining(['--context', '1']));
    expect(files[0].blocks).toEqual([
      [
        { line: 11, text: 'before' },
        { line: 12, text: 'match' },
        { line: 13, text: 'after' },
      ],
      [{ line: 40, text: 'far away' }],
    ]);
  });

  it('asks for no context when none was wanted', async () => {
    await keywordSearch('/projects/demo', 'match', { limit: 20, maxPerFile: 10, context: 0, pathsOnly: false }, signal);
    expect(proc.ran[0].args).not.toContain('--context');
  });

  it('lists the files alone when only the paths are wanted, reading no further into them', async () => {
    proc.output = './src/settings.ts\nREADME.md\n./src/settings.ts\n';
    const found = await keywordSearch(
      '/projects/demo',
      'match',
      { limit: 20, maxPerFile: 10, context: 2, pathsOnly: true },
      signal
    );
    expect(found.files).toEqual([
      { path: 'src/settings.ts', blocks: [] },
      { path: 'README.md', blocks: [] },
    ]);
    expect(proc.ran[0].args).toEqual(expect.arrayContaining(['--files-with-matches']));
    // Nothing about lines or context, which it isn't returning
    for (const flag of ['--line-number', '--context', '--max-count']) expect(proc.ran[0].args).not.toContain(flag);
  });

  describe('searching only part of the workspace', () => {
    const globsIn = (args: string[]) => args.filter((_arg, at) => args[at - 1] === '--glob');
    const argsFor = async (path: string) => {
      await keywordSearch(
        '/projects/demo',
        'match',
        { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false, path },
        signal
      );
      return proc.ran.at(-1)!.args as string[];
    };

    it('searches a plain path by giving it to ripgrep as the place to look', async () => {
      const args = await argsFor('src/search');
      expect(args.at(-1)).toBe('src/search');
      // Not as a filter. The one filter here is the standing exclusion that
      // keeps every search out of node_modules (see argsFor)
      expect(globsIn(args)).toEqual(['!node_modules']);
    });

    it('passes a glob to ripgrep as a filter, still searching from the top', async () => {
      const args = await argsFor('src/**/*.test.ts');
      expect(args).toEqual(expect.arrayContaining(['--glob', 'src/**/*.test.ts']));
      expect(args.at(-1)).toBe('.');
    });

    // The copy this searches is filled from `git ls-files` and has no .git in
    // it, and ripgrep reads a .gitignore only from inside a repository: left
    // to itself it walked the node_modules the project's own install had put
    // in the container, and answered "where is Message declared" out of
    // postcss. The embeddings never had this, so the wrong answers all came
    // from the searches that land here.
    it("reads the project's own .gitignore although the copy it searches is no repository", async () => {
      expect(await argsFor('src')).toContain('--no-require-git');
    });

    it('keeps a search out of node_modules even where there is no .gitignore to say so', async () => {
      expect(globsIn(await argsFor('src'))).toContain('!node_modules');
    });

    it('searches node_modules when it is pointed there on purpose, rather than answering nothing', async () => {
      const args = await argsFor('node_modules/postcss');
      expect(globsIn(args)).not.toContain('!node_modules');
      expect(args.at(-1)).toBe('node_modules/postcss');
    });

    // Given one file rather than a directory, ripgrep leaves the path off its
    // matches unless it is asked for it, and parse() reads every row by that
    // path: without the flag a search narrowed to one file threw away every
    // line it found and answered that nothing matched.
    it('asks ripgrep for the path of each match, even when the place to search is one file', async () => {
      const args = await argsFor('src/renderer.ts');
      expect(args.at(-1)).toBe('src/renderer.ts');
      expect(args).toContain('--with-filename');
    });

    const argsForMany = async (path: string[], exclude?: string[]) => {
      await keywordSearch(
        '/projects/demo',
        'match',
        { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false, path, exclude },
        signal
      );
      return proc.ran.at(-1)!.args as string[];
    };

    it('gives ripgrep several plain paths as the places to look, one after another', async () => {
      const args = await argsForMany(['src/main.ts', 'src/preload.ts']);
      expect(args.slice(-2)).toEqual(['src/main.ts', 'src/preload.ts']);
      expect(globsIn(args)).toEqual(['!node_modules']);
    });

    // ripgrep searches a path it was handed outright whatever the filters
    // say, so a list with a glob in it goes in as filters alone
    it('turns a list with a glob in it into filters over the whole workspace', async () => {
      const args = await argsForMany(['src/main.ts', 'tests/**/*.test.ts']);
      expect(args.at(-1)).toBe('.');
      expect(globsIn(args)).toEqual(expect.arrayContaining(['src/main.ts', 'src/main.ts/**', 'tests/**/*.test.ts']));
    });

    it('leaves out what it was told to, wherever it was told to look', async () => {
      const args = await argsForMany(['src'], ['src/llm/providers', '**/*.test.ts']);
      expect(globsIn(args)).toEqual(expect.arrayContaining(['!src/llm/providers', '!**/*.test.ts']));
      expect(args.at(-1)).toBe('src');
    });
  });

  it('reads the lines of a search narrowed to a single file, which ripgrep prints without the path', async () => {
    proc.output = 'src/renderer.ts:74:  usage?: ModelUsage[];\nsrc/renderer.ts:151:  usage?: Record<string, N>;\n';
    const result = await keywordSearch(
      '/projects/demo',
      'usage',
      { limit: 20, maxPerFile: 10, context: 0, pathsOnly: false, path: 'src/renderer.ts' },
      signal
    );
    expect(result.files).toEqual([
      {
        path: 'src/renderer.ts',
        blocks: [[{ line: 74, text: 'usage?: ModelUsage[];' }], [{ line: 151, text: 'usage?: Record<string, N>;' }]],
      },
    ]);
  });

  it('finds nothing, without running anything, when the query has no keywords', async () => {
    await expect(
      keywordSearch('/projects/demo', 'how is it', { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false }, signal)
    ).resolves.toEqual({ files: [], indexed: 100 });
    expect(proc.ran).toEqual([]);
  });

  it('finds nothing when ripgrep matches nothing', async () => {
    await expect(
      keywordSearch('/projects/demo', 'zebra', { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false }, signal)
    ).resolves.toEqual({ files: [], indexed: 100 });
  });

  it('says so when ripgrep is not installed', async () => {
    proc.error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' });
    await expect(
      keywordSearch('/projects/demo', 'zebra', { limit: 20, maxPerFile: 10, context: 1, pathsOnly: false }, signal)
    ).rejects.toThrow('ripgrep (rg) is not installed.');
  });
});

describe('regexSearch', () => {
  it('gives ripgrep the pattern as it was written, and matches the case it was written in', async () => {
    proc.output = 'src/api.ts:3:  await fetch(url);\n';
    const result = await regexSearch('/projects/demo', 'await\\s+fetch\\(', limits, signal);
    expect(result).toEqual({
      files: [{ path: 'src/api.ts', blocks: [[{ line: 3, text: 'await fetch(url);' }]] }],
      indexed: 100,
    });
    const { args } = proc.ran[0];
    // Nothing is taken out of it: the keywords() a question goes through would
    // have left "await" and "fetch" and thrown the pattern itself away
    expect(args).toEqual(expect.arrayContaining(['--regexp', 'await\\s+fetch\\(']));
    // Someone who writes "[A-Z]" means the capital letters
    expect(args).not.toContain('--ignore-case');
  });

  it('matches whatever the case where it is asked to, as grep -i does', async () => {
    await regexSearch('/projects/demo', 'always allow', { ...limits, ignoreCase: true }, signal);
    expect(proc.ran[0].args).toContain('--ignore-case');
  });

  it('never ignores the case of a definition, whatever the search was asked', async () => {
    await definitionSearch('/projects/demo', 'Thread', { ...limits, ignoreCase: true }, signal);
    expect(proc.ran[0].args).not.toContain('--ignore-case');
  });

  it('finds the lines of a pattern narrowed to a single file, rather than answering that nothing matched', async () => {
    proc.output = 'src/harness/index.ts:412:  const compacted = await compact(thread);\n';
    const result = await regexSearch(
      '/projects/demo',
      'condensing|compact\\(',
      { ...limits, context: 0, path: 'src/harness/index.ts' },
      signal
    );
    expect(result.files).toEqual([
      { path: 'src/harness/index.ts', blocks: [[{ line: 412, text: 'const compacted = await compact(thread);' }]] },
    ]);
    // The path is asked for, because ripgrep given one file does not print it
    expect(proc.ran[0].args).toContain('--with-filename');
  });

  it('says why when ripgrep refuses the pattern, rather than answering that nothing matched', async () => {
    proc.code = 2;
    proc.failed = 'regex parse error:\n    fetch(\n         ^\nerror: unclosed group';
    await expect(regexSearch('/projects/demo', 'fetch(', limits, signal)).rejects.toThrow('unclosed group');
  });

  it('finds nothing, and does not fail, when the pattern is good and simply matches nothing', async () => {
    proc.code = 1;
    await expect(regexSearch('/projects/demo', 'zebra', limits, signal)).resolves.toEqual({
      files: [],
      indexed: 100,
    });
  });

  it("searches the thread's own copy of the files, so what it has written is found", async () => {
    container.result = { code: 0, data: Buffer.from('src/new.ts:1:written in the container\n') };
    const result = await regexSearch('/projects/demo', 'written', { ...limits, thread: THREAD }, signal);
    expect(result.files).toEqual([{ path: 'src/new.ts', blocks: [[{ line: 1, text: 'written in the container' }]] }]);
    expect(container.ran[0]).toContain('--regexp');
    expect(container.ran[0]).toContain('written');
    // The user's own copy was not searched at all
    expect(proc.ran).toEqual([]);
  });

  it('passes a refusal from inside the container back as the reason, as it does on the host', async () => {
    container.result = { code: 2, data: Buffer.from('error: unclosed group') };
    await expect(regexSearch('/projects/demo', 'fetch(', { ...limits, thread: THREAD }, signal)).rejects.toThrow(
      'unclosed group'
    );
  });

  it("falls back on the user's copy when the thread hasn't got a container", async () => {
    container.result = null;
    proc.output = 'src/api.ts:3:on the host\n';
    const result = await regexSearch('/projects/demo', 'host', { ...limits, thread: THREAD }, signal);
    expect(proc.ran).toHaveLength(1);
    expect(result.files[0].blocks[0][0].text).toBe('on the host');
  });

  it("falls back on the user's copy when the container is older than ripgrep being put in the image", async () => {
    container.result = { code: 127, data: Buffer.from('bash: rg: command not found\n') };
    proc.output = 'src/api.ts:3:on the host\n';
    const result = await regexSearch('/projects/demo', 'host', { ...limits, thread: THREAD }, signal);
    // A slightly stale answer beats telling the model its pattern was refused
    expect(proc.ran).toHaveLength(1);
    expect(result.files[0].blocks[0][0].text).toBe('on the host');
  });
});

describe('which copy of the files the keyword fallback reads', () => {
  it("searches the thread's copy too, so both backends answer from the same files", async () => {
    container.result = { code: 0, data: Buffer.from('src/new.ts:1:api keys\n') };
    const result = await keywordSearch('/projects/demo', 'where are API keys', { ...limits, thread: THREAD }, signal);
    expect(result.files).toEqual([{ path: 'src/new.ts', blocks: [[{ line: 1, text: 'api keys' }]] }]);
    expect(container.ran[0]).toContain('api|keys');
    expect(proc.ran).toEqual([]);
  });
});

describe('definitionSearch', () => {
  // The pattern is given to ripgrep, whose syntax is Rust's, and nothing in
  // it uses what the two matchers disagree about — so JavaScript's own stands
  // in here for asking ripgrep what the pattern would find
  const matches = (name: string, line: string) => new RegExp(definitionPattern(name), 'm').test(line);

  it('matches the ways a thing is declared', () => {
    expect(matches('Thread', 'interface Thread {')).toBe(true);
    expect(matches('Thread', 'export interface Thread {')).toBe(true);
    expect(matches('Thread', 'export type Thread = {')).toBe(true);
    expect(matches('pick', 'export function pick(hit: Hit, query: string): Line[] {')).toBe(true);
    expect(matches('MAX_OUTPUT', 'const MAX_OUTPUT = 20000; // characters of results kept')).toBe(true);
    expect(matches('isGlob', 'const isGlob = (pattern: string) => /[*?[\\]{}]/.test(pattern);')).toBe(true);
    expect(matches('run', '  async run(input, { signal, threadId }: ToolContext) {')).toBe(true);
    expect(matches('parse', 'def parse(self, text):')).toBe(true);
    expect(matches('Name', 'func (t *Thread) Name() string {')).toBe(true);
  });

  // The whole point of it: a declaration rather than the forty lines that use
  // the name, which is what a search for the words around it comes back with
  it('does not match where the name is only used', () => {
    expect(matches('pick', '  const lines = pick(hit, query, context);')).toBe(false);
    expect(matches('render', 'render();')).toBe(false);
    expect(matches('Thread', '  threads: Thread[];')).toBe(false);
    expect(matches('save', '  save({ threads: state.threads });')).toBe(false);
    expect(matches('Thread', '// The sidebar: threads grouped by the workspace')).toBe(false);
  });

  it('matches the name as it was written, since Thread and thread are two things', async () => {
    proc.output = 'src/renderer.ts:134:interface Thread {\n';
    const result = await definitionSearch('/projects/demo', 'Thread', { ...limits, context: 0 }, signal);
    expect(result.files).toEqual([{ path: 'src/renderer.ts', blocks: [[{ line: 134, text: 'interface Thread {' }]] }]);
    expect(proc.ran[0].args).toEqual(expect.arrayContaining(['--regexp', definitionPattern('Thread')]));
    expect(proc.ran[0].args).not.toContain('--ignore-case');
  });

  it('holds off what is a pattern in the name itself', () => {
    expect(matches('go$', 'const go$ = 1;')).toBe(true);
    expect(matches('go$', 'const goX = 1;')).toBe(false);
  });
});
