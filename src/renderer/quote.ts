import { composer, inflight, input, messagesEl } from './shared.js';
import { startOffshoot, state } from './threads.js';
import { render } from './thread-view.js';

// One quote at a time waits to be sent with the next message. The selection that may become a quote
// is kept in `pending` until the Comment button is clicked.
let pending: string | null = null;
let quote: { thread: typeof state.activeId; line: string } | null = null;

const button = document.createElement('button');
button.type = 'button';
button.id = 'quote-button';
button.textContent = 'Comment';
button.hidden = true;
document.body.appendChild(button);

// Beside it, for a reply that is finished: the comment goes into a thread of its own instead of this one
const threadButton = document.createElement('button');
threadButton.type = 'button';
threadButton.id = 'quote-thread-button';
threadButton.textContent = 'Comment in a new thread';
threadButton.hidden = true;
document.body.appendChild(threadButton);

function showChip(line: string): void {
  const text = document.querySelector('#quote-text');
  const chip = document.querySelector<HTMLElement>('#quote');
  if (text) text.textContent = line;
  if (chip) chip.hidden = false;
}

function hideChip(): void {
  const chip = document.querySelector<HTMLElement>('#quote');
  if (chip) chip.hidden = true;
}

function hideButton(): void {
  pending = null;
  button.hidden = true;
  threadButton.hidden = true;
}

function setQuote(line: string): void {
  quote = { thread: state.activeId, line };
  showChip(line);
  hideButton();
  input.focus();
}

// Whether the thread on screen has a reply on its way, which nothing can be sent to until it is done
function replying(): boolean {
  return state.activeId !== null && inflight.has(state.activeId);
}

// Quotes `line` in the comment that is written next. Where the reply is still being written the comment cannot go
// into this thread yet, so it goes into an offshoot: a thread branched off from what has been said so far, which
// the sidebar lists under this one (see startOffshoot). It can also be asked for (`inNewThread`) on a finished reply.
function comment(line: string, inNewThread = false): void {
  const thread = state.threads.find((t) => t.id === state.activeId);
  if (thread && (inNewThread || replying())) {
    startOffshoot(thread, line.replace(/^> /, ''));
    // What was selected stays behind in this thread's reply, not in the copy of it that is drawn next
    window.getSelection()?.removeAllRanges();
    render();
  }
  setQuote(line);
}

// What is selected in a reply, as where it sits in the reply. A reply being written is drawn again with every word,
// which replaces the text the selection is in, so it is put back from this (see syncQuote).
let held: { reply: number; from: number; to: number } | null = null;

function offsetOf(message: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(message);
  range.setEnd(node, offset);
  return range.toString().length;
}

// Called before the messages are drawn again
export function holdSelection(): void {
  held = null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const message = messageOf(range.startContainer);
  if (!message || message !== messageOf(range.endContainer)) return;
  const reply = Array.from(messagesEl.querySelectorAll('.message.assistant')).indexOf(message);
  if (reply < 0) return;
  held = {
    reply,
    from: offsetOf(message, range.startContainer, range.startOffset),
    to: offsetOf(message, range.endContainer, range.endOffset),
  };
}

// The text node `offset` characters into the message's text, and where in it
function pointAt(message: Element, offset: number): [Node, number] | null {
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) return [node, left];
    left -= length;
  }
  return null;
}

// Selects again what holdSelection found selected, if it is still there to be selected
function restoreSelection(): boolean {
  const was = held;
  held = null;
  const message = was && messagesEl.querySelectorAll('.message.assistant')[was.reply];
  const from = message && was && pointAt(message, was.from);
  const to = message && was && pointAt(message, was.to);
  if (!from || !to) return false;
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

// The quote for this thread, as the lines that go in front of the user's comment
export function takeQuote(): string {
  if (!quote || quote.thread !== state.activeId) return '';
  const { line } = quote;
  quote = null;
  hideChip();
  return `${line}\n\n`;
}

// Called after every render: a selection may be gone, which is put back if it can be (see holdSelection), and the
// chip belongs to one thread
export function syncQuote(): void {
  hideButton();
  if (restoreSelection()) offer();
  if (quote && quote.thread !== state.activeId) {
    quote = null;
    hideChip();
  }
}

function messageOf(node: Node): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest('.message.assistant') ?? null;
}

function inDiagram(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest('.diagram');
}

// Offers a Comment button under what is selected, if that is text inside one reply. Whether it did.
function offer(): boolean {
  if (composer.hidden) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const message = messageOf(range.startContainer);
  if (!message || message !== messageOf(range.endContainer)) return false;
  if (inDiagram(range.startContainer) || inDiagram(range.endContainer)) return false;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  pending = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  const rect = range.getBoundingClientRect();
  button.textContent = replying() ? 'Comment in a new thread' : 'Comment';
  button.style.left = `${rect.left}px`;
  button.style.top = `${rect.bottom + 4}px`;
  button.hidden = false;
  // A reply still being written has only the new thread to go to, which the one button already says
  threadButton.hidden = replying();
  threadButton.style.left = `${rect.left + button.offsetWidth + 4}px`;
  threadButton.style.top = `${rect.bottom + 4}px`;
  return true;
}

// Selecting text inside one reply offers a Comment button under the selection
messagesEl.addEventListener('mouseup', offer);

// Clicking a node or an edge of a diagram quotes it at once
messagesEl.addEventListener('click', (e) => {
  if (composer.hidden || !(e.target instanceof Element)) return;
  const part = e.target.closest('g.node, g.edge');
  const diagram = part?.closest('.diagram');
  const message = diagram?.closest('.message.assistant');
  if (!part || !diagram || !message) return;
  const n = Array.from(message.querySelectorAll('.diagram')).indexOf(diagram) + 1;
  const isNode = part.classList.contains('node');
  const label = isNode
    ? (() => {
        const id = part.getAttribute('data-node') ?? '';
        const text = Array.from(part.querySelectorAll('tspan'))
          .map((t) => t.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text) return id;
        if (id === text) return text;
        return `${id}: ${text}`;
      })()
    : (part.getAttribute('data-edge') ?? '');
  if (!label) return;
  comment(`> [diagram ${n}, ${isNode ? 'node' : 'edge'} "${label}"]`);
});

button.addEventListener('mousedown', (e) => e.preventDefault());
button.addEventListener('click', () => {
  if (pending) comment(`> ${pending}`);
});
threadButton.addEventListener('mousedown', (e) => e.preventDefault());
threadButton.addEventListener('click', () => {
  if (pending) comment(`> ${pending}`, true);
});

document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('#quote-clear')) {
    quote = null;
    hideChip();
  }
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('#quote-button, #quote-thread-button')) hideButton();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideButton();
});
// Scrolling takes the selection with it, and the button goes where it went. A reply being followed as it is written
// scrolls with every word, so hiding the button here would never let it be clicked.
messagesEl.addEventListener('scroll', () => {
  if (!button.hidden && !offer()) hideButton();
});
