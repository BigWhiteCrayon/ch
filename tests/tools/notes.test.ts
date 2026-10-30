// The two tools the workspace's detailed notes are read and written with:
// what the model is told about them, and what calling them does. The notes
// themselves are tested in ../harness/notes.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';
import type { Tool, ToolContext } from '../../src/types';

const notes = vi.hoisted(() => ({
  add: vi.fn(),
  search: vi.fn(),
  MAX_NOTE_LENGTH: 2000,
  MAX_SUBJECT_LENGTH: 120,
  MAX_SOURCES: 20,
}));
vi.mock('../../src/harness/notes', () => notes);

import { format, registerTools, tools } from '../../src/tools/notes';

const signal = new AbortController().signal;
const context: ToolContext = { signal, threadId: 'thread-1', workspace: '/projects/demo' };
const searchNotes = tools.find((tool) => tool.name === 'search_workspace_notes') as Tool;
const addNote = tools.find((tool) => tool.name === 'add_workspace_note') as Tool;
const hit = (over: Record<string, unknown> = {}) => ({
  workspace: '/projects/demo',
  subject: 'The docker image',
  content: 'One docker image per toolchain.',
  writtenAt: '2026-10-08T09:00:00.000Z',
  files: [{ path: 'src/sandbox/docker.ts', digest: 'abc' }],
  score: 0.7,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  notes.add.mockImplementation((given: { subject: string }) => ({
    ...given,
    subject: given.subject.trim(),
    files: [],
  }));
  notes.search.mockResolvedValue({ hits: [], by: 'meaning' });
});

describe('what the model is told about them', () => {
  it('offers both only in a thread that has a workspace', () => {
    expect(tools.map(({ name, needsWorkspace }) => [name, needsWorkspace])).toEqual([
      ['search_workspace_notes', true],
      ['add_workspace_note', true],
    ]);
    // Neither is the one note every message carries, so neither is taken away
    // while a first look at the workspace is writing that one (see
    // ../../src/harness/index.ts)
    for (const tool of tools) expect(tool.writesProjectNote).toBeUndefined();
  });

  it('tells it to search them before it searches the code, and why that pays', () => {
    const told = unwrapped(searchNotes.description);
    expect(told).toContain('Use it before you search the code and before you read a file');
    expect(told).toContain('reading their note costs one call where finding it out again costs');
    expect(told).toContain('it searches by meaning');
    // A note may have gone stale, and saying so is part of the answer
    expect(told).toContain('trust the files over a note where they differ');
    expect(told).toContain('put right with add_workspace_note where it is wrong');
    expect(searchNotes.inputSchema).toMatchObject({ required: ['query'] });
  });

  it('tells it to write one note per thing, as it goes, for whoever comes next', () => {
    const told = unwrapped(addNote.description);
    expect(told).toContain('so that nobody has to work it out again');
    expect(told).toContain('the moment you have established something, rather than once the task is done');
    expect(told).toContain('One note per thing');
    expect(told).toContain('only what will still be true tomorrow');
    // Not the place for how far the task has got
    expect(told).toContain('belong in your context note for this thread');
    // Read by somebody who has not seen the work that found it out
    expect(told).toContain('read on its own by somebody who has not seen your work');
    expect(told).toContain('name files, commands and identifiers exactly as they are spelled');
    // Writing the same subject again is how a wrong note is put right
    expect(told).toContain('replaces that note');
    // ...and nothing it does can lose what another subagent wrote
    expect(told).toContain('only ever adds or corrects one note');
    expect(addNote.inputSchema).toMatchObject({ required: ['subject', 'content', 'files'] });
  });

  it('asks which files the note rests on, so that it can be checked later rather than believed', () => {
    const told = unwrapped(addNote.description);
    // Said where the files are asked for, below, rather than twice over
    expect(told).toContain('Why the files matter, and which of them to name, is under "files"');
    const { files } = (addNote.inputSchema as { properties: { files: { description: string; items: unknown } } })
      .properties;
    expect(files.items).toEqual({ type: 'string' });
    const said = unwrapped(files.description);
    expect(said).toContain('paths relative to the top of the workspace');
    expect(said).toContain(`Up to ${notes.MAX_SOURCES}`);
    // Which files to name: the ones the note stands or falls on
    expect(said).toContain('name the files the note would be wrong about if they changed');
    expect(said).toContain('not every file you happened to open');
    expect(said).toContain('Give an empty list');
  });

  it('says what a subject is for, since it is what finds the note again', () => {
    const { subject, content } = (
      addNote.inputSchema as { properties: { subject: { description: string }; content: { description: string } } }
    ).properties;
    expect(unwrapped(subject.description)).toContain('the words somebody looking for this would use');
    expect(unwrapped(subject.description)).toContain(`Under ${notes.MAX_SUBJECT_LENGTH} characters`);
    expect(unwrapped(content.description)).toContain(`Up to ${notes.MAX_NOTE_LENGTH} characters`);
    // Too long to be one note is too long because it is more than one thing
    expect(unwrapped(content.description)).toContain('it is more than one thing');
  });
});

