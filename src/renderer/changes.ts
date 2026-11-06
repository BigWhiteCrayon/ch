import type { BranchStatus, FileChange, ReviewComment, Thread } from './types.js';
import { element, inflight, threadChanges } from './shared.js';
import { state, save, saveSoon, activeThread, addMessage, sourceOf } from './threads.js';
import { render } from './thread-view.js';
import { reply } from './reply.js';
import { openAgentTab } from './agent-tabs.js';
import { renderMarkdown } from './markdown.js';

export const changesDialog = element<HTMLDialogElement>('changes-dialog');
export const changesFiles = element('changes-files');
export const changesStatus = element('changes-status');
export const changesApply = element<HTMLButtonElement>('changes-apply');
export const changesSend = element<HTMLButtonElement>('changes-send');
export const changesRevert = element<HTMLButtonElement>('changes-revert');
export const changesBranch = element('changes-branch');
export const changesBranchStatus = element('changes-branch-status');
export const changesCommitMessage = element<HTMLInputElement>('changes-commit-message');
export const changesCommit = element<HTMLButtonElement>('changes-commit');
export const changesPush = element<HTMLButtonElement>('changes-push');
export const changesPull = element<HTMLButtonElement>('changes-pull');
// The thread whose changes are on show
export let changesThread: Thread | null = null;
// Where the shown thread's branch stood when last looked at (null until known), and whether a commit, push or pull is
// under way, which the buttons wait for
let branchState: BranchStatus | null = null;
let branchBusy = false;

// Brings the number on the Changes button up to date
export async function countChanges(thread: Thread): Promise<void> {
  const changes = await window.threads.changes(thread.id).catch(() => null);
  if (!changes) return;
  const before = thread.changes;
  rememberChanges(thread, changes.files.length + (changes.more ?? 0));
  // The sidebar marks a thread that has changes waiting, active or not
  if (thread.id === state.activeId || !before !== !thread.changes) render();
}

// Keeps the count with the thread, so that it is known again after a restart
export function rememberChanges(thread: Thread, count: number): void {
  if (count === (thread.changes ?? 0)) return;
  if (count) thread.changes = count;
  else delete thread.changes;
  saveSoon();
}

export const STATUS_NAMES = { added: 'Added', modified: 'Changed', deleted: 'Deleted' };

// The changes on show, kept so that the list can be drawn again as comments
// are added to it
export let shownChanges: FileChange[] = [];
// Files whose diff is open in the list (by path)
export const openFiles = new Set<string>();
// The line a comment is being written on, or the comment being replied to
export let drafting: { path: string; row: string; line: number | null; commentId?: string } | null = null;

// A line of a diff: its text as Git gives it, what kind of line it is, and
// its line number (in the new file, or in the old one for a removed line)
export interface DiffRow {
  text: string;
  kind: 'add' | 'del' | 'context' | 'hunk';
  line: number | null;
  oldLine: number | null;
  newLine: number | null;
}

export function diffRows(diff: string): DiffRow[] {
  let before = 0;
  let after = 0;
  return diff.split('\n').map((text): DiffRow => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      return { text, kind: 'hunk', line: null, oldLine: null, newLine: null };
    }
    if (text.startsWith('+')) {
      const newLine = after++;
      return { text, kind: 'add', line: newLine, oldLine: null, newLine };
    }
    if (text.startsWith('-')) {
      const oldLine = before++;
      return { text, kind: 'del', line: oldLine, oldLine, newLine: null };
    }
    if (!text.startsWith(' ')) return { text, kind: 'hunk', line: null, oldLine: null, newLine: null };
    const oldLine = before++;
    const newLine = after++;
    return { text, kind: 'context', line: newLine, oldLine, newLine };
  });
}

