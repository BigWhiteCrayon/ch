// The detail of what is known about a workspace: many small notes, each on one
// specific thing somebody working here worked out, searched by meaning when
// they are wanted.
//
// This and ./project.ts are the two halves of what a workspace knows, split by
// what it costs to know it. The note in project.ts is read at the start of
// every message in the workspace, so it is short and says only what is true of
// the project as a whole: what it is, how it is laid out, how it is built and
// tested. These are read only when something asks for them, so there can be
// hundreds and each can be as specific as it likes — how one module fits
// together, the flag a command actually needs, the convention one directory
// follows, a trap and the way round it. A thread searches them before it goes
// looking in the code, and writes a new one the moment it works something out
// (see prompt).
//
// They are searched over embeddings from the same local model the code search
// uses (see ../search/embeddings.ts), with a plain word match as the fallback
// for when there is no Ollama to ask. A note is embedded when a search needs
// it rather than when it is written: writing down what you found out must not
// be able to fail because a server is down, and a note nobody ever searches
// for never needs a vector at all.
//
// As in project.ts, the notes belong to the workspace rather than to a thread:
// they are kept in one file in the app's data folder, and a note a thread
// writes is its own until the thread's changes reach the workspace (see add
// and promote). Nothing here throws except where a model can act on it, and
// nothing is done until init() is called, so the harness can be used (and
// tested) without it.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as log from '../log';
import { MODEL, PREFIXES, decode, embed, encode, similarity, unit } from '../search/embeddings';

const FILE_NAME = 'notes.json';

// A subject is a line that says what the note is about, not a note of its own
export const MAX_SUBJECT_LENGTH = 120;
// What one note may say. Short on purpose: the point of keeping them apart
// from one another is that each can be found, read and trusted on its own, and
// a note that runs to pages is a chapter that wants splitting into the several
// things it is really about. A model that writes more is told to split it.
export const MAX_NOTE_LENGTH = 2000;
// How many a workspace keeps. Each is a few hundred characters and a vector of
// a few hundred bytes, so this is small on disk; what it really bounds is the
// work a search does, which reads every one of them.
export const MAX_NOTES = 500;
// Files one note may say it came from. A note that rests on twenty files is
// not a note about a thing, it is a note about the project; the limit is also
// what bounds the reading a write does, since each one is fingerprinted as it
// is taken down (see fingerprint).
export const MAX_SOURCES = 20;
// Where a file is read whole to fingerprint it. Past this it is data rather
// than something a note is about, and its size and the time it was last
// written answer the only question asked of a fingerprint — whether it is the
// same file as before.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// Notes a search gives back at most. Fewer than the code search returns lines:
// each of these is a paragraph the model has to read, and the best few answer
// the question or nothing does.
const LIMIT = 6;
// What counts as an answer at all, and how far behind the best of them a note
// may be and still be shown. The same numbers as the thread search, which is
// the same kind of thing — short prose, embedded whole, searched in plain
// words (see ../search/threads.ts, where they were measured). The spread is a
// little wider here: several notes on one subject are the normal case, and
// cutting the later ones off loses the half of the answer that was written
// second.
const FLOOR = 0.45;
const SPREAD = 0.15;
// Notes embedded in one request, as for files and thread pieces
const BATCH = 16;
const EMBED_TIMEOUT_MS = 60000;

// A file a note rests on, as it stood when the note was written. Taken down at
// that moment because it cannot be worked out afterwards: a note read a year
// later says what it says, and only this says what it was read from.
export interface Source {
  // Where the file is, relative to the top of the workspace — the same paths
  // the search and read_file use
  path: string;
  // What it held: a digest of its contents, or of its size and the time it was
  // last written where the file is too big to read whole (see
  // MAX_SOURCE_BYTES). Only ever compared with itself, so which of the two it
  // is does not matter to a reader. Undefined where the file could not be read
  // at all, which is a file the thread has made in its container and the
  // workspace has not got yet.
  digest?: string;
}

