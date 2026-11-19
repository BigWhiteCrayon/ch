// The roster of threads, and the messages sent from one thread to another.
//
// A thread's model can list the other threads the app is working, see what each
// one is doing, and send a message to one of them. The threads themselves live in
// the renderer, which is the only place that knows what a thread is doing right
// now — whether a reply is in progress, whether one is waiting on the user,
// whether its changes have been written back yet — so the renderer is the one
// that builds the roster and pushes it here on every save (see
// renderer/roster.ts and the 'threads:roster' channel in main.ts). A model that
// wants it reads the cache back through the tools in ./tools/threads.ts.
//
// A message to a thread does not reach the thread here: it is pushed back to the
// renderer (see deliver), which injects it into the thread's conversation the way
// a look is injected (see renderer/settings.ts, which wires 'project:looking' the
// same way). The main process is only the road the message travels on; the reply
// is started in the renderer, and it is the renderer that answers for whether a
// thread could take it.

import { BrowserWindow } from 'electron';
import * as log from './log';
import type { RosterEntry } from './types';

// The roster as the renderer last pushed it. Replaced whole on every save, which
// is what a save is: the threads are kept in the renderer, and this is the main
// process's copy of them, for a model that is not the renderer to read.
let entries: RosterEntry[] = [];

// The renderer's copy of the roster, on a save. See the top of the file.
export function set(value: RosterEntry[]): void {
  entries = value;
}

// The roster a model that is not the renderer is shown, as it stands. Every
// thread but the one asking, so that a thread asked to look at its neighbours does
// not list itself among them.
export function list(excludeId?: string): RosterEntry[] {
  return excludeId ? entries.filter((entry) => entry.id !== excludeId) : entries;
}

// Whether a thread can take a message right now: not one that is already working.
// A thread has one reply at a time, the way a reply is one request at a time
// (see the inflight map in renderer/shared.ts), so a message to a thread that is
// already working has no reply to write into. The renderer, which alone knows,
// says so when it is asked (see onInject in renderer/roster.ts); this is what the
// tool reports back.
export function busy(id: string): boolean {
  return entries.some((entry) => entry.id === id && entry.activity === 'working');
}

// Pushes a message to a thread, the way a look is pushed (see main.ts and
// renderer/settings.ts for 'project:looking'): it goes to every window, and it is
// the renderer that starts the thread's reply on it. There is no answer back: a
// thread is a conversation of its own, and the reply it makes is its own, which
// the message that started it has no part in.
export function deliver(threadId: string, text: string): void {
  log.info('roster.deliver', { thread: threadId, chars: text.length });
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('threads:inject', threadId, text);
  }
}
