import type { ClassificationProblem, Message, Thread } from './types.js';
import { element } from './shared.js';
import { state, save, sourceOf } from './threads.js';
import { conversation } from './reply.js';
import { render } from './thread-view.js';
import { workspaceName, nameWorkspace } from './sidebar.js';

export const renameWorkspaceDialog = element<HTMLDialogElement>('rename-workspace-dialog');
export const workspaceNameInput = element<HTMLInputElement>('workspace-name');
export let renamingWorkspace: string | null = null;

export function openRenameWorkspace(workspace: string): void {
  renamingWorkspace = workspace;
  element('rename-workspace-path').textContent = workspace;
  workspaceNameInput.value = workspaceName(workspace);
  renameWorkspaceDialog.showModal();
  workspaceNameInput.select();
}

export function closeRenameWorkspace(name?: string): void {
  if (renamingWorkspace !== null && name !== undefined) nameWorkspace(renamingWorkspace, name);
  renamingWorkspace = null;
  renameWorkspaceDialog.close();
}

element('rename-workspace-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeRenameWorkspace(workspaceNameInput.value);
});
element('rename-workspace-reset').addEventListener('click', () => closeRenameWorkspace(''));
element('rename-workspace-cancel').addEventListener('click', () => closeRenameWorkspace());

// Rating how a message was classified: good is kept at once, bad asks what was
// wrong first. The verdict goes to a file beside the log (see feedback.ts) and
// stays on the note, which then shows it in place of the buttons.
export const feedbackDialog = element<HTMLDialogElement>('feedback-dialog');
export const feedbackForm = element<HTMLFormElement>('feedback-form');
export const feedbackSend = element<HTMLButtonElement>('feedback-send');
export let rating: { thread: Thread; note: Message } | null = null;

// The message a classification note is about: the user's one before it
export function askedOf(thread: Thread, note: Message): Message | undefined {
  return thread.messages.slice(0, thread.messages.indexOf(note)).findLast((m) => m.role === 'user');
}

export function feedbackButtons(thread: Thread, note: Message): HTMLElement {
  const span = document.createElement('span');
  span.className = 'feedback';
  if (note.feedback) {
    span.textContent = note.feedback === 'good' ? 'Rated good' : 'Rated bad';
    return span;
  }
  const thumbs = [
    ['👍', 'Good'],
    ['👎', 'Bad'],
  ] as const;
  for (const [emoji, label] of thumbs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feedback-thumb';
    button.textContent = emoji;
    button.title = label;
    button.setAttribute('aria-label', `Rate classification ${label.toLowerCase()}`);
    button.addEventListener('click', (e) => {
      // It sits in the dropdown's summary, which would otherwise open or close
      e.preventDefault();
      e.stopPropagation();
      if (label === 'Good') {
        rateClassification(thread, note, 'good');
        return;
      }
      rating = { thread, note };
      feedbackForm.reset();
      feedbackSend.disabled = true;
      feedbackDialog.showModal();
    });
    span.append(button);
  }
  return span;
}

export function rateClassification(
  thread: Thread,
  note: Message,
  verdict: 'good' | 'bad',
  problems?: ClassificationProblem[]
) {
  const asked = askedOf(thread, note);
  if (!asked?.classification) return;
  note.feedback = verdict;
  window.llm.feedback({
    rating: verdict,
    problems,
    request: asked.text,
    classification: asked.classification,
    thread: thread.id,
    // What the classifier was given for this message, so the verdict can be
    // replayed later (see feedback.ts). Built the same way as the history a
    // reply is sent with, and cut off at the message that was rated: rating an
    // older note must not hand it the turns that came after it.
    messages: conversation(thread.messages.slice(0, thread.messages.indexOf(note))),
    workspace: sourceOf(thread),
    summary: thread.summary,
  });
  save();
  if (thread.id === state.activeId) render();
}

export function chosenProblems(): ClassificationProblem[] {
  return [...feedbackForm.querySelectorAll<HTMLInputElement>('input[name="problem"]:checked')].map(
    (box) => box.value as ClassificationProblem
  );
}

// Too low and too high cannot both be so
feedbackForm.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  const other = box.value === 'too_low' ? 'too_high' : box.value === 'too_high' ? 'too_low' : undefined;
  if (box.checked && other) {
    const opposite = feedbackForm.querySelector<HTMLInputElement>(`input[value="${other}"]`);
    if (opposite) opposite.checked = false;
  }
  feedbackSend.disabled = chosenProblems().length === 0;
});
feedbackForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const problems = chosenProblems();
  if (rating && problems.length) rateClassification(rating.thread, rating.note, 'bad', problems);
  rating = null;
  feedbackDialog.close();
});
element('feedback-cancel').addEventListener('click', () => {
  rating = null;
  feedbackDialog.close();
});
