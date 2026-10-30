// The tools a model reads and writes the workspace's detailed notes with. The
// notes themselves, how they are searched and what the model is told about
// them are in ../harness/notes.ts.
//
// Two tools, and the pair is the point: one finds what somebody already worked
// out, the other writes down what nobody had. They are the counterpart of the
// workspace note's tools (see ./context.ts) for everything too particular to
// live in a note that is read at the start of every message.

import { MAX_NOTE_LENGTH, MAX_SOURCES, MAX_SUBJECT_LENGTH, add, search, type Hit } from '../harness/notes';
import type { Tool } from '../types';

// Characters of results kept, as for the code search: enough for the few notes
// a search returns, bounded so that one long note cannot fill the window
const MAX_OUTPUT = 12000;

// What is said about a note whose files have moved on since it was written.
// The note is still given, because it is still the best anybody has written
// about this: what the warning buys is a reader who goes and looks instead of
// taking it as read, and who leaves the note better than they found it.
function stale(drift: Hit['drift']): string {
  if (!drift) return '';
  const what = [
    drift.gone.length > 0 ? `${drift.gone.join(', ')} ${drift.gone.length > 1 ? 'are' : 'is'} no longer there` : '',
    drift.changed.length > 0 ? `${drift.changed.join(', ')} has changed` : '',
  ].filter(Boolean);
  return `\nstale: ${what.join('; ')} since this was written. Read what is there now before you rely on this, and
put the note right with add_workspace_note if it is wrong.`;
}

export function format(hits: Hit[], by: 'meaning' | 'words', why?: string): string {
  if (hits.length === 0) {
    const nothing = 'No notes on that.';
    return by === 'words'
      ? `${nothing} The search by meaning did not answer (${why}), so this was a plain word match: a note written in
other words than you asked in would have been missed.`
      : `${nothing} Nobody has written down anything about it, so whatever you work out is worth adding with
add_workspace_note.`;
  }
  const notes = hits.map(({ subject, content, writtenAt, thread, files, drift }) => {
    const whose = thread ? ', in this thread' : '';
    // The files it was worked out from, so a note can be checked against them
    // where it matters rather than taken on trust (see ../harness/notes.ts)
    const from = files?.length ? `\nfrom: ${files.map(({ path }) => path).join(', ')}` : '';
    return `## ${subject}\n(written ${writtenAt.slice(0, 10)}${whose})${from}${stale(drift)}\n${content}`;
  });
  let output = notes.join('\n\n');
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[truncated]`;
  if (by === 'words') {
    output = `Note: the search by meaning did not answer (${why}), so these are plain word matches and there may be
notes it missed.\n\n${output}`;
  }
  return output;
}

export const tools: Tool[] = [
  {
    name: 'search_workspace_notes',
    needsWorkspace: true,
    description: `Search what the assistants who have worked in this workspace wrote down about it: one note per
thing they worked out, more particular than the note on the project you are shown at the start of every message.

Use it before you search the code and before you read a file. Much of what a task needs to know has been established
by somebody here already, and reading their note costs one call where finding it out again costs many. Ask in plain
words for what you need to know ("how are the tests written", "why does the build need a flag"); it searches by
meaning, so you need not guess the words the note was written in.

Returns the notes most like your query, each with what it is about, when it was written, and the files it was worked
out from. A note whose files have changed or gone since it was written is marked "stale": that one has to be read
against the files before you act on it, and put right with add_workspace_note where it is wrong. Any of them may be
out of date, marked or not, so trust the files over a note where they differ.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you need to know, described in plain words.',
        },
      },
      required: ['query'],
    },
    async run(input, { signal, threadId, workspace }) {
      if (typeof input?.query !== 'string' || !input.query.trim()) {
        throw new Error('"query" must be a non-empty string.');
      }
      if (!workspace) throw new Error('This thread has no workspace to search the notes of.');
      const { hits, by, why } = await search(workspace, input.query, signal, { thread: threadId });
      return format(hits, by, why);
    },
  },
  {
    name: 'add_workspace_note',
    needsWorkspace: true,
    description: `Write down one thing you have worked out about this workspace, so that nobody has to work it out
again. The notes outlive this thread and are what search_workspace_notes finds; whatever you established and do not
write down is lost when this thread ends.

Use it as you go, the moment you have established something, rather than once the task is done. One note per thing,
and only what will still be true tomorrow — not what the task in hand is or how far you have got, which belong in
your context note for this thread. Why the files matter, and which of them to name, is under "files" below.

Each note is read on its own by somebody who has not seen your work and knows nothing of this task, so say what it is
about and name files, commands and identifiers exactly as they are spelled. Writing a subject that is already there
replaces that note, which is how a note that has turned out to be wrong is put right.

This only ever adds or corrects one note, so others can be writing theirs at the same time as you.`,
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: `A line saying what the note is about, naming the thing itself ("how the embeddings index is
kept in step", "running the tests"). Under ${MAX_SUBJECT_LENGTH} characters, and used to find the note again, so make
it the words somebody looking for this would use.`,
        },
        content: {
          type: 'string',
          description: `What you worked out, in a sentence or a short paragraph, written to be read on its own. Up to
${MAX_NOTE_LENGTH} characters; if what you have to say is longer than that, it is more than one thing and wants
writing as more than one note.`,
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: `The files you worked this out from, as paths relative to the top of the workspace, the way the
search and read_file give them. Up to ${MAX_SOURCES}. These are what makes the note checkable later: when one of them
changes, the note can be read again against it instead of standing for ever on what was true the day you wrote it.
So name the files the note would be wrong about if they changed, not every file you happened to open. Give an empty
list for something that rests on no particular file.`,
        },
      },
      required: ['subject', 'content', 'files'],
    },
    run(input, { workspace, threadId }) {
      if (!workspace) throw new Error('This thread has no workspace to keep notes on.');
      if (typeof input?.subject !== 'string') throw new Error('"subject" must be a non-empty string.');
      if (typeof input?.content !== 'string') throw new Error('"content" must be a non-empty string.');
      // A note that names no files is taken all the same, and said to have
      // named none: the provenance is worth having, and the finding is worth
      // more. Refusing here would lose the finding to make a point.
      const note = add({
        workspace,
        subject: input.subject,
        content: input.content,
        thread: threadId,
        files: input.files,
      });
      return note.files.length > 0
        ? `Written down under "${note.subject}", from ${note.files.map(({ path }) => path).join(', ')}.`
        : `Written down under "${note.subject}". It names no files, so nothing can check it later: if it is about
particular files, write it again with them.`;
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}
