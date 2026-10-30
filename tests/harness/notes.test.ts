// The detail of what is known about a workspace: many small notes, searched by
// meaning when they are wanted (see ../../src/harness/notes.ts). The one note
// every message carries is tested in ./project.test.ts.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';

// The real vector maths is kept — scaling a vector to bytes and back is most of
// what decides whether a search works — and only the model is replaced, as in
// ../search/threads.test.ts.
const embedding = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('../../src/search/embeddings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/search/embeddings')>();
  return { ...real, embed: embedding.embed };
});

import * as notes from '../../src/harness/notes';

// A stand-in for the embedder: one dimension per word it knows, counting how
// often each appears. Text about the same things comes out pointing the same
// way, which is all a search needs of it.
const VOCAB = ['docker', 'image', 'parser', 'token', 'vitest', 'dialog'];
const vectorFor = (text: string) => VOCAB.map((word) => text.toLowerCase().split(word).length - 1);

const signal = () => new AbortController().signal;
const embedded = () => embedding.embed.mock.calls.flatMap(([inputs]) => inputs as string[]);

let dir: string;
// The workspace is a real folder, since a note takes down a fingerprint of
// every file it says it was worked out from (see the files a note rests on)
let workspace: string;
const put = (name: string, text: string) => {
  const whole = path.join(workspace, name);
  fs.mkdirSync(path.dirname(whole), { recursive: true });
  fs.writeFileSync(whole, text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-notes-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-notes-workspace-'));
  notes.init(dir);
  embedding.embed.mockReset();
  embedding.embed.mockImplementation(async (inputs: string[]) => inputs.map(vectorFor));
});

afterEach(() => {
  for (const folder of [dir, workspace]) fs.rmSync(folder, { recursive: true, force: true });
});

const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
const subjects = (found: { subject: string }[]) => found.map(({ subject }) => subject);

describe('writing one down', () => {
  it('keeps what it is about, what it says and when, and has it back for the asking', () => {
    const written = notes.add({ workspace, subject: '  Running the tests  ', content: '  npm test, with vitest.\n' });
    expect(written).toMatchObject({ workspace, subject: 'Running the tests', content: 'npm test, with vitest.' });
    expect(written.writtenAt).toEqual(expect.any(String));
    expect(notes.all(workspace)).toEqual([written]);
    expect(notes.count(workspace)).toBe(1);
  });

  it('survives a restart, which is the whole point of it', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test, with vitest.' });
    notes.init(dir);
    expect(subjects(notes.all(workspace))).toEqual(['Running the tests']);
  });

  it('keeps one workspace out of another', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace: '/projects/other', subject: 'Running the tests', content: 'make check.' });
    expect(notes.all(workspace)).toMatchObject([{ content: 'npm test.' }]);
    expect(notes.all('/projects/other')).toMatchObject([{ content: 'make check.' }]);
  });

  it('writes nothing down before init, rather than throwing where nobody can act on it', () => {
    notes.init(path.join(dir, 'gone', 'notes'));
    expect(notes.all(workspace)).toEqual([]);
    expect(notes.count(workspace)).toBe(0);
  });

  it.each([
    ['nothing to say', { subject: 'A thing', content: '  ' }, '"content" must be a non-empty string.'],
    ['nothing it is about', { subject: ' ', content: 'Something.' }, '"subject" must be a non-empty string'],
    [
      'a subject that is a note of its own',
      { subject: 'x'.repeat(notes.MAX_SUBJECT_LENGTH + 1), content: 'Something.' },
      `Keep it under ${notes.MAX_SUBJECT_LENGTH}`,
    ],
    [
      'more than one thing in one note',
      { subject: 'A thing', content: 'x'.repeat(notes.MAX_NOTE_LENGTH + 1) },
      'write this as several notes',
    ],
  ])('refuses %s, saying what to do instead', (_name, input, message) => {
    expect(() => notes.add({ workspace, ...input })).toThrow(message);
    expect(notes.all(workspace)).toEqual([]);
  });
});

