import type { AgentEvent, Message, PlanMode, State, Thread, ThreadPiece, ToolImage, Waits } from './types.js';
import {
  drafts,
  idleTimers,
  indexed,
  indexTimer,
  inflight,
  input,
  INDEX_INTERVAL_MS,
  MAX_RECENT_WORKSPACES,
  MAX_RESTARTS,
  SAVE_INTERVAL_MS,
  saveTimer,
  setIndexed,
  setIndexTimer,
  setSaveTimer,
  STORAGE_KEY,
} from './shared.js';
import { endOfTurn } from './reply.js';
import { isWorking } from './sidebar.js';
import { dropApproval } from './approvals.js';
import { dropQuestion } from './questions.js';
import { clearDraft, loadDraft, stashDraft } from './attachments.js';

// Every screenshot and clip the threads carry, each with a stable id of its
// own: the key it is written to the sidecar by, and the name the JSON keeps in
// its place. Given when the item first comes into memory and never changed, so
// a shot taken twice in one session is written to the sidecar once. Declared
// here, before the threads are loaded, because the load hangs the saved media
// back on the threads (see reattachMedia below) and so runs as this module is
// evaluated.
const persistedMedia = new Set<string>();
const idFor = (): string => crypto.randomUUID();

export const state = load();

export function load(): State {
  try {
    // Threads used to be kept in the window's own storage, which is where
    // they are still found the first time this version runs
    const text = window.threads.load() ?? localStorage.getItem(STORAGE_KEY);
    const saved = JSON.parse(text ?? 'null') as State | null;
    if (saved && Array.isArray(saved.threads)) {
      for (const thread of saved.threads) {
        // A message still marked as being replied to is one the app went down
        // in the middle of. Counted here, so that a reply it goes down on
        // twice is left alone rather than tried for ever (see resumeCutOff).
        for (const m of thread.messages) {
          if (m.role === 'user' && m.pending !== undefined) m.pending++;
        }
        // Drop a reply that was still streaming with nothing to show for it
        thread.messages = thread.messages.filter((m) => !m.streaming || m.text);
        // Planning used to be a switch: on, or off for good
        const switched = thread as { plan?: PlanMode | boolean };
        if (switched.plan === true) thread.plan = 'always';
        else if (switched.plan === false) delete thread.plan;
        thread.messages.forEach((m) => {
          delete m.streaming;
          delete m.status;
          // A subagent used to report its work as lines of text rather than
          // as the events the work is made of. What was saved then is kept as
          // thoughts: less than it would be now, but still readable.
          const was = m as Message & { lines?: string[] };
          if (m.role === 'subagent' && was.lines && !m.events) {
            m.events = was.lines.map((text) => ({ type: 'thought', text }) as AgentEvent);
          }
          delete was.lines;
          // A subagent that was still working when the app closed is not
          // working now. It is started again (see resumeSubagents), unless it
          // cannot be, or has already been started again once and the app
          // closed on it again: then it is failed, since nothing is going to
          // finish it and left as it was it would show a working mark in the
          // sidebar for ever.
          if (m.role === 'subagent' && m.finding === undefined) {
            if (m.thoughtId && m.task && (m.restarts ?? 0) < MAX_RESTARTS) {
              delete m.progress;
            } else {
              m.finding = 'The app closed before this finished.';
              m.failed = true;
            }
          }
        });
      }
      // A workspace used to be called a folder, and was saved under that name
      for (const thread of saved.threads) {
        const was = thread as Thread & { folder?: string };
        if (was.workspace === undefined && was.folder !== undefined) was.workspace = was.folder;
        delete was.folder;
      }
      // A workspace's own subagent used to be a row in the sidebar rather than a
      // thread, with the workspaces whose row was hidden kept here
      delete (saved as State & { hiddenWork?: string[] }).hiddenWork;
      const older = saved as State & { recentFolders?: string[]; folderNames?: Record<string, string> };
      older.recentWorkspaces ??= older.recentFolders;
      older.workspaceNames ??= older.folderNames;
      delete older.recentFolders;
      delete older.folderNames;
      // Timings saved when they were the wait before a model began to answer,
      // which is not what they are now (see Waits). A sum of first-token waits
      // is no kind of total, and there is nothing in what was kept to work the
      // total out from, so the old ones are dropped rather than shown as
      // something they never measured. Told apart by the field they were kept
      // under, the old shape having `waited` where this one has `spent`.
      const stale = (used: { waits?: Waits }) => {
        if (used.waits && (used.waits as Waits & { waited?: number }).waited !== undefined) delete used.waits;
      };
      for (const day of Object.values(saved.daily ?? {})) for (const total of Object.values(day)) stale(total);
      for (const thread of saved.threads) {
        for (const total of Object.values(thread.usage ?? {})) stale(total);
        for (const message of thread.messages) message.usage?.forEach(stale);
      }
      // Saved before recent workspaces were kept: start from the threads' own
      saved.recentWorkspaces ??= [...new Set(saved.threads.flatMap((t) => (t.workspace ? [t.workspace] : [])))].slice(
        0,
        MAX_RECENT_WORKSPACES
      );
      // The screenshots and clips were kept out of this JSON, in a sidecar
      // beside it (see save). What is here is their id, so the bytes are hung
      // back on now; one whose bytes have fallen out of the sidecar's cap is
      // left as a name with no picture behind it, and draws nothing.
      reattachMedia(saved);
      return saved;
    }
  } catch {}
  return { threads: [], activeId: null };
}

