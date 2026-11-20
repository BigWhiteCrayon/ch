// The Review queue: one place for everything that is waiting on the user.
//
// Two kinds of thing live in it. The first is a question the harness put to the
// user that nobody has answered yet — a model above the approval level, a file on
// the user's computer it wants to read, a command there it wants to run, or a
// plain question the model asked. Those are the actions a reply is blocked on, so
// they are answerable right here in the queue, the same cards that sit at the end
// of the thread they were asked in. The second is a reply that has finished while
// the user was away, left marked unread: it is the thing that needs a look, with
// a button to open the thread and, for a thread that changed files, the diff it
// left.
//
// The cards are the cards the thread itself draws — approvalCard and questionCard
// — so that answering one answers it everywhere. What is left to this module is
// only to gather them, to keep the badge up to date, and to re-draw when an
// answer is given from here.
import { element, inflight, requests } from './shared.js';
import { state, activate } from './threads.js';
import { render } from './thread-view.js';
import { needingUser, onBadge } from './events.js';
import { approvalCard } from './approvals.js';
import type { Asked } from './approvals.js';
import { questionCard } from './questions.js';
import { diffRows } from './changes.js';
import type { Thread, FileChange } from './types.js';

// The button that opens the queue, and the count it carries
const reviewButton = element('open-review');
const reviewCount = element('review-count');
// The queue itself, the line that says what it holds, and where its rows go
const reviewDialog = element<HTMLDialogElement>('review-queue-dialog');
const reviewBody = element('review-queue-body');
const reviewClose = element('review-close');

// A completed thread whose diff is open in the queue, by its id. Kept across a
// re-draw so that answering a question from the queue does not collapse the diffs
// the user was reading, and dropped on close, so that nothing lazily fetched
// lingers after the queue is gone.
const openDiffs = new Set<string>();
// The changes the container has already given, by thread id. A diff that has been
// fetched is not fetched again on the re-draw that follows an answer; only one
// bridge call per thread is made, and only when its diff is first opened.
const diffCache = new Map<string, Awaited<ReturnType<typeof window.threads.changes>>>();

// What the queue counts, and so does the app's icon: the threads from
// needingUser in events.ts, which is what showBadge counts too, so the number on
// the queue and the one on the icon never disagree.
const pendingThreads = needingUser;

// Paints the number on the Review button. A queue with nothing in it shows no
// number at all, the way the count on a thread's own row does.
const paintBadge = (): void => {
  const count = pendingThreads().length;
  reviewCount.textContent = count > 0 ? String(count) : '';
  reviewCount.hidden = count === 0;
};

// The request a thread is in, if it is in one: the one the harness is waiting on
// for it, looked up the way approvalOf and questionOf do it.
const requestOf = (thread: Thread) => {
  const rid = inflight.get(thread.id);
  return rid === undefined ? undefined : requests.get(rid);
};

// One of a thread's pending answers, read straight off the request rather than
// through approvalOf, which hands back only the first. The model approval, then
// the commands the harness is waiting to be let run, then the files it is
// waiting to be let read: the order the card is asked in the thread.
const pendingItemsOf = (request: NonNullable<ReturnType<typeof requestOf>>) => {
  const items: Asked[] = [];
  if (request.approval) items.push(request.approval);
  for (const entry of request.commandAccess ?? []) items.push(entry);
  for (const entry of request.fileAccess ?? []) items.push(entry);
  return items;
};

// A thread's block of answers, under a small label of its own. Each card is the
// card the thread itself draws, so it answers in place and the queue need add no
// handler of its own.
const actionsForThread = (
  thread: Thread,
  rid: string,
  request: NonNullable<ReturnType<typeof requestOf>>
): HTMLElement => {
  const group = document.createElement('div');
  group.className = 'review-group';
  const label = document.createElement('p');
  label.className = 'review-group-label';
  label.textContent = thread.title;
  // The id, in case two threads share a title; it names the thread without
  // taking the title's place
  const id = document.createElement('small');
  id.className = 'review-group-id';
  id.textContent = thread.id;
  label.append(id);
  group.append(label);
  for (const item of pendingItemsOf(request)) group.append(approvalCard(rid, item));
  if (request.question) group.append(questionCard(rid, request.question));
  return group;
};

// A line that says there is nothing of a kind. The queue shows both kinds, so
// each has its own.
const noActions = (): HTMLElement => {
  const empty = document.createElement('p');
  empty.className = 'review-empty';
  empty.textContent = 'No pending actions';
  return empty;
};

// The last thing a thread said that is an answer rather than narration: its
// summary, if the thread has one, or its final message, or, with neither, a line
// that says so.
const summaryLineOf = (thread: Thread): string =>
  thread.summary ?? thread.messages.findLast((m) => m.final)?.text ?? 'No final message';

