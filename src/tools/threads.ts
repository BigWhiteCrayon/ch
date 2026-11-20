// The two tools a thread uses to reach the other threads the app is working: one
// lists them and what each is doing, and the other sends a message to one of
// them. They are the cross-thread counterpart of the subagent tools in
// ./subagents.ts, which do the same for the subagents a thread hands its own work
// out to.
//
// The threads a model can list and message are the top-level threads of the app,
// not its subagents: a subagent is a piece of work the thread that sent it is
// waiting for, run inside the thread's own loop, so it already has its own way to
// be written to (see ../subagents/mailbox.ts). A thread is a conversation of its
// own, started by the renderer, and this is what lets a thread speak to it: to
// "tell all the threads with changes to do a thing", the thread that is asked
// lists them, reads what each one is doing, and messages the ones that match.
//
// What each one is doing is read from the roster the renderer keeps, which alone
// knows what a thread is doing right now — whether a reply is in progress,
// whether one is waiting on the user, whether the thread's changes have been
// written back yet (see ../roster.ts and ../renderer/roster.ts). The git status
// of a thread that is on a branch is read where the branch lives, here, the main
// process, and added to the roster as it is read, so a message that is sent on
// the strength of that status is not sent on a status that has moved on.
//
// A message to a thread does not bring back the thread's reply. A thread is a
// conversation of its own, and the reply it makes is its own, which the message
// that started it has no part in: the message is delivered, the thread is started
// working on it, and that is what is reported. A reply to it, if there is one,
// lives in the thread that received it, and shows in the sidebar as a thread that
// has gone on while another was on screen.

import * as worktree from '../sandbox/worktree';
import * as roster from '../roster';
import type { BranchStatus, RosterEntry, Tool } from '../types';

export const LIST_TOOL = 'list_threads';
export const SEND_TOOL = 'send_message';

// What a thread's branch stands at, in the words the thread that wrote them reads
// (see ../renderer/changes.ts, which says the same thing to the user).
function branchState(status: BranchStatus): string {
  const parts: string[] = [];
  if (status.dirty) parts.push('uncommitted changes');
  if (!status.upstream) parts.push('not pushed yet');
  else if (status.ahead === 0 && status.behind === 0) parts.push('up to date');
  else {
    if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
    if (status.behind > 0) parts.push(`${status.behind} behind`);
  }
  const tracking = status.upstream ? ` · ${status.upstream}` : '';
  return parts.join(', ') + tracking;
}

// What a thread is doing, in the words a message that is sent on its strength is
// written for. The git status of a thread that is on a branch is read fresh, so
// that a thread that has gone its own way is told as it is.
async function describe(entry: RosterEntry): Promise<string> {
  const parts: string[] = [entry.title];
  const where =
    entry.activity === 'working'
      ? 'working'
      : entry.activity === 'waiting-on-user'
        ? 'waiting on the user'
        : entry.activity === 'unread'
          ? 'finished, unread'
          : 'idle';
  parts.push(where);
  if (entry.changes > 0)
    parts.push(
      `${entry.changes} file${entry.changes === 1 ? '' : 's'} not yet written back to the workspace`
    );
  if (entry.branch) {
    // Fresh from the worktree, where the branch lives
    const status = await worktree.status(entry.branch.worktree).catch(() => null);
    parts.push(
      status
        ? ` on ${entry.branch.name}, ${branchState(status)}`
        : ` on ${entry.branch.name}, status unknown`
    );
  }
  return parts.join('; ');
}

export const tools: Tool[] = [
  {
    name: LIST_TOOL,
    description: `List the other threads the app is working, and what each one is doing.

Use it when your work reaches for a thread other than your own: when a message
asks you to "tell all the threads that have changes" to do a thing, when you have
finished a piece and want to know what the other threads are up to, or when a
thread you are asked about is not the one you are in.

Each thread is given by its activity — whether it is working, waiting on the user,
has finished and is unread, or is idle — and, where it has work to see to, by
where that work stands: whether it has files not yet written back to the
workspace, and, where it is on a branch, where that branch stands against its
upstream, which says whether a merge and a push could be done on it now or would
first need a commit or a pull.

A thread is not told its own status, since it is the one asking. What it is told
is what the threads are doing right now: a thread that is waiting on the user is
one a message would not start, and one that is already working is one a message
would not start a second reply in.`,
    inputSchema: { type: 'object', properties: {} },
    async run(_input, { threadId }) {
      const entries = roster.list(threadId);
      if (entries.length === 0) return 'There are no other threads to speak to.';
      const lines = await Promise.all(entries.map(async (entry) => `- ${await describe(entry)}`));
      return `The other threads, and what each is doing:\n\n${lines.join('\n')}`;
    },
  },
  {
    name: SEND_TOOL,
    description: `Send a message to one or more of the other threads the app is working, and start
each one's reply on it.

Use it to tell a thread that is not your own to do a thing, or to answer back to
one that spoke to you: "tell the thread on the fix-upload branch to merge from
main and push", "tell the threads that have changes to commit and push", and so
on. Name each thread by the id the list tool gives it, and say what you want it
to do in words it can act on, the way you would say it to a thread you had not
been in.

The message reaches the thread and the thread's reply is started on it. It does
not bring the reply back: a thread is a conversation of its own, and the reply it
makes is its own, which shows in the sidebar as a thread that has gone on. This
returns what was sent and to whom, and nothing more.

A thread that is already working is not sent to, and is said so in what is
returned: a thread has one reply at a time, and a message sent to a thread that is
already answering would not be answered into. A thread that is waiting on the user
can take a message, and it will be answered when the user's answer is in.`,
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'The ids of the threads to send the message to, as the list tool gives them.',
        },
        message: {
          type: 'string',
          description:
            'What to say to them, in words they can act on, written for threads that are not in your conversation.',
        },
      },
      required: ['targets', 'message'],
    },
    async run(input) {
      const targets = (input.targets ?? []) as unknown;
      const message = input.message;
      const ids = Array.isArray(targets) ? targets.filter((id): id is string => typeof id === 'string') : [];
      const text = typeof message === 'string' ? message.trim() : '';
      if (ids.length === 0) throw new Error('"targets" has to be the ids of the threads to send the message to.');
      if (!text) throw new Error('"message" has to be what you want to say to them.');

      const sent: string[] = [];
      const skipped: string[] = [];
      const none: string[] = [];
      for (const id of ids) {
        const entry = roster.list().find((one) => one.id === id);
        if (!entry) {
          none.push(id);
          continue;
        }
        if (roster.busy(id)) {
          skipped.push(`${entry.title} (already working)`);
          continue;
        }
        roster.deliver(id, text);
        sent.push(entry.title);
      }

      const lines: string[] = [];
      if (sent.length > 0) {
        const names =
          sent.length === 1
            ? sent[0]
            : sent.slice(0, -1).join(', ') + ' and ' + sent[sent.length - 1];
        lines.push(`Sent to ${names}; each is now working on it.`);
      }
      if (skipped.length > 0)
        lines.push(`Not sent to ${skipped.join(', ')}: a thread that is already working is left to it.`);
      if (none.length > 0)
        lines.push(`No such thread: ${none.join(', ')}. Look the threads up with ${LIST_TOOL}.`);
      return lines.join('\n');
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const one of tools) registry.register(one);
}