describe('writing a subject that is already there', () => {
  it('corrects that note rather than leaving two that disagree', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace, subject: 'running the TESTS', content: 'npm test -- --run, since watch mode hangs.' });
    expect(notes.all(workspace)).toMatchObject([{ content: 'npm test -- --run, since watch mode hangs.' }]);
  });

  it('leaves the notes about other things alone', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace, subject: 'Building', content: 'npm run build.' });
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test -- --run.' });
    expect(subjects(notes.all(workspace)).sort()).toEqual(['Building', 'Running the tests']);
  });

  it('keeps the vector when the words have not changed, and makes a new one when they have', async () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'vitest.' });
    await notes.search(workspace, 'vitest', signal());
    embedding.embed.mockClear();

    // The same note again: nothing to embed but the query
    notes.add({ workspace, subject: 'Running the tests', content: 'vitest.' });
    await notes.search(workspace, 'vitest', signal());
    expect(embedded()).toHaveLength(1);

    notes.add({ workspace, subject: 'Running the tests', content: 'vitest, in watch mode.' });
    await notes.search(workspace, 'vitest', signal());
    expect(embedded()).toHaveLength(3);
  });
});

describe('the files a note rests on', () => {
  beforeEach(() => {
    put('src/parser.ts', 'export function parse() {}');
    put('src/lexer.ts', 'export function lex() {}');
  });

  it('takes down a fingerprint of each as it was when the note was written', () => {
    const written = notes.add({
      workspace,
      subject: 'The parser',
      content: 'It parses tokens.',
      files: ['src/parser.ts', 'src/lexer.ts'],
    });
    expect(written.files).toEqual([
      { path: 'src/parser.ts', digest: expect.any(String) },
      { path: 'src/lexer.ts', digest: expect.any(String) },
    ]);
    // Two files that differ have different fingerprints, which is the whole
    // use of them
    expect(written.files[0].digest).not.toBe(written.files[1].digest);
    // ...and they survive a restart with the note
    notes.init(dir);
    expect(notes.all(workspace)[0].files).toEqual(written.files);
  });

  it('names each file one way, however the model spelled it', () => {
    const written = notes.add({
      workspace,
      subject: 'The parser',
      content: 'It parses tokens.',
      files: ['./src/parser.ts', 'src/parser.ts', `${workspace}/src/parser.ts`, '  '],
    });
    expect(written.files.map(({ path: where }) => where)).toEqual(['src/parser.ts']);
  });

  it('takes down a file the workspace has not got, which a thread’s note is often about', () => {
    const written = notes.add({
      workspace,
      subject: 'The new emitter',
      content: 'Written in this thread.',
      files: ['src/emitter.ts'],
      thread: 't1',
    });
    // Named, so the note can be checked once the file is really there; no
    // fingerprint, because there was nothing to take one of
    expect(written.files).toEqual([{ path: 'src/emitter.ts', digest: undefined }]);
  });

  // Every note refused over this in the log had written its files as one
  // string, which names the same files the array would (see harness/notes.ts)
  it.each([
    ['src/parser.ts', ['src/parser.ts']],
    ['src/parser.ts, src/emitter.ts', ['src/parser.ts', 'src/emitter.ts']],
    ['src/parser.ts,src/emitter.ts', ['src/parser.ts', 'src/emitter.ts']],
  ])('reads the files given as one string (%s) as the list they read as', (files, expected) => {
    const written = notes.add({ workspace, subject: 'The parser', content: 'It parses.', files });
    expect(written.files.map(({ path }) => path)).toEqual(expected);
  });

  it('keeps a note that names no files, there being notes that rest on none', () => {
    expect(notes.add({ workspace, subject: 'Node', content: 'Node 24 is wanted.' }).files).toEqual([]);
    expect(notes.add({ workspace, subject: 'Npm', content: 'npm ci.', files: [] }).files).toEqual([]);
  });

  it.each([
    ['a path that leads out of the workspace', ['../elsewhere/secrets.ts'], 'is not a path in this workspace'],
    ['the workspace itself, which is no file', ['.'], 'is not a path in this workspace'],
    ['a list of nothing a path could be', 7, '"files" must be a list of paths'],
    ['a list given as an object', { 0: 'src/parser.ts' }, '"files" must be a list of paths'],
    [
      'more files than one note can rest on',
      Array.from({ length: notes.MAX_SOURCES + 1 }, (_, i) => `src/f${i}.ts`),
      `Keep it to ${notes.MAX_SOURCES}`,
    ],
  ])('refuses %s, and writes nothing', (_name, files, message) => {
    expect(() => notes.add({ workspace, subject: 'The parser', content: 'It parses.', files })).toThrow(message);
    expect(notes.all(workspace)).toEqual([]);
  });
});

