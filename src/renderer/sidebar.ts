import { state, save, saveSoon, activate, createThread, busy, deleteThread, offshootsOf, sourceOf } from './threads.js';
import { inflight, MAX_OPEN_THREADS, input, startedAgents, automatic, onTab } from './shared.js';
import { approvalOf } from './approvals.js';
import { questionOf } from './questions.js';
import { render } from './thread-view.js';
import { LEFT_ALONE } from './reply.js';
import { openRenameWorkspace } from './rename-feedback.js';
import { openWorkspaceDialog } from './workspace-dialog.js';
import { openAgentTab } from './agent-tabs.js';
import { postReply, watching } from './events.js';
import { changesThread, drafting, drawChanges } from './changes.js';
import { openThreadDialog } from './thread-dialog.js';
import type { Thread, Message } from './types.js';

export function workspaceName(workspace: string): string {
  return state.workspaceNames?.[workspace] ?? ownName(workspace);
}

// The last part of the workspace's path
export function ownName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

// Names a workspace; a blank name, or its own, goes back to the workspace's own
export function nameWorkspace(workspace: string, name: string): void {
  const names = { ...state.workspaceNames };
  const given = name.trim();
  if (given && given !== ownName(workspace)) names[workspace] = given;
  else delete names[workspace];
  state.workspaceNames = names;
  save();
  render();
}

// Whether the app stopped on a reply of the thread's, having been closed on it more than once. The error is not
// always the last message, so all of them are looked at.
const leftAlone = (thread: Thread) => thread.messages.some((m) => m.role === 'error' && m.text === LEFT_ALONE);

// Whether a thread is working or has something for the user to look at: a
// question, a reply not yet read, or changes to write back. Such a thread stays
// at the top of its group and is never archived.
export function needsAttention(thread: Thread): boolean {
  return (
    inflight.has(thread.id) ||
    isWorking(thread) ||
    approvalOf(thread) !== undefined ||
    questionOf(thread) !== undefined ||
    !!thread.unread ||
    !!thread.changes ||
    leftAlone(thread) ||
    // What was branched off it is its work too: it is not archived, and stays up, while one is going on
    offshootsOf(thread).some(needsAttention)
  );
}

// When the thread was last opened or used, whichever is later
export function lastUsed(thread: Thread): number {
  return Math.max(thread.opened ?? 0, thread.lastActive ?? 0);
}

// Threads needing attention come first, the rest by how recently they were
// opened or used, so opening a thread puts it at the top of those. A thread
// saved before either was kept has none, so it goes last. Threads that tie keep
// their own order, newest started first.
export function byRecency(a: Thread, b: Thread): number {
  if (needsAttention(a) !== needsAttention(b)) return needsAttention(a) ? -1 : 1;
  return lastUsed(b) - lastUsed(a);
}

// Archives, in each sidebar group with more than MAX_OPEN_THREADS threads, the
// ones opened longest ago until it is down to that many — never one needing
// attention, nor the one on screen. They are left in state.threads, so search
// still finds them. Whether any were archived, for the caller to save.
export function archiveStale(): boolean {
  let archived = false;
  for (const { threads } of threadGroups()) {
    const over = threads.length - MAX_OPEN_THREADS;
    if (over <= 0) continue;
    const idle = threads.filter((t) => t.id !== state.activeId && !needsAttention(t));
    for (const thread of idle.slice(-over)) {
      thread.archived = true;
      archived = true;
    }
  }
  return archived;
}