// The media the JSON will keep only as a name: its id, its bytes and type sent
// to the sidecar in the same breath. Every item gets an id before the JSON is
// built, so the replacer and the sidecar agree on which is which.
function collectMedia(): { id: string; mediaType: string; data: string }[] {
  const items: { id: string; mediaType: string; data: string }[] = [];
  for (const thread of state.threads) {
    for (const message of thread.messages) {
      for (const image of message.images ?? []) {
        if (!image.id) image.id = idFor();
        if (image.data && !persistedMedia.has(image.id)) {
          items.push({ id: image.id, mediaType: image.mediaType, data: image.data });
          persistedMedia.add(image.id);
        }
      }
      for (const video of message.videos ?? []) {
        if (!video.id) video.id = idFor();
        if (video.data && !persistedMedia.has(video.id)) {
          items.push({ id: video.id, mediaType: video.mediaType, data: video.data });
          persistedMedia.add(video.id);
        }
      }
    }
  }
  return items;
}

// Hung back onto the threads as they load: each image or clip the JSON names by
// id is given its bytes and type from the sidecar, and its id marked as
// already written so it is not sent over again. An item whose bytes have fallen
// out of the sidecar's cap is left with no data, which the view draws as
// nothing (see appendMedia).
function reattachMedia(saved: State): void {
  let byId: Record<string, { mediaType: string; data: string }> = {};
  const text = window.threads.loadMedia?.();
  if (text) {
    try {
      byId = JSON.parse(text) as Record<string, { mediaType: string; data: string }>;
    } catch {
      byId = {};
    }
  }
  // A screenshot and a clip share the same shape for this, and the sidecar came
  // back as parsed JSON, so the type it gives back is a plain string, which is
  // one of the media types (see collectMedia)
  const fill = (items?: { id?: string; mediaType: string; data?: string }[]) => {
    for (const item of items ?? []) {
      if (item.data !== undefined || !item.id) continue;
      const bytes = byId[item.id];
      if (!bytes) continue;
      item.mediaType = bytes.mediaType;
      item.data = bytes.data;
      persistedMedia.add(item.id);
    }
  };
  for (const thread of saved.threads) {
    for (const message of thread.messages) {
      fill(message.images);
      fill(message.videos);
    }
  }
}

// The thread state as it is written to disk: the same as in memory, but a
// screenshot or clip is reduced to its id, its bytes and type living in the
// sidecar. Kept to the id alone, so neither the bytes nor their type — a
// clip's is 'video/webm' — touches the thread's JSON, which is written on every
// change and must stay small.
function serialize(): string {
  return JSON.stringify(state, (key, value: unknown) => {
    if ((key === 'images' || key === 'videos') && Array.isArray(value)) {
      return value.map((item: { id?: string }) => ({ id: item.id }));
    }
    return value;
  });
}

