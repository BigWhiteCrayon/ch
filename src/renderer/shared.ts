import type { Message, ModelInfo, PendingRequest, ProviderStatus, Thread } from './types.js';

export const STORAGE_KEY = 'chat-state';
export const MAX_RECENT_WORKSPACES = 8;
// How many times a subagent the app closed on is started again before it is
// failed instead (see resumeSubagents)
export const MAX_RESTARTS = 1;
// What the app calls itself in the window title, which the project is added to
export const APP_NAME = 'ch';

export const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const threadList = element<HTMLUListElement>('thread-list');
export const threadTitle = element('thread-title');
export const threadWorkspace = element('thread-workspace');
export const threadChanges = element<HTMLButtonElement>('thread-changes');
export const threadUsage = element<HTMLDetailsElement>('thread-usage');
export const threadUsageSummary = element('thread-usage-summary');
export const threadUsageModels = element('thread-usage-models');
export const modelSelect = element<HTMLSelectElement>('model');
export const messagesEl = element('messages');
// The tabs above a thread: the thread itself, and one per subagent opened from
// it. A subagent's work reads as its own conversation (see agentMessages), so
// it gets a pane of its own rather than being folded into the thread.
export const tabsEl = element('tabs');
export const agentView = element('agent-view');
// Following the end of the thread: the window keeps it in view as a reply is
// written. True while the user is reading the end, false from the moment they
// scroll up to read something earlier — a reply arrives a few characters at a
// time and every one of them redraws the thread, so without this the reader
// was dragged back to the bottom several times a second and could not read
// anything but the last line. It is why three places here save the scroll
// position and put it back around a render; they no longer have to.
//
// How near the end counts as the end. A thread sitting a line or two short of
// the bottom — a reply that has just grown, a list that reflowed — is one the
// user is still reading the end of.
export const FOLLOWING = 48;
export const atEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOWING;
// A thread the user has just opened, or just written to, is shown at its end
// whatever they had scrolled to before: both are them asking for the end.
export let drawnThread: string | null = null;
export function setDrawnThread(value: string | null): void {
  drawnThread = value;
}
export let toTheEnd = false;
export function setToTheEnd(value: boolean): void {
  toTheEnd = value;
}

// Keeping to this computer, in the bar the window draws for itself. The same
// setting is in the app's menu, with a key to it (see ../menu.ts); whichever
// is used, the other follows (see onChanged).
export const offlineSwitch = element<HTMLLabelElement>('offline');
export const offlineToggle = element<HTMLInputElement>('offline-toggle');

// Preferring hosted models for their speed, beside it. The same setting is in
// the app's menu too (see drawFast).
export const fastSwitch = element<HTMLLabelElement>('fast');
export const fastToggle = element<HTMLInputElement>('fast-toggle');

// What the last 30 days have cost, at the left of the title bar (see drawMonthCost)
export const monthCost = element('cost-30d');

// Searching the threads by what was said in them (see searchThreads)
export const searchBox = element('search');
export const searchInput = element<HTMLInputElement>('search-input');
export const searchResults = element<HTMLUListElement>('search-results');

export const composer = element<HTMLFormElement>('composer');
export const input = element<HTMLTextAreaElement>('input');
export const sendButton = element<HTMLButtonElement>('send');
// What was typed in the box and not yet sent, by thread, so it stays with the thread it was written in
export const drafts = new Map<string, string>();

// models: the ones on offer; allModels also includes those switched off in Settings
export let models: ModelInfo[] = [];
export function setModels(value: ModelInfo[]): void {
  models = value;
}
export let allModels: ModelInfo[] = [];
export function setAllModels(value: ModelInfo[]): void {
  allModels = value;
}
export let providers: ProviderStatus[] = [];
export function setProviders(value: ProviderStatus[]): void {
  providers = value;
}
// Replies being generated: threadId -> requestId, requestId -> its details
export const inflight = new Map<string, string>();
export const requests = new Map<string, PendingRequest>();
// Threads whose changes are being checked by a model right now (see verifyReply)
export const reviewing = new Set<string>();
// When each subagent began its work, for the clock on its tab. Not on the
// Message, which is saved: it means nothing once the window has gone.
export const startedAgents = new WeakMap<Message, number>();
// The timer that keeps the clocks on screen running (see clock)
export let ticker: ReturnType<typeof setInterval> | undefined;
export function setTicker(value: ReturnType<typeof setInterval> | undefined): void {
  ticker = value;
}
// Tool calls and notes whose details are expanded. Rendering rebuilds the
// messages, so this is what keeps a dropdown open while a reply streams.
export const expanded = new Set<string>();
// The work the app does on a workspace of its own accord — reading it to write
// the note every thread there is shown (see harness/project.ts) — is a thread
// like any other, started by the app rather than by the user. It is kept out
// of the way until it is asked for (see automaticRows), because it is nobody's
// conversation; it is a thread rather than a line in the sidebar because what
// it did is worth reading the way any other work is read.
// Workspace -> the thread the look going on in it is writing into. Only while
// it runs: what it wrote stays in the thread, which outlives it.
export const automatic = new Map<string, string>();
// The subagents opened as tabs, by the thread they belong to, and which of them
// each thread is showing. A tab is the window's own business: it is not saved
// with the thread, and closing the window closes them. Declared here with the
// rest of the module's state, because the first render reads it.
export const tabs = new Map<string, string[]>();
export const onTab = new Map<string, string>();
export const tabsOf = (thread: Thread) => tabs.get(thread.id) ?? [];
// How each tool is spoken of in the thread: "Reading src/main.ts…" while it
// is at work and "Read src/main.ts" once it is done. `input` names the part
// of what the tool was given that says what it is working on; `thing` stands
// in when that isn't known. A tool that isn't listed goes by its own name.
export const TOOL_LABELS: Record<
  string,
  { doing: string; done: string; thing: string; input?: string | string[]; quoted?: boolean }
