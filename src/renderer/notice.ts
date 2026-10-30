// One thing the app has to say, with at most one thing to do about it.
//
// It exists for the switches in the title bar that have nothing to switch
// between: Fast with no hosted model, Offline with no local one (see drawFast
// in models.ts). Greying one out and leaving it at that tells the user they
// may not do something and never why; a tooltip saying why is a tooltip
// nobody opens. So the switch stays clickable and says it here.

import { element } from './shared.js';

export const noticeDialog = element<HTMLDialogElement>('notice-dialog');
export const noticeTitle = element('notice-title');
export const noticeText = element('notice-text');
export const noticeAction = element<HTMLButtonElement>('notice-action');
export const noticeClose = element<HTMLButtonElement>('notice-close');

export interface Notice {
  title: string;
  text: string;
  // The one thing to do about it, if there is one
  action?: { label: string; run(): void };
}

// What the button showing does, kept here so the handler below is registered
// once rather than per notice
let run: (() => void) | undefined;

export function showNotice({ title, text, action }: Notice): void {
  noticeTitle.textContent = title;
  noticeText.textContent = text;
  run = action?.run;
  noticeAction.hidden = !action;
  noticeAction.textContent = action?.label ?? '';
  if (!noticeDialog.open) noticeDialog.showModal();
}

noticeClose.addEventListener('click', () => noticeDialog.close());

noticeAction.addEventListener('click', () => {
  const act = run;
  noticeDialog.close();
  // After closing: what this opens is usually another dialog, and two modal
  // dialogs at once leaves the page with nothing to go back to
  act?.();
});