describe('telling which notes have drifted', () => {
  const noteOn = (subject: string, files: string[], thread?: string) =>
    notes.add({ workspace, subject, content: `About ${files.join(' and ')}.`, files, thread });

  beforeEach(() => {
    put('src/parser.ts', 'export function parse() {}');
    put('src/lexer.ts', 'export function lex() {}');
  });

  it('says nothing of a note whose files are as it left them', () => {
    noteOn('The parser', ['src/parser.ts']);
    expect(notes.drifted(workspace)).toEqual([]);
  });

  it('names the files that have changed, and the note they belong to', () => {
    noteOn('The parser', ['src/parser.ts', 'src/lexer.ts']);
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    const [drift, ...rest] = notes.drifted(workspace);
    expect(rest).toEqual([]);
    expect(drift.note.subject).toBe('The parser');
    expect(drift).toMatchObject({ changed: ['src/parser.ts'], gone: [], unchecked: [] });
  });

  it('tells a file that has gone from one that has merely changed', () => {
    noteOn('The lexer', ['src/lexer.ts']);
    fs.rmSync(path.join(workspace, 'src/lexer.ts'));
    expect(notes.drifted(workspace)[0]).toMatchObject({ changed: [], gone: ['src/lexer.ts'] });
  });

  it('puts the notes whose files have gone before the ones that have only changed', () => {
    noteOn('The parser', ['src/parser.ts']);
    noteOn('The lexer', ['src/lexer.ts']);
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    fs.rmSync(path.join(workspace, 'src/lexer.ts'));
    expect(notes.drifted(workspace).map(({ note }) => note.subject)).toEqual(['The lexer', 'The parser']);
  });

  it('says nothing of a note that rests on no files, nothing being known about it either way', () => {
    notes.add({ workspace, subject: 'Node', content: 'Node 24 is wanted.' });
    put('src/parser.ts', 'changed');
    expect(notes.drifted(workspace)).toEqual([]);
  });

  it('does not call a file it never fingerprinted drifted, not knowing is not changing', () => {
    noteOn('The emitter', ['src/emitter.ts']);
    // The file arrives afterwards: the note was never checked against it, so
    // there is nothing to say it has moved on
    put('src/emitter.ts', 'export function emit() {}');
    expect(notes.drifted(workspace)).toEqual([]);
  });

  it('reports what cannot be checked alongside what has, for a note with both', () => {
    noteOn('The parser and the emitter', ['src/parser.ts', 'src/emitter.ts']);
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    expect(notes.drifted(workspace)[0]).toMatchObject({
      changed: ['src/parser.ts'],
      unchecked: ['src/emitter.ts'],
    });
  });

  it('looks at the workspace’s notes, and a thread’s own when it is asked as that thread', () => {
    noteOn('The lexer', ['src/lexer.ts'], 't1');
    put('src/lexer.ts', 'export function lex(text: string) {}');
    expect(notes.drifted(workspace)).toEqual([]);
    expect(notes.drifted(workspace, 't1').map(({ note }) => note.subject)).toEqual(['The lexer']);
  });

  it('marks a hit whose files have moved on, so a stale note is not read as current', async () => {
    noteOn('The parser', ['src/parser.ts']);
    noteOn('The lexer', ['src/lexer.ts']);
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    const { hits } = await notes.search(workspace, 'the parser and the lexer', signal());
    expect(hits.find(({ subject }) => subject === 'The parser')?.drift).toEqual({
      changed: ['src/parser.ts'],
      gone: [],
      unchecked: [],
    });
    // Nothing has happened to the other's file, so nothing is said about it
    expect(hits.find(({ subject }) => subject === 'The lexer')?.drift).toBeUndefined();
  });

  it('marks them the same way when the embeddings could not be asked', async () => {
    noteOn('The parser', ['src/parser.ts']);
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    embedding.embed.mockRejectedValue(new Error('nope'));
    const { hits, by } = await notes.search(workspace, 'parser', signal());
    expect(by).toBe('words');
    expect(hits[0].drift).toMatchObject({ changed: ['src/parser.ts'] });
  });

  it('changes nothing: a drifted note is still there to be read', () => {
    noteOn('The parser', ['src/parser.ts']);
    put('src/parser.ts', 'changed');
    notes.drifted(workspace);
    expect(notes.all(workspace)).toHaveLength(1);
    expect(notes.drifted(workspace)).toHaveLength(1);
  });

  it('takes the fingerprints again when a thread’s work goes back to the workspace', () => {
    // The thread wrote its note about a file the workspace did not have, and
    // then its changes were applied: now the workspace holds what the note
    // describes, so the note is current rather than unreadable
    noteOn('The emitter', ['src/emitter.ts'], 't1');
    put('src/emitter.ts', 'export function emit() {}');
    expect(notes.promote(workspace, 't1')).toBe(1);
    expect(notes.all(workspace)[0].files).toEqual([{ path: 'src/emitter.ts', digest: expect.any(String) }]);
    expect(notes.drifted(workspace)).toEqual([]);
  });

  it('counts a file the thread changed as current once its changes are applied', () => {
    noteOn('The parser', ['src/parser.ts'], 't1');
    // What the thread made of it, written back to the workspace
    put('src/parser.ts', 'export function parse(tokens: Token[]) {}');
    notes.promote(workspace, 't1');
    expect(notes.drifted(workspace)).toEqual([]);
  });
});

