// The tools a model keeps the note on its workspace with. The note itself,
// what is done with it and what the model is told about it are in
// ../harness/project.ts.
//
// There are two, because there are two sorts of writer. The model answering
// the user holds the whole note and replaces it. A subagent holds one finding
// and adds it, because several subagents run at once and a replacement from
// one would throw away what the others just wrote (see ../subagents/kind.ts).

import { MAX_NOTE_LENGTH, append, update } from '../harness/project';
import type { Tool } from '../types';

// What belongs in the note, said on the tool that adds to it. It is the same
// whichever way the note is written, so it used to be on both — but both are
// offered in the same step, which paid for it twice, and this one is the one
// that travels alone: the head explorer is given it without its sibling (see
// ../subagents/head.ts), while nothing is ever given the sibling without this.
// So the other refers to this rather than repeating it, and ../harness/project
// .prompt, which has the note in front of it, says only what a description
// cannot — a tool description is resent on every round of every request.
const PURPOSE = `The note on this project is what the next assistant in this workspace is shown at the start of every
message, so it holds the overview and nothing else: what the project is, how it is laid out, how it is built, run and
tested, and what has to be installed for any of that to work. Everything more particular than that — how a module
fits together, what a command really needs, a trap in one corner of the code — goes to add_workspace_note instead,
where it is searched for when it is wanted rather than read by everybody every time. Write to this one on your own
initiative, the moment something belonging in it changes or turns out to be wrong. It is about the project, not about
the task in hand or how far you have got — that belongs in your context note for the thread, which this is not.`;

export const tools: Tool[] = [
  {
    name: 'update_workspace_context',
    phases: ['execute'],
    needsWorkspace: true,
    writesProjectNote: true,
    description: `Write the note on this project, replacing what it said. It is shown at the start of every message
in this workspace, so it holds the overview and nothing else, and writing it is something to do on your own
initiative the moment what it says changes or turns out to be wrong. What belongs in it is in the description of
add_to_workspace_context, which adds to this same note and is offered beside this one.

In this thread the note is your own copy, having begun as the workspace's, and it goes back to the workspace when your
changes do. This overwrites it, so write the whole of it: keep everything in the current note that is still true, and
add what is missing.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: `The full, updated note, up to about 250 words.
It is refused over ${MAX_NOTE_LENGTH} characters, because every message in this workspace carries it. Keep the
particulars of any one part of the project out of it and write those down with add_workspace_note; what is left is
shortened for you if it still grows long, so do not prune what is worth keeping here to save room.`,
        },
      },
      required: ['content'],
    },
    run(input, { workspace, threadId }) {
      if (!workspace) throw new Error('This thread has no workspace to keep a note on.');
      if (typeof input?.content !== 'string') throw new Error('"content" must be a non-empty string.');
      update(workspace, input.content, threadId);
      return 'The note was updated.';
    },
  },
  {
    name: 'add_to_workspace_context',
    // As update_workspace_context above: it writes the note every message in
    // the workspace carries, which is a change to the project and not a thing
    // a step that only reads has any business doing
    phases: ['execute'],
    needsWorkspace: true,
    writesProjectNote: true,
    description: `Add a line to the note on this project, leaving the rest of it as it is. ${PURPOSE}

Write each addition so that it stands on its own and says what it is about, since it will be read by someone who has
not seen your work and has no idea what you were asked. Name the files, commands and identifiers exactly as they are
spelled. This only ever adds, so others can be writing to the note at the same time as you.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: `What you found out, in a sentence or a short paragraph, written to be read on its own. Name
the files, commands and identifiers it is about exactly as they are spelled.`,
        },
      },
      required: ['content'],
    },
    run(input, { workspace, threadId }) {
      if (!workspace) throw new Error('This thread has no workspace to keep a note on.');
      if (typeof input?.content !== 'string') throw new Error('"content" must be a non-empty string.');
      append(workspace, input.content, threadId);
      return 'Added to the note.';
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}