// One thing somebody worked out about the workspace
export interface Note {
  workspace: string;
  // The thread that wrote it, while it is still only that thread's. A thread
  // works in its own copy of the workspace (see ../sandbox), so what it finds
  // out is about the project as that thread has made it, and it reaches the
  // other threads when its changes do (see promote).
  thread?: string;
  // What the note is about, in a line
  subject: string;
  content: string;
  writtenAt: string;
  // The files it was worked out from, fingerprinted as they were then, so that
  // a note can later be checked against the project it describes rather than
  // trusted for ever (see drifted). Empty for a note that rests on no
  // particular file.
  files: Source[];
}

// What a note's files have done since it was written (see check)
export interface Checked {
  // Files whose contents have changed since the note was written
  changed: string[];
  // ...and files that have gone from the workspace altogether, which is the
  // stronger signal: a note about a file that no longer exists is describing
  // something that no longer exists
  gone: string[];
  // Files nothing can be said about, having had no fingerprint taken when the
  // note was written. Reported alongside the rest rather than counted as
  // drift, since not knowing is not the same as having changed.
  unchecked: string[];
}

export interface Hit extends Note {
  // How like the query it is. Comparable with the other hits of the same
  // search and no further: a search answered by words scores differently from
  // one answered by meaning (see Found.by).
  score: number;
  // Set only where the note's files have moved on since it was written, so
  // that whoever reads it knows to read the files rather than trust it (see
  // search). Checking is reading the files of the few notes a search gives
  // back, which is cheap enough to do on every search and worth more than
  // leaving a stale note to be believed.
  drift?: Checked;
}

export interface Found {
  hits: Hit[];
  // How they were found. 'words' means the embeddings could not be asked and
  // plain word matching answered instead, which is worth saying: it matches
  // what the note says, not what it means, so a question in other words than
  // the note used comes back with nothing.
  by: 'meaning' | 'words';
  // Why the embeddings could not answer, where they could not
  why?: string;
}

// A note as it is kept on disk. The vector is optional, unlike the thread
// search's: a note is written first and embedded later, and a note whose
// vector is missing is still a note (see embedMissing).
interface StoredNote extends Note {
  // What was embedded, so an unchanged note is not embedded again
  hash?: string;
  vector?: string;
}

interface Stored {
  // Which model's vectors these are. Vectors from two models cannot be
  // compared, so a change of model throws the vectors away — but not the
  // notes, which is the difference from every other index here: a note is
  // something somebody wrote and cannot be made again from anything else, so
  // it is kept and embedded afresh (see state).
  model: string;
  notes: Record<string, StoredNote>;
}

// The vector is held both ways, as in ../search/threads.ts: decoded to compare
// with, and as the bytes it was written as, so saving it again is not a second
// round of scaling.
type Entry = Note & { hash?: string; vector?: Int8Array; encoded?: string };

interface Held {
  // Which model the vectors held here came from (see vectorsFor)
  model: string;
  // key -> the note and its vector
  notes: Map<string, Entry>;
}

let file: string | null = null;
// Null until the file has been read, which is done once, on the first call
// that needs it
let held: Held | null = null;

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

// What a note is known by: its workspace, whose note it is for now, and its
// subject. The subject rather than the whole of it, so that writing the same
// subject again corrects the note instead of leaving two notes that disagree —
// which is what the model is told the tool does (see ../tools/notes.ts).
const keyOf = (note: { workspace: string; thread?: string; subject: string }) =>
  digest([note.workspace, note.thread ?? '', note.subject.trim().toLowerCase()].join('\u0000'));

// What is embedded for a note: what it is about and what it says, which is
// what somebody searching for it would describe
export const textOf = (note: { subject: string; content: string }) =>
  `${note.subject.trim()}\n\n${note.content.trim()}`;

// Starts keeping the notes in notes.json in the given folder, beside the
// workspaces' own notes (see project.init).
export function init(dir: string): void {
  file = path.join(dir, FILE_NAME);
  held = null;
}

function state(): Held {
  if (held) return held;
  const fresh: Held = { model: MODEL, notes: new Map() };
  try {
    const saved = JSON.parse(fs.readFileSync(file as string, 'utf8')) as Stored;
    fresh.model = saved?.model ?? MODEL;
    for (const [key, note] of Object.entries(saved?.notes ?? {})) {
      fresh.notes.set(key, {
        ...note,
        vector: note.vector ? decode(note.vector) : undefined,
        encoded: note.vector,
      });
    }
  } catch {
    // Nothing kept yet, or nothing readable: the notes start again from none
  }
  held = fresh;
  return fresh;
}

