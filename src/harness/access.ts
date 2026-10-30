// Reading files on the user's own computer, which is not the same as reading
// the thread's copy of its workspace — and, at the end of this file, the one
// other thing out there the user is asked about: a command that could lose
// work.
//
// Everything else the model reads is in its container: a copy, which it can do
// what it likes with. A file outside it is the user's own, and what is in it
// is theirs to share — so the model asks (see tools/files.ts), and nothing is
// read until the user has said yes. A yes can be for this once, or for good in
// this workspace for the file or for the folder it is in. What has been said
// yes to for good is kept in the settings (see settings.ts allowRead), beside
// a list that holds for every workspace. A yes can also be for one thread
// only, which is kept here and lasts until the app is closed.
//
// Paths are compared as real paths, so a link or a ".." cannot lead out of a
// folder that was allowed.

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FileAccessAnswer, HarnessEvent } from '../types';

// Where the lists are kept. Set by the app at startup, since the settings are
// the app's and not the harness's (see ../main.ts).
export interface Allowlists {
  // Everything allowed in a workspace: the global list and the workspace's own
  readable(workspace?: string): string[];
  // Adds one file or folder to a workspace's own list
  allow(workspace: string, entry: string): void;
}

let lists: Allowlists = { readable: () => [], allow: () => undefined };

export function configure(next: Allowlists): void {
  lists = next;
}

// The real path of what the model named. "~" is the home folder, as the model
// will have seen it written; anything else not absolute is refused rather than
// guessed at from where the app happens to be running. That is the only error
// before the user is asked: a path that is not there is not an error here, or
// the model could find out what exists without asking. It comes back as the
// real path of the deepest folder that is there, with the rest after it, which
// is also what an allowed folder needs to match a file that is not there yet.
export function resolve(given: string): string {
  const named = given === '~' || given.startsWith('~/') ? path.join(os.homedir(), given.slice(1)) : given;
  if (!path.isAbsolute(named)) {
    throw new Error(
      `"${given}" is not an absolute path. Give the whole path, starting from /, or from ~ for the home folder.`
    );
  }
  const rest: string[] = [];
  let head = path.normalize(named);
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.join(head, ...rest);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

// Whether a path is the entry or inside it
const within = (entry: string, target: string) =>
  target === entry || target.startsWith(entry.endsWith(path.sep) ? entry : entry + path.sep);

// An entry as a real path where it can be one: the global list may be edited
// by hand, and a link in it would otherwise never match what is compared
function real(entry: string): string {
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

// Where a real path (see resolve) is inside the thread's own workspace, its path from the workspace's root ('' for the
// root itself); otherwise null. A thread works on a copy of its workspace, so this is the original of a file it has.
export function relativeToWorkspace(workspace: string | undefined, target: string): string | null {
  if (!workspace) return null;
  const root = real(workspace);
  return within(root, target) ? path.relative(root, target) : null;
}

// What has been allowed for one thread only, by thread id
const forThread = new Map<string, Set<string>>();

export function allowed(workspace: string | undefined, target: string, threadId?: string): boolean {
  const own = threadId ? [...(forThread.get(threadId) ?? [])] : [];
  return [...lists.readable(workspace), ...own].some((entry) => within(real(entry), target));
}

// The questions waiting on the user, by the id the question was sent with
const pending = new Map<string, (answer: FileAccessAnswer) => void>();

const ANSWERS = new Set<unknown>(['deny', 'once', 'thread', 'file', 'folder']);

// The user's answer to a 'file_access' event. Nothing happens if the question
// is no longer waiting, as when the reply was cancelled first.
export function answer(id: string, said: FileAccessAnswer): void {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(ANSWERS.has(said) ? said : 'deny');
}

// Whether the model may read this path (a real path, see resolve): at once if
// it has been allowed, otherwise when the user says so. Without a way to ask,
// or if the reply is cancelled while waiting, the answer is no.
export async function permitted(
  target: string,
  isFolder: boolean,
  {
    workspace,
    threadId,
    signal,
    emit,
  }: { workspace?: string; threadId?: string; signal: AbortSignal; emit?(event: HarnessEvent): void }
): Promise<boolean> {
  if (allowed(workspace, target, threadId)) return true;
  if (!emit || signal.aborted) return false;
  const id = randomUUID();
  const folder = isFolder ? target : path.dirname(target);
  let stop!: () => void;
  const said = await new Promise<FileAccessAnswer>((resolve) => {
    stop = () => resolve('deny');
    pending.set(id, resolve);
    signal.addEventListener('abort', stop, { once: true });
    emit({ type: 'file_access', id, path: target, folder, isFolder, canRemember: Boolean(workspace) });
  });
  signal.removeEventListener('abort', stop);
  pending.delete(id);
  // A yes for this thread needs a thread to be for: it is for what was asked, the file or the folder
  if (threadId && said === 'thread') forThread.set(threadId, (forThread.get(threadId) ?? new Set()).add(target));
  // A yes for good needs a workspace to be for good in
  if (workspace && said === 'file') lists.allow(workspace, target);
  if (workspace && said === 'folder') lists.allow(workspace, folder);
  return said !== 'deny';
}

// ---- A command the user has to allow by name
//
// Git on the user's own computer may change their repository, which is what
// the branch of a thread is worked on with (see tools/hostReading.ts). Most of
// it is the ordinary work of a branch and runs as any other command there
// does. Some of it is not: a force, a reset, a clean, a push can lose work
// that nothing here can bring back, and no reading of the command can tell the
// one that was meant from the one that was not — so the user is shown it and
// says.
//
// Nothing is remembered. A yes is for the one command, in the one folder, this
// once: the next --force is a different piece of work being overridden, and a
// list of commands allowed for good is a guardrail that goes away while nobody
// is looking.

const pendingCommands = new Map<string, (allowed: boolean) => void>();

// The user's answer to a 'command_access' event. Nothing happens if the
// question is no longer waiting, as when the reply was cancelled first.
export function allowCommand(id: string, allowed: boolean): void {
  const resolve = pendingCommands.get(id);
  if (!resolve) return;
  pendingCommands.delete(id);
  resolve(allowed === true);
}

// Whether this command may be run in this folder: only if the user says so,
// however much of the folder they have allowed before. Without a way to ask,
// or if the reply is cancelled while waiting, the answer is no — as it is for
// a look at a workspace or anything else with nobody in front of it.
export async function confirmed(
  command: string,
  path: string,
  why: string,
  { signal, emit }: { signal: AbortSignal; emit?(event: HarnessEvent): void }
): Promise<boolean> {
  if (!emit || signal.aborted) return false;
  const id = randomUUID();
  let stop!: () => void;
  const said = await new Promise<boolean>((resolve) => {
    stop = () => resolve(false);
    pendingCommands.set(id, resolve);
    signal.addEventListener('abort', stop, { once: true });
    emit({ type: 'command_access', id, command, path, why });
  });
  signal.removeEventListener('abort', stop);
  pendingCommands.delete(id);
  return said;
}