// Saved to a file by the main process, so that the threads outlive the app
// however it is shut down
export function save(): void {
  clearTimeout(saveTimer);
  setSaveTimer(undefined);
  // The screenshots and clips a reply took are kept out of the thread's own
  // JSON, which is written to disk on every change and so must stay small:
  // their bytes go to a sidecar beside it (see the main process's store), and
  // the JSON names each one by id. The two are written together, so a thread
  // that outlives the app carries its pictures with it the same way it carries
  // its words, whichever way the app goes down.
  window.threads.saveMedia(collectMedia());
  window.threads.save(serialize());
  indexSoon();
}

// Saves before long, without saving on every piece of a reply as it streams
export function saveSoon(): void {
  setSaveTimer(saveTimer ?? setTimeout(save, SAVE_INTERVAL_MS));
}

// Anything that changed the threads may have changed what there is to search,
// so the index is brought up to date a little after things go quiet. The pieces
// are compared with the ones last sent and nothing goes over if they are the
// same, so a change that left the conversation alone costs one comparison.
export function indexSoon(): void {
  clearTimeout(indexTimer);
  setIndexTimer(
    setTimeout(() => {
      setIndexTimer(undefined);
      const pieces = searchPieces();
      const now = JSON.stringify(pieces);
      if (now === indexed) return;
      setIndexed(now);
      void window.threads.index(pieces).catch(() => {
        // Nothing to embed with, most likely. The search says so when it is used.
        setIndexed('');
      });
    }, INDEX_INTERVAL_MS)
  );
}

// Every thread cut into the pieces a search is over: one per request, holding
// what the user asked and what the assistant said back. Thoughts, tool calls
// and the app's own notes are left out — a search for "docker image" should
// find the exchange about images, not every reply that read a Dockerfile.
export function searchPieces(): ThreadPiece[] {
  return state.threads.flatMap((thread) =>
    thread.messages.flatMap((m, at) => {
      if (m.role !== 'user' || !m.text.trim()) return [];
      const reply = thread.messages
        .slice(at + 1, endOfTurn(thread, m))
        .filter((one) => one.role === 'assistant' && one.text.trim())
        .map((one) => one.text)
        .join('\n\n');
      return [{ thread: thread.id, title: thread.title, at, request: m.text, reply, when: thread.lastActive }];
    })
  );
}

// Closing the window mid-reply keeps what had arrived. The same serialization as
// save, so the two ways the app goes down — a save on its own, and this one on
// the close — leave the JSON and its sidecar saying the same thing
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  window.threads.saveMedia(collectMedia());
  window.threads.saveNow(serialize());
});

// There is always at least one thread, and one of them is always active
export function activeThread(): Thread {
  return state.threads.find((t) => t.id === state.activeId) as Thread;
}

// Puts a thread on screen. If it has a workspace, the main process gets the
// workspace indexed for search, so it is ready by the time it is needed.
export function activate(thread: Thread): void {
  if (state.activeId !== thread.id) {
    // The text in the box belongs to the thread being left, and the box shows the one being entered
    if (state.threads.some((t) => t.id === state.activeId)) {
      if (input.value) drafts.set(state.activeId as string, input.value);
      else drafts.delete(state.activeId as string);
      stashDraft(state.activeId as string);
    }
    input.value = drafts.get(thread.id) ?? '';
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    loadDraft(thread.id);
  }
  state.activeId = thread.id;
  delete thread.unread;
  // Opened, so it goes to the top of the threads with nothing going on, and
  // back into the sidebar if it had been archived
  thread.opened = Date.now();
  delete thread.archived;
  if (thread.workspace) window.threads.open(thread.id, thread.branch?.worktree ?? thread.workspace);
}

// The host folder a thread's files come from and Apply writes to: its branch's worktree if it has one, else the
// workspace. Everything that hands a folder to the main process or the harness wants this, while grouping, recents and
// display keep using thread.workspace, the repo root.
export function sourceOf(thread: Thread): string | undefined {
  return thread.branch?.worktree ?? thread.workspace;
}

