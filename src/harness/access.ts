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
import { justify } from './accessJustifier';

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

// The questions waiting on the user, by the id the question was sent with.
// Each is resolved with the answer and, on a denial, the reason the user gave
// for it, which is handed back to the model (see the tools that ask).
interface AccessAnswer {
  answer: FileAccessAnswer;
  reason?: string;
}
const pending = new Map<string, (answer: AccessAnswer) => void>();

const ANSWERS = new Set<unknown>(['deny', 'once', 'thread', 'file', 'folder']);

// The user's answer to a 'file_access' event. Nothing happens if the question
// is no longer waiting, as when the reply was cancelled first. On a denial the
// user may say why, which is kept so it can be put back to the model.
export function answer(id: string, said: FileAccessAnswer, reason?: string): void {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve({ answer: ANSWERS.has(said) ? said : 'deny', reason });
}

// Whether the model may read this path (a real path, see resolve): at once if
// it has been allowed, otherwise when the user says so. Without a way to ask,
// or if the reply is cancelled while waiting, the answer is no. What comes back
// is whether it was allowed and, where it was not, the reason the user gave, so
// the tool that asked can put it back to the model (see the error in
// ../tools/files.ts).
//
// While the user decides, the model's own reason for the access is written by a
// one-off prompt of its own (see ./accessJustifier.ts) and arrives in its own
// 'access_justification' event, so the card the user is reading can show it. It
// is not waited for: a reason is a help to the question, and the question goes
// on without one if it is not there by the time the user answers.
export async function permitted(
  target: string,
  isFolder: boolean,
  context: {
    workspace?: string;
    threadId?: string;
    signal: AbortSignal;
    emit?(event: HarnessEvent): void;
    conversation?: import('../types').ChatMessage[];
  }
): Promise<{ allowed: boolean; reason?: string }> {
  const { workspace, threadId, signal, emit, conversation } = context;
  if (allowed(workspace, target, threadId)) return { allowed: true };
  if (!emit || signal.aborted) return { allowed: false };
  const id = randomUUID();
  const folder = isFolder ? target : path.dirname(target);
  let stop!: () => void;
  // The question is asked, and the model's own reason for it is written at the
  // same moment, so it can be on the card while the user is still deciding; see
  // fireJustification, which is not waited for.
  void fireJustification(emit, id, { target, isFolder, conversation, signal });
  const said = await new Promise<AccessAnswer>((resolve) => {
    stop = () => resolve({ answer: 'deny' });
    pending.set(id, resolve);
    signal.addEventListener('abort', stop, { once: true });
    emit({ type: 'file_access', id, path: target, folder, isFolder, canRemember: Boolean(workspace) });
  });
  signal.removeEventListener('abort', stop);
  pending.delete(id);
  const { answer: saidAnswer, reason } = said;
  // A yes for this thread needs a thread to be for: it is for what was asked, the file or the folder
  if (threadId && saidAnswer === 'thread')
    forThread.set(threadId, (forThread.get(threadId) ?? new Set()).add(target));
  // A yes for good needs a workspace to be for good in
  if (workspace && saidAnswer === 'file') lists.allow(workspace, target);
  if (workspace && saidAnswer === 'folder') lists.allow(workspace, folder);
  return { allowed: saidAnswer !== 'deny', ...(reason ? { reason } : {}) };
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

// A no, and where it came from: on a denial the user may say why, which is kept
// so it can be put back to the model (see the error in ../tools/hostReading.ts)
interface CommandAnswer {
  allowed: boolean;
  reason?: string;
}
const pendingCommands = new Map<string, (answer: CommandAnswer) => void>();

// The user's answer to a 'command_access' event. Nothing happens if the
// question is no longer waiting, as when the reply was cancelled first.
export function allowCommand(id: string, allowed: boolean, reason?: string): void {
  const resolve = pendingCommands.get(id);
  if (!resolve) return;
  pendingCommands.delete(id);
  resolve({ allowed: allowed === true, ...(reason ? { reason } : {}) });
}

// Whether this command may be run in this folder: only if the user says so,
// however much of the folder they have allowed before. Without a way to ask,
// or if the reply is cancelled while waiting, the answer is no — as it is for
// a look at a workspace or anything else with nobody in front of it. As with a
// file (see permitted), the model's reason for wanting to run it is written for
// the card as it waits, and a denial may carry the reason the user gave.
export async function confirmed(
  command: string,
  folderPath: string,
  why: string,
  context: {
    signal: AbortSignal;
    emit?(event: HarnessEvent): void;
    conversation?: import('../types').ChatMessage[];
  }
): Promise<{ allowed: boolean; reason?: string }> {
  const { signal, emit, conversation } = context;
  if (!emit || signal.aborted) return { allowed: false };
  const id = randomUUID();
  let stop!: () => void;
  // As in permitted: the question is asked and the reason is written at once, so
  // it can be on the card while the user is deciding.
  void fireJustification(emit, id, { target: folderPath, isFolder: true, command, why, conversation, signal });
  const said = await new Promise<CommandAnswer>((resolve) => {
    stop = () => resolve({ allowed: false });
    pendingCommands.set(id, resolve);
    signal.addEventListener('abort', stop, { once: true });
    emit({ type: 'command_access', id, command, path: folderPath, why });
  });
  signal.removeEventListener('abort', stop);
  pendingCommands.delete(id);
  return said;
}

// ---- The reason the model is after the access, shown on the card
//
// The card shows what the model wants and asks the user to allow it; what it
// cannot see is why the model wants it, which is the thing the user is judging.
// A one-off prompt of its own writes it from the conversation (see
// ./accessJustifier.ts) and, where one is written, it is put back to the card in
// its own 'access_justification' event. It is not part of the question the user
// must answer — a denial stands without it — so it is made in the background and
// the question is shown at once.
//
// The justification is not waited for, and it is not held if the question is
// already gone: a reason with no card to show it on, as when the reply has moved
// on or the user has answered first, is not worth keeping, so nothing is saved
// for a late one. It is also not part of the reply's own path: an error writing
// the reason is not an error in reading the file, so it is swallowed.
export async function fireJustification(
  emit: ((event: HarnessEvent) => void) | undefined,
  id: string,
  request: {
    target: string;
    isFolder: boolean;
    command?: string;
    why?: string;
    conversation?: import('../types').ChatMessage[];
    signal: AbortSignal;
  }
): Promise<void> {
  if (!emit || request.signal.aborted) return;
  const reason = await justify({ ...request, signal: request.signal });
  // Where the reason was written, put it back to the card by the question's id.
  // A late reason, the card being gone by then, is left where it is.
  if (reason) emit({ type: 'access_justification', id, justification: reason });
}