// The diff of one file, line by line: the same rows and the same shape the
// Changes dialog gives it (see changedFile in changes.ts) — a numbered line, the
// old number, the new, and the text — so a diff read in the queue reads the same
// as one read in the dialog.
const renderFileDiff = (file: FileChange): HTMLElement => {
  const box = document.createElement('div');
  box.className = 'review-file';
  const heading = document.createElement('p');
  heading.className = 'review-file-path';
  heading.textContent = file.path;
  box.append(heading);
  // A binary file has no diff to show line by line, so its place says as much
  if (file.binary) {
    const note = document.createElement('p');
    note.className = 'review-file-note';
    note.textContent = 'Binary file';
    box.append(note);
    return box;
  }
  const diff = document.createElement('div');
  diff.className = 'diff';
  for (const row of diffRows(file.diff || 'Nothing to show for this file.')) {
    const line = document.createElement('div');
    line.className = `row ${row.kind}`;
    const number = document.createElement('span');
    number.className = 'number';
    number.textContent = row.oldLine === null ? '' : String(row.oldLine);
    const number2 = document.createElement('span');
    number2.className = 'number';
    number2.textContent = row.newLine === null ? '' : String(row.newLine);
    const code = document.createElement('code');
    code.textContent = row.text;
    line.append(number, number2, code);
    diff.append(line);
  }
  box.append(diff);
  return box;
};

// The changes of a thread, drawn once they have come back from the container.
// The result the container gives is the one remembered, so a re-draw re-expands
// a diff that was already open without asking for it again.
const renderChanges = (
  thread: Thread,
  into: HTMLElement,
  result: NonNullable<Awaited<ReturnType<typeof window.threads.changes>>>
): void => {
  into.replaceChildren();
  if (result.unavailable) {
    const note = document.createElement('p');
    note.className = 'review-file-note';
    note.textContent = `Changes could not be read: ${result.unavailable}`;
    into.append(note);
  } else {
    for (const file of result.files) into.append(renderFileDiff(file));
    if (result.more) {
      const more = document.createElement('p');
      more.className = 'review-file-note';
      more.textContent = `…and ${result.more} more ${result.more === 1 ? 'file' : 'files'}`;
      into.append(more);
    }
  }
};

// The diff a thread with changes gets in the queue: open when its id is in the
// set the queue keeps open, fetched the first time it is opened and shown again
// on a re-draw without a second fetch.
const diffForThread = (thread: Thread): HTMLElement => {
  const details = document.createElement('details');
  details.className = 'review-diff';
  details.open = openDiffs.has(thread.id);
  const summary = document.createElement('summary');
  summary.textContent = thread.changes && thread.changes > 1 ? `Show ${thread.changes} changes` : 'Show changes';
  const body = document.createElement('div');
  body.className = 'review-diff-body';
  details.append(summary, body);
  // Opening the diff asks the container for the thread's changes; closing it
  // drops the thread from the set, so a re-draw does not ask for it again
  details.addEventListener('toggle', () => {
    if (details.open) {
      openDiffs.add(thread.id);
      fetchChanges(thread, body);
    } else {
      openDiffs.delete(thread.id);
    }
  });
  // On a re-draw the set is kept, so a diff that was open is asked for again
  // here; the fetch is the one that remembers, so it is not made twice
  if (details.open) fetchChanges(thread, body);
  return details;
};

// Asks the container for a thread's changes, drawing whatever it gives into the
// place the diff is shown. The one bridge call per thread, made only when the
// diff is opened or re-expanded.
const fetchChanges = async (thread: Thread, into: HTMLElement): Promise<void> => {
  let result: Awaited<ReturnType<typeof window.threads.changes>>;
  if (diffCache.has(thread.id)) {
    result = diffCache.get(thread.id)!;
  } else {
    result = await window.threads
      .changes(thread.id)
      .catch((err: Error) => ({ files: [], more: undefined, unavailable: err.message }));
    diffCache.set(thread.id, result);
  }
  // Closed, or the queue closed, by the time the answer came
  if (!openDiffs.has(thread.id)) return;
  renderChanges(thread, into, result);
};