export function createThread(workspace?: string, branch?: Thread['branch']): void {
  const thread: Thread = {
    id: crypto.randomUUID(),
    title: 'New thread',
    workspace,
    branch,
    lastActive: Date.now(),
    messages: [],
  };
  if (workspace) {
    const others = (state.recentWorkspaces ?? []).filter((f) => f !== workspace);
    state.recentWorkspaces = [workspace, ...others].slice(0, MAX_RECENT_WORKSPACES);
  }
  state.threads.unshift(thread);
  // A new thread is always in view, even if its group was collapsed
  const hidden = [workspace ?? '', ...(workspace && branch ? [`${workspace}#${branch.name}`] : [])];
  state.collapsed = state.collapsed?.filter((group) => !hidden.includes(group));
  activate(thread);
  save();
}

// The threads branched off this one, newest first (see startOffshoot)
export function offshootsOf(thread: Thread): Thread[] {
  return state.threads.filter((t) => t.offshootOf === thread.id);
}

// Branches a new thread off one whose reply is still being written, so that a comment on what has been said so far
// need not wait for the rest. It starts from the conversation as it stands, the reply's words so far included, and
// is its own thread from then on: it has its own files and its own replies, and the parent goes on unaffected. The
// sidebar lists it under the parent (see threadRows), which is always the thread it all began in.
export function startOffshoot(parent: Thread, title: string): Thread {
  createThread(parent.workspace, parent.branch);
  const thread = state.threads[0];
  thread.offshootOf = parent.offshootOf ?? parent.id;
  thread.title = title.slice(0, 40);
  thread.summary = parent.summary;
  thread.messages = parent.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
    .map(({ role, text, summarized }) => ({ role, text, summarized }));
  // Shown, so that the thread just left is not all there is on screen to say where this one went
  state.openedOffshoots = [...new Set([...(state.openedOffshoots ?? []), thread.offshootOf])];
  save();
  return thread;
}

// Whether something is being written into this thread right now: a reply, or
// the app's own work in a thread it started (see isWorking). Such a thread is
// not deleted — what is thrown away is work nobody asked to lose, and the
// thread cannot be had back.
export function busy(thread: Thread): boolean {
  return inflight.has(thread.id) || isWorking(thread);
}

export function deleteThread(id: string): void {
  const thread = state.threads.find((one) => one.id === id);
  // Guarded here as well as on the button: a thread that is working is not
  // the user's to lose by a stray click, and stopping it is a separate thing
  // they can do first (see the Stop button)
  if (thread && busy(thread)) return;
  clearTimeout(idleTimers.get(id));
  idleTimers.delete(id);
  const requestId = inflight.get(id);
  if (requestId) {
    window.llm.cancel(requestId);
    dropApproval(requestId);
    dropQuestion(requestId);
  }
  window.threads.remove(id);
  drafts.delete(id);
  clearDraft(id);
  state.threads = state.threads.filter((t) => t.id !== id);
  // What was branched off it is not deleted with it, and goes into the sidebar as a thread like any other
  for (const t of state.threads) if (t.offshootOf === id) delete t.offshootOf;
  // The last thread on a branch takes its worktree with it. Git refuses a worktree that has work in it that is not
  // committed, which is then simply left; the branch itself is never deleted.
  const { workspace, branch } = thread ?? {};
  if (workspace && branch && !state.threads.some((t) => t.branch?.worktree === branch.worktree)) {
    window.threads.removeWorktree(workspace, branch.worktree).catch(() => {});
  }
  // Its subagents went with it, so whether they were shown is nothing to keep
  if (state.opened?.includes(id)) state.opened = state.opened.filter((open) => open !== id);
  if (state.openedOffshoots?.includes(id)) {
    state.openedOffshoots = state.openedOffshoots.filter((open) => open !== id);
  }
  if (state.threads.length === 0) createThread();
  // One still in the sidebar, rather than bringing an archived one back
  else if (state.activeId === id) {
    const parent = state.threads.find((t) => t.id === thread?.offshootOf);
    activate(parent ?? state.threads.find((t) => !t.archived) ?? state.threads[0]);
  }
  save();
}

export function addMessage(
  thread: Thread,
  role: Message['role'],
  text: string,
  images?: ToolImage[]
): Message {
  const message: Message = { role, text, ...(images?.length ? { images } : {}) };
  thread.messages.push(message);
  // Name the thread after its first message
  if (thread.messages.length === 1) thread.title = text.slice(0, 40);
  save();
  return message;
}
