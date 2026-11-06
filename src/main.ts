import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import path from 'path';
import * as contextmenu from './contextmenu';
import * as feedback from './feedback';
import * as harness from './harness';
import * as llm from './llm';
import * as cachelock from './llm/cachelock';
import * as ollama from './llm/ollama';
import * as log from './log';
import * as menu from './menu';
import * as sandbox from './sandbox';
import * as search from './search';
import * as settings from './settings';
import * as setup from './setup';
import * as store from './store';
import * as tools from './tools';
import type {
  ClassificationFeedback,
  DescriptionRequest,
  FileAccessAnswer,
  HarnessRequest,
  ListModelsOptions,
  PullProgress,
  RetryRequest,
  Installable,
  SettingsPatch,
  SetupProgress,
  SuggestionRequest,
  SummaryRequest,
  ThreadPiece,
  VerificationRequest,
  WorkspaceNote,
} from './types';

// What the app calls itself: the menu bar, the About panel and any dialog it
// opens. Set outright rather than left to be read from package.json, which
// Electron only does for some ways of starting the app; the window title adds
// the project to it (see renderer.ts).
const APP_NAME = 'ch';
app.setName(APP_NAME);

// The app's own mark, in place of Electron's: the name in a rounded square
// (see assets/icon.svg, which is what it is drawn from). Beside dist/ rather
// than in it, since it is not built from anything the compiler knows about.
//
// Where it shows depends on the platform. Windows and Linux take it from the
// window, macOS from the dock, and neither is given the other's — so both are
// set, and each ignores what it has no use for.
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// A capture runs the app on a virtual display of its own and grabs the whole
// screen (see appShotCommand in tools/sandbox.ts). A screen with no window
// manager shows a window smaller than it as a black bar on its right and bottom,
// so a capture names the display's size through these two and the window is made
// to fill it. A run the user starts sets neither, and the window opens at the
// sizes below, as the app has always done.
function envSize(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: envSize('CH_WINDOW_WIDTH', 1000),
    height: envSize('CH_WINDOW_HEIGHT', 700),
    minWidth: 600,
    minHeight: 400,
    // Until the page sets its own, which adds the project (see renderer.ts)
    title: APP_NAME,
    icon: ICON,
    // macOS: no frame of its own. The page's own top bar is the title bar, with
    // the window's buttons inset into it and the bar itself what the window is
    // dragged by (see body > header in styles.css). Left alone on Windows and
    // Linux, where a frameless window would have to draw its own close,
    // minimise and maximise buttons.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Links in a reply open in the user's browser; the window itself never
  // leaves the app's own page
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Right-click: corrections for a misspelt word, and cut, copy and paste
  contextmenu.attach(win.webContents);
  // What goes wrong in the window is logged with everything else
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'error') log.error('renderer.error', { error: message, source: `${sourceId}:${lineNumber}` });
  });
  win.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    log.error('renderer.gone', { reason, exitCode });
  });
  // index.html sits beside the compiled output directory
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

// A switch in the menu thrown: saved, put into effect and shown to every
// window, which asks for what is on offer again.
function change(name: 'offline' | 'fast', patch: SettingsPatch): void {
  try {
    const updated = settings.update(patch);
    llm.configure(updated);
    log.info(`settings.${name}`, { [name]: updated[name] });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', settings.publicView());
    }
  } catch (err) {
    log.error(`settings.${name}`, { ok: false, error: (err as Error).message });
    dialog.showErrorBox(APP_NAME, (err as Error).message);
  }
  showMenu();
}

// What there is to switch between, which the Offline and Fast switches are
// greyed out without: Fast prefers hosted models, Offline keeps to local ones,
// and neither means anything when that side of the machine is empty. Kept
// here rather than asked for as the menu is built, because building a menu is
// synchronous and finding out is not.
let available = { local: false, hosted: false };

// Asked again whenever what it is made of may have changed: a key saved, a
// model downloaded, a local server started. Never throws: a switch greyed out
// because the check failed would be worse than one that does nothing.
async function refreshAvailable(): Promise<void> {
  try {
    const status = await setup.status();
    available = {
      local: status.local.models > 0,
      hosted: status.keys.anthropic || status.keys.openai,
    };
  } catch (err) {
    log.warn('setup.available', { ok: false, error: (err as Error).message });
  }
  showMenu();
}

