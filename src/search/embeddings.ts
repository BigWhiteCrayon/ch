// The semantic search behind search_workspace, over embeddings from a local
// Ollama model.
//
// Files are embedded in pieces (see chunks.ts), so each vector is about one
// thing and knows which lines it came from. Finding the piece is only half of
// an answer, though: an embedding cannot say which line in a piece matters, so
// the query's own words pick the line to show from inside it, and the
// embedding and the keywords each do what they are good at.
//
// The files are read as they are rather than as last committed, so a thread's
// own uncommitted work is searchable.
//
// A thread searches its own copy. The workspace's index is made once and shared,
// and a thread takes a copy of it when it first needs one (see adopt), so it
// starts out knowing the whole project without embedding any of it again.
// From then on the two part company: the thread works in its container, and
// what it changes there is re-embedded into its own copy alone (see update),
// so what it searches is the project as the thread has made it. A file the
// thread deleted goes from its copy; the workspace's is left as it was.
//
// Vectors are kept as bytes rather than numbers: a vector of 768 floats
// written out as JSON is some 15kB, and there are ten or more of them per
// file. Scaled to a byte each they are 768, which is small enough to keep
// them all in one file per workspace, and accurate enough that the order things
// come back in barely moves.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as log from '../log';
import type { LocalSettings } from '../types';
import * as changes from '../sandbox/changes';
import { embeddable, isBoundary, split, type Chunk } from './chunks';
import { keywords } from './ripgrep';
import type { SearchOptions, SearchResult } from './results';
import { toolEnv } from './env';

// The model the embeddings come from. Small, made for retrieval, and it takes
// a whole piece at a time with room to spare.
export const MODEL = 'nomic-embed-text';

// Some embedding models are trained to be told whether they are reading
// something to be found or something to find it with, and are markedly worse
// when they aren't. A model not named here is given the text alone.
export const PREFIXES: Record<string, { document: string; query: string }> = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
  'mxbai-embed-large': { document: '', query: 'Represent this sentence for searching relevant passages: ' },
};

// Characters of a file that are read at all. Past this it is not source code
// but data, and embedding it says little.
const MAX_CHARS = 400000;
// Pieces embedded in one request
const BATCH = 16;
const TIMEOUT_MS = 120000;
// Files with a NUL byte early on are not text and are not embedded
const BINARY_SNIFF = 8000;
// The largest a byte of a vector may be. Each vector is scaled by its own
// largest component rather than by being made a unit vector first: a unit
// vector of 768 components has each of them around 0.036, which leaves only
// about five steps of a byte to say it in and loses more than it should.
// Scaling by the peak uses the whole byte, and direction is all that likeness
// depends on, so the scale itself need not be kept.
const SCALE = 127;

// A piece as it is kept on disk: its lines, and its vector as bytes in base64
interface StoredChunk {
  start: number;
  end: number;
  vector: string;
}

interface Stored {
  // Which model wrote them: vectors from two models cannot be compared, so a
  // change of model throws the lot away
  model: string;
  // Path (relative to the workspace) -> the file's digest and its pieces
  files: Record<string, { hash: string; chunks: StoredChunk[] }>;
}

// The same, as it is held while running, with the vectors decoded
interface Held {
  model: string;
  files: Map<string, { hash: string; chunks: { start: number; end: number; vector: Int8Array }[] }>;
}

let dir: string | null = null;
let local: LocalSettings = { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '' };
// workspace -> what has been embedded for it
const held = new Map<string, Held>();
// Threads that have been given the workspace's index (see adopt). A thread
// whose own copy is empty is given it, and an empty copy is indistinguishable
// from one a thread has emptied itself, so this marks the giving as done and
// keeps that thread from being given it over and over.
const adopted = new Set<string>();

// Where the vectors are kept, and which Ollama to ask for them.
export function configure(options: { dir?: string; local?: LocalSettings }): void {
  if (options.dir !== undefined) dir = path.join(options.dir, 'embeddings');
  if (options.local) local = options.local;
  held.clear();
  adopted.clear();
  // Another server may have other models, or the same names for other models
  embedders.clear();
}

// Ollama's own API lives at the server root, not under the OpenAI-compatible path
const rootURL = () => local.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');

function headers(): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (local.apiKey) result.Authorization = `Bearer ${local.apiKey}`;
  return result;
}

