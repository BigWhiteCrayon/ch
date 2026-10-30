import type { Thread } from './types.js';
import { input } from './shared.js';
import { state } from './threads.js';
import { conversation } from './reply.js';

// What the message box says while the user has written nothing: the text they
// are offered to say next, as faint writing in place of this, and Tab fills it
// in (see composer.ts). It is the box's placeholder, so it goes the moment they
// type and comes back if they clear the box.
const PLACEHOLDER = input.placeholder;

// What each thread is offered. Not kept: a suggestion answers the reply above
// it, and is of no use once the app has been closed on.
const suggestions = new Map<string, string>();
// Threads a suggestion is being written for. A new message, or another
// suggestion, ends the wait: what arrives for the old one is thrown away.
const asking = new Map<string, object>();

// Puts the active thread's suggestion in the box, or the usual words if it has none
export function showSuggestion(): void {
  const text = state.activeId ? suggestions.get(state.activeId) : undefined;
  input.placeholder = text ?? PLACEHOLDER;
  input.classList.toggle('suggesting', text !== undefined);
}

export function dropSuggestion(thread: Thread): void {
  asking.delete(thread.id);
  if (suggestions.delete(thread.id)) showSuggestion();
}

// Asks for something the user might say after the thread's last reply, and
// offers it if there is anything. Lazy like describeThread: nothing waits for
// it, and a reply with nothing worth suggesting after it leaves the box as it is.
export async function suggestReply(thread: Thread): Promise<void> {
  dropSuggestion(thread);
  const messages = conversation(thread.messages);
  if (messages.at(-1)?.role !== 'assistant') return;
  const token = {};
  asking.set(thread.id, token);
  const result = await window.llm.suggest({ messages }).catch(() => null);
  if (asking.get(thread.id) !== token || !state.threads.includes(thread)) return;
  asking.delete(thread.id);
  if (!result?.text) return;
  suggestions.set(thread.id, result.text);
  showSuggestion();
}

// Fills the box with the suggestion, as if the user had written it, for them to
// change or send. False where there was nothing to fill it in with, or the box
// already has something in it.
export function acceptSuggestion(): boolean {
  const text = state.activeId ? suggestions.get(state.activeId) : undefined;
  if (!text || input.value) return false;
  suggestions.delete(state.activeId as string);
  input.value = text;
  showSuggestion();
  input.dispatchEvent(new Event('input'));
  input.setSelectionRange(text.length, text.length);
  return true;
}