> = {
  run_command: { doing: 'Running', done: 'Ran', thing: 'a command', input: 'command' },
  read_file: { doing: 'Reading', done: 'Read', thing: 'a file', input: 'path' },
  screenshot: {
    doing: 'Taking a screenshot of',
    done: 'Took a screenshot of',
    thing: 'a page',
    input: ['url', 'command'],
  },
  record: { doing: 'Recording', done: 'Recorded', thing: 'a page', input: ['url', 'command'] },
  write_file: { doing: 'Writing', done: 'Wrote', thing: 'a file', input: 'path' },
  edit_file: { doing: 'Editing', done: 'Edited', thing: 'a file', input: 'path' },
  list_files: { doing: 'Listing', done: 'Listed', thing: 'files', input: 'path' },
  search_workspace: { doing: 'Searching', done: 'Searched', thing: 'workspace', input: 'query', quoted: true },
  save_context: { doing: 'Saving', done: 'Saved', thing: 'its notes' },
  update_workspace_context: { doing: 'Updating', done: 'Updated', thing: 'workspace context' },
  add_to_workspace_context: { doing: 'Adding to', done: 'Added to', thing: 'workspace context' },
  // Run on the thread's behalf when a reply that changed files ends, as well
  // as whenever the model asks for it (see ../tools/sync.ts)
  sync_workspace: { doing: 'Checking', done: 'Checked', thing: 'against the workspace' },
  hand_to_subagent: { doing: 'Handing out', done: 'Handed out', thing: 'work to subagents' },
};
// Characters of a tool's input shown in its label
export const LABEL_INPUT = 60;
// What each model's part in a reply is called in the token note. Up here
// because the first render, below, already needs it.
export const PURPOSES = {
  classification: 'Classification',
  planning: 'Planning',
  reply: 'Reply',
  summary: 'Summary',
  description: 'Description',
  compaction: 'Condensing',
  subagent: 'Subagent',
  verification: 'Review',
};
// How often a reply that is still being written is saved
export const SAVE_INTERVAL_MS = 1000;
export let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function setSaveTimer(value: ReturnType<typeof setTimeout> | undefined): void {
  saveTimer = value;
}
// How long after the last change the threads are indexed for searching. Longer
// than the save, since nothing is waiting for it and a reply being written
// changes the thread every few seconds (see indexSoon).
export const INDEX_INTERVAL_MS = 4000;
export let indexTimer: ReturnType<typeof setTimeout> | undefined;
export function setIndexTimer(value: ReturnType<typeof setTimeout> | undefined): void {
  indexTimer = value;
}
// The pieces last sent to be indexed, so that a change which left the
// conversation alone — a tool note, a thought, an opened dropdown — is not sent
export let indexed = '';
export function setIndexed(value: string): void {
  indexed = value;
}
// Tool calls still waiting for their result: callId -> the tool's name
export const runningCalls = new Map<string, string>();
// A thread left alone this long is summarized, and the summary is then sent
// to the model in place of the messages it covers
export const SUMMARY_IDLE_MS = 10 * 60 * 1000;
// Fewer new messages than this aren't worth a summary
export const SUMMARY_MIN_MESSAGES = 4;
// threadId -> the timer that summarizes it once it has been idle long enough
export const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
// A sidebar group holding more threads than this has the ones opened longest ago
// archived (see archiveStale): out of the sidebar, but still searched
export const MAX_OPEN_THREADS = 10;