// Which files are being searched: the user's workspace as it is, or a thread's
// own copy of it, which starts as a copy of the workspace's and then diverges
export interface Workspace {
  workspace: string;
  // The thread whose copy is searched, if it is not the workspace's own
  thread?: string;
}

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
// A thread's index is kept apart from the workspace's, and from other threads'
const nameOf = (where: Workspace) => (where.thread ? threadName(where.thread) : `workspace:${where.workspace}`);
const fileFor = (name: string) => path.join(dir as string, `${digest(name)}.json`);
const cacheFile = (where: Workspace) => fileFor(nameOf(where));
// A thread's name does not depend on its workspace, so its copy can be found
// again knowing only the thread (see forgetThread)
const threadName = (thread: string) => `thread:${thread}`;

// A vector as bytes, scaled by its own largest component (see SCALE)
export function encode(vector: number[]): string {
  const peak = vector.reduce((most, x) => Math.max(most, Math.abs(x)), 0) || 1;
  const bytes = Buffer.alloc(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round((vector[i] / peak) * SCALE);
    bytes[i] = Math.max(-SCALE, Math.min(SCALE, scaled)) & 0xff;
  }
  return bytes.toString('base64');
}

export function decode(text: string): Int8Array {
  const raw = Buffer.from(text, 'base64');
  const bytes = new Int8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw[i] > SCALE ? raw[i] - 256 : raw[i];
  return bytes;
}

// A unit vector, for the query side of a comparison
export function unit(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((n, x) => n + x * x, 0)) || 1;
  return vector.map((x) => x / length);
}

// How like each other a unit vector and a stored one are, from -1 to 1. The
// stored one's own length is worked out as it goes, since it was scaled by
// whatever its largest component happened to be.
export function similarity(query: number[], stored: Int8Array): number {
  let dot = 0;
  let length = 0;
  for (let i = 0; i < stored.length; i++) {
    dot += (query[i] ?? 0) * stored[i];
    length += stored[i] * stored[i];
  }
  return length === 0 ? 0 : dot / Math.sqrt(length);
}

function state(where: Workspace, model: string): Held {
  const name = nameOf(where);
  const found = held.get(name);
  if (found && found.model === model) return found;
  const fresh: Held = { model, files: new Map() };
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(where), 'utf8')) as Stored;
    // Vectors from another model say nothing about these ones
    if (saved?.model === model && saved.files) {
      for (const [file, { hash, chunks }] of Object.entries(saved.files)) {
        fresh.files.set(file, {
          hash,
          chunks: chunks.map(({ start, end, vector }) => ({ start, end, vector: decode(vector) })),
        });
      }
    }
  } catch {
    // Nothing kept for this where yet, or it could not be read
  }
  held.set(name, fresh);
  return fresh;
}

function persist(where: Workspace, current: Held): void {
  if (!dir) return;
  try {
    const stored: Stored = { model: current.model, files: {} };
    for (const [file, { hash, chunks }] of current.files) {
      stored.files[file] = {
        hash,
        chunks: chunks.map(({ start, end, vector }) => ({
          start,
          end,
          vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64'),
        })),
      };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(where), JSON.stringify(stored), { mode: 0o600 });
  } catch (err) {
    log.warn('embeddings.save', { ...where, error: (err as Error).message });
  }
}

// The files worth embedding: what Git would track or report as untracked, so
// the ignored ones (node_modules and the like) are never read.
export function files(workspace: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      env: toolEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `git ls-files exited with ${code}`));
      resolve([...new Set(out.split('\0').filter(Boolean))]);
    });
  });
}

// A file's text, or null if it is not text, is too big to be worth it, or
// could not be read at all
function text(workspace: string, file: string): string | null {
  try {
    const data = fs.readFileSync(path.join(workspace, file));
    if (data.subarray(0, BINARY_SNIFF).includes(0)) return null;
    const whole = data.toString('utf8');
    return whole.trim() ? whole.slice(0, MAX_CHARS) : null;
  } catch {
    return null;
  }
}

// Which models Ollama says can embed. Asked about once per model; a model it
// could not be asked about is asked about again next time.
const embedders = new Map<string, Promise<boolean | undefined>>();

