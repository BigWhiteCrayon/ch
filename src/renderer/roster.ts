// The roster the renderer keeps, and the messages sent from one thread to it.
//
// The threads are the renderer's, and so is what they are doing: whether a reply
// is in progress, whether one is waiting on the user, whether a thread's changes
// have been written back yet. None of it is in the threads as they are saved —
// that JSON is what the model is shown, and it holds no such thing — so the
// roster is built here, from the same signals the sidebar reads them from, and
// pushed to the main process on every save, which is where a model that is not
// the renderer looks for it (see ../roster.ts and the 'threads:roster' channel
// in ../main.ts).
//
// A message a thread sends to another is pushed back to the renderer the way a
// look is pushed (see settings.ts, which wires 'project:looking' the same way),
// and it is the renderer that starts the target thread's reply on it. A thread
// that is already working has no reply to write into, so a message to such a
// thread is left to it rather than started twice (see inject).

import type { RosterEntry, Thread } from './types.js';
import { inflight, onSave } from './shared.js';
import { state } from './threads.js';
import { isWorking } from './sidebar.js';
import { approvalOf } from './approvals.js';
import { questionOf } from './questions.js';
import { reply } from './reply.js';
import { render } from './thread-view.js';

// What a thread is doing right now, read from the same signals the sidebar reads
// them from. The order matters: a thread that is waiting on the user is the one
// to be said so, since it is the kind a message would not start; a thread that
// has a reply in progress is the one a message must not start a second of.
export function activity(thread: Thread): RosterEntry['activity'] {
  if (inflight.has(thread.id) || isWorking(thread)) return 'working';
  if (approvalOf(thread) !== undefined || questionOf(thread) !== undefined) return 'waiting-on-user';
  if (thread.unread) return 'unread';
  return 'idle';
}

// The roster, as it stands: one entry a thread, every signal the model can act
// on read off the thread and the renderer's own maps, and nothing a thread does
// not already say (see RosterEntry in ../types.ts). The git status of a thread
// on a branch is read where the branch lives, the main process, when a model
// asks for it (see ../roster.ts and tools/threads.ts), and so is not in the
// roster itself: the roster is the renderer's, and git is the main process's.
export function build(): RosterEntry[] {
  return state.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    activity: activity(thread),
    changes: thread.changes ?? 0,
    ...(thread.branch ? { branch: thread.branch } : {}),
  }));
}

// The roster, pushed to the main process, which is where a model that is not the
// renderer looks for it. Called on every save, which is what a save is: the
// threads are kept in the renderer, and the main process's copy of them is kept
// in step with the save they are kept in.
export function push(): void {
  window.threads.roster(build());
}

// A message sent to a thread from another, pushed from the main process (see
// ../roster.deliver and the 'threads:inject' channel in ../preload.ts). It is
// injected into the thread's conversation the way a look is injected (see
// settings.ts): as a message the thread is asked to answer, and the reply is
// started on it, the same as when the user sends a message to the thread.
//
// A thread that is already working is left to it: a thread has one reply at a
// time (see the inflight map in shared.ts), and a second reply into a thread that
// is already answering would not be answered into but would collide with the one
// in progress. The message that started it, in the main process, is told so by
// the tool that sent it (see ../roster.busy), which reads the roster this pushes.
window.threads.onInject((threadId, text) => {
  const thread = state.threads.find((one) => one.id === threadId);
  if (!thread || inflight.has(thread.id)) return;
  void reply(thread, { role: 'user', text, fromApp: true }).then(render);
});

// The roster the main process holds is kept in step with the threads by a save,
// which is the one place every change to a thread comes through. It is run on
// every save through the hook in shared.ts rather than by the save itself, so
// that this module — which reads the threads as they stand — need not be imported
// by the one that saves them.
onSave.add(push);