describe("a thread's own notes", () => {
  it('are the thread’s until its work goes back to the workspace, and nobody else’s meanwhile', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace, subject: 'The parser', content: 'Rewritten in this thread.', thread: 't1' });

    expect(subjects(notes.all(workspace, 't1')).sort()).toEqual(['Running the tests', 'The parser']);
    expect(subjects(notes.all(workspace))).toEqual(['Running the tests']);
    expect(subjects(notes.all(workspace, 't2'))).toEqual(['Running the tests']);
  });

  it('become the workspace’s when the thread’s changes do, without being embedded again', async () => {
    notes.add({ workspace, subject: 'The parser', content: 'Rewritten in this thread.', thread: 't1' });
    await notes.search(workspace, 'parser', signal(), { thread: 't1' });
    embedding.embed.mockClear();

    expect(notes.promote(workspace, 't1')).toBe(1);
    expect(subjects(notes.all(workspace))).toEqual(['The parser']);
    const { hits } = await notes.search(workspace, 'parser', signal());
    expect(subjects(hits)).toEqual(['The parser']);
    // Only the query: what it said has not changed, so neither has its vector
    expect(embedded()).toHaveLength(1);
  });

  it("replaces the workspace's note on the same subject, being the newer of the two", () => {
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });
    notes.add({ workspace, subject: 'The parser', content: 'Generated from a grammar now.', thread: 't1' });
    notes.promote(workspace, 't1');
    expect(notes.all(workspace)).toMatchObject([{ content: 'Generated from a grammar now.' }]);
  });

  it('go when the thread does, leaving the workspace’s for the threads that share them', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace, subject: 'The parser', content: 'Rewritten in this thread.', thread: 't1' });
    notes.add({ workspace, subject: 'The lexer', content: 'Left alone.', thread: 't2' });

    notes.forgetThread('t1');
    expect(subjects(notes.all(workspace, 't1'))).toEqual(['Running the tests']);
    expect(subjects(notes.all(workspace, 't2')).sort()).toEqual(['Running the tests', 'The lexer']);
    // And for good, not until the next restart
    notes.init(dir);
    expect(subjects(notes.all(workspace, 't1'))).toEqual(['Running the tests']);
  });

  it('are nothing to promote or forget when there are none', () => {
    expect(notes.promote(workspace, 't1')).toBe(0);
    expect(() => notes.forgetThread('t1')).not.toThrow();
  });
});