// Whether the model is an embedding model: true, false, or undefined where
// the server would not say. A text model asked for an embedding answers with
// something, and that something is not an embedding of anything useful, so it
// is worth knowing before rather than after.
export function embeds(model: string): Promise<boolean | undefined> {
  let asking = embedders.get(model);
  if (!asking) {
    asking = fetch(`${rootURL()}/api/show`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10000),
    }).then(
      async (res) => {
        if (!res.ok) return undefined;
        const body = (await res.json().catch(() => ({}))) as { capabilities?: string[] | null };
        // An Ollama too old to say leaves this unanswered
        return body.capabilities?.length ? body.capabilities.includes('embedding') : undefined;
      },
      () => {
        embedders.delete(model);
        return undefined;
      }
    );
    embedders.set(model, asking);
  }
  return asking;
}

// Asks Ollama to embed each of the texts, in the order given. Throws with
// something readable if the model isn't there, isn't an embedding model, or
// the server isn't reachable.
export async function embed(inputs: string[], signal: AbortSignal, model = MODEL): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if ((await embeds(model)) === false) {
    throw new Error(`"${model}" is a text model, not an embedding model. Set one that embeds, such as ${MODEL}.`);
  }
  let response: Response;
  try {
    response = await fetch(`${rootURL()}/api/embed`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model, input: inputs, truncate: true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`No Ollama reachable at ${rootURL()} to embed with.`);
  }
  const body = await response.text();
  if (!response.ok) {
    let reason = body.slice(0, 300);
    try {
      reason = (JSON.parse(body) as { error?: string }).error ?? reason;
    } catch {}
    if (/not found/i.test(reason)) {
      throw new Error(`The embedding model "${model}" is not installed. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama could not embed: ${reason}`);
  }
  const { embeddings } = JSON.parse(body) as { embeddings?: number[][] };
  if (!embeddings || embeddings.length !== inputs.length) {
    throw new Error(`Ollama returned ${embeddings?.length ?? 0} embeddings for ${inputs.length} texts.`);
  }
  return embeddings;
}

export interface Indexed {
  // Files the workspace has that could be embedded
  files: number;
  // Pieces they came to
  chunks: number;
  // ...of which these had to be embedded now, the rest being unchanged
  embedded: number;
  // Files passed over as binary, empty or unreadable
  skipped: number;
}

// Brings the workspace's vectors up to date with its files, embedding only the
// pieces of the files that have changed, and forgetting the files that have
// gone. Awaited by whoever wants it finished; see start() for the other way.
export async function index(
  workspace: string,
  signal: AbortSignal,
  onProgress?: (done: number, of: number) => void,
  model = MODEL
): Promise<Indexed> {
  const started = performance.now();
  const current = state({ workspace }, model);
  const found = await files(workspace);

  // What each file is now, and the pieces it comes to
  const wanted = new Map<string, { hash: string; chunks: Chunk[] }>();
  let skipped = 0;
  for (const file of found) {
    const whole = text(workspace, file);
    if (whole === null) {
      skipped++;
      continue;
    }
    const pieces = split(whole);
    if (pieces.length === 0) {
      skipped++;
      continue;
    }
    wanted.set(file, { hash: digest(whole), chunks: pieces });
  }
  // Files that have gone, or stopped being text
  for (const file of [...current.files.keys()]) if (!wanted.has(file)) current.files.delete(file);

  // Every piece of every file whose contents have changed
  const stale: { file: string; chunk: Chunk }[] = [];
  for (const [file, { hash, chunks }] of wanted) {
    if (current.files.get(file)?.hash === hash) continue;
    for (const chunk of chunks) stale.push({ file, chunk });
  }

  const prefix = PREFIXES[model]?.document ?? '';
  const made = new Map<string, { start: number; end: number; vector: Int8Array }[]>();
  for (let at = 0; at < stale.length; at += BATCH) {
    if (signal.aborted) break;
    const batch = stale.slice(at, at + BATCH);
    const got = await embed(
      batch.map(({ file, chunk }) => `${prefix}${embeddable(file, chunk)}`),
      signal,
      model
    );
    batch.forEach(({ file, chunk }, i) => {
      const pieces = made.get(file) ?? [];
      pieces.push({ start: chunk.start, end: chunk.end, vector: decode(encode(got[i])) });
      made.set(file, pieces);
    });
    // A file is only taken as done once every piece of it is embedded, so a
    // run cut short leaves no half-embedded file behind
    for (const [file, pieces] of made) {
      if (pieces.length === wanted.get(file)?.chunks.length) {
        current.files.set(file, { hash: wanted.get(file)!.hash, chunks: pieces });
        made.delete(file);
      }
    }
    onProgress?.(Math.min(at + BATCH, stale.length), stale.length);
    // Saved as it goes, so a long first pass is not lost if the app closes
    persist({ workspace }, current);
  }
  // ...and again at the end, since a workspace whose files only went away has
  // nothing to embed and would otherwise never have the losses written down
  persist({ workspace }, current);

  const result = {
    files: wanted.size,
    chunks: [...wanted.values()].reduce((n, { chunks }) => n + chunks.length, 0),
    embedded: stale.length,
    skipped,
  };
  log.info('embeddings.index', { workspace, model, ms: log.since(started), ...result });
  return result;
}

