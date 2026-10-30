import type { Message, Thread } from './types.js';
import { element, inflight, messagesEl } from './shared.js';
import { save } from './threads.js';
import { render } from './thread-view.js';
import { endOfTurn, attempts, reply } from './reply.js';

export const messageMenu = element('message-menu');
export const menuRetry = element<HTMLButtonElement>('menu-retry');
export const menuDelete = element<HTMLButtonElement>('menu-delete');
// What the open menu acts on
export let menuTarget: { thread: Thread; message: Message; messages: Message[] } | null = null;

// The user message whose reply this message is part of (itself, if it is one)
export function askedBy(thread: Thread, message: Message): Message | undefined {
  const upTo = thread.messages.slice(0, thread.messages.indexOf(message) + 1);
  return upTo.findLast((m) => m.role === 'user');
}

// messages: everything the entry stands for, when it is several tool calls
// shown as one
export function openMessageMenu(thread: Thread, message: Message, x: number, y: number, messages = [message]): void {
  menuTarget = { thread, message, messages };
  // Nothing in a thread can be changed while a reply is being written to it
  const busy = inflight.has(thread.id);
  menuDelete.disabled = busy;
  menuRetry.disabled = busy || !askedBy(thread, message);
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