// The app's menu, which holds the Offline and Fast switches (see menu.ts). Built again
// whenever the switch is thrown, so its tick shows what the setting actually
// came to rather than what was clicked.
function showMenu(): void {
  const { offline, fast } = settings.get();
  menu.install({
    name: APP_NAME,
    offline,
    // A switch that is on can always be turned off, whatever is available:
    // the one thing a user with a dead Ollama and Offline on needs is the way
    // back out of it
    offlineEnabled: offline || available.local,
    onOffline: (on) => change('offline', { offline: on }),
    fast,
    fastEnabled: fast || available.hosted,
    onFast: (on) => change('fast', { fast: on }),
  });
}

// How long the threads' search index may take to build, and a search of it to
// answer. Indexing a long history embeds it a batch at a time; a search is one
// embedding of one short query.
const INDEX_MS = 300000;
const SEARCH_MS = 30000;

// requestId -> AbortController for every reply being generated
const active = new Map<string, AbortController>();

// A notification the user clicked (see notify in renderer.ts). The page asks
// for this because it cannot raise itself: by the time a notification is
// shown the user is in another app or another window, and window.focus() does
// not bring an app forward from there. Minimised, hidden behind another
// window, or the whole app switched away from are all the same ask.
ipcMain.on('host:show', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  // macOS: the window coming forward is not the app coming forward, and an
  // app the user switched away from is not allowed to take focus back without
  // saying it means to. Ignored on the other platforms, where show() is
  // already enough.
  app.focus({ steal: true });
});

// How many threads have news the user has not seen, shown on the app's icon:
// the dock's badge on macOS, where 0 takes it away. Other platforms have no
// such badge to give, so it is left to macOS alone.
ipcMain.on('host:badge', (_event, count: unknown) => {
  if (process.platform !== 'darwin') return;
  app.setBadgeCount(typeof count === 'number' && count > 0 ? Math.floor(count) : 0);
});

// The UI always asks the providers afresh, e.g. right after a model download
ipcMain.handle('llm:models', (_event, options?: ListModelsOptions) => llm.listModels({ ...options, fresh: true }));

// How the user rated a message's classification
ipcMain.on('llm:feedback', (_event, verdict: ClassificationFeedback) => feedback.record(verdict));

// A thread that has gone quiet is condensed, for use in its later messages
ipcMain.handle('llm:summarize', (_event, request: SummaryRequest) => harness.summarize(request));

// A thread is named after what the user has asked for in it
ipcMain.handle('llm:describe', (_event, request: DescriptionRequest) => harness.describe(request));

// What the user might say next, offered in the message box after a reply
ipcMain.handle('llm:suggest', (_event, request: SuggestionRequest) => harness.suggest(request));

// A reply's changes are checked by a model at least as capable as the one that
// wrote them, at the user's asking (see harness/verifier.ts). One that tries them
// in the thread's container has its files put back afterwards, unless a reply
// has started on the thread since, whose changes would go with them: a request
// starting is what moves beforeRequest on.
ipcMain.handle('llm:verify', (_event, request: VerificationRequest) => {
  const latest = beforeRequest.get(request.thread)?.request;
  return harness.verify(request, { untouched: () => beforeRequest.get(request.thread)?.request === latest });
});

// The thread as it was when its latest request started: its files, and the
// context note it keeps in its container. Both are kept so that an attempt
// whose messages the user throws away can be undone before the next attempt
// at the same message (see 'thread:revert'). One per thread: a request
// starting is the moment the one before it stops being the latest.
const beforeRequest = new Map<string, { request: string; tree: string | null; context: string }>();