// Indexing going on in the background, by workspace
const jobs = new Map<string, { done: number; of: number; running: boolean }>();

// Gets the workspace indexed without waiting for it. A search may be answered
// from what is embedded so far, and says how much of the workspace that is.
export function start(workspace: string, model = MODEL): void {
  if (jobs.get(workspace)?.running) return;
  const job = { done: 0, of: 0, running: true };
  jobs.set(workspace, job);
  index(workspace, AbortSignal.timeout(60 * 60 * 1000), (done, of) => Object.assign(job, { done, of }), model)
    .catch((err) => log.warn('embeddings.start', { workspace, error: (err as Error).message }))
    .finally(() => (job.running = false));
}

// How much of the workspace is embedded, as a percentage: everything, unless
// there is indexing going on
export function coverage(workspace: string): number {
  const job = jobs.get(workspace);
  if (!job?.running || job.of === 0) return 100;
  return Math.min(99, Math.round((100 * job.done) / job.of));
}

// Gives a thread its own copy of the workspace's index, once. Called when the
// thread is first opened, and again before each of its searches, so that it
// knows the whole project without a single file being embedded again. Does
// nothing once the thread has a copy of its own, or while the workspace has
// nothing to copy yet.
//
// A thread opened before its workspace had been indexed used to be left with
// nothing for as long as it lived: there was nothing to copy at the time, and
// the first search it ran saved an empty index of its own, which every later
// attempt then took for a copy already made. Such a thread searched an empty
// index and found nothing, however much of the project was indexed by then.
// So an empty copy is not treated as a copy, and is filled in when the
// workspace's index arrives.
export function adopt(where: Workspace, model = MODEL): void {
  const { workspace, thread } = where;
  if (!dir || !thread || adopted.has(thread)) return;
  const theirs = cacheFile({ workspace });
  if (!fs.existsSync(theirs)) return;
  const mine = cacheFile(where);
  // A copy with files in it is the thread's own work and is left alone
  const existed = fs.existsSync(mine);
  if (existed && state(where, model).files.size > 0) {
    adopted.add(thread);
    return;
  }
  // Nothing worth taking yet: the workspace's index is there but still empty
  if (state({ workspace }, model).files.size === 0) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(theirs, mine);
    held.delete(nameOf(where));
    adopted.add(thread);
    // `backfilled` tells the thread that was given the index late from the
    // one that had it from the start
    log.info('embeddings.adopt', { workspace, thread, backfilled: existed });
  } catch (err) {
    log.warn('embeddings.adopt', { workspace, thread, error: (err as Error).message });
  }
}

export interface Updated {
  // Files the thread has changed since its workspace was copied in
  changed: number;
  // ...of which these were embedded again now
  embedded: number;
  // ...and these were dropped, having been deleted or stopped being text
  dropped: number;
}

