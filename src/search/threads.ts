// Searching the threads themselves: what was asked, and what came back, by
// meaning rather than by word. The model and the vectors are the ones the code
// search uses (see embeddings.ts).
//
// A thread is cut into one piece per request: a user message and whatever the
// assistant said in reply to it. That is the unit a person remembers — "the
// conversation where I asked about the container" — and the unit they want to
// be put back into, so a hit can be shown as the request it belongs to and
// opened at the message that began it.
//
// Only the request and the replies are embedded. A thread also holds the
// model's thoughts, its tool calls, their output and the app's own notes, and
// embedding those buries the conversation: a search for "docker image" would
// find every reply that happened to read a Dockerfile rather than the one where
// the user asked about images.
//
// The window cuts the threads up, because it is the window that knows what a
// message is (see pieces() in renderer.ts). What arrives here is a flat list,
// and what is kept is one vector each, in one file for all of them: a piece is
// a few hundred words, so a long history is a few hundred vectors.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as log from '../log';
import { MODEL, PREFIXES, decode, embed, encode, similarity, unit } from './embeddings';

// One request and its replies, as the window cuts them
export interface Piece {
  // The thread it came from, and what that thread is called
  thread: string;
  title: string;
  // Which message of the thread began it. A hint for the window, which finds
  // the message by its text if the thread has changed shape since (see the key)
  at: number;
  // What the user asked
  request: string;
  // What came back: every assistant message of that turn, and nothing else
  reply: string;
  // When the thread was last used, for ordering hits that are equally alike
  when?: number;
}

export interface Hit extends Piece {
  // How like the query it is, from -1 to 1
  score: number;
  // The part of it worth showing: the words of the reply that have most to do
  // with the query
  preview: string;
}

export interface Indexed {
  // Pieces the threads come to
  pieces: number;
  // ...of which these had to be embedded now, the rest being unchanged
  embedded: number;
  // Pieces that were kept for messages which have since gone
  dropped: number;
}

// Pieces embedded in one request, as for files
const BATCH = 16;
// How many hits a search gives back at most
const LIMIT = 8;
// What counts as an answer at all. A search by meaning always has a best
// answer, so without a cut a search for something never discussed comes back
// with whatever is least unlike it.
//
// Both numbers are measured rather than guessed. Embedding three unrelated
// exchanges with nomic-embed-text and asking four questions of them: the piece
// the question was about scored 0.60 to 0.69, the others 0.37 to 0.49, and a
// question about something absent altogether scored 0.44 at best. So nothing
// below FLOOR is an answer, and a piece much less alike than the best one is
// not an answer either — that gap, not the score, is what tells a match from
// the model's own baseline.
const FLOOR = 0.45;
const SPREAD = 0.1;
// Characters of a preview
const PREVIEW = 240;

// A piece as it is kept on disk
interface StoredPiece {
  thread: string;
  title: string;
  at: number;
  request: string;
  reply: string;
  when?: number;
  // What was embedded, so an unchanged piece is not embedded again
  hash: string;
  vector: string;
}

interface Stored {
  // Vectors from two models cannot be compared, so a change of model throws
  // the lot away
  model: string;
  pieces: Record<string, StoredPiece>;
}

let dir: string | null = null;
// key -> the piece and its vector, decoded
// The vector is held both ways: decoded to compare with, and as the bytes it
// was written as, so saving it again is not a second round of scaling.
type Entry = Piece & { hash: string; vector: Int8Array; encoded: string };
let held: { model: string; pieces: Map<string, Entry> } | null = null;

// Where the vectors are kept: beside the ones for code
export function configure(options: { dir?: string }): void {
  if (options.dir !== undefined) dir = path.join(options.dir, 'embeddings');
  held = null;
}

const file = () => path.join(dir as string, 'threads.json');
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

// What a piece is known by. The text of the request rather than its place in
// the thread: a message added or removed above it moves every later one, and a
// key that moved would re-embed the lot and would point the window at the
// wrong message.
export const keyOf = (piece: { thread: string; request: string }) => `${piece.thread}:${digest(piece.request.trim())}`;

// What is embedded for a piece: the request and the replies to it, which is
// everything a person would have said the exchange was about
export const textOf = (piece: { request: string; reply: string }) =>
  piece.reply.trim() ? `${piece.request.trim()}\n\n${piece.reply.trim()}` : piece.request.trim();

function state(model: string): NonNullable<typeof held> {
  if (held && held.model === model) return held;
  const fresh: NonNullable<typeof held> = { model, pieces: new Map() };
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Stored;
    if (saved?.model === model && saved.pieces) {
      for (const [key, piece] of Object.entries(saved.pieces)) {
        fresh.pieces.set(key, { ...piece, vector: decode(piece.vector), encoded: piece.vector });
      }
    }
  } catch {
    // Nothing kept yet, or it could not be read
  }
  held = fresh;
  return fresh;
}