// Threads by workspace, general chats (no workspace) together, each ordered by
// byRecency. A group sits where its first thread would, so a thread that has
// an update brings its workspace to the top with it.
export function threadGroups(): { workspace: string | undefined; threads: Thread[] }[] {
  const groups = new Map<string | undefined, Thread[]>();
  for (const thread of state.threads) {
    // The app's own threads are shown under their own arrow (see automaticRows),
    // not among the threads the user started
    if (thread.automatic) continue;
    // ...and archived ones are left to be found by searching
    if (thread.archived) continue;
    // ...and an offshoot is shown under the thread it came from (see threadRows), unless that is gone
    if (thread.offshootOf && state.threads.some((t) => t.id === thread.offshootOf)) continue;
    const group = groups.get(thread.workspace) ?? [];
    group.push(thread);
    groups.set(thread.workspace, group);
  }
  return [...groups]
    .map(([workspace, threads]) => ({ workspace, threads: threads.sort(byRecency) }))
    .sort((a, b) => byRecency(a.threads[0], b.threads[0]));
}

// The mark a collapsed heading carries for the threads under it, so nothing goes unnoticed: null if there is none
function collapsedMark(threads: Thread[]): HTMLSpanElement | null {
  const asking = threads.some((t) => approvalOf(t) || questionOf(t));
  const working = threads.some((t) => inflight.has(t.id));
  const changed = threads.some((t) => t.changes);
  if (!asking && !working && !changed && !threads.some((t) => t.unread)) return null;
  const status = document.createElement('span');
  status.className = `status ${asking ? 'approval' : working ? 'working' : changed ? 'changed' : 'unread'}`;
  status.title = asking
    ? threads.some((t) => approvalOf(t))
      ? 'Needs your approval'
      : 'Needs your answer'
    : working
      ? 'Replying…'
      : changed
        ? 'Changes to write back'
        : 'New reply';
  return status;
}

// What state.collapsed holds for a branch's sub-group: the workspace and the branch, which a workspace's own entry
// (just its path) is never mistaken for
export function branchKey(workspace: string, branch: string): string {
  return `${workspace}#${branch}`;
}

// A workspace's threads as the rows under its heading: the ones on whatever is checked out first, then a sub-heading
// for each branch with the threads working on it. A workspace with no branch threads has no sub-headings.
export function threadsRows(workspace: string | undefined, threads: Thread[]): HTMLLIElement[] {
  const plain = threads.filter((t) => !t.branch);
  const branches = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (!thread.branch) continue;
    branches.set(thread.branch.name, [...(branches.get(thread.branch.name) ?? []), thread]);
  }
  // threads arrive in byRecency order, so each branch's first thread sets where the branch sits
  return [
    ...plain.flatMap(threadRows),
    ...[...branches].flatMap(([branch, those]) => {
      if (!workspace) return those.flatMap(threadRows);
      const key = branchKey(workspace, branch);
      const collapsed = !!state.collapsed?.includes(key);
      return [branchHeading(key, those, collapsed), ...(collapsed ? [] : those.flatMap(threadRows))];
    }),
  ];
}

// A branch's heading; clicking it collapses or expands the threads on the branch
export function branchHeading(key: string, threads: Thread[], collapsed: boolean): HTMLLIElement {
  const { name, base, upstream } = threads[0].branch as NonNullable<Thread['branch']>;
  const li = document.createElement('li');
  li.className = 'group branch';
  li.classList.toggle('collapsed', collapsed);
  li.setAttribute('aria-expanded', String(!collapsed));
  li.title = upstream ? `${name} → ${upstream}` : `${name} (from ${base}, not pushed)`;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;
  li.append(label);
  const mark = collapsed ? collapsedMark(threads) : null;
  if (mark) li.append(mark);
  li.addEventListener('click', () => {
    const others = (state.collapsed ?? []).filter((group) => group !== key);
    state.collapsed = collapsed ? others : [...others, key];
    save();
    render();
  });
  return li;
}

// The line that closes a group which has archived threads, so their absence is
// explained: they are not gone, only left to be found by searching
export function archivedNote(workspace: string | undefined): HTMLLIElement[] {
  const archived = state.threads.filter((t) => t.archived && !t.automatic && t.workspace === workspace).length;
  if (archived === 0) return [];
  const li = document.createElement('li');
  li.className = 'archived';
  li.textContent = 'Older threads have been archived. You can still find them in search.';
  li.title = `${archived} archived thread${archived === 1 ? '' : 's'}`;
  return [li];
}

