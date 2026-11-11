import { composer, inflight, input, modelSelect } from './shared.js';
import { save, state } from './threads.js';
import { dropApproval } from './approvals.js';
import { dropQuestion } from './questions.js';
import { takeQuote } from './quote.js';
import { send } from './reply.js';
import { acceptSuggestion } from './suggestion.js';
import { take } from './attachments.js';

modelSelect.addEventListener('change', () => {
  state.modelChoice = modelSelect.value;
  save();
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const requestId = state.activeId ? inflight.get(state.activeId) : undefined;
  if (requestId) {
    // Only the Stop button cancels; Enter while a reply streams does nothing
    if (e.submitter) {
      window.llm.cancel(requestId);
      dropApproval(requestId);
      dropQuestion(requestId);
    }
    return;
  }
  const text = input.value.trim();
  const images = take();
  // A message is the words, the pictures, or both: neither is enough on its own
  if (!text && !images.length) return;
  input.value = '';
  input.style.height = 'auto';
  send(takeQuote() + text, images);
});

// Enter sends, Shift+Enter inserts a newline, and Tab fills in the suggested
// reply where there is one (otherwise it moves on, as it does anywhere)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  } else if (e.key === 'Tab' && !e.shiftKey && !e.isComposing && acceptSuggestion()) {
    e.preventDefault();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
});
