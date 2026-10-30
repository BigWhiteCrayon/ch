import type { AgentEvent, Used, WorkspaceDetails, WorkspaceNote } from './types.js';
import { element, input } from './shared.js';
import { fill } from './tool-calls.js';
import { state, createThread } from './threads.js';
import { SEARCH_MIN, SEARCH_DELAY_MS } from './search.js';
import { workspaceName } from './sidebar.js';
import { openRenameWorkspace } from './rename-feedback.js';
import { render } from './thread-view.js';

// What a workspace and a thread are keeping, shown on a right-click in the
// sidebar. The notes here are otherwise read by nobody but the models: this is
// the one place the user can see what the assistants in a workspace have been
// told about it, and what one thread has made of that.

export const workspaceDialog = element<HTMLDialogElement>('workspace-dialog');
export const workspaceDialogName = element('workspace-dialog-name');
export const workspaceDialogPath = element('workspace-dialog-path');
export const workspaceDialogBody = element('workspace-dialog-body');
export const workspaceDialogRelook = element<HTMLButtonElement>('workspace-dialog-relook');
// The workspace the open dialog is about
export let shownWorkspace: string | null = null;

// How old what is being read is, in words rather than a timestamp
export function when(at: string | null): string {
  if (!at) return '';
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'written just now';
  if (minutes < 60) return `written ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `written ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `written ${days} day${days === 1 ? '' : 's'} ago`;
}

// Workspaces being looked at again at the user's asking, so the button says so
// however the dialog is opened and closed in the meantime
export const relooking = new Set<string>();

// What the button says: a look under way cannot be asked for twice, whether
// this dialog set it going or the workspace was simply opened for the first time
export function showRelook(going: boolean): void {
  workspaceDialogRelook.disabled = going;
  workspaceDialogRelook.textContent = going ? 'Looking…' : 'Look again';
  workspaceDialogRelook.title = going
    ? 'An explorer is going through this workspace'
    : 'Throw the notes away and have an explorer write them again';
}