export function isCollapsed(workspace: string | undefined): boolean {
  return !!state.collapsed?.includes(workspace ?? '');
}

// A group's heading; clicking it collapses or expands the threads under it
export function groupHeading(workspace: string | undefined, threads: Thread[]): HTMLLIElement {
  const collapsed = isCollapsed(workspace);
  const li = document.createElement('li');
  li.className = 'group';
  li.classList.toggle('collapsed', collapsed);
  li.setAttribute('aria-expanded', String(!collapsed));
  if (workspace) li.title = workspace;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = workspace ? workspaceName(workspace) : 'General chat';
  li.append(label);

  // A collapsed group carries its threads' marks, so nothing goes unnoticed
  const mark = collapsed ? collapsedMark(threads) : null;
  if (mark) li.append(mark);

  if (workspace) {
    const rename = document.createElement('button');
    rename.className = 'rename';
    rename.textContent = '✎';
    rename.title = 'Name this workspace';
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      openRenameWorkspace(workspace);
    });
    li.append(rename);
  }

  // Starts a thread here directly, without the new-thread pop-up
  const add = document.createElement('button');
  add.className = 'add';
  add.textContent = '+';
  add.title = workspace ? `New thread in ${workspaceName(workspace)}` : 'New general chat';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    createThread(workspace);
    render();
    input.focus();
  });
  li.append(add);

  li.addEventListener('click', () => {
    const others = (state.collapsed ?? []).filter((group) => group !== (workspace ?? ''));
    state.collapsed = collapsed ? others : [...others, workspace ?? ''];
    save();
    render();
  });
  // A right-click shows what the workspace is keeping: the note every thread
  // in it is given. A general chat has no workspace and so nothing to show.
  if (workspace) {
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void openWorkspaceDialog(workspace);
    });
  }
  return li;
}

// The subagents a thread has set to work, oldest first. They are kept as
// messages in the thread (see the 'subagent' event), so they outlive the reply
// that sent them and can be looked back at.
// The subagents a thread shows under it: the ones still working, and the ones
// that failed and have not been dealt with. One that finished is history, and
// is read from the thread itself, where its work is written (see
// subagentItem) — a list of everything a thread ever sent out would say
// nothing about what is going on now, which is what the list is for.
export function subagentsOf(thread: Thread): Message[] {
  const working = (m: Message) => m.finding === undefined;
  return thread.messages.filter((m) => m.role === 'subagent' && (working(m) || m.failed) && !m.dismissed);
}

// Whether a thread is showing the subagents under it. Hidden until asked for:
// a thread may have a good many, and once they have finished they are history.
// Hoisted, like isCollapsed: the first render happens before this point.
export function threadShowsAgents(thread: Thread): boolean {
  return !!state.opened?.includes(thread.id);
}

// ...and whether it is showing the offshoots branched off it, independently of its subagents
export function threadShowsOffshoots(thread: Thread): boolean {
  return !!state.openedOffshoots?.includes(thread.id);
}

// ...and whether a workspace is showing the threads the app started for
// itself. Hidden until asked for: they are not the user's conversations, and
// what they do is already in the workspace's notes.
// Hoisted, like isCollapsed: the first render happens before this point.
export function showsAutomatic(workspace: string): boolean {
  return !!state.shownAutomatic?.includes(workspace);
}

// The threads a workspace has that the app started, newest first
export function automaticOf(workspace: string): Thread[] {
  return state.threads.filter((thread) => thread.automatic && thread.workspace === workspace);
}