ipcMain.on('llm:send', async (event, requestId: string, request: HarnessRequest) => {
  const controller = new AbortController();
  active.set(requestId, controller);
  if (request.thread) {
    const [tree, context] = await Promise.all([
      sandbox.changes.snapshot(request.thread),
      sandbox.readContext(request.thread),
    ]);
    beforeRequest.set(request.thread, { request: requestId, tree, context });
  }
  const started = performance.now();
  const where = { request: requestId, thread: request.thread };
  log.info('request.start', {
    ...where,
    messages: request.messages?.length,
    workspace: Boolean(request.workspace),
    summarized: Boolean(request.summary),
    picked: request.model,
  });
  // How the reply ended; stays as it is if the harness never said
  let outcome: log.Fields = { ok: false, error: 'The reply ended without finishing.' };
  // Whether the reply was a suggestion, read from the classification event as it
  // is said. A suggestion makes its change in a demo copy to be shown, not kept,
  // so however the reply ends its files go back to how they were at the start of
  // the request (see the revert in finally): the user is shown the suggestion,
  // and is never left with it as a change to their project.
  let suggested = false;
  try {
    for await (const chatEvent of harness.run(request, controller.signal, requestId)) {
      if (chatEvent.type === 'classification') {
        if (!chatEvent.failed && chatEvent.category === 'suggestion') suggested = true;
      } else if (chatEvent.type === 'done') {
        const { stopReason, steps, usage } = chatEvent;
        outcome = {
          ok: true,
          stopReason,
          steps,
          input: usage?.input,
          output: usage?.output,
          // Part of input, not beside it (see Usage): what the reply as a
          // whole read back from the prompt cache rather than paid full price
          // for, which is the figure to read a slow or dear reply against
          cacheRead: usage?.cacheRead,
          cacheWrite: usage?.cacheWrite,
        };
      } else if (chatEvent.type === 'error') {
        outcome = { ok: false, code: chatEvent.code, status: chatEvent.status, error: chatEvent.message };
      }
      if (event.sender.isDestroyed()) {
        controller.abort();
        outcome = { ok: false, error: 'The window was closed.' };
        break;
      }
      event.sender.send('llm:event', requestId, chatEvent);
    }
  } catch (err) {
    outcome = { ok: false, error: err };
    throw err;
  } finally {
    active.delete(requestId);
    // A suggestion is shown, not kept: however it ended, its files go back to
    // how they were when the request started, and the context note it wrote is
    // put back too, so the next message is not told what this one suggested. The
    // snapshot and the note were held for this the moment the request started
    // (see beforeRequest), for the same reason as the revert the user asks for
    // on a thrown-away attempt (see thread:revert).
    if (suggested) {
      const threadId = request.thread;
      const held = threadId ? beforeRequest.get(threadId) : undefined;
      if (threadId && held && held.request === requestId) {
        beforeRequest.delete(threadId);
        const back = await sandbox.changes.revert(threadId, held.tree);
        // After the files, which carry a note of their own in the tree they are
        // put back from (see thread:revert): this is the last word on what the
        // note says either way.
        await sandbox.restoreContext(threadId, held.context);
        log.info('request.reverted', { ...where, suggestion: true, back });
      }
    }
    // However it ended, there is no next step of this reply to keep a local
    // model's prompt for, and the next message in the thread is as far off as
    // the user is. Said here rather than in the harness because every way a
    // reply can end comes through here (see llm/cachelock.ts).
    cachelock.broke(request.thread, 'reply over');
    const ended = { ...where, ms: log.since(started), ...outcome };
    if (outcome.ok) log.info('request.end', ended);
    else log.error('request.end', ended);
  }
});

ipcMain.on('llm:cancel', (_event, requestId: string) => {
  active.get(requestId)?.abort();
});

ipcMain.on('llm:allow-file-access', (_event, id: string, answer: FileAccessAnswer) =>
  harness.answerFileAccess(id, answer)
);

// Whether one command that could lose work may run (see harness/access.ts)
ipcMain.on('llm:allow-command', (_event, id: string, allowed: boolean) =>
  harness.answerCommandAccess(id, allowed === true)
);

ipcMain.on('llm:approve', (_event, requestId: string, approved: boolean) =>
  harness.answerApproval(requestId, approved === true)
);

ipcMain.on('llm:answer', (_event, requestId: string, answer: string) =>
  harness.answerQuestion(requestId, typeof answer === 'string' ? answer : '')
);