// The notes, with vectors a search by this model can use. A change of model
// keeps the notes and drops the vectors, which the search then makes again
// (see embedMissing): a note is the one thing here that nobody can work out
// again from the files, so it outlives the model that indexed it.
function vectorsFor(model: string): Held {
  const current = state();
  if (current.model === model) return current;
  for (const [key, note] of current.notes) {
    current.notes.set(key, { ...note, hash: undefined, vector: undefined, encoded: undefined });
  }
  current.model = model;
  log.info('notes.model', { model, notes: current.notes.size });
  return current;
}

function save(): void {
  if (!file || !held) return;
  try {
    const stored: Stored = { model: held.model, notes: {} };
    for (const [key, note] of held.notes) {
      const { vector: _vector, encoded, hash, ...rest } = note;
      stored.notes[key] = encoded ? { ...rest, hash, vector: encoded } : rest;
    }
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    log.error('notes.save', { ok: false, error: (err as Error).message });
  }
}

// What a file held, for telling later whether it is the same file. Contents
// where the file is small enough to read, which is every source file; its size
// and the time it was last written otherwise. Undefined where it could not be
// read at all, which is not an error: a thread writes notes about files it has
// made in its container, and the workspace has not got those until the
// thread's changes are applied (see promote, which takes the fingerprints
// again at that point).
function fingerprint(workspace: string, relative: string): string | undefined {
  try {
    const whole = path.join(workspace, relative);
    const stat = fs.statSync(whole);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_SOURCE_BYTES) return digest(`${stat.size}:${stat.mtimeMs}`);
    return digest(fs.readFileSync(whole, 'utf8'));
  } catch {
    return undefined;
  }
}

// Where a path the model gave points, as a path relative to the top of the
// workspace. Throws, with something the model can act on, for anything that
// points outside it: a note's files are what a later check will go and read,
// so a path that leads out of the project is of no use to anybody.
function within(workspace: string, given: string): string {
  const relative = path.relative(workspace, path.resolve(workspace, given));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `"${given}" is not a path in this workspace. Give the files as paths relative to the top of it, as the ` +
        'search and read_file give them.'
    );
  }
  // One spelling per file, so that the same file named two ways is the same
  // source
  return relative.split(path.sep).join('/');
}

// The files a note says it rests on, fingerprinted as they stand now. Throws
// what within() throws; a file that is simply not there is taken down all the
// same, without a fingerprint.
export function sourcesOf(workspace: string, given: unknown): Source[] {
  if (given === undefined || given === null) return [];
  // One string where a list was asked for is taken as the list it reads as.
  // Every note refused over this in the log had given its files the way a
  // person writes them — "src/tools/sync.ts, src/sandbox/changes.ts" — which
  // names the same files the array would and costs a round to be told so. The
  // cost is a single path with a comma in its name, which would be split into
  // two that are not there and refused by within() — rarer than the refusal
  // this saves, and refused in a way that says which path it could not find.
  const list = typeof given === 'string' ? given.split(',') : given;
  if (!Array.isArray(list)) throw new Error('"files" must be a list of paths, relative to the top of the workspace.');
  const paths: string[] = [];
  for (const one of list) {
    if (typeof one !== 'string' || !one.trim()) continue;
    const relative = within(workspace, one.trim());
    if (!paths.includes(relative)) paths.push(relative);
  }
  if (paths.length > MAX_SOURCES) {
    throw new Error(
      `That note says it comes from ${paths.length} files. Keep it to ${MAX_SOURCES}: a note resting on more than ` +
        'that is about the project rather than about one thing, and wants writing as several notes.'
    );
  }
  return paths.map((relative) => ({ path: relative, digest: fingerprint(workspace, relative) }));
}

// The notes a thread works from: the workspace's, and its own on top of them.
// Newest first, which is the order a reader wants when two notes are about the
// same thing.
export function all(workspace: string, thread?: string): Note[] {
  if (!file) return [];
  const kept = [...state().notes.values()].filter(
    (note) => note.workspace === workspace && (!note.thread || note.thread === thread)
  );
  return kept
    .map(({ hash: _h, vector: _v, encoded: _e, ...note }) => note)
    .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
}

