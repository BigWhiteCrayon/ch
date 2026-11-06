import { inflight, requests, reviewing } from './shared.js';
import { state, save, addMessage } from './threads.js';
import { settings } from './settings.js';
import { endOfTurn, reply, turnOf } from './reply.js';
import { about, countdown, mergeUsage, recordUsage, usedLine } from './usage.js';
import { render } from './thread-view.js';
import type { FileAccessAnswer, HarnessEvent, Message, PendingRequest, Thread } from './types.js';

export const APPROVING = 'Waiting for your approval';

export type ApprovalEvent = Extract<HarnessEvent, { type: 'approval' }>;

// The question the harness is waiting on: a model to approve, a file on the user's computer the model wants to
// read, or a command there it wants to run that could lose work (see below). Tool calls run side by side, so
// several of either can be asked about at once; they are put one at a time, in the order they came.
export function askApproval(request: PendingRequest, event: Asked): void {
  if (event.type === 'file_access') request.fileAccess = [...(request.fileAccess ?? []), event];
  else if (event.type === 'command_access') request.commandAccess = [...(request.commandAccess ?? []), event];
  else {
    request.approval = event;
    // The harness only waits so long before going on with the lesser model, so
    // the card says how long is left of it (see approvalCard)
    request.approvalDeadline = Date.now() + event.timeoutMs;
  }
  request.message.status = APPROVING;
}

// The question of the thread's reply that is waiting on the user, if there is one: the model to approve, or else
// the first command it is waiting to run or file it is waiting to read. The command goes first of those two: it is
// the one the user is being asked to let through a guardrail, and the one a reply is most likely stuck on.
export function approvalOf(thread: Thread): Asked | undefined {
  const requestId = inflight.get(thread.id);
  const request = requestId === undefined ? undefined : requests.get(requestId);
  return request?.approval ?? request?.commandAccess?.[0] ?? request?.fileAccess?.[0];
}

// The question goes, answered or not
export function clearApproval(request: PendingRequest): void {
  delete request.approval;
  delete request.approvalDeadline;
  if (request.message.status === APPROVING && !waiting(request)) delete request.message.status;
}

// Whether anything the user was asked about is still waiting on them
const waiting = (request: PendingRequest) =>
  Boolean(request.fileAccess?.length) || Boolean(request.commandAccess?.length);

// A model reading a file on the user's computer asks first (see the 'file_access' event)
export type FileAccessEvent = Extract<HarnessEvent, { type: 'file_access' }>;

// ...and so does one running a command there that could lose work (see the 'command_access' event)
export type CommandAccessEvent = Extract<HarnessEvent, { type: 'command_access' }>;

// Everything the thread can be waiting on an answer to
export type Asked = ApprovalEvent | FileAccessEvent | CommandAccessEvent;

export function answerFileAccess(requestId: string, answer: FileAccessAnswer): void {
  const request = requests.get(requestId);
  const [asked, ...rest] = request?.fileAccess ?? [];
  if (!request || !asked) return;
  if (rest.length > 0) request.fileAccess = rest;
  else delete request.fileAccess;
  if (!request.approval && !waiting(request) && request.message.status === APPROVING) delete request.message.status;
  window.llm.allowFileAccess(asked.id, answer);
  render();
}

// The answer to the command question: this once, or not at all. Nothing is remembered either way — the next command
// like it is asked about again (see harness/access.ts).
export function answerCommandAccess(requestId: string, allowed: boolean): void {
  const request = requests.get(requestId);
  const [asked, ...rest] = request?.commandAccess ?? [];
  if (!request || !asked) return;
  if (rest.length > 0) request.commandAccess = rest;
  else delete request.commandAccess;
  if (!request.approval && !waiting(request) && request.message.status === APPROVING) delete request.message.status;
  window.llm.allowCommand(asked.id, allowed);
  render();
}

export function answerApproval(requestId: string, approved: boolean): void {
  const request = requests.get(requestId);
  if (!request?.approval) return;
  const { provider, model } = request.approval;
  clearApproval(request);
  // Kept with the message, on disk at once, so the answer is remembered if the app closes before the reply ends
  request.asked.approval = { provider, model, approved };
  save();
  window.llm.approve(requestId, approved);
  render();
}

// The request is cancelled: its question goes, unanswered. The harness is
// listening to the abort, so it needs no answer.
export function dropApproval(requestId: string): void {
  const request = requests.get(requestId);
  if (!request || (!request.approval && !waiting(request))) return;
  delete request.fileAccess;
  delete request.commandAccess;
  clearApproval(request);
  render();
}