describe('throwing one away', () => {
  it('takes that note and leaves the rest, for good rather than until a restart', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });

    expect(notes.remove(workspace, 'The parser')).toBe(true);
    expect(subjects(notes.all(workspace))).toEqual(['Running the tests']);
    notes.init(dir);
    expect(subjects(notes.all(workspace))).toEqual(['Running the tests']);
    expect(Object.keys(saved().notes)).toHaveLength(1);
  });

  it('names it the way a note is known, however the subject was spelled on screen', () => {
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });
    expect(notes.remove(workspace, '  the PARSER  ')).toBe(true);
    expect(notes.all(workspace)).toEqual([]);
  });

  it('takes a thread’s own note, and leaves the workspace’s on the same subject', () => {
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });
    notes.add({ workspace, subject: 'The parser', content: 'Rewritten in this thread.', thread: 't1' });

    expect(notes.remove(workspace, 'The parser', 't1')).toBe(true);
    expect(notes.all(workspace, 't1')).toMatchObject([{ content: 'Hand-written.' }]);
  });

  it('leaves a thread’s note alone when the workspace’s is what was asked for', () => {
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });
    notes.add({ workspace, subject: 'The parser', content: 'Rewritten in this thread.', thread: 't1' });

    expect(notes.remove(workspace, 'The parser')).toBe(true);
    expect(notes.all(workspace, 't1')).toMatchObject([{ content: 'Rewritten in this thread.' }]);
    expect(notes.all(workspace)).toEqual([]);
  });

  it('leaves the same subject in another workspace, a note belonging to one of them', () => {
    notes.add({ workspace, subject: 'The parser', content: 'Hand-written.' });
    notes.add({ workspace: '/projects/other', subject: 'The parser', content: 'Somebody else’s.' });

    expect(notes.remove(workspace, 'The parser')).toBe(true);
    expect(subjects(notes.all('/projects/other'))).toEqual(['The parser']);
  });

  it('says there was nothing to throw for a note that has already gone, and keeps the file', () => {
    notes.add({ workspace, subject: 'Running the tests', content: 'npm test.' });
    expect(notes.remove(workspace, 'The parser')).toBe(false);
    expect(subjects(notes.all(workspace))).toEqual(['Running the tests']);
  });

  it('says there was nothing to throw where nothing is being kept, rather than throwing', () => {
    notes.init(path.join(dir, 'gone', 'notes'));
    expect(notes.remove(workspace, 'The parser')).toBe(false);
  });

  it('takes the vector with it, so a search cannot answer with a note that has gone', async () => {
    notes.add({ workspace, subject: 'The docker image', content: 'One image per toolchain.' });
    notes.add({ workspace, subject: 'The parser', content: 'It parses a token at a time.' });
    await notes.search(workspace, 'docker image', signal());

    notes.remove(workspace, 'The docker image');
    const { hits } = await notes.search(workspace, 'docker image', signal());
    expect(subjects(hits)).toEqual([]);
  });
});

