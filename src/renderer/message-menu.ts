import type { Message, Thread } from './types.js';
import { element, inflight, messagesEl, requests } from './shared.js';
import { save, state } from './threads.js';
import { render } from './thread-view.js';
import { endOfTurn, attempts, reply } from './reply.js';
import { dropApproval } from './approvals.js';
import { dropQuestion } from './questions.js';

export const messageMenu = element('message-menu');
export const menuRetry = element<HTMLButtonElement>('menu-retry');
export const menuEdit = element<HTMLButtonElement>('menu-edit');
export const menuDelete = element<HTMLButtonElement>('menu-delete');
export const editMessageDialog = element<HTMLDialogElement>('edit-message-dialog');
const editMessageInput = element<HTMLTextAreaElement>('edit-message-input');
const editMessageHint = element('edit-message-hint');
// What the open menu acts on
export let menuTarget: { thread: Thread; message: Message; messages: Message[] } | null = null;
// The user message whose text the editor is changing, kept apart from the menu
// because the menu is closed before the dialog opens and so is gone by the time
// the dialog is saved
let editing: Message | null = null;

// The user message whose reply this message is part of (itself, if it is one)
export function askedBy(thread: Thread, message: Message): Message | undefined {
  const upTo = thread.messages.slice(0, thread.messages.indexOf(message) + 1);
  return upTo.findLast((m) => m.role === 'user');
}

// messages: everything the entry stands for, when it is several tool calls
// shown as one
export function openMessageMenu(thread: Thread, message: Message, x: number, y: number, messages = [message]): void {
  menuTarget = { thread, message, messages };
  // Nothing in a thread can be changed while a reply is being written to it,
  // so Retry and Delete are shut off then. Edit is the exception: the point of
  // it is to change the message while a reply to it is on its way or has
  // already started (see startEdit), so it is offered regardless of the thread
  // being busy, but only where there is a user message to ask again
  const busy = inflight.has(thread.id);
  const active = askedBy(thread, message);
  menuDelete.disabled = busy;
  menuRetry.disabled = busy || !active;
  menuEdit.disabled = !active;
  messageMenu.hidden = false;
  // At the pointer, pulled back in if it would run off the window
  const { offsetWidth: width, offsetHeight: height } = messageMenu;
  messageMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  messageMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
}

export function closeMessageMenu(): void {
  messageMenu.hidden = true;
  menuTarget = null;
}

// Undoes the thread's summary: the model is sent the messages themselves
// again, all of which are still here. The note that marked how far the summary
// reached goes with it.
function unsummarize(thread: Thread): void {
  delete thread.summary;
  thread.messages = thread.messages.filter((m) => m.summary === undefined);
  for (const m of thread.messages) delete m.summarized;
}

// Takes one message out of the thread, and so out of what the model is shown
menuDelete.addEventListener('click', () => {
  if (!menuTarget) return;
  const { thread, message, messages } = menuTarget;
  closeMessageMenu();
  thread.messages = thread.messages.filter((m) => !messages.includes(m));
  // Deleting the summary's note undoes the summary
  if (message.summary !== undefined) unsummarize(thread);
  save();
  // Stay where the user was reading rather than jumping to the end
  const top = messagesEl.scrollTop;
  render();
  messagesEl.scrollTop = top;
});

// Throws away the reply to a user message and asks for it again. Later
// messages in the thread are kept, and are not shown to the model.
//
// Whether the attempt that is being thrown away ended in an error. A reply
// that failed partway has still done whatever its tools did before it failed,
// and that is what the files are put back from; one that ran to the end left
// work the user may have looked over already, so its files stay where they
// are. Its context note goes back either way (see the revert below).
export function turnFailed(thread: Thread, asked: Message): boolean {
  const start = thread.messages.indexOf(asked) + 1;
  return thread.messages.slice(start, endOfTurn(thread, asked)).some((m) => m.role === 'error');
}

menuRetry.addEventListener('click', async () => {
  if (!menuTarget) return;
  const { thread, message } = menuTarget;
  closeMessageMenu();
  const asked = askedBy(thread, message);
  if (!asked) return;
  const attempt = attempts.get(asked);
  const failed = turnFailed(thread, asked);
  const start = thread.messages.indexOf(asked) + 1;
  thread.messages.splice(start, endOfTurn(thread, asked) - start);
  // A summary that reaches this message was written from the attempt being
  // thrown away as much as from the thread, and asking again withholds it from
  // this message only (see reply.ts): left standing it comes back on the next
  // message, where it is rated and answered as though the attempt had stood.
  if (asked.summarized) unsummarize(thread);
  render();

  // What the attempt left goes before the next one starts, so that the model
  // works on the project and not on what the last try made of it: the context
  // note always, and the files where the attempt failed partway. A revert of
  // the files is said in the thread rather than done quietly, because they
  // have just changed back under anyone who was watching them; the note is
  // nobody's reading but the model's, so nothing is said of it.
  if (attempt && (await window.threads.revert(thread.id, attempt, { files: failed }))) {
    thread.messages.splice(thread.messages.indexOf(asked) + 1, 0, {
      role: 'note',
      text: 'Put the files back as they were before the attempt that failed.',
    });
    render();
  }
  reply(thread, asked);
});