// Brings a thread's copy in step with what the thread has done in its
// container: the files it has written are embedded again, and the ones it has
// deleted are dropped. Only its own copy is touched, never the workspace's.
export async function update(where: Workspace, signal: AbortSignal, model = MODEL): Promise<Updated> {
  const { workspace, thread } = where;
  if (!thread) throw new Error('Only a thread has a copy of its own to bring up to date.');
  adopt(where, model);
  const started = performance.now();
  const current = state(where, model);

  let changedFiles: changes.ChangedFile[] | null = null;
  try {
    changedFiles = await changes.changedText(thread);
  } catch (err) {
    // No record to compare against: the copy stands as the workspace's was
    log.warn('embeddings.update', { workspace, thread, error: (err as Error).message });
    return { changed: 0, embedded: 0, dropped: 0 };
  }
  // No container yet, so the thread has changed nothing
  if (!changedFiles) return { changed: 0, embedded: 0, dropped: 0 };

  // What the thread has now, in pieces; a file with no text to embed goes
  const wanted = new Map<string, { hash: string; chunks: Chunk[] }>();
  let dropped = 0;
  for (const file of changedFiles) {
    const pieces = file.text === null ? [] : split(file.text);
    if (pieces.length === 0) {
      if (current.files.delete(file.path)) dropped++;
      continue;
    }
    const hash = digest(file.text as string);
    // Already embedded at this very content: nothing to do for it
    if (current.files.get(file.path)?.hash === hash) continue;
    wanted.set(file.path, { hash, chunks: pieces });
  }

  const prefix = PREFIXES[model]?.document ?? '';
  const stale = [...wanted].flatMap(([file, { chunks }]) => chunks.map((chunk) => ({ file, chunk })));
  const made = new Map<string, { start: number; end: number; vector: Int8Array }[]>();
  for (let at = 0; at < stale.length; at += BATCH) {
    if (signal.aborted) break;
    const batch = stale.slice(at, at + BATCH);
    const got = await embed(
      batch.map(({ file, chunk }) => `${prefix}${embeddable(file, chunk)}`),
      signal,
      model
    );
    batch.forEach(({ file, chunk }, i) => {
      const pieces = made.get(file) ?? [];
      pieces.push({ start: chunk.start, end: chunk.end, vector: decode(encode(got[i])) });
      made.set(file, pieces);
    });
    // A file is only taken as done once every piece of it is embedded
    for (const [file, pieces] of made) {
      if (pieces.length === wanted.get(file)?.chunks.length) {
        current.files.set(file, { hash: wanted.get(file)!.hash, chunks: pieces });
        made.delete(file);
      }
    }
  }
  persist(where, current);

  const result = { changed: changedFiles.length, embedded: wanted.size, dropped };
  log.info('embeddings.update', { workspace, thread, model, ms: log.since(started), ...result });
  return result;
}

