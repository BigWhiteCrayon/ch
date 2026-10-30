import type { Thread } from './types.js';
import { element, input } from './shared.js';
import { createThread, state } from './threads.js';
import { render } from './thread-view.js';

export const newThreadDialog = element<HTMLDialogElement>('new-thread-dialog');
export const recentWorkspaces = element<HTMLSelectElement>('recent-workspaces');
export const startInWorkspace = element<HTMLButtonElement>('start-in-workspace');

// Fills the dropdown with these workspaces, the first one selected
export function offerWorkspaces(workspaces: string[]): void {
  recentWorkspaces.replaceChildren(
    ...workspaces.map((workspace) => {
      const option = document.createElement('option');
      option.value = option.textContent = workspace;
      return option;
    })
  );
  if (workspaces.length === 0) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No recent workspaces';
    recentWorkspaces.append(none);
  }
  recentWorkspaces.disabled = startInWorkspace.disabled = workspaces.length === 0;
}

const branchSection = element('branch-section');
const branchChoice = element<HTMLSelectElement>('branch-choice');
const branchName = element<HTMLInputElement>('branch-name');
const branchError = element('branch-error');
// What a new branch starts from: the checkout's current branch, or HEAD when it has none (a detached HEAD)
let branchBase = 'HEAD';
// Which look at the workspace's branches is the latest, so that a slow answer for a workspace the user has since
// moved off cannot fill the dropdown with its branches
let branchLook = 0;

export function startThread(workspace?: string, branch?: Thread['branch']): void {
  newThreadDialog.close();
  createThread(workspace, branch);
  render();
  input.focus();
}

function showBranchError(message: string): void {
  branchError.textContent = message;
  branchError.hidden = !message;
}

// Offers the branches of the chosen workspace. A folder that is not a Git repository has none to offer, so the
// section stays out of the way and the thread starts in the folder as it always did.
async function loadBranches(): Promise<void> {
  const look = ++branchLook;
  const workspace = recentWorkspaces.value;
  branchSection.hidden = true;
  branchChoice.value = '';
  branchName.hidden = true;
  branchName.value = '';
  showBranchError('');
  // Back to just the two fixed choices, whatever the last workspace had
  for (const option of [...branchChoice.options].slice(2)) option.remove();
  if (!workspace) return;
  // Not assumed to answer: a window without Git support, or a bare mock, gives nothing back
  const found = await Promise.resolve(window.threads.branches?.(workspace)).catch(() => undefined);
  if (look !== branchLook || !found?.names?.length) return;
  branchBase = found.current ?? 'HEAD';
  branchChoice.append(
    ...found.names.map((name) => {
      const option = document.createElement('option');
      option.value = option.textContent = name;
      return option;
    })
  );
  branchSection.hidden = false;
}

// A thread on a branch works in that branch's own worktree, which is made first. Said in the dialog, which stays
// open, if it cannot be made.
async function startOnBranch(workspace: string, choice: string): Promise<void> {
  const create = choice === '+new';
  const name = create ? branchName.value.trim() : choice;
  if (!name) return showBranchError('Give the new branch a name.');
  showBranchError('');
  try {
    const worktree = await window.threads.prepareBranch(workspace, name, branchBase, create);
    startThread(workspace, { name, base: branchBase, worktree });
  } catch (err) {
    showBranchError(err instanceof Error ? err.message : String(err));
  }
}

element('new-thread').addEventListener('click', () => {
  offerWorkspaces(state.recentWorkspaces ?? []);
  void loadBranches();
  newThreadDialog.showModal();
});

// A workspace that isn't in the dropdown is picked in the system's own dialog
element('browse-workspace').addEventListener('click', async () => {
  const workspace = await window.threads.chooseWorkspace();
  if (!workspace) return;
  const offered = [...recentWorkspaces.options].map((o) => o.value).filter((f) => f && f !== workspace);
  offerWorkspaces([workspace, ...offered]);
  void loadBranches();
});

recentWorkspaces.addEventListener('change', () => void loadBranches());

// A name is only asked for when the branch is a new one
branchChoice.addEventListener('change', () => {
  branchName.hidden = branchChoice.value !== '+new';
  showBranchError('');
  if (!branchName.hidden) branchName.focus();
});

element('new-thread-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!recentWorkspaces.value) return;
  if (branchChoice.value && !branchSection.hidden) void startOnBranch(recentWorkspaces.value, branchChoice.value);
  else startThread(recentWorkspaces.value);
});

element('general-chat').addEventListener('click', () => startThread());
element('new-thread-cancel').addEventListener('click', () => newThreadDialog.close());

// A thread's changes to its copy of its workspace: looked over in a pop-up, and
// written back to the workspace only when the user says so
