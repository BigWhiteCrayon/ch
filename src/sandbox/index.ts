// The per-thread sandbox: a thread's own container, what it is told about it,
// and the context note it keeps there for itself. The tools a model calls to
// work in it are defined in ../tools/sandbox.ts.

import * as changes from './changes';
import * as docker from './docker';
import { withFileLock } from './lock';

// Relative to the working directory, /workspace
export const CONTEXT_FILE = `${docker.AGENT_DIR}/context.md`;

// Where one agent keeps its note. The thread's own agent has the file above;
// a subagent has one to itself, named after it, so that several at work in the
// same container at the same time cannot write over each other's or over the
// thread's (see ../subagents/run.ts).
export function contextFile(agent?: string): string {
  if (!agent) return CONTEXT_FILE;
  const named = agent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${docker.AGENT_DIR}/agents/${named || 'agent'}.md`;
}

export const PROMPT = `This thread has its own Linux container with a private, persistent filesystem. Your working
directory is ${docker.WORKDIR}, and files you create stay there for the life of the thread.

You also have a context note for this thread, shown to you at the start of every message. It is where your work is
kept: on a later message you see none of your calls and none of their results, only the conversation itself, so what
you wrote in this note is what is left of all of it. Two things belong in it — what you have found out that you could
not have known without looking, and where the work stands: the goal, what is done, what is next, and where the
relevant files are. Add them with add_to_context after every tool call, on your own initiative and without being
asked, while the result is still in front of you. save_context replaces the whole note and is for tidying it up once
it has grown long; while you are working, add to it.`;

// How the step being told the prompt below brings a change about, which
// decides what it is told about making one (see changing in
// ../harness/index.ts).
//
// 'itself' holds the tools that write, and is told to make the change in the
// files, which is what it does.
//
// 'coders' is the doing step of a coding change, which holds none of them: the
// change is made by the coders it hands the plan to (see ../harness/phases.ts).
// It is told to say what was changed, because it is the step the changes come
// out of and the words reach the user through the account it writes — but not
// to make one itself, which it cannot do. Telling it to was what had it
// reading the project over again instead of handing the plan out: the one
// instruction in front of it that it had no tool to act on was an instruction
// to edit the files, and a step reading its way towards a move that is not
// there does not stop, because it never gets to make it.
//
// 'none' is the finding-out step, which only reads: it is told neither, because
// an instruction a step cannot act on is paid for on every round and
// contradicts what the step was told it is for, which is the way the
// finding-out step used to end up making changes.
export type Changes = 'itself' | 'coders' | 'none';

// Added to the prompt for a thread that was started in a workspace.
export const workspacePrompt = (workspace: string, changes: Changes = 'none') =>
  [
    `This thread is about the workspace ${workspace} on the user's computer, and your working directory holds a copy
of it, made when the container was created. Treat what the user asks as being about those files unless it plainly is
not: find what you need in them, searching for the relevant ones and reading them rather than going on general
knowledge, and say which files and lines it came from. The path above is the user's original, which is not read from
here: the files are in your working directory, and any change of yours is only there.`,
    changes === 'itself'
      ? `When they ask for a change, make it in the files in your working directory, keeping to the conventions
already used there. So change the files rather than pasting code for the user to copy.`
      : '',
    changes === 'coders'
      ? `When they ask for a change, it is made in the files in your working directory by the coders you hand it to,
not by you: what you hand out has to say enough for the piece to be made the way the code around it is written.
Nothing here is yours to edit, and nothing is pasted into the reply for the user to copy.`
      : '',
    changes === 'none'
      ? ''
      : `Say which files you changed and what you changed in each. Leave out how the changes reach the user's
workspace: they know how to apply them.`,
    // Said to every step, the finding-out one included, since that is the step
    // whose work is only reading and so the one that had the most to say about it
    `When a request only needs reading, just answer it. Do not say that it was read-only or that nothing was
changed.`,
    // This used to be a paragraph telling the step to read again every line it
    // was about to quote, name or say it had changed, on the ground that a
    // condensed result is a note about a file rather than the file. It was said
    // to every step in a workspace, the doing step among them — the one step
    // whose own instructions are that reading is not how it starts — so the
    // prompt both told it to hand the plan out and told it to go back over the
    // files first, and the reading won. What it was guarding against is worth
    // guarding against; a line of prose asking for it on every round was not
    // the way. The finding-out step's claims are checked against the files it
    // opened instead, by the harness, which can tell (see
    // ../harness/grounding.ts). What is left here is the part a check cannot
    // make for it.
    `Where you could not check something, say so rather than leaving it to be taken as checked.`,
  ]
    .filter(Boolean)
    .join('\n\n');

// The thread's saved context note, or '' if there is none. Never creates a
// container, and never fails: without Docker there is simply no context.
export async function readContext(threadId: string | undefined, agent?: string): Promise<string> {
  try {
    if (!(await docker.ensure(threadId, { create: false }))) return '';
    const { code, output } = await docker.exec(threadId, `cat ${docker.quote(contextFile(agent))}`);
    return code === 0 ? output.trim() : '';
  } catch {
    return '';
  }
}

// Puts the thread's context note back to what it was, for an attempt whose
// messages have been thrown away (see the retry in ../renderer/message-menu.ts
// and 'thread:revert' in ../main.ts). The note is where a reply's work is
// kept, so an attempt nobody is keeping leaves its findings in front of the
// next one, reading as things established rather than as the discarded
// attempt's word for them.
//
// `was` is the note as it stood before that attempt, '' if there was none —
// in which case the file goes, rather than being left as an empty note.
// Returns whether the note is now as it was. Never throws: a note that cannot
// be put back must not stop the reply that is being asked for again.
export async function restoreContext(threadId: string | undefined, was: string, agent?: string): Promise<boolean> {
  try {
    if (!(await docker.ensure(threadId, { create: false }))) return false;
    const file = contextFile(agent);
    // Under the file's lock, like every other write to it, so that a note
    // being added as this runs is not half written over (see keepFindings)
    return await withFileLock(threadId, file, async () => {
      const text = was.trim();
      const { code } = text
        ? await docker.exec(threadId, `mkdir -p "$(dirname ${docker.quote(file)})" && cat > ${docker.quote(file)}`, {
            input: `${text}\n`,
          })
        : await docker.exec(threadId, `rm -f ${docker.quote(file)}`);
      return code === 0;
    });
  } catch {
    return false;
  }
}

// What the compactor's findings are kept under in the note, so that a later
// compaction replaces them rather than piling another copy on top: each one
// condenses the whole reply so far, the one before it included.
const CONDENSED = '## What this work has found so far (condensed from the record)';

// Keeps a compaction's findings in the thread's note.
//
// The findings are the only writing-up of a reply's tool results there is: the
// compactor made them because the results would not fit, and the message they
// were put into goes when the reply ends (see harness/compactor.ts). Without
// this they are made at cost and thrown away, and the next message starts from
// whatever the model happened to note by hand.
//
// They go in under a heading of their own, below whatever the model wrote
// itself, and replace the findings of any earlier compaction in this thread:
// each compaction reads the one before it, so two of them kept side by side
// would say the same things twice.
//
// Never throws: a note that cannot be written must not bring down the reply it
// was written for.
// agent: whose note to keep them in, where the work being condensed is a
// subagent's rather than the thread's. Its findings are its own, and writing
// them into the thread's note would put one subagent's condensed reading in
// front of every other subagent in the container (see contextFile).
export async function keepFindings(threadId: string | undefined, findings: string, agent?: string): Promise<boolean> {
  if (!findings.trim()) return false;
  try {
    if (!(await docker.ensure(threadId, { create: false }))) return false;
    const file = contextFile(agent);
    // Read and written under the file's lock, so that a note added meanwhile
    // (see add_to_context) is not written over
    return await withFileLock(threadId, file, async () => {
      const note = await readContext(threadId, agent);
      const mine = note.split(CONDENSED)[0].trimEnd();
      const whole = `${mine ? `${mine}\n\n` : ''}${CONDENSED}\n\n${findings.trim()}\n`;
      const { code } = await docker.exec(
        threadId,
        `mkdir -p "$(dirname ${docker.quote(file)})" && cat > ${docker.quote(file)}`,
        {
          input: whole,
        }
      );
      return code === 0;
    });
  } catch {
    return false;
  }
}

// What a thread has changed, and writing that back to its workspace
export { changes };
// A file in a workspace, read by the name a reply gave it (see readfile.ts)
export { readFileInWorkspace, resolveInWorkspace } from './readfile';
export * as worktree from './worktree';
export * as recipes from './recipes';
// Folders the app makes for threads that were not started in one
export * as workspaces from './workspace';

// The image a thread's container is built from, when the user has chosen one
export const configure = docker.configure;

export const setWorkspace = docker.setWorkspace;
export const remove = docker.remove;
export const stopAll = docker.stopAll;
// Where what could not be removed is written down, and what is left over from
// an earlier session cleaned up (see sweep in ./docker.ts)
export const init = docker.init;
export const sweep = docker.sweep;