// How many a thread has to search, for what the model is told about them (see
// prompt)
export function count(workspace: string, thread?: string): number {
  return all(workspace, thread).length;
}

// Writes one down. Throws, with something the model can act on, if it cannot
// be taken; returns the note as it was kept.
//
// Writing a subject that is already there replaces that note rather than
// adding a second one, so a note can be corrected when it turns out to be
// wrong. Anything else is added, and adding is all a note ever does to its
// neighbours: several subagents write at once (see ../subagents), and nothing
// one of them writes can lose what another just wrote.
export function add(given: {
  workspace: string;
  subject: string;
  content: string;
  thread?: string;
  // The files it was worked out from, relative to the top of the workspace.
  // Fingerprinted here, as they stand, so that the note can be checked against
  // them later (see sourcesOf and drifted).
  files?: unknown;
}): Note {
  if (!file) throw new Error('Notes on workspaces are not being kept, so this one was not saved.');
  const subject = given.subject.trim();
  const content = given.content.trim();
  if (!subject) throw new Error('"subject" must be a non-empty string: a line saying what the note is about.');
  if (!content) throw new Error('"content" must be a non-empty string.');
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(
      `The subject is ${subject.length} characters. Keep it under ${MAX_SUBJECT_LENGTH}: it is a line naming what ` +
        'the note is about, and what the note says goes in "content".'
    );
  }
  if (content.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `The note is ${content.length} characters. Keep it under ${MAX_NOTE_LENGTH}: a note is one thing somebody ` +
        'can find and use on its own, so write this as several notes, one for each thing it says.'
    );
  }
  // Before anything is kept: a bad list of paths is the model's to put right,
  // and the note is refused whole rather than saved without the one thing
  // that lets it be checked afterwards
  const files = sourcesOf(given.workspace, given.files);
  const current = state();
  const note: Note = {
    workspace: given.workspace,
    thread: given.thread,
    subject,
    content,
    writtenAt: new Date().toISOString(),
    files,
  };
  const key = keyOf(note);
  const had = current.notes.get(key);
  // Unchanged text keeps its vector, so correcting a note's wording costs an
  // embedding and repeating it costs nothing
  const hash = digest(textOf(note));
  const kept = had?.hash === hash ? { ...note, hash, vector: had.vector, encoded: had.encoded } : { ...note, hash };
  current.notes.set(key, kept);
  prune(given.workspace);
  save();
  log.info('notes.add', {
    workspace: given.workspace,
    thread: given.thread,
    subject,
    chars: content.length,
    files: files.length,
    // A note nobody can check later is worth noticing, since it is the one
    // kind that can only ever be taken on trust
    unread: files.filter(({ digest: taken }) => !taken).length,
    replaced: Boolean(had),
  });
  return note;
}

// Keeps a workspace to MAX_NOTES, dropping the oldest first. What is lost is
// what has been written over most often since: the notes are corrected in
// place (see add), so an old one is one nobody has had cause to touch.
function prune(workspace: string): void {
  if (!held) return;
  const mine = [...held.notes].filter(([, note]) => note.workspace === workspace);
  if (mine.length <= MAX_NOTES) return;
  const oldest = mine.sort(([, a], [, b]) => a.writtenAt.localeCompare(b.writtenAt));
  for (const [key] of oldest.slice(0, mine.length - MAX_NOTES)) held.notes.delete(key);
  log.info('notes.prune', { workspace, dropped: mine.length - MAX_NOTES, kept: MAX_NOTES });
}