// The box a comment or a reply to one is written in
export function commentForm(thread: Thread): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'comment-form';
  const box = document.createElement('textarea');
  box.rows = 2;
  box.placeholder = drafting?.commentId ? 'Reply…' : 'Leave a comment, or ask a question, about this line…';
  const add = document.createElement('button');
  add.type = 'submit';
  add.className = 'primary';
  add.textContent = drafting?.commentId ? 'Add reply' : 'Add comment';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    drafting = null;
    drawChanges(thread);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text || !drafting) return;
    const review = (thread.review ??= []);
    const existing = review.find((c) => c.id === drafting?.commentId);
    if (existing) {
      existing.entries.push({ from: 'user', text, at: Date.now() });
    } else {
      thread.reviewCount = (thread.reviewCount ?? 0) + 1;
      const { path, row, line } = drafting;
      review.push({ id: `c${thread.reviewCount}`, path, row, line, entries: [{ from: 'user', text, at: Date.now() }] });
    }
    drafting = null;
    save();
    drawChanges(thread);
  });
  const buttons = document.createElement('div');
  buttons.className = 'actions';
  buttons.append(cancel, add);
  form.append(box, buttons);
  // Once it is on the page
  queueMicrotask(() => box.focus());
  return form;
}

// A comment and what has been said under it since, as on a pull request
export function commentThread(thread: Thread, comment: ReviewComment): HTMLElement {
  const box = document.createElement('div');
  box.className = 'comment';
  box.dataset.comment = comment.id;
  for (const entry of comment.entries) {
    const row = document.createElement('div');
    row.className = `entry ${entry.from}`;
    const who = document.createElement('strong');
    who.textContent = entry.from === 'user' ? 'You' : 'Assistant';
    const said = document.createElement('span');
    said.append(renderMarkdown(entry.text));
    row.append(who, said);
    if (entry.from === 'user' && !entry.sent) {
      // Not yet seen by the assistant, so it can still be taken back
      const pending = document.createElement('small');
      pending.textContent = 'not sent yet';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.title = 'Remove';
      remove.addEventListener('click', () => {
        comment.entries = comment.entries.filter((e) => e !== entry);
        if (comment.entries.length === 0) thread.review = thread.review?.filter((c) => c !== comment);
        save();
        drawChanges(thread);
      });
      row.append(pending, remove);
    }
    if (entry.at !== undefined) {
      // When the entry was left, in small print
      const time = document.createElement('small');
      time.className = 'entry-time';
      time.textContent = new Date(entry.at).toLocaleTimeString();
      row.append(time);
    }
    box.append(row);
  }
  // How far the reviewer dealing with it has got, once one has taken it up
  const reviewer = thread.messages
    .filter((m) => m.role === 'subagent' && m.kind === 'reviewer' && m.text === comment.id)
    .at(-1);
  if (reviewer) {
    const progress = document.createElement('div');
    progress.className = 'progress';
    const status = document.createElement('small');
    status.textContent =
      reviewer.finding !== undefined
        ? reviewer.failed
          ? 'Reviewer did not finish'
          : 'Reviewer finished'
        : reviewer.waiting
          ? `Reviewer waiting its turn for ${reviewer.waiting}…`
          : `Reviewer working…${reviewer.progress === undefined ? '' : ` ${Math.round(reviewer.progress)}%`}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'reply';
    open.textContent = 'See its work';
    open.addEventListener('click', () => {
      changesThread = null;
      changesDialog.close();
      openAgentTab(thread, reviewer);
    });
    progress.append(status, open);
    box.append(progress);
  }
  if (drafting?.commentId === comment.id) {
    box.append(commentForm(thread));
  } else {
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'reply';
    reply.textContent = 'Reply';
    reply.addEventListener('click', () => {
      drafting = { path: comment.path, row: comment.row, line: comment.line, commentId: comment.id };
      drawChanges(thread);
    });
    box.append(reply);
  }
  return box;
}

// One changed file: its name, opening to show what changed in it line by
// line. A line can be clicked to comment on it, and comments sit under the
// line they are about.
export function changedFile(thread: Thread, file: FileChange): HTMLDetailsElement {
  const details = document.createElement('details');
  details.open = openFiles.has(file.path);
  details.addEventListener('toggle', () => {
    if (details.open) openFiles.add(file.path);
    else openFiles.delete(file.path);
  });
  const comments = (thread.review ?? []).filter((c) => c.path === file.path);
  // How many lines the change adds and removes, shown on the summary
  const rows = diffRows(file.diff || 'Nothing to show for this file.');
  const adds = rows.filter((r) => r.kind === 'add').length;
  const dels = rows.filter((r) => r.kind === 'del').length;
  const summary = document.createElement('summary');
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = STATUS_NAMES[file.status];
  summary.append(status, file.path);
  if (adds + dels > 0) {
    const tally = document.createElement('small');
    tally.className = 'tally';
    tally.textContent = `+${adds} −${dels}`;
    summary.append(tally);
  }
  if (comments.length > 0) {
    const count = document.createElement('small');
    count.className = 'comments';
    count.textContent = ` ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`;
    summary.append(count);
  }
  details.append(summary);

  const diff = document.createElement('div');
  diff.className = 'diff';
  // Each comment goes under the line it was left on: the one that reads the
  // same, nearest to where it was. Lines change as the thread works, so a
  // comment whose line is gone is listed below the diff instead.
  const placed = new Map<DiffRow, ReviewComment[]>();
  const outdated: ReviewComment[] = [];
  for (const comment of comments) {
    const same = rows.filter((row) => row.kind !== 'hunk' && row.text === comment.row);
    const nearest = same.sort(
      (a, b) => Math.abs((a.line ?? 0) - (comment.line ?? 0)) - Math.abs((b.line ?? 0) - (comment.line ?? 0))
    )[0];
    if (nearest) placed.set(nearest, [...(placed.get(nearest) ?? []), comment]);
    else outdated.push(comment);
  }

  for (const row of rows) {
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
    if (row.kind !== 'hunk' && file.diff) {
      line.title = 'Comment on this line';
      line.addEventListener('click', () => {
        drafting = { path: file.path, row: row.text, line: row.line };
        drawChanges(thread);
      });
    }
    diff.append(line);
    for (const comment of placed.get(row) ?? []) diff.append(commentThread(thread, comment));
    const here =
      drafting &&
      !drafting.commentId &&
      drafting.path === file.path &&
      drafting.row === row.text &&
      drafting.line === row.line;
    if (here) diff.append(commentForm(thread));
  }
  if (outdated.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'outdated';
    heading.textContent = 'On lines that have since changed:';
    diff.append(heading);
    for (const comment of outdated) {
      const was = document.createElement('code');
      was.className = 'was';
      was.textContent = comment.row;
      diff.append(was, commentThread(thread, comment));
    }
  }
  details.append(diff);
  return details;
}

// The user's comments that the assistant hasn't been sent yet
export function unsentComments(thread: Thread): ReviewComment[] {
  return (thread.review ?? []).filter((c) => c.entries.some((e) => e.from === 'user' && !e.sent));
}

// Draws the list of changed files, with their comments, and brings the
// buttons under it up to date
export function drawChanges(thread: Thread): void {
  changesFiles.replaceChildren(...shownChanges.map((file) => changedFile(thread, file)));
  const unsent = unsentComments(thread).length;
  changesSend.textContent = unsent ? `Send ${unsent} ${unsent === 1 ? 'comment' : 'comments'}` : 'Send comments';
  changesSend.disabled = unsent === 0 || inflight.has(thread.id);
}

// The comments as the assistant is sent them: each with its id, where it is,
// and everything said under it so far
export function reviewMessage(comments: ReviewComment[]): string {
  const parts = comments.map((comment) => {
    const where = `${comment.path}${comment.line === null ? '' : `, line ${comment.line}`}`;
    const said = comment.entries.map((entry) => `${entry.from === 'user' ? 'Me' : 'You'}: ${entry.text}`);
    return [`[${comment.id}] ${where}`, `> ${comment.row}`, ...said].join('\n');
  });
  return `Review comments on your changes:\n\n${parts.join('\n\n')}`;
}

// Which of Commit, Push and Pull make sense now: Commit when there is work to commit and a message for it, Push when
// there are commits the upstream lacks (or no upstream yet), Pull when the upstream has some this branch lacks
function drawBranchButtons(): void {
  const known = branchState && !branchBusy ? branchState : null;
  changesCommit.disabled = !known?.dirty || !changesCommitMessage.value.trim();
  changesPush.disabled = !known || (known.ahead === 0 && known.upstream !== null);
  changesPull.disabled = !known || known.behind === 0;
}

// The thread's branch, how it stands against its upstream, and the buttons that act on it. Hidden for a thread that is
// not on a branch.
export async function drawBranch(thread: Thread): Promise<void> {
  const branch = thread.branch;
  changesBranch.hidden = !branch;
  branchState = null;
  if (!branch) return;
  if (!changesCommitMessage.value) changesCommitMessage.value = thread.title;
  changesBranchStatus.textContent = `${branch.name} — looking at where it stands…`;
  drawBranchButtons();
  const status = await window.threads.branchStatus(branch.worktree).catch((err: Error) => err);
  // Closed, or showing another thread, by the time the answer came
  if (changesThread !== thread) return;
  if (status instanceof Error) {
    changesBranchStatus.textContent = `${branch.name} — ${status.message}`;
    return;
  }
  branchState = status;
  // Whatever the branch tracks is kept with the thread, so that the sidebar can say where it was pushed to
  if (status.upstream !== (branch.upstream ?? null)) {
    if (status.upstream) branch.upstream = status.upstream;
    else delete branch.upstream;
    save();
    // The sidebar names it in the branch's heading
    render();
  }
  const parts: string[] = [];
  if (status.dirty) parts.push('uncommitted changes');
  if (!status.upstream) parts.push('not pushed yet');
  else if (status.ahead === 0 && status.behind === 0) parts.push('up to date');
  else {
    if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
    if (status.behind > 0) parts.push(`${status.behind} behind`);
  }
  const tracking = status.upstream ? ` · ${status.upstream}` : '';
  changesBranchStatus.textContent = `${branch.name} — ${parts.join(', ')}${tracking}`;
  drawBranchButtons();
}

// Runs one of the buttons on the branch: `act` resolves with what to say it did, or throws why it could not
async function runBranch(
  failed: string,
  act: (branch: NonNullable<Thread['branch']>) => Promise<string>
): Promise<void> {
  const thread = changesThread;
  const branch = thread?.branch;
  if (!thread || !branch || branchBusy) return;
  branchBusy = true;
  drawBranchButtons();
  let outcome: string;
  try {
    outcome = await act(branch);
  } catch (err) {
    outcome = `${failed}: ${(err as Error).message}`;
  }
  branchBusy = false;
  if (changesThread !== thread) return;
  changesStatus.textContent = outcome;
  await drawBranch(thread);
}

changesCommitMessage.addEventListener('input', drawBranchButtons);

changesCommit.addEventListener('click', () =>
  runBranch('Could not commit', async (branch) =>
    (await window.threads.commitBranch(branch.worktree, changesCommitMessage.value))
      ? 'Committed.'
      : 'Nothing to commit.'
  )
);

changesPush.addEventListener('click', () =>
  runBranch('Could not push', async (branch) => {
    branch.upstream = await window.threads.pushBranch(branch.worktree);
    save();
    render();
    return `Pushed to ${branch.upstream}.`;
  })
);

changesPull.addEventListener('click', () =>
  runBranch('Could not pull', async (branch) => {
    await window.threads.pullBranch(branch.worktree);
    return 'Pulled.';
  })
);

// outcome: what to say about an attempt to write them, if one was just made
export async function showChanges(thread: Thread, outcome = ''): Promise<void> {
  shownChanges = [];
  drawChanges(thread);
  changesApply.disabled = true;
  changesRevert.disabled = true;
  element('changes-hint').textContent =
    `What this thread has changed in its own copy of ${thread.workspace}. ` +
    'Nothing reaches the workspace itself until you write it there.';
  const changes = await window.threads
    .changes(thread.id)
    .catch((err: Error) => ({ files: [], unavailable: err.message, more: undefined }));
  // Closed, or showing another thread, by the time the answer came
  if (changesThread !== thread) return;

  if (!changes.unavailable) rememberChanges(thread, changes.files.length + (changes.more ?? 0));
  shownChanges = changes.files;
  drawChanges(thread);
  let note = '';
  if (changes.unavailable) note = changes.unavailable;
  else if (changes.more) note = `…and ${changes.more} more files.`;
  else if (changes.files.length === 0 && !outcome)
    note = 'This thread has no changes waiting to be written to the workspace.';
  changesStatus.textContent = [outcome, note].filter(Boolean).join('\n');
  changesApply.disabled = changes.files.length === 0 || inflight.has(thread.id);
  changesRevert.disabled = changes.files.length === 0 || inflight.has(thread.id);
  void drawBranch(thread);
  render();
}

export function openChanges(thread: Thread): void {
  if (!thread.workspace) return;
  changesThread = thread;
  drafting = null;
  openFiles.clear();
  // Each thread's commit message starts from its own title (see drawBranch)
  changesCommitMessage.value = '';
  changesBranch.hidden = true;
  changesStatus.textContent = 'Looking at what has changed…';
  changesDialog.showModal();
  void showChanges(thread);
}

threadChanges.addEventListener('click', () => openChanges(activeThread()));

changesApply.addEventListener('click', async () => {
  const thread = changesThread;
  if (!thread?.workspace) return;
  changesApply.disabled = true;
  changesStatus.textContent = 'Writing to the workspace…';
  const result = await window.threads
    .applyChanges(thread.id, sourceOf(thread) as string)
    .catch((err: Error) => ({ applied: [], conflicts: [], skipped: [], error: err.message }));
  // A successful write-back leaves nothing pending, whether or not the dialog is still looking at the thread
  if (!result.error && result.conflicts.length === 0) {
    const had = thread.changes;
    rememberChanges(thread, 0);
    if (had) render();
  }
  if (changesThread !== thread) return;

  const lines: string[] = [];
  if (result.error) lines.push(`Nothing was written: ${result.error}`);
  else if (result.conflicts.length > 0) {
    lines.push(
      'Nothing was written, because these files have changed in the workspace in ways that clash with the thread:'
    );
    lines.push(...result.conflicts.map((c) => `• ${c.path}: ${c.reason}`));
  } else {
    // What was commented on is in the workspace now; the review of it is over
    thread.review = [];
    save();
    const n = result.applied.length;
    lines.push(
      n === 0
        ? 'The workspace already had these changes.'
        : `Wrote ${n} ${n === 1 ? 'file' : 'files'} to ${sourceOf(thread)}.`
    );
  }
  if (result.skipped.length > 0) {
    lines.push('Left out:', ...result.skipped.map((s) => `• ${s.path}: ${s.reason}`));
  }
  await showChanges(thread, lines.join('\n'));
});

// Throws away the thread's changes in its own copy, back to how they were when last written back (or made). Nothing
// reaches the workspace, and the thread's review comments are left as they are.
changesRevert.addEventListener('click', async () => {
  const thread = changesThread;
  if (!thread?.workspace || inflight.has(thread.id)) return;
  changesRevert.disabled = true;
  changesApply.disabled = true;
  changesStatus.textContent = 'Reverting…';
  const reverted = await window.threads.discardChanges(thread.id).catch(() => false);
  if (changesThread !== thread) return;
  await showChanges(
    thread,
    reverted
      ? "Reverted. The thread's files are as they were before its changes."
      : 'Nothing was reverted: the files were already as they were, or could not be put back.'
  );
});

// Sends the comments the assistant hasn't seen to the thread, as a message it
// is to act on and answer comment by comment
changesSend.addEventListener('click', () => {
  const thread = changesThread;
  if (!thread || inflight.has(thread.id)) return;
  const unsent = unsentComments(thread);
  if (unsent.length === 0) return;
  const text = reviewMessage(unsent);
  for (const comment of unsent) for (const entry of comment.entries) entry.sent = true;
  changesThread = null;
  changesDialog.close();
  const asked = addMessage(thread, 'user', text);
  asked.review = true;
  asked.carries = unsent.map(({ id, path, line }) => ({ id, path, line }));
  save();
  render();
  reply(thread, asked);
});

element('changes-close').addEventListener('click', () => {
  changesThread = null;
  changesDialog.close();
});