describe('how many a workspace keeps', () => {
  it('drops the oldest once there are more than it keeps, and leaves other workspaces alone', () => {
    notes.add({ workspace: '/projects/other', subject: 'Untouched', content: 'Still here.' });
    for (let i = 0; i < notes.MAX_NOTES + 2; i++) {
      notes.add({ workspace, subject: `Thing ${i}`, content: `What thing ${i} is.` });
    }
    const kept = subjects(notes.all(workspace));
    expect(kept).toHaveLength(notes.MAX_NOTES);
    expect(kept).toContain(`Thing ${notes.MAX_NOTES + 1}`);
    expect(notes.all('/projects/other')).toHaveLength(1);
  });
});

describe('searching them', () => {
  const written = () => {
    notes.add({ workspace, subject: 'The docker image', content: 'One docker image per toolchain.' });
    notes.add({ workspace, subject: 'Running the tests', content: 'vitest, run from the top.' });
    notes.add({ workspace, subject: 'The parser', content: 'A parser of tokens, in src/parser.ts.' });
  };

  it('answers with the notes about what was asked, and not with the rest', async () => {
    written();
    const { hits, by } = await notes.search(workspace, 'which docker image is used', signal());
    expect(by).toBe('meaning');
    expect(subjects(hits)).toEqual(['The docker image']);
    expect(hits[0]).toMatchObject({ content: 'One docker image per toolchain.', score: expect.any(Number) });
  });

  it('answers with nothing when nothing is like the query, rather than with the least unlike', async () => {
    written();
    const { hits } = await notes.search(workspace, 'dialog', signal());
    expect(hits).toEqual([]);
  });

  it('embeds a note once however often it is searched for', async () => {
    written();
    await notes.search(workspace, 'docker', signal());
    const first = embedded().length;
    expect(first).toBe(4); // three notes and the query
    await notes.search(workspace, 'docker', signal());
    expect(embedded()).toHaveLength(first + 1);
  });

  it('keeps the vectors across a restart, so a search costs the same twice', async () => {
    written();
    await notes.search(workspace, 'docker', signal());
    notes.init(dir);
    embedding.embed.mockClear();
    const { hits } = await notes.search(workspace, 'which docker image is used', signal());
    expect(subjects(hits)).toEqual(['The docker image']);
    expect(embedded()).toHaveLength(1);
  });

  it('asks nothing of the embedder when there is nothing to search, or nothing asked', async () => {
    await expect(notes.search(workspace, 'docker', signal())).resolves.toEqual({ hits: [], by: 'meaning' });
    notes.add({ workspace, subject: 'The docker image', content: 'One per toolchain.' });
    await expect(notes.search(workspace, '  ', signal())).resolves.toEqual({ hits: [], by: 'meaning' });
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('searches only this workspace, and the thread’s own notes with it', async () => {
    written();
    notes.add({ workspace: '/projects/other', subject: 'Their docker image', content: 'A docker image, theirs.' });
    notes.add({
      workspace,
      subject: 'This thread’s docker work',
      content: 'A second docker image, added here.',
      thread: 't1',
    });

    const mine = await notes.search(workspace, 'docker image', signal(), { thread: 't1' });
    expect(subjects(mine.hits).sort()).toEqual(['The docker image', 'This thread’s docker work']);
    const theirs = await notes.search(workspace, 'docker image', signal(), { thread: 't2' });
    expect(subjects(theirs.hits)).toEqual(['The docker image']);
  });

  it('gives back no more than it was asked for', async () => {
    written();
    const { hits } = await notes.search(workspace, 'docker image parser vitest token', signal(), { limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe('when the embeddings cannot be asked', () => {
  beforeEach(() => {
    notes.add({ workspace, subject: 'The docker image', content: 'One docker image per toolchain.' });
    notes.add({ workspace, subject: 'Running the tests', content: 'vitest, run from the top.' });
  });

  it('matches on the words instead and says so, rather than leaving the notes unread', async () => {
    embedding.embed.mockRejectedValue(new Error('No Ollama reachable at http://localhost:11434 to embed with.'));
    const { hits, by, why } = await notes.search(workspace, 'which docker image', signal());
    expect(by).toBe('words');
    expect(why).toContain('No Ollama reachable');
    expect(subjects(hits)).toEqual(['The docker image']);
  });

  it('counts a word in the subject for more than one buried in the note', async () => {
    notes.add({ workspace, subject: 'Something else', content: 'Nothing to do with the image, except this word.' });
    embedding.embed.mockRejectedValue(new Error('nope'));
    const { hits } = await notes.search(workspace, 'image', signal());
    expect(subjects(hits)).toEqual(['The docker image', 'Something else']);
  });

  it('answers with nothing when no note has any of the words in it', async () => {
    embedding.embed.mockRejectedValue(new Error('nope'));
    await expect(notes.search(workspace, 'dialog', signal())).resolves.toMatchObject({ hits: [], by: 'words' });
  });

  it('is still a cancelled search when the caller cancelled it', async () => {
    const controller = new AbortController();
    embedding.embed.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(notes.search(workspace, 'docker', controller.signal)).rejects.toThrow('aborted');
  });
});

describe('a change of embedding model', () => {
  it('keeps the notes and makes their vectors again, there being nowhere else to get them', async () => {
    notes.add({ workspace, subject: 'The docker image', content: 'One docker image per toolchain.' });
    await notes.search(workspace, 'docker', signal());
    embedding.embed.mockClear();

    const { hits } = await notes.search(workspace, 'which docker image', signal(), { model: 'mxbai-embed-large' });
    expect(subjects(hits)).toEqual(['The docker image']);
    // The note again, with the new model, and the query
    expect(embedded()).toHaveLength(2);
    // ...and it is not embedded a third time
    embedding.embed.mockClear();
    await notes.search(workspace, 'which docker image', signal(), { model: 'mxbai-embed-large' });
    expect(embedded()).toHaveLength(1);
  });
});

describe('what the model is told about them', () => {
  it('is to search them before going looking, and to write one for every finding', () => {
    const told = unwrapped(notes.prompt(12));
    expect(told).toContain('12 of them so far');
    expect(told).toContain('Search them with search_workspace_notes before you search the code');
    expect(told).toContain('Write one with add_workspace_note the moment you make a finding');
    expect(told).toContain('rather than at the end of the task');
    // What counts as a finding, since the word otherwise means whatever the
    // model already took it to mean: the trap is a model that writes up the
    // thing it set out to learn and nothing it picked up on the way
    expect(told).toContain('could not have read off the screen at a glance');
    expect(told).toContain('whether or not it was what you set out to find');
    // ...and which of the two notes a thing belongs in
    expect(told).toContain('Keep the note above for what is true of the whole project');
  });

  it('tells it to err on the side of writing, a note costing one call and nothing else', () => {
    const told = unwrapped(notes.prompt(12));
    expect(told).toContain('Err on the side of writing');
    expect(told).toContain('where you are weighing whether a thing is worth a note, it is');
    // ...and that a lot of them is the project working, not a problem
    expect(told).toContain('a hundred notes is working as intended');
  });

  it('says the same to a subagent, in the room one has for it', () => {
    const told = unwrapped(notes.SUBAGENT_PROMPT);
    expect(told).toContain('Err on the side of writing');
    expect(told).toContain('costs whoever is sent next the whole of the work you just did');
  });

  it('is said even where there are none, a workspace with none needing the first most', () => {
    const told = unwrapped(notes.prompt(0));
    expect(told).toContain('none have been written yet');
    expect(told).toContain('search_workspace_notes');
    expect(told).toContain('add_workspace_note');
  });
});
