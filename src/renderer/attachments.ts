import type { ToolImage } from './types.js';
import { attachButton, attachInput, attachmentsEl, composer } from './shared.js';

// The pictures the user is adding to the message they are about to send, held
// here until it goes out or the box is cleared. They are decoded once, when
// picked, and shown as thumbnails; what is sent is the base64 they were read
// into (see ToolImage). Not saved with the thread: a message that has been sent
// shows its pictures on the user's own message, and one that has not is the
// user's to drop.

// The pictures waiting to be sent, newest last
let pending: ToolImage[] = [];
// The thumbnails on screen, keyed by the picture they stand for
let thumbs = new WeakMap<HTMLImageElement, ToolImage>();

// What an attached picture is kept as: the types the model is shown, and no
// more. Anything else the box does not take.
const TAKEN = /^image\/(png|jpeg|webp)$/;

// A picture the box has not yet taken: a thumbnail that is dropped on a click
function drop(image: HTMLImageElement): void {
  const of = thumbs.get(image);
  if (of) pending = pending.filter((one) => one !== of);
  image.remove();
  if (pending.length === 0) attachmentsEl.hidden = true;
}

// Shows the pictures waiting to be sent, newest last
function draw(): void {
  attachmentsEl.replaceChildren();
  for (const image of pending) {
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = `data:${image.mediaType};base64,${image.data}`;
    thumb.alt = 'Attachment';
    thumb.title = 'Remove';
    thumbs.set(thumb, image);
    thumb.addEventListener('click', () => drop(thumb));
    attachmentsEl.append(thumb);
  }
  attachmentsEl.hidden = pending.length === 0;
}

// Reads a picked or pasted picture into base64, and adds it to what is waiting
function add(file: File): void {
  if (!TAKEN.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => {
    const data = reader.result;
    if (typeof data !== 'string') return;
    pending.push({ mediaType: file.type as ToolImage['mediaType'], data: data.replace(/^data:[^,]+,/, '') });
    draw();
  };
  reader.readAsDataURL(file);
}

// The pictures waiting to be sent, then clears the strip. Called on send: the
// box is emptied, and what was not typed is gone with it
export function take(): ToolImage[] {
  const images = pending;
  pending = [];
  thumbs = new WeakMap();
  attachmentsEl.replaceChildren();
  attachmentsEl.hidden = true;
  return images;
}

// A picture left in the box while the user goes elsewhere comes back with it
export const drafts = new Map<string, ToolImage[]>();
export function stashDraft(threadId: string): void {
  if (pending.length) drafts.set(threadId, [...pending]);
  else drafts.delete(threadId);
}
export function loadDraft(threadId: string): void {
  pending = drafts.get(threadId) ?? [];
  draw();
}
export function clearDraft(threadId: string): void {
  drafts.delete(threadId);
}

attachButton.addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  for (const file of Array.from(attachInput.files ?? [])) add(file);
  attachInput.value = '';
});

// A picture dropped on the box or pasted into it is added, as one picked is
composer.addEventListener('drop', (e) => {
  for (const file of Array.from(e.dataTransfer?.files ?? [])) add(file);
});
composer.addEventListener('dragover', (e) => e.preventDefault());
composer.addEventListener('paste', (e) => {
  for (const file of Array.from(e.clipboardData?.files ?? [])) add(file);
});