// The question, drawn at the end of the thread it was asked in
export function approvalCard(requestId: string, event: Asked): HTMLElement {
  if (event.type === 'file_access') return fileAccessCard(requestId, event);
  if (event.type === 'command_access') return commandAccessCard(requestId, event);
  const card = document.createElement('div');
  card.className = 'message approval';
  card.setAttribute('role', 'group');
  const text = document.createElement('p');
  text.textContent =
    `${event.name} (${event.sophistication}/5) is above your approval level of ${event.ceiling}. ` +
    `Approve it, or use ${event.fallbackName}?`;
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'decline';
  decline.textContent = `Use ${event.fallbackName}`;
  decline.addEventListener('click', () => answerApproval(requestId, false));
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'approve primary';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => answerApproval(requestId, true));
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(decline, approve);
  card.append(text, actions);
  // How long the question stands. Left unanswered it answers itself, the reply
  // going on with the fallback, so the clock says what is about to happen as
  // well as when: a card the user is reading does not change under them
  // unannounced. The harness keeps the time of record (see
  // APPROVAL_TIMEOUT_MS); this only shows it.
  const deadline = requests.get(requestId)?.approvalDeadline;
  if (deadline !== undefined) {
    const timer = document.createElement('p');
    timer.className = 'deadline';
    timer.append(`Using ${event.fallbackName} in `, countdown(deadline));
    card.append(timer);
  }
  return card;
}

// The question about a file, drawn at the end of the thread it was asked in
export function fileAccessCard(requestId: string, event: FileAccessEvent): HTMLElement {
  const card = document.createElement('div');
  card.className = 'message approval file-access';
  card.setAttribute('role', 'group');
  const text = document.createElement('p');
  text.textContent = `The model wants to read ${event.isFolder ? 'the folder ' : ''}${event.path} on your computer.`;
  const button = (className: string, label: string, answer: FileAccessAnswer) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = label;
    el.addEventListener('click', () => answerFileAccess(requestId, answer));
    return el;
  };
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('decline', 'Deny', 'deny'),
    button('approve primary', 'Allow once', 'once'),
    button('approve', 'Allow for this thread', 'thread'),
    // Where the workspace is what the answer is remembered for, the two ways
    // of remembering it: just this, or everything in its folder. Both are for
    // this workspace only, so they say so (see settings.ts allowRead).
    ...(event.canRemember && event.isFolder
      ? [button('approve', `Always allow this folder in this workspace`, 'folder')]
      : event.canRemember
        ? [
            button('approve', 'Always allow this file in this workspace', 'file'),
            button('approve', `Always allow ${event.folder} in this workspace`, 'folder'),
          ]
        : [])
  );
  card.append(text, actions);
  return card;
}

// The question about a command, drawn the same way. It says what would run, where, and what is risky about it, and
// takes one answer: run it this once, or not. There is no remembering it — a yes to one command that overrides a
// guardrail is not a yes to the next (see harness/access.ts).
export function commandAccessCard(requestId: string, event: CommandAccessEvent): HTMLElement {
  const card = document.createElement('div');
  card.className = 'message approval command-access';
  card.setAttribute('role', 'group');
  const text = document.createElement('p');
  text.textContent = `The model wants to run a command in ${event.path} on your computer: ${event.why}.`;
  // The command itself, as it would be run, on a line of its own: it is the thing being agreed to, so it is not
  // folded into the sentence above where a -f could be read past.
  const what = document.createElement('p');
  what.className = 'command';
  const code = document.createElement('code');
  code.textContent = event.command;
  what.append(code);
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.className = 'decline';
  decline.textContent = "Don't run it";
  decline.addEventListener('click', () => answerCommandAccess(requestId, false));
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'approve primary';
  allow.textContent = 'Run it once';
  allow.addEventListener('click', () => answerCommandAccess(requestId, true));
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(decline, allow);
  card.append(text, what, actions);
  return card;
}

// Having the changes a reply left checked by a model at least as capable as the
// one that wrote them (see harness/verifier.ts). Offered in the thread itself
// once the reply is over and has changes waiting. A pass is a note in the
// thread; problems are put to the thread as a message of the app's, which sets
// it working on them, and the next reply's changes can be checked in turn.

