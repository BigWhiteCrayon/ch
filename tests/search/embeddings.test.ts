import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// git is stood in for: `tracked` is what it reports the workspace holds
const proc = vi.hoisted(() => ({
  tracked: [] as string[],
  code: 0,
  error: '',
  ran: [] as string[][],
}));

vi.mock('child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    proc.ran.push(args);
    const child: any = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
    Promise.resolve().then(() => {
      if (proc.error) child.stderr.emit('data', Buffer.from(proc.error));
      else child.stdout.emit('data', Buffer.from(proc.tracked.map((f) => `${f}\0`).join('')));
      child.emit('close', proc.code);
    });
    return child;
  },
}));

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../src/log', () => log);

// What the thread has done in its container, as the record would report it
const thread = vi.hoisted(() => ({
  changed: null as { path: string; status: string; text: string | null }[] | null,
  failure: null as string | null,
  // What each file holds in the container now, for the lines a hit shows
  contents: {} as Record<string, string>,
  // Whether the thread has a container at all. Without one there is nothing
  // to read from, which is not the same as a file that could not be read
  // (see filesText in ../../src/sandbox/changes.ts).
  container: true,
  // The files of each read of the container, so that a test can see how many
  // reads a search took and which files they were for
  reads: [] as string[][],
}));
vi.mock('../../src/sandbox/changes', () => ({
  changedText: async () => {
    if (thread.failure) throw new Error(thread.failure);
    return thread.changed;
  },
  filesText: async (_threadId: string, files: string[]) => {
    thread.reads.push(files);
    if (!thread.container) return null;
    return new Map(files.map((file) => [file, thread.contents[file] ?? null]));
  },
}));

import * as embeddings from '../../src/search/embeddings';

const signal = () => new AbortController().signal;
// The words the fake model can tell apart
const MARKERS = ['alpha', 'beta', 'gamma', 'delta'];
const options = { limit: 20, context: 1, pathsOnly: false };
// What the fake Ollama answers: a vector per input, or an error
let vectors: (input: string) => number[];
let failure: { status: number; body: string } | null;
// What /api/show says the embedding model can do
let capabilities: string[];
const requests: { model: string; input: string[]; truncate?: boolean }[] = [];

let workspace: string;
let data: string;
const put = (name: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
  fs.writeFileSync(path.join(workspace, name), content);
};

