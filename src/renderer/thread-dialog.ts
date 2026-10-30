import type { Message, Thread } from './types.js';
import type { Watched } from './workspace-dialog.js';
import type { Section } from './tool-calls.js';
import { element, requests, inflight, startedAgents } from './shared.js';
import { fill, lineDiff } from './tool-calls.js';
import { save, activate } from './threads.js';
import { workspaceName } from './sidebar.js';
import { render } from './thread-view.js';
import { openChanges } from './changes.js';

export const subagentKey = (subagent: Message) => subagent.thoughtId ?? subagent.text;

// A thread's subagent as its tab shows it
// How a piece of work was rated, in the words a thread's own note uses. Empty
// for one handed out before there were ratings, or by a model that gave none.
export function ratingOf(subagent: Message): string | undefined {
  const parts = [
    subagent.kind ?? 'subagent',
    ...(subagent.complexity ? [`${subagent.complexity}/5 Complexity`] : []),
    ...(subagent.effort ? [`${subagent.effort} effort`] : []),
    ...(subagent.served ? [subagent.served] : []),
  ];
  return parts.length > 1 ? parts.join(' · ') : undefined;
}

// What the task at the top of a subagent's tab is captioned with. The task was
// written by the model that handed the work out, so the tab opens on words
// nobody in the conversation said; the caption says whose goal they are.
export function goalOf(subagent: Message): string {
  const kind = subagent.kind ?? 'subagent';
  return `${kind[0].toUpperCase()}${kind.slice(1)}'s Goal`;
}

export function watchedSubagent(thread: Thread, subagent: Message): Watched {
  const working = subagent.finding === undefined;
  // What the call it is on has used so far, which is held with the request
  // rather than with the subagent (see Live). Found by the id its events
  // carry, which is what the request knows it by.
  const request = requests.get(inflight.get(thread.id) ?? '');
  const id = [...(request?.subagents ?? [])].find(([, one]) => one === subagent)?.[0];
  const live = id === undefined ? undefined : request?.live.get(id);
  return {
    name: subagent.text,
    rating: ratingOf(subagent),
    usage: live ? [...(subagent.usage ?? []), live] : subagent.usage,
    counting: !!live,
    since: startedAgents.get(subagent),
    task: subagent.task,
    goal: goalOf(subagent),
    events: subagent.events,
    working,
    failed: subagent.failed,
    result: subagent.finding,
  };
}

// Its dropdown in the thread, where the reply it belongs to can be read around it
export const threadDialog = element<HTMLDialogElement>('thread-dialog');
export const threadDialogName = element('thread-dialog-name');
export const threadDialogPath = element('thread-dialog-path');
export const threadDialogBody = element('thread-dialog-body');
export const threadPlan = element('thread-plan');
export const threadPlanMode = element<HTMLSelectElement>('thread-plan-mode');
export const threadInvestigate = element('thread-investigate');
export const threadInvestigateMode = element<HTMLInputElement>('thread-investigate-mode');
export let shownThread: Thread | null = null;

export async function openThreadDialog(thread: Thread): Promise<void> {
  shownThread = thread;
  threadDialogName.textContent = thread.title;
  threadDialogPath.textContent = thread.workspace
    ? `In ${workspaceName(thread.workspace)}`
    : 'A general chat, with no workspace';
  // Only where there is code to plan a change to. A thread with no workspace
  // has no files, so the steps would have nothing to work through.
  threadPlan.hidden = !thread.workspace;
  threadPlanMode.value = thread.plan ?? 'auto';
  threadInvestigate.hidden = !thread.workspace;
  threadInvestigateMode.checked = thread.investigate === true;
  threadDialogBody.replaceChildren();
  threadDialog.showModal();
  const details = await window.threads.details(thread.id, thread.workspace).catch(() => null);
  if (shownThread !== thread) return;
  threadDialogBody.replaceChildren();
  if (!details) {
    fill(threadDialogBody, [['', 'What this thread is keeping could not be read.']]);
    return;
  }
  // What the thread has done to the workspace's note. Its own copy begins as
  // the workspace's, so anything that differs is the thread's own work, and
  // goes back to the workspace when its files do.
  const changed = details.note !== details.shared;
  fill(threadDialogBody, [
    [
      'Thread context',
      details.context ||
        'This thread has written nothing down for itself yet. It keeps its own notes with save_context.',
    ],
    ...(thread.workspace
      ? ([
          [
            'Changes to the workspace notes',
            changed ? lineDiff(details.shared, details.note) : 'This thread has not changed the workspace notes.',
            changed ? 'diff' : undefined,
          ],
          ...(changed ? ([['The notes as this thread has them', details.note]] as Section[]) : []),
        ] as Section[])
      : []),
  ]);
}

// Takes effect on the next message: a reply already being written is working
// under the steps it started with
threadPlanMode.addEventListener('change', () => {
  if (!shownThread) return;
  const mode = threadPlanMode.value;
  if (mode === 'always' || mode === 'never') shownThread.plan = mode;
  else delete shownThread.plan;
  save();
});

// Takes effect on the next message, as the plan setting does
threadInvestigateMode.addEventListener('change', () => {
  if (!shownThread) return;
  if (threadInvestigateMode.checked) shownThread.investigate = true;
  else delete shownThread.investigate;
  save();
});

export function closeThreadDialog(): void {
  shownThread = null;
  threadDialog.close();
}

element('thread-dialog-close').addEventListener('click', closeThreadDialog);
element('thread-dialog-changes').addEventListener('click', () => {
  const thread = shownThread;
  closeThreadDialog();
  if (!thread?.workspace) return;
  activate(thread);
  save();
  render();
  openChanges(thread);
});

// Naming a workspace: the name is shown in the sidebar and above the thread in
// place of the workspace's own, and is kept with the threads
