import { inflight, requests } from './shared.js';
import { save } from './threads.js';
import { interject } from './events.js';
import { render } from './thread-view.js';
import type { HarnessEvent, PendingRequest, Thread } from './types.js';

export const ASKING = 'Waiting for your answer';

export type QuestionEvent = Extract<HarnessEvent, { type: 'question' }>;

export function askQuestion(request: PendingRequest, event: QuestionEvent): void {
  request.question = event;
  request.message.status = ASKING;
}

// The question of the thread's reply that is waiting on the user, if there is one
export function questionOf(thread: Thread): QuestionEvent | undefined {
  const requestId = inflight.get(thread.id);
  return requestId === undefined ? undefined : requests.get(requestId)?.question;
}

// The question goes, answered or not
export function clearQuestion(request: PendingRequest): void {
  delete request.question;
  if (request.message.status === ASKING) delete request.message.status;
}

export function answerQuestion(requestId: string, answer: string): void {
  const request = requests.get(requestId);
  const asked = request?.question;
  if (!request || !asked || !answer.trim()) return;
  clearQuestion(request);
  window.llm.answer(requestId, answer);
  // The exchange stays in the thread, where the question card was
  interject(request.thread, request, { role: 'note', text: `Asked: ${asked.question}\nYou answered: ${answer}` });
  save();
  render();
}

// The request is cancelled: its question goes, unanswered. The harness is
// listening to the abort, so it needs no answer.
export function dropQuestion(requestId: string): void {
  const request = requests.get(requestId);
  if (!request?.question) return;
  clearQuestion(request);
  render();
}

// The question, drawn at the end of the thread it was asked in
export function questionCard(requestId: string, event: QuestionEvent): HTMLElement {
  const card = document.createElement('div');
  card.className = 'message question';
  card.setAttribute('role', 'group');
  const text = document.createElement('p');
  text.textContent = event.question;
  card.append(text);
  if (event.options.length) {
    const options = document.createElement('div');
    options.className = 'options';
    for (const option of event.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option';
      button.textContent = option;
      button.addEventListener('click', () => answerQuestion(requestId, option));
      options.append(button);
    }
    card.append(options);
  }
  const other = document.createElement('input');
  other.type = 'text';
  other.className = 'other';
  // The 'or' divider already marks the free-text box as a second way to answer, so it need not say so again.
  other.placeholder = 'Answer in your own words…';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'send primary';
  send.textContent = 'Send';
  send.disabled = true;
  other.addEventListener('input', () => {
    send.disabled = !other.value.trim();
  });
  other.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    answerQuestion(requestId, other.value.trim());
  });
  send.addEventListener('click', () => answerQuestion(requestId, other.value.trim()));
  // The 'or' between the options and the free-text box marks it as a second way to answer,
  // not just another option: only when there are options to pick.
  if (event.options.length) {
    const or = document.createElement('div');
    or.className = 'answer-or';
    or.textContent = 'or';
    card.append(or);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(other, send);
  card.append(actions);
  return card;
}