// One completed thread: what it last said, a button to open it, and its diff
// where it left any.
const completedItem = (thread: Thread): HTMLElement => {
  const item = document.createElement('div');
  item.className = 'review-completed';
  const line = document.createElement('p');
  line.className = 'review-summary';
  line.textContent = summaryLineOf(thread);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 're-open';
  open.textContent = 'Re-open';
  // Opening the thread is the in-app re-open: it is what a notification's click
  // does too, and nothing here is a deep link to it. The queue is closed first,
  // since a dialog left open would sit over the thread it was asked to open.
  open.addEventListener('click', () => {
    const target = state.threads.find((x) => x.id === thread.id);
    if (!target) return;
    reviewDialog.close();
    activate(target);
    render();
  });
  item.append(line, open);
  // A thread that left changes gets its diff, opened only when its diff is opened
  if (thread.changes && thread.changes > 0) item.append(diffForThread(thread));
  return item;
};

// The two sections the queue is made of.
const drawActions = (): HTMLElement => {
  const section = document.createElement('div');
  section.className = 'review-section';
  const heading = document.createElement('p');
  heading.className = 'review-heading';
  heading.textContent = 'Waiting on you';
  section.append(heading);
  let any = false;
  for (const thread of pendingThreads()) {
    if (thread.automatic) continue;
    const rid = inflight.get(thread.id);
    const request = rid === undefined ? undefined : requests.get(rid);
    // The thread may be unread without anything to answer, which is the other
    // section; only the ones with a question waiting are actions here
    if (!request) continue;
    const items = pendingItemsOf(request);
    if (items.length === 0 && !request.question) continue;
    section.append(actionsForThread(thread, rid as string, request));
    any = true;
  }
  if (!any) section.append(noActions());
  return section;
};

const drawCompleted = (): HTMLElement => {
  const section = document.createElement('div');
  section.className = 'review-section';
  const heading = document.createElement('p');
  heading.className = 'review-heading';
  heading.textContent = 'Finished, not yet read';
  section.append(heading);
  // A reply that finished while the user was away, marked unread. The app's own
  // threads are left out, the way the badge is.
  const items = state.threads.filter((t) => t.unread && !t.automatic);
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'review-empty';
    empty.textContent = 'Nothing to review';
    section.append(empty);
    return section;
  }
  for (const thread of items) section.append(completedItem(thread));
  return section;
};

// What the queue held when it was last drawn, as text: everything that shows in
// it, so that two equal strings are two queues that look alike. Compared with what
// the threads say now, it tells whether an open queue is out of date, and so lets
// it follow the threads without being rebuilt on every render, which would take a
// half-typed answer out from under the user's hands.
let drawn = '';
const holding = (): string =>
  JSON.stringify(
    pendingThreads().map((t) => {
      const request = requestOf(t);
      return [
        t.id,
        t.title,
        Boolean(t.unread),
        t.changes ?? 0,
        summaryLineOf(t),
        request && [pendingItemsOf(request), request.question],
      ];
    })
  );

// Builds the queue from the threads as they stand now, and paints the badge to
// match. Called when the queue is opened, and again after an answer is given
// from it, so that the question just answered is gone and the number is right.
const draw = (): void => {
  paintBadge();
  drawn = holding();
  reviewBody.replaceChildren(drawActions(), drawCompleted());
};

// Whenever the threads are redrawn — a reply finishing unread, a question
// arriving, a thread being read — the number on the button follows, and the
// queue too if it is open and what it holds has changed (see onBadge).
onBadge(() => {
  paintBadge();
  if (reviewDialog.open && holding() !== drawn) draw();
});

// A card's answer buttons are the only ones that should make the queue re-draw:
// the Re-open button opens a thread and the diff toggle opens a diff, and
// neither of those changes what the queue holds. The class on a card's button
// says which is which.
const ANSWER_CLASSES = ['approve', 'decline', 'option', 'send'];

// A question answered from the queue is answered by the card's own handler, which
// deletes it from its request and then renders the thread. That is not the
// queue, so the queue would still show the question it no longer has: re-draw it
// on the next frame, when the answer has been taken out of the request. A
// requestAnimationFrame defers it past the handler, so the item is gone by the
// time draw re-reads the requests; the Re-open button is not among the answer
// buttons, so opening a thread does not re-draw the queue on its own.
reviewBody.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button || !reviewBody.contains(button)) return;
  if (!ANSWER_CLASSES.some((c) => button.classList.contains(c))) return;
  requestAnimationFrame(() => draw());
});

// Opening the queue: draw it, then show it.
reviewButton.addEventListener('click', () => {
  draw();
  reviewDialog.showModal();
});
reviewClose.addEventListener('click', () => reviewDialog.close());
// Closing the queue by any means — the button or Esc — drops the diffs that were
// opened in it, so that what was fetched for them does not survive the close
// (see openDiffs, and the set the diff toggle adds to).
reviewDialog.addEventListener('close', () => openDiffs.clear());

// Paint the badge now, in case the threads are drawn already; after this it
// follows them (see onBadge above).
paintBadge();