// The row that shows and hides the subagents under a workspace or a thread. It
// sits below the thing it belongs to, above the subagents themselves, and says
// what is going on under it whether they are shown or hidden: closed, it is
// all the user has; open, it is still the only thing that counts the work up,
// which a column of rows does not give at a glance.
export function agentsToggle(
  parent: 'workspace' | 'thread',
  shown: boolean,
  agents: { working: boolean; failed?: boolean; offshoot?: boolean; unread?: boolean }[],
  onToggle: () => void
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `agents ${parent}-agents`;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-expanded', String(shown));

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = shown ? '▾' : '▸';
  li.append(arrow);

  const working = agents.filter((one) => one.working).length;
  const failed = agents.filter((one) => !one.working && one.failed).length;
  // The threads branched off this one are listed with its subagents, and are counted with them
  const offshoots = agents.filter((one) => one.offshoot).length;
  const noun = offshoots === 0 ? 'subagent' : offshoots === agents.length ? 'offshoot' : 'agent';
  const unread = agents.some((one) => !one.working && one.unread);
  const many = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  // Hidden: what is behind the row, with work going on named first. The two
  // are told apart because they ask different things of the user: one is to be
  // waited for, the other to be retried or let go of.
  const parts: string[] = [];
  if (working > 0) parts.push(`${many(working, noun)} running`);
  // Where work is going on too, the failures are a count on the end of it
  if (failed > 0) parts.push(working > 0 ? `${failed} failed` : `${many(failed, noun)} failed`);
  const going = parts.join(', ') || many(agents.length, noun);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = going;
  li.append(label);
  if (working > 0 || failed > 0 || unread) {
    const status = document.createElement('span');
    status.className = `status ${working > 0 ? 'working' : failed > 0 ? 'failed' : 'unread'}`;
    li.append(status);
  }
  li.title = shown ? `Hide the ${many(agents.length, noun)}` : `Show the ${going}`;

  li.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  return li;
}

// One subagent, indented under the thread that sent it. Clicking it opens what
// it did, where it did it: in the thread, which is where its work is written.
export function subagentItem(thread: Thread, subagent: Message): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'subagent';
  const working = subagent.finding === undefined;
  if (subagent.task) li.title = subagent.task;

  if (working || subagent.failed) {
    const status = document.createElement('span');
    status.className = `status ${working ? 'working' : 'failed'}`;
    status.title = working ? 'Working…' : 'Did not finish';
    li.append(status);
  }

  const name = document.createElement('span');
  name.className = 'name';
  // A reviewer answering a comment reads very differently from a worker
  name.textContent = subagent.text;
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = subagent.kind ?? 'subagent';
  li.append(name, kind);

  // What failed can be sent out again, or let go of. Both are the user's to
  // decide: the work may have failed for a reason that has passed, such as a
  // model that was not running, or it may not have been worth doing.
  if (!working && subagent.failed) {
    const again = document.createElement('button');
    again.className = 'retry';
    again.textContent = '↻';
    again.title = 'Run this subagent again';
    again.addEventListener('click', (e) => {
      e.stopPropagation();
      void retrySubagent(thread, subagent);
    });
    const drop = document.createElement('button');
    drop.className = 'delete';
    drop.textContent = '×';
    drop.title = 'Take this off the list (what it did stays in the thread)';
    drop.addEventListener('click', (e) => {
      e.stopPropagation();
      subagent.dismissed = true;
      save();
      render();
    });
    li.append(again, drop);
  }

  // Opens what it is doing, which fills in while it works. Its dropdown in the
  // thread is a click further on, from inside the dialog.
  li.addEventListener('click', (e) => {
    e.stopPropagation();
    openAgentTab(thread, subagent);
  });
  return li;
}

// Subagents being run again right now, by the id their thread knows them by:
// two clicks of the same row are one retry
export const retryingAgents = new Set<string>();