// A thread's notes become the workspace's, for when its work is written back:
// what it found out is about the project, not about the thread that found it
// out. Returns how many moved.
//
// The text does not change, so the vectors come across with them and nothing
// is embedded again. A note the workspace already had under the same subject
// is replaced by the thread's, which is the newer of the two.
//
// The files are fingerprinted again as they go. A thread writes its notes
// about the files as it has them in its container, which is not what the
// workspace held at the time; now that its changes have been written to the
// workspace, what is in the workspace is what the note describes. Taking the
// fingerprints now is the difference between a note that reads as current and
// one that reads as drifted the moment it arrives (see drifted).
export function promote(workspace: string, thread: string): number {
  if (!file) return 0;
  const current = state();
  let moved = 0;
  for (const [key, note] of [...current.notes]) {
    if (note.workspace !== workspace || note.thread !== thread) continue;
    const { thread: _thread, ...shared } = note;
    const files = shared.files.map(({ path: relative }) => ({
      path: relative,
      digest: fingerprint(workspace, relative),
    }));
    current.notes.delete(key);
    current.notes.set(keyOf(shared), { ...shared, files });
    moved++;
  }
  if (moved > 0) {
    prune(workspace);
    save();
    log.info('notes.promote', { workspace, thread, moved });
  }
  return moved;
}

// Throws one note away, by the workspace and subject it is known by, and the
// thread whose it is where it is still only that thread's (see keyOf). Returns
// whether there was one to throw.
//
// The user's, and nobody else's: a model corrects a note by writing its
// subject again (see add), and the only reason to be rid of one altogether is
// that it should never have been written — a thing worked out wrong, or a
// thing that was true of the project and has stopped being true in a way no
// drift can show. Nothing a model does here deletes a note, so this is the one
// way one goes before its workspace runs out of room for it (see prune).
export function remove(workspace: string, subject: string, thread?: string): boolean {
  if (!file) return false;
  const current = state();
  const key = keyOf({ workspace, thread, subject });
  if (!current.notes.delete(key)) return false;
  save();
  log.info('notes.remove', { workspace, thread, subject: subject.trim() });
  return true;
}

// A thread is gone, and so are the notes it had not written back. The
// workspace's own are left for the threads that share them.
export function forgetThread(thread: string): void {
  if (!file) return;
  const current = state();
  let dropped = 0;
  for (const [key, note] of [...current.notes]) {
    if (note.thread !== thread) continue;
    current.notes.delete(key);
    dropped++;
  }
  if (dropped > 0) {
    save();
    log.info('notes.forgetThread', { thread, dropped });
  }
}

// A note whose files are no longer what they were when it was written. What
// the files held is taken down as the note is (see sourcesOf), so this is a
// matter of reading them again and comparing — no model, and nothing that has
// to run while anybody is waiting.
export interface Drift extends Checked {
  note: Note;
}

// What has become of one note's files, by reading them again and comparing
// with the fingerprints taken when it was written (see sourcesOf). No model
// and no network: this is the cheap half of keeping the notes honest, and it
// is what both a search and a job that went through them all would start from.
export function check(workspace: string, note: Note): Checked {
  const found: Checked = { changed: [], gone: [], unchecked: [] };
  for (const source of note.files) {
    if (!source.digest) found.unchecked.push(source.path);
    else {
      const now = fingerprint(workspace, source.path);
      if (now === undefined) found.gone.push(source.path);
      else if (now !== source.digest) found.changed.push(source.path);
    }
  }
  return found;
}

// Whether what came back from check() is drift at all, as against a note whose
// files are where it left them or were never readable in the first place
const hasDrifted = ({ changed, gone }: Checked) => changed.length + gone.length > 0;

// The notes whose files have moved on since they were written, worst first.
//
// This is the read side of what every note takes down about where it came
// from, and what a job that keeps the notes honest would start from: each of
// these is a note worth putting in front of a model with its files, to be
// confirmed, corrected or thrown away. Nothing here does that — a note is
// never changed or dropped by this, and a note that rests on no files, or on
// files that could not be read when it was written, is not reported at all,
// because nothing is known about it either way.
export function drifted(workspace: string, thread?: string): Drift[] {
  return all(workspace, thread)
    .map((note) => ({ note, ...check(workspace, note) }))
    .filter(hasDrifted)
    .sort((a, b) => b.gone.length - a.gone.length || b.changed.length - a.changed.length);
}