// One failed subagent, run again because the user asked for it. Its work goes
// to the window as it happens, under the thread and the name it is known by,
// and what it finally brings back is the answer to this call.
ipcMain.handle('llm:retry-subagent', (_event, request: RetryRequest) =>
  harness.subagents.retry(
    request,
    (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('llm:subagent-event', request.thread, request.id, event);
      }
    },
    new AbortController().signal
  )
);

// Browsing for a new thread's workspace; null if the user backs out
ipcMain.handle('thread:choose-workspace', async (event) => {
  const options: OpenDialogOptions = {
    title: 'Choose a workspace for this thread',
    buttonLabel: 'Start here',
    properties: ['openDirectory', 'createDirectory'],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  return canceled ? null : (filePaths[0] ?? null);
});

// The branches a new thread could work on in a workspace, and the one that is checked out
ipcMain.handle('thread:branches', (_event, workspace: string) => sandbox.worktree.branches(workspace));

// A worktree of the workspace on the branch the thread will work on, made from `base` if the branch is new
ipcMain.handle('thread:prepare-branch', (_event, workspace: string, branch: string, base: string, create: boolean) =>
  sandbox.worktree.ensureWorktree(workspace, app.getPath('userData'), branch, base, create)
);

// Where a branch's worktree stands, and committing, pushing and pulling it. Git runs here, on the host, so the
// user's own credentials do the pushing; the thread's container never sees them.
ipcMain.handle('thread:branch-status', (_event, worktree: string) => sandbox.worktree.status(worktree));
ipcMain.handle('thread:branch-commit', (_event, worktree: string, message: string) =>
  sandbox.worktree.commit(worktree, message)
);
ipcMain.handle('thread:branch-push', (_event, worktree: string) => sandbox.worktree.push(worktree));
ipcMain.handle('thread:branch-pull', (_event, worktree: string) => sandbox.worktree.pull(worktree));

// A worktree nothing is using any more; refused by git if it has uncommitted work
ipcMain.handle('thread:remove-worktree', (_event, workspace: string, worktree: string) =>
  sandbox.worktree.remove(workspace, worktree)
);

// Opening a thread that has a workspace starts indexing the workspace for search
ipcMain.on('thread:open', (_event, threadId: string, workspace: string) => {
  search.open(threadId, workspace);
  // A workspace nobody has looked at yet gets an explorer sent through it, which
  // writes the note on the project that every thread here is shown from then
  // on (see harness/project.ts). Started as soon as the thread exists rather
  // than when it is first used, so the note is being written while the user
  // is still typing.
  if (harness.project.due(workspace)) void harness.project.survey(workspace, threadId);
  // The thread takes the workspace's note as its own to work from and add to
  harness.project.adopt(workspace, threadId);
});

// Which workspaces are being looked at right now: asked for once by a window
// that has just opened, which missed any news from before it existed
ipcMain.handle('workspaces:looking', () => harness.project.looking());

// A look starting or ending, pushed so the window can show it going on under
// the workspace it is of rather than under any one thread
harness.project.onLook((workspace, going, task) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('project:looking', workspace, going, task);
  }
  if (going) void follow(workspace);
});

// Passes on what the explorer says while it works, so the window can show the
// work itself and not only the note it ends with. Watching replays from the
// beginning, so nothing said before this started is missed.
async function follow(workspace: string): Promise<void> {
  try {
    for await (const event of harness.project.watch(workspace)) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('project:look-event', workspace, event);
      }
    }
  } catch (err) {
    log.warn('project.follow', { workspace, error: (err as Error).message });
  }
}

// ...and when that note is written, every window hears about it, so that each
// thread in the workspace is shown it without having to ask
harness.project.onSurveyed((workspace, note) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('project:surveyed', workspace, note);
  }
});

// Detailed notes listed in the workspace dialog at once. A workspace may keep
// hundreds (see MAX_NOTES in harness/notes.ts); these are the newest, and the
// rest are reached by searching them, which is what the models do with them
// anyway.
const SHOWN_NOTES = 50;