describe('searching them', () => {
  it('searches the thread’s notes and the workspace’s, and shows what each is about', async () => {
    notes.search.mockResolvedValue({ hits: [hit(), hit({ subject: 'Running the tests', content: 'vitest.' })] });
    const output = String(await searchNotes.run({ query: 'which docker image' }, context));
    expect(notes.search).toHaveBeenCalledWith('/projects/demo', 'which docker image', signal, { thread: 'thread-1' });
    expect(output).toContain('## The docker image');
    expect(output).toContain('(written 2026-10-08)');
    expect(output).toContain('One docker image per toolchain.');
    expect(output).toContain('## Running the tests');
  });

  it('shows the files a note was worked out from, so it can be checked where it matters', async () => {
    notes.search.mockResolvedValue({ hits: [hit(), hit({ subject: 'Node', files: [] })] });
    const output = String(await searchNotes.run({ query: 'docker' }, context));
    expect(output).toContain('from: src/sandbox/docker.ts');
    // A note that rests on no file says nothing about files rather than saying
    // it has none
    expect(output.match(/^from:/gm)).toHaveLength(1);
  });

  it('says which notes are the thread’s own, those not being in the workspace yet', async () => {
    notes.search.mockResolvedValue({ hits: [hit({ thread: 'thread-1' })] });
    expect(String(await searchNotes.run({ query: 'docker' }, context))).toContain(
      '(written 2026-10-08, in this thread)'
    );
  });

  it('says that nothing has been written down, and that what is found out is worth writing', async () => {
    const output = String(await searchNotes.run({ query: 'docker' }, context));
    expect(output).toContain('No notes on that.');
    expect(unwrapped(output)).toContain('worth adding with add_workspace_note');
  });

  it.each([
    ['a query that is not text', { query: 7 }, '"query" must be a non-empty string.'],
    ['an empty query', { query: '  ' }, '"query" must be a non-empty string.'],
  ])('refuses %s', async (_name, input, message) => {
    await expect(searchNotes.run(input as Record<string, unknown>, context)).rejects.toThrow(message);
  });

  it('refuses in a thread with no workspace to search the notes of', async () => {
    await expect(searchNotes.run({ query: 'docker' }, { signal, threadId: 't' })).rejects.toThrow(
      'This thread has no workspace to search the notes of.'
    );
  });
});