// The message whose reply's changes are there to be checked: the latest one, if
// a reply to it has come and nothing has checked it since
export function reviewable(thread: Thread): Message | undefined {
  if (!thread.workspace || !thread.changes || thread.automatic || inflight.has(thread.id)) return undefined;
  const asked = thread.messages.findLast((m) => m.role === 'user');
  if (!asked?.answeredBy || asked.reviewed) return undefined;
  return turnOf(thread, asked).some((m) => m.role === 'assistant' && m.text) ? asked : undefined;
}

// With automatic review on, a reply to the user's own request is checked as soon as it is over
export function autoVerify(thread: Thread): void {
  if (!settings?.autoReview) return;
  const asked = reviewable(thread);
  if (!asked || asked.fromApp) return;
  void verifyReply(thread, asked);
}

export async function verifyReply(thread: Thread, asked: Message): Promise<void> {
  if (reviewing.has(thread.id)) return;
  reviewing.add(thread.id);
  render();
  const output = turnOf(thread, asked)
    .filter((m) => m.role === 'assistant' && m.text)
    .map((m) => m.text)
    .join('\n\n');
  const result = await window.llm
    .verify({
      thread: thread.id,
      request: asked.text,
      output,
      provider: asked.answeredBy?.provider,
      model: asked.answeredBy?.model,
      // With a workspace the changes are tried in the thread's container as well as read
      ...(thread.workspace ? { workspace: thread.workspace } : {}),
    })
    .catch((err: Error) => err);
  reviewing.delete(thread.id);
  if (!state.threads.includes(thread)) return;

  const insert = (message: Message) => thread.messages.splice(endOfTurn(thread, asked), 0, message);
  if (result instanceof Error) {
    insert({ role: 'error', text: `The review could not be made: ${result.message}` });
    save();
    render();
    return;
  }
  asked.reviewed = true;
  if (result.usage) {
    recordUsage(thread, result.usage);
    // The review is part of what the turn used: it is added to the turn's Tokens
    // note, which nothing but its usage links to the turn. The turn is over, so
    // none of it is estimated live.
    const note = turnOf(thread, asked).findLast((m) => m.role === 'note' && m.usage);
    if (note?.usage) {
      const { purpose, model, input } = result.usage;
      note.usage = mergeUsage([...note.usage, result.usage]);
      note.passes = [...(note.passes ?? []), { purpose, model, input }];
      note.text = `Tokens: ${about(usedLine(note.usage), false)}`;
    }
  }
  // Said in the note where the review did not reach every changed file, so a
  // pass is not read as a pass over all of them
  const over = result.unreviewed
    ? ` · ${result.unreviewed} ${result.unreviewed === 1 ? 'file' : 'files'} not reviewed`
    : '';
  // What the reviewer did to check them, under the note, where it tried them
  const checked = result.checked ? { summary: result.checked } : {};
  const how = result.tested ? ' · tried in the thread' : '';
  if (result.passed) {
    insert({ role: 'note', text: `Review passed · ${result.model}${how}${over}`, ...checked });
    save();
    render();
    return;
  }
  insert({ role: 'note', text: `Review found problems · ${result.model}${how}${over}`, ...checked });
  // The user has moved on while it was being checked: the problems are said, but
  // the thread is not set off on them underneath whatever it is doing now
  if (thread.messages.findLast((m) => m.role === 'user') !== asked || inflight.has(thread.id)) {
    save();
    render();
    return;
  }
  // How it found them goes too, so that the fix can be checked the same way
  const seen = result.checked ? `\n\nWhat the reviewer did to check them:\n\n${result.checked}` : '';
  const fix = addMessage(
    thread,
    'user',
    `A reviewer checked your changes against my request and found these problems:\n\n` +
      `${result.problems}${seen}\n\nFix each of them, then say what you changed.`
  );
  fix.fromApp = true;
  save();
  render();
  void reply(thread, fix);
}

// The offer, drawn at the end of the thread
export function reviewCard(thread: Thread, asked: Message): HTMLElement {
  const card = document.createElement('div');
  card.className = 'message review';
  card.setAttribute('role', 'group');
  const text = document.createElement('p');
  text.textContent =
    'Have a model at least as capable as the one that wrote these changes check them: read them, run the ' +
    "project's checks and try them in the app. If it finds problems, they go back to the thread to be fixed.";
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check primary';
  const going = reviewing.has(thread.id);
  check.disabled = going;
  check.textContent = going ? 'Reviewing…' : 'Review changes';
  check.addEventListener('click', () => void verifyReply(thread, asked));
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(check);
  card.append(text, actions);
  return card;
}