// One note as the window shows it: its files by name, and what has become of
// them since it was written. The fingerprints themselves are no use to a
// reader, and checking is reading the files of the few notes being shown (see
// harness/notes.check).
const shownNote = (note: harness.notes.Note, drift?: harness.notes.Checked): WorkspaceNote => ({
  subject: note.subject,
  content: note.content,
  writtenAt: note.writtenAt,
  thread: note.thread,
  files: note.files.map(({ path }) => path),
  ...(drift && drift.changed.length + drift.gone.length > 0
    ? { drift: { changed: drift.changed, gone: drift.gone } }
    : {}),
});

// What a file in a workspace is, read by the relative name a reply gave it. A
// reference in a reply (see renderer/file-ref.ts) points the user at a part of
// the code by name, and the window shows what it pointed at when the user opens
// it. It is the user's own workspace, read at the user's own click, so nothing
// is asked about it; a path that would reach outside the workspace is refused
// (see sandbox.readFileInWorkspace).
ipcMain.handle('workspace:file', (_event, workspace: string, relPath: string, from?: number, to?: number) =>
  sandbox.readFileInWorkspace(workspace, relPath, from, to)
);

// What is known about a workspace, for the user to read: the note on its
// project and the detailed notes behind it, which are otherwise only ever
// shown to the models working in it
ipcMain.handle('workspace:details', (_event, workspace: string) => {
  const kept = harness.notes.all(workspace);
  return {
    note: harness.project.get(workspace),
    writtenAt: harness.project.writtenAt(workspace),
    surveying: harness.project.surveying(workspace),
    notes: kept.slice(0, SHOWN_NOTES).map((note) => shownNote(note, harness.notes.check(workspace, note))),
    moreNotes: Math.max(kept.length - SHOWN_NOTES, 0),
  };
});

// ...and searching them by meaning, the same way a model searches them, so
// that what the user reads is what a thread asking this would be given. The
// hits already say which have drifted (see harness/notes.search).
ipcMain.handle('workspace:search-notes', async (_event, workspace: string, query: string) => {
  const { hits } = await harness.notes.search(workspace, query, AbortSignal.timeout(SEARCH_MS));
  return hits.map((hit) => shownNote(hit, hit.drift));
});

// Throwing one of those notes away, which only the user ever does: the models
// correct a note by writing its subject again, and a note that should never
// have been written is nobody else's to be rid of (see harness/notes.remove).
// Resolves with whether there was one to throw — a note the window is showing
// may already be gone, having been promoted or pruned since it was drawn.
ipcMain.handle('workspace:forget-note', (_event, workspace: string, subject: string, threadId?: string) =>
  harness.notes.remove(workspace, subject, threadId)
);

// The user has asked for the workspace to be looked at again: its note goes
// and an explorer writes a new one. Resolves once the look is over, and the
// note reaches every thread by the same push as the first one did.
ipcMain.handle('workspace:relook', (_event, workspace: string, threadId?: string) =>
  harness.project.relook(workspace, threadId)
);

// ...and what one thread keeps: the note it writes for itself in its
// container, and what it has made of the workspace's note
ipcMain.handle('thread:details', async (_event, threadId: string, workspace?: string) => ({
  context: await sandbox.readContext(threadId),
  note: workspace ? harness.project.get(workspace, threadId) : '',
  shared: workspace ? harness.project.get(workspace) : '',
}));

// What a thread has changed in its copy of its workspace, and writing that back
// to the workspace: only ever at the user's own request
ipcMain.handle('thread:changes', (_event, threadId: string) => sandbox.changes.list(threadId));
ipcMain.handle('thread:apply-changes', async (_event, threadId: string, workspace: string) => {
  const applied = await sandbox.changes.apply(threadId, workspace);
  // What the thread learned about the project goes back with its files: the
  // note is as much a part of the work as the code is
  if (applied.applied.length > 0) {
    harness.project.promote(workspace, threadId);
    // ...and so are the particular things it wrote down along the way
    harness.notes.promote(workspace, threadId);
  }
  return applied;
});

// Throwing away what the thread has changed in its copy since it was last written back (or made): the files go
// back to how they were then, and the workspace is never touched. The "Revert changes" button in the Changes dialog.
ipcMain.handle('thread:discard-changes', (_event, threadId: string) => sandbox.changes.revert(threadId, null));