beforeEach(() => {
  proc.tracked = [];
  proc.code = 0;
  proc.error = '';
  proc.ran = [];
  requests.length = 0;
  failure = null;
  capabilities = ['embedding'];
  // A vector that says which of the marker words a text holds, so that what
  // ranks where is arranged by putting those words in files
  vectors = (input) => {
    const text = input.replace(/^(search_document|search_query): /, '').replace(/^Represent this sentence.*?: /, '');
    return [...MARKERS.map((word) => (text.includes(word) ? 1 : 0)), 0.01];
  };
  thread.changed = [];
  thread.failure = null;
  thread.contents = {};
  thread.reads = [];
  thread.container = true;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-workspace-'));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-data-'));
  embeddings.configure({ dir: data, local: { baseURL: 'http://server:11434/v1', apiKey: 'k' } });

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    // What the model can do, asked before it is used to embed anything
    if (new URL(url).pathname === '/api/show') {
      return new Response(JSON.stringify({ capabilities }), { status: 200 });
    }
    const body = JSON.parse(init.body as string);
    requests.push(body);
    if (failure) return new Response(failure.body, { status: failure.status });
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({ embeddings: inputs.map(vectors) }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

describe('vectors as bytes', () => {
  const stored = (vector: number[]) => embeddings.decode(embeddings.encode(vector));
  const like = (a: number[], b: number[]) => embeddings.similarity(embeddings.unit(a), stored(b));

  it('is 1 for the same direction, 0 for a right angle, -1 for the opposite', () => {
    expect(like([1, 0], [2, 0])).toBeCloseTo(1, 2);
    expect(like([1, 0], [0, 3])).toBeCloseTo(0, 2);
    expect(like([1, 0], [-1, 0])).toBeCloseTo(-1, 2);
  });

  it('is 0 against a vector of nothing, rather than not a number', () => {
    expect(like([1, 2], [0, 0])).toBe(0);
    expect(embeddings.similarity([], stored([]))).toBe(0);
  });

  it('keeps a vector to a byte a component, and survives the round trip', () => {
    const vector = Array.from({ length: 768 }, (_, i) => Math.sin(i));
    const bytes = embeddings.encode(vector);
    // 768 bytes, base64: far smaller than the same numbers written out
    expect(Buffer.from(bytes, 'base64')).toHaveLength(768);
    expect(bytes.length).toBeLessThan(JSON.stringify(vector).length / 10);
    // ...and still says the same thing about direction
    expect(embeddings.similarity(embeddings.unit(vector), embeddings.decode(bytes))).toBeCloseTo(1, 2);
  });

  it('makes a unit vector of whatever length it is given', () => {
    const made = embeddings.unit([3, 4]);
    expect(Math.hypot(...made)).toBeCloseTo(1);
    expect(embeddings.unit([0, 0])).toEqual([0, 0]);
  });
});

describe('asking Ollama to embed', () => {
  it('asks its own API, with the key, and lets it truncate what is too long', async () => {
    await embeddings.embed(['one', 'two'], signal());
    expect(requests).toEqual([{ model: 'nomic-embed-text', input: ['one', 'two'], truncate: true }]);
    const [, init] = (globalThis.fetch as any).mock?.calls?.[0] ?? [];
    expect(init === undefined || init.headers.Authorization).toBeTruthy();
  });

  it('says what to run when the model is not installed', async () => {
    failure = {
      status: 404,
      body: JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
    };
    await expect(embeddings.embed(['one'], signal())).rejects.toThrow('ollama pull nomic-embed-text');
  });

  it('reports any other refusal as the server put it', async () => {
    failure = { status: 500, body: JSON.stringify({ error: 'out of memory' }) };
    await expect(embeddings.embed(['one'], signal())).rejects.toThrow('Ollama could not embed: out of memory');
  });

  it('refuses a model that turns out to be a text model, not an embedding one', async () => {
    capabilities = ['completion', 'tools'];
    await expect(embeddings.embed(['one'], signal(), 'llama3.2:3b')).rejects.toThrow(
      '"llama3.2:3b" is a text model, not an embedding model'
    );
    // Nothing was asked of it
    expect(requests).toEqual([]);
  });

  it('uses a model the server will not describe, rather than refusing it', async () => {
    // An older Ollama reports no capabilities for anything
    capabilities = [];
    await expect(embeddings.embed(['one'], signal(), 'mystery')).resolves.toHaveLength(1);
  });

  it('says so when it cannot reach the server at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(embeddings.embed(['one'], signal())).rejects.toThrow('No Ollama reachable at http://server:11434');
  });

  it('refuses an answer that does not match what was asked', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 }));
    await expect(embeddings.embed(['one', 'two'], signal())).rejects.toThrow('returned 1 embeddings for 2 texts');
  });

  it('asks for nothing when there is nothing to embed', async () => {
    await expect(embeddings.embed([], signal())).resolves.toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('indexing a workspace', () => {
  it('embeds the pieces of the files Git reports, and leaves the ignored ones alone', async () => {
    put('src/a.ts', 'alpha');
    put('src/b.ts', 'beta');
    proc.tracked = ['src/a.ts', 'src/b.ts'];
    await expect(embeddings.index(workspace, signal())).resolves.toEqual({
      files: 2,
      chunks: 2,
      embedded: 2,
      skipped: 0,
    });
    expect(proc.ran[0]).toEqual(['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  });

  it('puts the path in front of each piece, so a query can match on it', async () => {
    put('src/settings.ts', 'const FILE = 1;');
    proc.tracked = ['src/settings.ts'];
    await embeddings.index(workspace, signal());
    expect(requests[0].input).toEqual(['search_document: src/settings.ts\n\nconst FILE = 1;']);
  });

  it('counts a long file as the several pieces it comes to', async () => {
    // Twenty top-level functions: more than one piece's worth
    const body = Array.from({ length: 20 }, (_, i) => `function f${i}() {\n  ${'x'.repeat(120)}\n}`).join('\n');
    put('big.ts', body);
    proc.tracked = ['big.ts'];
    const result = await embeddings.index(workspace, signal());
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.embedded).toBe(result.chunks);
  });

  it('passes over what is not text, empty, or gone', async () => {
    put('good.ts', 'alpha');
    put('image.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    put('empty.ts', '   \n');
    proc.tracked = ['good.ts', 'image.png', 'empty.ts', 'missing.ts'];
    await expect(embeddings.index(workspace, signal())).resolves.toMatchObject({ files: 1, skipped: 3 });
  });

  it('embeds a file again only once it has changed, and then all of its pieces', async () => {
    put('a.ts', 'alpha');
    proc.tracked = ['a.ts'];
    await embeddings.index(workspace, signal());
    expect(requests).toHaveLength(1);

    await expect(embeddings.index(workspace, signal())).resolves.toMatchObject({ embedded: 0 });
    expect(requests).toHaveLength(1);

    put('a.ts', 'alpha, changed');
    await expect(embeddings.index(workspace, signal())).resolves.toMatchObject({ embedded: 1 });
    expect(requests).toHaveLength(2);
  });

  it('forgets a file that has gone from the workspace', async () => {
    put('a.ts', 'alpha');
    put('b.ts', 'beta');
    proc.tracked = ['a.ts', 'b.ts'];
    await embeddings.index(workspace, signal());
    fs.rmSync(path.join(workspace, 'b.ts'));
    proc.tracked = ['a.ts'];
    await embeddings.index(workspace, signal());
    const hits = await embeddings.rank({ workspace }, 'beta', 10, signal());
    expect(hits.map((h) => h.path)).toEqual(['a.ts']);
  });

  it('throws away everything embedded by another model', async () => {
    put('a.ts', 'alpha');
    proc.tracked = ['a.ts'];
    await embeddings.index(workspace, signal());
    await expect(embeddings.index(workspace, signal(), undefined, 'mxbai-embed-large')).resolves.toMatchObject({
      embedded: 1,
    });
  });

  it('embeds in batches, saying how far it has got', async () => {
    const many = Array.from({ length: 35 }, (_, i) => `f${i}.ts`);
    for (const file of many) put(file, `file ${file}`);
    proc.tracked = many;
    const progress: number[] = [];
    await embeddings.index(workspace, signal(), (done) => progress.push(done));
    expect(requests.map((r) => r.input.length)).toEqual([16, 16, 3]);
    expect(progress).toEqual([16, 32, 35]);
  });

  it('leaves no half-embedded file behind when it is cut short', async () => {
    // One file of more pieces than a batch holds, cut off after the first
    const body = Array.from({ length: 100 }, (_, i) => `function f${i}() {\n  ${'x'.repeat(400)}\n}`).join('\n');
    put('big.ts', body);
    proc.tracked = ['big.ts'];
    const controller = new AbortController();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/show') {
        return new Response(JSON.stringify({ capabilities }), { status: 200 });
      }
      const body = JSON.parse(init.body as string);
      requests.push(body);
      controller.abort();
      return new Response(JSON.stringify({ embeddings: body.input.map(vectors) }), { status: 200 });
    });
    await embeddings.index(workspace, controller.signal);
    // One batch of sixteen ran, of the many pieces the file comes to
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toHaveLength(16);
    // Nothing of it was kept, rather than the first sixteen pieces of it
    expect(await embeddings.rank({ workspace }, 'anything', 10, signal())).toEqual([]);
  });

  it('says why it could not list the workspace', async () => {
    proc.code = 128;
    proc.error = 'fatal: not a git repository';
    await expect(embeddings.index(workspace, signal())).rejects.toThrow('not a git repository');
  });
});

describe('ranking pieces against a query', () => {
  beforeEach(async () => {
    // Each file has one marker word in it, in a piece of its own
    put('one.ts', 'function first() {\n  return "alpha";\n}');
    put('two.ts', 'function second() {\n  return "beta";\n}');
    put('three.ts', 'function third() {\n  return "gamma";\n}');
    proc.tracked = ['one.ts', 'two.ts', 'three.ts'];
    await embeddings.index(workspace, signal());
    requests.length = 0;
  });

  it('puts the likest piece first, with the lines it covers and its score', async () => {
    const hits = await embeddings.rank({ workspace }, 'alpha', 10, signal());
    expect(hits[0]).toMatchObject({ path: 'one.ts', start: 1, end: 3 });
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].text).toContain('return "alpha"');
  });

  it('tells the model it is embedding a query, not a document', async () => {
    await embeddings.rank({ workspace }, 'where is alpha', 10, signal());
    expect(requests).toEqual([expect.objectContaining({ input: ['search_query: where is alpha'] })]);
  });

  it('returns no more pieces than asked for', async () => {
    expect(await embeddings.rank({ workspace }, 'alpha', 2, signal())).toHaveLength(2);
  });

  it('indexes nothing itself: it answers from what is embedded already', async () => {
    put('four.ts', 'function fourth() {\n  return "delta";\n}');
    proc.tracked = ['one.ts', 'two.ts', 'three.ts', 'four.ts'];
    const hits = await embeddings.rank({ workspace }, 'delta', 10, signal());
    // Only the query was embedded, and the new file is not there to be found
    expect(requests).toHaveLength(1);
    expect(hits.map((h) => h.path)).not.toContain('four.ts');
  });
});

describe('ordering files something else found', () => {
  beforeEach(async () => {
    // Each file has one marker word in it, so what the query means decides
    // which of them comes first
    put('one.ts', 'function first() {\n  return "alpha";\n}');
    put('two.ts', 'function second() {\n  return "beta";\n}');
    put('three.ts', 'function third() {\n  return "gamma";\n}');
    proc.tracked = ['one.ts', 'two.ts', 'three.ts'];
    await embeddings.index(workspace, signal());
    requests.length = 0;
  });

  it('puts the file the query means first, whatever order it was given them in', async () => {
    const paths = ['one.ts', 'two.ts', 'three.ts'];
    expect(await embeddings.order({ workspace }, 'gamma', paths, signal())).toEqual(['three.ts', 'one.ts', 'two.ts']);
    expect(await embeddings.order({ workspace }, 'beta', paths, signal())).toEqual(['two.ts', 'one.ts', 'three.ts']);
  });

  it("reads nothing and embeds only the query: the lines are the other search's", async () => {
    await embeddings.order({ workspace }, 'alpha', ['one.ts', 'two.ts'], signal());
    expect(requests).toHaveLength(1);
    expect(thread.reads).toEqual([]);
  });

  it('leaves a file it has nothing embedded for where it was, after the ones it has', async () => {
    const ordered = await embeddings.order({ workspace }, 'beta', ['new.ts', 'one.ts', 'two.ts'], signal());
    expect(ordered).toEqual(['two.ts', 'one.ts', 'new.ts']);
  });

  it('is nothing to do for one file, and asks the model nothing', async () => {
    expect(await embeddings.order({ workspace }, 'alpha', ['one.ts'], signal())).toEqual(['one.ts']);
    expect(requests).toEqual([]);
  });
});

describe('choosing the lines to show from a piece', () => {
  const hit = {
    path: 'a.ts',
    start: 10,
    end: 14,
    score: 1,
    text: ['function parse() {', '  const seen = new Set();', '  return seen;', '}', ''].join('\n'),
  };

  it('shows the line with most of the query words in it, and its neighbours', () => {
    expect(embeddings.pick(hit, 'where is seen set', 1)).toEqual([
      { line: 10, text: 'function parse() {' },
      { line: 11, text: '  const seen = new Set();' },
      { line: 12, text: '  return seen;' },
    ]);
  });

  it('shows the start of the piece when none of the words are in it', () => {
    const picked = embeddings.pick(hit, 'nothing whatsoever here', 1);
    expect(picked[0]).toEqual({ line: 10, text: 'function parse() {' });
  });

  it('shows the matching line alone when no context was wanted', () => {
    expect(embeddings.pick(hit, 'seen', 0)).toEqual([{ line: 11, text: '  const seen = new Set();' }]);
  });

  it('does not run off either end of the piece', () => {
    expect(embeddings.pick(hit, 'parse', 10)).toHaveLength(5);
  });

  // A piece whose file could not be read has no lines to show. It used to
  // show one blank line, which reached the model as a line number with
  // nothing against it.
  it('shows nothing for a piece whose lines could not be read', () => {
    expect(embeddings.pick({ ...hit, text: '' }, 'anything', 2)).toEqual([]);
  });

  // The first lines of a piece are often the file's header comment, which
  // says no more than the path the piece is listed under
  it('passes over comments to the first line of code when nothing matched', () => {
    const commented = { ...hit, start: 1, text: '// What this file is for\n//\nexport function go() {' };
    expect(embeddings.pick(commented, 'nothing whatsoever here', 0)).toEqual([
      { line: 3, text: 'export function go() {' },
    ]);
  });

  // The failure this weighing was written for. A comment holds more of a
  // question's words than the line it describes, so counting them answered
  // "where is the Thread type" with the sentence above it, every time.
  it('shows the declaration rather than the prose about it, where both hold the words', () => {
    const commented = {
      ...hit,
      start: 130,
      text: [
        '// The sidebar: threads grouped by the workspace they were started in',
        '',
        'interface Thread {',
        '  id: string;',
        '  // The workspace the thread was started in, if the user chose one',
        '  workspace?: string;',
        '}',
      ].join('\n'),
    };
    expect(embeddings.pick(commented, 'Thread interface workspace', 0)).toEqual([
      { line: 132, text: 'interface Thread {' },
    ]);
  });

  it('counts a word on its own for more than the same word inside another', () => {
    const uses = { ...hit, start: 1, text: '  const threadList = [];\n  const thread = one;' };
    expect(embeddings.pick(uses, 'thread', 0)).toEqual([{ line: 2, text: '  const thread = one;' }]);
  });

  // A comment at column 0 is a place a piece may end (see chunks.isBoundary)
  // but not a declaration, and the bonus for starting something must not put
  // it back ahead of the code it describes
  it('does not take a comment at the start of a line for a declaration', () => {
    const commented = { ...hit, start: 1, text: '// archived threads, and what became of them\nconst archived = [];' };
    expect(embeddings.pick(commented, 'archived', 0)).toEqual([{ line: 2, text: 'const archived = [];' }]);
  });
});

describe('search, in the shape the tool works in', () => {
  beforeEach(async () => {
    put('one.ts', 'function first() {\n  return "alpha";\n}');
    put('two.ts', 'function second() {\n  return "beta";\n}');
    proc.tracked = ['one.ts', 'two.ts'];
    await embeddings.index(workspace, signal());
  });

  it('groups the pieces by file, likest first, each with the lines worth showing', async () => {
    const result = await embeddings.search({ workspace }, 'alpha', options, signal());
    expect(result.files[0].path).toBe('one.ts');
    expect(result.files[0].blocks[0]).toEqual(expect.arrayContaining([{ line: 2, text: '  return "alpha";' }]));
    expect(result.indexed).toBe(100);
  });

  it('gives no lines at all when only the paths were wanted', async () => {
    const result = await embeddings.search({ workspace }, 'alpha', { ...options, pathsOnly: true }, signal());
    expect(result.files[0]).toEqual({ path: 'one.ts', blocks: [] });
  });
});

describe("a thread's own copy", () => {
  const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
  const mine = { workspace: '', thread: THREAD };
  const paths = async (where: { workspace: string; thread?: string }, query: string) =>
    (await embeddings.rank(where, query, 10, signal())).map((h) => h.path);

  beforeEach(async () => {
    mine.workspace = workspace;
    // The workspace is embedded once, and shared
    put('one.ts', 'function first() {\n  return "alpha";\n}');
    put('two.ts', 'function second() {\n  return "beta";\n}');
    proc.tracked = ['one.ts', 'two.ts'];
    await embeddings.index(workspace, signal());
    requests.length = 0;
  });

  it('starts as a copy of the workspace, without embedding any of it again', async () => {
    embeddings.adopt(mine);
    await expect(paths(mine, 'alpha')).resolves.toEqual(['one.ts', 'two.ts']);
    // Only the query was embedded: the files came over as they were
    expect(requests).toHaveLength(1);
  });

  it('is given the index later when the thread was opened before the workspace had one', async () => {
    // The thread's first search comes before the workspace has been indexed,
    // so there is nothing to take and an empty copy of its own is saved
    embeddings.forget({ workspace });
    embeddings.forgetThread(THREAD);
    await embeddings.update(mine, signal());
    await expect(paths(mine, 'alpha')).resolves.toEqual([]);

    // The workspace's index arrives after that
    await embeddings.index(workspace, signal());
    log.info.mockClear();
    await embeddings.update(mine, signal());

    // The thread is given it, instead of searching an empty index for as
    // long as it lives
    await expect(paths(mine, 'alpha')).resolves.toEqual(['one.ts', 'two.ts']);
    expect(log.info).toHaveBeenCalledWith('embeddings.adopt', expect.objectContaining({ backfilled: true }));
  });

  it('does not keep giving the index back to a thread that emptied its own copy', async () => {
    embeddings.adopt(mine);
    thread.changed = [
      { path: 'one.ts', status: 'deleted', text: null },
      { path: 'two.ts', status: 'deleted', text: null },
    ];
    await expect(embeddings.update(mine, signal())).resolves.toMatchObject({ dropped: 2 });
    await expect(paths(mine, 'alpha')).resolves.toEqual([]);

    // Its copy is empty, but empty because the thread emptied it: giving the
    // workspace's back would undo the thread's own work, over and over
    await expect(embeddings.update(mine, signal())).resolves.toMatchObject({ dropped: 0 });
    await expect(paths(mine, 'alpha')).resolves.toEqual([]);
  });

  describe('what it reads from the container', () => {
    beforeEach(() => {
      embeddings.adopt(mine);
      thread.contents['one.ts'] = 'function first() {\n  return "alpha";\n}';
      thread.contents['two.ts'] = 'function second() {\n  return "beta";\n}';
      thread.reads = [];
    });

    it('reads nothing at all when only the paths were wanted', async () => {
      const result = await embeddings.search(mine, 'alpha', { ...options, pathsOnly: true }, signal());
      expect(result.files.map((f) => f.path)).toContain('one.ts');
      // The lines would only have been thrown away (see trim in tools/search)
      expect(thread.reads).toEqual([]);
    });

    // What the container gives back before it has been created: the pieces are
    // all there, and not one of them has any lines. The answer used to be a
    // list of line numbers with nothing against them, which told the model
    // nothing and sent it searching again for what it had just asked for.
    it('leaves out the files the container could not give it, rather than listing them empty', async () => {
      thread.contents = {};
      const result = await embeddings.search(mine, 'alpha', options, signal());
      expect(result.files).toEqual([]);
    });

    // A thread's first searches come before anything has made it a container:
    // a model is told to search before it reads, and reading is what makes
    // one. Every piece used to be found and then dropped for want of its
    // lines, so the answer was "No matches." for a workspace sitting indexed
    // on disk.
    it('answers from the workspace itself when the thread has no container yet', async () => {
      thread.container = false;
      const result = await embeddings.search(mine, 'alpha', options, signal());
      expect(result.files[0].path).toBe('one.ts');
      expect(result.files[0].blocks[0]).toEqual(expect.arrayContaining([{ line: 2, text: '  return "alpha";' }]));
      // Nothing is left unaccounted for: the lines were read, elsewhere
      expect(result.unread).toBe(0);
    });

    // The thread has a container and has changed the file in it, so what it
    // has there is what it searches: the workspace's copy is not an answer
    // for a file the thread has made its own.
    it('prefers what the container holds to the workspace, where it has both', async () => {
      thread.contents['one.ts'] = 'function first() {\n  return "alpha and more";\n}';
      const result = await embeddings.search(mine, 'alpha', options, signal());
      expect(result.files[0].blocks[0]).toEqual(
        expect.arrayContaining([{ line: 2, text: '  return "alpha and more";' }])
      );
    });

    it('says how many pieces it found and could not read, rather than none', async () => {
      // The container is there and has nothing to give: not the same as not
      // being there, and nothing can stand in for it (see the tool, which
      // tells the model what became of these)
      thread.contents = {};
      const result = await embeddings.search(mine, 'alpha', options, signal());
      expect(result.files).toEqual([]);
      expect(result.unread).toBeGreaterThan(0);
    });

    it('keeps the files it could read when only some of them failed', async () => {
      delete thread.contents['one.ts'];
      const result = await embeddings.search(mine, 'alpha', options, signal());
      expect(result.files.map((f) => f.path)).toEqual(['two.ts']);
    });

    it('reads only the files the search was narrowed to, not the ones ruled out', async () => {
      await embeddings.search(mine, 'alpha', { ...options, keep: (path) => path === 'two.ts' }, signal());
      expect(thread.reads.flat()).toEqual(['two.ts']);
    });

    it('reads every file it needs in one go, and each file only once', async () => {
      // A file long enough to be held as several pieces: a piece aims for
      // 1,500 characters. Each of them matching used to be a read of its own.
      const long = Array.from({ length: 200 }, (_, i) => `function alpha${i}() { return "alpha"; }`).join('\n');
      put('long.ts', long);
      thread.contents['long.ts'] = long;
      thread.changed = [{ path: 'long.ts', status: 'added', text: long }];
      await embeddings.update(mine, signal());
      thread.reads = [];

      const hits = await embeddings.rank(mine, 'alpha', 20, signal());
      // Several pieces of the one file came back...
      expect(hits.filter((hit) => hit.path === 'long.ts').length).toBeGreaterThan(1);
      // ...and they cost one read between them
      expect(thread.reads).toHaveLength(1);
      expect(thread.reads[0]).toEqual([...new Set(thread.reads[0])]);
      expect(thread.reads[0].filter((path) => path === 'long.ts')).toHaveLength(1);
      // The lines are still each piece's own
      expect(hits.find((hit) => hit.path === 'long.ts')?.text).toContain('alpha');
    });
  });

  it('is taken only once, so later work on it is not thrown away', async () => {
    embeddings.adopt(mine);
    thread.changed = [{ path: 'three.ts', status: 'added', text: 'function third() {\n  return "gamma";\n}' }];
    thread.contents['three.ts'] = 'function third() {\n  return "gamma";\n}';
    await embeddings.update(mine, signal());
    // Adopting again must not put the workspace's copy back over the thread's
    embeddings.adopt(mine);
    await expect(paths(mine, 'gamma')).resolves.toContain('three.ts');
  });

  it('embeds what the thread has written, into its own copy alone', async () => {
    embeddings.adopt(mine);
    thread.changed = [{ path: 'one.ts', status: 'modified', text: 'function first() {\n  return "delta";\n}' }];
    thread.contents['one.ts'] = 'function first() {\n  return "delta";\n}';
    await expect(embeddings.update(mine, signal())).resolves.toEqual({ changed: 1, embedded: 1, dropped: 0 });

    // The thread finds what it wrote...
    const hits = await embeddings.rank(mine, 'delta', 10, signal());
    expect(hits[0].path).toBe('one.ts');
    expect(hits[0].text).toContain('delta');
    // ...and the workspace's copy still has what was there before
    const theirs = await embeddings.rank({ workspace }, 'delta', 10, signal());
    expect(theirs[0].score).toBeLessThan(hits[0].score);
  });

  it('drops a file the thread deleted, from its copy alone', async () => {
    embeddings.adopt(mine);
    thread.changed = [{ path: 'two.ts', status: 'deleted', text: null }];
    await expect(embeddings.update(mine, signal())).resolves.toEqual({ changed: 1, embedded: 0, dropped: 1 });
    await expect(paths(mine, 'beta')).resolves.not.toContain('two.ts');
    // The workspace still has it
    await expect(paths({ workspace }, 'beta')).resolves.toContain('two.ts');
  });

  it('drops a file that has stopped being text', async () => {
    embeddings.adopt(mine);
    thread.changed = [{ path: 'one.ts', status: 'modified', text: null }];
    await expect(embeddings.update(mine, signal())).resolves.toMatchObject({ dropped: 1 });
    await expect(paths(mine, 'alpha')).resolves.not.toContain('one.ts');
  });

  it('embeds a file again only when the thread has changed it since', async () => {
    embeddings.adopt(mine);
    const text = 'function first() {\n  return "delta";\n}';
    thread.changed = [{ path: 'one.ts', status: 'modified', text }];
    thread.contents['one.ts'] = text;
    await embeddings.update(mine, signal());
    const after = requests.length;
    // Reported as changed again, but it is the same text as before
    await expect(embeddings.update(mine, signal())).resolves.toMatchObject({ changed: 1, embedded: 0 });
    expect(requests).toHaveLength(after);
  });

  it('leaves the copy as it was when there is no container to ask', async () => {
    embeddings.adopt(mine);
    thread.changed = null;
    await expect(embeddings.update(mine, signal())).resolves.toEqual({ changed: 0, embedded: 0, dropped: 0 });
    await expect(paths(mine, 'alpha')).resolves.toEqual(['one.ts', 'two.ts']);
  });

  it('leaves the copy as it was, and says so, when the record cannot be read', async () => {
    embeddings.adopt(mine);
    thread.failure = "This thread's changes can't be told.";
    await expect(embeddings.update(mine, signal())).resolves.toEqual({ changed: 0, embedded: 0, dropped: 0 });
    expect(log.warn).toHaveBeenCalledWith('embeddings.update', expect.objectContaining({ thread: THREAD }));
  });

  it('is nothing to adopt before the workspace itself has been embedded', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-other-'));
    try {
      embeddings.adopt({ workspace: other, thread: 'another-thread' });
      await expect(paths({ workspace: other, thread: 'another-thread' }, 'alpha')).resolves.toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('goes when the thread goes, and leaves the workspace its own', async () => {
    embeddings.adopt(mine);
    thread.changed = [{ path: 'three.ts', status: 'added', text: 'function third() {\n  return "gamma";\n}' }];
    thread.contents['three.ts'] = 'function third() {\n  return "gamma";\n}';
    await embeddings.update(mine, signal());
    expect(await paths(mine, 'gamma')).toContain('three.ts');

    embeddings.forgetThread(THREAD);
    await expect(paths(mine, 'gamma')).resolves.toEqual([]);
    // The workspace's copy is untouched
    await expect(paths({ workspace }, 'alpha')).resolves.toEqual(['one.ts', 'two.ts']);
  });

  it('refuses to be asked to update the workspace itself', async () => {
    await expect(embeddings.update({ workspace }, signal())).rejects.toThrow('Only a thread has a copy of its own');
  });

  it('is what a search of a thread reads, brought up to date first', async () => {
    embeddings.adopt(mine);
    const text = 'function first() {\n  return "gamma";\n}';
    thread.changed = [{ path: 'one.ts', status: 'modified', text }];
    thread.contents['one.ts'] = text;
    const result = await embeddings.search(mine, 'gamma', options, signal());
    expect(result.files[0].path).toBe('one.ts');
    expect(result.files[0].blocks[0].map((l) => l.text).join('\n')).toContain('gamma');
  });
});

describe('whether it is ready to be used', () => {
  it('is, once the model answers', async () => {
    await expect(embeddings.status()).resolves.toEqual({ ready: true });
  });

  it('is not, and says what to do, when the model is missing', async () => {
    failure = { status: 404, body: JSON.stringify({ error: 'model not found, try pulling it first' }) };
    await expect(embeddings.status()).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining('ollama pull'),
    });
  });
});

describe('forgetting a workspace', () => {
  it('has the next index embed it all again', async () => {
    put('a.ts', 'alpha');
    proc.tracked = ['a.ts'];
    await embeddings.index(workspace, signal());
    embeddings.forget({ workspace });
    await expect(embeddings.index(workspace, signal())).resolves.toMatchObject({ embedded: 1 });
  });
});