// Embeds the notes that have no vector, or whose text has changed since they
// were given one. Throws what the embedder threw: a search that cannot be made
// by meaning is worth saying so rather than answering with nothing (see
// search).
async function embedMissing(entries: Entry[], signal: AbortSignal, model: string): Promise<void> {
  const stale = entries.filter((entry) => !entry.vector || entry.hash !== digest(textOf(entry)));
  if (stale.length === 0) return;
  const prefix = PREFIXES[model]?.document ?? '';
  for (let at = 0; at < stale.length; at += BATCH) {
    if (signal.aborted) break;
    const batch = stale.slice(at, at + BATCH);
    const got = await embed(
      batch.map((entry) => `${prefix}${textOf(entry)}`),
      signal,
      model
    );
    batch.forEach((entry, i) => {
      // Kept as the bytes it will be read back as, so a note scores the same
      // before and after a restart
      const encoded = encode(got[i]);
      entry.hash = digest(textOf(entry));
      entry.encoded = encoded;
      entry.vector = decode(encoded);
    });
  }
  save();
}

// The words of a query worth matching on: the ones long enough to mean
// something on their own, as in ../search/threads.ts
const words = (query: string) => [...new Set(query.toLowerCase().match(/[\w']{3,}/g) ?? [])];

// What the notes come to when the embeddings cannot be asked. A word in the
// subject counts for more than one buried in the body: the subject is what the
// note is about, and a note that mentions a word in passing is not a note on
// it.
function byWords(entries: Entry[], query: string): Hit[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  const hits: Hit[] = [];
  for (const entry of entries) {
    const subject = entry.subject.toLowerCase();
    const content = entry.content.toLowerCase();
    const inSubject = wanted.filter((word) => subject.includes(word)).length;
    const inContent = wanted.filter((word) => content.includes(word)).length;
    if (inSubject + inContent === 0) continue;
    const { hash: _hash, vector: _vector, encoded: _encoded, ...note } = entry;
    hits.push({ ...note, score: (inSubject * 2 + inContent) / (wanted.length * 3) });
  }
  return hits;
}

// The notes most like the query, most alike first.
//
// Never throws for want of an embedding: the notes are the one part of what a
// workspace knows that cannot be found out again by looking, so a search that
// cannot be made by meaning is made by words and says so, rather than failing
// and leaving the model to go and work out what somebody already wrote down.
export async function search(
  workspace: string,
  query: string,
  signal: AbortSignal,
  { thread, limit = LIMIT, model = MODEL }: { thread?: string; limit?: number; model?: string } = {}
): Promise<Found> {
  if (!file || !query.trim()) return { hits: [], by: 'meaning' };
  const current = vectorsFor(model);
  const mine = [...current.notes.values()].filter(
    (note) => note.workspace === workspace && (!note.thread || note.thread === thread)
  );
  if (mine.length === 0) return { hits: [], by: 'meaning' };

  const newest = (a: Hit, b: Hit) => b.score - a.score || b.writtenAt.localeCompare(a.writtenAt);
  // The few notes a search hands back, each marked where its files have moved
  // on since it was written. Done here rather than left to the reader because
  // a stale note read as current is worse than no note: it is believed. Only
  // what is being handed back is read, so the cost is a handful of files.
  const flagged = (hits: Hit[]) =>
    hits.map((hit) => {
      const found = check(workspace, hit);
      return hasDrifted(found) ? { ...hit, drift: found } : hit;
    });
  try {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)]);
    await embedMissing(mine, timeout, model);
    const asked = PREFIXES[model]?.query ?? '';
    const [embedded] = await embed([`${asked}${query}`], timeout, model);
    const wanted = unit(embedded);
    const hits: Hit[] = [];
    for (const entry of mine) {
      if (!entry.vector) continue;
      const score = similarity(wanted, entry.vector);
      if (score < FLOOR) continue;
      const { hash: _hash, vector: _vector, encoded: _encoded, ...note } = entry;
      hits.push({ ...note, score });
    }
    hits.sort(newest);
    // ...and then only what is in the same company as the best of them
    const best = hits[0]?.score ?? 0;
    const kept = hits.filter((hit) => hit.score >= best - SPREAD).slice(0, limit);
    return { hits: flagged(kept), by: 'meaning' };
  } catch (err) {
    if (signal.aborted) throw err;
    const why = (err as Error).message;
    log.warn('notes.search', { workspace, thread, by: 'words', error: why });
    return { hits: flagged(byWords(mine, query).sort(newest).slice(0, limit)), by: 'words', why };
  }
}

// What a model is told about the notes on its workspace. Said whether or not
// there are any yet: a workspace with none needs the first one written more
// than a workspace with fifty needs the fifty-first.
//
// What this says and what the two note tools say in their own descriptions
// used to be largely the same words, and the descriptions are the better
// place for them: they are in front of the model at the moment it picks the
// tool, where this is read once at the top. So what a note looks like — one
// per thing, under a subject, naming the files it was worked out from — is
// left to add_workspace_note, and what the search takes to search_workspace_
// notes. What is left here is what neither can say: how many notes there are,
// where they sit beside the note on the project, and why to write one at all.
export const prompt = (kept: number) => `This workspace keeps a collection of notes on itself, apart from the note
above: ${
  kept === 0
    ? 'none have been written yet, so anything you work out here is the first of them'
    : `${kept} of them so far`
}. Each is one specific thing somebody working here worked out and wrote down — how a module fits together, what a
command actually needs, the convention a directory follows, a trap and the way round it, something that does not work
and why. They are too many and too particular to put in front of you at the start of a message, so they are searched
rather than read.

Search them with search_workspace_notes before you search the code and before you read a file. What an earlier thread
established is written down there already, and the one call that finds it is worth the ten it would take you to work
it out again.

Write one with add_workspace_note the moment you make a finding, rather than at the end of the task. A finding is
anything you know about this project now that you did not know a minute ago and could not have read off the screen at
a glance; the test is whether somebody arriving tomorrow would have to do your work over again to know it, whether or
not it was what you set out to find. A search of these that came back with nothing is the surest sign of one:
whatever you then establish is what the next thread will search for in the same words and not find either.

Err on the side of writing. A note costs you one call and nothing else; not writing one costs whoever comes next the
whole of the work you just did, and they have no way of knowing it was ever done. So where you are weighing whether
a thing is worth a note, it is — write it and carry on. Several short notes are better than one long one, and a
project with a hundred notes is working as intended.

Keep the note above for what is true of the whole project; everything more particular than that belongs here.`;

// What a subagent is told about them (see ../subagents/run.ts, which says it
// to every kind that has the tools for it). The same two things the model that
// sent it is told above, in the room a subagent has for them, and worth saying
// to every kind rather than only to the one sent to explore: the command the
// tests actually need, the convention a file follows, the trap in one corner
// of it are things a subagent sent to change one thing works out on the way,
// and what it does not write down is worked out again by whoever is sent next.
// A subagent is also the case where it matters most that a note is written as
// it is worked out — a run has few rounds and can end in the middle of them,
// and what was written down is what is left of it.
export const SUBAGENT_PROMPT = `This workspace keeps a collection of notes on itself: one note per thing somebody
working here worked out and wrote down — how a module fits together, what a command actually needs, the convention a
directory follows, something that does not work and why. There are too many to put in front of you, so they are
searched rather than read.

Search them before you go looking yourself. The moment your piece of work needs something you do not know — where a
kind of thing lives, what a command takes, how the tests here are written, why something was done the way it was —
ask search_workspace_notes for it in plain words, before you search the code and before you read a file. Somebody may
have established it already, and the one call that finds their note is worth the rounds you would spend working it
out again. Where a note and the files disagree, the files are right.

Write back every finding, not only the ones that fill a gap you went looking for. The moment you know something about
this project that you did not know a minute ago — how a part of it fits together, what a command actually needs, why
it is done the way it is, something that does not work and why — write it with add_workspace_note and then carry on.
Your rounds can run out, and your results are set aside as you read them, so a finding kept for the end of your work
is one you write from memory or do not write at all.

Err on the side of writing: a note costs you one call, and not writing one costs whoever is sent next the whole of
the work you just did. Where you are weighing whether a thing is worth a note, it is.

One note per thing, with a subject naming what it is about, the files you worked it out from, and a body that
somebody who has not seen your work can use; name the files the note would be wrong about if they changed, since
those are what let it be checked later rather than believed. Write only what will still be true tomorrow, and not
what your piece of work is or how far you have got, which is what your own context note is for.`;