// The thread as it was before the attempt named by `request`, for an attempt
// the user has thrown away, so that asking again starts from the project
// rather than from what that attempt left (see the retry in
// ../renderer/message-menu.ts). Only the latest attempt on the thread can be
// undone, and only once — anything else and what is held here is not from the
// message in hand.
//
// The context note always goes back: it is where a reply writes down what it
// found and what it did, and an attempt nobody kept has no standing to tell
// the next one either. The files go back only when asked, a reply that failed
// partway having left its tools' writes behind where one that ran to the end
// left work the user may have looked over already. Resolves with whether the
// files were in fact put back, which is what the thread is told about.
ipcMain.handle('thread:revert', async (_event, threadId: string, request: string, options?: { files?: boolean }) => {
  const held = beforeRequest.get(threadId);
  if (!held || held.request !== request) return false;
  beforeRequest.delete(threadId);
  const back = options?.files === false ? false : await sandbox.changes.revert(threadId, held.tree);
  // After the files, which carry a note of their own in the tree they are
  // put back from (see isAgentsOwn in sandbox/changes.ts): this is the last
  // word on what the note says either way.
  await sandbox.restoreContext(threadId, held.context);
  return back;
});

// A deleted thread takes its container and files with it, and its search
// server unless another thread uses the same workspace
ipcMain.on('thread:delete', (_event, threadId: string) => {
  sandbox.remove(threadId);
  beforeRequest.delete(threadId);
  // Anything it handed out and never waited for is nobody's to collect now
  harness.subagents.forgetThread(threadId);
  // Its copy of the code index, and what was said in it, both go
  search.forget(threadId);
  harness.project.forgetThread(threadId);
  // Its own notes go with it; the workspace's are left for the threads that
  // share them
  harness.notes.forgetThread(threadId);
});

// Searching the threads by what was said in them (see search/threads.ts). The
// window cuts the threads into pieces, because it is the window that knows
// what a message is; embedding them and finding them happens here.
ipcMain.handle('threads:index', async (_event, pieces: ThreadPiece[]) => {
  try {
    await search.threads.index(pieces, AbortSignal.timeout(INDEX_MS));
  } catch (err) {
    // No Ollama to embed with is the ordinary case for someone who has not set
    // one up: the search says so when it is used, and nothing else needs to
    log.warn('threads.index', { ok: false, error: (err as Error).message });
  }
});

ipcMain.handle('threads:search', (_event, query: string) =>
  search.threads.search(query, AbortSignal.timeout(SEARCH_MS))
);

// The window keeps the threads; they are saved to disk here (see store.ts).
// Both answer at once, so the window can wait for them when it has to.
ipcMain.on('threads:load', (event) => {
  event.returnValue = store.load();
});

ipcMain.on('threads:save', (event, state: string) => {
  store.save(state);
  event.returnValue = true;
});

// The screenshots and clips a reply took, kept in a sidecar beside the threads
// so the JSON stays small (see store.saveMedia). Written as the JSON is, and
// read back when the JSON is, so the two always say the same thing.
// The window waits for the answer (see preload.ts), and one never given leaves
// it frozen until the event happens to be garbage collected here.
ipcMain.on('threads:save-media', (event, items: { id: string; mediaType: string; data: string }[]) => {
  store.saveMedia(items);
  event.returnValue = true;
});

ipcMain.on('threads:load-media', (event) => {
  event.returnValue = store.loadMedia();
});

ipcMain.handle('ollama:status', () => ollama.status(settings.get().local));

// Model name -> AbortController for every download in progress
const downloads = new Map<string, AbortController>();

ipcMain.on('ollama:pull', async (event, name: string) => {
  if (downloads.has(name)) return;
  const controller = new AbortController();
  downloads.set(name, controller);
  const report = (progress: Omit<PullProgress, 'name'>) => {
    if (!event.sender.isDestroyed()) event.sender.send('ollama:progress', { name, ...progress });
  };
  try {
    await ollama.pull(settings.get().local, name, report, controller.signal);
    report({ done: true });
    // The first model downloaded is what Offline Mode was waiting for
    void refreshAvailable();
  } catch (err) {
    if (!controller.signal.aborted) log.warn('ollama.pull', { ok: false, model: name, error: (err as Error).message });
    report({
      done: true,
      error: controller.signal.aborted ? 'Download cancelled.' : (err as Error).message,
    });
  } finally {
    downloads.delete(name);
  }
});