describe('a note whose files have moved on since it was written', () => {
  const drift = { changed: ['src/sandbox/docker.ts'], gone: [], unchecked: [] };

  it('is marked stale, and says what to do about it rather than only that it is', () => {
    const output = unwrapped(format([hit({ drift })], 'meaning'));
    expect(output).toContain('stale: src/sandbox/docker.ts has changed since this was written');
    expect(output).toContain('Read what is there now before you rely on this');
    expect(output).toContain('put the note right with add_workspace_note if it is wrong');
    // Still given: it is the best anybody has written about this
    expect(output).toContain('One docker image per toolchain.');
  });

  it('says plainly when a file has gone, which is more than it having changed', () => {
    const gone = { changed: [], gone: ['src/sandbox/docker.ts'], unchecked: [] };
    expect(unwrapped(format([hit({ drift: gone })], 'meaning'))).toContain(
      'stale: src/sandbox/docker.ts is no longer there since this was written'
    );
    const both = { changed: ['a.ts'], gone: ['b.ts', 'c.ts'], unchecked: [] };
    expect(unwrapped(format([hit({ drift: both })], 'meaning'))).toContain(
      'stale: b.ts, c.ts are no longer there; a.ts has changed since this was written'
    );
  });

  it('leaves a note whose files are where it left them unmarked', () => {
    expect(format([hit()], 'meaning')).not.toContain('stale');
  });

  it('is marked in the tool description too, so the model knows what the mark means', () => {
    const told = unwrapped(searchNotes.description);
    expect(told).toContain('is marked "stale"');
    expect(told).toContain('has to be read against the files before you act on it');
    // ...and that the mark is not a guarantee about the ones without it
    expect(told).toContain('may be out of date, marked or not');
  });
});

describe('what a search by words instead of meaning says', () => {
  it('says why, and that there may be notes it missed', () => {
    const output = unwrapped(format([hit()], 'words', 'No Ollama reachable'));
    expect(output).toContain('the search by meaning did not answer (No Ollama reachable)');
    expect(output).toContain('there may be notes it missed');
    expect(output).toContain('## The docker image');
  });

  it('says the same of a search by words that found nothing, which is not the same as none existing', () => {
    const output = unwrapped(format([], 'words', 'No Ollama reachable'));
    expect(output).toContain('No notes on that.');
    expect(output).toContain('a note written in other words than you asked in would have been missed');
  });
});

describe('writing one down', () => {
  it('writes it as the thread’s, with its files, and says what it was filed under', () => {
    notes.add.mockReturnValue({ subject: 'The docker image', files: [{ path: 'src/sandbox/docker.ts' }] });
    expect(
      addNote.run(
        { subject: ' The docker image ', content: 'One per toolchain.', files: ['src/sandbox/docker.ts'] },
        context
      )
    ).toBe('Written down under "The docker image", from src/sandbox/docker.ts.');
    expect(notes.add).toHaveBeenCalledWith({
      workspace: '/projects/demo',
      subject: ' The docker image ',
      content: 'One per toolchain.',
      thread: 'thread-1',
      files: ['src/sandbox/docker.ts'],
    });
  });

  it('takes a note that names no files, and says that nothing will be able to check it', () => {
    notes.add.mockReturnValue({ subject: 'The docker image', files: [] });
    const said = String(addNote.run({ subject: 'The docker image', content: 'One per toolchain.' }, context));
    expect(said).toContain('Written down under "The docker image".');
    expect(unwrapped(said)).toContain('It names no files, so nothing can check it later');
    // The finding is worth more than the provenance, so it is kept either way
    expect(notes.add).toHaveBeenCalledWith(expect.objectContaining({ files: undefined }));
  });

  it('passes on what the notes themselves refuse, which the model can act on', () => {
    notes.add.mockImplementation(() => {
      throw new Error('write this as several notes');
    });
    expect(() => addNote.run({ subject: 'A thing', content: 'x' }, context)).toThrow('write this as several notes');
  });

  it.each([
    ['nothing it is about', { content: 'Something.' }, '"subject" must be a non-empty string.'],
    ['nothing to say', { subject: 'A thing' }, '"content" must be a non-empty string.'],
  ])('refuses %s before it reaches the notes', (_name, input, message) => {
    expect(() => addNote.run(input as Record<string, unknown>, context)).toThrow(message);
    expect(notes.add).not.toHaveBeenCalled();
  });

  it('refuses in a thread with no workspace to keep notes on', () => {
    expect(() => addNote.run({ subject: 'A thing', content: 'Something.' }, { signal, threadId: 't' })).toThrow(
      'This thread has no workspace to keep notes on.'
    );
  });
});

describe('registering them', () => {
  it('registers both, in the order a model is shown them', () => {
    const registry = { register: vi.fn() };
    registerTools(registry);
    expect(registry.register.mock.calls.map(([tool]) => tool.name)).toEqual([
      'search_workspace_notes',
      'add_workspace_note',
    ]);
  });
});