// Runs one failed subagent again (see ../subagents/retry.ts). What it did
// before is cleared rather than added to: this is the same piece of work being
// done over, and half of one account followed by half of another would read
// as neither.
export async function retrySubagent(thread: Thread, subagent: Message): Promise<void> {
  const id = subagent.thoughtId;
  if (!id || !subagent.task || retryingAgents.has(id)) return;
  retryingAgents.add(id);
  subagent.events = [];
  delete subagent.finding;
  delete subagent.failed;
  delete subagent.progress;
  startedAgents.set(subagent, Date.now());
  save();
  render();

  const asked = {
    thread: thread.id,
    workspace: sourceOf(thread),
    id,
    name: subagent.text,
    task: subagent.task,
    kind: subagent.kind,
  };
  const result = await window.llm.retrySubagent(asked).catch((err: Error) => ({ text: err.message, isError: true }));
  retryingAgents.delete(id);
  subagent.finding = result.text;
  subagent.failed = result.isError;
  delete subagent.restarts;
  // Finished out of sight, like a reply (see the request's last event)
  if (result.isError && !watching(thread)) thread.unread = true;
  save();
  render();
}

// What a subagent being run again says while it works, in the same events it
// reports by inside a reply (see the 'subagent_update' event)
window.llm.onSubagentEvent((threadId, id, event) => {
  const thread = state.threads.find((t) => t.id === threadId);
  const subagent = thread?.messages.find((m) => m.role === 'subagent' && m.thoughtId === id);
  if (!thread || !subagent) return;
  // A reviewer's answer belongs under the comment it answers, as it does when
  // a reply is what set the reviewer to work
  if (event.type === 'tool_call' && event.name === 'reply_to_comment') {
    postReply(thread, event.input);
    return;
  }
  subagent.events ??= [];
  subagent.events.push(event);
  saveSoon();
  if (changesThread === thread && !drafting) drawChanges(thread);
  if (thread.id === state.activeId) render();
});

// Whether the app is working in this thread right now, which is what the look
// in its workspace is doing
export function isWorking(thread: Thread): boolean {
  return Boolean(thread.automatic && thread.workspace && automatic.get(thread.workspace) === thread.id);
}

// The rows a workspace adds under its heading: the arrow that shows the
// threads the app started for itself, and those threads when it is open.
export function automaticRows(workspace: string): HTMLLIElement[] {
  const threads = automaticOf(workspace);
  if (threads.length === 0) return [];
  const shown = showsAutomatic(workspace);
  const toggle = automaticToggle(shown, threads, () => {
    const others = (state.shownAutomatic ?? []).filter((one) => one !== workspace);
    state.shownAutomatic = shown ? others : [...others, workspace];
    save();
    render();
  });
  return shown ? [toggle, ...threads.flatMap(threadRows)] : [toggle];
}

// The arrow under a workspace that shows and hides those threads. It says what
// is behind it whether they are shown or hidden, as agentsToggle does for
// subagents: how many there are, or how many are running, and the mark of work
// going on is never behind a row that says nothing.
export function automaticToggle(shown: boolean, threads: Thread[], onToggle: () => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'agents workspace-agents';
  li.setAttribute('role', 'button');
  li.setAttribute('aria-expanded', String(shown));

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = shown ? '▾' : '▸';
  li.append(arrow);

  const busy = threads.filter(isWorking).length;
  const many = (n: number) => `${n} automatic thread${n === 1 ? '' : 's'}`;
  const going = busy > 0 ? `${many(busy)} running` : many(threads.length);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = going;
  li.append(label);
  if (busy > 0) {
    const status = document.createElement('span');
    status.className = 'status working';
    li.append(status);
  }
  li.title = shown ? `Hide the ${many(threads.length)}` : `Show the ${going}`;

  li.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  return li;
}