function persist(current: NonNullable<typeof held>): void {
  if (!dir) return;
  try {
    const stored: Stored = { model: current.model, pieces: {} };
    for (const [key, piece] of current.pieces) {
      const { vector: _vector, encoded, ...rest } = piece;
      stored.pieces[key] = { ...rest, vector: encoded };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(stored), { mode: 0o600 });
  } catch (err) {
    log.warn('threads.index.save', { error: (err as Error).message });
  }
}

// Brings the index up to date with the threads as they now are: embeds the
// pieces that are new or have changed, forgets the ones whose messages have
// gone, and leaves the rest alone. Nothing changed is no work and no request.
export async function index(pieces: Piece[], signal: AbortSignal, model = MODEL): Promise<Indexed> {
  const started = performance.now();
  const current = state(model);
  const wanted = new Map(pieces.map((piece) => [keyOf(piece), piece]));

  let dropped = 0;
  for (const key of [...current.pieces.keys()]) {
    if (!wanted.has(key)) {
      current.pieces.delete(key);
      dropped++;
    }
  }

  // A piece whose text is unchanged keeps its vector; everything else about it
  // (its title, where it is, when it was) is taken as it now stands
  const stale: { key: string; piece: Piece; hash: string }[] = [];
  for (const [key, piece] of wanted) {
    const hash = digest(textOf(piece));
    const have = current.pieces.get(key);
    if (have && have.hash === hash) {
      current.pieces.set(key, { ...piece, hash, vector: have.vector, encoded: have.encoded });
      continue;
    }
    stale.push({ key, piece, hash });
  }

  if (stale.length === 0) {
    if (dropped > 0) persist(current);
    return { pieces: wanted.size, embedded: 0, dropped };
  }

  const prefix = PREFIXES[model]?.document ?? '';
  let embedded = 0;
  for (let at = 0; at < stale.length; at += BATCH) {
    if (signal.aborted) break;
    const batch = stale.slice(at, at + BATCH);
    const got = await embed(
      batch.map(({ piece }) => `${prefix}${textOf(piece)}`),
      signal,
      model
    );
    batch.forEach(({ key, piece, hash }, i) => {
      // Kept as the bytes it will be read back as, so a search scores a piece
      // the same before and after a restart
      const encoded = encode(got[i]);
      current.pieces.set(key, { ...piece, hash, vector: decode(encoded), encoded });
      embedded++;
    });
  }
  persist(current);
  log.info('threads.index', {
    pieces: wanted.size,
    embedded,
    dropped,
    ms: Math.round(performance.now() - started),
  });
  return { pieces: wanted.size, embedded, dropped };
}

// The words of a query worth matching on: the ones long enough to mean
// something on their own
const words = (query: string) => [...new Set(query.toLowerCase().match(/[\w']{3,}/g) ?? [])];

// The part of a reply that has most to do with the query: the line with the
// most of its words in it, and what follows that line up to a limit. A reply
// with none of them shows its opening, which is what it was about.
export function excerpt(text: string, query: string, max = PREVIEW): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const wanted = words(query);
  let best = 0;
  let most = 0;
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    const score = wanted.filter((word) => low.includes(word)).length;
    if (score > most) {
      most = score;
      best = i;
    }
  });
  const shown = lines.slice(best).join(' ');
  return shown.length > max ? `${shown.slice(0, max).trimEnd()}…` : shown;
}

// The pieces most like the query, most alike first. Throws what the embedder
// threw: no Ollama to ask is worth saying rather than answering with nothing.
export async function search(
  query: string,
  signal: AbortSignal,
  {
    limit = LIMIT,
    model = MODEL,
    floor = FLOOR,
    spread = SPREAD,
  }: { limit?: number; model?: string; floor?: number; spread?: number } = {}
): Promise<Hit[]> {
  if (!query.trim()) return [];
  const current = state(model);
  if (current.pieces.size === 0) return [];
  const asked = PREFIXES[model]?.query ?? '';
  const [embedded] = await embed([`${asked}${query}`], signal, model);
  const wanted = unit(embedded);

  const hits: Hit[] = [];
  for (const piece of current.pieces.values()) {
    const score = similarity(wanted, piece.vector);
    if (score < floor) continue;
    const { hash: _hash, vector: _vector, encoded: _encoded, ...rest } = piece;
    hits.push({ ...rest, score, preview: excerpt(piece.reply || piece.request, query) });
  }
  // Alike first, and the thread used most recently first among equals
  hits.sort((a, b) => b.score - a.score || (b.when ?? 0) - (a.when ?? 0));
  // ...and then only what is in the same company as the best of them
  const best = hits[0]?.score ?? 0;
  return hits.filter((hit) => hit.score >= best - spread).slice(0, limit);
}

// A thread is gone: so are its pieces. The next index would drop them anyway,
// but a deleted thread must not be findable in the meantime.
export function forgetThread(thread: string, model = MODEL): void {
  const current = state(model);
  let dropped = 0;
  for (const [key, piece] of [...current.pieces]) {
    if (piece.thread === thread) {
      current.pieces.delete(key);
      dropped++;
    }
  }
  if (dropped > 0) persist(current);
}