export interface Hit {
  path: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

// The workspace's pieces, likest the query first, from what is embedded now.
// Nothing is indexed here: see start() and index().
export interface RankOptions {
  model?: string;
  // Which files may match, when the search was narrowed to some of them
  keep?: (path: string) => boolean;
  // Only the paths are wanted, so no file need be read at all
  pathsOnly?: boolean;
}

export async function rank(
  where: Workspace,
  query: string,
  limit: number,
  signal: AbortSignal,
  { model = MODEL, keep, pathsOnly = false }: RankOptions = {}
): Promise<Hit[]> {
  const current = state(where, model);
  const asked = PREFIXES[model]?.query ?? '';
  const [embedded] = await embed([`${asked}${query}`], signal, model);
  const wanted = unit(embedded);

  const hits: Hit[] = [];
  for (const [file, { chunks }] of current.files) {
    // A search narrowed to some of the files leaves the rest out here, before
    // anything is read, rather than after: their lines were being fetched
    // from the container only to be thrown away, and asking for five times
    // the pieces to make up for the narrowing made it five times as much
    if (keep && !keep(file)) continue;
    for (const chunk of chunks) {
      hits.push({ path: file, start: chunk.start, end: chunk.end, text: '', score: similarity(wanted, chunk.vector) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // The lines themselves are read only for the pieces being returned, and not
  // even for those when only the paths were asked for
  const top = hits.slice(0, limit);
  if (!pathsOnly) await fill(where, top);
  return top;
}

// Gives each piece its lines, as the where has them now: from the workspace,
// or from the thread's container where it is a thread's. A piece whose file
// has changed under us and no longer has those lines gets nothing.
//
// Every piece is read together, and each file only once however many of its
// pieces matched. One at a time they cost around 55ms each of Docker before
// a byte was read, which a search for thirty pieces paid thirty times over
// (see sandbox/docker.readEach).
async function fill(where: Workspace, hits: Hit[]): Promise<void> {
  const paths = [...new Set(hits.map((hit) => hit.path))];
  const fromWorkspace = () => new Map(paths.map((path) => [path, text(where.workspace, path)]));
  // A thread's lines come from its container, where its own work is. Until it
  // has one it has done no work, and the workspace's files are exactly what it
  // would have read there — so they answer instead of nothing.
  //
  // Without this, a thread's first searches were ranked against a full index,
  // could read none of the lines they had found, and dropped every hit (see
  // search): "No matches." for a workspace indexed and sitting right there.
  // It is the first searches that matter most — a model is told to search
  // before it reads anything, which is before anything has made a container.
  const whole = where.thread ? ((await changes.filesText(where.thread, paths)) ?? fromWorkspace()) : fromWorkspace();
  for (const hit of hits) {
    const file = whole.get(hit.path);
    hit.text = file
      ? file
          .split('\n')
          .slice(hit.start - 1, hit.end)
          .join('\n')
      : '';
  }
}

// Whether a line shows code, rather than being blank or a comment. A piece
// that begins with its file's header comment would otherwise be shown as that
// comment, which says no more than the path above it already does.
const isCode = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return !/^(\/\/|\/\*|\*\/|\*(\s|$)|#!|# |--(\s|$)|<!--|;(\s|$))/.test(trimmed);
};

// What a line is worth against the query's words, which decides the line a
// piece is shown from (see pick). A count of the words in it is not enough,
// and in a commented codebase it is usually wrong: a sentence about the code
// holds more of a question's words than the declaration it sits above, so the
// count shows the prose and leaves the model to guess that the code is nearby.
// A search for the Thread type was answered eleven times with the comment two
// lines under it and never with the line that declares it.
//
// So three things are weighed instead. A word on its own is worth more than
// the same word inside another one, since `thread` in `threadList` is a use
// and `thread` on its own is often the thing itself. A comment is worth half
// of what code is: it is about the answer rather than the answer. And a line
// that starts something is worth more again — a declaration is what "where is
// X" is asking for, and it is the one line of a piece that a model can act on
// without reading the file (see chunks.isBoundary).
const WHOLE = 2; // the word on its own
const PART = 1; // the word inside another one
const PROSE = 0.5; // what a comment is worth against what code is
const DECLARES = 1.5; // added where the line starts something

// The keywords are letters, digits and underscores only (see
// ripgrep.keywords), so they go into a pattern as they are. `_` is a word
// character to both this and the code it matches, which is what keeps
// `thread` from being read as a whole word in `thread_list`. Kept, since the
// same handful of words is asked of every line of every piece in a search.
const patterns = new Map<string, RegExp>();
function whole(word: string): RegExp {
  const known = patterns.get(word);
  if (known) return known;
  const pattern = new RegExp(`\\b${word}\\b`);
  patterns.set(word, pattern);
  return pattern;
}

export function score(line: string, words: string[]): number {
  const lower = line.toLowerCase();
  let found = 0;
  for (const word of words) {
    if (!lower.includes(word)) continue;
    found += whole(word).test(lower) ? WHOLE : PART;
  }
  if (found === 0) return 0;
  // A comment at column 0 is where a piece may end (see chunks.isBoundary),
  // but it is not a declaration: the bonus is for code that starts something,
  // and giving it to prose would undo what PROSE is for.
  if (!isCode(line)) return found * PROSE;
  return isBoundary(line) ? found + DECLARES : found;
}

// Which lines of a piece to show. An embedding says the piece is about the
// query but not which line of it is, so the query's own words choose: the
// line they are worth most on, and its neighbours. A piece with none of them
// shows its first line of code, which is where a function's name and
// signature are; a piece whose lines could not be read shows nothing.
export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {
  if (!hit.text) return [];
  const all = hit.text.split('\n');
  const words = keywords(query);
  let best = 0;
  let most = 0;
  all.forEach((line, i) => {
    const worth = score(line, words);
    if (worth > most) {
      most = worth;
      best = i;
    }
  });
  // Nothing in the piece matched the query, so it is shown from its first
  // real line rather than from a comment block it happens to start with
  if (most === 0) best = Math.max(0, all.findIndex(isCode));
  const from = Math.max(0, best - context);
  const to = Math.min(all.length, best + context + 1);
  return all.slice(from, to).map((line, i) => ({ line: hit.start + from + i, text: line }));
}

// A search, in the shape the search tool works in: the pieces grouped by the
// file they are in, likest first, each with the lines worth showing.
export async function search(
  where: Workspace,
  query: string,
  { limit, context, pathsOnly, keep }: SearchOptions,
  signal: AbortSignal
): Promise<SearchResult> {
  // Kept up to date in the background: a search is answered from what is
  // embedded now rather than waiting for the rest. A thread's copy is brought
  // in step with its own work instead, which is quick: only what it changed.
  if (where.thread) await update(where, signal).catch(() => undefined);
  else start(where.workspace);
  const hits = await rank(where, query, limit, signal, { keep, pathsOnly });
  const byFile = new Map<string, { line: number; text: string }[][]>();
  // Pieces that matched and whose lines nothing could be read from
  let unread = 0;
  for (const hit of hits) {
    if (pathsOnly) {
      byFile.set(hit.path, byFile.get(hit.path) ?? []);
      continue;
    }
    // A piece whose lines could not be read is left out rather than shown as
    // line numbers with nothing against them: that is not an answer, and a
    // model that gets one searches again for what it already asked for. It is
    // counted, though, because a search that found pieces and could show none
    // of them must not come back saying there was nothing to find (see
    // ../tools/search.ts). The ordinary cause — a thread with no container —
    // is answered from the workspace now and does not reach here (see fill).
    const lines = pick(hit, query, context);
    if (lines.length === 0) {
      unread++;
      continue;
    }
    const blocks = byFile.get(hit.path) ?? [];
    blocks.push(lines);
    byFile.set(hit.path, blocks);
  }
  return {
    files: [...byFile].map(([file, blocks]) => ({ path: file, blocks })),
    indexed: coverage(where.workspace),
    unread,
  };
}

// The given files, likest the query first.
//
// This is for a search something else answered — a pattern matched against the
// text of the files (see ../tools/search.ts) — whose matches have no order
// worth anything: ripgrep returns them in the order it walked the directory,
// so a pattern that matches eighty files is cut to the first twenty by where
// they happen to sit on disk. What is embedded already can say which of those
// eighty the query meant, and that costs one embedding of the query and no
// reading at all: the lines shown are still the pattern's own.
//
// Files this has nothing embedded for keep the order they came in, after the
// ones it does, rather than being dropped: an answer that is already found
// must not be lost to an index that is half built.
export async function order(
  where: Workspace,
  query: string,
  paths: string[],
  signal: AbortSignal,
  model = MODEL
): Promise<string[]> {
  if (paths.length < 2) return paths;
  const current = state(where, model);
  const asked = PREFIXES[model]?.query ?? '';
  const [embedded] = await embed([`${asked}${query}`], signal, model);
  const wanted = unit(embedded);
  // A file is as like the query as its likest piece is
  const scored = paths.map((path, at) => {
    const chunks = current.files.get(path)?.chunks ?? [];
    const best = chunks.reduce((most, chunk) => Math.max(most, similarity(wanted, chunk.vector)), -Infinity);
    return { path, best, at };
  });
  return scored.sort((a, b) => (b.best === a.best ? a.at - b.at : b.best - a.best)).map(({ path }) => path);
}

// Whether the embedding model is installed, which it has to be before any of
// this works. Resolves with why not, when it isn't.
export async function status(model = MODEL): Promise<{ ready: boolean; reason?: string }> {
  try {
    await embed(['probe'], AbortSignal.timeout(TIMEOUT_MS), model);
    return { ready: true };
  } catch (err) {
    return { ready: false, reason: (err as Error).message };
  }
}

// Forgets what was embedded for a where, so the next search starts over.
export function forget(where: Workspace): void {
  held.delete(nameOf(where));
  if (where.thread) adopted.delete(where.thread);
  if (!where.thread) jobs.delete(where.workspace);
  if (!dir) return;
  fs.rmSync(cacheFile(where), { force: true });
}

// Forgets a thread's own copy, which goes when the thread does. The workspace's
// is left alone, being shared by every thread started in it, and a thread is
// known by itself rather than by the workspace it came from.
export function forgetThread(thread: string): void {
  held.delete(threadName(thread));
  adopted.delete(thread);
  if (!dir) return;
  fs.rmSync(fileFor(threadName(thread)), { force: true });
}