// Reads what the workspace is keeping and puts it in the open dialog. Apart
// from opening it, so that a look finishing can refresh what is on screen.
export async function fillWorkspaceDialog(workspace: string): Promise<void> {
  const details = await window.threads.workspace(workspace).catch(() => null);
  // Another workspace was asked for while this one was being fetched
  if (shownWorkspace !== workspace) return;
  workspaceDialogBody.replaceChildren();
  if (!details) {
    fill(workspaceDialogBody, [['', 'What this workspace is keeping could not be read.']]);
    return;
  }
  const going = details.surveying || relooking.has(workspace);
  showRelook(going);
  const threads = state.threads.filter((t) => t.workspace === workspace).length;
  workspaceDialogPath.textContent = [
    workspace,
    `${threads} thread${threads === 1 ? '' : 's'}`,
    details.note ? when(details.writtenAt) : '',
    going ? 'being looked at now' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  fill(workspaceDialogBody, [
    [
      'Workspace notes',
      details.note ||
        (going
          ? 'An explorer is going through this workspace now. What it finds will appear here.'
          : 'Nothing has been written about this workspace yet. It is looked at when a thread is first opened in it.'),
    ],
  ]);
  // Not over the results of a search the user is reading: those are theirs
  // until they clear the box
  if (workspaceNotesQuery.value.trim().length < SEARCH_MIN) fillNotes(details, going);
}

// ---- The notes behind that one note (see harness/notes.ts)
//
// The workspace keeps one short note that every message in it carries, and
// behind that a note for each particular thing anybody working here has worked
// out. Those are written and read by the models alone, through a search, and
// there are too many of them to put on screen at once — so they are shown the
// way the models get at them: the newest to begin with, and the same search by
// meaning for everything else.

export const workspaceNotesLabel = element('workspace-notes-label');
export const workspaceNotesQuery = element<HTMLInputElement>('workspace-notes-query');
export const workspaceNotesList = element('workspace-notes-list');
// Which search the notes on screen are from: an answer to an earlier one is
// dropped rather than drawn over a later one, as in the thread search
export let searchingNotes = 0;

// Which thread wrote a note that has not been written back to the workspace
// yet, by name where the window still has it
export function whoseNote(thread: string): string {
  const found = state.threads.find(({ id }) => id === thread);
  return found?.title ? `in the thread “${found.title}”` : 'in one thread';
}

// One note as the user reads it: what it is about, how old it is, the files it
// was worked out from, and whether those have moved on since — which is as
// much as anybody can say about whether it is still true (see notes.check).
export function drawNote(note: WorkspaceNote): HTMLElement {
  const row = document.createElement('div');
  row.className = 'note';
  const head = document.createElement('div');
  head.className = 'note-head';
  const subject = document.createElement('div');
  subject.className = 'note-subject';
  subject.textContent = note.subject;
  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'delete';
  forget.textContent = '\u00d7';
  forget.title = 'Forget this note';
  forget.setAttribute('aria-label', `Forget the note on ${note.subject}`);
  forget.addEventListener('click', () => void forgetNote(note, forget));
  head.append(subject, forget);
  row.append(head);

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  meta.textContent = [when(note.writtenAt), note.thread ? whoseNote(note.thread) : '', note.files.join(', ')]
    .filter(Boolean)
    .join(' · ');
  row.append(meta);

  if (note.drift) {
    const stale = document.createElement('div');
    stale.className = 'note-stale';
    const { changed, gone } = note.drift;
    stale.textContent = [
      gone.length > 0 ? `${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} no longer there` : '',
      changed.length > 0 ? `${changed.join(', ')} ${changed.length > 1 ? 'have' : 'has'} changed` : '',
    ]
      .filter(Boolean)
      .join('; ');
    stale.title = 'What this note was worked out from has moved on, so it may no longer be true';
    row.append(stale);
  }

  const body = document.createElement('pre');
  body.textContent = note.content;
  row.append(body);
  return row;
}

// Puts a set of notes on screen under a heading, or says why there are none
export function drawNotes(label: string, notes: WorkspaceNote[], nothing: string): void {
  workspaceNotesLabel.textContent = label;
  workspaceNotesList.replaceChildren();
  if (notes.length === 0) {
    const said = document.createElement('p');
    said.className = 'hint';
    said.textContent = nothing;
    workspaceNotesList.append(said);
    return;
  }
  for (const note of notes) workspaceNotesList.append(drawNote(note));
}

// The newest of them, which is what is shown until something is searched for
export function fillNotes(details: WorkspaceDetails, going: boolean): void {
  const kept = details.notes.length + details.moreNotes;
  const more = details.moreNotes > 0 ? ` · showing the newest ${details.notes.length}` : '';
  drawNotes(
    kept > 0 ? `Notes · ${kept}${more}` : 'Notes',
    details.notes,
    going
      ? 'An explorer is going through this workspace now. What it works out will be written down here.'
      : 'Nothing has been written down here yet. Threads add a note whenever they work something out about this ' +
          'workspace, and search them before going looking.'
  );
}

// ...and the same search by meaning the models make of them, so that what the
// user reads here is what a thread asking this would be given
export async function runNoteSearch(workspace: string, query: string): Promise<void> {
  const mine = ++searchingNotes;
  let hits: WorkspaceNote[];
  try {
    hits = await window.threads.searchNotes(workspace, query);
  } catch (err) {
    if (mine === searchingNotes && shownWorkspace === workspace) {
      drawNotes(`Notes matching “${query}”`, [], `Those notes could not be searched: ${(err as Error).message}`);
    }
    return;
  }
  // A later search, or another workspace, has been asked for since
  if (mine !== searchingNotes || shownWorkspace !== workspace) return;
  drawNotes(`Notes matching “${query}” · ${hits.length}`, hits, 'No note here is about that.');
}

// Throws one note away at the user's asking. The models never do: a note is
// corrected by writing its subject again (see harness/notes.add), so a note
// that should never have been written — a thing worked out wrong, or a thing
// that has stopped being true in a way reading its files cannot show — would
// otherwise stay until the workspace ran out of room for it. It cannot be had
// back, which is why the button is the one the threads use for the same thing.
//
// What is on screen is drawn again from the store rather than patched, so the
// count in the heading and a search's results both say what is really there.
export async function forgetNote(note: WorkspaceNote, button: HTMLButtonElement): Promise<void> {
  const workspace = shownWorkspace;
  if (!workspace) return;
  button.disabled = true;
  try {
    await window.threads.forgetNote(workspace, note.subject, note.thread);
  } catch (err) {
    button.disabled = false;
    button.title = `That note could not be thrown away: ${(err as Error).message}`;
    return;
  }
  // Another workspace was opened while it was going
  if (shownWorkspace !== workspace) return;
  const query = workspaceNotesQuery.value.trim();
  if (query.length >= SEARCH_MIN) await runNoteSearch(workspace, query);
  else await fillWorkspaceDialog(workspace);
}

export let noteSearchTimer: ReturnType<typeof setTimeout> | undefined;

workspaceNotesQuery.addEventListener('input', () => {
  clearTimeout(noteSearchTimer);
  const workspace = shownWorkspace;
  if (!workspace) return;
  const query = workspaceNotesQuery.value.trim();
  // Too short to search by meaning, so back to the newest (see SEARCH_MIN)
  if (query.length < SEARCH_MIN) {
    searchingNotes++;
    void fillWorkspaceDialog(workspace);
    return;
  }
  // Each search embeds the query, which is a request to Ollama, so it waits
  // for the typing to stop
  noteSearchTimer = setTimeout(() => void runNoteSearch(workspace, query), SEARCH_DELAY_MS);
});

export async function openWorkspaceDialog(workspace: string): Promise<void> {
  shownWorkspace = workspace;
  workspaceDialogName.textContent = workspaceName(workspace);
  workspaceDialogPath.textContent = workspace;
  workspaceDialogBody.replaceChildren();
  workspaceNotesQuery.value = '';
  workspaceNotesList.replaceChildren();
  workspaceNotesLabel.textContent = 'Notes';
  showRelook(relooking.has(workspace));
  if (!workspaceDialog.open) workspaceDialog.showModal();
  await fillWorkspaceDialog(workspace);
}

export function closeWorkspaceDialog(): void {
  shownWorkspace = null;
  workspaceDialog.close();
}

// Throws the notes away and sends an explorer through the workspace again.
// The dialog stays open and fills in with what it wrote, and every thread in
// the workspace is told as usual (see window.threads.onSurveyed).
workspaceDialogRelook.addEventListener('click', async () => {
  const workspace = shownWorkspace;
  if (!workspace || relooking.has(workspace)) return;
  relooking.add(workspace);
  showRelook(true);
  await fillWorkspaceDialog(workspace);
  // The thread whose container the explorer's search is run from, if one is open
  const thread = state.threads.find((t) => t.workspace === workspace);
  try {
    await window.threads.relook(workspace, thread?.id);
  } catch {
    // Whatever went wrong, what the workspace has now is what is shown below
  } finally {
    relooking.delete(workspace);
    if (shownWorkspace === workspace) await fillWorkspaceDialog(workspace);
  }
});

element('workspace-dialog-close').addEventListener('click', closeWorkspaceDialog);
element('workspace-dialog-rename').addEventListener('click', () => {
  const workspace = shownWorkspace;
  closeWorkspaceDialog();
  if (workspace) openRenameWorkspace(workspace);
});
element('workspace-dialog-new').addEventListener('click', () => {
  const workspace = shownWorkspace;
  closeWorkspaceDialog();
  if (!workspace) return;
  createThread(workspace);
  render();
  input.focus();
});

// One subagent, opened from its row in the sidebar: what it was given, what
// it is doing as it does it, and what it brought back. It fills in while the
// subagent works, so it can be left open and watched.

// The subagent the open dialog is about: a thread's, or the workspace's own
// explorer, which is a subagent of the same sort sent by nobody's thread

// What the dialog shows, whichever sort of subagent it is about
export interface Watched {
  name: string;
  // How the piece was rated and what it went to, as a note above the work:
  // the same thing a thread is told about its own reply (see the
  // 'classification' note in the thread)
  rating?: string;
  // What it has used, and how long its models kept it waiting
  usage?: Used[];
  // Whether the call it is on is counted in that, it being still unfinished
  // (see Live): what the note says is "so far" while it is
  counting?: boolean;
  // When it began, if this window saw it (see startedAgents)
  since?: number;
  task?: string;
  // The caption over that task (see goalOf)
  goal?: string;
  // What it did as it worked, oldest first
  events?: AgentEvent[];
  working: boolean;
  failed?: boolean;
  // What it brought back, once it has
  result?: string;
}

// Where the dropdown for a subagent is remembered by, in the thread and here