ipcMain.on('ollama:cancel', (_event, name: string) => {
  downloads.get(name)?.abort();
});

// Getting the app ready to use (see setup/checks.ts). Asked afresh every
// time: the flow polls this while it waits for an install to land.
ipcMain.handle('setup:status', async () => {
  const status = await setup.status();
  available = { local: status.local.models > 0, hosted: status.keys.anthropic || status.keys.openai };
  showMenu();
  return status;
});

ipcMain.on('setup:install-docker', (event) => {
  setup.installDocker((progress: SetupProgress) => {
    if (!event.sender.isDestroyed()) event.sender.send('setup:progress', progress);
  });
});

ipcMain.on('setup:cancel', () => setup.cancel());

ipcMain.on('setup:download', (_event, what: Installable) => setup.download(what));

ipcMain.handle('settings:get', () => settings.publicView());

ipcMain.handle('settings:save', (_event, patch: SettingsPatch) => {
  const updated = settings.update(patch);
  llm.configure(updated);
  search.configure(updated.local);
  sandbox.configure(updated.sandbox.image);
  // In case the save was of the switch itself
  showMenu();
  // A key saved or taken away, or the local server pointed somewhere else,
  // changes what the switches have to work with
  void refreshAvailable();
  return settings.publicView();
});

app.whenReady().then(() => {
  // First, so that everything after it can be logged
  const file = log.init(app.getPath('logs'));
  log.watchProcess();
  log.info('app.start', { name: app.getName(), version: app.getVersion(), platform: process.platform, log: file });
  // The dock is where the mark shows on macOS, a window's icon being ignored
  // there. There is a dock to set only on macOS, which is the whole of the
  // test: Electron leaves app.dock undefined elsewhere. Never fatal — an app
  // that cannot set its icon still runs, and the user would rather have it
  // running under Electron's mark than not at all.
  if (app.dock) {
    try {
      app.dock.setIcon(ICON);
    } catch (err) {
      log.warn('app.icon', { ok: false, icon: ICON, error: (err as Error).message });
    }
  }
  harness.project.init(app.getPath('userData'));
  // The detail behind that note, kept beside it (see harness/notes.ts)
  harness.notes.init(app.getPath('userData'));
  // How each workspace's app is run, kept beside them (see sandbox/recipes.ts)
  sandbox.recipes.init(app.getPath('userData'));
  // Where a removal that could not be made is written down (see sandbox/docker.ts)
  sandbox.init(app.getPath('userData'));
  // What the user has allowed the model to read on their computer is kept in the settings
  harness.access.configure({ readable: settings.readable, allow: settings.allowRead });
  search.init(app.getPath('userData'));
  const loaded = settings.load();
  llm.configure(loaded);
  search.configure(loaded.local);
  sandbox.configure(loaded.sandbox.image);
  // Where the branches a subagent makes keep their worktrees (see tools/branches.ts)
  tools.branches.init(app.getPath('userData'));
  tools.registerAll(harness.tools);
  // Before the window, so the menu is never the default one, even briefly.
  // With the switches greyed out until the first check comes back, which is
  // the safe way round: a switch that becomes usable is better than one that
  // was offered and did nothing.
  showMenu();
  void refreshAvailable();
  createWindow();
  // What earlier sessions left behind: a container whose thread was deleted
  // while Docker was down, a container a session that was killed left running,
  // and the caches and images nothing uses any more (see sweep in
  // sandbox/docker.ts). After the window, since nothing waits on it, and with
  // the threads as the store has them — which is how a container with no
  // thread is told from one whose thread simply has not been opened yet. Null
  // from the store is "cannot tell", and then nothing is removed for being
  // unknown.
  void sandbox.sweep(store.threadIds() ?? undefined);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // How each tool did this session: calls, failures and latency
  log.info('app.quit', { tools: harness.tools.stats() });
  sandbox.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