// The same for a thread: the thread, then its arrow, then its subagents and the threads branched off it. Those are
// threads of their own, which the arrow only gathers under the one they came from (see startOffshoot).
export function threadRows(thread: Thread): HTMLLIElement[] {
  const agents = subagentsOf(thread);
  const offshoots = offshootsOf(thread);
  if (agents.length + offshoots.length === 0) return [threadItem(thread)];
  const rows = [threadItem(thread)];
  if (agents.length > 0) {
    const shown = threadShowsAgents(thread);
    const toggle = agentsToggle(
      'thread',
      shown,
      agents.map((one) => ({ working: one.finding === undefined, failed: one.failed })),
      () => {
        const others = (state.opened ?? []).filter((id) => id !== thread.id);
        state.opened = shown ? others : [...others, thread.id];
        save();
        render();
      }
    );
    toggle.classList.add('subagents-toggle');
    rows.push(toggle);
    if (shown) rows.push(...agents.map((one) => subagentItem(thread, one)));
  }
  if (offshoots.length > 0) {
    const shown = threadShowsOffshoots(thread);
    const toggle = agentsToggle(
      'thread',
      shown,
      offshoots.map((one) => ({ working: busy(one), offshoot: true, unread: one.unread })),
      () => {
        const others = (state.openedOffshoots ?? []).filter((id) => id !== thread.id);
        state.openedOffshoots = shown ? others : [...others, thread.id];
        save();
        render();
      }
    );
    toggle.classList.add('offshoots-toggle');
    rows.push(toggle);
    if (shown) {
      for (const one of offshoots) {
        const li = threadItem(one);
        li.classList.add('offshoot');
        rows.push(li);
      }
    }
  }
  return rows;
}

export function threadItem(thread: Thread): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'thread';
  // The app's own, which the sidebar keeps behind an arrow (see automaticRows)
  li.classList.toggle('automatic', Boolean(thread.automatic));
  li.classList.toggle('active', thread.id === state.activeId);
  if (thread.workspace) li.title = thread.workspace;
  li.addEventListener('click', () => {
    // Back to the thread itself, whichever of its subagents was open last.
    // The thread is what the row stands for, and a subagent left open from an
    // hour ago is not what the user is asking to see. Its tab stays in the bar
    // to go back to (see tabs, which this does not touch).
    onTab.delete(thread.id);
    activate(thread);
    save();
    render();
    input.focus();
  });

  // A dot: pulsing while a reply is on its way, green while changes wait to be
  // written back (whether or not the thread has been read), solid once a reply
  // is waiting unread, red once the app has stopped on a reply (see LEFT_ALONE).
  // An automatic thread has no reply of its own; what is on its way there is the
  // app's own work (see isWorking).
  const approving = approvalOf(thread) !== undefined;
  const asking = approving || questionOf(thread) !== undefined;
  const working = inflight.has(thread.id) || isWorking(thread);
  const stopped = leftAlone(thread);
  const changed = !!thread.changes;
  if (asking || working || stopped || changed || thread.unread) {
    const status = document.createElement('span');
    const kind = asking ? 'approval' : working ? 'working' : stopped ? 'failed' : changed ? 'changed' : 'unread';
    status.className = `status ${kind}`;
    status.title = asking
      ? approving
        ? 'Needs your approval'
        : 'Needs your answer'
      : working
        ? 'Replying…'
        : stopped
          ? 'The app closed on this reply more than once'
          : changed
            ? 'Changes to write back'
            : 'New reply';
    li.append(status);
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = thread.title;

  const del = document.createElement('button');
  del.className = 'delete';
  del.textContent = '×';
  // A thread being written into cannot be deleted: the reply would be lost
  // half-written, with nothing to show for what it has already cost. Stop it
  // first, and then it can go.
  del.disabled = busy(thread);
  del.title = del.disabled
    ? thread.automatic
      ? 'The app is working in this thread; it can be deleted when that is done'
      : 'Stop the reply before deleting this thread'
    : 'Delete thread';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteThread(thread.id);
    render();
  });

  li.append(name, del);
  // ...and on a thread, what the thread itself is keeping
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void openThreadDialog(thread);
  });
  return li;
}

// The subagent a thread is showing, if it is showing one rather than itself