// Edit a message the user sent.
//
// The one path both of the cases the user was unsure about run through. A reply
// to a message can be waiting to start — sent, classified, waiting its turn for
// a model (see waitingTurn) and having done nothing of its own yet — or already
// in progress, mid-step, with files perhaps changed. In neither case does the
// thread stay as it is: the reply to the old text is thrown away and the new
// text is asked for in its place, the same as a retry (see menuRetry) but with
// the message's own text changed. The waiting case is the clean one — nothing of
// its own was done — and the in-progress case is the restart the user chose.
//
// The nudge the user left open — handing the edited text to the reply already
// running rather than throwing it away — has no seam yet: the harness's nudges
// (see the ANNOUNCED user turn in ../harness/index.ts) are the model's own, not
// the user's, and window.llm.nudge (../types.ts) is a channel that is declared
// and reaches nowhere. So it is not done here.
menuEdit.addEventListener('click', () => {
  if (!menuTarget) return;
  const { thread, message } = menuTarget;
  closeMessageMenu();
  const asked = askedBy(thread, message);
  if (!asked) return;
  startEdit(asked);
});

// The editor: the message's text in a box the user overwrites, with a line
// saying what saving will do
function startEdit(asked: Message): void {
  // A reply is on its way to the message the thread is busy, so the editor
  // says it is stopping a reply rather than just asking for one
  const thread = state.threads.find((one) => one.messages.includes(asked));
  editing = asked;
  editMessageInput.value = asked.text;
  editMessageHint.textContent = thread && inflight.has(thread.id)
    ? 'Stop the reply in progress and start over from the edited message.'
    : 'Save to start over from the edited message.';
  editMessageDialog.showModal();
  // Select the text so the user can type over it or take it in whole
  editMessageInput.focus();
  editMessageInput.select();
}

// What the editor saves: throw away the reply to the message as it is and ask
// for the new text in its place. One path for the waiting and the in-progress
// cases alike (see the menuEdit handler above).
async function commitEdit(asked: Message, text: string): Promise<void> {
  const thread = state.threads.find((one) => one.messages.includes(asked));
  if (!thread) return;
  // Scrap whatever reply is on its way to the old text, before asking for the
  // new one: the request that is waiting or in progress goes, with whatever it
  // was waiting on the user for, and its empty bubble and its own tracking. The
  // main process is listening to the abort (see llm:cancel), so it needs no
  // answer, and the 'done' event it sends is for a request that is no longer in
  // the map, so it is ignored.
  const oldId = inflight.get(thread.id);
  if (oldId) {
    dropApproval(oldId);
    dropQuestion(oldId);
    window.llm.cancel(oldId);
    requests.delete(oldId);
    inflight.delete(thread.id);
  }
  // The message is what the user meant to send, so its text is changed in place
  // and the reply to it is asked for again on the new text
  asked.text = text;
  const attempt = attempts.get(asked);
  const failed = turnFailed(thread, asked);
  const start = thread.messages.indexOf(asked) + 1;
  thread.messages.splice(start, endOfTurn(thread, asked) - start);
  if (asked.summarized) unsummarize(thread);
  render();

  // The reply that was scrapped may have left files behind, as a retry throws
  // away the attempt's own (see menuRetry): the context note always, and the
  // files where it left the work. A reply that was only waiting to start
  // changed nothing, so its revert does nothing — which is what the waiting case
  // needs.
  if (oldId && attempt && (await window.threads.revert(thread.id, attempt, { files: failed }))) {
    thread.messages.splice(thread.messages.indexOf(asked) + 1, 0, {
      role: 'note',
      text: 'Put the files back as they were before the reply that was thrown away.',
    });
    render();
  }
  reply(thread, asked);
}

// Enter saves the edit, Escape backs out, as the composer does with its box
element('edit-message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const asked = editing;
  editing = null;
  if (!asked) return;
  const text = editMessageInput.value;
  editMessageDialog.close();
  // The message is changed and asked for again only when its text has changed:
  // the box is left as it was when nothing was done
  if (text === asked.text) return;
  void commitEdit(asked, text);
});

element('edit-message-cancel').addEventListener('click', () => {
  editing = null;
  editMessageDialog.close();
});

// Anything else the user does puts the menu away
document.addEventListener('click', closeMessageMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMessageMenu();
});
window.addEventListener('blur', closeMessageMenu);
window.addEventListener('resize', closeMessageMenu);
messagesEl.addEventListener('scroll', closeMessageMenu);

// The sidebar: threads grouped by the workspace they were started in

// What a workspace is called: the name the user gave it, else its own.
// A function declaration, since the first render runs before this line
