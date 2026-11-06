// @vitest-environment jsdom
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  HarnessEvent,
  HarnessRequest,
  ModelList,
  OllamaStatus,
  PublicSettings,
  PullProgress,
  SetupProgress,
  SetupStatus,
} from '../src/types';
import { model } from './helpers';

// The page markup, without the script tag (the renderer is imported instead)
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<script/.exec(html)![1];

const opus = model({
  id: 'opus',
  name: 'Opus',
  provider: 'anthropic',
  providerName: 'Anthropic',
  local: false,
  sophistication: 4,
});
const haiku = model({
  id: 'haiku',
  name: 'Haiku',
  provider: 'anthropic',
  providerName: 'Anthropic',
  local: false,
  sophistication: 2,
});
const llama = model({ id: 'llama3.2:3b', sophistication: 1 });

// Stand-ins for the main process, reachable through the preload bridges
let modelList: ModelList;
let settings: PublicSettings;
let ollama: OllamaStatus;
let emit: (requestId: string, event: HarnessEvent) => void;
// The main process reporting a subagent that is being run again on its own
let agentEvent: (threadId: string, name: string, event: AgentEvent) => void;
// The main process saying a setting was changed from the app's menu
let settingsChanged: (updated: PublicSettings) => void;
// What the app needs installed, and the installer saying how it is going
let setupState: SetupStatus;
let setupProgress: (update: SetupProgress) => void;
const llm = {
  listModels: vi.fn(),
  send: vi.fn(),
  summarize: vi.fn(),
  describe: vi.fn(),
  suggest: vi.fn(),
  verify: vi.fn(),
  feedback: vi.fn(),
  cancel: vi.fn(),
  allowFileAccess: vi.fn(),
  allowCommand: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  onEvent: vi.fn(),
  retrySubagent: vi.fn(),
  onSubagentEvent: vi.fn(),
};
const threads = {
  chooseWorkspace: vi.fn(),
  branches: vi.fn(),
  prepareBranch: vi.fn(),
  branchStatus: vi.fn(),
  commitBranch: vi.fn(),
  pushBranch: vi.fn(),
  pullBranch: vi.fn(),
  removeWorktree: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  changes: vi.fn(),
  applyChanges: vi.fn(),
  revert: vi.fn(),
  discardChanges: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  saveNow: vi.fn(),
  saveMedia: vi.fn(),
  loadMedia: vi.fn(),
  workspace: vi.fn(),
  workspaceFile: vi.fn(),
  searchNotes: vi.fn(),
  forgetNote: vi.fn(),
  details: vi.fn(),
  relook: vi.fn(),
  looking: vi.fn(),
  onLooking: vi.fn(),
  onLookEvent: vi.fn(),
  // Kept so the push can be fired at the renderer in tests
  onSurveyed: vi.fn(),
  index: vi.fn(),
  search: vi.fn(),
};
// What the main process has on disk for the threads: the last state saved
let onDisk: string | null = null;
// ...and the media sidecar, the screenshots and clips a reply took, keyed by
// id (see save in renderer/threads.ts)
let onMedia: Record<string, { mediaType: string; data: string }> = {};
// Where the page is drawn, and the one thing it asks of its window: to come
// forward for a notification the user clicked
const host = { platform: process.platform, show: vi.fn(), badge: vi.fn() };
const ollamaApi = { status: vi.fn(), pull: vi.fn(), cancel: vi.fn(), onProgress: vi.fn() };
const settingsApi = { get: vi.fn(), save: vi.fn(), onChanged: vi.fn() };
const setupApi = {
  status: vi.fn(),
  installDocker: vi.fn(),
  cancel: vi.fn(),
  download: vi.fn(),
  onProgress: vi.fn(),
};

// Ollama saying how a download is going, which reaches everything that
// listens: the list in Settings and the setup flow both show the same
// download, and the main process sends to the window rather than to one of
// them (see preload.ts).
async function progress(update: PullProgress): Promise<void> {
  for (const [listener] of ollamaApi.onProgress.mock.calls) await listener(update);
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Each message as "role: text". A note with a dropdown shows as the
// dropdown's summary, and a thought as the text inside its dropdown. The
// classification rating on a note's summary line is left out.
const messages = () =>
  $$('#messages .message').map((m) => {
    const shown = m.classList.contains('thought') ? m.querySelector('pre') : m.querySelector('summary');
    const copy = (shown ?? m).cloneNode(true) as HTMLElement;
    copy.querySelector('.feedback')?.remove();
    return `${m.classList[1]}: ${copy.textContent}`;
  });
const threadTitles = () => $$('#thread-list .name').map((t) => t.textContent);
const pickerOptions = () => $$('#model option').map((o) => o.textContent);
const saved = () => JSON.parse(onDisk as string);

async function type(text: string) {
  $<HTMLTextAreaElement>('#input').value = text;
  $<HTMLFormElement>('#composer').requestSubmit();
  await flush();
}
const recentWorkspaces = () => $$('#recent-workspaces option').map((o) => o.textContent);
// The main process saying a workspace's note has been written (see
// harness/project.ts). It is pushed to every thread in that workspace, so it
// arrives apart from any one reply's events.
const surveyed = (workspace: string, note: string) => {
  for (const [listener] of threads.onSurveyed.mock.calls) listener(workspace, note);
};
// Picks a workspace in the system's workspace dialog (null backs out of it)
async function browse(workspace: string | null) {
  threads.chooseWorkspace.mockResolvedValue(workspace);
  $('#browse-workspace').click();
  await flush();
}
// Starts a thread from the new-thread pop-up: in a workspace, taken from the
// dropdown if it is there and browsed for if not, or as a general chat (null)
async function newThread(workspace: string | null = '/projects/demo') {
  $('#new-thread').click();
  if (workspace === null) {
    $('#general-chat').click();
    return;
  }
  if (recentWorkspaces().includes(workspace)) $<HTMLSelectElement>('#recent-workspaces').value = workspace;
  else await browse(workspace);
  $('#start-in-workspace').click();
}
// The request most recently sent to the harness, and its id
const sentId = () => llm.send.mock.calls.at(-1)![0] as string;
const sent = () => llm.send.mock.calls.at(-1)![1] as HarnessRequest;

// What each copy of the renderer listens for on the window and the document. The
// jsdom window outlives every test, so a listener left behind keeps its whole
// copy of the renderer in memory, and it would hear every later beforeunload too.
type Listening = [EventTarget, Parameters<EventTarget['addEventListener']>];
const listening: Listening[] = [];
for (const target of [window, document]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
    listening.push([target, args]);
    add(...args);
  };
}

// The same goes for its timers: the one that waits ten minutes to summarize an idle
// thread would hold its copy of the renderer until long after the run is over. Only
// the real ones, which are the ones set before a test turns on fake timers.
const timers: Array<ReturnType<typeof setTimeout>> = [];
const realClearTimeout = globalThis.clearTimeout;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  const timer = realSetTimeout(...args);
  timers.push(timer);
  return timer;
}) as typeof setTimeout;

async function start() {
  // The window before this one closes, which also ends any save it had
  // pending; what is on disk stays as the test left it
  const kept = onDisk;
  const keptMedia = onMedia;
  window.dispatchEvent(new Event('beforeunload'));
  onDisk = kept;
  onMedia = keptMedia;
  for (const [target, [type, listener, options]] of listening.splice(0)) {
    target.removeEventListener(type, listener, options);
  }
  for (const timer of timers.splice(0)) realClearTimeout(timer);
  vi.resetModules();
  document.body.innerHTML = body;
  await import('../src/renderer');
  await flush();
}

beforeEach(async () => {
  localStorage.clear();
  for (const api of [llm, threads, ollamaApi, settingsApi, setupApi]) {
    Object.values(api).forEach((mock) => mock.mockReset());
  }
  // Not in the loop above: the host bridge carries a platform as well as a call
  host.show.mockReset();
  host.badge.mockReset();
  modelList = { models: [opus, haiku, llama], providers: [] };
  settings = {
    anthropic: { hasKey: true, disabledModels: [] },
    openai: { hasKey: false, disabledModels: [] },
    local: { baseURL: 'http://localhost:11434/v1', hasKey: false },
    sophistication: {},
    sandbox: { image: '' },
    offline: false,
    fast: false,
    approvalCeiling: 5,
    autoReview: false,
    theme: {},
    setup: { completed: true, version: 1, skipped: [] },
  };
  ollama = { reachable: false, url: 'http://localhost:11434', installed: [], suggested: [] };
  // Everything in place and nothing to ask about, so the flow on the way in
  // stays shut unless a test says otherwise (see wanted in setup/checks.ts)
  setupState = {
    local: {
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'qwen2.5:7b', size: 4.7e9 }],
      recommended: [],
      memoryGB: 16,
      models: 1,
      routable: true,
      embedding: true,
      embeddingModel: 'nomic-embed-text',
    },
    docker: { installed: true, running: true, automatic: true },
    keys: { anthropic: true, openai: false },
    canAnswer: true,
    ready: true,
    canRunCode: true,
    canSearch: true,
    setup: { completed: true, version: 1, skipped: [] },
    version: 1,
    wanted: false,
    platform: process.platform,
  };
  onDisk = null;
  onMedia = {};
  threads.load.mockImplementation(() => onDisk);
  threads.loadMedia.mockImplementation(() => (Object.keys(onMedia).length ? JSON.stringify(onMedia) : null));
  threads.saveMedia.mockImplementation((items: { id: string; mediaType: string; data: string }[]) => {
    for (const item of items) onMedia[item.id] = { mediaType: item.mediaType, data: item.data };
  });
  threads.branches.mockResolvedValue({ current: null, names: [] });
  threads.branchStatus.mockResolvedValue({ upstream: null, ahead: 0, behind: 0, dirty: false });
  threads.removeWorktree.mockResolvedValue(undefined);
  threads.changes.mockResolvedValue({ files: [] });
  threads.applyChanges.mockResolvedValue({ applied: [], conflicts: [], skipped: [] });
  threads.revert.mockResolvedValue(false);
  threads.discardChanges.mockResolvedValue(false);
  threads.save.mockImplementation((state: string) => (onDisk = state));
  threads.saveNow.mockImplementation((state: string) => (onDisk = state));
  threads.workspace.mockResolvedValue({ note: '', writtenAt: null, surveying: false, notes: [], moreNotes: 0 });
  threads.workspaceFile.mockResolvedValue({ path: '', lines: [], from: 1, total: 0 });
  threads.relook.mockResolvedValue('');
  threads.looking.mockResolvedValue([]);
  threads.details.mockResolvedValue({ context: '', note: '', shared: '' });
  threads.index.mockResolvedValue(undefined);
  threads.search.mockResolvedValue([]);
  llm.listModels.mockImplementation(async () => modelList);
  llm.summarize.mockResolvedValue(null);
  llm.describe.mockResolvedValue(null);
  llm.suggest.mockResolvedValue(null);
  llm.onEvent.mockImplementation((callback) => (emit = callback));
  // A subagent the app closed on is started again when it opens (see resumeSubagents)
  llm.retrySubagent.mockImplementation(() => new Promise(() => {}));
  llm.onSubagentEvent.mockImplementation((callback) => (agentEvent = callback));
  ollamaApi.status.mockImplementation(async () => ollama);
  settingsApi.get.mockImplementation(async () => settings);
  settingsApi.onChanged.mockImplementation((callback) => (settingsChanged = callback));
  settingsApi.save.mockImplementation(async () => settings);
  setupApi.status.mockImplementation(async () => setupState);
  setupApi.onProgress.mockImplementation((callback) => (setupProgress = callback));
  Object.assign(window, { host, llm, threads, ollamaApi, settingsApi, setupApi });
  // jsdom has no layout or modal dialogs
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    if (this.open) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    }
  };
  await start();
});

describe('startup', () => {
  it('opens with one empty thread', () => {
    expect(threadTitles()).toEqual(['New thread']);
    expect($('#thread-title').textContent).toBe('New thread');
    expect($('#messages .empty').textContent).toContain('Send a message');
    expect($('#send').textContent).toBe('Send');
  });

  it('offers Auto first, then the models with their provider and level', () => {
    expect(llm.listModels).toHaveBeenCalledWith({ includeDisabled: true });
    expect(pickerOptions()).toEqual([
      'Auto · chosen per message',
      'Opus · Anthropic · 4/5',
      'Haiku · Anthropic · 2/5',
      'llama3.2:3b · Local · 1/5',
    ]);
    expect($<HTMLSelectElement>('#model').value).toBe('auto');
  });

  it('leaves switched-off models out of the picker', async () => {
    modelList = { models: [opus, { ...haiku, disabled: true }], providers: [] };
    await start();
    expect(pickerOptions()).toEqual(['Auto · chosen per message', 'Opus · Anthropic · 4/5']);
  });

  it('disables the picker when there are no models', async () => {
    modelList = { models: [], providers: [] };
    await start();
    expect(pickerOptions()).toEqual(['No models available']);
    expect($<HTMLSelectElement>('#model').disabled).toBe(true);
  });
});

describe('the offline switch', () => {
  const toggle = () => $<HTMLInputElement>('#offline-toggle');
  const label = () => $<HTMLElement>('#offline');
  // The main process: it saves the setting, and what is on offer follows from
  // it. Braced, and so returning nothing: a beforeEach that returns a function
  // has handed vitest a teardown hook, and mockImplementation returns the mock.
  beforeEach(() => {
    settingsApi.save.mockImplementation(async (patch: { offline?: boolean }) => {
      settings = { ...settings, ...patch };
      modelList = settings.offline
        ? { models: [llama], providers: [{ id: 'anthropic', name: 'Anthropic', ok: false, error: 'Offline.' }] }
        : { models: [opus, haiku, llama], providers: [] };
      return settings;
    });
  });

  it('is in the bar the window draws for itself, off, when nothing has been switched', () => {
    expect($('#titlebar #offline')).not.toBeNull();
    expect(toggle().checked).toBe(false);
    expect(label().className).not.toContain('on');
    expect(label().textContent?.trim()).toBe('Offline Mode');
    expect(label().title).toContain('Offline Mode disables non-local');
    expect(label().title).toContain('Click to go offline');
  });

  it('saves the switch and leaves only this computer’s models on offer', async () => {
    toggle().click();
    await flush();

    expect(settingsApi.save).toHaveBeenCalledWith({ offline: true });
    expect(label().className).toContain('on');
    expect(label().title).toContain('only models on this computer are used');
    expect(pickerOptions()).toEqual(['Auto · chosen per message', 'llama3.2:3b · Local · 1/5']);
  });

  it('drops a hosted model the user had picked, rather than sending to it anyway', async () => {
    $<HTMLSelectElement>('#model').value = 'anthropic/opus';
    $<HTMLSelectElement>('#model').dispatchEvent(new Event('change'));
    expect(saved().modelChoice).toBe('anthropic/opus');

    toggle().click();
    await flush();
    expect(saved().modelChoice).toBe('auto');
    await type('hello');
    expect(sent().provider).toBeUndefined();
    expect(sent().model).toBeUndefined();
  });

  it('follows the same switch thrown from the app’s menu, which is the other way to it', async () => {
    settings = { ...settings, offline: true };
    modelList = { models: [llama], providers: [] };
    settingsChanged(settings);
    await flush();
    expect(toggle().checked).toBe(true);
    expect(label().className).toContain('on');
    expect(pickerOptions()).not.toContain('Opus · Anthropic · 4/5');
  });

  it('opens with the switch on when that is how it was left', async () => {
    settings = { ...settings, offline: true };
    modelList = { models: [llama], providers: [] };
    await start();
    await flush();
    expect(toggle().checked).toBe(true);
    expect(label().className).toContain('on');
  });

  it('shows what is, not what was asked for, when the setting could not be saved', async () => {
    settingsApi.save.mockImplementation(() => {
      throw new Error('Encryption is not available on this system.');
    });
    toggle().click();
    await flush();
    // The click left it ticked; the switch puts it back and says why
    expect(toggle().checked).toBe(false);
    expect(label().className).not.toContain('on');
    expect(label().title).toBe('Encryption is not available on this system.');
    expect(pickerOptions()).toContain('Opus · Anthropic · 4/5');
  });
});

describe('a switch with nothing to switch between', () => {
  const offline = () => $<HTMLInputElement>('#offline-toggle');
  const fast = () => $<HTMLInputElement>('#fast-toggle');
  const notice = () => ({
    open: $<HTMLDialogElement>('#notice-dialog').open,
    title: $('#notice-title').textContent,
    text: $('#notice-text').textContent,
    action: $('#notice-action').textContent,
  });

  it('greys Fast out when there is no hosted model to prefer, and says so when clicked', async () => {
    settings = { ...settings, anthropic: { hasKey: false, disabledModels: [] } };
    await start();
    expect(fast().disabled).toBe(true);
    expect($('#fast').className).toContain('unavailable');
    expect($('#fast').title).toContain('API key');

    $('#fast').click();
    expect(notice()).toMatchObject({ open: true, title: 'Fast Mode needs a hosted model', action: 'Add a key' });
    expect(notice().text).toContain('none to prefer');
  });

  it('greys Offline out when this computer has no model of its own', async () => {
    modelList = { models: [opus, haiku], providers: [] };
    await start();
    expect(offline().disabled).toBe(true);
    expect($('#offline').title).toContain('there are none');

    $('#offline').click();
    expect(notice()).toMatchObject({ open: true, title: 'Offline Mode needs a model on this computer' });
  });

  it('leaves both alone while there is a key and a local model', () => {
    expect(fast().disabled).toBe(false);
    expect(offline().disabled).toBe(false);
    expect($('#offline').className).not.toContain('unavailable');
  });

  // The way out of an Offline Mode whose last local model has gone
  it('leaves a switch that is on usable, however little there is', async () => {
    settings = { ...settings, offline: true, fast: true, anthropic: { hasKey: false, disabledModels: [] } };
    modelList = { models: [], providers: [] };
    await start();
    expect(offline().disabled).toBe(false);
    expect(fast().disabled).toBe(false);
  });

  it('opens the flow from the notice, for whichever switch it was about', async () => {
    settings = { ...settings, anthropic: { hasKey: false, disabledModels: [] } };
    setupState = { ...setupState, keys: { anthropic: false, openai: false } };
    await start();
    $('#fast').click();
    $('#notice-action').click();
    await flush();
    expect($<HTMLDialogElement>('#notice-dialog').open).toBe(false);
    expect($<HTMLDialogElement>('#setup-dialog').open).toBe(true);
    expect($('#setup-title').textContent).toContain('Hosted models'.toLowerCase());
  });
});

describe('the flow on the way in', () => {
  const dialog = () => $<HTMLDialogElement>('#setup-dialog');
  const steps = () =>
    $$('#setup-steps li').map(
      (li) =>
        `${li.textContent}${li.classList.contains('done') ? ' ✓' : ''}${li.getAttribute('aria-current') ? ' ←' : ''}`
    );
  // Each requirement as "<what it is> <how it stands> <what can be done>"
  const rows = () =>
    $$('#setup-body .setup-item').map((item) => {
      const buttons = [...item.querySelectorAll('button')].map((b) => `<${b.textContent}>`);
      return [item.querySelector('.name')?.textContent, item.querySelector('.state')?.textContent, ...buttons]
        .filter(Boolean)
        .join(' ');
    });
  // A button in one requirement's row: several rows offer a "Download"
  const clickIn = (name: string, label: string) => {
    const item = $$('#setup-body .setup-item').find((i) => i.querySelector('.name')?.textContent === name);
    const button = [...(item?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
    if (!button) throw new Error(`No "${label}" in "${name}". There is: ${rows().join(' | ')}`);
    button.click();
  };
  const click = (label: string) => {
    const button = [...$$('#setup-body button'), ...$$('#setup-dialog .actions button')].find(
      (b) => b.textContent === label && !(b as HTMLButtonElement).hidden
    );
    if (!button) throw new Error(`No "${label}" button. There is: ${rows().join(' | ')}`);
    button.click();
  };
  // Nothing set up at all, which is what a new install looks like
  const nothing = {
    local: {
      reachable: false,
      url: 'http://localhost:11434',
      installed: [],
      recommended: [
        { name: 'qwen2.5:14b', sophistication: 1, memoryGB: 16 },
        { name: 'qwen2.5:7b', sophistication: 1, memoryGB: 8 },
      ],
      memoryGB: 16,
      models: 0,
      routable: false,
      embedding: false,
      embeddingModel: 'nomic-embed-text',
    },
    docker: { installed: false, running: false, automatic: true },
    keys: { anthropic: false, openai: false },
    canAnswer: false,
    ready: false,
    canRunCode: false,
    canSearch: false,
    setup: { completed: false, version: 0, skipped: [] },
    version: 1,
    wanted: true,
    platform: 'darwin',
  };
  // Ollama answering with the embedding model and a model to answer with:
  // everything the flow requires, so it can be finished (see blocking)
  const ollamaReady = {
    reachable: true,
    installed: [{ name: 'qwen2.5:14b', size: 9e9 }],
    recommended: [],
    models: 1,
    routable: true,
    embedding: true,
  };

  it('stays shut when there is nothing to ask about', () => {
    expect(dialog().open).toBe(false);
  });

  it('opens at the first step that wants something, with what is already done ticked', async () => {
    setupState = { ...nothing, keys: { anthropic: true, openai: false }, canAnswer: true };
    await start();
    expect(dialog().open).toBe(true);
    expect(steps()).toEqual(['Models on this computer ←', 'Hosted models ✓', 'Containers']);
  });

  it('offers the download when nothing is answering, and nothing else until it does', async () => {
    setupState = nothing;
    await start();
    expect(rows()).toEqual(['Ollama Not found <Download Ollama>']);
    click('Download Ollama');
    expect(setupApi.download).toHaveBeenCalledWith('ollama');
    expect($('#setup-status').textContent).toContain('checks every few seconds');
  });

  it('offers the models this computer can hold once Ollama answers, biggest first', async () => {
    setupState = { ...nothing, local: { ...nothing.local, reachable: true } };
    await start();
    expect(rows()).toEqual([
      'Ollama Running',
      'A model to answer with Missing',
      'nomic-embed-text Missing <Download>',
      'qwen2.5:14b <Download>',
      'qwen2.5:7b <Download>',
    ]);
    expect($$('#setup-body .about').map((a) => a.textContent)).toContain(
      'Level 1/5 · wants 16GB of memory, and this computer has 16GB · the best of these it can hold'
    );
  });

  it('downloads a model, shows how it is going, and asks again when it lands', async () => {
    setupState = { ...nothing, local: { ...nothing.local, reachable: true } };
    await start();
    clickIn('qwen2.5:14b', 'Download');
    expect(ollamaApi.pull).toHaveBeenCalledWith('qwen2.5:14b');

    await progress({ name: 'qwen2.5:14b', status: 'pulling manifest', percent: null });
    expect(rows()).toContain('qwen2.5:14b pulling manifest <Cancel>');
    await progress({ name: 'qwen2.5:14b', percent: 42 });
    expect(rows()).toContain('qwen2.5:14b 42% <Cancel>');

    setupState = {
      ...setupState,
      local: { ...setupState.local, reachable: true, models: 1, routable: true, recommended: [] },
      canAnswer: true,
    };
    await progress({ name: 'qwen2.5:14b', done: true });
    await flush();
    expect(rows()).toContain('A model to answer with Ready');
  });

  it('says when the models there are will not be routed to, rather than calling them enough', async () => {
    setupState = {
      ...nothing,
      local: {
        ...nothing.local,
        reachable: true,
        installed: [{ name: 'llama3.2:3b', size: 2e9 }],
        models: 1,
        routable: false,
        embedding: true,
      },
      canAnswer: true,
    };
    await start();
    // A local model there is opens the flow at the next step that wants
    // something, so this one is reached by going back to it
    click('Back');
    expect(rows()).toContain('A model to answer with Small');
    expect(
      $$('#setup-body .about')
        .map((a) => a.textContent)
        .join(' ')
    ).toContain('5B and up');
  });

  it('saves a key from the flow itself, and asks for everything again afterwards', async () => {
    setupState = { ...nothing, local: { ...nothing.local, reachable: true } };
    await start();
    click('Next');
    expect(steps()).toEqual(['Models on this computer', 'Hosted models ←', 'Containers']);
    expect(rows()).toEqual(['Anthropic Not set <Save>', 'OpenAI Not set <Save>']);

    $<HTMLInputElement>('#setup-body input').value = 'sk-ant-key';
    setupState = { ...setupState, keys: { anthropic: true, openai: false }, canAnswer: true };
    click('Save');
    await flush();
    expect(settingsApi.save).toHaveBeenCalledWith({ anthropic: { apiKey: 'sk-ant-key' } });
    expect(rows()).toEqual(['Anthropic Saved <Remove>', 'OpenAI Not set <Save>']);
  });

  it('saves nothing for an empty box, which is a click on the wrong button', async () => {
    setupState = { ...nothing, local: { ...nothing.local, reachable: true } };
    await start();
    click('Next');
    click('Save');
    await flush();
    expect(settingsApi.save).not.toHaveBeenCalled();
  });

  it('installs Docker, showing the installer’s own output as it arrives', async () => {
    setupState = {
      ...nothing,
      local: { ...nothing.local, ...ollamaReady },
      keys: { anthropic: true, openai: false },
      canAnswer: true,
      ready: true,
    };
    // Everything but Docker in place, so the flow opens on the step for it
    await start();
    expect(rows()).toEqual(['Docker Not found <Install Docker>']);

    click('Install Docker');
    expect(setupApi.installDocker).toHaveBeenCalled();
    expect(rows()).toEqual(['Docker Working… <Stop>']);
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(true);

    setupProgress({ line: '[docker] Docker was not found. Installing it...' });
    expect($('#setup-log').hidden).toBe(false);
    expect($('#setup-log').textContent).toBe('[docker] Docker was not found. Installing it...');

    setupState = { ...setupState, docker: { installed: true, running: true, automatic: true }, canRunCode: true };
    setupProgress({ done: true, ok: true });
    await flush();
    expect(rows()).toEqual(['Docker Running']);
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(false);
  });

  it('sends the user to the download when this computer cannot install Docker itself', async () => {
    setupState = {
      ...nothing,
      keys: { anthropic: true, openai: false },
      canAnswer: true,
      docker: { installed: false, running: false, automatic: false },
    };
    await start();
    click('Next');
    click('Next');
    expect(rows()).toEqual(['Docker Not found <Download Docker Desktop>']);
    click('Download Docker Desktop');
    expect(setupApi.download).toHaveBeenCalledWith('docker');
  });

  it('offers to start a Docker that is installed and down, which is what a reboot leaves', async () => {
    setupState = {
      ...nothing,
      keys: { anthropic: true, openai: false },
      canAnswer: true,
      docker: { installed: true, running: false, automatic: true },
    };
    await start();
    click('Next');
    click('Next');
    expect(rows()).toEqual(['Docker Stopped <Start Docker>']);
  });

  // Ollama is required, and what is missing is said one thing at a time: a
  // user who installs Ollama and then has to guess that a model is wanted too
  // has been told nothing
  it('will not be finished without Ollama, whatever else is in place', async () => {
    setupState = { ...nothing, keys: { anthropic: true, openai: false }, canAnswer: true };
    await start();
    click('Next');
    click('Next');
    expect($('#setup-next').textContent).toBe('Finish');
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(true);
    expect($('#setup-status').textContent).toContain('Ollama has to be running');
  });

  it('will not be finished without the embedding model the search is built on', async () => {
    setupState = {
      ...nothing,
      local: { ...nothing.local, ...ollamaReady, embedding: false },
      canAnswer: true,
    };
    await start();
    click('Next');
    click('Next');
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(true);
    expect($('#setup-status').textContent).toContain('Download nomic-embed-text');
  });

  it('will not be finished with an Ollama that has nothing to answer with', async () => {
    setupState = { ...nothing, local: { ...nothing.local, reachable: true, embedding: true } };
    await start();
    click('Next');
    click('Next');
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(true);
    expect($('#setup-status').textContent).toContain('nothing here to answer a message with');
  });

  // The window says which requirement is missing; the main process settles
  // whether anything is (see blocking). The stricter of the two wins, because
  // a flow that let the user out early would only open itself again.
  it('will not be finished while the main process says something is missing', async () => {
    setupState = { ...nothing, local: { ...nothing.local, ...ollamaReady }, canAnswer: true, ready: false };
    await start();
    click('Next');
    expect($<HTMLButtonElement>('#setup-next').disabled).toBe(true);
    expect($('#setup-status').textContent).toBe('Something the app needs is still missing.');
  });

  it('records what it got through, against the requirements it was asked about', async () => {
    setupState = { ...nothing, local: { ...nothing.local, ...ollamaReady }, canAnswer: true, ready: true };
    // A local model answers, so the keys step is where it opens and the
    // container step is the last of it
    await start();
    click('Next');
    click('Finish');
    await flush();
    expect(settingsApi.save).toHaveBeenCalledWith({ setup: { completed: true, version: 1 } });
    expect(dialog().open).toBe(false);
  });

  it('remembers a step the user would rather go without, so it is not asked again', async () => {
    setupState = { ...nothing, local: { ...nothing.local, ...ollamaReady }, canAnswer: true, ready: true };
    await start();
    click('Skip this step');
    await flush();
    expect(settingsApi.save).toHaveBeenCalledWith({ setup: { skipped: ['keys'] } });
    expect(steps()).toEqual(['Models on this computer ✓', 'Hosted models', 'Containers ←']);
  });

  it('has nothing to skip on a step that is already satisfied', async () => {
    setupState = { ...nothing, keys: { anthropic: true, openai: false }, canAnswer: true };
    await start();
    click('Next');
    expect($<HTMLButtonElement>('#setup-skip').hidden).toBe(true);
  });

  // The one step that is not the user's to decline
  it('never offers to skip the models on this computer', async () => {
    setupState = { ...nothing, keys: { anthropic: true, openai: false }, canAnswer: true };
    await start();
    expect(steps()[0]).toContain('←');
    expect($<HTMLButtonElement>('#setup-skip').hidden).toBe(true);

    setupState = { ...setupState, local: { ...nothing.local, reachable: true } };
    await start();
    expect($<HTMLButtonElement>('#setup-skip').hidden).toBe(true);
  });

  it('can be left for later, and comes back next time', async () => {
    setupState = nothing;
    await start();
    click('Finish later');
    expect(dialog().open).toBe(false);
    expect(settingsApi.save).not.toHaveBeenCalled();
  });

  it('is reopened from Settings, which it closes on the way', async () => {
    $('#open-settings').click();
    await flush();
    $('#open-setup').click();
    await flush();
    expect($<HTMLDialogElement>('#settings').open).toBe(false);
    expect(dialog().open).toBe(true);
    // Everything in place, so it opens at the beginning rather than nowhere
    expect(steps()).toEqual(['Models on this computer ✓ ←', 'Hosted models ✓', 'Containers ✓']);
  });
});

describe('the window’s own title bar', () => {
  it('spans the window, above the threads and the chat', () => {
    const bar = $<HTMLElement>('#titlebar');
    expect(bar.parentElement?.tagName).toBe('BODY');
    expect(bar.nextElementSibling?.id).toBe('shell');
    expect($('#shell #sidebar')).not.toBeNull();
    expect($('#shell main')).not.toBeNull();
  });

  it('holds the switch that is about the whole app, and nothing else', () => {
    expect($('#titlebar #offline')).not.toBeNull();
    expect($('#titlebar #thread-title')).toBeNull();
    expect($('#titlebar #model')).toBeNull();
    expect($('#titlebar #search-input')).toBeNull();
  });

  it('leaves the thread’s own bar what is about the thread', () => {
    for (const id of ['thread-title', 'thread-workspace', 'thread-changes', 'thread-usage', 'model']) {
      expect($(`main > header #${id}`)).not.toBeNull();
    }
  });

  it('has the search over the threads it searches, at the top of the sidebar', () => {
    const search = $<HTMLElement>('#sidebar #search');
    expect(search).not.toBeNull();
    expect(search.previousElementSibling).toBeNull();
    expect(search.nextElementSibling?.id).toBe('thread-list');
  });

  it('says which computer it is on, which is what the bar is laid out around', () => {
    expect(document.body.dataset.platform).toBe(process.platform);
  });
});

describe('sending a message', () => {
  it('shows the message, names the thread after it, and sends it for routing on Auto', async () => {
    await type('  How do I parse JSON in Rust, including nested structures?  ');
    expect(messages()).toEqual([
      'user: How do I parse JSON in Rust, including nested structures?',
      'note: Classifying complexity & routing…',
    ]);
    expect(threadTitles()).toEqual(['How do I parse JSON in Rust, including n']);
    expect(sent()).toEqual({
      thread: saved().threads[0].id,
      provider: undefined,
      model: undefined,
      messages: [{ role: 'user', content: 'How do I parse JSON in Rust, including nested structures?' }],
    });
    expect($<HTMLTextAreaElement>('#input').value).toBe('');
  });

  it('sends the picked model when the user chose one, and remembers the choice', async () => {
    const picker = $<HTMLSelectElement>('#model');
    picker.value = 'local/llama3.2:3b';
    picker.dispatchEvent(new Event('change'));
    await type('hi');
    expect(sent()).toMatchObject({ provider: 'local', model: 'llama3.2:3b' });

    await start();
    expect($<HTMLSelectElement>('#model').value).toBe('local/llama3.2:3b');
  });

  it('goes back to Auto when the remembered model no longer exists', async () => {
    const picker = $<HTMLSelectElement>('#model');
    picker.value = 'local/llama3.2:3b';
    picker.dispatchEvent(new Event('change'));
    modelList = { models: [opus], providers: [] };
    await start();
    expect($<HTMLSelectElement>('#model').value).toBe('auto');
  });

  it('ignores an empty message', async () => {
    await type('   ');
    expect(llm.send).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it('keeps what was typed with its own thread when another one is opened', async () => {
    const input = $<HTMLTextAreaElement>('#input');
    input.value = 'half a thought';
    await newThread(null);
    expect(input.value).toBe('');
    input.value = 'something else';
    // Opening a thread moves it to the top, so the other one is found by not being on screen
    $$<HTMLElement>('#thread-list li.thread:not(.active)')[0].click();
    expect(input.value).toBe('half a thought');
    $$<HTMLElement>('#thread-list li.thread:not(.active)')[0].click();
    expect(input.value).toBe('something else');
  });

  it('sends on Enter but not on Shift+Enter', async () => {
    const input = $<HTMLTextAreaElement>('#input');
    input.value = 'hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
    await flush();
    expect(llm.send).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(sent().messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('explains why nothing can be sent when no provider has models', async () => {
    modelList = {
      models: [],
      providers: [
        { id: 'anthropic', name: 'Anthropic', ok: false, error: 'No API key.' },
        { id: 'local', name: 'Local', ok: false, error: 'No server reachable.' },
      ],
    };
    await start();
    await type('hi');
    expect(llm.send).not.toHaveBeenCalled();
    expect(messages()).toEqual([
      'user: hi',
      'error: No models available.\nAnthropic: No API key.\nLocal: No server reachable.',
    ]);
  });
});

describe('attaching an image to a message', () => {
  // The pictures the user is attaching are read in the renderer, on a FileReader
  // the app owns (see attachments.ts), so the test drives the same attach input
  // and reads the picture off the request the send makes. No preload bridge is
  // involved: only what the renderer itself does is in question.
  const shot = { mediaType: 'image/png', data: 'abc' };
  // jsdom runs a real FileReader on its own timer, so the picture is read into
  // its base64 here at once instead, and the strip is left the same it would be
  const RealFileReader = globalThis.FileReader;
  function attach() {
    globalThis.FileReader = class {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = `data:${shot.mediaType};base64,${shot.data}`;
        this.onload?.();
      }
    } as unknown as typeof FileReader;
    const input = $<HTMLInputElement>('#attach-input');
    Object.defineProperty(input, 'files', { value: [{ type: 'image/png' }], configurable: true });
    input.dispatchEvent(new Event('change'));
  }
  afterEach(() => {
    globalThis.FileReader = RealFileReader;
  });

  it('rides the picture the user attached along on its message', async () => {
    attach();
    await type('what is in this picture?');
    // The sidecar stamps each picture with its own id on the way out (see
    // collectMedia in threads.ts), so the picture rides along with one, and the
    // test checks its bytes and type rather than that id
    expect(sent().messages.at(-1)).toEqual({
      role: 'user',
      content: 'what is in this picture?',
      images: [expect.objectContaining(shot)],
    });
  });

  it('sends a message that is its pictures, with no words', async () => {
    attach();
    $<HTMLFormElement>('#composer').requestSubmit();
    await flush();
    expect(sent().messages.at(-1)).toEqual({
      role: 'user',
      content: '',
      images: [expect.objectContaining(shot)],
    });
  });
});

describe('receiving a reply', () => {
  beforeEach(async () => {
    await type('hi');
  });

  it('streams text into the reply and finishes', () => {
    emit(sentId(), { type: 'step', step: 1 });
    emit(sentId(), { type: 'text', delta: 'Hel' });
    emit(sentId(), { type: 'text', delta: 'lo' });
    expect(messages()).toEqual(['user: hi', 'assistant: Hello']);
    expect($('#send').textContent).toBe('Stop');

    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
    expect($('#send').textContent).toBe('Send');
    expect(saved().threads[0].messages).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'Hello', final: true },
    ]);
  });

  it('draws only the reply as more of its words arrive, not the whole thread', () => {
    emit(sentId(), { type: 'text', delta: 'Hel' });
    const asked = $('#messages .message.user');
    const reply = $('#messages .message.assistant');
    emit(sentId(), { type: 'text', delta: 'lo **there**' });
    expect($('#messages .message.user')).toBe(asked);
    expect($('#messages .message.assistant')).toBe(reply);
    expect(reply.querySelector('strong')?.textContent).toBe('there');
    expect(messages()).toEqual(['user: hi', 'assistant: Hello there']);
  });

  it('sends the next request only the reply the turn ended with, not what was said before a thought', async () => {
    emit(sentId(), { type: 'text', delta: 'Let me look.' });
    emit(sentId(), { type: 'thought', text: 'Checking the file' });
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
    await type('next');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('marks the last words of a finished reply as its answer, and keeps what the app asked for', async () => {
    const { conversation } = await import('../src/renderer/reply');
    emit(sentId(), { type: 'text', delta: 'Let me look.' });
    emit(sentId(), { type: 'thought', text: 'Checking the file' });
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
    const kept = saved().threads[0].messages.filter((m) => m.role === 'assistant');
    expect(kept.map((m) => m.final)).toEqual([undefined, true]);
    expect(
      conversation([
        { role: 'user', text: 'look', fromApp: true },
        { role: 'assistant', text: 'Looking.' },
        { role: 'assistant', text: 'Found it.' },
        { role: 'user', text: 'one' },
        { role: 'assistant', text: 'Looking.' },
        { role: 'assistant', text: 'Answer one.', final: true },
      ])
    ).toEqual([
      { role: 'user', content: 'look' },
      { role: 'assistant', content: 'Found it.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'Answer one.' },
    ]);
  });

  it('puts a general chat into the workspace it moved to, and leaves one that has a workspace where it is', () => {
    const id = saved().threads[0].id;
    threads.open.mockClear();
    emit(sentId(), { type: 'workspace', workspace: '/home/me/ch-workspaces/birds' });
    expect(saved().threads[0].workspace).toBe('/home/me/ch-workspaces/birds');
    expect(saved().recentWorkspaces).toContain('/home/me/ch-workspaces/birds');
    expect(threads.open).toHaveBeenCalledWith(id, '/home/me/ch-workspaces/birds');

    emit(sentId(), { type: 'workspace', workspace: '/home/me/ch-workspaces/other' });
    expect(saved().threads[0].workspace).toBe('/home/me/ch-workspaces/birds');
    expect(threads.open).toHaveBeenCalledTimes(1);
  });

  it('says it is classifying and routing until a model has been chosen, then waits for the reply', () => {
    expect(messages()).toEqual(['user: hi', 'note: Classifying complexity & routing…']);

    emit(sentId(), {
      type: 'classification',
      sophistication: 4,
      effort: 'high',
      category: 'coding',
      model: 'llama3.2:3b',
    });
    expect(messages().at(-1)).toBe('note: Classifying complexity & routing…');

    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    expect(messages()).toEqual(['user: hi', 'note: Coding · 4/5 Complexity · high effort', 'work: Working…']);
  });

  it('says the message is waiting when another request is in progress, until it is classified', () => {
    emit(sentId(), { type: 'queued' });
    expect(messages()).toEqual(['user: hi', 'note: Waiting on in-progress request…']);

    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    expect(messages().at(-1)).toBe('note: Classifying complexity & routing…');
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'matched',
    });
    expect(messages().join('\n')).not.toMatch(/Waiting|Classifying/);
  });

  // A local model answers one conversation at a time and keeps itself for the
  // one whose prompt it is holding (see src/llm/cachelock.ts), so a reply can
  // be waiting on another thread's work rather than on anything of its own
  it('says which model a reply is waiting its turn for, and stops when the turn comes', () => {
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'qwen3.5:9b',
      name: 'qwen3.5:9b',
      sophistication: 3,
      reason: 'matched',
    });
    emit(sentId(), { type: 'queued', model: 'qwen3.5:9b' });
    expect(messages().at(-1)).toBe('note: Waiting its turn for qwen3.5:9b…');

    emit(sentId(), { type: 'waited', ms: 4000 });
    expect(messages().join('\n')).not.toMatch(/Waiting/);
    expect(messages().at(-1)).toBe('work: Working…');
  });

  // The step it is on is still the step it is on, and it is what the window
  // says again as soon as the model is free (see the 'phase' event)
  it('says again what the step was doing once its turn comes', () => {
    emit(sentId(), { type: 'phase', phase: 'explore' });
    const saying = messages().at(-1);
    emit(sentId(), { type: 'queued', model: 'qwen3.5:9b' });
    expect(messages().at(-1)).toBe('work: Waiting its turn for qwen3.5:9b…');
    emit(sentId(), { type: 'waited', ms: 4000 });
    expect(messages().at(-1)).toBe(saying);
  });

  it('stops saying it is classifying once the model the user picked is confirmed', () => {
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'picked',
    });
    expect(messages()).toEqual(['user: hi', 'work: Working…']);
  });

  it('replaces the classifying message with the error when no model could be chosen', () => {
    emit(sentId(), { type: 'classification', failed: true, reason: 'No models available.' });
    emit(sentId(), { type: 'error', code: 'other', message: 'No models available.' });
    expect(messages()).toEqual(['user: hi', 'error: No models available.']);
  });

  it('notes the classification and the model chosen for it above the reply', () => {
    emit(sentId(), {
      type: 'classification',
      sophistication: 4,
      effort: 'high',
      category: 'coding',
      model: 'llama3.2:3b',
    });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    emit(sentId(), { type: 'text', delta: 'Sure.' });
    expect(messages()).toEqual(['user: hi', 'note: Coding · 4/5 Complexity · high effort', 'assistant: Sure.']);
  });

  it('says when the chosen model falls short of what was needed', () => {
    emit(sentId(), { type: 'classification', sophistication: 5, effort: 'high', category: 'coding', model: 'm' });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'best_available',
    });
    expect(messages()[1]).toBe('note: Coding · 5/5 Complexity · high effort');
    expect($('#messages .note details').textContent).toContain('Opus (4/5), the best available');
  });

  it('still names the model when classification failed', () => {
    emit(sentId(), { type: 'classification', failed: true, reason: 'timeout' });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'unclassified',
    });
    expect(messages()).toEqual(['user: hi', 'note: Not classified', 'work: Working…']);
    expect($('#messages .note details').textContent).toContain('Opus (4/5)');
  });

  // A reply that ran to its end with nothing in its bubble. It used to be
  // dropped as a cancellation, which left the turn with no trace of the
  // assistant at all — and a thread whose earlier request has no answer under
  // it gets that request answered again by the next message (see the thread
  // this leaves behind, below).
  describe('a reply that finished without writing anything', () => {
    it('says so in the thread rather than disappearing', () => {
      emit(sentId(), { type: 'thought', text: 'Working it out.' });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      expect(messages()).toEqual([
        'user: hi',
        'work: Work',
        'thought: Working it out.',
        'error: The model finished without writing an answer. Its thoughts above are all it produced.',
      ]);
    });

    // A reply that changed files ends with the harness squaring them with the
    // workspace, which arrives as a tool call after the last word is written
    // (see SYNC_TOOL in harness/index.ts). That closes the bubble holding the
    // answer and opens a fresh one, and the fresh one is empty — which used to
    // be read as a reply that never wrote anything, so every coding reply in a
    // workspace ended by denying the answer sitting directly above it.
    it('does not say so when something interjected after the last word', () => {
      emit(sentId(), { type: 'tool_call', id: 'w1', name: 'write_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'w1', name: 'write_file', output: 'written', isError: false });
      emit(sentId(), { type: 'text', delta: 'I changed a.ts.' });
      emit(sentId(), { type: 'tool_call', id: 'r-level-1', name: 'sync_workspace', input: {} });
      const synced = { id: 'r-level-1', name: 'sync_workspace', output: 'nothing', isError: false };
      emit(sentId(), { type: 'tool_result', ...synced });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 3 });
      expect(messages()).toEqual([
        'user: hi',
        'tool: Wrote a.ts',
        'assistant: I changed a.ts.',
        'work: Work',
        'tool: Checked against the workspace',
      ]);
    });

    // The plan is lifted out of the reply into a message of its own, leaving
    // the reply an empty bubble to carry on in: a reply stopped there has
    // still put the plan in front of the user (see the 'plan' event)
    it('does not say so when all the reply wrote was the plan', () => {
      emit(sentId(), { type: 'text', delta: 'Change a.ts.' });
      emit(sentId(), { type: 'plan', text: 'Change a.ts.' });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 2 });
      expect(messages()).toEqual(['user: hi', 'plan: PlanChange a.ts.']);
    });

    // The screenshots and clips taken while planning are shown under the plan,
    // as they are under the answer (see the 'plan' handler in events.ts)
    it('shows the screenshots and clips a plan carries under its text', () => {
      const shot = { mediaType: 'image/png', data: 'abc' };
      const clip = { mediaType: 'video/webm', data: 'webm' };
      emit(sentId(), { type: 'text', delta: 'Change a.ts.' });
      emit(sentId(), { type: 'plan', text: 'Change a.ts.', images: [shot], videos: [clip] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      expect(messages()).toEqual(['user: hi', 'plan: PlanChange a.ts.']);
      expect($$('#messages .plan img.tool-image').map((img) => img.getAttribute('src'))).toEqual([
        'data:image/png;base64,abc',
      ]);
      expect($('#messages .plan video.tool-video')).not.toBeNull();
    });

    it('leaves nothing behind when the user stopped it, which needs no saying', () => {
      emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 1 });
      expect(messages()).toEqual(['user: hi']);
    });

    // The next message tells the model that the request before it was not
    // left unanswered, so that it answers only the one being asked
    it('declares the gap it leaves to the model answering next', async () => {
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      await type('and now this');
      expect(sent().messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: expect.stringContaining('is not an\nunanswered request') },
        { role: 'user', content: 'and now this' },
      ]);
    });
  });

  // The screenshots a reply's tools took, sent once at the end for the thread
  // to show under the answer (see SHOWN in harness/index.ts)
  describe('the screenshots a reply took', () => {
    const shot = (data: string) => ({ mediaType: 'image/png', data });
    // Only those drawn inside a bubble of the reply's own words count: a
    // picture hung on a message nothing renders is a picture nobody sees
    const drawn = () =>
      $$('#messages .assistant img.tool-image').map((img) => (img as HTMLImageElement).getAttribute('src'));

    it('shows them under the answer that speaks of them', () => {
      emit(sentId(), { type: 'text', delta: 'The screenshot below is the new layout.' });
      emit(sentId(), { type: 'images', images: [shot('abc')] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      expect(messages()).toEqual(['user: hi', 'assistant: The screenshot below is the new layout.']);
      expect(drawn()).toEqual(['data:image/png;base64,abc']);
    });

    // A reply that changed files ends with the harness squaring them with the
    // workspace, which arrives as a tool call after the last word is written
    // (see SYNC_TOOL in harness/index.ts). That closes the bubble holding the
    // answer and opens a fresh, empty one, and the pictures arrive after it:
    // hung on that bubble they went out with it when it was dropped, so the
    // replies most likely to take a screenshot were the ones that never
    // showed any.
    it('shows them when the workspace sync interjected after the answer', () => {
      emit(sentId(), { type: 'tool_call', id: 's1', name: 'screenshot', input: { url: 'after.html' } });
      emit(sentId(), { type: 'tool_result', id: 's1', name: 'screenshot', output: 'Screenshot.', isError: false });
      emit(sentId(), { type: 'text', delta: 'The screenshot below is the new layout.' });
      emit(sentId(), { type: 'tool_call', id: 'r-level-1', name: 'sync_workspace', input: {} });
      const synced = { id: 'r-level-1', name: 'sync_workspace', output: 'nothing', isError: false };
      emit(sentId(), { type: 'tool_result', ...synced });
      emit(sentId(), { type: 'images', images: [shot('abc')] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 3 });
      expect(drawn()).toEqual(['data:image/png;base64,abc']);
    });

    // The last of them, where the harness sent more than one
    it('shows every one it was sent, in the order they were taken', () => {
      emit(sentId(), { type: 'text', delta: 'Before and after.' });
      emit(sentId(), { type: 'images', images: [shot('one'), shot('two')] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      expect(drawn()).toEqual(['data:image/png;base64,one', 'data:image/png;base64,two']);
    });

    // A clip is the user's alone: no provider takes video, so the model is sent
    // frames of it as images and the clip itself only ever reaches the thread
    // (see ToolVideo in types.ts)
    describe('and the clips it recorded', () => {
      const clip = { mediaType: 'video/webm', data: 'webm' };
      const player = () => $('#messages .assistant video.tool-video') as HTMLVideoElement | null;

      const record = () => {
        emit(sentId(), { type: 'text', delta: 'The clip below is the new animation.' });
        emit(sentId(), { type: 'images', images: [shot('abc')], videos: [clip] });
        emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      };

      it('shows them in a player under the answer, beside the screenshots', () => {
        record();
        expect(player()).not.toBeNull();
        // A blob where the window makes them, the data URL it came as where it
        // does not (jsdom): either is allowed to play (see the CSP in index.html)
        expect(player()!.getAttribute('src')).toMatch(/^(blob:|data:video\/webm;base64,webm$)/);
        expect(drawn()).toEqual(['data:image/png;base64,abc']);
      });

      // Silent, so it is allowed to start on its own, and looped: a few seconds
      // of something moving reads as a picture that moves
      it('plays them without asking, quietly, and over again', () => {
        record();
        expect(player()!.muted).toBe(true);
        expect(player()!.autoplay).toBe(true);
        expect(player()!.loop).toBe(true);
        expect(player()!.controls).toBe(true);
      });

      // The thread is rebuilt from scratch on every render, so a player built
      // afresh each time would start the clip over whenever anything changed
      it('keeps the same player across a redraw, so the clip does not start over', async () => {
        record();
        const before = player();
        await type('and now this');
        expect(player()).toBe(before);
      });

      it('keeps them out of what is saved, as it does the screenshots', () => {
        record();
        // The reply itself is on disk; the clip inside it is not — it is named by
        // id, its bytes and type living in the sidecar beside the JSON. Both
        // halves matter: without the first, a save that never happened would pass.
        expect(onDisk).toContain('The clip below is the new animation.');
        const videos = saved().threads[0].messages.flatMap((m) => m.videos ?? []);
        expect(videos).toEqual([{ id: expect.any(String) }]);
      });
    });

    // They are big, and the thread is written to disk on every change (see
    // save in threads.ts), so the bytes are kept out of the JSON
    it('keeps them out of what is saved, naming each by id for the sidecar', () => {
      emit(sentId(), { type: 'text', delta: 'Here it is.' });
      emit(sentId(), { type: 'images', images: [shot('abc')] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      // The reply's words are on disk; the screenshot is not — it is named by
      // id only, its bytes written to the sidecar in the same breath
      expect(onDisk).toContain('Here it is.');
      const images = saved().threads[0].messages.flatMap((m) => m.images ?? []);
      expect(images).toEqual([{ id: expect.any(String) }]);
      expect(Object.keys(onMedia).length).toBe(1);
    });

    // The bytes the JSON does not carry are kept in the sidecar, so the
    // screenshot shows again when the app opens it the next time (see
    // reattachMedia in threads.ts)
    it('keeps the bytes in a sidecar, and shows them again after a restart', async () => {
      emit(sentId(), { type: 'text', delta: 'The screenshot below is the new layout.' });
      emit(sentId(), { type: 'images', images: [shot('abc')] });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 1 });
      expect(drawn()).toEqual(['data:image/png;base64,abc']);
      // Not in the thread's JSON; in the sidecar beside it, keyed by id
      const id = saved().threads[0].messages.flatMap((m) => m.images ?? [])[0]!.id as string;
      expect(onMedia[id]).toEqual({ mediaType: 'image/png', data: 'abc' });
      // The app closed and opened again: the screenshot is hung back on the
      // thread from its id, and drawn again under the answer
      await start();
      expect(drawn()).toEqual(['data:image/png;base64,abc']);
    });
  });

  describe('a message that could not be classified', () => {
    const note = () => $<HTMLDetailsElement>('#messages .note details');
    const sections = () =>
      $$('#messages .note details .label').map((label) => [label.textContent, label.nextElementSibling!.textContent]);
    const route = () =>
      emit(sentId(), {
        type: 'model',
        provider: 'anthropic',
        model: 'opus',
        name: 'Opus',
        sophistication: 4,
        reason: 'unclassified',
      });

    it('gets a dropdown on its note, closed at first, saying why and which model was asked', () => {
      emit(sentId(), {
        type: 'classification',
        failed: true,
        reason: 'The operation timed out.',
        model: 'llama3.2:3b',
      });
      route();
      expect(note().open).toBe(false);
      expect(note().querySelector('summary')!.textContent).toBe('Not classified');
      expect(sections()).toEqual([
        ['Reason', 'The operation timed out.'],
        ['Classifier', 'llama3.2:3b'],
        ['Answered by', 'Opus (4/5)'],
      ]);
    });

    it('shows what the classifier said when its reply was the problem', () => {
      emit(sentId(), {
        type: 'classification',
        failed: true,
        reason: 'The reply was not a level from 1 to 5.',
        model: 'llama3.2:3b',
        reply: 'This looks like a coding task.',
      });
      route();
      expect(sections().at(-2)).toEqual(['Its reply', 'This looks like a coding task.']);
    });

    it('says so when the classifier replied with nothing', () => {
      emit(sentId(), {
        type: 'classification',
        failed: true,
        reason: 'The reply was not a level from 1 to 5.',
        model: 'm',
        reply: '',
      });
      route();
      expect(sections().at(-2)).toEqual(['Its reply', 'Nothing.']);
    });

    it('stays open while the reply streams, and is still there after a restart', async () => {
      emit(sentId(), { type: 'classification', failed: true, reason: 'timeout' });
      route();
      note().open = true;
      note().dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'text', delta: 'Hello.' });
      expect(note().open).toBe(true);

      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await start();
      expect(sections()).toEqual([
        ['Reason', 'timeout'],
        ['Answered by', 'Opus (4/5)'],
      ]);
    });

    it('names the classifier and the model chosen, with no failure details, when classification worked', () => {
      emit(sentId(), {
        type: 'classification',
        sophistication: 4,
        effort: 'high',
        category: 'coding',
        model: 'llama3.2:3b',
      });
      emit(sentId(), {
        type: 'model',
        provider: 'anthropic',
        model: 'opus',
        name: 'Opus',
        sophistication: 4,
        reason: 'matched',
      });
      expect(sections()).toEqual([
        ['Classified by', 'llama3.2:3b'],
        ['Answered by', 'Opus (4/5)'],
      ]);
    });
  });

  it('does not repeat a model the user picked themselves', () => {
    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'picked',
    });
    expect(messages()[1]).toBe('note: Question · 1/5 Complexity · low effort');
  });

  it('keeps which model classified the message, and which was chosen to answer, in a dropdown on the note', () => {
    emit(sentId(), {
      type: 'classification',
      sophistication: 3,
      effort: 'medium',
      category: 'coding',
      model: 'llama3.2:3b',
    });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    const note = () => $<HTMLDetailsElement>('#messages .note details');
    expect(note().open).toBe(false);
    expect(note().querySelector('summary')!.firstChild!.textContent).toBe('Coding · 3/5 Complexity · medium effort');
    expect(note().querySelectorAll('summary .feedback button')).toHaveLength(2);
    expect(
      [...note().querySelectorAll('.label')].map((label) => [label.textContent, label.nextElementSibling!.textContent])
    ).toEqual([
      ['Classified by', 'llama3.2:3b'],
      ['Answered by', 'Opus (4/5)'],
    ]);

    // It stays open while the reply streams
    note().open = true;
    note().dispatchEvent(new Event('toggle'));
    emit(sentId(), { type: 'text', delta: 'Here.' });
    expect(note().open).toBe(true);
  });

  describe('rating the classification', () => {
    const classify = () =>
      emit(sentId(), {
        type: 'classification',
        sophistication: 3,
        effort: 'medium',
        category: 'coding',
        model: 'llama3.2:3b',
      });
    const classification = { sophistication: 3, effort: 'medium', category: 'coding', model: 'llama3.2:3b' };
    const buttons = () => $$('#messages .feedback button').map((b) => b.textContent);
    const choose = (...problems: string[]) => {
      for (const problem of problems) {
        const box = $<HTMLInputElement>(`#feedback-form input[value="${problem}"]`);
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    it('offers a good and a bad button inline with the classification message', () => {
      classify();
      expect(buttons()).toEqual(['👍', '👎']);
      // On the summary line itself, so they show while the dropdown is closed
      expect($$('#messages summary .feedback button')).toHaveLength(2);
      const details = $('#messages .feedback').closest('details')!;
      expect(details.open).toBe(false);
      $$('#messages .feedback button')[1].click();
      expect(details.open).toBe(false);
    });

    it('sends a good rating at once and shows it in place of the buttons', () => {
      classify();
      $$('#messages .feedback button')[0].click();
      expect(llm.feedback).toHaveBeenCalledWith({
        rating: 'good',
        problems: undefined,
        request: 'hi',
        classification,
        thread: expect.any(String),
        // The conversation the classifier was given, so the verdict can be
        // replayed against it later (see evals/feedback.ts)
        messages: [{ role: 'user', content: 'hi' }],
        workspace: undefined,
        summary: undefined,
      });
      expect(buttons()).toEqual([]);
      expect($('#messages .feedback').textContent).toBe('Rated good');
      expect(saved().threads[0].messages.find((m: { feedback?: string }) => m.feedback)?.feedback).toBe('good');
    });

    it('asks what went wrong for a bad rating, and sends the answer', () => {
      classify();
      $$('#messages .feedback button')[1].click();
      expect($<HTMLDialogElement>('#feedback-dialog').open).toBe(true);
      expect(llm.feedback).not.toHaveBeenCalled();
      expect($<HTMLButtonElement>('#feedback-send').disabled).toBe(true);

      // Too low and too high cannot both be ticked
      choose('too_low', 'too_high', 'wrong_type');
      expect($<HTMLInputElement>('#feedback-form input[value="too_low"]').checked).toBe(false);
      expect($<HTMLButtonElement>('#feedback-send').disabled).toBe(false);
      $<HTMLFormElement>('#feedback-form').requestSubmit();

      expect(llm.feedback).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 'bad', problems: ['too_high', 'wrong_type'], request: 'hi' })
      );
      expect($<HTMLDialogElement>('#feedback-dialog').open).toBe(false);
      expect($('#messages .feedback').textContent).toBe('Rated bad');
    });

    it('sends the conversation as it stood, without the turns after the message rated', async () => {
      classify();
      emit(sentId(), { type: 'text', delta: 'Hello.' });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 0 });
      await type('and now the second thing');
      classify();
      // The first classification's buttons, not the second's
      $$('#messages .feedback button')[0].click();
      const sent = llm.feedback.mock.calls[0][0];
      expect(sent.request).toBe('hi');
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('sends nothing when the pop-up is cancelled', () => {
      classify();
      $$('#messages .feedback button')[1].click();
      $('#feedback-cancel').click();
      expect(llm.feedback).not.toHaveBeenCalled();
      expect(buttons()).toEqual(['👍', '👎']);
    });
  });

  it('shows tool use between the text before and after it, marking failures', () => {
    emit(sentId(), { type: 'text', delta: 'Let me check.' });
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'run_command', input: {} });
    emit(sentId(), { type: 'tool_call', id: 'c2', name: 'read_file', input: {} });
    emit(sentId(), { type: 'tool_result', id: 'c1', name: 'run_command', output: 'ok', isError: false });
    emit(sentId(), { type: 'tool_result', id: 'c2', name: 'read_file', output: 'nope', isError: true });
    emit(sentId(), { type: 'text', delta: 'Done.' });
    expect(messages()).toEqual([
      'user: hi',
      'assistant: Let me check.',
      'work: Work',
      'tool: Ran a command',
      'tool: Read a file (failed)',
      'assistant: Done.',
    ]);
  });

  it('shows thoughts apart from the results, in the order they came', () => {
    emit(sentId(), { type: 'thought', text: 'Looking for the config file.' });
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'search_workspace', input: {} });
    emit(sentId(), { type: 'tool_result', id: 'c1', name: 'search_workspace', output: 'ok', isError: false });
    emit(sentId(), { type: 'thought', text: 'Summarising what was found.' });
    emit(sentId(), { type: 'text', delta: 'It is in src/settings.ts.\n\n' });
    emit(sentId(), { type: 'thought', text: 'Adding a caveat.' });
    emit(sentId(), { type: 'text', delta: 'It is encrypted.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 2 });
    expect(messages()).toEqual([
      'user: hi',
      'work: Work',
      'thought: Looking for the config file.',
      'tool: Searched workspace',
      'thought: Summarising what was found.',
      'assistant: It is in src/settings.ts.',
      'work: Work',
      'thought: Adding a caveat.',
      'assistant: It is encrypted.',
    ]);
  });

  describe('the work that went into a reply', () => {
    const works = () => $$('#messages .message.work');
    const finish = () =>
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

    it('folds a thought and a tool call that only looked into one Work dropdown, closed at first', () => {
      emit(sentId(), { type: 'thought', text: 'Looking for the config file.' });
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'ok', isError: false });
      emit(sentId(), { type: 'text', delta: 'Found it.' });
      finish();
      expect(works()).toHaveLength(1);
      const details = works()[0].querySelector(':scope > details') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')!.textContent).toBe('Work');
      expect(details.querySelectorAll('.message.thought')).toHaveLength(1);
      expect(details.querySelectorAll('.message.tool')).toHaveLength(1);
    });

    it('is split in two by a file being changed between the thoughts', () => {
      emit(sentId(), { type: 'thought', text: 'Changing a.ts.' });
      emit(sentId(), { type: 'tool_call', id: 'w1', name: 'edit_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'w1', name: 'edit_file', output: 'edited', isError: false });
      emit(sentId(), { type: 'thought', text: 'Checking it.' });
      finish();
      expect(works()).toHaveLength(2);
      // The change itself is shown in the thread, outside either block
      expect($$('#messages > .message.tool')).toHaveLength(1);
    });

    it('is split in two by a file being written between the thoughts', () => {
      emit(sentId(), { type: 'thought', text: 'Writing a.ts.' });
      emit(sentId(), { type: 'tool_call', id: 'w1', name: 'write_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'w1', name: 'write_file', output: 'written', isError: false });
      emit(sentId(), { type: 'thought', text: 'Checking it.' });
      finish();
      expect(works()).toHaveLength(2);
    });

    it('is split in two by a subagent between the thoughts', () => {
      emit(sentId(), { type: 'thought', text: 'Handing it out.' });
      emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests' });
      emit(sentId(), { type: 'thought', text: 'Waiting on it.' });
      expect(works()).toHaveLength(2);
    });

    it('is named for the step its work was done in, in the past tense once the step is over', () => {
      emit(sentId(), { type: 'phase', phase: 'explore' });
      emit(sentId(), { type: 'thought', text: 'Looking around.' });
      // Still going on: named for what it is doing, with the waiting dots after it
      expect(works().map((work) => work.querySelector('summary')!.textContent)).toEqual([
        'Finding out what this touches…',
      ]);
      expect(works()[0].querySelector('summary .waiting')).not.toBeNull();
      emit(sentId(), { type: 'phase', phase: 'execute' });
      // A thought straight after the last would join its run, and so its phase
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'ok', isError: false });
      emit(sentId(), { type: 'thought', text: 'Making the change.' });
      finish();
      expect(works().map((work) => work.querySelector('summary')!.textContent)).toEqual([
        'Found out what this touches',
        'Made the changes',
      ]);
      expect($$('#messages .waiting')).toEqual([]);
    });

    it('is not split by the edits and subagents of a step, which are drawn below it as well', () => {
      emit(sentId(), { type: 'phase', phase: 'execute' });
      emit(sentId(), { type: 'thought', text: 'Changing a.ts.' });
      emit(sentId(), { type: 'tool_call', id: 'w1', name: 'edit_file', input: { path: 'a.ts' } });
      emit(sentId(), { type: 'tool_result', id: 'w1', name: 'edit_file', output: 'edited', isError: false });
      emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests' });
      emit(sentId(), { type: 'thought', text: 'Checking it.' });
      emit(sentId(), { type: 'text', delta: 'Done.' });
      finish();
      expect(works()).toHaveLength(1);
      const inside = [...works()[0].querySelectorAll(':scope > details > .message')];
      expect(inside.map((m) => m.className)).toEqual([
        'message thought',
        'message tool event',
        'message subagent event',
        'message thought',
      ]);
      // The edit and the subagent are lines in the dropdown, not dropdowns
      expect(inside[1].querySelector('details')).toBeNull();
      expect(inside[1].textContent).toContain('a.ts');
      expect(inside[2].querySelector('button.open')).not.toBeNull();
      // ...and are in the thread under it, in order, as they are elsewhere
      expect($$('#messages > .message').map((m) => m.classList[1])).toEqual([
        'user',
        'work',
        'tool',
        'subagent',
        'assistant',
      ]);
      expect($('#messages > .message.tool details')).not.toBeNull();
    });
  });

  describe('a run of thoughts', () => {
    const runs = () => $$('#messages .thought details') as HTMLDetailsElement[];
    const labels = () => runs().map((t) => t.querySelector('summary')!.textContent);
    const texts = () => runs().map((t) => [...t.querySelectorAll('pre')].map((pre) => pre.textContent));

    beforeEach(() => {
      emit(sentId(), { type: 'thought', text: 'Planning the approach.' });
      emit(sentId(), { type: 'thought', text: 'Checking the result.' });
    });

    const finish = () =>
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

    it('puts the thoughts that came one after another in a single dropdown', () => {
      expect(runs()).toHaveLength(1);
      expect(labels()).toEqual(['2 thoughts']);
      expect(texts()).toEqual([['Planning the approach.', 'Checking the result.']]);
      expect($$('#messages .thought .label')).toEqual([]);
    });

    it('is open while the model is still thinking', () => {
      expect(runs().map((t) => t.open)).toEqual([true]);
    });

    it('closes once the reply has something to say', () => {
      emit(sentId(), { type: 'text', delta: 'Here is the answer.' });
      expect(runs().map((t) => t.open)).toEqual([false]);
    });

    it('starts a new run, open, when the model thinks again after writing', () => {
      emit(sentId(), { type: 'text', delta: 'Partly.' });
      emit(sentId(), { type: 'thought', text: 'Thinking again.' });
      expect(labels()).toEqual(['2 thoughts', 'Thought']);
      // Only the newest run is open
      expect(runs().map((t) => t.open)).toEqual([false, true]);
      expect(texts()).toEqual([['Planning the approach.', 'Checking the result.'], ['Thinking again.']]);
    });

    it('stays closed once the user closes it', () => {
      runs()[0].open = false;
      runs()[0].dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'thought', text: 'Still going.' });
      expect(runs().map((t) => t.open)).toEqual([false]);
    });

    it('closes when the reply finishes, however it ends', async () => {
      finish();
      expect(runs().map((t) => t.open)).toEqual([false]);

      await type('again');
      emit(sentId(), { type: 'thought', text: 'Trying.' });
      expect(runs().map((t) => t.open)).toEqual([false, true]);
      emit(sentId(), { type: 'error', code: 'other', message: 'It broke.' });
      expect(runs().map((t) => t.open)).toEqual([false, false]);
    });

    it('can be opened again after the reply, and then stays open', async () => {
      finish();
      runs()[0].open = true;
      runs()[0].dispatchEvent(new Event('toggle'));
      await type('next');
      emit(sentId(), { type: 'text', delta: 'Sure.' });
      expect(runs().map((t) => t.open)).toEqual([true]);
    });

    it('is not reopened by a dropdown that has since been rebuilt', () => {
      const [stale] = runs();
      finish();
      stale.dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'text', delta: 'late' });
      expect(runs().map((t) => t.open)).toEqual([false]);
    });

    it('is still in its dropdown after a restart', async () => {
      finish();
      await start();
      expect(texts()).toEqual([['Planning the approach.', 'Checking the result.']]);
    });
  });

  it('keeps thoughts out of what is sent to the model next time', async () => {
    emit(sentId(), { type: 'thought', text: 'Recalling the capital.' });
    emit(sentId(), { type: 'text', delta: 'Paris.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await type('and Spain?');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: 'and Spain?' },
    ]);
  });

  describe('a successful tool call', () => {
    const succeeded = () => $<HTMLDetailsElement>('#messages .tool details.succeeded');
    const sections = () =>
      $$('#messages .tool details.succeeded .label').map((label) => [
        label.textContent,
        label.nextElementSibling!.textContent,
      ]);
    const finish = (input: Record<string, unknown> | null, output: string) => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output, isError: false });
    };

    it('shows its input in a dropdown as soon as it is called, before its result arrives', () => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.txt' } });
      const running = $<HTMLDetailsElement>('#messages .tool details.running');
      expect(running.open).toBe(false);
      expect(running.querySelector('summary')!.textContent).toBe('Reading a.txt…');
      expect(
        [...running.querySelectorAll('.label')].map((label) => [
          label.textContent,
          label.nextElementSibling!.textContent,
        ])
      ).toEqual([['Input', 'path: a.txt']]);
      expect(messages().at(-2)).toBe('tool: Reading a.txt…');
    });

    it('says the tool is running only until its result arrives', () => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.txt' } });
      emit(sentId(), { type: 'tool_call', id: 'c2', name: 'run_command', input: { command: 'ls' } });
      const labels = () => $$('#messages .tool summary').map((s) => s.textContent);
      expect(labels()).toEqual(['Reading a.txt…', 'Running ls…']);
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'contents', isError: false });
      expect(labels()).toEqual(['Read a.txt', 'Running ls…']);
      emit(sentId(), { type: 'tool_result', id: 'c2', name: 'run_command', output: 'no', isError: true });
      expect(labels()).toEqual(['Read a.txt', 'Ran ls (failed)']);
    });

    it('no longer says a tool is running once the reply is over, or after a restart', async () => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.txt' } });
      emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 1 });
      const label = () => $('#messages .tool summary').textContent;
      expect(label()).toBe('Read a.txt');
      await start();
      expect(label()).toBe('Read a.txt');
    });

    it('stays open when its result arrives, if it was opened while the tool ran', () => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.txt' } });
      const running = $<HTMLDetailsElement>('#messages .tool details.running');
      running.open = true;
      running.dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'contents', isError: false });
      expect(succeeded().open).toBe(true);
      expect(sections()).toEqual([
        ['Input', 'path: a.txt'],
        ['Output', 'contents'],
      ]);
    });

    it('gets a dropdown, closed at first, with its input and output', () => {
      finish({ path: 'notes.txt' }, 'first line\nsecond line\n');
      expect(succeeded().open).toBe(false);
      expect(succeeded().querySelector('summary')!.textContent).toBe('Read notes.txt');
      expect(sections()).toEqual([
        ['Input', 'path: notes.txt'],
        ['Output', 'first line\nsecond line'],
      ]);
    });

    it('shows each input on one line, cut short when long', () => {
      finish(
        { path: 'a.txt', content: `line one\nline two ${'x'.repeat(300)}`, overwrite: true, lines: [1, 2] },
        'Wrote a.txt'
      );
      const [, input] = sections()[0];
      expect(input!.split('\n')).toEqual([
        'path: a.txt',
        `content: line one line two ${'x'.repeat(102)}…`,
        'overwrite: true',
        'lines: [1,2]',
      ]);
    });

    it('shows only the start of a long output, and says how much more there was', () => {
      const output = Array.from({ length: 40 }, (_, i) => (i === 1 ? 'y'.repeat(500) : `line ${i + 1}`)).join('\n');
      finish({ path: 'big.txt' }, output);
      const lines = sections()[1][1]!.split('\n');
      expect(lines).toHaveLength(7);
      expect(lines[0]).toBe('line 1');
      expect(lines[1]).toBe(`${'y'.repeat(160)}…`);
      expect(lines[6]).toBe('… 34 more lines');
    });

    it('says so when there was no input or no output', () => {
      finish({}, '  \n');
      expect(sections()).toEqual([
        ['Input', 'No input.'],
        ['Output', 'No output.'],
      ]);
    });

    it('stays open while the reply keeps streaming', () => {
      finish({ path: 'a.txt' }, 'contents');
      succeeded().open = true;
      succeeded().dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'text', delta: 'Here it is.' });
      expect(succeeded().open).toBe(true);
    });
  });

  describe('a failed tool call', () => {
    const failed = () => $<HTMLDetailsElement>('#messages .tool details.failed');
    const sections = () =>
      $$('#messages .tool details.failed .label').map((label) => [
        label.textContent,
        label.nextElementSibling!.textContent,
      ]);

    beforeEach(() => {
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'run_command', input: { command: 'ls' } });
      emit(sentId(), { type: 'tool_call', id: 'c2', name: 'read_file', input: { path: 'missing.txt' } });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'run_command', output: 'ok', isError: false });
      emit(sentId(), {
        type: 'tool_result',
        id: 'c2',
        name: 'read_file',
        output: 'cat: missing.txt: No such file or directory',
        isError: true,
      });
    });

    it('gets a dropdown, closed at first, with the error and what the tool was called with', () => {
      expect($$('#messages .tool details.failed')).toHaveLength(1);
      expect(failed().open).toBe(false);
      expect(failed().querySelector('summary')!.textContent).toBe('Read missing.txt (failed)');
      expect(sections()).toEqual([
        ['Error', 'cat: missing.txt: No such file or directory'],
        ['Input', '{\n  "path": "missing.txt"\n}'],
      ]);
    });

    it('stays open while the reply keeps streaming', () => {
      failed().open = true;
      failed().dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'text', delta: 'That file is missing.' });
      expect(failed().open).toBe(true);

      failed().open = false;
      failed().dispatchEvent(new Event('toggle'));
      emit(sentId(), { type: 'text', delta: ' Sorry.' });
      expect(failed().open).toBe(false);
    });

    it('is still there after a restart, and the successful call keeps only its summary', async () => {
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 2 });
      await start();
      expect(sections()[0]).toEqual(['Error', 'cat: missing.txt: No such file or directory']);
      const notes = saved().threads[0].messages.filter((m: { role: string }) => m.role === 'tool');
      expect(notes[0]).toEqual({
        role: 'tool',
        text: 'Used run_command',
        tool: 'run_command',
        callId: 'c1',
        inputSummary: 'command: ls',
        output: 'ok',
      });
      expect(notes[1]).not.toHaveProperty('inputSummary');
    });
  });

  it('says so when a failed tool call had unusable input or no output, and trims a very long error', () => {
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: null });
    emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: '', isError: true });
    emit(sentId(), { type: 'tool_call', id: 'c2', name: 'run_command', input: {} });
    emit(sentId(), { type: 'tool_result', id: 'c2', name: 'run_command', output: 'x'.repeat(9000), isError: true });
    const pres = $$('#messages .tool details.failed pre').map((pre) => pre.textContent as string);
    expect(pres.slice(0, 2)).toEqual(['The tool gave no details.', 'The input was not valid JSON.']);
    expect(pres[2]).toHaveLength(5000 + '\n[truncated]'.length);
  });

  it('shows an error in place of an empty reply', () => {
    emit(sentId(), { type: 'error', code: 'auth', message: 'Anthropic rejected the API key.' });
    expect(messages()).toEqual(['user: hi', 'error: Anthropic rejected the API key.']);
    expect($('#send').textContent).toBe('Send');
  });

  it('keeps a partial reply and reports the error after it', () => {
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    emit(sentId(), { type: 'error', code: 'unreachable', message: 'Connection lost.' });
    expect(messages()).toEqual(['user: hi', 'assistant: Half an ans', 'error: Connection lost.']);
  });

  it.each([
    ['refusal', 'The model declined to respond.'],
    ['max_steps', 'Stopped: the model kept calling tools without answering.'],
  ])('explains a reply that ended with %s', (stopReason, text) => {
    emit(sentId(), { type: 'done', stopReason, usage: { input: 0, output: 0 }, steps: 1 });
    expect(messages()).toEqual(['user: hi', `error: ${text}`]);
  });

  it('removes the empty bubble when a reply is cancelled before any text', () => {
    emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 0 });
    expect(messages()).toEqual(['user: hi']);
  });

  it('ignores events for requests it does not know', () => {
    expect(() => emit('unknown', { type: 'text', delta: 'x' })).not.toThrow();
    expect(messages()).toEqual(['user: hi', 'note: Classifying complexity & routing…']);
  });

  it('sends only the conversation text on the next message, not notes, tools or errors', async () => {
    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'run_command', input: {} });
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    emit(sentId(), { type: 'error', code: 'other', message: 'Then it broke.' });
    await type('and then?');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'and then?' },
    ]);
  });
});

describe('token use', () => {
  const classifierUse = {
    type: 'usage' as const,
    purpose: 'classification' as const,
    provider: 'local',
    model: 'llama3.2:3b',
    input: 120,
    output: 3,
    cost: 0,
  };
  const replyUse = {
    type: 'usage' as const,
    purpose: 'reply' as const,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    input: 2000,
    output: 500,
    cost: 0.018,
  };
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  // One finished exchange in which these models used tokens
  const exchange = async (question: string, ...uses: HarnessEvent[]) => {
    await type(question);
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    for (const use of uses) emit(sentId(), use);
    finish();
  };
  const noteLines = () =>
    $$('#messages .usage details .label').map(
      (label) => `${label.textContent}: ${label.nextElementSibling!.textContent}`
    );
  const header = () => $<HTMLDetailsElement>('#thread-usage');
  const headerRows = () =>
    $$('#thread-usage-models div').map((row) => [...row.children].map((c) => c.textContent).join(': '));

  // Most of what a tool loop sends is the same prompt over again, so what it
  // paid full price for is a different figure from what it sent
  it('says how much of what went in was read back from the cache', async () => {
    await exchange('question', { ...replyUse, input: 2000, cacheRead: 1500, cacheWrite: 400, cost: 0.0043 });
    expect(messages().at(-1)).toBe('note: Tokens: 500 in (1.5K cached) · 500 out · $0.0043');
    expect(noteLines()[0]).toBe('Reply · claude-opus-5-5: 500 in (1.5K cached) · 500 out · $0.0043');
  });

  // The first pass of a reply caches nothing, and every pass after it caches
  // most of what it sends: a line that counted only the first pass's share
  // reported a tool loop that was reusing its prompt as caching nothing at all
  it('adds up the cached share of every pass of one reply, not just the first', async () => {
    await exchange(
      'question',
      { ...replyUse, input: 2000, cost: 0.03 },
      { ...replyUse, input: 3000, cacheRead: 1900, cost: 0.02 },
      { ...replyUse, input: 4000, cacheRead: 2900, cost: 0.02 }
    );
    expect(messages().at(-1)).toBe('note: Tokens: 4.2K in (4.8K cached) · 1.5K out · $0.0700');
  });

  it('leaves the cached share off where a provider reports none, rather than showing a nought', async () => {
    await exchange('question', classifierUse, replyUse);
    expect(messages().at(-1)).toBe('note: Tokens: 2.1K in · 503 out · $0.0180');
  });

  it("adds the cached shares into the thread's running total", async () => {
    await exchange('one', { ...replyUse, cacheRead: 1000 });
    await exchange('two', { ...replyUse, cacheRead: 500 });
    expect(headerRows()).toEqual(['claude-opus-5-5: 2.5K in (1.5K cached) · 1K out · $0.0360']);
  });

  it("closes each request with its tokens and overall cost, opening to show each model's share", async () => {
    await exchange('question', classifierUse, replyUse);
    expect(messages()).toEqual(['user: question', 'assistant: Answer.', 'note: Tokens: 2.1K in · 503 out · $0.0180']);
    expect($<HTMLDetailsElement>('#messages .usage details').open).toBe(false);
    expect(noteLines()).toEqual([
      'Classification · llama3.2:3b: 120 in · 3 out · free',
      'Reply · claude-opus-5-5: 2K in · 500 out · $0.0180',
      'Context sent with each request: 1. Classification · llama3.2:3b: 120 tokens\n' +
        '2. Reply · claude-opus-5-5: 2K tokens',
    ]);
  });

  it('lists the context sent with each request as it is made, rather than only the sum', async () => {
    await type('question');
    emit(sentId(), { type: 'text', delta: 'Partial' });
    emit(sentId(), replyUse);
    expect(noteLines().at(-1)).toBe('Context sent with each request: 1. Reply · claude-opus-5-5: 2K tokens');
    emit(sentId(), { ...replyUse, input: 3500, output: 200 });
    expect(noteLines()).toEqual([
      'Reply · claude-opus-5-5: 5.5K in · 700 out · $0.0360',
      'Context sent with each request: 1. Reply · claude-opus-5-5: 2K tokens\n' +
        '2. Reply · claude-opus-5-5: 3.5K tokens',
    ]);
    finish();
    expect(noteLines().at(-1)).toBe(
      'Context sent with each request: 1. Reply · claude-opus-5-5: 2K tokens\n' +
        '2. Reply · claude-opus-5-5: 3.5K tokens'
    );
  });

  it('shows the tokens at the end of the thread while the request runs, and keeps it up to date', async () => {
    await type('question');
    emit(sentId(), { type: 'text', delta: 'Partial' });
    emit(sentId(), classifierUse);
    expect(messages()).toEqual(['user: question', 'assistant: Partial', 'note: Tokens: 120 in · 3 out · free']);
    emit(sentId(), replyUse);
    emit(sentId(), { type: 'text', delta: ' answer' });
    expect(messages()).toEqual([
      'user: question',
      'assistant: Partial answer',
      'note: Tokens: 2.1K in · 503 out · $0.0180',
    ]);
    finish();
    expect(messages()).toEqual([
      'user: question',
      'assistant: Partial answer',
      'note: Tokens: 2.1K in · 503 out · $0.0180',
    ]);
  });

  it('adds nothing when no token counts were reported', async () => {
    await exchange('question');
    expect(messages()).toEqual(['user: question', 'assistant: Answer.']);
    expect(header().hidden).toBe(true);
  });

  it('says a request was free when only local models were used', async () => {
    await exchange('question', classifierUse, { ...classifierUse, purpose: 'reply', input: 900, output: 100 });
    expect(messages().at(-1)).toBe('note: Tokens: 1K in · 103 out · free');
  });

  it('says so when a cost is not known, without passing off a partial total as the whole', async () => {
    const unknown = { ...replyUse, model: 'claude-next', cost: null };
    await exchange('one', unknown);
    expect(messages().at(-1)).toBe('note: Tokens: 2K in · 500 out · cost unknown');

    await exchange('two', replyUse, { ...unknown, purpose: 'classification' as const });
    expect(messages().at(-1)).toBe('note: Tokens: 4K in · 1K out · $0.0180 + unknown');
  });

  it.each([
    [999, '999'],
    [1000, '1K'],
    [1234, '1.2K'],
    [12_345, '12K'],
    [123_456, '120K'],
    [999_999, '1M'],
    [3_540_000, '3.5M'],
    [2_000_000_000, '2B'],
  ])('shortens %i tokens to %s, to two significant figures from the thousands up', async (input, shown) => {
    await exchange('question', { ...replyUse, input, output: 0 });
    expect(messages().at(-1)).toMatch(new RegExp(`^note: Tokens: ${shown} in · 0 out`));
  });

  it('shows larger and very small costs sensibly', async () => {
    await exchange('big', { ...replyUse, input: 3_000_000, output: 0, cost: 12 });
    expect(messages().at(-1)).toBe('note: Tokens: 3M in · 0 out · $12.00');
    await exchange('tiny', { ...replyUse, input: 10, output: 1, cost: 0.00006 });
    expect(messages().at(-1)).toBe('note: Tokens: 10 in · 1 out · <$0.0001');
  });

  it('puts the note after an error that ended the request', async () => {
    await type('question');
    emit(sentId(), { type: 'text', delta: 'Partial' });
    emit(sentId(), replyUse);
    emit(sentId(), { type: 'error', code: 'other', message: 'Connection lost.' });
    expect(messages()).toEqual([
      'user: question',
      'assistant: Partial',
      'error: Connection lost.',
      'note: Tokens: 2K in · 500 out · $0.0180',
    ]);
  });

  it('puts the note after an error that came before any text', async () => {
    await type('question');
    emit(sentId(), classifierUse);
    emit(sentId(), { type: 'error', code: 'other', message: 'No models available.' });
    expect(messages()).toEqual([
      'user: question',
      'error: No models available.',
      'note: Tokens: 120 in · 3 out · free',
    ]);
  });

  it("climbs the thread's total with each pass, before the reply has finished", async () => {
    await type('question');
    // Nothing used yet, but classification has begun: only the clock to show
    expect($('#thread-usage-summary').textContent).toBe('0s elapsed');

    // The harness reports each pass as it ends (see harness/index.ts)
    emit(sentId(), classifierUse);
    expect($('#thread-usage-summary').textContent).toBe('123 tokens · free · 0s elapsed');
    emit(sentId(), replyUse);
    expect($('#thread-usage-summary').textContent).toBe('2.6K tokens · $0.0180 · 0s elapsed');
    emit(sentId(), replyUse);
    expect($('#thread-usage-summary').textContent).toBe('5.1K tokens · $0.0360 · 0s elapsed');

    // ...and the note at the end is still one line per model, with each pass
    // only in the list of what each request was sent
    finish();
    expect(noteLines()).toEqual([
      'Classification · llama3.2:3b: 120 in · 3 out · free',
      'Reply · claude-opus-5-5: 4K in · 1K out · $0.0360',
      'Context sent with each request: 1. Classification · llama3.2:3b: 120 tokens\n' +
        '2. Reply · claude-opus-5-5: 2K tokens\n' +
        '3. Reply · claude-opus-5-5: 2K tokens',
    ]);
    expect(messages().at(-1)).toBe('note: Tokens: 4.1K in · 1K out · $0.0360');
  });

  // ---- How long the models took over it (see Latency)
  //
  // The pill carries the thread's running total of tokens and cost; the same
  // calls are timed, so it carries their time too. Only the calls somebody
  // waits on are: a reply and its subagents, and not the app's own errands.
  describe('the time taken, beside the tokens', () => {
    const took = (totalMs: number, over: Partial<typeof replyUse> = {}) => ({
      ...replyUse,
      ...over,
      latency: { totalMs },
    });
    // The pill without the clock that runs beside it while a reply is going
    const summary = () => $('#thread-usage-summary').textContent!.replace(/(^| · )[^·]*elapsed$/, '');
    const waitsRow = () => headerRows().find((row) => row.startsWith('Time the models took'));

    it('says how long the call took in full, after the tokens and the cost', async () => {
      await exchange('question', took(2100));
      expect(summary()).toBe('2.5K tokens · $0.0180 · 2.1s');
    });

    it('gives it per model as well as in full, a thread using two of them having no one answer', async () => {
      await exchange('question', took(400, { provider: 'local', model: 'llama3.2:3b', cost: 0 }), took(3000));
      expect(headerRows()).toEqual([
        'claude-opus-5-5: 2K in · 500 out · $0.0180 · 3.0s',
        'llama3.2:3b: 2K in · 500 out · free · 400ms',
        // The two of them together, under the models rather than among them
        'Time the models took: 3.4s in all · 3.0s slowest · over 2 calls',
      ]);
    });

    it('adds the calls up and keeps the slowest, a total alone not saying which call hurt', async () => {
      await exchange('question', took(1000), took(1000), took(7000));
      expect(summary()).toBe('7.5K tokens · $0.0540 · 9.0s');
      expect(waitsRow()).toBe('Time the models took: 9.0s in all · 7.0s slowest · over 3 calls');
    });

    it('says the one time plainly when there has only been one call, a total of one being itself', async () => {
      await exchange('question', took(2100));
      expect(waitsRow()).toBe('Time the models took: 2.1s');
    });

    it('keeps the wait behind another request apart from it, and says it as its own thing', async () => {
      // A local provider answers one at a time, so a thread of them queues.
      // That is the app serialising its work, not the model being slow.
      await exchange('question', { ...took(800), latency: { totalMs: 800, queuedMs: 4000 } });
      expect(summary()).toBe('2.5K tokens · $0.0180 · 800ms');
      expect(waitsRow()).toBe('Time the models took: 800ms · 4.0s more spent waiting its turn');
    });

    it('says nothing of the time when nothing was timed, rather than showing a nought', async () => {
      await exchange('question', classifierUse, replyUse);
      expect(summary()).toBe('2.6K tokens · $0.0180');
      expect(waitsRow()).toBeUndefined();
      // ...and leaves the models themselves as they were
      expect(headerRows()).toEqual([
        'claude-opus-5-5: 2K in · 500 out · $0.0180',
        'llama3.2:3b: 120 in · 3 out · free',
      ]);
    });

    it('counts only the calls that were timed, the errands nobody waits on being untimed', async () => {
      await exchange('question', classifierUse, took(2000));
      expect(summary()).toBe('2.6K tokens · $0.0180 · 2.0s');
      expect(waitsRow()).toBe('Time the models took: 2.0s');
    });

    it("counts a subagent's calls with the rest, a thread waiting on those too", async () => {
      await exchange('question', took(1000, { purpose: 'subagent' }), took(3000));
      expect(waitsRow()).toBe('Time the models took: 4.0s in all · 3.0s slowest · over 2 calls');
    });

    it.each([
      [450, '450ms'],
      [1250, '1.3s'],
      [9949, '9.9s'],
      [12_400, '12s'],
      [95_000, '1m 35s'],
    ])('reads %ims as %s: tenths while they are felt, and minutes once there are any', async (ms, shown) => {
      await exchange('question', took(ms));
      expect(summary()).toBe(`2.5K tokens · $0.0180 · ${shown}`);
    });

    it('climbs while the reply runs, as the tokens do', async () => {
      await type('question');
      emit(sentId(), took(1000));
      expect(summary()).toBe('2.5K tokens · $0.0180 · 1.0s');
      emit(sentId(), took(3000));
      expect(summary()).toBe('5K tokens · $0.0360 · 4.0s');
      finish();
      expect(summary()).toBe('5K tokens · $0.0360 · 4.0s');
    });

    it('is kept with the thread, so it is still there when the app is opened again', async () => {
      await exchange('question', took(2100));
      expect(saved().threads[0].usage['anthropic/claude-opus-5-5'].waits).toEqual({
        timed: 1,
        spent: 2100,
        slowest: 2100,
        queued: 0,
      });
      await start();
      expect(summary()).toBe('2.5K tokens · $0.0180 · 2.1s');
    });

    it("says it in the request's note too, over every pass and not only the first", async () => {
      await exchange('question', took(1000), took(3000));
      expect(messages().at(-1)).toBe('note: Tokens: 4K in · 1K out · $0.0360 · 4.0s');
      expect(noteLines()[0]).toBe('Reply · claude-opus-5-5: 4K in · 1K out · $0.0360 · 4.0s');
    });

    it('gives each model in the note its own, as the pill does', async () => {
      await exchange('question', took(400, { provider: 'local', model: 'llama3.2:3b', cost: 0 }), took(3000));
      expect(noteLines().slice(0, 2)).toEqual([
        'Reply · llama3.2:3b: 2K in · 500 out · free · 400ms',
        'Reply · claude-opus-5-5: 2K in · 500 out · $0.0180 · 3.0s',
      ]);
    });

    it('leaves the note as it was when nothing was timed, and counts only the calls that were', async () => {
      await exchange('question', classifierUse, replyUse);
      expect(messages().at(-1)).toBe('note: Tokens: 2.1K in · 503 out · $0.0180');
      await exchange('another', classifierUse, took(2000));
      expect(messages().at(-1)).toBe('note: Tokens: 2.1K in · 503 out · $0.0180 · 2.0s');
    });

    describe("in a subagent's own tab", () => {
      const sub = (id: string, name: string) => emit(sentId(), { type: 'subagent', id, name, task: `do ${name}` });
      const open = async (index: number) => {
        $$<HTMLElement>('#messages .subagent .open')[index].click();
        await flush();
      };
      // ...without the clock that runs beside it, or on its own, while the subagent works
      const notes = () =>
        $$('#agent-view .message.note')
          .map((el) => el.textContent!.replace(/(^| · )[^·]*elapsed$/, ''))
          .filter((text) => text !== 'Working');

      it('is told beside its tokens, from the calls it made and no other', async () => {
        await type('do two things');
        sub('s1', 'tests');
        sub('s2', 'build');
        emit(sentId(), { ...took(1000, { purpose: 'subagent' }), subagent: 's1' });
        emit(sentId(), { ...took(3000, { purpose: 'subagent' }), subagent: 's1' });
        emit(sentId(), { ...took(500, { purpose: 'subagent' }), subagent: 's2' });
        await open(0);
        expect(notes()).toEqual(['Tokens: 4K in · 1K out · $0.0360 · 4.0s']);
        await open(1);
        expect(notes()).toEqual(['Tokens: 2K in · 500 out · $0.0180 · 500ms']);
      });

      it("is still counted in the thread's own, which has always had it", async () => {
        await type('do one thing');
        sub('s1', 'tests');
        emit(sentId(), { ...took(1000, { purpose: 'subagent' }), subagent: 's1' });
        expect(summary()).toBe('2.5K tokens · $0.0180 · 1.0s');
        expect(messages().at(-1)).toBe('note: Tokens: 2K in · 500 out · $0.0180 · 1.0s');
        // The subagent id is how the event is routed, not part of what is kept of the usage
        finish();
        const note = saved().threads[0].messages.find((m: { role: string; usage?: unknown }) => m.role === 'note');
        expect(note.usage[0]).not.toHaveProperty('subagent');
      });

      it('says nothing when the subagent has used nothing yet', async () => {
        await type('do one thing');
        sub('s1', 'tests');
        await open(0);
        expect(notes()).toEqual([]);
      });
    });
  });

  // ---- The count while a pass is still being written (see TokensEvent)
  //
  // A pass reports what it used when it ends. On a local model that is most of
  // a reply, so the pill and the note stood still for as long as the user was
  // actually waiting. The counts that arrive meanwhile are shown, and dropped
  // again the moment the pass says what it really used.
  describe('the count as a pass is written', () => {
    const sofar = (over: Record<string, unknown> = {}) => ({
      type: 'tokens' as const,
      purpose: 'reply' as const,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      input: 2000,
      output: 100,
      cost: 0.0036,
      ...over,
    });
    // The pill without the clock that runs beside it while a reply is going
    const pill = () => $('#thread-usage-summary').textContent!.replace(/(^| · )[^·]*elapsed$/, '');
    const tokenNote = () => messages().find((one) => one.startsWith('note: Tokens'));

    it('climbs as the count comes in, rather than waiting for the pass to end', async () => {
      await type('question');
      emit(sentId(), { type: 'text', delta: 'Answ' });
      emit(sentId(), sofar());
      expect(pill()).toBe('2.1K tokens · $0.0036');
      emit(sentId(), sofar({ output: 300, cost: 0.0054 }));
      // The second count replaces the first: each is the whole call so far
      expect(pill()).toBe('2.3K tokens · $0.0054');
    });

    it('gives way to what the pass really used, rather than being added to it', async () => {
      await type('question');
      emit(sentId(), sofar({ output: 300, cost: 0.0054 }));
      emit(sentId(), replyUse);
      expect(pill()).toBe('2.5K tokens · $0.0180');
    });

    it('counts the pass in flight on top of the passes that have finished', async () => {
      await type('question');
      emit(sentId(), replyUse);
      emit(sentId(), sofar({ input: 2500, output: 40, cost: 0.0045 }));
      expect(pill()).toBe('5K tokens · $0.0225');
    });

    it('leaves nothing behind in what the thread records: a climbing count is no record', async () => {
      await type('question');
      emit(sentId(), sofar());
      expect(pill()).toBe('2.1K tokens · $0.0036');
      // The reply ends without the pass ever reporting what it used
      finish();
      expect(pill()).toBe('');
      expect(saved().threads[0].usage ?? {}).toEqual({});
      expect(saved().daily ?? {}).toEqual({});
    });

    it('marks a figure nobody counted, and leaves a counted one unmarked', async () => {
      await type('question');
      emit(sentId(), sofar({ estimated: true }));
      expect(pill()).toBe('~2.1K tokens · ~$0.0036');
      emit(sentId(), sofar());
      expect(pill()).toBe('2.1K tokens · $0.0036');
    });

    it('leaves "free" as it is, free being free whether it was counted or reckoned', async () => {
      await type('question');
      emit(sentId(), sofar({ provider: 'local', model: 'llama3.2:3b', cost: 0, estimated: true }));
      expect(pill()).toBe('~2.1K tokens · free');
    });

    it('marks the model whose figures were reckoned, and not the one beside it', async () => {
      await type('question');
      emit(sentId(), classifierUse);
      emit(sentId(), sofar({ estimated: true }));
      expect(headerRows()).toEqual([
        'claude-opus-5-5: ~2K in · 100 out · $0.0036',
        'llama3.2:3b: 120 in · 3 out · free',
      ]);
    });

    it("says it in the request's note too, as what it has used so far", async () => {
      await type('question');
      emit(sentId(), { type: 'text', delta: 'Answer.' });
      emit(sentId(), sofar());
      expect(tokenNote()).toBe('note: Tokens so far: 2K in · 100 out · $0.0036');
      expect(noteLines()[0]).toBe('Reply · claude-opus-5-5: 2K in · 100 out · $0.0036');
      // ...and plainly again once the pass has said what it used
      emit(sentId(), replyUse);
      expect(tokenNote()).toBe('note: Tokens: 2K in · 500 out · $0.0180');
    });

    it('marks the note as well, where the figures in it were reckoned', async () => {
      await type('question');
      emit(sentId(), { type: 'text', delta: 'Answer.' });
      emit(sentId(), sofar({ estimated: true }));
      expect(tokenNote()).toBe('note: Tokens so far: ~2K in · 100 out · $0.0036');
      expect(noteLines()[0]).toBe('Reply · claude-opus-5-5: ~2K in · 100 out · $0.0036');
    });

    it("counts towards a subagent's own tab, from the call it is on", async () => {
      await type('do one thing');
      emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'do tests' });
      emit(sentId(), { ...sofar({ purpose: 'subagent' }), subagent: 's1' });
      $$<HTMLElement>('#messages .subagent .open')[0].click();
      await flush();
      // ...without the clock that runs beside it, as the pill has one
      expect($$('#agent-view .message.note').map((el) => el.textContent!.replace(/ · [^·]*elapsed$/, ''))).toEqual([
        'Tokens so far: 2K in · 100 out · $0.0036',
      ]);
      // ...and towards the thread's own, which waits on it
      expect(pill()).toBe('2.1K tokens · $0.0036');
    });

    it('drops what a subagent was reckoned to be using once it has finished', async () => {
      await type('do one thing');
      emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'do tests' });
      emit(sentId(), { ...sofar({ purpose: 'subagent' }), subagent: 's1' });
      expect(pill()).toBe('2.1K tokens · $0.0036');
      // It came back without its last call ever saying what it used
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Done.', isError: false });
      expect(pill()).toBe('');
    });
  });

  it('names condensing in the note, so its tokens are not mistaken for the reply', async () => {
    const condensing = { ...replyUse, purpose: 'compaction' as const, input: 800, output: 90, cost: 0.0034 };
    await exchange('question', replyUse, condensing);
    expect(noteLines()).toEqual([
      'Reply · claude-opus-5-5: 2K in · 500 out · $0.0180',
      'Condensing · claude-opus-5-5: 800 in · 90 out · $0.0034',
      'Context sent with each request: 1. Reply · claude-opus-5-5: 2K tokens\n' +
        '2. Condensing · claude-opus-5-5: 800 tokens',
    ]);
    expect(messages().at(-1)).toBe('note: Tokens: 2.8K in · 590 out · $0.0214');
  });

  describe('as sub-threads in the sidebar', () => {
    const rows = () => $$<HTMLElement>('#thread-list li.subagent').map((el) => el.textContent);
    // The arrow under the thread, which shows and hides its subagents
    const toggle = () => $<HTMLElement>('#thread-list li.thread-agents');
    const arrow = () => toggle().querySelector('.arrow')!.textContent;
    const sub = (id: string, name: string, task: string, kind = 'worker') =>
      emit(sentId(), { type: 'subagent', id, name, task, kind });
    // One piece of what a subagent did, as it reports it
    const did = (id: string, event: unknown) => emit(sentId(), { type: 'subagent_update', id, event });

    beforeEach(async () => {
      await type('do two things');
    });

    it('has no toggle on a thread that has sent none', () => {
      expect(toggle()).toBeNull();
      expect(rows()).toEqual([]);
    });

    it('hides them behind an arrow under the thread, and shows them indented when opened', () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'the build', 'read the build', 'explorer');
      // Hidden to begin with: a thread can have four at a time
      expect(rows()).toEqual([]);
      expect(arrow()).toBe('▸');
      // ...and says what is behind it, with work going on named first
      expect(toggle().textContent).toContain('2 subagents running');
      expect(toggle().title).toBe('Show the 2 subagents running');
      // The arrow is its own row, below the thread rather than on it
      const order = $$<HTMLElement>('#thread-list li').map((el) => el.className.split(' ')[0]);
      expect(order.slice(order.indexOf('thread'), order.indexOf('thread') + 2)).toEqual(['thread', 'agents']);

      toggle().click();
      expect(rows()).toEqual(['tests' + 'worker', 'the build' + 'explorer']);
      expect(arrow()).toBe('▾');
      expect(toggle().title).toBe('Hide the 2 subagents');
      // Open, it still says what is running: the rows below name the subagents
      // but do not count the work up
      expect(toggle().textContent).toContain('2 subagents running');
      // Each says what sort of subagent it is, and what it was given
      expect($$<HTMLElement>('#thread-list li.subagent')[0].title).toBe('read the tests');

      toggle().click();
      expect(rows()).toEqual([]);
    });

    it('counts what is running, and drops each one as it finishes', () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'build', 'read the build');
      expect(toggle().textContent).toContain('2 subagents running');
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Done.', isError: false });
      expect(toggle().textContent).toContain('1 subagent running');
      toggle().click();
      // The one that finished is history, and is read from the thread itself
      expect(rows()).toEqual(['build' + 'worker']);

      // Nothing left running: the whole list goes, arrow and all
      emit(sentId(), { type: 'subagent_done', id: 's2', text: 'Done.', isError: false });
      expect(toggle()).toBeNull();
      expect(rows()).toEqual([]);
    });

    it('says which of them failed, keeping those apart from the ones still running', () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'build', 'read the build');
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Ran out of room.', isError: true });
      expect(toggle().textContent).toContain('1 subagent running, 1 failed');
      expect(toggle().title).toBe('Show the 1 subagent running, 1 failed');
      // A mark is carried while they are hidden, and it is the work's
      expect($$('#thread-list li.thread-agents .status.working')).toHaveLength(1);

      emit(sentId(), { type: 'subagent_done', id: 's2', text: 'Ran out of room.', isError: true });
      // Nothing running now, so what is left is the failures
      expect(toggle().textContent).toContain('2 subagents failed');
      expect($$('#thread-list li.thread-agents .status.failed')).toHaveLength(1);
    });

    it('keeps a failed one after a restart, since it outlives the reply that sent it', async () => {
      sub('s1', 'tests', 'read the tests');
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Ran out of room.', isError: true });
      toggle().click();
      // ...with the two things that can be done about it (see "a failed one")
      expect(rows()).toEqual(['tests' + 'worker' + '↻×']);
      await start();
      expect(rows()).toEqual(['tests' + 'worker' + '↻×']);
    });

    describe('one that failed', () => {
      const row = () => $<HTMLElement>('#thread-list li.subagent');
      const mark = () => $<HTMLElement>('#thread-list li.subagent .status').className;
      // The thread the subagents were sent out from
      const threadId = () => saved().activeId as string;

      // In a workspace of its own: what is run again is run in the thread's
      // container, which is the one its workspace was copied into
      beforeEach(async () => {
        await newThread('/projects/demo');
        await type('do two things');
        sub('s1', 'tests', 'read the tests');
        did('s1', { type: 'thought', text: 'Reading them.' });
        emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Ran out of room.', isError: true });
        toggle().click();
      });

      it('is sent out again when asked, with its own work in place of what it did before', async () => {
        let finish!: (result: { text: string; isError: boolean }) => void;
        llm.retrySubagent.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
        $<HTMLElement>('#thread-list li.subagent .retry').click();
        await flush();

        expect(llm.retrySubagent).toHaveBeenCalledWith({
          thread: threadId(),
          workspace: '/projects/demo',
          id: 's1',
          name: 'tests',
          task: 'read the tests',
          kind: 'worker',
        });
        // It is working again, so there is nothing to retry or let go of
        expect(mark()).toBe('status working');
        expect($$('#thread-list li.subagent button')).toEqual([]);

        // What it says this time arrives on its own, as it works
        agentEvent(threadId(), 's1', { type: 'thought', text: 'Trying again.' });
        finish({ text: 'They use vitest.', isError: false });
        await flush();

        // Done, so it is off the list and read from the thread instead
        expect($$('#thread-list li.subagent')).toEqual([]);
        $<HTMLElement>('#messages .subagent .open').click();
        await flush();
        expect($('#agent-view').textContent).toContain('Trying again.');
        // Its old work is not left mixed in with the new
        expect($('#agent-view').textContent).not.toContain('Reading them.');
        expect($('#agent-view .message.assistant').textContent).toBe('They use vitest.');
      });

      it('stays on the list, with what went wrong, when running it again failed too', async () => {
        llm.retrySubagent.mockResolvedValue({ text: 'No models available.', isError: true });
        $<HTMLElement>('#thread-list li.subagent .retry').click();
        await flush();
        expect(mark()).toBe('status failed');
        expect($$('#thread-list li.subagent .retry')).toHaveLength(1);
        expect(saved().threads.flatMap((t: { messages: { finding?: string }[] }) => t.messages)).toContainEqual(
          expect.objectContaining({ finding: 'No models available.', failed: true })
        );
      });

      it('says so in place of a result when the retry could not be made at all', async () => {
        llm.retrySubagent.mockRejectedValue(new Error('Docker is not running.'));
        $<HTMLElement>('#thread-list li.subagent .retry').click();
        await flush();
        expect(mark()).toBe('status failed');
        $<HTMLElement>('#messages .subagent .open').click();
        await flush();
        expect($('#agent-view').textContent).toContain('Docker is not running.');
      });

      it('is sent out once however many times the row is clicked', async () => {
        llm.retrySubagent.mockImplementation(() => new Promise(() => {}));
        $<HTMLElement>('#thread-list li.subagent .retry').click();
        await flush();
        expect(row()).not.toBeNull();
        // Working now, so there is no retry button to click a second time
        expect($$('#thread-list li.subagent .retry')).toEqual([]);
        expect(llm.retrySubagent).toHaveBeenCalledTimes(1);
      });

      it('is taken off the list when the user is done with it, and stays in the thread', async () => {
        $<HTMLElement>('#thread-list li.subagent .delete').click();
        expect($$('#thread-list li.subagent')).toEqual([]);
        expect(toggle()).toBeNull();
        // Still in the thread, with what it did
        expect($$('#messages .subagent .open').map((el) => el.textContent)).toEqual([
          'Subagent: tests — did not finish',
        ]);
        $<HTMLElement>('#messages .subagent .open').click();
        await flush();
        expect($('#agent-view').textContent).toContain('Reading them.');
        // ...and it is still off the list after a restart
        await start();
        expect($$('#thread-list li.subagent')).toEqual([]);
      });

      it('takes no notice of work reported for a subagent or thread it does not know', () => {
        agentEvent('no-such-thread', 's1', { type: 'thought', text: 'nothing' });
        agentEvent(threadId(), 'no-such-agent', { type: 'thought', text: 'nothing' });
        expect(messages().join('\n')).not.toContain('nothing');
      });
    });

    it('marks one that is still working, and one that did not finish', () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'build', 'read the build');
      toggle().click();
      const marks = () => $$<HTMLElement>('#thread-list li.subagent .status').map((el) => el.className);
      expect(marks()).toEqual(['status working', 'status working']);

      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
      emit(sentId(), { type: 'subagent_done', id: 's2', text: 'Ran out of room.', isError: true });
      // One finished, so it is unmarked; the other did not and says so
      expect(marks()).toEqual(['status failed']);
      expect($<HTMLElement>('#thread-list li.subagent .status').title).toBe('Did not finish');
    });

    it('carries a working mark whether they are shown or hidden, so work is not missed', () => {
      sub('s1', 'tests', 'read the tests');
      const mark = () => $$('#thread-list li.thread-agents .status.working').length;
      expect(mark()).toBe(1);

      // Still there once they are shown, beside the mark on each subagent
      toggle().click();
      expect(mark()).toBe(1);
      expect($$('#thread-list li.subagent .status.working').length).toBe(1);

      toggle().click();
      // Nothing running: the row says so, and the mark goes
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Done.', isError: false });
      expect(mark()).toBe(0);
    });

    it('forgets whether they were shown once the thread is deleted', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      expect(saved().opened).toHaveLength(1);
      await newThread(null);
      await flush();
      // The one that has the subagents, whichever row it is now in
      const mine = saved().opened[0] as string;
      // Its reply has to be over first: a thread being written into is not
      // deleted (see "will not delete a thread that is being written into"),
      // and the row is found after that, the list having been drawn again
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      const row = $$<HTMLElement>('#thread-list li.thread').find((el) =>
        el.nextElementSibling?.classList.contains('agents')
      )!;
      row.querySelector<HTMLElement>('.delete')!.click();
      await flush();
      expect(saved().opened).toEqual([]);
      expect(saved().threads.map((t: { id: string }) => t.id)).not.toContain(mine);
    });

    it('opens the subagent in a tab on its thread when its row is clicked', async () => {
      sub('s1', 'tests', 'read the tests');
      did('s1', { type: 'thought', text: 'Reading them.' });
      did('s1', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.test.ts' } });
      did('s1', { type: 'tool_result', id: 'c1', name: 'read_file', output: '1: import { it }', isError: false });
      toggle().click();

      // No tabs until something is opened in one
      expect($<HTMLElement>('#tabs').hidden).toBe(true);
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();

      // The thread keeps its own tab, and the subagent gets one beside it
      expect($<HTMLElement>('#tabs').hidden).toBe(false);
      expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'tests']);
      expect($$('#tabs .tab')[1].className).toContain('active');
      // The thread's messages give way to the subagent's
      expect($<HTMLElement>('#messages').hidden).toBe(true);
      expect($<HTMLElement>('#agent-view').hidden).toBe(false);
    });

    it('says what the piece was rated and which model is doing it, as the thread is told of its reply', async () => {
      emit(sentId(), {
        type: 'subagent',
        id: 's1',
        name: 'tests',
        task: 'read the tests',
        kind: 'explorer',
        complexity: 2,
        effort: 'low',
        model: 'haiku',
      });
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      // Above its work, as the note above a reply in a thread
      // (and the clock that runs while it works, which is not what is being said here)
      expect($$('#agent-view .message').map((el) => el.textContent)).toEqual([
        "Explorer's Goalread the tests",
        'explorer · 2/5 Complexity · low effort · haiku',
        'Working · 0s elapsed',
        'Working…',
      ]);
    });

    it('fills a ring on its tab as it says how much of its piece is left', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      // Nothing said yet, so the dot pulses as it did before
      expect($<HTMLElement>('#tabs .tab .status').className).toContain('working');

      did('s1', { type: 'progress', percent: 40 });
      await flush();
      const ring = $<SVGElement>('#tabs .tab .status.ring');
      expect(ring.getAttribute('aria-label')).toBe('40% done');
      // Filled four tenths of the way round, measured in the circumference
      const [drawn] = String($<SVGElement>('#tabs .tab .status.ring .done').getAttribute('stroke-dasharray')).split(
        ' '
      );
      expect(Number(drawn) / (2 * Math.PI * 4.5)).toBeCloseTo(0.4);
      // ...and the estimate is a status, not a line of its work
      expect($('#agent-view').textContent).not.toContain('40');

      // A later estimate replaces it rather than adding to it
      did('s1', { type: 'progress', percent: 90 });
      await flush();
      expect($<SVGElement>('#tabs .tab .status.ring').getAttribute('aria-label')).toBe('90% done');
    });

    it('marks a finished subagent done, and one whose report was cut as neither done nor failed', async () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'docs', 'read the docs');
      toggle().click();
      for (const row of $$<HTMLElement>('#thread-list li.subagent')) row.click();
      await flush();

      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
      emit(sentId(), { type: 'subagent_done', id: 's2', text: 'There are some.', isError: false, cut: true });
      await flush();
      const classes = $$<HTMLElement>('#tabs .tab .status').map((el) => el.className);
      expect(classes).toEqual(['status done', 'status cut']);
      expect($$<HTMLElement>('#tabs .tab .status')[1].title).toContain('too long');
    });

    it('offers no message box while a subagent’s tab is the one showing', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      expect($<HTMLElement>('#composer').hidden).toBe(true);
      // ...and gives it back on the thread's own tab, where there is someone
      // to write to
      $$<HTMLElement>('#tabs .tab')[0].click();
      await flush();
      expect($<HTMLElement>('#composer').hidden).toBe(false);
    });

    it('marks the task a subagent was given as the app’s asking, not the user’s', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      expect($<HTMLElement>('#agent-view .message.user').className).toContain('system');
    });

    it('reads as the thread reads: what it was asked, its thoughts, its tools, its answer', async () => {
      sub('s1', 'tests', 'read the tests');
      did('s1', { type: 'thought', text: 'Reading them.' });
      did('s1', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.test.ts' } });
      did('s1', { type: 'tool_result', id: 'c1', name: 'read_file', output: '1: import { it }', isError: false });
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
      // Finished, so it is off the list under the thread and read from the
      // thread itself, where its work is written
      $<HTMLElement>('#messages .subagent .open').click();
      await flush();

      const rows = () => $$<HTMLElement>('#agent-view .message').map((el) => el.className.split(' ')[1]);
      expect(rows()).toEqual(['user', 'work', 'thought', 'tool', 'assistant']);
      const view = () => $('#agent-view').textContent ?? '';
      // What it was given, as the message that set it going
      // Captioned with whose goal it is: nobody in the conversation typed it
      expect($('#agent-view .message.user .caption').textContent).toBe("Worker's Goal");
      expect($('#agent-view .message.user').textContent).toBe("Worker's Goalread the tests");
      // Its thought, and its tool call with what the tool gave back
      expect(view()).toContain('Reading them.');
      expect(view()).toContain('Read a.test.ts');
      $<HTMLElement>('#agent-view .message.tool summary').click();
      expect($('#agent-view .message.tool').textContent).toContain('1: import { it }');
      // ...and its report as the reply
      expect($('#agent-view .message.assistant').textContent).toBe('They use vitest.');
    });

    it('fills in while it works, and says so when it is still going', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      // Still working: the reply it will give is waited for, as a thread's is
      expect($$('#agent-view .message.work summary .waiting')).toHaveLength(1);

      did('s1', { type: 'thought', text: 'Half way.' });
      expect($('#agent-view').textContent).toContain('Half way.');
      did('s1', { type: 'condensing' });
      expect($('#agent-view').textContent).toContain('Condensing what it has found');

      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
      expect($$('#agent-view .message.work summary .waiting')).toHaveLength(0);
      expect($('#agent-view .message.assistant').textContent).toBe('They use vitest.');
    });

    // Subagents of one thread take turns at a local model rather than a round
    // each (see src/llm/cachelock.ts), so one that has written nothing yet is
    // waiting for the model and not stuck
    it('says when it is waiting its turn for the model, and takes it back when the turn comes', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();

      did('s1', { type: 'queued', model: 'qwen3.5:9b' });
      expect($('#agent-view').textContent).toContain('Waiting its turn for qwen3.5:9b');

      did('s1', { type: 'waited', ms: 9000 });
      expect($('#agent-view').textContent).not.toContain('Waiting its turn');
    });

    it('turns the note that it is condensing into one that it did, which stays in its work', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();

      did('s1', { type: 'condensing' });
      did('s1', { type: 'thought', text: 'Carrying on.' });
      did('s1', { type: 'condensed', changed: true });
      expect($('#agent-view').textContent).not.toContain('Condensing what it has found');
      expect($('#agent-view').textContent).toContain('Context condensed');
      // ...where it was, with the work that followed below it
      const roles = $$('#agent-view .message').map((m) => m.textContent);
      expect(roles.findIndex((t) => t?.includes('Context condensed'))).toBeLessThan(
        roles.findIndex((t) => t?.includes('Carrying on.'))
      );
    });

    it('takes the note that it is condensing away when nothing came of it', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();

      did('s1', { type: 'condensing' });
      did('s1', { type: 'condensed', changed: false });
      expect($('#agent-view').textContent).not.toContain('Condensing');
      expect($('#agent-view').textContent).not.toContain('Context condensed');
    });

    it('shows one that did not finish as an error, as a thread would', async () => {
      sub('s1', 'tests', 'read the tests');
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Ran out of room.', isError: true });
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      expect($('#agent-view .message.error').textContent).toBe('Ran out of room.');
    });

    it('goes back to the thread itself when its row in the sidebar is clicked', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      expect($<HTMLElement>('#agent-view').hidden).toBe(false);

      // The row stands for the thread, not for whatever was last open on it
      $<HTMLElement>('#thread-list li.thread .name').click();
      await flush();
      expect($<HTMLElement>('#messages').hidden).toBe(false);
      expect($<HTMLElement>('#agent-view').hidden).toBe(true);
      expect($$('#tabs .tab')[0].className).toContain('active');
      // ...and the subagent's tab is still there to go back to
      expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'tests']);
    });

    it('keeps a tab per subagent, switches between them, and closes them', async () => {
      sub('s1', 'tests', 'read the tests');
      sub('s2', 'build', 'read the build');
      toggle().click();
      const rows = () => $$<HTMLElement>('#thread-list li.subagent');
      rows()[0].click();
      await flush();
      rows()[1].click();
      await flush();
      expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'tests', 'build']);
      expect($$('#tabs .tab')[2].className).toContain('active');

      // Back to the thread itself
      $$<HTMLElement>('#tabs .tab')[0].click();
      expect($<HTMLElement>('#messages').hidden).toBe(false);
      expect($<HTMLElement>('#agent-view').hidden).toBe(true);
      expect($$('#tabs .tab')[0].className).toContain('active');

      // Closing the one on screen goes back to the thread; closing the last
      // takes the tabs away
      $$<HTMLElement>('#tabs .tab')[1].click();
      $$<HTMLElement>('#tabs .tab')[1].querySelector<HTMLElement>('.shut')!.click();
      expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'build']);
      expect($<HTMLElement>('#messages').hidden).toBe(false);
      $$<HTMLElement>('#tabs .tab')[1].querySelector<HTMLElement>('.shut')!.click();
      expect($<HTMLElement>('#tabs').hidden).toBe(true);
    });

    it('says on the tab how the subagent is doing, without opening it', async () => {
      sub('s1', 'tests', 'read the tests');
      toggle().click();
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      const mark = () => $<HTMLElement>('#tabs .tab:last-child .status').className;
      expect(mark()).toContain('working');
      emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Done.', isError: false });
      expect(mark()).toContain('done');
    });

    it('is started again by an app that closed mid-run, from the top', async () => {
      sub('s1', 'tests', 'read the tests');
      did('s1', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      llm.retrySubagent.mockImplementation(() => new Promise(() => {}));
      await start();
      expect(llm.retrySubagent).toHaveBeenCalledTimes(1);
      expect(llm.retrySubagent).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1', name: 'tests', task: 'read the tests', kind: 'worker' })
      );
      toggle().click();
      expect($$<HTMLElement>('#thread-list li.subagent .status').map((el) => el.className)).toEqual(['status working']);
    });

    it('says what a subagent started again brought back, in the thread', async () => {
      sub('s1', 'tests', 'read the tests');
      llm.retrySubagent.mockResolvedValue({ text: 'They use vitest.', isError: false });
      await start();
      await flush();
      $<HTMLElement>('#messages .subagent .open').click();
      await flush();
      expect($('#agent-view .message.assistant').textContent).toBe('They use vitest.');
    });

    it('is told to the reply picked up with it that it was started again', async () => {
      sub('s1', 'tests', 'read the tests');
      llm.retrySubagent.mockImplementation(() => new Promise(() => {}));
      await start();
      const [line] = sent().resumed!.did;
      expect(line).toContain('subagent tests (worker)');
      expect(line).toContain('started again');
    });

    it('is failed rather than started again a second time that the app closes on it', async () => {
      sub('s1', 'tests', 'read the tests');
      did('s1', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      llm.retrySubagent.mockImplementation(() => new Promise(() => {}));
      await start();
      await start();
      expect(llm.retrySubagent).toHaveBeenCalledTimes(1);
      toggle().click();
      expect($$<HTMLElement>('#thread-list li.subagent .status').map((el) => el.className)).toEqual(['status failed']);
      $<HTMLElement>('#thread-list li.subagent').click();
      await flush();
      expect($('#agent-view .message.error').textContent).toBe('The app closed before this finished.');
    });
  });

  // Several handed out at once take the model in turn rather than a round each
  // (see src/llm/cachelock.ts): the ones not writing are waiting, and a row
  // that said "working" of all of them said nothing of which was which
  it('says on a subagent that is waiting its turn which model it is waiting for', async () => {
    await type('do two things');
    const sub = (id: string, name: string, task: string) => emit(sentId(), { type: 'subagent', id, name, task });
    const did = (id: string, event: unknown) => emit(sentId(), { type: 'subagent_update', id, event });
    const labels = () => $$('#messages .subagent .open').map((el) => el.textContent);

    sub('s1', 'tests', 'read the tests');
    sub('s2', 'build', 'read the build');
    did('s2', { type: 'queued', model: 'qwen3.5:9b' });
    expect(labels()).toEqual(['Subagent: tests — working…', 'Subagent: build — waiting its turn for qwen3.5:9b…']);

    did('s2', { type: 'waited', ms: 9000 });
    expect(labels()).toEqual(['Subagent: tests — working…', 'Subagent: build — working…']);
  });

  it('shows each subagent as a line that opens it, not as a dropdown of its work', async () => {
    await type('do two things');
    const sub = (id: string, name: string, task: string) => emit(sentId(), { type: 'subagent', id, name, task });

    sub('s1', 'tests', 'read the tests');
    sub('s2', 'build', 'read the build');
    const labels = () => $$('#messages .subagent .open').map((el) => el.textContent);
    expect(labels()).toEqual(['Subagent: tests — working…', 'Subagent: build — working…']);
    // Its work is a view of its own, not folded into the middle of the reply
    expect($$('#messages .subagent details')).toHaveLength(0);

    emit(sentId(), { type: 'subagent_update', id: 's1', event: { type: 'thought', text: 'Reading them.' } });
    emit(sentId(), { type: 'subagent_done', id: 's1', text: 'The tests use vitest.', isError: false });
    emit(sentId(), { type: 'subagent_done', id: 's2', text: 'Ran out of room.', isError: true });
    expect(labels()).toEqual(['Subagent: tests', 'Subagent: build — did not finish']);

    // The reply that waited for them carries on below
    emit(sentId(), { type: 'text', delta: 'Both done.' });
    finish();
    expect(messages()).toEqual([
      'user: do two things',
      'subagent: Subagent: tests',
      'subagent: Subagent: build — did not finish',
      'assistant: Both done.',
    ]);

    // ...and clicking one opens it in a tab of its own on this thread
    $$<HTMLElement>('#messages .subagent .open')[0].click();
    await flush();
    expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'tests']);
    expect($('#agent-view').textContent).toContain('Reading them.');
    expect($('#agent-view .message.assistant').textContent).toBe('The tests use vitest.');
  });

  it('says it is waiting on its subagents instead of pulsing as though words were coming', async () => {
    await type('do two things');
    const sub = (id: string, name: string) => emit(sentId(), { type: 'subagent', id, name, task: 'read it' });
    const dots = () => $$('#messages .message.work summary .waiting');

    // Before any are set to work, the reply is simply on its way
    emit(sentId(), { type: 'model', provider: 'local', model: 'm', name: 'm', sophistication: 3, reason: 'picked' });
    expect(dots()).toHaveLength(1);

    sub('s1', 'tests');
    expect(messages().at(-1)).toBe('note: Waiting on 1 subagent…');
    expect(dots()).toHaveLength(0);
    sub('s2', 'build');
    expect(messages().at(-1)).toBe('note: Waiting on 2 subagents…');

    emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
    expect(messages().at(-1)).toBe('note: Waiting on 1 subagent…');

    // The last of them hands the reply back its words
    emit(sentId(), { type: 'subagent_done', id: 's2', text: 'Done.', isError: false });
    expect(messages().at(-1)).toBe('work: Working…');
    expect(dots()).toHaveLength(1);
    emit(sentId(), { type: 'text', delta: 'Both done.' });
    expect(messages().at(-1)).toBe('assistant: Both done.');
  });

  it('ignores subagent news for a reply this window never saw the start of', async () => {
    await type('question');
    emit(sentId(), { type: 'subagent_update', id: 'unknown', event: { type: 'thought', text: 'something' } });
    emit(sentId(), { type: 'subagent_done', id: 'unknown', text: 'x', isError: false });
    expect($$('#messages .subagent')).toHaveLength(0);
  });

  it('keeps a running total for the thread in the header, by model', async () => {
    await exchange('one', classifierUse, replyUse);
    await exchange('two', classifierUse, replyUse);
    expect(header().hidden).toBe(false);
    expect($('#thread-usage-summary').textContent).toBe('5.2K tokens · $0.0360');
    expect(headerRows()).toEqual(['claude-opus-5-5: 4K in · 1K out · $0.0360', 'llama3.2:3b: 240 in · 6 out · free']);
  });

  it("keeps each thread's total to itself, and remembers it after a restart", async () => {
    await exchange('one', replyUse);
    await newThread(null);
    expect(header().hidden).toBe(true);

    await start();
    $$('#thread-list li.thread')[1].click();
    expect($('#thread-usage-summary').textContent).toBe('2.5K tokens · $0.0180');
    expect(saved().threads[1].usage['anthropic/claude-opus-5-5']).toMatchObject({
      input: 2000,
      output: 500,
      cost: 0.018,
    });
  });

  it('still counts the tokens of a reply that was retried or deleted', async () => {
    await exchange('one', replyUse);
    const rightClick = (text: string) =>
      $$('#messages .message')[messages().indexOf(text)].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    rightClick('assistant: Answer.');
    $('#menu-retry').click();
    await flush();
    emit(sentId(), { type: 'text', delta: 'Better answer.' });
    emit(sentId(), replyUse);
    finish();
    // The first attempt's note went with its reply, but its tokens were still spent
    expect(messages()).toEqual(['user: one', 'assistant: Better answer.', 'note: Tokens: 2K in · 500 out · $0.0180']);
    expect($('#thread-usage-summary').textContent).toBe('5K tokens · $0.0360');
  });

  it('does not send the token notes to the model', async () => {
    await exchange('one', replyUse);
    await type('two');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'two' },
    ]);
  });
});

describe('summarizing an idle thread: token use', () => {
  it("counts a summary's tokens toward the thread", async () => {
    vi.useFakeTimers();
    try {
      const started = start();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      llm.summarize.mockResolvedValue({
        text: 'Summary.',
        usage: {
          purpose: 'summary',
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          input: 3000,
          output: 200,
          cost: 0.008,
        },
      });
      for (const question of ['a', 'b']) {
        $<HTMLTextAreaElement>('#input').value = question;
        $<HTMLFormElement>('#composer').requestSubmit();
        await vi.advanceTimersByTimeAsync(0);
        emit(sentId(), { type: 'text', delta: 'Answer.' });
        emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      }
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect($('#thread-usage-summary').textContent).toBe('3.2K tokens · $0.0080');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the token usage page', () => {
  // The renderer's own day key (see dayKey), worked out the same way here so
  // that a test is not pinned to the day it was written on
  const day = (back = 0) => {
    const on = new Date();
    on.setDate(on.getDate() - back);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${on.getFullYear()}-${pad(on.getMonth() + 1)}-${pad(on.getDate())}`;
  };
  // One model's total for a day, as the record keeps it. A cost of null is
  // one that is not known.
  const spent = (provider: string, model: string, input: number, output: number, cost: number | null) => ({
    [`${provider}/${model}`]: {
      provider,
      model,
      input,
      output,
      cost: cost ?? 0,
      ...(cost === null ? { unpriced: true } : {}),
    },
  });
  const anthropicUse = {
    type: 'usage' as const,
    purpose: 'reply' as const,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    input: 2000,
    output: 500,
    cost: 0.018,
  };
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

  // A window opened on a record of what the given days were spent on
  const withDaily = async (
    daily: Record<string, object>,
    threads: object[] = [],
    dailyPurpose?: Record<string, object>
  ) => {
    onDisk = JSON.stringify({
      threads: [{ id: 't1', title: 'One', messages: [], ...threads[0] }],
      activeId: 't1',
      daily,
      ...(dailyPurpose ? { dailyPurpose } : {}),
    });
    await start();
    $('#open-usage').click();
  };

  const open = () => $<HTMLDialogElement>('#usage').open;
  const tiles = () =>
    $$('#usage-tiles .usage-tile').map(
      (tile) => `${tile.querySelector('.label')!.textContent}: ${tile.querySelector('.figure')!.textContent}`
    );
  // The breakdown's lines: a provider's own row, then a row per model under it
  const breakdown = () =>
    $$('#usage-breakdown tbody tr').map((row) => [...row.children].map((cell) => cell.textContent).join(' | '));
  // The purposes' lines: what each model was asked to do, subagent kinds under their row
  const purposes = () =>
    $$('#usage-purpose tbody tr').map((row) => [...row.children].map((cell) => cell.textContent).join(' | '));
  const days = () => $$('#usage-days .usage-day > summary').map((summary) => summary.textContent);
  const dayModels = () =>
    $$('#usage-days .usage-day .label').map(
      (label) => `${label.textContent}: ${label.nextElementSibling!.textContent}`
    );
  const columns = () => $$('#usage-chart .chart-col');
  // Counted back from today, which is the last column whatever the range
  const column = (back: number) => columns()[columns().length - 1 - back];
  const bars = () => columns().map((each) => each.querySelectorAll('.seg').length);
  const quietBefore = (days: number) =>
    bars()
      .slice(0, -days)
      .every((n) => n === 0);
  const axis = () => $$('#usage-chart .chart-y small').map((tick) => tick.textContent);
  const legend = () => $$('#usage-legend span').map((entry) => entry.textContent);
  const ranges = () => $$('#usage-range button');
  const hueOf = (el: Element) => Number((el as HTMLElement).style.getPropertyValue('--series-hue'));
  const shiftOf = (el: Element) => Number((el as HTMLElement).style.getPropertyValue('--series-shift'));

  it('says in the title bar what the last 30 days cost, cut off at the cent', async () => {
    await withDaily({
      [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.019),
      [day(29)]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 1.239),
      [day(30)]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 50),
    });
    expect($('#titlebar #cost-30d').textContent).toBe('Last 30 days: $1.25');
  });

  it('says free when nothing was spent in the last 30 days', async () => {
    await withDaily({ [day(30)]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 5) });
    expect($('#cost-30d').textContent).toBe('Last 30 days: free');
  });

  it('updates the title bar as a reply is paid for', async () => {
    await type('question');
    expect($('#cost-30d').textContent).toBe('Last 30 days: free');
    emit(sentId(), { ...anthropicUse, cost: 0.018 });
    finish();
    expect($('#cost-30d').textContent).toBe('Last 30 days: $0.01');
  });

  it('opens from the sidebar and is closed again by its own button', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) });
    expect(open()).toBe(true);
    $('#usage-close').click();
    expect(open()).toBe(false);
  });

  it('counts what a reply used against today, and still has it after a restart', async () => {
    await type('question');
    emit(sentId(), anthropicUse);
    finish();
    expect(saved().daily[day()]['anthropic/claude-opus-5-5']).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      input: 2000,
      output: 500,
      cost: 0.018,
    });

    await start();
    $('#open-usage').click();
    expect(tiles()).toEqual(['Spent: $0.0180', 'A day: $0.0026', 'Tokens in: 2K', 'Tokens out: 500']);
  });

  it('counts every thread, and not just the one on screen', async () => {
    const half = { ...anthropicUse, input: 1000, output: 100, cost: 0.009 };
    await type('one');
    emit(sentId(), half);
    finish();
    await newThread(null);
    await type('two');
    emit(sentId(), half);
    finish();

    // The header holds the thread's own half; the page holds both halves
    expect($('#thread-usage-summary').textContent).toBe('1.1K tokens · $0.0090');
    $('#open-usage').click();
    expect(tiles()).toContain('Spent: $0.0180');
    expect(tiles()).toContain('Tokens in: 2K');
  });

  it('breaks the range down by provider, and by model under it', async () => {
    await withDaily({
      [day()]: {
        ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
        ...spent('anthropic', 'claude-haiku-4-5', 400, 40, 0.0006),
        ...spent('local', 'llama3.2:3b', 900, 60, 0),
      },
    });
    expect(breakdown()).toEqual([
      'Anthropic | 2.4K | — | 540 | $0.0186',
      'claude-opus-5-5 | 2K | — | 500 | $0.0180',
      'claude-haiku-4-5 | 400 | — | 40 | $0.0006',
      'Local | 900 | — | 60 | free',
      'llama3.2:3b | 900 | — | 60 | free',
    ]);
  });

  it('switches the breakdown between the models and what they were asked to do', async () => {
    await withDaily(
      {
        [day()]: {
          ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
          ...spent('anthropic', 'claude-haiku-4-5', 400, 40, 0.0006),
        },
      },
      [],
      {
        [day()]: {
          reply: { input: 2400, output: 540, cost: 0.0186 },
          planning: { input: 40, output: 40, cost: 0.0006 },
        },
      }
    );

    // The models to begin with, so the purpose section is put away
    expect($('#usage-breakdown-section').hidden).toBe(false);
    expect($('#usage-purpose-section').hidden).toBe(true);
    expect($$('#usage-breakdown-view button').map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    // The chart and its legend read the same way: one segment per model
    expect(legend()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
    expect(bars().at(-1)).toBe(2);

    $$('#usage-breakdown-view button')[1].click();
    expect($('#usage-breakdown-section').hidden).toBe(true);
    expect($('#usage-purpose-section').hidden).toBe(false);
    expect($$('#usage-breakdown-view button').map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    // The chart follows the toggle: the segments and legend are now the purposes
    expect(legend()).toEqual(['Planning', 'Reply']);
    expect(bars().at(-1)).toBe(2);

    $$('#usage-breakdown-view button')[0].click();
    expect($('#usage-breakdown-section').hidden).toBe(false);
    expect($('#usage-purpose-section').hidden).toBe(true);
    // And back to the models
    expect(legend()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
  });

  it('takes a series off the chart from its colour box, and singles another out from its name', async () => {
    await withDaily(
      {
        [day()]: {
          ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
          ...spent('anthropic', 'claude-haiku-4-5', 400, 40, 0.0006),
          ...spent('local', 'llama3.2:3b', 900, 60, 0.001),
        },
      },
      [],
      {
        [day()]: {
          reply: { input: 2000, output: 500, cost: 0.018 },
          planning: { input: 400, output: 40, cost: 0.0006 },
          subagent: { input: 900, output: 60, cost: 0.001 },
        },
      }
    );

    // Each legend entry has its colour box and its name, each the way to act on the series.
    const entry = (label: string) =>
      $$<HTMLElement>('#usage-legend .legend-item').find((e) => e.textContent === label)!;
    const swatch = (label: string) => entry(label).querySelector('.legend-swatch')!;
    const nameBtn = (label: string) => entry(label).querySelector('.legend-name')!;
    const isOff = (label: string) => entry(label).classList.contains('is-off');
    const isSolo = (label: string) => entry(label).classList.contains('is-solo');
    // The last column, whichever range it is
    const lastColumn = () => $$('#usage-chart .chart-col')[$$('#usage-chart .chart-col').length - 1]!;

    expect(legend()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5', 'llama3.2:3b']);
    expect(bars().at(-1)).toBe(3);

    // The colour box on a name takes that series off, and the chart is rescaled to the rest.
    swatch('llama3.2:3b').click();
    expect(isOff('llama3.2:3b')).toBe(true);
    expect(bars().at(-1)).toBe(2);
    expect(legend()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5', 'llama3.2:3b']);
    // Its box is the way to bring it back
    swatch('llama3.2:3b').click();
    expect(isOff('llama3.2:3b')).toBe(false);
    expect(bars().at(-1)).toBe(3);

    // The name on a series singles it out to its own, off the colour box of the others.
    nameBtn('claude-opus-5-5').click();
    expect(isSolo('claude-opus-5-5')).toBe(true);
    expect(bars().at(-1)).toBe(1);
    expect(lastColumn().querySelectorAll('.seg')).toHaveLength(1);
    // The same name again lets the rest back on
    nameBtn('claude-opus-5-5').click();
    expect(isSolo('claude-opus-5-5')).toBe(false);
    expect(bars().at(-1)).toBe(3);

    // The last series is not taken off: a chart of nothing tells nothing
    swatch('claude-haiku-4-5').click();
    swatch('claude-opus-5-5').click();
    // Two off, one on: the last one on will not come off, either
    expect(bars().at(-1)).toBe(1);
    expect(isOff('claude-haiku-4-5')).toBe(true);
    swatch('llama3.2:3b').click();
    expect(bars().at(-1)).toBe(1);
    expect(isOff('llama3.2:3b')).toBe(false);

    // A choice reading the models does not reach in and change the purposes
    $$('#usage-breakdown-view button')[1].click();
    expect(legend()).toEqual(['Planning', 'Reply', 'Subagent']);
    expect(bars().at(-1)).toBe(3);
    $$('#usage-breakdown-view button')[0].click();
    expect(isOff('claude-haiku-4-5')).toBe(true);
    expect(bars().at(-1)).toBe(1);
  });

  it('breaks the range down by what the models were asked to do', async () => {
    await type('question');
    emit(sentId(), anthropicUse);
    finish();
    await start();
    $('#open-usage').click();
    expect(purposes()).toEqual(['Reply | 2K | — | 500 | $0.0180']);
  });

  it('takes the cached share off what a purpose sent, as the models table does', async () => {
    await type('question');
    emit(sentId(), { ...anthropicUse, cacheRead: 1500, cost: 0.0043 });
    finish();
    await start();
    $('#open-usage').click();
    expect(purposes()).toEqual(['Reply | 500 | 1.5K | 500 | $0.0043']);
  });

  it('puts the kinds of subagent under the Subagent row', async () => {
    await type('question');
    emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests', kind: 'explorer' });
    emit(sentId(), { ...anthropicUse, purpose: 'subagent', subagent: 's1' });
    finish();
    await start();
    $('#open-usage').click();
    expect(purposes()).toEqual(['Subagent | 2K | — | 500 | $0.0180', '↳ explorer | 2K | — | 500 | $0.0180']);
  });

  it('calls a verification pass a review', async () => {
    await type('question');
    emit(sentId(), { ...anthropicUse, purpose: 'verification' });
    finish();
    await start();
    $('#open-usage').click();
    expect(purposes()).toEqual(['Review | 2K | — | 500 | $0.0180']);
  });

  it('owns up to the usage from before purposes were recorded, so the totals reconcile', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) });
    expect(purposes()).toEqual(['Earlier (purpose not recorded) | 2K | — | 500 | $0.0180']);
  });

  it('gives the cached share a tile of its own, and says what part of the input it was', async () => {
    await withDaily({
      [day()]: {
        'anthropic/claude-opus-5-5': {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          input: 2000,
          output: 500,
          cacheRead: 1500,
          cacheWrite: 200,
          cost: 0.0043,
        },
      },
    });
    expect(tiles()).toContain('Tokens in: 500');
    expect(tiles()).toContain('Cached: 1.5K');
    expect($$('#usage-tiles .usage-tile').map((t) => t.querySelector('small')!.textContent)).toContain(
      '75% of what went in'
    );
  });

  it('has no cached tile where nothing was cached, rather than a nought', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) });
    expect(tiles().some((tile) => tile.startsWith('Cached:'))).toBe(false);
  });

  it('breaks the cached share down by model, beside what went in', async () => {
    await withDaily({
      [day()]: {
        'anthropic/claude-opus-5-5': {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          input: 2000,
          output: 500,
          cacheRead: 1500,
          cost: 0.0043,
        },
        ...spent('local', 'llama3.2:3b', 900, 60, 0),
      },
    });
    expect(breakdown()).toEqual([
      // In is what was not cached, as the tiles have it, so In + Cached is the 2K
      'Anthropic | 500 | 1.5K | 500 | $0.0043',
      'claude-opus-5-5 | 500 | 1.5K | 500 | $0.0043',
      // The local models say nothing about caching, which is not the same as
      // having cached nothing
      'Local | 900 | — | 60 | free',
      'llama3.2:3b | 900 | — | 60 | free',
    ]);
  });

  it('lists every day that was used, newest first, with the models it went to', async () => {
    await withDaily({
      [day(2)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.009),
      [day()]: spent('local', 'llama3.2:3b', 500, 50, 0),
    });
    const [today, before] = days();
    expect(today).toContain('500 in · 50 out · free');
    expect(before).toContain('1K in · 100 out · $0.0090');
    expect(dayModels()).toEqual([
      'Local · llama3.2:3b: 500 in · 50 out · free',
      'Anthropic · claude-opus-5-5: 1K in · 100 out · $0.0090',
    ]);
  });

  it('says so when part of a cost is not known, rather than passing off the rest as the whole', async () => {
    await withDaily({
      [day()]: {
        ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
        ...spent('anthropic', 'claude-next', 100, 10, null),
      },
    });
    expect(tiles()[0]).toBe('Spent: $0.0180 + unknown');
    expect(breakdown()).toEqual([
      'Anthropic | 2.1K | — | 510 | $0.0180 + unknown',
      'claude-opus-5-5 | 2K | — | 500 | $0.0180',
      'claude-next | 100 | — | 10 | cost unknown',
    ]);
  });

  it('gives the chart a column per day in the range, the quiet ones included', async () => {
    await withDaily({
      [day(3)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.009),
      [day()]: spent('openai', 'gpt-6-sol', 500, 50, 0.002),
    });
    // The whole range, with bars on the two days that have anything on them
    expect(columns()).toHaveLength(7);
    expect(bars().slice(-4)).toEqual([1, 0, 0, 1]);
    expect(quietBefore(4)).toBe(true);
    // Two models, so which colour is which is spelled out, each with a colour of its own
    expect(legend()).toEqual(['claude-opus-5-5', 'gpt-6-sol']);
    expect($$('#usage-chart .seg').map((seg) => seg.className)).toEqual(['seg', 'seg']);
    const [first, second] = $$('#usage-chart .seg').map(hueOf);
    expect(first).not.toBe(second);
  });

  it("colours a provider's models alike but not the same, and each provider differently", async () => {
    await withDaily({
      [day()]: {
        ...spent('anthropic', 'claude-haiku-5', 100, 10, 0.001),
        ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
        ...spent('openai', 'gpt-6-sol', 500, 50, 0.002),
      },
    });
    const [haiku, opus, gpt] = $$('#usage-chart .seg');
    // Related models sit close in hue but are told apart by lightness
    expect(Math.abs(hueOf(haiku!) - hueOf(opus!))).toBeLessThanOrEqual(40);
    expect(`${hueOf(haiku!)}/${shiftOf(haiku!)}`).not.toBe(`${hueOf(opus!)}/${shiftOf(opus!)}`);
    // A different provider is a different family altogether
    expect(Math.abs(hueOf(gpt!) - hueOf(opus!))).toBeGreaterThan(40);
    // The legend's swatches are the chart's colours
    const swatches = $$('#usage-legend i').map((swatch) => `${hueOf(swatch)}/${shiftOf(swatch)}`);
    expect(swatches.sort()).toEqual([haiku!, opus!, gpt!].map((seg) => `${hueOf(seg)}/${shiftOf(seg)}`).sort());
  });

  it("tells the pointer what a day's column stands for, and takes it back when it leaves", async () => {
    await withDaily({
      [day(1)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.009),
      [day()]: {
        ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
        ...spent('local', 'llama3.2:3b', 900, 60, 0),
      },
    });
    const tip = $('#usage-tip');
    expect(tip.hidden).toBe(true);

    const hover = (back: number, type: string) =>
      column(back).dispatchEvent(new MouseEvent(type, { bubbles: false, clientX: 100, clientY: 100 }));
    hover(0, 'mouseenter');
    expect(tip.hidden).toBe(false);
    expect($$('#usage-tip > div').map((row) => row.textContent)).toEqual([
      `${days()[0]!.split(' · ')[0]} · 2.9K in · 560 out · $0.0180`,
      'claude-opus-5-52K in · 500 out · $0.0180',
      'llama3.2:3b900 in · 60 out · free',
    ]);

    hover(0, 'mouseleave');
    expect(tip.hidden).toBe(true);
  });

  it('scales the chart to the busiest day, in money or in tokens', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) });
    expect($('#usage-chart-label').textContent).toBe('Each day, in cost');
    expect(axis()).toEqual(['$0.02', '$0.01', '$0']);

    $$('#usage-view button')[1].click();
    expect($('#usage-chart-label').textContent).toBe('Each day, in tokens');
    expect(axis()).toEqual(['2.5K', '1.3K', '0']);
    expect($$('#usage-view button').map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('reads the whole page in tokens, with what they cost still on it', async () => {
    await withDaily({
      [day()]: {
        // Cheaper, but far more of them: which model leads depends on which
        // of the two the page is being read in
        ...spent('local', 'llama3.2:3b', 900000, 40000, 0),
        ...spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018),
      },
    });
    expect(breakdown()[0]).toContain('Anthropic');
    expect(tiles()[0]).toBe('Spent: $0.0180');

    $$('#usage-view button')[1].click();
    expect(breakdown()[0]).toContain('Local');
    expect(tiles()).toEqual(['Tokens: 940K', 'A day: 130K', 'Tokens in: 900K', 'Tokens out: 41K', 'Spent: $0.0180']);
  });

  it('narrows to the days the chosen range covers', async () => {
    await withDaily({
      [day(40)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.01),
      [day(10)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.01),
      [day()]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.01),
    });
    expect(ranges().map((chip) => chip.textContent)).toEqual(['7 days', '30 days', '90 days', 'All']);
    // Seven days to begin with, which leaves out the days ten and forty days back
    expect(ranges().map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    expect(tiles()[0]).toBe('Spent: $0.0100');
    expect(days()).toHaveLength(1);
    expect(columns()).toHaveLength(7);

    ranges()[1].click();
    expect(tiles()[0]).toBe('Spent: $0.0200');
    expect(days()).toHaveLength(2);
    expect(columns()).toHaveLength(30);

    ranges()[3].click();
    expect(tiles()[0]).toBe('Spent: $0.0300');
    expect(columns()).toHaveLength(41);
  });

  // A range is that many days whether or not the app was used on all of them.
  // Stretching the days there are across the whole chart would make a week of
  // quiet work look like a busy one.
  it('keeps a range its full length when few of its days have anything on them', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) });
    expect(columns()).toHaveLength(7);
    expect(bars().slice(-1)).toEqual([1]);
    expect(quietBefore(1)).toBe(true);
    expect(tiles()[0]).toBe('Spent: $0.0180');

    ranges()[1].click();
    expect(columns()).toHaveLength(30);
    expect(quietBefore(1)).toBe(true);

    // ...while All still starts where the record does
    ranges()[3].click();
    expect(columns()).toHaveLength(1);
  });

  it('shows one sentence rather than a page of zeroes when nothing has been used', async () => {
    await withDaily({});
    expect($('#usage-empty').hidden).toBe(false);
    expect($('#usage-empty').textContent).toContain('Nothing has been used yet');
    expect($('#usage-chart-section').hidden).toBe(true);
    expect($('#usage-tiles').hidden).toBe(true);
    expect(columns()).toHaveLength(0);
  });

  it('says the same when the range covers none of the days on record', async () => {
    await withDaily({ [day(40)]: spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.01) });
    ranges()[0].click();
    expect($('#usage-empty').hidden).toBe(false);
    expect(days()).toHaveLength(0);
  });

  it('owns up to what the threads hold that the day-by-day record never saw', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) }, [
      { usage: spent('anthropic', 'claude-opus-5-5', 9000, 1000, 0.05) },
    ]);
    const said = $('#usage-earlier');
    expect(said.hidden).toBe(false);
    expect(said.textContent).toContain('7.5K tokens');
    expect(said.textContent).toContain('$0.0320');
  });

  it('keeps that quiet when the record holds everything the threads do', async () => {
    await withDaily({ [day()]: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) }, [
      { usage: spent('anthropic', 'claude-opus-5-5', 2000, 500, 0.018) },
    ]);
    expect($('#usage-earlier').hidden).toBe(true);
  });

  it('forgets a day older than the year it keeps, as soon as something new is counted', async () => {
    await withDaily({ '2020-01-01': spent('anthropic', 'claude-opus-5-5', 1000, 100, 0.01) });
    $('#usage-close').click();
    await type('question');
    emit(sentId(), anthropicUse);
    finish();
    expect(Object.keys(saved().daily)).toEqual([day()]);
  });
});

// A coding change is worked through in discrete steps, and the window shows
// which one is going on and the plan it writes before it changes anything
// (see harness/phases.ts)
describe('the steps of a coding change', () => {
  const plan = () => $('#messages .message.plan');

  it('says which step the reply is in while it has written nothing yet', async () => {
    await type('change the parser');
    emit(sentId(), { type: 'phase', phase: 'explore' });
    expect(messages().at(-1)).toBe('work: Finding out what this touches…');
    emit(sentId(), { type: 'phase', phase: 'execute' });
    expect(messages().at(-1)).toBe('work: Making the changes…');
  });

  it('names the explore step of an investigation for investigating, and the report as in any thread', async () => {
    const works = () => $$('#messages .message.work');
    await type('why is the parser slow');
    emit(sentId(), { type: 'phase', phase: 'explore', investigation: true });
    expect(messages().at(-1)).toBe('work: Investigating…');
    emit(sentId(), { type: 'thought', text: 'Looking around.' });
    // A thought straight after the last would join its run, and so its phase
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
    emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'ok', isError: false });
    emit(sentId(), { type: 'phase', phase: 'report' });
    emit(sentId(), { type: 'thought', text: 'Writing it up.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    expect(works().map((work) => work.querySelector('summary')!.textContent)).toEqual([
      'Investigated',
      'Wrote up the investigation',
    ]);
  });

  it('lifts the plan out of the reply and keeps it above the work', async () => {
    await type('change the parser');
    emit(sentId(), { type: 'phase', phase: 'plan' });
    // The plan streams into the reply as it is written...
    emit(sentId(), { type: 'text', delta: 'Add a flag to `src/parse.ts`.' });
    expect(messages().at(-1)).toBe('assistant: Add a flag to src/parse.ts.');

    // ...and becomes its own thing once it is finished
    emit(sentId(), { type: 'plan', text: 'Add a flag to `src/parse.ts`.' });
    expect(plan()).not.toBeNull();
    expect(plan()!.textContent).toContain('Add a flag to');
    expect(plan()!.querySelector('.caption')!.textContent).toBe('Plan');
    // Written as Markdown, as the reply is
    expect(plan()!.querySelector('code')!.textContent).toBe('src/parse.ts');
    // ...and the reply starts again empty, for the answer at the end, still
    // saying what the request is doing until the next step says otherwise
    expect(messages().at(-1)).toBe('note: Working out a plan…');

    emit(sentId(), { type: 'phase', phase: 'execute' });
    emit(sentId(), { type: 'text', delta: 'Added the flag.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 5 });
    expect(messages().at(-1)).toBe('assistant: Added the flag.');
  });

  it('keeps the plan in the thread, to be read again after a restart', async () => {
    await type('change the parser');
    emit(sentId(), { type: 'plan', text: 'Add a flag.' });
    emit(sentId(), { type: 'text', delta: 'Added it.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 5 });

    expect(saved().threads[0].messages.map((m: { role: string }) => m.role)).toEqual(['user', 'plan', 'assistant']);
    await start();
    expect(plan()!.textContent).toContain('Add a flag.');
  });

  // The plan is the model's, not the user's, and is never sent back as if it
  // were part of the conversation
  it('never sends the plan to a model as a turn of the conversation', async () => {
    await type('change the parser');
    emit(sentId(), { type: 'plan', text: 'Add a flag.' });
    emit(sentId(), { type: 'text', delta: 'Added it.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 5 });

    await type('now the lexer');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'change the parser' },
      { role: 'assistant', content: 'Added it.' },
      { role: 'user', content: 'now the lexer' },
    ]);
  });

  it('has nothing to lift out when the step wrote no plan', async () => {
    await type('change the parser');
    emit(sentId(), { type: 'phase', phase: 'plan' });
    emit(sentId(), { type: 'plan', text: '' });
    expect(plan()).toBeNull();
  });
});

// A reply arrives a few characters at a time and every one of them redraws the
// thread. Redrawing used to put the scroll back at the bottom, so a user who
// had scrolled up to read something was dragged away from it several times a
// second (see FOLLOWING in the renderer).
describe('following the end of a thread', () => {
  // jsdom lays nothing out, so the thread is given a height and a scroll of
  // its own: without this every measurement is zero and the thread always
  // reads as being at its end
  const place = (height: number, visible: number, at: number) => {
    const el = $('#messages');
    let top = at;
    Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: visible, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (to: number) => (top = to),
      configurable: true,
    });
    return () => top;
  };
  // A thread long enough to scroll, with the reader partway up it
  const scrolledUp = () => place(4000, 500, 1200);
  const atTheEnd = () => place(4000, 500, 3500);

  it('keeps the end in view for a reader who is already at the end', async () => {
    await type('question');
    const top = atTheEnd();
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    expect(top()).toBe(4000);
  });

  it('leaves a reader who has scrolled up where they put themselves', async () => {
    await type('question');
    const top = scrolledUp();
    emit(sentId(), { type: 'text', delta: 'Answer.' });
    expect(top()).toBe(1200);
    // ...and goes on leaving them there as the rest of the reply arrives
    emit(sentId(), { type: 'text', delta: ' And more of it.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    expect(top()).toBe(1200);
  });

  it('goes back to the end when the user writes, wherever they had scrolled to', async () => {
    await type('question');
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    const top = scrolledUp();
    await type('another question');
    expect(top()).toBe(4000);
  });

  it('shows a thread just opened at its end, whatever was scrolled to in the last one', async () => {
    await type('question');
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    const top = scrolledUp();
    await newThread(null);
    expect(top()).toBe(4000);
  });
});

describe('commenting on a reply', () => {
  const button = () => $<HTMLButtonElement>('#quote-button');
  const chip = () => $<HTMLElement>('#quote');
  const sentText = () => sent().messages.at(-1)!.content;

  // jsdom does no layout, so a range has no position
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 20 }) as DOMRect;
  });
  afterAll(() => {
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  });

  // A finished exchange: the user said hi and the model has written `text`
  async function answered(text: string) {
    await type('hi');
    emit(sentId(), { type: 'text', delta: text });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
  }
  // Selects what is inside an element, or from the start of one to the end of another, as a drag would
  function select(from: Element, to: Element = from) {
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.childNodes.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    from.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const twoDiagrams =
    'One:\n' +
    '```mermaid\nflowchart LR\nA[One] --> B[Two]\n```\n' +
    'Two:\n' +
    '```mermaid\nflowchart LR\nA[Again] --> B[Two]\n```';

  it('offers a Comment button for selected text, and sends the quote with the comment', async () => {
    await answered('Here is some **bold** text.');
    expect(button().hidden).toBe(true);
    select($('#messages .message.assistant p'));
    expect(button().hidden).toBe(false);
    button().click();
    expect(chip().hidden).toBe(false);
    expect($('#quote-text').textContent).toBe('> Here is some bold text.');
    expect(button().hidden).toBe(true);
    await type('why?');
    expect(sentText()).toBe('> Here is some bold text.\n\nwhy?');
    expect(chip().hidden).toBe(true);
  });

  it('shortens a long selection', async () => {
    const text = 'word '.repeat(100).trim();
    await answered(text);
    select($('#messages .message.assistant p'));
    button().click();
    expect($('#quote-text').textContent).toBe(`> ${text.slice(0, 300)}…`);
  });

  it('does not offer the button for a selection across two messages or in what the user wrote', async () => {
    await answered('First reply.');
    await answered('Second reply.');
    const [first, second] = $$('#messages .message.assistant p');
    select(first, second);
    expect(button().hidden).toBe(true);
    select($$('#messages .message.user')[0]);
    expect(button().hidden).toBe(true);
  });

  it('quotes a diagram node or edge when it is clicked, numbering the diagrams in the reply', async () => {
    await answered(twoDiagrams);
    const [first, second] = $$('#messages .message.assistant .diagram');
    click(second.querySelector('[data-node="A"] rect')!);
    expect($('#quote-text').textContent).toBe('> [diagram 2, node "A: Again"]');
    click(first.querySelector('[data-edge="A->B"] path')!);
    expect($('#quote-text').textContent).toBe('> [diagram 1, edge "A->B"]');
    await type('why this arrow?');
    expect(sentText()).toBe('> [diagram 1, edge "A->B"]\n\nwhy this arrow?');
  });

  // The size of the diagram's viewBox, and the ids of its nodes
  const diagramBox = () => {
    const svg = $('#messages .message.assistant .diagram svg');
    const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    return { width, height, nodes: [...svg.querySelectorAll('[data-node]')].map((n) => n.getAttribute('data-node')) };
  };
  const chain = (direction: string) =>
    '```mermaid\nflowchart ' + direction + '\n' + 'ABCDEFGH'.split('').join('[Step] --> ') + '[Step]\n```';

  it('turns a long left-to-right diagram top-down so it fits the width', async () => {
    await answered(chain('LR'));
    const { width, height, nodes } = diagramBox();
    expect(height).toBeGreaterThan(width);
    expect(nodes).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('keeps a short left-to-right diagram left to right', async () => {
    await answered('```mermaid\nflowchart LR\nA[One] --> B[Two]\n```');
    const { width, height } = diagramBox();
    expect(width).toBeGreaterThan(height);
  });

  it('turns a long right-to-left diagram bottom-up so it fits the width', async () => {
    await answered(chain('RL'));
    const { width, height } = diagramBox();
    expect(height).toBeGreaterThan(width);
  });

  // Clicking a picture or a diagram opens it larger in #zoom-dialog (see src/renderer/zoom.ts)
  it('opens a screenshot in the dialog when it is clicked', async () => {
    await answered('Here is the page.');
    const shot = document.createElement('img');
    shot.className = 'tool-image';
    shot.src = 'data:image/png;base64,AAAA';
    shot.alt = 'Screenshot';
    $('#messages .message.assistant').append(shot);
    click(shot);
    expect($('#zoom-dialog').hasAttribute('open')).toBe(true);
    expect($<HTMLImageElement>('#zoom-body img').src).toBe(shot.src);
  });

  it('opens a diagram larger, without the size it was drawn at', async () => {
    await answered(twoDiagrams);
    click($('#messages .message.assistant .diagram'));
    expect($('#zoom-dialog').hasAttribute('open')).toBe(true);
    expect($('#zoom-body svg').hasAttribute('width')).toBe(false);
    expect($('#zoom-body svg').hasAttribute('height')).toBe(false);
  });

  it('does not open the dialog for a node, which quotes it instead', async () => {
    await answered(twoDiagrams);
    const [first] = $$('#messages .message.assistant .diagram');
    click(first.querySelector('[data-node="A"] rect')!);
    expect($('#zoom-dialog').hasAttribute('open')).toBe(false);
    expect($('#quote-text').textContent).toBe('> [diagram 1, node "A: One"]');
  });

  it('closes the dialog with its close button, emptying it', async () => {
    await answered(twoDiagrams);
    click($('#messages .message.assistant .diagram'));
    click($('#zoom-close'));
    expect($('#zoom-dialog').hasAttribute('open')).toBe(false);
    expect($('#zoom-body').children.length).toBe(0);
  });

  it('closes the dialog when its backdrop is clicked', async () => {
    await answered(twoDiagrams);
    click($('#messages .message.assistant .diagram'));
    click($('#zoom-dialog'));
    expect($('#zoom-dialog').hasAttribute('open')).toBe(false);
  });

  it('drops the quote when it is cleared', async () => {
    await answered('Some text.');
    select($('#messages .message.assistant p'));
    button().click();
    $('#quote-clear').click();
    expect(chip().hidden).toBe(true);
    await type('plain');
    expect(sentText()).toBe('plain');
  });

  it('keeps the quote when there is no comment to send', async () => {
    await answered('Some text.');
    select($('#messages .message.assistant p'));
    button().click();
    const before = llm.send.mock.calls.length;
    await type('');
    expect(llm.send.mock.calls.length).toBe(before);
    expect(chip().hidden).toBe(false);
  });

  it('hides the quote in another thread', async () => {
    await answered('Some text.');
    select($('#messages .message.assistant p'));
    button().click();
    await newThread();
    await flush();
    expect(chip().hidden).toBe(true);
    await type('hello');
    expect(sentText()).toBe('hello');
  });

  it('can branch a comment on a finished reply off into a thread of its own', async () => {
    const threadButton = () => $<HTMLButtonElement>('#quote-thread-button');
    await answered('Here is some text');
    const parent = sentId();
    select($('#messages .message.assistant p'));
    expect(button().textContent).toBe('Comment');
    expect(threadButton().hidden).toBe(false);
    threadButton().click();
    expect($('#quote-text').textContent).toBe('> Here is some text');
    expect($$('#thread-list li.thread.offshoot')).toHaveLength(1);
    expect(threadButton().hidden).toBe(true);
    await type('what about that?');
    expect(sent().messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sentText()).toBe('> Here is some text\n\nwhat about that?');
    expect(sentId()).not.toBe(parent);
  });

  describe('while the reply is still being written', () => {
    const topLevel = () => $$<HTMLElement>('#thread-list li.thread:not(.offshoot)');
    const offshoots = () => $$<HTMLElement>('#thread-list li.thread.offshoot');
    const reply = () => $('#messages .message.assistant p');

    // The user said hi and the model has written `text` so far
    async function writing(text: string) {
      await type('hi');
      emit(sentId(), { type: 'text', delta: text });
    }

    it('lists subagents and offshoots under two toggles of their own, each opened on its own', async () => {
      await writing('Here is some text so far');
      const parent = sentId();
      emit(parent, { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests', kind: 'worker' });
      select(reply());
      button().click();
      const subToggle = () => $<HTMLElement>('#thread-list li.subagents-toggle');
      const offToggle = () => $<HTMLElement>('#thread-list li.offshoots-toggle');
      const subRows = () => $$<HTMLElement>('#thread-list li.subagent');
      // Starting an offshoot shows it, and nothing else: the subagents stay hidden
      expect(subToggle().getAttribute('aria-expanded')).toBe('false');
      expect(offToggle().getAttribute('aria-expanded')).toBe('true');
      expect(subRows()).toHaveLength(0);
      expect(offshoots()).toHaveLength(1);
      // Subagent rows come before the offshoot toggle
      const order = $$<HTMLElement>('#thread-list li');
      expect(order.indexOf(subToggle())).toBeLessThan(order.indexOf(offToggle()));

      subToggle().click();
      expect(subToggle().getAttribute('aria-expanded')).toBe('true');
      expect(subRows()).toHaveLength(1);
      expect(offToggle().getAttribute('aria-expanded')).toBe('true');
      expect(offshoots()).toHaveLength(1);

      offToggle().click();
      expect(offToggle().getAttribute('aria-expanded')).toBe('false');
      expect(offshoots()).toHaveLength(0);
      expect(subToggle().getAttribute('aria-expanded')).toBe('true');
      expect(subRows()).toHaveLength(1);
    });

    it('branches the comment off into a thread of its own, listed under the one it came from', async () => {
      await writing('Here is some text so far');
      const parent = sentId();
      select(reply());
      expect(button().textContent).toBe('Comment in a new thread');
      button().click();
      expect($('#quote-text').textContent).toBe('> Here is some text so far');
      expect(chip().hidden).toBe(false);
      // The new thread starts from what has been said
      expect(reply().textContent).toBe('Here is some text so far');
      expect(topLevel()).toHaveLength(1);
      expect(offshoots().map((el) => el.querySelector('.name')!.textContent)).toEqual(['Here is some text so far']);
      expect($('#thread-list li.thread-agents').textContent).toContain('1 offshoot');

      await type('what about that?');
      expect(sent().messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(sent().messages[1].content).toBe('Here is some text so far');
      expect(sentText()).toBe('> Here is some text so far\n\nwhat about that?');
      expect(sentId()).not.toBe(parent);

      // ...and the first thread goes on being written, untouched
      emit(parent, { type: 'text', delta: ' and the rest' });
      emit(parent, { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      topLevel()[0].click();
      expect(reply().textContent).toBe('Here is some text so far and the rest');
      expect($$('#messages .message.user')).toHaveLength(1);
    });

    it('quotes a diagram in an offshoot too', async () => {
      await writing('Flow:\n```mermaid\nflowchart LR\nA[One] --> B[Two]\n```\n');
      click($('#messages .diagram [data-node="A"] rect'));
      expect($('#quote-text').textContent).toBe('> [diagram 1, node "A: One"]');
      expect(offshoots()).toHaveLength(1);
    });

    it('keeps the selection, and the button, as more of the reply arrives', async () => {
      await writing('Here is some text so far');
      select(reply());
      emit(sentId(), { type: 'text', delta: ' and more' });
      expect(reply().textContent).toBe('Here is some text so far and more');
      expect(window.getSelection()!.toString()).toBe('Here is some text so far');
      expect(button().hidden).toBe(false);
    });

    it('lists an offshoot as a thread of its own once the one it came from is deleted', async () => {
      await writing('Some text');
      const parent = sentId();
      select(reply());
      button().click();
      emit(parent, { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      topLevel()[0].querySelector<HTMLElement>('.delete')!.click();
      expect(topLevel()).toHaveLength(1);
      expect(offshoots()).toHaveLength(0);
      expect($('#thread-list li.thread-agents')).toBeNull();
    });

    it('does not send on Enter while the reply is streaming, and keeps what was typed', async () => {
      await writing('Some text so far');
      const parent = sentId();
      const input = $<HTMLTextAreaElement>('#input');
      input.value = 'second thought';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await flush();
      expect($$('#messages .message.user')).toHaveLength(1);
      expect(sentId()).toBe(parent);
      expect(input.value).toBe('second thought');
    });

    it('cancels the reply from the Stop button, and leaves what was typed in the box', async () => {
      await writing('Some text so far');
      const parent = sentId();
      $<HTMLTextAreaElement>('#input').value = 'second thought';
      $<HTMLButtonElement>('#send').click();
      await flush();
      expect(llm.cancel).toHaveBeenCalledWith(parent);
      expect($<HTMLTextAreaElement>('#input').value).toBe('second thought');
    });
  });
});

describe('markdown in a reply', () => {
  beforeEach(() => type('hi'));

  // The reply bubble's markup after the model has written `text`
  const reply = (text: string) => {
    emit(sentId(), { type: 'text', delta: text });
    return $('#messages .message.assistant').innerHTML;
  };

  it('formats bold, italics, strikethrough and inline code', () => {
    expect(reply('Use **bold**, *italic*, _also italic_, ~~gone~~ and `npm run dev`.')).toBe(
      '<p>Use <strong>bold</strong>, <em>italic</em>, <em>also italic</em>, <del>gone</del> ' +
        'and <code>npm run dev</code>.</p>'
    );
  });

  it('leaves underscores inside words and unmatched markers alone', () => {
    expect(reply('Set max_tokens_limit to 2 * 3 and **keep going')).toBe(
      '<p>Set max_tokens_limit to 2 * 3 and **keep going</p>'
    );
  });

  it('shows what is inside inline code exactly as written', () => {
    expect(reply('Run `ls **/*.ts` and \\*not italic\\*')).toBe('<p>Run <code>ls **/*.ts</code> and *not italic*</p>');
  });

  it('separates paragraphs and keeps line breaks within one', () => {
    expect(reply('First line\nsecond line\n\nNew paragraph')).toBe(
      '<p>First line<br>second line</p><p>New paragraph</p>'
    );
  });

  it('formats headings and rules', () => {
    expect(reply('# Title\n### Section ###\ntext\n\n---\nmore')).toBe(
      '<h1>Title</h1><h3>Section</h3><p>text</p><hr><p>more</p>'
    );
  });

  it('formats a code block, keeping its contents untouched', () => {
    expect(reply('Try:\n```ts\nconst a = **b**;\n  <b>x</b>\n```\nDone')).toBe(
      '<p>Try:</p><pre><code data-language="ts">const a = **b**;\n  &lt;b&gt;x&lt;/b&gt;</code></pre><p>Done</p>'
    );
  });

  it('shows a code block that is still being written', () => {
    expect(reply('```\nnpm install')).toBe('<pre><code>npm install</code></pre>');
  });

  describe('a diagram', () => {
    const drawn = (text: string) => {
      reply(text);
      return $('#messages .message.assistant');
    };
    const labels = (el: Element, selector: string) =>
      [...el.querySelectorAll(selector)].map((node) => node.textContent);

    it('draws a mermaid flowchart as SVG, with its nodes and arrows', () => {
      const el = drawn(
        'Flow:\n```mermaid\nflowchart TD\n  A[Parser] --> B{Valid?}\n  B -->|yes| C(Cache)\n' +
          '  B -.-> D((Log))\n```\nDone'
      );
      expect(el.querySelector('pre')).toBeNull();
      expect(el.querySelectorAll('.diagram > svg')).toHaveLength(1);
      expect(labels(el, '.node')).toEqual(['Parser', 'Valid?', 'Cache', 'Log']);
      expect([...el.querySelectorAll('.node')].map((n) => n.getAttribute('data-node'))).toEqual(['A', 'B', 'C', 'D']);
      expect([...el.querySelectorAll('.edge')].map((e) => e.getAttribute('data-edge'))).toEqual([
        'A->B',
        'B->C',
        'B->D',
      ]);
      expect(labels(el, '.edge-label')).toEqual(['yes']);
      expect(el.querySelectorAll('.edge.dotted')).toHaveLength(1);
      expect(el.querySelector('[data-node="B"] polygon')).not.toBeNull();
      expect(el.querySelector('[data-node="D"] ellipse')).not.toBeNull();
      expect(labels(el, 'p')).toEqual(['Flow:', 'Done']);
    });

    it.each([
      ['TD', 'y', 1],
      ['BT', 'y', -1],
      ['LR', 'x', 1],
      ['RL', 'x', -1],
    ])('lays a %s chart out along %s, B after A by %i', (direction, axis, sign) => {
      const el = drawn('```mermaid\nflowchart ' + direction + '\nA --> B\n```');
      const at = (id: string) => Number(el.querySelector(`[data-node="${id}"] rect`)?.getAttribute(axis));
      expect(Math.sign(at('B') - at('A'))).toBe(sign);
    });

    it('draws a cycle and chained arrows without looping', () => {
      const el = drawn('```mermaid\nflowchart LR\nA --> B --> C\nC --> A\nA --> A\n```');
      expect(el.querySelectorAll('.node')).toHaveLength(3);
      expect(el.querySelectorAll('.edge')).toHaveLength(3);
    });

    it('shows a diagram that is still being written as code', () => {
      expect(reply('```mermaid\nflowchart TD\nA --> B')).toBe(
        '<pre><code data-language="mermaid">flowchart TD\nA --&gt; B</code></pre>'
      );
    });

    it.each([
      ['another kind of diagram', 'sequenceDiagram\nA->>B: hi'],
      ['a subgraph', 'flowchart TD\nsubgraph one\nA --> B\nend'],
      ['no nodes', 'flowchart TD'],
    ])('shows %s as code', (_, source) => {
      const el = drawn('```mermaid\n' + source + '\n```');
      expect(el.querySelector('svg')).toBeNull();
      expect(el.querySelector('pre code')?.textContent).toBe(source);
    });

    it('never turns what the model wrote into markup', () => {
      const el = drawn('```mermaid\nflowchart TD\nA["<img src=x onerror=alert(1)>"] --> B\n```');
      expect(el.querySelector('img')).toBeNull();
      expect(labels(el, '.node')[0]).toBe('<img src=x onerror=alert(1)>');
    });
  });

  describe('a file reference', () => {
    // A finished reply in a thread that has a workspace, its last assistant
    // bubble back so the reference it named can be read from that workspace
    const inWorkspace = async (text: string) => {
      await newThread('/projects/demo');
      $<HTMLTextAreaElement>('#input').value = 'hi';
      $<HTMLFormElement>('#composer').requestSubmit();
      await flush();
      emit(sentId(), { type: 'text', delta: text });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      return $<HTMLElement>('#messages .message.assistant');
    };

    it('shows a named part of the code as a note, closed until it is opened', async () => {
      const el = await inWorkspace('Here:\n```file\nsrc/main.ts:442-451\n```\n');
      const details = el.querySelector('details.file-ref');
      expect(details).not.toBeNull();
      expect(details!.open).toBe(false);
      expect(details!.querySelector('.file-path')?.textContent).toBe('src/main.ts');
      expect(details!.querySelector('.file-range')?.textContent).toBe('442-451');
      expect(threads.workspaceFile).not.toHaveBeenCalled();
      expect(details!.querySelector('.file-body .row')).toBeNull();
    });

    it('reads the lines of the file when the note is opened, numbered', async () => {
      threads.workspaceFile.mockResolvedValue({
        path: 'src/main.ts', lines: ['alpha', 'beta'], from: 442, total: 451, more: 9,
      });
      const el = await inWorkspace('```file\nsrc/main.ts:442-451\n```\n');
      const details = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await flush();
      expect(threads.workspaceFile).toHaveBeenCalledWith('/projects/demo', 'src/main.ts', 442, 451);
      const rows = [...details.querySelectorAll('.file-body .row')];
      expect(rows.map((r) => r.querySelector('.number')!.textContent)).toEqual(['442', '443']);
      expect(rows.map((r) => r.querySelector('code')!.textContent)).toEqual(['alpha', 'beta']);
      expect(details.querySelector('.file-body .more')?.textContent).toContain('more');
    });

    it('reads a whole file when the note names no lines', async () => {
      threads.workspaceFile.mockResolvedValue({ path: 'a.txt', lines: ['x', 'y'], from: 1, total: 2 });
      const el = await inWorkspace('```file\na.txt\n```\n');
      const details = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await flush();
      expect(threads.workspaceFile).toHaveBeenCalledWith('/projects/demo', 'a.txt', undefined, undefined);
      expect([...details.querySelectorAll('.file-body .row code')].map((c) => c.textContent)).toEqual(['x', 'y']);
    });

    it('stays open when the messages are rebuilt, and reads it again', async () => {
      threads.workspaceFile.mockResolvedValue({ path: 'a.txt', lines: ['x'], from: 1, total: 1 });
      const el = await inWorkspace('```file\na.txt\n```\n');
      const details = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await flush();
      // A rebuild redraws the notes, and the one the user opened comes back open
      emit(sentId(), { type: 'text', delta: ' ' });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      const again = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      expect(again.open).toBe(true);
      expect(again.querySelector('.file-body .row')).not.toBeNull();
    });

    it('says when the file is not there, in place of the lines', async () => {
      threads.workspaceFile.mockResolvedValue({ path: 'nope.ts', notFound: true });
      const el = await inWorkspace('```file\nnope.ts\n```\n');
      const details = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await flush();
      expect(details.querySelector('.file-body .row')).toBeNull();
      expect(details.querySelector('.file-body')!.textContent).toContain('Not found');
    });

    it('says when the path reaches outside the workspace', async () => {
      threads.workspaceFile.mockResolvedValue({ path: '../secret.txt', outside: true });
      const el = await inWorkspace('```file\n../secret.txt\n```\n');
      const details = $<HTMLDetailsElement>('#messages .message.assistant details.file-ref');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await flush();
      expect(details.querySelector('.file-body')!.textContent).toContain('outside the workspace');
    });

    it('shows a file reference that is still being written as code', async () => {
      const el = await inWorkspace('```file\nsrc/main.ts');
      expect(el.querySelector('details.file-ref')).toBeNull();
      expect(el.querySelector('pre code')?.textContent).toBe('src/main.ts');
    });

    it('shows a file block of no references as code', async () => {
      const el = await inWorkspace('```file\n\n```\n');
      expect(el.querySelector('details.file-ref')).toBeNull();
      expect(el.querySelector('pre code')?.textContent).toBe('');
    });
  });

  it('formats bulleted and numbered lists', () => {
    expect(reply('- one\n- **two**\n\n3. three\n4. four')).toBe(
      '<ul><li>one</li><li><strong>two</strong></li></ul><ol start="3"><li>three</li><li>four</li></ol>'
    );
  });

  it('nests lists by indentation and keeps code inside its list item', () => {
    expect(reply('1. Install:\n   ```sh\n   npm i\n   ```\n2. Then:\n   - build\n   - run\n\nAfter')).toBe(
      '<ol><li>Install:<pre><code data-language="sh">npm i</code></pre></li>' +
        '<li>Then:<ul><li>build</li><li>run</li></ul></li></ol><p>After</p>'
    );
  });

  it('formats quotes and tables', () => {
    expect(reply('> quoted **text**\n> more')).toBe(
      '<blockquote><p>quoted <strong>text</strong><br>more</p></blockquote>'
    );
  });

  it('formats a table with its column alignment', () => {
    emit(sentId(), { type: 'text', delta: '| Model | Level |\n|:--|--:|\n| Opus | `4` |\n| Haiku | 2 |\nEnd' });
    const cells = (selector: string) => $$(`#messages .message.assistant ${selector}`).map((c) => c.textContent);
    expect(cells('th')).toEqual(['Model', 'Level']);
    expect(cells('td')).toEqual(['Opus', '4', 'Haiku', '2']);
    expect($$('#messages td')[1].style.textAlign).toBe('right');
    expect($('#messages td code').textContent).toBe('4');
    expect($('#messages .message.assistant p').textContent).toBe('End');
  });

  it('makes web links that open outside the app, written out or bare', () => {
    emit(sentId(), { type: 'text', delta: 'See [the docs](https://example.com/a_b) or https://example.org/x.' });
    const links = $$('#messages .message.assistant a') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.target])).toEqual([
      ['the docs', 'https://example.com/a_b', '_blank'],
      ['https://example.org/x', 'https://example.org/x', '_blank'],
    ]);
    expect($('#messages .message.assistant').textContent).toBe('See the docs or https://example.org/x.');
  });

  it('does not make a link out of anything but a web or email address', () => {
    expect(reply('[click](javascript:alert(1)) and [file](file:///etc/passwd)')).not.toContain('<a');
  });

  it('never turns what the model writes into markup', () => {
    const html = reply('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>bold</b>**');
    expect(
      $$('#messages .message.assistant img, #messages .message.assistant script, #messages .message.assistant b')
    ).toEqual([]);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('formats as the reply streams in, piece by piece', () => {
    reply('Here is **bo');
    expect(reply('ld** text')).toBe('<p>Here is <strong>bold</strong> text</p>');
  });

  it('reads a thread saved when a workspace was called a folder', async () => {
    // Saved by a version that spelled all three of these "folder"
    const state = saved() as Record<string, unknown> & { threads: Record<string, unknown>[] };
    state.threads[0].workspace = undefined;
    state.threads[0].folder = '/projects/demo';
    delete state.recentWorkspaces;
    delete state.workspaceNames;
    state.recentFolders = ['/projects/demo', '/projects/other'];
    state.folderNames = { '/projects/demo': 'The demo' };
    onDisk = JSON.stringify(state);
    await start();

    // The thread still knows where it was started, under the new name, and
    // the name the user gave that workspace is still its name
    expect($('#thread-workspace').textContent).toContain('The demo');
    // The workspaces used before are still offered for a new thread
    $('#new-thread').click();
    await flush();
    expect(recentWorkspaces()).toEqual(['/projects/demo', '/projects/other']);

    // ...and what is saved from here on uses the new names only
    await type('hi');
    const now = JSON.parse(onDisk!) as Record<string, unknown> & { threads: Record<string, unknown>[] };
    expect(now.threads[0].workspace).toBe('/projects/demo');
    expect(now.threads[0]).not.toHaveProperty('folder');
    expect(now).not.toHaveProperty('recentFolders');
    expect(now).not.toHaveProperty('folderNames');
    expect(now.workspaceNames).toEqual({ '/projects/demo': 'The demo' });
  });

  it('leaves out result tags in a reply saved before they were stripped', async () => {
    const state = saved();
    state.threads[0].messages = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '<result>\nThe capital is **Paris**.\n</result>' },
    ];
    onDisk = JSON.stringify(state);
    await start();
    expect($('#messages .message.assistant').innerHTML).toBe('<p>The capital is <strong>Paris</strong>.</p>');
  });

  it('leaves the messages the user wrote as plain text', async () => {
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await type('**not bold**');
    expect($$('#messages .message.user').at(-1)!.innerHTML).toBe('**not bold**');
  });
});

describe('the right-click menu on a message', () => {
  const menu = () => $('#message-menu');
  const retry = () => $<HTMLButtonElement>('#menu-retry');
  const del = () => $<HTMLButtonElement>('#menu-delete');
  // Right-clicks the message that reads `text` ("role: text", as in messages())
  const rightClick = (text: string) => {
    const el = $$('#messages .message')[messages().indexOf(text)];
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    el.dispatchEvent(event);
    return event;
  };
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  // One finished exchange: a question and its answer
  const exchange = async (question: string, answer: string) => {
    await type(question);
    emit(sentId(), { type: 'text', delta: answer });
    finish();
  };

  beforeEach(async () => {
    await exchange('first question', 'First answer.');
    await exchange('second question', 'Second answer.');
  });

  it('opens where the message was right-clicked, in place of the system menu', () => {
    expect(menu().hidden).toBe(true);
    const event = rightClick('assistant: First answer.');
    expect(event.defaultPrevented).toBe(true);
    expect(menu().hidden).toBe(false);
    expect([menu().style.left, menu().style.top]).toEqual(['40px', '60px']);
    expect($$('#message-menu button').map((b) => b.textContent)).toEqual(['Retry', 'Delete']);
  });

  it('closes on Escape or a click elsewhere, without changing anything', () => {
    rightClick('assistant: First answer.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu().hidden).toBe(true);

    rightClick('assistant: First answer.');
    $('#messages').click();
    expect(menu().hidden).toBe(true);
    expect(messages()).toHaveLength(4);
  });

  describe('Delete', () => {
    it('removes just that message, from the thread and from what the model sees next', async () => {
      rightClick('assistant: First answer.');
      del().click();
      expect(menu().hidden).toBe(true);
      expect(messages()).toEqual(['user: first question', 'user: second question', 'assistant: Second answer.']);
      expect(saved().threads[0].messages).toHaveLength(3);

      // The deleted answer leaves a gap between two of the user's messages,
      // and that gap is declared: a model sent one request with no answer
      // under it and another after it answers them both
      await type('third question');
      expect(sent().messages).toEqual([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: expect.stringContaining('is not an\nunanswered request') },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'Second answer.' },
        { role: 'user', content: 'third question' },
      ]);
    });

    it('removes a message of the user, and leaves the reply to it', () => {
      rightClick('user: first question');
      del().click();
      expect(messages()).toEqual(['assistant: First answer.', 'user: second question', 'assistant: Second answer.']);
    });

    it('removes notes, thoughts and tool calls too', async () => {
      await type('third question');
      emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
      emit(sentId(), {
        type: 'model',
        provider: 'local',
        model: 'llama3.2:3b',
        name: 'llama3.2:3b',
        sophistication: 1,
        reason: 'matched',
      });
      emit(sentId(), { type: 'thought', text: 'Looking it up.' });
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'x', isError: false });
      emit(sentId(), { type: 'text', delta: 'Third answer.' });
      finish();
      for (const text of ['thought: Looking it up.', 'tool: Read a', 'note: Question · 1/5 Complexity · low effort']) {
        rightClick(text);
        del().click();
      }
      expect(messages().slice(4)).toEqual(['user: third question', 'assistant: Third answer.']);
    });
  });

  describe('Retry', () => {
    it('replaces the last reply with a new one to the same message', async () => {
      llm.send.mockClear();
      rightClick('assistant: Second answer.');
      retry().click();
      expect(menu().hidden).toBe(true);
      // The attempt's note is put back before the next one is asked for
      await flush();
      expect(messages()).toEqual([
        'user: first question',
        'assistant: First answer.',
        'user: second question',
        'note: Classifying complexity & routing…',
      ]);
      expect(llm.send).toHaveBeenCalledOnce();
      expect(sent().messages).toEqual([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'First answer.' },
        { role: 'user', content: 'second question' },
      ]);

      emit(sentId(), { type: 'text', delta: 'A better second answer.' });
      finish();
      expect(messages().at(-1)).toBe('assistant: A better second answer.');
      expect(messages()).toHaveLength(4);
    });

    it('works from the message of the user as well as from any part of the reply', async () => {
      rightClick('user: second question');
      retry().click();
      await flush();
      expect(messages().at(-1)).toBe('note: Classifying complexity & routing…');
      expect(sent().messages.at(-1)).toEqual({ role: 'user', content: 'second question' });
    });

    it('retries an earlier message in place, keeping what came after it', async () => {
      rightClick('assistant: First answer.');
      retry().click();
      await flush();
      // The model is shown the conversation only as far as the retried message
      expect(sent().messages).toEqual([{ role: 'user', content: 'first question' }]);

      emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
      emit(sentId(), {
        type: 'model',
        provider: 'local',
        model: 'llama3.2:3b',
        name: 'llama3.2:3b',
        sophistication: 1,
        reason: 'matched',
      });
      emit(sentId(), { type: 'thought', text: 'Trying again.' });
      emit(sentId(), { type: 'text', delta: 'Let me check.' });
      emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } });
      emit(sentId(), { type: 'tool_result', id: 'c1', name: 'read_file', output: 'x', isError: false });
      emit(sentId(), { type: 'text', delta: 'New first answer.' });
      finish();
      expect(messages()).toEqual([
        'user: first question',
        'note: Question · 1/5 Complexity · low effort',
        'work: Work',
        'thought: Trying again.',
        'assistant: Let me check.',
        'work: Work',
        'tool: Read a',
        'assistant: New first answer.',
        'user: second question',
        'assistant: Second answer.',
      ]);
    });

    it('puts a failure in place too, after whatever of the reply arrived', async () => {
      rightClick('user: first question');
      retry().click();
      await flush();
      emit(sentId(), { type: 'text', delta: 'Partial' });
      emit(sentId(), { type: 'error', code: 'other', message: 'Connection lost.' });
      expect(messages()).toEqual([
        'user: first question',
        'assistant: Partial',
        'error: Connection lost.',
        'user: second question',
        'assistant: Second answer.',
      ]);
    });

    it('replaces a reply that failed', async () => {
      await type('third question');
      emit(sentId(), { type: 'error', code: 'rate_limit', message: 'Too many requests.' });
      rightClick('error: Too many requests.');
      retry().click();
      // A failed attempt's files are put back before the next one starts
      await flush();
      emit(sentId(), { type: 'text', delta: 'Third answer.' });
      finish();
      expect(messages().slice(4)).toEqual(['user: third question', 'assistant: Third answer.']);
    });

    // A reply that failed partway has still done whatever its tools did before
    // it failed. Left there, the next attempt would be working on top of it.
    describe('the files a failed attempt left behind', () => {
      // One failed attempt at a message in a workspace, ready to be retried
      const failedTurn = async () => {
        await newThread('/projects/demo');
        await type('change the parser');
        const attempt = sentId();
        emit(attempt, { type: 'text', delta: 'Half done' });
        emit(attempt, { type: 'error', code: 'other', message: 'Connection lost.' });
        return attempt;
      };

      it('puts them back before trying again, and says so in the thread', async () => {
        const attempt = await failedTurn();
        threads.revert.mockResolvedValue(true);
        rightClick('error: Connection lost.');
        retry().click();
        await flush();

        expect(threads.revert).toHaveBeenCalledWith(expect.any(String), attempt, { files: true });
        // Above the reply it is making way for, and nothing of the attempt
        // it replaced left under it
        expect(messages().slice(0, 2)).toEqual([
          'user: change the parser',
          'note: Put the files back as they were before the attempt that failed.',
        ]);
        expect(messages()).not.toContain('error: Connection lost.');
      });

      it('says nothing when there was nothing to put back', async () => {
        await failedTurn();
        rightClick('error: Connection lost.');
        retry().click();
        await flush();
        expect(threads.revert).toHaveBeenCalled();
        expect(messages()[0]).toBe('user: change the parser');
        expect(messages().some((m) => m.includes('Put the files back'))).toBe(false);
      });

      // An attempt that ran to the end left work the user may have looked over
      // already, so its files stay. What it wrote in its context note does not:
      // the messages it wrote that from have just been thrown away (see the
      // 2026-10-29 "squash everything" thread, where the note went on telling
      // the next attempt the work was done).
      it('puts the note back but leaves the files alone when the attempt did not fail', async () => {
        await newThread('/projects/demo');
        await type('change the parser');
        emit(sentId(), { type: 'text', delta: 'Done.' });
        emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
        const attempt = sentId();

        rightClick('assistant: Done.');
        retry().click();
        await flush();
        expect(threads.revert).toHaveBeenCalledWith(expect.any(String), attempt, { files: false });
        expect(messages().some((m) => m.includes('Put the files back'))).toBe(false);
      });

      // The snapshot the main process holds is of the latest attempt on the
      // thread; a message answered before that is not the one it belongs to
      it('asks for the attempt it is replacing, not whichever was last', async () => {
        const first = await failedTurn();
        await type('something else');
        const second = sentId();
        expect(second).not.toBe(first);
        emit(second, { type: 'error', code: 'other', message: 'Also lost.' });

        rightClick('error: Connection lost.');
        retry().click();
        await flush();
        expect(threads.revert).toHaveBeenCalledWith(expect.any(String), first, { files: true });
      });
    });

    it('is not offered for a reply whose message was deleted', () => {
      rightClick('user: first question');
      del().click();
      rightClick('assistant: First answer.');
      expect(retry().disabled).toBe(true);
      expect(del().disabled).toBe(false);
    });
  });

  it('offers nothing while a reply is being written to the thread', async () => {
    await type('third question');
    rightClick('assistant: First answer.');
    expect([retry().disabled, del().disabled]).toEqual([true, true]);

    finish();
    rightClick('assistant: First answer.');
    expect([retry().disabled, del().disabled]).toEqual([false, false]);
  });
});

describe('summarizing an idle thread', () => {
  const IDLE = 10 * 60 * 1000;
  // Time is under the tests' control here, so nothing waits on a real timer
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const say = async (text: string) => {
    $<HTMLTextAreaElement>('#input').value = text;
    $<HTMLFormElement>('#composer').requestSubmit();
    settle();
  };
  const exchange = async (question: string, answer: string) => {
    await say(question);
    emit(sentId(), { type: 'text', delta: answer });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  };
  // start() waits on a timer of its own, so the clock is kept moving until it
  // is done rather than advanced once and hoped over: how many turns the
  // reimport takes is not this test's business
  const restart = async () => {
    let done = false;
    const started = start().then(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(0);
    await started;
  };
  const rightClick = (text: string) =>
    $$('#messages .message')[messages().indexOf(text)].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  const NOTE = 'note: Conversation so far summarized';

  beforeEach(async () => {
    vi.useFakeTimers();
    await restart();
    llm.summarize.mockResolvedValue({ text: 'They discussed A and B.' });
    await exchange('question A', 'Answer A.');
    await exchange('question B', 'Answer B.');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a summary of the conversation once the thread has been idle for ten minutes', async () => {
    await wait(IDLE - 1000);
    expect(llm.summarize).not.toHaveBeenCalled();
    await wait(1000);
    expect(llm.summarize).toHaveBeenCalledExactlyOnceWith({
      summary: undefined,
      messages: [
        { role: 'user', content: 'question A' },
        { role: 'assistant', content: 'Answer A.' },
        { role: 'user', content: 'question B' },
        { role: 'assistant', content: 'Answer B.' },
      ],
    });
  });

  it('marks where the summary reaches with a note that opens to show it', async () => {
    await wait(IDLE);
    expect(messages()).toEqual([
      'user: question A',
      'assistant: Answer A.',
      'user: question B',
      'assistant: Answer B.',
      NOTE,
    ]);
    expect($('#messages .note.summary details pre').textContent).toBe('They discussed A and B.');
    expect($<HTMLDetailsElement>('#messages .note.summary details').open).toBe(false);
  });

  it('sends the summary in place of the messages it covers from then on', async () => {
    await wait(IDLE);
    await say('question C');
    expect(sent().summary).toBe('They discussed A and B.');
    expect(sent().messages).toEqual([{ role: 'user', content: 'question C' }]);
  });

  it('sends the whole conversation, and no summary, until there is one', async () => {
    await say('question C');
    expect(sent().summary).toBeUndefined();
    expect(sent().messages).toHaveLength(5);
  });

  it('starts counting again whenever the thread is used', async () => {
    await wait(IDLE - 1000);
    await exchange('question C', 'Answer C.');
    await wait(IDLE - 1000);
    expect(llm.summarize).not.toHaveBeenCalled();
    await wait(1000);
    expect(llm.summarize.mock.calls[0][0].messages).toHaveLength(6);
  });

  it('does not summarize a thread with little new to summarize', async () => {
    await wait(IDLE);
    llm.summarize.mockClear();
    await exchange('question C', 'Answer C.');
    await wait(IDLE);
    expect(llm.summarize).not.toHaveBeenCalled();
  });

  it('folds the earlier summary into the next one, and moves the note', async () => {
    await wait(IDLE);
    await exchange('question C', 'Answer C.');
    await exchange('question D', 'Answer D.');
    llm.summarize.mockResolvedValue({ text: 'They discussed A to D.' });
    await wait(IDLE);
    expect(llm.summarize).toHaveBeenLastCalledWith({
      summary: 'They discussed A and B.',
      messages: [
        { role: 'user', content: 'question C' },
        { role: 'assistant', content: 'Answer C.' },
        { role: 'user', content: 'question D' },
        { role: 'assistant', content: 'Answer D.' },
      ],
    });
    expect(messages().filter((m) => m === NOTE)).toHaveLength(1);
    expect(messages().at(-1)).toBe(NOTE);

    await say('question E');
    expect(sent()).toMatchObject({ summary: 'They discussed A to D.', messages: [{ content: 'question E' }] });
  });

  it('leaves the thread as it was when no summary could be made, and tries again after its next use', async () => {
    llm.summarize.mockResolvedValue(null);
    await wait(IDLE);
    expect(messages()).not.toContain(NOTE);
    await say('question C');
    expect(sent().messages).toHaveLength(5);
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

    llm.summarize.mockResolvedValue({ text: 'Now it worked.' });
    await wait(IDLE);
    expect(messages()).toContain(NOTE);
  });

  it('waits for a reply that is still being written', async () => {
    await say('question C');
    await wait(IDLE * 2);
    expect(llm.summarize).not.toHaveBeenCalled();
  });

  it('keeps the summary after a restart, and summarizes a thread idle since the app closed', async () => {
    await wait(IDLE);
    await restart();
    await say('question C');
    expect(sent()).toMatchObject({ summary: 'They discussed A and B.', messages: [{ content: 'question C' }] });
  });

  it('summarizes soon after starting when the thread was already idle long enough', async () => {
    vi.setSystemTime(Date.now() + IDLE * 3);
    llm.summarize.mockClear();
    await restart();
    settle();
    expect(llm.summarize).toHaveBeenCalledOnce();
  });

  it('sends the messages themselves when an earlier, summarized message is retried', async () => {
    await wait(IDLE);
    rightClick('assistant: Answer A.');
    $('#menu-retry').click();
    await settle();
    expect(sent().summary).toBeUndefined();
    expect(sent().messages).toEqual([{ role: 'user', content: 'question A' }]);
  });

  // The summary was written from the attempt being thrown away as much as from
  // the thread, so it goes with it. Withheld from the retried message alone, it
  // came back on the next message and was rated and answered as though the
  // attempt had stood: that is what rated a message of "1" at 4 of 5 and sent
  // it to a model the user had to approve (the 2026-10-29 "squash" thread).
  it('throws away a summary that covers the retried message, rather than leaving it for the next one', async () => {
    await wait(IDLE);
    rightClick('assistant: Answer A.');
    $('#menu-retry').click();
    await settle();
    emit(sentId(), { type: 'text', delta: 'A better answer.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    expect(messages()).not.toContain(NOTE);

    await say('question C');
    expect(sent().summary).toBeUndefined();
    expect(sent().messages).toEqual([
      { role: 'user', content: 'question A' },
      { role: 'assistant', content: 'A better answer.' },
      { role: 'user', content: 'question B' },
      { role: 'assistant', content: 'Answer B.' },
      { role: 'user', content: 'question C' },
    ]);
  });

  // ...where it does not reach the message, it is the thread's own and stands:
  // nothing of what it covers is being thrown away
  it('keeps a summary that the retried message comes after', async () => {
    await wait(IDLE);
    await exchange('question C', 'Answer C.');
    rightClick('assistant: Answer C.');
    $('#menu-retry').click();
    await settle();
    expect(messages()).toContain(NOTE);
    expect(sent().summary).toBe('They discussed A and B.');
    expect(sent().messages).toEqual([{ role: 'user', content: 'question C' }]);
  });

  it('goes back to sending the messages when the summary note is deleted', async () => {
    await wait(IDLE);
    rightClick(NOTE);
    $('#menu-delete').click();
    await say('question C');
    expect(sent().summary).toBeUndefined();
    expect(sent().messages).toHaveLength(5);
  });

  it('does nothing for a thread that was deleted', async () => {
    $('#thread-list .delete').click();
    await wait(IDLE);
    expect(llm.summarize).not.toHaveBeenCalled();
  });
});

describe('stopping a reply', () => {
  it('cancels with the Stop button, but not with Enter', async () => {
    await type('hi');
    const first = sentId();
    await type('typed while waiting');
    expect(llm.cancel).not.toHaveBeenCalled();
    expect(llm.send).toHaveBeenCalledTimes(1);

    $<HTMLFormElement>('#composer').requestSubmit($<HTMLButtonElement>('#send'));
    expect(llm.cancel).toHaveBeenCalledWith(first);
  });
});

describe('threads', () => {
  it('names the app and the project on screen in the window title', async () => {
    // A general chat is the app's name alone
    expect(document.title).toBe('ch');

    await newThread('/projects/demo');
    expect(document.title).toBe('ch — demo');

    // Back to a thread without a workspace
    $$('#thread-list li.thread')[1].click();
    expect(document.title).toBe('ch');
  });

  it('keeps each thread with its own messages', async () => {
    await type('first thread');
    emit(sentId(), { type: 'text', delta: 'First answer.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await newThread();
    expect(messages()).toEqual([]);
    await type('second thread');
    expect(threadTitles()).toEqual(['second thread', 'first thread']);

    $$('#thread-list li.thread')[1].click();
    expect($('#thread-title').textContent).toBe('first thread');
    expect(messages()).toEqual(['user: first thread', 'assistant: First answer.']);
    expect($('#send').textContent).toBe('Send');
  });

  it('keeps streaming into a thread that is not on screen', async () => {
    await type('background');
    const id = sentId();
    await newThread();
    emit(id, { type: 'text', delta: 'Still here.' });
    expect(messages()).toEqual([]);
    $$('#thread-list li.thread:not(.active)')[0].click();
    expect(messages()).toEqual(['user: background', 'assistant: Still here.']);
  });

  it('will not delete a thread that is being written into: a reply half lost is lost', async () => {
    await type('doomed');
    const threadId = sent().thread;
    await newThread();
    const del = (n: number) => $$<HTMLButtonElement>('#thread-list .delete')[n];
    // Working, so it is at the top
    expect(del(0).disabled).toBe(true);
    expect(del(0).title).toBe('Stop the reply before deleting this thread');

    del(0).click();
    expect(threads.remove).not.toHaveBeenCalled();
    expect(threadTitles()).toHaveLength(2);

    // Once the reply is over it can go, and its container goes with it. Its thread has an
    // update, so it has moved to the top
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
    expect(del(0).disabled).toBe(false);
    del(0).click();
    expect(threads.remove).toHaveBeenCalledWith(threadId);
    expect(threadTitles()).toEqual(['New thread']);
  });

  it('cancels the reply of a thread stopped first, and then deleted', async () => {
    await type('doomed');
    const id = sentId();
    await newThread();
    emit(id, { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
    // The stopped thread has an update, so it is at the top
    $$<HTMLButtonElement>('#thread-list .delete')[0].click();
    expect(threadTitles()).toEqual(['New thread']);
  });

  describe('the new-thread pop-up', () => {
    const popup = () => $<HTMLDialogElement>('#new-thread-dialog');
    const startButton = () => $<HTMLButtonElement>('#start-in-workspace');
    const dropdown = () => $<HTMLSelectElement>('#recent-workspaces');

    it('opens instead of creating a thread straight away, and Cancel creates none', () => {
      $('#new-thread').click();
      expect(popup().open).toBe(true);
      expect(threadTitles()).toEqual(['New thread']);
      expect(threads.chooseWorkspace).not.toHaveBeenCalled();

      $('#new-thread-cancel').click();
      expect(popup().open).toBe(false);
      expect(saved().threads).toHaveLength(1);
    });

    it('has nothing to start in until a workspace is browsed for', async () => {
      $('#new-thread').click();
      expect(recentWorkspaces()).toEqual(['No recent workspaces']);
      expect(dropdown().disabled).toBe(true);
      expect(startButton().disabled).toBe(true);

      await browse('/projects/demo');
      expect(recentWorkspaces()).toEqual(['/projects/demo']);
      expect(startButton().disabled).toBe(false);
      // Browsing alone starts nothing
      expect(popup().open).toBe(true);
      expect(saved().threads).toHaveLength(1);
    });

    it('lists the workspaces threads were started in, most recently used first', async () => {
      await newThread('/projects/one');
      await newThread('/projects/two');
      await newThread('/projects/one');
      $('#new-thread').click();
      expect(recentWorkspaces()).toEqual(['/projects/one', '/projects/two']);
      expect(dropdown().value).toBe('/projects/one');
      expect(threads.chooseWorkspace).toHaveBeenCalledTimes(2);
    });

    it('starts in the workspace picked from the dropdown, without the system dialog', async () => {
      await newThread('/projects/one');
      await newThread('/projects/two');
      threads.chooseWorkspace.mockClear();

      $('#new-thread').click();
      dropdown().value = '/projects/one';
      startButton().click();
      expect(popup().open).toBe(false);
      expect(saved().threads[0].workspace).toBe('/projects/one');
      expect(saved().recentWorkspaces).toEqual(['/projects/one', '/projects/two']);
      expect(threads.chooseWorkspace).not.toHaveBeenCalled();
    });

    it('puts a browsed workspace at the top of the dropdown, selected, once', async () => {
      await newThread('/projects/one');
      await newThread('/projects/two');
      $('#new-thread').click();
      await browse('/projects/new');
      expect(recentWorkspaces()).toEqual(['/projects/new', '/projects/two', '/projects/one']);
      expect(dropdown().value).toBe('/projects/new');
      await browse('/projects/one');
      expect(recentWorkspaces()).toEqual(['/projects/one', '/projects/new', '/projects/two']);
    });

    it('changes nothing when the system dialog is backed out of', async () => {
      await newThread('/projects/one');
      $('#new-thread').click();
      await browse(null);
      expect(recentWorkspaces()).toEqual(['/projects/one']);
      expect(popup().open).toBe(true);
    });

    it('does not remember a workspace that was browsed for but not started in', async () => {
      $('#new-thread').click();
      await browse('/projects/demo');
      $('#new-thread-cancel').click();
      $('#new-thread').click();
      expect(recentWorkspaces()).toEqual(['No recent workspaces']);
    });

    it('starts a general chat: a thread with no workspace, files or search', async () => {
      await newThread('/projects/one');
      threads.open.mockClear();
      $('#new-thread').click();
      $('#general-chat').click();
      expect(popup().open).toBe(false);
      expect(saved().threads).toHaveLength(3);
      expect(saved().threads[0]).not.toHaveProperty('workspace');
      expect(threads.open).not.toHaveBeenCalled();
      expect(saved().recentWorkspaces).toEqual(['/projects/one']);
    });

    it('keeps only the eight most recent workspaces', async () => {
      for (let i = 1; i <= 10; i++) await newThread(`/projects/p${i}`);
      $('#new-thread').click();
      expect(recentWorkspaces()).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map((i) => `/projects/p${i}`));
    });

    it('offers the workspaces of threads saved before recent workspaces were kept', async () => {
      await newThread('/projects/one');
      await newThread('/projects/two');
      const state = saved();
      delete state.recentWorkspaces;
      onDisk = JSON.stringify(state);
      await start();
      $('#new-thread').click();
      expect(recentWorkspaces()).toEqual(['/projects/two', '/projects/one']);
    });
  });

  it('saves the workspace with the new thread, and shows it', async () => {
    await newThread('/projects/demo');
    expect(threads.chooseWorkspace).toHaveBeenCalledOnce();
    expect(saved().threads.map((t: { workspace?: string }) => t.workspace)).toEqual(['/projects/demo', undefined]);
    expect($('#thread-workspace').textContent).toBe('demo');
    expect($('#thread-workspace').title).toBe('/projects/demo');
    expect($$('#thread-list li.thread').map((li) => li.title)).toEqual(['/projects/demo', '']);

    $$('#thread-list li.thread')[1].click();
    expect($('#thread-workspace').textContent).toBe('');
  });

  it("sends the thread's workspace with its messages", async () => {
    await newThread('/projects/demo');
    await type('what is in here?');
    expect(sent().workspace).toBe('/projects/demo');
  });

  it('creates a thread without a workspace for a general chat', async () => {
    await type('first thread');
    await newThread(null);
    // The first is still replying, which keeps it at the top
    expect(threadTitles()).toEqual(['first thread', 'New thread']);
    expect(saved().threads[0]).not.toHaveProperty('workspace');
    expect($('#thread-workspace').textContent).toBe('');

    await type('no workspace here');
    expect(sent().workspace).toBeUndefined();
  });

  it('keeps the workspace after a restart', async () => {
    await newThread('/projects/demo');
    await start();
    expect($('#thread-workspace').title).toBe('/projects/demo');
  });

  it('has the search server started whenever a thread with a workspace comes on screen', async () => {
    expect(threads.open).not.toHaveBeenCalled();
    await newThread('/projects/demo');
    const id = saved().threads[0].id;
    expect(threads.open.mock.calls).toEqual([[id, '/projects/demo']]);

    // Switching to the thread without a workspace, and back
    $$('#thread-list li.thread:not(.active)')[0].click();
    expect(threads.open).toHaveBeenCalledTimes(1);
    $$('#thread-list li.thread:not(.active)')[0].click();
    expect(threads.open).toHaveBeenCalledTimes(2);

    // Reopening the app on it
    await start();
    expect(threads.open).toHaveBeenCalledTimes(3);
    expect(threads.open).toHaveBeenLastCalledWith(id, '/projects/demo');
  });

  describe('a thread on a branch', () => {
    // Opens the pop-up on the demo workspace, which has these branches
    async function openOnBranches() {
      threads.branches.mockResolvedValue({ current: 'main', names: ['main', 'feature'] });
      $('#new-thread').click();
      await browse('/projects/demo');
    }
    const choice = () => $<HTMLSelectElement>('#branch-choice');
    const submit = async () => {
      $<HTMLFormElement>('#new-thread-form').requestSubmit();
      await flush();
    };

    it('sends its worktree, not the repo root, to the main process and the harness', async () => {
      threads.prepareBranch.mockResolvedValue('/worktrees/feature');
      await openOnBranches();
      expect($('#branch-section').hidden).toBe(false);
      choice().value = 'feature';
      await submit();

      expect(threads.prepareBranch).toHaveBeenCalledWith('/projects/demo', 'feature', 'main', false);
      const [thread] = saved().threads;
      expect(thread.workspace).toBe('/projects/demo');
      expect(thread.branch).toEqual({ name: 'feature', base: 'main', worktree: '/worktrees/feature' });
      expect(threads.open).toHaveBeenCalledWith(thread.id, '/worktrees/feature');
      expect($('#thread-workspace').title).toBe('/projects/demo');

      await type('hello');
      expect(sent().workspace).toBe('/worktrees/feature');
    });

    it('writes the changes to the worktree', async () => {
      threads.prepareBranch.mockResolvedValue('/worktrees/feature');
      threads.changes.mockResolvedValue({
        files: [{ path: 'a.ts', status: 'modified', binary: false, diff: '@@ -1 +1 @@\n-a\n+b' }],
      });
      await openOnBranches();
      choice().value = 'feature';
      await submit();
      await type('hello');
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      $('#thread-changes').click();
      await flush();
      $('#changes-apply').click();
      await flush();
      expect(threads.applyChanges).toHaveBeenCalledWith(saved().activeId, '/worktrees/feature');
    });

    it('makes a new branch from the current one, and says why it could not', async () => {
      threads.prepareBranch.mockRejectedValueOnce(new Error('A branch called "x" already exists.'));
      await openOnBranches();
      choice().value = '+new';
      choice().dispatchEvent(new Event('change'));
      expect($('#branch-name').hidden).toBe(false);

      const beforeThreads = saved().threads.length;
      await submit();
      expect($('#branch-error').textContent).toBe('Give the new branch a name.');
      expect(threads.prepareBranch).not.toHaveBeenCalled();

      $<HTMLInputElement>('#branch-name').value = 'x';
      await submit();
      expect(threads.prepareBranch).toHaveBeenCalledWith('/projects/demo', 'x', 'main', true);
      expect($('#branch-error').textContent).toBe('A branch called "x" already exists.');
      expect($('#branch-error').hidden).toBe(false);
      expect($<HTMLDialogElement>('#new-thread-dialog').open).toBe(true);
      expect(saved().threads.length).toEqual(beforeThreads);
    });

    it('is not offered for a folder that is not a Git repository', async () => {
      $('#new-thread').click();
      await browse('/projects/demo');
      expect($('#branch-section').hidden).toBe(true);
    });

    const finishReply = () =>
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    // A thread on the feature branch that has said something and been answered
    async function onFeature(title: string) {
      threads.prepareBranch.mockResolvedValue('/worktrees/feature');
      await openOnBranches();
      choice().value = 'feature';
      await submit();
      await type(title);
      finishReply();
      await flush();
    }
    const branchOf = (title: string) => saved().threads.find((t) => t.title === title)!.branch;

    describe('in the changes dialog', () => {
      const standing = (over = {}) =>
        threads.branchStatus.mockResolvedValue({ upstream: null, ahead: 0, behind: 0, dirty: false, ...over });
      const openChanges = async () => {
        $('#thread-changes').click();
        await flush();
      };
      const click = async (id: string) => {
        $(id).click();
        await flush();
      };
      const disabled = () =>
        ['#changes-commit', '#changes-push', '#changes-pull'].map((id) => $<HTMLButtonElement>(id).disabled);

      it('is left out for a thread that is not on a branch', async () => {
        await newThread('/projects/demo');
        await type('plain');
        finishReply();
        await flush();
        await openChanges();
        expect($('#changes-branch').hidden).toBe(true);
        expect(threads.branchStatus).not.toHaveBeenCalled();
      });

      it('says how far ahead of and behind its upstream the branch is, and keeps the upstream', async () => {
        standing({ upstream: 'origin/feature', ahead: 2, behind: 1 });
        await onFeature('hello');
        await openChanges();
        expect($('#changes-branch').hidden).toBe(false);
        expect(threads.branchStatus).toHaveBeenCalledWith('/worktrees/feature');
        expect($('#changes-branch-status').textContent).toBe('feature — 2 ahead, 1 behind · origin/feature');
        // Nothing to commit; commits to push, and commits to pull
        expect(disabled()).toEqual([true, false, false]);
        expect(branchOf('hello')?.upstream).toBe('origin/feature');
      });

      it('says when the branch has not been pushed, or has work that is not committed', async () => {
        standing({ dirty: true });
        await onFeature('hello');
        await openChanges();
        expect($('#changes-branch-status').textContent).toBe('feature — uncommitted changes, not pushed yet');
        // The commit message starts from the thread's title
        expect($<HTMLInputElement>('#changes-commit-message').value).toBe('hello');
        expect(disabled()).toEqual([false, false, true]);
        $<HTMLInputElement>('#changes-commit-message').value = '  ';
        $('#changes-commit-message').dispatchEvent(new Event('input'));
        expect(disabled()[0]).toBe(true);
      });

      it('commits what the worktree has with the message, and looks again', async () => {
        standing({ dirty: true });
        threads.commitBranch.mockResolvedValue(true);
        await onFeature('hello');
        await openChanges();
        $<HTMLInputElement>('#changes-commit-message').value = 'Add hello';
        standing({ dirty: false, ahead: 1, upstream: 'origin/feature' });
        await click('#changes-commit');
        expect(threads.commitBranch).toHaveBeenCalledWith('/worktrees/feature', 'Add hello');
        expect($('#changes-status').textContent).toBe('Committed.');
        expect($('#changes-branch-status').textContent).toBe('feature — 1 ahead · origin/feature');

        // Someone else committed it in the meantime: the button was on offer, and there is nothing left to do
        threads.commitBranch.mockResolvedValue(false);
        standing({ dirty: true });
        await openChanges();
        await click('#changes-commit');
        expect($('#changes-status').textContent).toBe('Nothing to commit.');
      });

      it('pushes the branch and records where it went', async () => {
        standing();
        threads.pushBranch.mockResolvedValue('origin/feature');
        await onFeature('hello');
        await openChanges();
        expect(branchOf('hello')?.upstream).toBeUndefined();
        standing({ upstream: 'origin/feature' });
        await click('#changes-push');
        expect(threads.pushBranch).toHaveBeenCalledWith('/worktrees/feature');
        expect($('#changes-status').textContent).toBe('Pushed to origin/feature.');
        expect(branchOf('hello')?.upstream).toBe('origin/feature');
        expect($('#changes-branch-status').textContent).toBe('feature — up to date · origin/feature');
        // Nothing more to push
        expect(disabled()).toEqual([true, true, true]);
      });

      it('pulls what the upstream has, and says why when it cannot', async () => {
        standing({ upstream: 'origin/feature', behind: 2 });
        threads.pullBranch.mockResolvedValue(undefined);
        await onFeature('hello');
        await openChanges();
        standing({ upstream: 'origin/feature' });
        await click('#changes-pull');
        expect(threads.pullBranch).toHaveBeenCalledWith('/worktrees/feature');
        expect($('#changes-status').textContent).toBe('Pulled.');

        standing({ upstream: 'origin/feature', behind: 2 });
        await openChanges();
        threads.pullBranch.mockRejectedValue(new Error('Not possible to fast-forward'));
        await click('#changes-pull');
        expect($('#changes-status').textContent).toBe('Could not pull: Not possible to fast-forward');
      });

      it('says why git refused a push, and leaves the buttons to try again', async () => {
        standing();
        threads.pushBranch.mockRejectedValue(new Error('rejected: non-fast-forward'));
        await onFeature('hello');
        await openChanges();
        await click('#changes-push');
        expect($('#changes-status').textContent).toBe('Could not push: rejected: non-fast-forward');
        expect($<HTMLButtonElement>('#changes-push').disabled).toBe(false);
        expect(branchOf('hello')?.upstream).toBeUndefined();
      });

      it("shows why the branch's state cannot be told, and offers nothing", async () => {
        threads.branchStatus.mockRejectedValue(new Error('fatal: not a git repository'));
        await onFeature('hello');
        await openChanges();
        expect($('#changes-branch-status').textContent).toBe('feature — fatal: not a git repository');
        expect(disabled()).toEqual([true, true, true]);
      });
    });

    describe('in the sidebar', () => {
      // The threads, and a branch's heading as "[name]", leaving the workspaces' own headings out
      const rows = () =>
        $$('#thread-list li')
          .filter((li) => li.matches('li.thread, li.group.branch'))
          .map((li) =>
            li.matches('.group')
              ? `[${li.querySelector('.label')!.textContent}]`
              : li.querySelector('.name')!.textContent
          )
          .filter((row) => row !== 'New thread');

      it('puts a branch under its own heading after the threads that are not on one', async () => {
        await onFeature('on feature');
        await newThread('/projects/demo');
        await type('plain');
        finishReply();
        await flush();
        expect(rows()).toEqual(['plain', '[feature]', 'on feature']);
        expect($('#thread-list li.group.branch').title).toBe('feature (from main, not pushed)');
      });

      it('keeps the threads on a branch together, whatever order they were started in', async () => {
        await onFeature('one');
        await newThread('/projects/demo');
        await type('plain');
        finishReply();
        await flush();
        await onFeature('two');
        expect(rows().filter((row) => row === '[feature]')).toHaveLength(1);
        expect(rows().slice(0, 2)).toEqual(['plain', '[feature]']);
        expect(rows().slice(2).sort()).toEqual(['one', 'two']);
      });

      // What a subagent does with create_branch and enter_branch (see tools/branches.ts): the thread it is working
      // in moves under the branch's heading, and the branch's worktree is the folder it works from after that
      it('moves a thread under a new heading when a subagent puts it on a branch', async () => {
        await newThread('/projects/demo');
        await type('plain');
        expect(rows()).toEqual(['plain']);
        threads.open.mockClear();

        const branch = { name: 'spin-off', base: 'main', worktree: '/worktrees/spin-off' };
        emit(sentId(), { type: 'branch', branch });
        finishReply();
        await flush();

        expect(rows()).toEqual(['[spin-off]', 'plain']);
        expect($('#thread-list li.group.branch').title).toBe('spin-off (from main, not pushed)');
        expect(branchOf('plain')).toEqual(branch);
        expect(threads.open).toHaveBeenCalledWith(saved().threads[0].id, '/worktrees/spin-off');
      });

      it('unfolds a branch group that was left folded under the same name', async () => {
        await onFeature('on feature');
        $('#thread-list li.group.branch').click();
        expect(saved().collapsed).toContain('/projects/demo#feature');

        await newThread('/projects/demo');
        await type('plain');
        emit(sentId(), { type: 'branch', branch: { name: 'feature', base: 'main', worktree: '/worktrees/feature' } });
        finishReply();
        await flush();
        expect(saved().collapsed ?? []).not.toContain('/projects/demo#feature');
        expect(rows()).toEqual(['[feature]', 'plain', 'on feature']);
      });

      it('has no heading for a workspace whose threads are not on branches', async () => {
        await newThread('/projects/demo');
        await type('plain');
        finishReply();
        await flush();
        expect(rows()).toEqual(['plain']);
      });

      it('names where the branch was pushed in its tooltip', async () => {
        threads.branchStatus.mockResolvedValue({ upstream: 'origin/feature', ahead: 0, behind: 0, dirty: false });
        await onFeature('on feature');
        $('#thread-changes').click();
        await flush();
        $('#changes-close').click();
        expect($('#thread-list li.group.branch').title).toBe('feature → origin/feature');
      });

      it('folds a branch away when its heading is clicked, and remembers it', async () => {
        await onFeature('on feature');
        $('#thread-list li.group.branch').click();
        expect(rows()).toEqual(['[feature]']);
        expect($('#thread-list li.group.branch').classList.contains('collapsed')).toBe(true);
        expect(saved().collapsed).toContain('/projects/demo#feature');

        $('#thread-list li.group.branch').click();
        expect(rows()).toEqual(['[feature]', 'on feature']);
        expect(saved().collapsed ?? []).not.toContain('/projects/demo#feature');
      });

      it('shows a folded branch the way a folded workspace does, when something in it is going on', async () => {
        await onFeature('on feature');
        $('#thread-list li.group.branch').click();
        expect($('#thread-list li.group.branch .status')).toBeNull();
        $('#thread-list li.group.branch').click();
        // A reply on its way, and then the branch folded over it
        await type('busy');
        $('#thread-list li.group.branch').click();
        expect($('#thread-list li.group.branch .status').classList.contains('working')).toBe(true);
      });

      it('opens a branch again when a new thread is started on it', async () => {
        await onFeature('one');
        $('#thread-list li.group.branch').click();
        await onFeature('two');
        expect(saved().collapsed ?? []).not.toContain('/projects/demo#feature');
        expect(rows()).toContain('two');
      });
    });

    describe('when a thread on it is deleted', () => {
      const remove = (title: string) =>
        $$('#thread-list li.thread')
          .find((li) => li.querySelector('.name')!.textContent === title)!
          .querySelector<HTMLElement>('.delete')!
          .click();

      it("takes the branch's worktree away with the last thread on it", async () => {
        await onFeature('one');
        await onFeature('two');
        remove('one');
        expect(threads.removeWorktree).not.toHaveBeenCalled();
        remove('two');
        expect(threads.removeWorktree).toHaveBeenCalledTimes(1);
        expect(threads.removeWorktree).toHaveBeenCalledWith('/projects/demo', '/worktrees/feature');
      });

      it('leaves the worktree alone for a thread that is not on a branch', async () => {
        await newThread('/projects/demo');
        await type('plain');
        finishReply();
        await flush();
        remove('plain');
        expect(threads.removeWorktree).not.toHaveBeenCalled();
      });

      it('carries on when git will not take the worktree away', async () => {
        threads.removeWorktree.mockRejectedValue(new Error('contains modified or untracked files'));
        await onFeature('one');
        remove('one');
        await flush();
        expect(threads.removeWorktree).toHaveBeenCalled();
        expect(saved().threads.some((t) => t.title === 'one')).toBe(false);
      });
    });
  });

  it('starts the search server for the thread that takes over from a deleted one', async () => {
    await newThread('/projects/demo');
    await newThread(null);
    threads.open.mockClear();
    $$('#thread-list .delete')[0].click();
    expect(threads.open).toHaveBeenCalledWith(saved().threads[0].id, '/projects/demo');
  });

  describe('the sidebar', () => {
    // The list as it reads: "[Group]" headings and the threads under them,
    // with "~" in front of one that is replying and "*" on one with an unread reply
    const sidebar = () =>
      $$('#thread-list li').map((li) => {
        if (li.classList.contains('group')) {
          const status = li.querySelector('.status');
          const mark = status?.classList.contains('working') ? '~' : status?.classList.contains('unread') ? '*' : '';
          const label = li.querySelector('.label')!.textContent;
          return `${mark}[${label}]${li.classList.contains('collapsed') ? ' (collapsed)' : ''}`;
        }
        if (li.classList.contains('archived')) return '(archived)';
        const status = li.querySelector('.status');
        const mark = status?.classList.contains('working') ? '~' : status?.classList.contains('unread') ? '*' : '';
        return `${mark}${li.querySelector('.name')!.textContent}`;
      });
    const finish = (id: string) =>
      emit(id, { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    const open = (title: string) =>
      $$('#thread-list li.thread')
        .find((li) => li.querySelector('.name')!.textContent === title)!
        .click();

    it('groups threads by workspace, with general chats together', async () => {
      await type('general one');
      finish(sentId());
      await newThread('/projects/alpha');
      await type('alpha one');
      finish(sentId());
      await newThread(null);
      await type('general two');
      finish(sentId());
      await newThread('/work/beta');
      await type('beta one');
      finish(sentId());
      await newThread('/projects/alpha');
      await type('alpha two');
      finish(sentId());

      expect(sidebar()).toEqual([
        '[alpha]',
        'alpha two',
        'alpha one',
        '[beta]',
        'beta one',
        '[General chat]',
        'general two',
        'general one',
      ]);
      expect($$('#thread-list li.group').map((g) => g.title)).toEqual(['/projects/alpha', '/work/beta', '']);
    });

    it('keeps workspaces with the same name apart', async () => {
      await newThread('/a/site');
      await newThread('/b/site');
      expect(sidebar()).toEqual(['[site]', 'New thread', '[site]', 'New thread', '[General chat]', 'New thread']);
    });

    describe("a group's + button", () => {
      const add = (name: string) =>
        $$('#thread-list li.group')
          .find((g) => g.querySelector('.label')!.textContent === name)!
          .querySelector<HTMLButtonElement>('.add')!;

      beforeEach(async () => {
        await type('general');
        finish(sentId());
        await newThread('/projects/alpha');
        await type('alpha one');
        finish(sentId());
        threads.chooseWorkspace.mockClear();
        threads.open.mockClear();
      });

      it('starts a thread in that workspace straight away, without the pop-up', () => {
        expect(add('alpha').title).toBe('New thread in alpha');
        add('alpha').click();
        expect($<HTMLDialogElement>('#new-thread-dialog').open).toBe(false);
        expect(threads.chooseWorkspace).not.toHaveBeenCalled();
        expect(sidebar()).toEqual(['[alpha]', 'New thread', 'alpha one', '[General chat]', 'general']);
        expect(saved().threads[0].workspace).toBe('/projects/alpha');
        expect($('#thread-title').textContent).toBe('New thread');
        // Its workspace's search server is started like any other thread's
        expect(threads.open).toHaveBeenCalledWith(saved().threads[0].id, '/projects/alpha');
      });

      it('starts a general chat from the general section', () => {
        expect(add('General chat').title).toBe('New general chat');
        add('General chat').click();
        expect(sidebar()).toEqual(['[General chat]', 'New thread', 'general', '[alpha]', 'alpha one']);
        expect(saved().threads[0]).not.toHaveProperty('workspace');
        expect(threads.open).not.toHaveBeenCalled();
      });

      it('does not collapse the group, and opens it if it was collapsed', () => {
        add('alpha').click();
        expect(sidebar()).not.toContain('[alpha] (collapsed)');

        $$('#thread-list li.group')[0].click();
        expect(sidebar()[0]).toBe('[alpha] (collapsed)');
        add('alpha').click();
        expect(sidebar().slice(0, 4)).toEqual(['[alpha]', 'New thread', 'New thread', 'alpha one']);
      });
    });

    describe('collapsing a group', () => {
      const heading = (name: string) =>
        $$('#thread-list li.group').find((g) => g.querySelector('.label')!.textContent === name)!;

      beforeEach(async () => {
        await type('general');
        finish(sentId());
        await newThread('/projects/alpha');
        await type('alpha one');
        finish(sentId());
        await newThread('/projects/alpha');
      });

      it('hides the threads in that workspace, and expanding shows them again', () => {
        expect(heading('alpha').getAttribute('aria-expanded')).toBe('true');
        heading('alpha').click();
        expect(sidebar()).toEqual(['[alpha] (collapsed)', '[General chat]', 'general']);
        expect(heading('alpha').getAttribute('aria-expanded')).toBe('false');

        heading('alpha').click();
        expect(sidebar()).toEqual(['[alpha]', 'New thread', 'alpha one', '[General chat]', 'general']);
      });

      it('works for general chats, and leaves the thread on screen as it is', () => {
        open('general');
        heading('General chat').click();
        // Opened last, so its group is first
        expect(sidebar()).toEqual(['[General chat] (collapsed)', '[alpha]', 'New thread', 'alpha one']);
        expect($('#thread-title').textContent).toBe('general');
      });

      it('is remembered after a restart', async () => {
        heading('alpha').click();
        await start();
        expect(sidebar()).toEqual(['[alpha] (collapsed)', '[General chat]', 'general']);
      });

      it('opens again for a new thread started in that workspace', async () => {
        heading('alpha').click();
        await newThread('/projects/alpha');
        expect(sidebar()).toEqual(['[alpha]', 'New thread', 'New thread', 'alpha one', '[General chat]', 'general']);
      });

      it('shows on the heading that a hidden thread is replying or has an unread reply', async () => {
        await type('alpha two');
        const id = sentId();
        open('general');
        heading('alpha').click();
        expect(sidebar()).toEqual(['~[alpha] (collapsed)', '[General chat]', 'general']);

        finish(id);
        expect(sidebar()).toEqual(['*[alpha] (collapsed)', '[General chat]', 'general']);

        heading('alpha').click();
        expect(sidebar()).toEqual(['[alpha]', '*alpha two', 'alpha one', '[General chat]', 'general']);
      });
    });

    it('marks a thread while its reply is in progress', async () => {
      expect(sidebar()).toEqual(['[General chat]', 'New thread']);
      await type('question');
      expect(sidebar()).toEqual(['[General chat]', '~question']);
      expect($('#thread-list .status').title).toBe('Replying…');

      emit(sentId(), { type: 'text', delta: 'Answer.' });
      expect(sidebar()).toEqual(['[General chat]', '~question']);
      finish(sentId());
      expect(sidebar()).toEqual(['[General chat]', 'question']);
    });

    it('marks a thread whose reply finished while another was on screen, until it is opened', async () => {
      await type('background');
      const id = sentId();
      await newThread(null);
      // Working, so above the thread on screen
      expect(sidebar()).toEqual(['[General chat]', '~background', 'New thread']);

      emit(id, { type: 'text', delta: 'Done.' });
      finish(id);
      expect(sidebar()).toEqual(['[General chat]', '*background', 'New thread']);
      expect($('#thread-list .status').title).toBe('New reply');

      // Read, it goes to the top of the threads with nothing going on
      open('background');
      expect(sidebar()).toEqual(['[General chat]', 'background', 'New thread']);
    });

    it('marks a background thread as unread when its reply failed, too', async () => {
      await type('background');
      const id = sentId();
      await newThread(null);
      emit(id, { type: 'error', code: 'other', message: 'Connection lost.' });
      expect(sidebar()).toEqual(['[General chat]', '*background', 'New thread']);
    });

    describe('notifications', () => {
      const shown: { title: string; options: NotificationOptions; click?: () => void }[] = [];

      beforeEach(() => {
        shown.length = 0;
        vi.stubGlobal(
          'Notification',
          class {
            static permission = 'granted';
            constructor(title: string, options: NotificationOptions) {
              shown.push({ title, options });
            }
            addEventListener(_type: string, listener: () => void): void {
              shown[shown.length - 1].click = listener;
            }
          }
        );
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('tells the user of a reply that finished in a thread that is not showing', async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        emit(id, { type: 'text', delta: 'Done.' });
        finish(id);
        expect(shown.map(({ title, options }) => [title, options.body])).toEqual([['background', 'Finished replying']]);
      });

      it('says what went wrong when the reply failed', async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        emit(id, { type: 'error', code: 'other', message: 'Connection lost.' });
        expect(shown.map(({ options }) => options.body)).toEqual(['Failed: Connection lost.']);
      });

      it('says nothing of a reply in the thread on screen, in a window that has focus', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        await type('question');
        finish(sentId());
        expect(shown).toEqual([]);
      });

      it('tells the user of a reply finished on screen in a window that has not focus', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        await type('question');
        finish(sentId());
        expect(shown).toHaveLength(1);
      });

      it('says nothing of a reply the user stopped', async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        emit(id, { type: 'done', stopReason: 'cancelled', steps: 0 });
        expect(shown).toEqual([]);
      });

      it('brings the thread up when the notification is clicked', async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        finish(id);
        // The reply finishing moved it to the top, where its unread mark is
        expect(sidebar()).toEqual(['[General chat]', '*background', 'New thread']);

        shown[0].click?.();
        // Showing, and so no longer unread
        expect(sidebar()).toEqual(['[General chat]', 'background', 'New thread']);
      });

      it('brings the window forward when the notification is clicked', async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        finish(id);
        shown[0].click?.();
        // The page cannot raise itself: the window is asked for (see host:show
        // in main.ts). window.focus() does nothing from another app.
        expect(host.show).toHaveBeenCalled();
      });

      it("puts the number of unread threads on the app's icon", async () => {
        await type('background');
        const id = sentId();
        await newThread(null);
        // Nothing is unread yet, and the icon has been told so: the page says
        // the count once at startup, whatever it is, so that a badge left on
        // the icon from before a reload is cleared (see badged in events.ts)
        expect(host.badge).toHaveBeenLastCalledWith(0);
        finish(id);
        expect(host.badge).toHaveBeenLastCalledWith(1);
        // Opened, so nothing is unread any more
        shown[0].click?.();
        expect(host.badge).toHaveBeenLastCalledWith(0);
      });

      // The count and the notification each used to decide for themselves
      // whether the user was looking, and disagreed: the notification asked
      // about the window's focus and the count did not, so a reply landing in
      // the open thread while the user was in another app was announced and
      // never counted (see watching in src/renderer/events.ts). One thread
      // open is the ordinary case, so that was most replies.
      it('counts a reply finished in the open thread when the window has not focus', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        await type('question');
        finish(sentId());
        expect(host.badge).toHaveBeenLastCalledWith(1);
        // ...which is the same moment it is notified about
        expect(shown).toHaveLength(1);
      });

      it('counts nothing of a reply the user is sitting watching', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        await type('question');
        finish(sentId());
        expect(host.badge).toHaveBeenLastCalledWith(0);
        expect(shown).toEqual([]);
      });

      it('takes the count off again when the user comes back to the window', async () => {
        const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        await type('question');
        finish(sentId());
        expect(host.badge).toHaveBeenLastCalledWith(1);

        // Coming back is reading it: the thread is open already, so opening it
        // is not what would take the mark off
        focused.mockReturnValue(true);
        window.dispatchEvent(new Event('focus'));
        expect(host.badge).toHaveBeenLastCalledWith(0);
        expect(sidebar()).toEqual(['[General chat]', 'question']);
      });
    });

    it('still shows the unread mark after a restart', async () => {
      await type('background');
      const id = sentId();
      await newThread(null);
      finish(id);
      await start();
      expect(sidebar()).toEqual(['[General chat]', '*background', 'New thread']);
    });

    it('moves a thread with an update above threads that were active more recently', async () => {
      await type('older');
      const older = sentId();
      await newThread(null);
      await type('newer');
      finish(sentId());
      // Still working, which counts as much as an update
      expect(sidebar()).toEqual(['[General chat]', '~older', 'newer']);

      finish(older);
      expect(sidebar()).toEqual(['[General chat]', '*older', 'newer']);
    });

    it('orders threads that are read by how recently they were opened or active', async () => {
      // Only the clock is stood still, so that each step is a moment of its own
      vi.useFakeTimers({ toFake: ['Date'] });
      const tick = () => vi.setSystemTime(Date.now() + 1000);
      await type('first');
      finish(sentId());
      await newThread(null);
      tick();
      await type('second');
      finish(sentId());
      expect(sidebar()).toEqual(['[General chat]', 'second', 'first']);

      // Opening a thread is enough to put it at the top
      tick();
      open('first');
      expect(sidebar()).toEqual(['[General chat]', 'first', 'second']);

      tick();
      open('second');
      await type('more on second');
      finish(sentId());
      expect(sidebar()).toEqual(['[General chat]', 'second', 'first']);
      vi.useRealTimers();
    });

    describe('archiving', () => {
      // Eleven read threads in General chat, 'thread 0' opened longest ago and
      // 'thread 10' on screen; replies are left running in those named in `running`
      const eleven = async (running: string[] = []) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let i = 0; i <= 10; i++) {
          vi.setSystemTime(Date.now() + 1000);
          if (i > 0) await newThread(null);
          await type(`thread ${i}`);
          if (!running.includes(`thread ${i}`)) finish(sentId());
        }
        vi.useRealTimers();
      };

      it('archives the thread opened longest ago once a group has more than ten', async () => {
        await eleven();
        expect(threadTitles()).toHaveLength(10);
        expect(threadTitles()).not.toContain('thread 0');
        await vi.waitFor(() => expect(saved().threads.find((t: any) => t.title === 'thread 0').archived).toBe(true), {
          timeout: 3000,
        });
      });

      it('keeps a thread that is working or has something to look at, and archives the next instead', async () => {
        await eleven(['thread 0']);
        expect(threadTitles()[0]).toBe('thread 0');
        expect(threadTitles()).toHaveLength(10);
        expect(threadTitles()).not.toContain('thread 1');
      });

      it('counts each workspace on its own', async () => {
        await eleven();
        await newThread('/projects/alpha');
        expect(sidebar()).toContain('[alpha]');
        expect(threadTitles()).toHaveLength(11);
      });

      it('tells the group that older threads are archived and can be searched for', async () => {
        await eleven();
        expect($$('#thread-list li.archived').map((li) => li.textContent)).toEqual([
          'Older threads have been archived. You can still find them in search.',
        ]);
        await newThread('/projects/alpha');
        expect($$('#thread-list li.archived')).toHaveLength(1);
      });

      it('says nothing when no thread has been archived', async () => {
        await type('hello');
        expect($$('#thread-list li.archived')).toHaveLength(0);
      });
    });

    it('puts the workspace with an updated thread first', async () => {
      await type('general');
      const id = sentId();
      await newThread('/projects/alpha');
      await type('alpha one');
      finish(sentId());
      expect(sidebar()).toEqual(['[General chat]', '~general', '[alpha]', 'alpha one']);

      finish(id);
      expect(sidebar()).toEqual(['[General chat]', '*general', '[alpha]', 'alpha one']);
    });
  });

  it('always leaves one thread', () => {
    const before = saved().threads[0].id;
    $('#thread-list .delete').click();
    expect(threadTitles()).toEqual(['New thread']);
    expect(saved().threads[0].id).not.toBe(before);
  });
});

describe('persistence', () => {
  it('restores threads after a restart, dropping the empty bubble of a reply that never arrived', async () => {
    await type('question one');
    emit(sentId(), { type: 'text', delta: 'Answer one.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await type('question two');

    await start();
    expect(messages().slice(0, 3)).toEqual(['user: question one', 'assistant: Answer one.', 'user: question two']);
    // The bubble that nothing had arrived in is gone, and nothing stands in
    // for it: the reply is asked for again instead, which is what the thread
    // is busy with now (see "picking up a reply the app closed on")
    expect(messages().filter((m) => m.startsWith('assistant:'))).toEqual(['assistant: Answer one.']);
    expect($('#send').textContent).toBe('Stop');
  });

  it('opens on a thread holding every kind of message, as saved by an earlier session', async () => {
    const usage = [{ purpose: 'reply', provider: 'local', model: 'llama3.2:3b', input: 10, output: 5, cost: 0 }];
    const state = {
      activeId: 't1',
      threads: [
        {
          id: 't1',
          title: 'Everything',
          workspace: '/projects/demo',
          usage: [{ provider: 'local', model: 'llama3.2:3b', input: 10, output: 5, cost: 0 }],
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'note', text: 'Earlier messages summarized', summary: 'They said hi.', thoughtId: 's1' },
            { role: 'note', text: 'Question · 1/5 Complexity · low effort · classified by m → llama3.2:3b (1/5)' },
            {
              role: 'note',
              text: 'Not classified → Opus (4/5)',
              unclassified: { id: 'u1', details: [['Reason', 'timed out']] },
            },
            { role: 'thought', text: 'Looking.', thoughtId: 'th1' },
            { role: 'tool', text: 'Used read_file', callId: 'c1', inputSummary: 'path: a.txt', output: 'contents' },
            { role: 'tool', text: 'Used run_command (failed)', callId: 'c2', input: '{}', failure: 'no' },
            { role: 'tool', text: 'Used search_workspace', callId: 'c3', inputSummary: 'query: x' },
            { role: 'assistant', text: 'Here is **the answer**.' },
            { role: 'error', text: 'Then it broke.' },
            { role: 'note', text: 'Tokens: 10 in · 5 out · $0.00', usage, thoughtId: 'n1' },
          ],
        },
      ],
    };
    onDisk = JSON.stringify(state);
    await expect(start()).resolves.toBeUndefined();
    // The thought and the three tool calls are folded into one Work block
    expect($$('#messages .message')).toHaveLength(12);
    expect($('#messages .usage .label').textContent).toBe('Reply · llama3.2:3b');
    // The rest of the window was set up too
    await type('still works');
    expect(sent().messages.at(-1)).toEqual({ role: 'user', content: 'still works' });
  });

  it('opens on a thread whose work is marked with the step it was part of', async () => {
    const state = {
      activeId: 't1',
      threads: [
        {
          id: 't1',
          title: 'Phased',
          workspace: '/projects/demo',
          messages: [
            { role: 'user', text: 'change it' },
            { role: 'thought', text: 'Finding the file.', thoughtId: 'th1', phase: 'explore' },
            { role: 'tool', text: 'Used read_file', callId: 'c1', inputSummary: 'path: a.txt', phase: 'explore' },
            { role: 'assistant', text: 'Done.' },
          ],
        },
      ],
    };
    onDisk = JSON.stringify(state);
    // The first drawing happens while this module is still being evaluated, so
    // the words for the step must already be there to be read (see start)
    await expect(start()).resolves.toBeUndefined();
    expect($$('#messages .message.work.step > details > summary').map((el) => el.textContent)).toEqual([
      'Found out what this touches',
    ]);
  });

  it('starts fresh when the saved state is unreadable', async () => {
    onDisk = '{not json';
    await start();
    expect(threadTitles()).toEqual(['New thread']);
  });

  it("saves to disk through the main process, not in the window's own storage", async () => {
    await type('remember this');
    expect(localStorage.getItem('chat-state')).toBeNull();
    expect(saved().threads[0].messages[0]).toMatchObject({ role: 'user', text: 'remember this' });
  });

  it("picks up threads kept in the window's own storage by an earlier version, and moves them to disk", async () => {
    const old = {
      threads: [{ id: 't1', title: 'From before', messages: [{ role: 'user', text: 'old message' }] }],
      activeId: 't1',
    };
    localStorage.setItem('chat-state', JSON.stringify(old));
    onDisk = null;
    await start();
    expect(threadTitles()).toEqual(['From before']);
    expect(messages()).toEqual(['user: old message']);

    await type('new message');
    expect(saved().threads[0].messages.map((m: { text: string }) => m.text)).toContain('old message');
    // From then on the disk is what counts
    localStorage.clear();
    await start();
    expect(messages().slice(0, 2)).toEqual(['user: old message', 'user: new message']);
  });

  describe('while a reply is being written', () => {
    const replyOnDisk = () => saved().threads[0].messages.map((m: { text: string }) => m.text);

    beforeEach(async () => {
      vi.useFakeTimers();
      $<HTMLTextAreaElement>('#input').value = 'question';
      $<HTMLFormElement>('#composer').requestSubmit();
      threads.save.mockClear();
    });

    afterEach(() => vi.useRealTimers());

    it('saves what has arrived about once a second, not on every piece', () => {
      emit(sentId(), { type: 'text', delta: 'The answer ' });
      emit(sentId(), { type: 'text', delta: 'is 42' });
      expect(threads.save).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(threads.save).toHaveBeenCalledTimes(1);
      expect(replyOnDisk()).toContain('The answer is 42');

      emit(sentId(), { type: 'text', delta: ', more or less.' });
      vi.advanceTimersByTime(1000);
      expect(threads.save).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(5000);
      expect(threads.save).toHaveBeenCalledTimes(2);
    });

    it('keeps the part of a reply that arrived before the app went down', async () => {
      emit(sentId(), { type: 'text', delta: 'Half an ans' });
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await start();
      // ...and carries on from there (see "picking up a reply the app closed on")
      expect(messages().slice(0, 2)).toEqual(['user: question', 'assistant: Half an ans']);
    });

    it('saves at once, and only once, when the reply ends', () => {
      emit(sentId(), { type: 'text', delta: 'Done.' });
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      expect(threads.save).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(threads.save).toHaveBeenCalledTimes(1);
      expect(replyOnDisk()).toContain('Done.');
    });

    it('saves without delay, and waits for it, when the window is closing', () => {
      emit(sentId(), { type: 'text', delta: 'Cut off he' });
      window.dispatchEvent(new Event('beforeunload'));
      expect(threads.saveNow).toHaveBeenCalled();
      expect(replyOnDisk()).toContain('Cut off he');
    });
  });
});

describe('condensing the context', () => {
  const ask = async () => {
    await type('do it');
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'picked',
    });
  };

  it('says it is happening, then leaves "Context condensed" in the log after the words so far', async () => {
    await ask();
    emit(sentId(), { type: 'text', delta: 'Starting.' });
    emit(sentId(), { type: 'condensing' });
    expect(messages()).toEqual(['user: do it', 'assistant: Starting.', 'note: Condensing context…', 'work: Working…']);
    emit(sentId(), { type: 'condensed', changed: true });
    emit(sentId(), { type: 'text', delta: 'Done.' });
    expect(messages()).toEqual(['user: do it', 'assistant: Starting.', 'note: Context condensed', 'assistant: Done.']);
  });

  it('shows it as the reply’s status before anything is written, then logs it like a tool call', async () => {
    await ask();
    emit(sentId(), { type: 'condensing' });
    expect($('#messages').textContent).toContain('Condensing context…');
    emit(sentId(), { type: 'condensed', changed: true });
    expect($('#messages').textContent).not.toContain('Condensing context…');
    expect(messages().slice(0, 2)).toEqual(['user: do it', 'note: Context condensed']);
    emit(sentId(), { type: 'text', delta: 'Done.' });
    expect(messages().slice(0, 3)).toEqual(['user: do it', 'note: Context condensed', 'assistant: Done.']);
  });

  it('leaves nothing behind when nothing came of it', async () => {
    await ask();
    emit(sentId(), { type: 'text', delta: 'Starting.' });
    emit(sentId(), { type: 'condensing' });
    emit(sentId(), { type: 'condensed', changed: false });
    expect(messages().join('\n')).not.toContain('ondens');
  });
});

describe('being rate limited', () => {
  const limited = (after = 20000, attempt = 1) =>
    emit(sentId(), { type: 'rate_limited', attempt, of: 4, after, message: 'HTTP 429: slow down' });
  // A message on its way to a model that has been chosen, which is where a
  // rate limit is met
  const ask = async (text = 'do it') => {
    await type(text);
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'picked',
    });
  };

  it('says so in the thread, with how long until the next go', async () => {
    await ask();
    emit(sentId(), { type: 'text', delta: 'Starting.' });
    limited();
    expect(messages()).toEqual([
      'user: do it',
      'assistant: Starting.',
      'note: Rate limited by the provider; trying again in 20 seconds (attempt 2 of 4)',
      'work: Working…',
    ]);
    // ...and what the provider actually said is there to be opened
    expect($('#messages .note details')).not.toBeNull();
    $<HTMLElement>('#messages .note summary').click();
    expect($('#messages .note details').textContent).toContain('HTTP 429: slow down');
  });

  it('says so in the thread when it falls back to another model', async () => {
    await ask();
    emit(sentId(), { type: 'fell_back', from: 'anthropic/claude-x', to: 'local/llama3.2:3b' });
    expect(messages()).toContain('note: Out of credit on anthropic/claude-x; continuing on local/llama3.2:3b.');
  });

  it('reads the same however long the wait, and counts the goes', async () => {
    await ask();
    limited(1000);
    limited(45000, 2);
    expect(messages().slice(1, 3)).toEqual([
      'note: Rate limited by the provider; trying again in 1 second (attempt 2 of 4)',
      'note: Rate limited by the provider; trying again in 45 seconds (attempt 3 of 4)',
    ]);
  });

  it('carries the reply on where it left off once the provider lets it', async () => {
    await ask();
    emit(sentId(), { type: 'text', delta: 'Starting.' });
    limited();
    emit(sentId(), { type: 'text', delta: 'Done.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    expect(messages()).toEqual([
      'user: do it',
      'assistant: Starting.',
      'note: Rate limited by the provider; trying again in 20 seconds (attempt 2 of 4)',
      'assistant: Done.',
    ]);
  });

  it('says it in a subagent’s own view too, where its work is read', async () => {
    await ask();
    emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests', kind: 'explorer' });
    emit(sentId(), {
      type: 'subagent_update',
      id: 's1',
      event: { type: 'rate_limited', attempt: 1, of: 4, after: 8000, message: 'HTTP 429' },
    });
    $<HTMLElement>('#messages .subagent .open').click();
    await flush();
    expect($('#agent-view').textContent).toContain('Rate limited; trying again in 8s (attempt 2 of 4)');
  });

  it('does not call a server that was not there a rate limit', async () => {
    await ask();
    emit(sentId(), { type: 'text', delta: 'Starting.' });
    emit(sentId(), {
      type: 'rate_limited',
      attempt: 1,
      of: 4,
      after: 2000,
      message: 'No server reachable at http://x',
      unreachable: true,
    });
    expect(messages()).toContain('note: Could not reach the provider; trying again in 2 seconds (attempt 2 of 4)');
  });

  it('says that in a subagent’s own view too', async () => {
    await ask();
    emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests', kind: 'explorer' });
    emit(sentId(), {
      type: 'subagent_update',
      id: 's1',
      event: { type: 'rate_limited', attempt: 1, of: 4, after: 8000, message: 'gone', unreachable: true },
    });
    $<HTMLElement>('#messages .subagent .open').click();
    await flush();
    expect($('#agent-view').textContent).toContain('Could not reach the provider; trying again in 8s (attempt 2 of 4)');
  });
});

describe('searching the threads', () => {
  const box = () => $<HTMLInputElement>('#search-input');
  const results = () => $$('#search-results .result');
  const rows = () => results().map((li) => li.textContent);
  // Types into the box and waits for the search, which waits for the typing to
  // stop (see SEARCH_DELAY_MS)
  const type_ = async (text: string) => {
    box().value = text;
    box().dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 250));
  };
  const key = (name: string) => box().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  const hit = (over: Record<string, unknown> = {}) => ({
    thread: 'other',
    title: 'Containers',
    at: 0,
    request: 'how is the docker image chosen?',
    reply: 'From the files in the workspace.',
    when: 1_700_000_000_000,
    score: 0.82,
    preview: 'From the files in the workspace.',
    ...over,
  });

  // A thread with something in it to be found, and another to be looking from
  const twoThreads = async () => {
    await type('how is the docker image chosen?');
    emit(sentId(), { type: 'text', delta: 'From the files in the workspace.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    const found = saved().activeId as string;
    await newThread(null);
    await type('something else entirely');
    return found;
  };

  it('is in the top bar, with nothing under it until something is typed', () => {
    expect(box()).not.toBeNull();
    expect($<HTMLElement>('#search-results').hidden).toBe(true);
  });

  it('asks nothing until there is enough to go on', async () => {
    await type_('do');
    expect(threads.search).not.toHaveBeenCalled();
    await type_('docker');
    expect(threads.search).toHaveBeenCalledWith('docker');
  });

  it('shows the thread, what was asked, and the part of the answer that matched', async () => {
    threads.search.mockResolvedValue([hit()]);
    await type_('docker image');
    expect(rows()).toEqual([
      'Containers' +
        new Date(1_700_000_000_000).toLocaleDateString() +
        'how is the docker image chosen?' +
        'From the files in the workspace.',
    ]);
  });

  it('says so when it found nothing, and when there is nothing to search with', async () => {
    threads.search.mockResolvedValue([]);
    await type_('docker image');
    expect(rows()).toEqual(['Nothing about "docker image" in your threads.']);

    threads.search.mockRejectedValue(new Error('No Ollama reachable at http://localhost:11434 to embed with.'));
    await type_('docker images');
    expect(rows()).toEqual(['No Ollama reachable at http://localhost:11434 to embed with.']);
  });

  it('finds an archived thread, and opening it puts it back at the top of the sidebar', async () => {
    const found = await twoThreads();
    // Archived as it would be in a workspace with more than ten threads (see archiveStale)
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await vi.waitFor(() => expect(saved().threads).toHaveLength(2));
    const state = saved();
    state.threads.find((t: { id: string }) => t.id === found).archived = true;
    onDisk = JSON.stringify(state);
    await start();
    expect(threadTitles()).toEqual(['something else entirely']);

    threads.search.mockResolvedValue([hit({ thread: found })]);
    await type_('docker image');
    results()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flush();
    expect(saved().activeId).toBe(found);
    expect(threadTitles()).toEqual(['how is the docker image chosen?', 'something else entirely']);
    expect(saved().threads.find((t: { id: string }) => t.id === found)).not.toHaveProperty('archived');
  });

  it('opens the thread it was found in, at the request it was found in', async () => {
    const found = await twoThreads();
    threads.search.mockResolvedValue([hit({ thread: found })]);
    await type_('docker image');
    results()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flush();

    expect(saved().activeId).toBe(found);
    expect(messages()[0]).toBe('user: how is the docker image chosen?');
    // The message it was looking for is marked, so arriving is visible
    const landed = $$('#messages .message.landed');
    expect(landed).toHaveLength(1);
    expect(landed[0].dataset.at).toBe('0');
    // ...and the search is put away, ready for the next one
    expect($<HTMLElement>('#search-results').hidden).toBe(true);
    expect(box().value).toBe('');
  });

  it('finds the request by what it says, not by where it was', async () => {
    const found = await twoThreads();
    // Indexed when it was the first message; a summary note has been put above it since
    threads.search.mockResolvedValue([hit({ thread: found, at: 7 })]);
    await type_('docker image');
    results()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flush();
    expect($<HTMLElement>('#messages .message.landed').dataset.at).toBe('0');
  });

  it('walks the results with the arrow keys and opens one with Enter', async () => {
    const found = await twoThreads();
    threads.search.mockResolvedValue([hit({ thread: found }), hit({ thread: found, request: 'and the parser?' })]);
    await type_('docker');
    expect(results().map((li) => li.className)).toEqual(['result on', 'result']);
    key('ArrowDown');
    expect(results().map((li) => li.className)).toEqual(['result', 'result on']);
    // ...and round again
    key('ArrowDown');
    expect(results()[0].className).toBe('result on');

    key('Enter');
    await flush();
    expect(saved().activeId).toBe(found);
  });

  it('is put away by Escape and by a click elsewhere', async () => {
    threads.search.mockResolvedValue([hit()]);
    await type_('docker');
    key('Escape');
    expect($<HTMLElement>('#search-results').hidden).toBe(true);
    expect(box().value).toBe('');

    await type_('docker');
    document.body.click();
    expect($<HTMLElement>('#search-results').hidden).toBe(true);
  });

  it('draws the answer to the last search, not whichever came back last', async () => {
    let answerFirst!: (hits: unknown[]) => void;
    threads.search.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    threads.search.mockResolvedValueOnce([hit({ title: 'The second search' })]);
    await type_('docker');
    await type_('docker image');
    // The first search answers late, with what is now the wrong thing
    answerFirst([hit({ title: 'The first search' })]);
    await flush();
    expect(rows().join()).toContain('The second search');
  });
});

describe('what is indexed for searching', () => {
  // What has been handed over for the thread this test is using. A window that
  // started before the clock was taken over has an index of its own pending on
  // the real one, and that would otherwise be counted here.
  const handed = () =>
    threads.index.mock.calls
      .map(([given]) => given as Record<string, unknown>[])
      .filter((pieces) => pieces.some((one) => one.thread === saved().activeId));
  // The pieces last handed over, as the window cut them
  const pieces = () => handed().at(-1) ?? [];
  // Fake timers, so the wait for things to go quiet can be had at once. Nothing
  // here awaits: the pieces are cut and handed over inside the timer.
  const settle = () => vi.advanceTimersByTime(5000);
  // The message, sent without awaiting a timer that will not tick
  const ask = (text: string) => {
    $<HTMLTextAreaElement>('#input').value = text;
    $<HTMLFormElement>('#composer').requestSubmit();
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is one piece per request, holding what was asked and what came back', async () => {
    ask('how is the docker image chosen?');
    emit(sentId(), { type: 'thought', text: 'Looking at the toolchains.' });
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/sandbox/docker.ts' } });
    emit(sentId(), {
      type: 'tool_result',
      id: 'c1',
      name: 'read_file',
      output: 'const TOOLCHAINS = {',
      isError: false,
    });
    emit(sentId(), { type: 'text', delta: 'From the files in the workspace.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    settle();

    expect(pieces()).toEqual([
      {
        thread: saved().activeId,
        title: expect.any(String),
        at: 0,
        request: 'how is the docker image chosen?',
        reply: 'From the files in the workspace.',
        when: expect.any(Number),
      },
    ]);
  });

  it('leaves out the thoughts, the tools and the notes, which are not the conversation', async () => {
    ask('how is the docker image chosen?');
    emit(sentId(), { type: 'thought', text: 'Looking at the toolchains.' });
    emit(sentId(), { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/sandbox/docker.ts' } });
    emit(sentId(), { type: 'text', delta: 'From the files.' });
    settle();
    const [piece] = pieces();
    expect(piece.reply).toBe('From the files.');
    expect(JSON.stringify(pieces())).not.toContain('toolchains');
    expect(JSON.stringify(pieces())).not.toContain('read_file');
  });

  it('hands nothing over when nothing of the conversation changed', async () => {
    ask('how is the docker image chosen?');
    emit(sentId(), { type: 'text', delta: 'From the files.' });
    settle();
    expect(handed()).toHaveLength(1);

    // A thought and a tool call change the thread, but not what is searched
    emit(sentId(), { type: 'thought', text: 'Still looking.' });
    emit(sentId(), { type: 'tool_call', id: 'c2', name: 'list_files', input: {} });
    settle();
    expect(handed()).toHaveLength(1);

    // More of the reply is more to search
    emit(sentId(), { type: 'text', delta: ' In the workspace.' });
    settle();
    expect(handed()).toHaveLength(2);
  });

  it('waits for the typing and the reply to stop rather than indexing every keystroke', async () => {
    ask('how is the docker image chosen?');
    emit(sentId(), { type: 'text', delta: 'From ' });
    vi.advanceTimersByTime(1000);
    emit(sentId(), { type: 'text', delta: 'the files.' });
    vi.advanceTimersByTime(1000);
    expect(handed()).toEqual([]);
    settle();
    expect(handed()).toHaveLength(1);
  });
});

describe('settings screen', () => {
  const open = async () => {
    $('#open-settings').click();
    await flush();
  };
  const rows = (provider: string) =>
    $$(`.model-list[data-provider="${provider}"] .row`).map((row) => {
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const level = row.querySelector('select')?.value || 'Auto';
      return `${box ? (box.checked ? '[x] ' : '[ ] ') : ''}${row.querySelector('span')!.textContent} (${level})`;
    });
  // A field is saved when it is changed: the 'change' event, as when it is left
  const changed = async (field: Element) => {
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  };
  const lastSaved = () => settingsApi.save.mock.calls.at(-1)![0];

  it('shows which keys are saved without revealing them', async () => {
    await open();
    expect($<HTMLDialogElement>('#settings').open).toBe(true);
    expect($<HTMLInputElement>('#anthropic-key').value).toBe('');
    expect($<HTMLInputElement>('#anthropic-key').placeholder).toContain('Saved');
    expect($<HTMLInputElement>('#openai-key').placeholder).toBe('Not set');
    expect($('.remove-key[data-provider="anthropic"]').hidden).toBe(false);
    expect($('.remove-key[data-provider="openai"]').hidden).toBe(true);
    expect($<HTMLInputElement>('#local-url').value).toBe('http://localhost:11434/v1');
  });

  it("lists each hosted provider's models with their state, or why there are none", async () => {
    modelList = {
      models: [opus, { ...haiku, disabled: true }, llama],
      providers: [{ id: 'openai', name: 'OpenAI', ok: false, error: 'No OpenAI API key found.' }],
    };
    settings.sophistication = { 'anthropic/opus': 5 };
    await start();
    await open();
    expect(rows('anthropic')).toEqual(['[x] Opus (5)', '[ ] Haiku (Auto)']);
    expect($('.model-list[data-provider="openai"]').textContent).toBe('No OpenAI API key found.');
  });

  describe('tabs', () => {
    // Trimmed: the label is what is written in the markup, whatever the
    // indentation around it
    const names = () => $$('#settings-tabs [role="tab"]').map((t) => t.textContent?.trim());
    const selected = () =>
      $$('#settings-tabs [role="tab"]')
        .filter((t) => t.getAttribute('aria-selected') === 'true')
        .map((t) => t.textContent?.trim());
    const visible = () =>
      $$('#settings [role="tabpanel"]')
        .filter((p) => !p.hidden)
        .map((p) => p.dataset.panel);
    const tab = (id: string) => $(`#settings-tabs [data-tab="${id}"]`);

    it('gives each provider its own tab, showing one at a time, Anthropic first', async () => {
      await open();
      expect(names()).toEqual(['Anthropic', 'OpenAI', 'Ollama', 'Sandbox', 'General']);
      expect(selected()).toEqual(['Anthropic']);
      expect(visible()).toEqual(['anthropic']);

      tab('local').click();
      expect(selected()).toEqual(['Ollama']);
      expect(visible()).toEqual(['local']);
    });

    it('opens on the tab the markup has selected, which the default has to agree with', async () => {
      // The markup marks one tab selected and puts it in the tab order before
      // any of this runs, and the dialog opens on whatever tab the renderer
      // starts on. A default naming another tab opens the dialog on one
      // nobody chose, and starts the arrow keys from there: 'general' did
      // that here (see settingsTab in renderer/settings.ts). Read off the
      // file rather than the page, which by now says what the renderer did.
      const marked = /<button[^>]*aria-selected="true"[^>]*>\s*([^<]+?)\s*</.exec(body)![1];
      await open();
      expect(selected()).toEqual([marked]);
    });

    it('keeps the approval level and the colours on a General tab of their own', async () => {
      await open();
      const inGeneral = (selector: string) => $(selector).closest('[role="tabpanel"]')?.getAttribute('data-panel');
      expect(inGeneral('#approval-ceiling')).toBe('general');
      expect(inGeneral('#theme-controls')).toBe('general');
      expect(inGeneral('#theme-reset')).toBe('general');

      tab('general').click();
      expect(selected()).toEqual(['General']);
      expect(visible()).toEqual(['general']);
    });

    it('says which panel each tab is for, so they are read as a pair', async () => {
      await open();
      for (const tab of $$('#settings-tabs [role="tab"]')) {
        const panel = $(`#${tab.getAttribute('aria-controls')}`);
        expect(panel.dataset.panel).toBe(tab.dataset.tab);
        expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
      }
    });

    it('is walked with the arrow keys, with only the one in hand in the tab order', async () => {
      await open();
      const order = () => $$('#settings-tabs [role="tab"]').map((t) => (t as HTMLElement).tabIndex);
      expect(order()).toEqual([0, -1, -1, -1, -1]);

      const press = (key: string) =>
        $('#settings-tabs').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      press('ArrowDown');
      expect(selected()).toEqual(['OpenAI']);
      expect(visible()).toEqual(['openai']);
      expect(order()).toEqual([-1, 0, -1, -1, -1]);

      press('ArrowUp');
      expect(selected()).toEqual(['Anthropic']);
      // ...and round, rather than stopping at the ends
      press('ArrowUp');
      expect(selected()).toEqual(['General']);

      press('Home');
      expect(selected()).toEqual(['Anthropic']);
      press('End');
      expect(selected()).toEqual(['General']);
    });

    it('takes no notice of a key that is not for moving about', async () => {
      await open();
      $('#settings-tabs').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      expect(selected()).toEqual(['Anthropic']);
    });

    it('puts the hint about which model answers away on the tab it says nothing about', async () => {
      await open();
      expect($<HTMLElement>('#settings-hint').hidden).toBe(false);
      tab('sandbox').click();
      // The container a thread works in has nothing to do with how a message
      // is rated
      expect($<HTMLElement>('#settings-hint').hidden).toBe(true);
      tab('local').click();
      expect($<HTMLElement>('#settings-hint').hidden).toBe(false);
    });

    it('stays on the same tab through a save and when the settings are reopened', async () => {
      await open();
      tab('openai').click();
      await changed($('#local-url'));
      expect(visible()).toEqual(['openai']);
      $('#settings-close').click();
      await open();
      expect(visible()).toEqual(['openai']);
    });

    it('saves a change on any tab, keeping what was already switched off on the others', async () => {
      const gpt = model({
        id: 'gpt',
        name: 'GPT',
        provider: 'openai',
        providerName: 'OpenAI',
        local: false,
        sophistication: 4,
      });
      modelList = { models: [opus, gpt], providers: [] };
      settings.anthropic.disabledModels = ['retired-model'];
      await start();
      await open();
      $<HTMLInputElement>('input[data-model="opus"]').checked = false;
      await changed($('input[data-model="opus"]'));
      expect(lastSaved()).toMatchObject({
        anthropic: { disabledModels: ['retired-model', 'opus'] },
        openai: { disabledModels: [] },
      });
      tab('openai').click();
      $<HTMLInputElement>('input[data-model="gpt"]').checked = false;
      await changed($('input[data-model="gpt"]'));
      expect(lastSaved()).toMatchObject({ openai: { disabledModels: ['gpt'] } });
    });
  });

  describe('each model', () => {
    const summaries = (provider: string) =>
      $$(`.model-list[data-provider="${provider}"] .row`).map(
        (row) => `${row.querySelector('span')!.textContent}: ${row.querySelector('small.level')!.textContent}`
      );

    it('has an on/off switch if it is from Anthropic or OpenAI, but not if it is local', async () => {
      const gpt = model({
        id: 'gpt',
        name: 'GPT',
        provider: 'openai',
        providerName: 'OpenAI',
        local: false,
        sophistication: 4,
      });
      modelList = { models: [opus, { ...haiku, disabled: true }, gpt, llama], providers: [] };
      await start();
      await open();
      const switches = (provider: string) =>
        $$(`.model-list[data-provider="${provider}"] input.toggle[role="switch"]`).map(
          (s) => `${s.dataset.model}: ${(s as HTMLInputElement).checked ? 'on' : 'off'}`
        );
      expect(switches('anthropic')).toEqual(['opus: on', 'haiku: off']);
      expect(switches('openai')).toEqual(['gpt: on']);
      expect(switches('local')).toEqual([]);
    });

    it('shows its level and the ratings Auto uses it for', async () => {
      await open();
      // llama (1) takes rating 1, Haiku (2) rating 2, and Opus (4) the rest,
      // including 5, which nothing fully meets
      expect(summaries('anthropic')).toEqual([
        'Opus: Advanced · 4/5 · used for ratings 3–5',
        'Haiku: Capable · 2/5 · used for rating 2',
      ]);
      expect(summaries('local')).toEqual(['llama3.2:3b: Basic · 1/5 · used for rating 1']);
    });

    it('says when it is switched off, and gives its ratings to the models that are on', async () => {
      modelList = { models: [opus, { ...haiku, disabled: true }, llama], providers: [] };
      await start();
      await open();
      expect(summaries('anthropic')).toEqual([
        'Opus: Advanced · 4/5 · used for ratings 2–5',
        'Haiku: Capable · 2/5 · switched off',
      ]);
    });

    it('says when Auto never picks it because another model at its level comes first', async () => {
      const mistral = model({ id: 'mistral:7b', sophistication: 2 });
      modelList = { models: [opus, haiku, mistral], providers: [] };
      await start();
      await open();
      // A local model wins the tie at level 2
      expect(summaries('anthropic')[1]).toBe('Haiku: Capable · 2/5 · not picked by Auto');
      expect(summaries('local')).toEqual(['mistral:7b: Capable · 2/5 · used for ratings 1–2']);
    });

    it('shows the level the user set, once saved', async () => {
      await open();
      modelList = { models: [{ ...opus, sophistication: 5 }, haiku, llama], providers: [] };
      $<HTMLSelectElement>('select[data-model="anthropic/opus"]').value = '5';
      await changed($('select[data-model="anthropic/opus"]'));
      expect(summaries('anthropic')[0]).toBe('Opus: Frontier · 5/5 · used for ratings 3–5');
    });
  });

  describe('offline mode in the settings screen', () => {
    const opusRow = () => $('.model-list[data-provider="anthropic"] .row');
    // Going offline leaves only this computer's models on offer (see the
    // offline switch tests), so a hosted model seen while online is kept by the
    // retained store and shown greyed out instead.
    beforeEach(() => {
      settingsApi.save.mockImplementation(async (patch: { offline?: boolean }) => {
        settings = { ...settings, ...patch };
        modelList = settings.offline
          ? { models: [llama], providers: [{ id: 'anthropic', name: 'Anthropic', ok: false, error: 'Offline.' }] }
          : { models: [opus, haiku, llama], providers: [] };
        return settings;
      });
    });

    it('keeps a hosted model on the list, greyed out but still switchable, while offline', async () => {
      modelList = { models: [opus, llama], providers: [] };
      settings.offline = false;
      await start();
      await open();
      // The opus row is present and, while online, not yet greyed out
      expect(opusRow()).not.toBeNull();
      expect(opusRow()!.classList.contains('unavailable')).toBe(false);

      $<HTMLInputElement>('#offline-toggle').click();
      await flush();

      // Still shown, but now greyed out: the switch stays on and is not disabled
      const row = opusRow()!;
      expect(row).not.toBeNull();
      expect(row.classList.contains('unavailable')).toBe(true);
      const switchEl = $<HTMLInputElement>('input[data-model="opus"]');
      expect(switchEl.checked).toBe(true);
      expect(switchEl.disabled).toBe(false);
      // The warning is on screen, saying Offline Mode is on
      expect($<HTMLParagraphElement>('#settings-offline-warning').hidden).toBe(false);
      expect($<HTMLParagraphElement>('#settings-offline-warning').textContent).toContain('Offline Mode');

      // Turning the switch off saves the choice, taking effect once online again
      switchEl.checked = false;
      await changed(switchEl);
      expect(lastSaved()).toMatchObject({
        anthropic: { disabledModels: expect.arrayContaining(['opus']) },
      });
    });

    // A boot that is already Offline never sees a hosted model in the live list,
    // so the greyed rows have to come from the retained list held across a
    // restart (in the window's own storage, as the threads are).
    it('shows the retained hosted models greyed out on a boot that is already offline', async () => {
      localStorage.setItem('retained-hosted-models', JSON.stringify([opus]));
      modelList = {
        models: [llama],
        providers: [{ id: 'anthropic', name: 'Anthropic', ok: false, error: 'Offline.' }],
      };
      settings.offline = true;
      await start();
      await open();

      // The opus row is on screen from the retained list, greyed out but switchable
      const row = opusRow();
      expect(row).not.toBeNull();
      expect(row!.classList.contains('unavailable')).toBe(true);
      const switchEl = $<HTMLInputElement>('input[data-model="opus"]');
      expect(switchEl.checked).toBe(true);
      expect(switchEl.disabled).toBe(false);
      // ...and the warning is on screen, since Offline Mode is on
      expect($<HTMLParagraphElement>('#settings-offline-warning').hidden).toBe(false);
    });
  });

  describe('model families', () => {
    const hosted = (id: string, provider: 'anthropic' | 'openai' = 'anthropic') =>
      model({
        id,
        name: id,
        provider,
        providerName: provider === 'anthropic' ? 'Anthropic' : 'OpenAI',
        local: false,
        sophistication: 4,
      });
    const opus47 = hosted('claude-opus-4-7');
    const opus46 = hosted('claude-opus-4-6');
    const sonnet = hosted('claude-sonnet-4-5');
    const families = (provider: string) => $$(`.model-list[data-provider="${provider}"] details.family`);
    const familySwitch = (key: string) => $<HTMLInputElement>(`input.family-toggle[data-family="${key}"]`);
    const versions = (key: string) =>
      Array.from(familySwitch(key).closest('details')!.querySelectorAll<HTMLInputElement>('input[data-model]'));
    const flip = (box: HTMLInputElement, checked: boolean) => {
      box.checked = checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };

    it('groups the versions of a family under a collapsed heading with a switch of its own', async () => {
      modelList = { models: [opus47, opus46, sonnet], providers: [] };
      await start();
      await open();
      const groups = families('anthropic');
      expect(groups.map((g) => g.querySelector<HTMLInputElement>('.family-toggle')!.dataset.family)).toEqual([
        'opus',
        'sonnet',
      ]);
      for (const group of groups) {
        expect(group.hasAttribute('open')).toBe(false);
        expect(group.querySelector('summary.family-head input.family-toggle[role="switch"]')).not.toBeNull();
        expect(group.querySelectorAll('.family-models label.row input[data-model]').length).toBeGreaterThan(0);
      }
      expect(groups[0].querySelector('summary small')!.textContent).toBe('2 models');
      expect(versions('opus').map((v) => v.dataset.model)).toEqual(['claude-opus-4-7', 'claude-opus-4-6']);
    });

    it('names the family of each model by the word that identifies it', async () => {
      const openai = (id: string) => hosted(id, 'openai');
      modelList = {
        models: [
          hosted('claude-opus-4-7'),
          hosted('claude-fable-5-1'),
          hosted('claude-haiku-4-5'),
          hosted('claude-mythos-1'),
          hosted('opus'),
          openai('gpt-5-mini'),
          openai('gpt-4o-mini'),
          openai('o3-mini'),
          openai('gpt'),
        ],
        providers: [],
      };
      await start();
      await open();
      const keys = (provider: string) =>
        $$(`.model-list[data-provider="${provider}"] input.family-toggle`).map((s) => s.dataset.family);
      expect(keys('anthropic').sort()).toEqual(['fable', 'haiku', 'mythos', 'opus']);
      expect(keys('openai').sort()).toEqual(['gpt', 'gpt-4o', 'gpt-5', 'o3']);
      // A short id is a family of its own, but that does not split the longer ids of the same word off
      expect(versions('opus').map((v) => v.dataset.model)).toEqual(['claude-opus-4-7', 'opus']);
      expect(versions('gpt-5').map((v) => v.dataset.model)).toEqual(['gpt-5-mini']);
      expect(versions('o3').map((v) => v.dataset.model)).toEqual(['o3-mini']);
    });

    it('has its switch on when any version is on', async () => {
      modelList = { models: [opus47, { ...opus46, disabled: true }], providers: [] };
      settings.anthropic.disabledModels = ['claude-opus-4-6'];
      await start();
      await open();
      expect(familySwitch('opus').checked).toBe(true);
      expect(versions('opus').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['true/false', 'false/false']);
    });

    it('has its switch off and its versions locked when every version is already off', async () => {
      modelList = {
        models: [{ ...opus47, disabled: true }, { ...opus46, disabled: true }, sonnet],
        providers: [],
      };
      settings.anthropic.disabledModels = ['claude-opus-4-7', 'claude-opus-4-6'];
      await start();
      await open();
      expect(familySwitch('opus').checked).toBe(false);
      expect(versions('opus').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['false/true', 'false/true']);
      expect(familySwitch('sonnet').checked).toBe(true);
      expect(versions('sonnet').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['true/false']);
    });

    it('switches off and locks every version when its switch is turned off, and back on again', async () => {
      modelList = { models: [opus47, opus46, sonnet], providers: [] };
      await start();
      await open();
      flip(familySwitch('opus'), false);
      expect(versions('opus').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['false/true', 'false/true']);
      // Another family is left as it was
      expect(versions('sonnet').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['true/false']);

      flip(familySwitch('opus'), true);
      expect(versions('opus').map((v) => `${v.checked}/${v.disabled}`)).toEqual(['true/false', 'true/false']);
    });

    it('saves every version of a family that is switched off', async () => {
      modelList = { models: [opus47, opus46, sonnet], providers: [] };
      await start();
      await open();
      flip(familySwitch('opus'), false);
      await flush();
      expect(lastSaved()).toMatchObject({
        anthropic: { disabledModels: ['claude-opus-4-7', 'claude-opus-4-6'] },
        openai: { disabledModels: [] },
      });
    });

    it('saves only the version that was switched off when its family is on', async () => {
      modelList = { models: [opus47, opus46, sonnet], providers: [] };
      await start();
      await open();
      flip(versions('opus')[0], false);
      expect(familySwitch('opus').checked).toBe(true);
      await flush();
      expect(lastSaved()).toMatchObject({
        anthropic: { disabledModels: ['claude-opus-4-7'] },
      });
    });

    it('saves nothing for a family that is switched off and on again', async () => {
      modelList = { models: [opus47, opus46], providers: [] };
      await start();
      await open();
      flip(familySwitch('opus'), false);
      flip(familySwitch('opus'), true);
      await flush();
      expect(lastSaved()).toMatchObject({ anthropic: { disabledModels: [] } });
    });

    it('groups the OpenAI models too, collapsed', async () => {
      const mini = hosted('gpt-5-mini', 'openai');
      const full = hosted('gpt-5', 'openai');
      modelList = { models: [mini, full], providers: [] };
      await start();
      await open();
      const [group] = families('openai');
      expect(families('openai')).toHaveLength(1);
      expect(group.hasAttribute('open')).toBe(false);
      expect(group.querySelector<HTMLInputElement>('.family-toggle')!.dataset.family).toBe('gpt-5');
      flip(familySwitch('gpt-5'), false);
      await flush();
      expect(lastSaved()).toMatchObject({
        openai: { disabledModels: ['gpt-5-mini', 'gpt-5'] },
      });
    });
  });

  it('saves a typed key, and leaves the saved one alone when the field is blank', async () => {
    await open();
    $<HTMLInputElement>('#openai-key').value = 'sk-new';
    await changed($('#openai-key'));
    expect(settingsApi.save).toHaveBeenCalledTimes(1);
    expect(settingsApi.save).toHaveBeenCalledWith({ openai: { apiKey: 'sk-new' } });
    expect($('#settings-status').textContent).toBe('Saved.');
    expect($<HTMLDialogElement>('#settings').open).toBe(true);

    $<HTMLInputElement>('#anthropic-key').value = '  ';
    await changed($('#anthropic-key'));
    expect(settingsApi.save).toHaveBeenCalledTimes(1);
  });

  it('saves the server URL and the sandbox image when they are changed', async () => {
    await open();
    $<HTMLInputElement>('#local-url').value = 'http://gpu-box:8080/v1';
    await changed($('#local-url'));
    expect(settingsApi.save).toHaveBeenLastCalledWith({ local: { baseURL: 'http://gpu-box:8080/v1' } });
    $<HTMLInputElement>('#sandbox-image').value = 'my-image';
    await changed($('#sandbox-image'));
    expect(settingsApi.save).toHaveBeenLastCalledWith({ sandbox: { image: 'my-image' } });
  });

  it('saves a limit on the context of local models, and takes it away when it is cleared', async () => {
    await open();
    const input = $<HTMLInputElement>('#local-max-context');
    input.value = '16384';
    await changed(input);
    expect(settingsApi.save).toHaveBeenLastCalledWith({ local: { maxContext: 16384 } });
    input.value = '';
    await changed(input);
    expect(settingsApi.save).toHaveBeenLastCalledWith({ local: { maxContext: null } });
  });

  it('saves the switched-off models and levels when one is changed, keeping those not listed now', async () => {
    settings.anthropic.disabledModels = ['retired-model'];
    settings.sophistication = { 'openai/not-listed-now': 3 };
    await open();

    $<HTMLInputElement>('.model-list[data-provider="anthropic"] input[data-model="haiku"]').checked = false;
    await changed($('input[data-model="haiku"]'));
    expect(settingsApi.save).toHaveBeenLastCalledWith({
      anthropic: { disabledModels: ['retired-model', 'haiku'] },
      openai: { disabledModels: [] },
      sophistication: { 'openai/not-listed-now': 3 },
    });

    $<HTMLSelectElement>('select[data-model="anthropic/opus"]').value = '5';
    await changed($('select[data-model="anthropic/opus"]'));
    expect(lastSaved()).toMatchObject({ sophistication: { 'openai/not-listed-now': 3, 'anthropic/opus': 5 } });
  });

  it('re-enables a model and clears a level back to Auto', async () => {
    modelList = { models: [opus, { ...haiku, disabled: true }], providers: [] };
    settings.anthropic.disabledModels = ['haiku'];
    settings.sophistication = { 'anthropic/opus': 5 };
    await start();
    await open();
    $<HTMLInputElement>('input[data-model="haiku"]').checked = true;
    $<HTMLSelectElement>('select[data-model="anthropic/opus"]').value = '';
    await changed($('input[data-model="haiku"]'));
    expect(lastSaved()).toMatchObject({
      anthropic: { disabledModels: [] },
      sophistication: {},
    });
  });

  it('keeps an open model family open when a change is saved', async () => {
    const hosted = (id: string) =>
      model({ id, name: id, provider: 'anthropic', providerName: 'Anthropic', local: false, sophistication: 4 });
    modelList = { models: [hosted('claude-opus-4-7'), hosted('claude-sonnet-4-5')], providers: [] };
    await start();
    await open();
    $<HTMLDetailsElement>('details.family').open = true;
    await changed($('input[data-model="claude-opus-4-7"]'));
    expect($$('details.family').map((d) => (d as HTMLDetailsElement).open)).toEqual([true, false]);
  });

  it('refreshes the model picker after saving', async () => {
    await open();
    modelList = { models: [opus], providers: [] };
    await changed($('#local-url'));
    expect(pickerOptions()).toEqual(['Auto · chosen per message', 'Opus · Anthropic · 4/5']);
  });

  it('does not reload the page when Enter is pressed in a field', async () => {
    await open();
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    $('#settings-form').dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it('has no Save button, since everything is saved as it is changed', async () => {
    await open();
    expect($$('#settings-form button[type="submit"]')).toEqual([]);
  });

  it('removes a saved key', async () => {
    await open();
    settingsApi.save.mockImplementation(async () => {
      settings.anthropic.hasKey = false;
      return settings;
    });
    $('.remove-key[data-provider="anthropic"]').click();
    await flush();
    expect(settingsApi.save).toHaveBeenCalledWith({ anthropic: { apiKey: null } });
    expect($('.remove-key[data-provider="anthropic"]').hidden).toBe(true);
  });

  it('shows why saving failed', async () => {
    await open();
    settingsApi.save.mockRejectedValue(new Error('Encryption is not available on this system.'));
    $<HTMLInputElement>('#openai-key').value = 'sk-new';
    await changed($('#openai-key'));
    expect($('#settings-status').textContent).toBe('Encryption is not available on this system.');
  });

  it('closes', async () => {
    await open();
    $('#settings-close').click();
    expect($<HTMLDialogElement>('#settings').open).toBe(false);
  });

  describe('Ollama section', () => {
    const suggestion = (name: string) => ({ name, sophistication: 2, memoryGB: 8 });
    const mistralSuggestion = suggestion('mistral:7b');
    const PREVIEW = 'Capable · 2/5 · Recommended 8GB Memory';
    // Each row without its preview line, which `previews` reads
    const ollamaRows = () =>
      $$('.model-list[data-provider="local"] .row').map((row) =>
        [...row.children]
          .filter((child) => !child.classList.contains('about'))
          .map((child) =>
            child.tagName === 'SELECT' ? '' : child.tagName === 'BUTTON' ? `<${child.textContent}>` : child.textContent
          )
          .filter(Boolean)
          .join(' ')
      );
    const button = (name: string) =>
      $$('.model-list[data-provider="local"] .row')
        .find((row) => row.firstElementChild!.textContent === name)!
        .querySelector('button')!;

    it('says when Ollama cannot be reached, and hides downloading', async () => {
      await open();
      expect($('#ollama-status').textContent).toContain("Ollama isn't reachable at http://localhost:11434");
      expect($('#ollama-other').hidden).toBe(true);
      // Models from another compatible server at that URL are still listed
      expect(ollamaRows()).toEqual(['llama3.2:3b Basic · 1/5 · used for rating 1']);
    });

    it('shows downloaded models with their size, and suggestions that are not downloaded', async () => {
      ollama = {
        reachable: true,
        url: 'http://localhost:11434',
        installed: [{ name: 'llama3.2:3b', size: 2_019_393_189 }],
        suggested: [mistralSuggestion, suggestion('qwen2.5:7b')],
      };
      await open();
      expect($('#ollama-status').textContent).toBe('Connected to Ollama. 1 downloaded, 2 available to download.');
      expect(ollamaRows()).toEqual([
        'llama3.2:3b · 2.0 GB · Downloaded Basic · 1/5 · used for rating 1',
        'mistral:7b <Download>',
        'qwen2.5:7b <Download>',
      ]);
      expect($('#ollama-other').hidden).toBe(false);
    });

    it('previews each suggested model: its level and the memory recommended for it', async () => {
      const big = { name: 'qwen2.5:32b', sophistication: 3, memoryGB: 32 };
      ollama = { reachable: true, url: 'u', installed: [], suggested: [mistralSuggestion, big] };
      await open();
      const previews = () => $$('.model-list[data-provider="local"] .row small.about').map((p) => p.textContent);
      expect(previews()).toEqual([PREVIEW, 'Strong · 3/5 · Recommended 32GB Memory']);

      // Still there while it downloads
      button('mistral:7b').click();
      expect(previews()[0]).toBe(PREVIEW);
    });

    it('has no preview for a model downloaded by name, or for one already downloaded', async () => {
      ollama = {
        reachable: true,
        url: 'u',
        installed: [{ name: 'llama3.2:3b', size: 2_019_393_189 }],
        suggested: [],
      };
      await open();
      $<HTMLInputElement>('#ollama-model').value = 'phi4:14b';
      $('#ollama-download').click();
      expect(ollamaRows()).toHaveLength(2);
      expect($$('.model-list[data-provider="local"] small.about')).toEqual([]);
    });

    it('downloads a suggested model, showing progress, then lists it as downloaded', async () => {
      ollama = { reachable: true, url: 'u', installed: [], suggested: [mistralSuggestion] };
      modelList = { models: [], providers: [] };
      await start();
      await open();

      button('mistral:7b').click();
      expect(ollamaApi.pull).toHaveBeenCalledWith('mistral:7b');
      expect(ollamaRows()).toEqual(['mistral:7b Starting… <Cancel>']);

      await progress({ name: 'mistral:7b', status: 'pulling manifest', percent: null });
      expect(ollamaRows()).toEqual(['mistral:7b pulling manifest <Cancel>']);
      await progress({ name: 'mistral:7b', status: 'pulling abc', percent: 42 });
      expect(ollamaRows()).toEqual(['mistral:7b 42% <Cancel>']);

      const mistral = model({ id: 'mistral:7b', sophistication: 2 });
      modelList = { models: [mistral], providers: [] };
      ollama = { reachable: true, url: 'u', installed: [{ name: 'mistral:7b', size: 4_100_000_000 }], suggested: [] };
      await progress({ name: 'mistral:7b', done: true });
      expect(ollamaRows()).toEqual(['mistral:7b · 4.1 GB · Downloaded Capable · 2/5 · used for ratings 1–5']);
      expect(pickerOptions()).toContain('mistral:7b · Local · 2/5');
    });

    it('cancels a download in progress', async () => {
      ollama = { reachable: true, url: 'u', installed: [], suggested: [mistralSuggestion] };
      await open();
      button('mistral:7b').click();
      button('mistral:7b').click();
      expect(ollamaApi.cancel).toHaveBeenCalledWith('mistral:7b');
      expect(ollamaApi.pull).toHaveBeenCalledTimes(1);
    });

    it('reports a failed download and offers it again', async () => {
      ollama = { reachable: true, url: 'u', installed: [], suggested: [mistralSuggestion] };
      await open();
      button('mistral:7b').click();
      await progress({ name: 'mistral:7b', done: true, error: 'disk full' });
      expect($('#ollama-status').textContent).toBe('Could not download mistral:7b: disk full');
      expect(ollamaRows()).toContain('mistral:7b <Download>');
    });

    it('downloads any model by name, with Enter not submitting the settings form', async () => {
      ollama = { reachable: true, url: 'u', installed: [], suggested: [] };
      await open();
      const input = $<HTMLInputElement>('#ollama-model');
      input.value = '  phi4:14b ';
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      input.dispatchEvent(enter);

      expect(enter.defaultPrevented).toBe(true);
      expect(ollamaApi.pull).toHaveBeenCalledWith('phi4:14b');
      expect(settingsApi.save).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      expect(ollamaRows()).toContain('phi4:14b Starting… <Cancel>');
    });

    it('does nothing when asked to download a blank name', async () => {
      ollama = { reachable: true, url: 'u', installed: [], suggested: [] };
      await open();
      $('#ollama-download').click();
      expect(ollamaApi.pull).not.toHaveBeenCalled();
    });
  });
});

describe('naming a workspace', () => {
  const FOLDER = '/projects/demo';
  const labels = () => $$('#thread-list li.group .label').map((label) => label.textContent);
  const dialog = () => $<HTMLDialogElement>('#rename-workspace-dialog');
  const nameInput = () => $<HTMLInputElement>('#workspace-name');
  const openRename = () => $<HTMLButtonElement>('#thread-list li.group .rename').click();
  const rename = (name: string) => {
    openRename();
    nameInput().value = name;
    $<HTMLFormElement>('#rename-workspace-form').requestSubmit();
  };

  beforeEach(async () => {
    await newThread(FOLDER);
  });

  it('renames it in the window title too, which shows the name and not the path', () => {
    expect(document.title).toBe('ch — demo');
    rename('The Demo');
    expect(document.title).toBe('ch — The Demo');
  });

  it('is offered on a workspace, not on the general chats', () => {
    const groups = $$('#thread-list li.group');
    expect(groups.map((g) => [g.title, g.querySelectorAll('.rename').length])).toEqual([
      [FOLDER, 1],
      ['', 0],
    ]);
  });

  it("opens with the workspace's path and its current name, without collapsing the workspace", () => {
    openRename();
    expect(dialog().open).toBe(true);
    expect($('#rename-workspace-path').textContent).toBe(FOLDER);
    expect(nameInput().value).toBe('demo');
    expect($('#thread-list li.group').classList.contains('collapsed')).toBe(false);
  });

  it('shows the name in the sidebar and above the thread, keeping the path at hand', () => {
    rename('  Client website ');
    expect(dialog().open).toBe(false);
    expect(labels()).toEqual(['Client website', 'General chat']);
    expect($('#thread-workspace').textContent).toBe('Client website');
    expect($('#thread-workspace').title).toBe(FOLDER);
    expect($('#thread-list li.group').title).toBe(FOLDER);
    expect($<HTMLButtonElement>('#thread-list li.group .add').title).toBe('New thread in Client website');
  });

  it('is saved, and still there after a restart', async () => {
    rename('Client website');
    expect(saved().workspaceNames).toEqual({ [FOLDER]: 'Client website' });
    await start();
    expect(labels()).toContain('Client website');

    openRename();
    expect(nameInput().value).toBe('Client website');
  });

  it("goes back to the workspace's own name when asked to, or when the name is blanked", () => {
    rename('Client website');
    openRename();
    $('#rename-workspace-reset').click();
    expect(labels()).toEqual(['demo', 'General chat']);
    expect(saved().workspaceNames).toEqual({});

    rename('Again');
    rename('   ');
    expect(labels()).toEqual(['demo', 'General chat']);
  });

  it('changes nothing when cancelled', () => {
    rename('Client website');
    openRename();
    nameInput().value = 'Something else';
    $('#rename-workspace-cancel').click();
    expect(dialog().open).toBe(false);
    expect(labels()).toEqual(['Client website', 'General chat']);
  });

  it('names each workspace separately', async () => {
    await newThread('/work/demo');
    $$<HTMLButtonElement>('#thread-list li.group .rename')
      .find((button) => button.closest('li')!.title === '/work/demo')!
      .click();
    nameInput().value = 'Work copy';
    $<HTMLFormElement>('#rename-workspace-form').requestSubmit();
    expect(saved().workspaceNames).toEqual({ '/work/demo': 'Work copy' });
    expect(labels().sort()).toEqual(['General chat', 'Work copy', 'demo']);
  });
});

describe('a suggested reply', () => {
  const box = () => $<HTMLTextAreaElement>('#input');
  const tab = () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    box().dispatchEvent(event);
    return event;
  };
  const answered = async (suggestion: string | null = 'Yes, go ahead') => {
    llm.suggest.mockResolvedValue(suggestion === null ? null : { text: suggestion });
    await type('Can you fix it?');
    emit(sentId(), { type: 'text', delta: 'Done. Shall I add a test?' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
  };

  it('is asked for once the reply is over, from the conversation so far', async () => {
    await answered();
    expect(llm.suggest).toHaveBeenCalledWith({
      messages: [
        { role: 'user', content: 'Can you fix it?' },
        { role: 'assistant', content: 'Done. Shall I add a test?' },
      ],
    });
  });

  it('shows in the box as darker text while it is empty', async () => {
    await answered();
    expect(box().placeholder).toBe('Yes, go ahead');
    expect(box().classList.contains('suggesting')).toBe(true);
    expect(box().value).toBe('');
  });

  it('is filled in by Tab for the user to send themselves', async () => {
    await answered();
    expect(tab().defaultPrevented).toBe(true);
    expect(box().value).toBe('Yes, go ahead');
    expect(box().placeholder).toBe('Type a message…');
    expect(box().classList.contains('suggesting')).toBe(false);
    expect(llm.send).toHaveBeenCalledTimes(1);

    $<HTMLFormElement>('#composer').requestSubmit();
    expect(box().value).toBe('');
    expect(llm.send).toHaveBeenCalledTimes(2);
    expect(saved().threads[0].messages.at(-2)).toMatchObject({ role: 'user', text: 'Yes, go ahead' });
  });

  it('leaves Tab alone where there is no suggestion, or the user has written something', async () => {
    await answered(null);
    expect(box().placeholder).toBe('Type a message…');
    expect(tab().defaultPrevented).toBe(false);

    await answered('Yes, go ahead');
    box().value = 'Actually, no';
    expect(tab().defaultPrevented).toBe(false);
    expect(box().value).toBe('Actually, no');
  });

  it('goes when the user sends something else', async () => {
    await answered();
    await type('Something else');
    expect(box().placeholder).toBe('Type a message…');
    expect(tab().defaultPrevented).toBe(false);
  });

  it('is not asked for after a reply that was stopped or failed', async () => {
    await type('Can you fix it?');
    emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
    await type('Again?');
    emit(sentId(), { type: 'error', code: 'other', message: 'boom' });
    await flush();
    expect(llm.suggest).not.toHaveBeenCalled();
  });

  it('belongs to its thread', async () => {
    await answered();
    await newThread(null);
    expect(box().placeholder).toBe('Type a message…');
    expect(tab().defaultPrevented).toBe(false);
  });
});

describe("a thread's description", () => {
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

  it('is the start of the first message until a model has described the thread', async () => {
    await type('How do I parse JSON in Rust without pulling in a big dependency?');
    expect(threadTitles()).toEqual(['How do I parse JSON in Rust without pull']);
    expect(llm.describe).not.toHaveBeenCalled();
  });

  it("is written from the user's requests once the reply is over, and replaces the title", async () => {
    llm.describe.mockResolvedValue({ text: 'Parsing JSON in Rust' });
    await type('How do I parse JSON in Rust?');
    emit(sentId(), { type: 'thought', text: 'Thinking.' });
    emit(sentId(), { type: 'text', delta: 'Use serde_json.' });
    finish();
    expect(llm.describe).toHaveBeenCalledWith({ requests: ['How do I parse JSON in Rust?'] });
    // Nothing waits for it: the old title stands until the description arrives
    expect(threadTitles()).toEqual(['How do I parse JSON in Rust?']);

    await flush();
    expect(threadTitles()).toEqual(['Parsing JSON in Rust']);
    expect($('#thread-title').textContent).toBe('Parsing JSON in Rust');
    expect(saved().threads[0]).toMatchObject({ title: 'Parsing JSON in Rust', described: 1 });
  });

  it('is brought up to date after each further request, from all of them', async () => {
    llm.describe.mockResolvedValue({ text: 'Parsing JSON in Rust' });
    await type('How do I parse JSON in Rust?');
    finish();
    await flush();

    llm.describe.mockResolvedValue({ text: 'JSON and YAML in Rust' });
    await type('And YAML?');
    finish();
    await flush();
    expect(llm.describe).toHaveBeenLastCalledWith({ requests: ['How do I parse JSON in Rust?', 'And YAML?'] });
    expect(threadTitles()).toEqual(['JSON and YAML in Rust']);
  });

  it('is kept across a restart, without being asked for again', async () => {
    llm.describe.mockResolvedValue({ text: 'Parsing JSON in Rust' });
    await type('How do I parse JSON in Rust?');
    finish();
    await flush();
    expect(llm.describe).toHaveBeenCalledTimes(1);

    await start();
    expect(threadTitles()).toEqual(['Parsing JSON in Rust']);
    expect(llm.describe).toHaveBeenCalledTimes(1);
  });

  it('keeps the title it has when no description could be written, and tries again next time', async () => {
    await type('How do I parse JSON in Rust?');
    finish();
    await flush();
    expect(threadTitles()).toEqual(['How do I parse JSON in Rust?']);
    expect(saved().threads[0].described).toBeUndefined();

    llm.describe.mockRejectedValueOnce(new Error('ipc failed'));
    await type('And YAML?');
    finish();
    await flush();
    expect(threadTitles()).toEqual(['How do I parse JSON in Rust?']);

    llm.describe.mockResolvedValue({ text: 'JSON and YAML in Rust' });
    await type('And TOML?');
    finish();
    await flush();
    expect(threadTitles()).toEqual(['JSON and YAML in Rust']);
  });

  it('is written even when the reply failed, since the request was still made', async () => {
    llm.describe.mockResolvedValue({ text: 'Parsing JSON in Rust' });
    await type('How do I parse JSON in Rust?');
    emit(sentId(), { type: 'error', code: 'other', message: 'It broke.' });
    await flush();
    expect(threadTitles()).toEqual(['Parsing JSON in Rust']);
  });

  it('counts the tokens it took towards the thread', async () => {
    llm.describe.mockResolvedValue({
      text: 'Parsing JSON in Rust',
      usage: { purpose: 'description', provider: 'local', model: 'llama3.2:3b', input: 90, output: 4, cost: 0 },
    });
    await type('How do I parse JSON in Rust?');
    finish();
    await flush();
    expect(saved().threads[0].usage['local/llama3.2:3b']).toMatchObject({ input: 90, output: 4 });
  });

  it('is dropped if the thread was deleted while it was being written', async () => {
    let arrive!: (description: { text: string }) => void;
    llm.describe.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    await type('How do I parse JSON in Rust?');
    finish();
    $<HTMLButtonElement>('#thread-list .delete').click();
    arrive({ text: 'Parsing JSON in Rust' });
    await flush();
    expect(threadTitles()).toEqual(['New thread']);
  });
});

describe('what the stylesheet says about hidden elements', () => {
  // The tests run in jsdom with no stylesheet, so nothing else here can see a
  // CSS mistake. This one reads the stylesheet as text.
  const css = () => fs.readFileSync(path.join(process.cwd(), 'styles.css'), 'utf8');
  const markup = () => fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

  it('says display: none for every hidden element it gives a display to', () => {
    // An id selector beats the browser's own `[hidden] { display: none }`, so
    // an element that is hidden in the markup and given a display by its id
    // stays on screen and takes up room. That is how the agent pane once took
    // half the thread's scroll area.
    // Hidden in the markup...
    const inMarkup = [...markup().matchAll(/id="([a-z-]+)"[^>]*\shidden/g)].map((m) => m[1]);
    // ...and hidden by the renderer as it goes, which is the same problem and
    // is how the thread's own pane came to keep half the room while a
    // subagent's was shown. The elements it holds, by the id they came from.
    const source = rendererSource();
    const byVariable = new Map(
      [...source.matchAll(/const (\w+) = element(?:<[^>]*>)?\('([a-z-]+)'\)/g)].map((m) => [m[1], m[2]])
    );
    const atRuntime = [...source.matchAll(/(\w+)\.hidden\s*=/g)]
      .map((m) => byVariable.get(m[1]))
      .filter((id): id is string => Boolean(id));

    const hidden = [...new Set([...inMarkup, ...atRuntime])];
    expect(hidden).toContain('messages');
    expect(hidden).toContain('agent-view');

    // Comments go first: a selector capture reaches back over the comment
    // above it, and a comment that mentions [hidden] would read as a guard
    const sheet = css().replace(/\/\*[\s\S]*?\*\//g, '');
    // The rules that set a display, by the selector that sets it
    const setsDisplay = [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /(^|[\s;])display\s*:/.test(body))
      .map(([, selector]) => selector.trim());

    // Whether a selector is about this element itself, rather than something
    // inside it: the id has to be in the last part, and be the whole id
    const about = (selector: string, id: string) =>
      selector.split(',').some((one) => {
        const subject =
          one
            .trim()
            .split(/[\s>+~]+/)
            .at(-1) ?? '';
        return new RegExp(`#${id}(?![\\w-])`).test(subject);
      });

    const unguarded = hidden.filter((id) => {
      const given = setsDisplay.filter((selector) => !selector.includes('[hidden]') && about(selector, id));
      if (given.length === 0) return false;
      return !setsDisplay.some((selector) => selector.includes('[hidden]') && about(selector, id));
    });
    expect(unguarded).toEqual([]);
  });
});

// The renderer's code: the entry and the modules it loads, as one text
const rendererFiles = () => [
  'src/renderer.ts',
  ...fs
    .readdirSync(path.join(process.cwd(), 'src/renderer'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/renderer/${f}`),
];

const rendererSource = () =>
  rendererFiles()
    .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
    .join('\n');

describe('the renderer is a set of ES modules', () => {
  it('the entry imports the modules and calls start() last', () => {
    const lines = fs
      .readFileSync(path.join(process.cwd(), 'src/renderer.ts'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('//'));
    expect(lines[0]).toMatch(/^import /);
    expect(lines.at(-1)).toBe('start();');
  });

  it('every relative import ends in .js, or the browser cannot find the module', () => {
    const wrong = rendererFiles().flatMap((file) => {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      return [...content.matchAll(/(?:from|import)\s+'(\.[^']*)'/g)]
        .map((m) => m[1])
        .filter((specifier) => !specifier.endsWith('.js'))
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(wrong).toEqual([]);
  });
});

describe('the threads the app starts for itself', () => {
  // The main process saying a look at a workspace has begun or ended
  const looking = (workspace: string, going: boolean, task?: string) => {
    for (const [listener] of threads.onLooking.mock.calls) listener(workspace, going, task);
  };
  // One of the explorer's own events, as the main process passes it on
  const event = (workspace: string, one: unknown) => {
    for (const [listener] of threads.onLookEvent.mock.calls) listener(workspace, one);
  };
  const toggle = () => $<HTMLElement>('#thread-list li.workspace-agents');
  const rows = () => $$<HTMLElement>('#thread-list li').map((el) => el.className.split(' ')[0]);
  const titles = () => $$('#thread-list li.thread .name').map((el) => el.textContent);
  // The app's own threads, which are the ones this is about
  const ours = () => $$('#thread-list li.thread.automatic .name').map((el) => el.textContent);
  const open = () => toggle()?.click();

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('is a thread of its own, hidden behind an arrow under the workspace', () => {
    expect(toggle()).toBeNull();
    looking('/projects/demo', true, 'Get to know the project in this workspace.');

    // An arrow under the workspace, above the user's own threads
    expect(rows().slice(0, 3)).toEqual(['group', 'agents', 'thread']);
    expect(toggle().textContent).toContain('1 automatic thread running');
    expect(toggle().title).toBe('Show the 1 automatic thread running');
    // ...and what is behind it is not among them until it is asked for
    expect(ours()).toEqual([]);

    open();
    expect(ours()).toEqual(['Getting to know the project']);
    // Open, it still says what is behind it, as the subagents' row does
    expect(toggle().textContent).toBe('▾1 automatic thread running');
    expect(toggle().title).toBe('Hide the 1 automatic thread');
  });

  it('says it is working while it is, and stops when the look ends', () => {
    looking('/projects/demo', true);
    open();
    const mark = () => $$('#thread-list li.thread.automatic .status.working').length;
    expect(mark()).toBe(1);
    looking('/projects/demo', false);
    expect(mark()).toBe(0);
    // The thread stays where it was: what it did is worth reading afterwards
    expect(ours()).toEqual(['Getting to know the project']);
    expect(toggle().title).toBe('Hide the 1 automatic thread');
  });

  it('draws what the app asked for itself apart from what a user typed', async () => {
    looking('/projects/demo', true, 'Get to know the project in this workspace.');
    surveyed('/projects/demo', 'It is a TypeScript app.');
    looking('/projects/demo', false);
    open();
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();

    // The task holds the user's turn, but nobody typed it
    const asked = $<HTMLElement>('#messages .message.user');
    expect(asked.textContent).toBe('Get to know the project in this workspace.');
    expect(asked.className).toContain('system');
    // ...while the thread the user types in is unmarked
    expect($$('#messages .message.assistant')[0].className).not.toContain('system');
  });

  it('reads as a thread reads: what it was asked, its thoughts, its tools, its answer', async () => {
    looking('/projects/demo', true, 'Get to know the project in this workspace.');
    event('/projects/demo', { type: 'thought', text: 'Looking at the layout.' });
    event('/projects/demo', { type: 'tool_call', id: 'c1', name: 'list_files', input: { path: 'src' } });
    event('/projects/demo', { type: 'tool_result', id: 'c1', name: 'list_files', output: 'main.ts', isError: false });
    surveyed('/projects/demo', 'It is a TypeScript app.');
    looking('/projects/demo', false);

    open();
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();
    expect(messages()).toEqual([
      'user: Get to know the project in this workspace.',
      'work: Work',
      'thought: Looking at the layout.',
      'tool: Listed src',
      'assistant: It is a TypeScript app.',
    ]);
    expect($('#thread-title').textContent).toBe('Getting to know the project');
  });

  it('shows the explorers the head sends as its own subagents, with tabs, as a thread does', async () => {
    looking('/projects/demo', true, 'Get to know the project in this workspace.');
    event('/projects/demo', { type: 'thought', text: 'Looking at the layout.' });
    // The head hands two areas out, and they report as any subagent does
    event('/projects/demo', {
      type: 'subagent',
      id: 's1',
      name: 'the tests',
      task: 'how the tests run',
      kind: 'explorer',
    });
    event('/projects/demo', {
      type: 'subagent',
      id: 's2',
      name: 'the build',
      task: 'how it is built',
      kind: 'explorer',
    });
    event('/projects/demo', {
      type: 'subagent_update',
      id: 's1',
      event: { type: 'thought', text: 'They are Vitest.' },
    });
    event('/projects/demo', { type: 'subagent_done', id: 's1', text: 'Vitest, one file each.', isError: false });

    open();
    // While they work, the thread says what it is waiting for, as a reply does
    expect($('#thread-list li.thread.automatic .status.working')).not.toBeNull();
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();
    expect(messages().at(-1)).toBe('note: Waiting on 1 subagent…');
    expect($$('#messages .subagent .open').map((el) => el.textContent)).toEqual([
      'Subagent: the tests',
      'Subagent: the build — working…',
    ]);

    // ...and each opens in a tab of its own, with its work in it
    $$<HTMLElement>('#messages .subagent .open')[0].click();
    await flush();
    expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'the tests']);
    expect($('#agent-view').textContent).toContain('They are Vitest.');
    expect($('#agent-view .message.assistant').textContent).toBe('Vitest, one file each.');
  });

  it('counts what the look cost against the thread that did it', async () => {
    looking('/projects/demo', true);
    event('/projects/demo', {
      type: 'usage',
      purpose: 'subagent',
      provider: 'local',
      model: 'llama3.2:3b',
      input: 900,
      output: 120,
      cost: 0,
    });
    looking('/projects/demo', false);
    open();
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();
    expect(messages().at(-1)).toBe('note: Tokens: 900 in · 120 out · free');
    // ...and towards its running total, as any other work in a thread is
    expect($('#thread-usage-summary').textContent).toContain('1K tokens');
  });

  it('is not named after its task, and offers nobody a way to write to it', async () => {
    looking('/projects/demo', true, 'Get to know the project in this workspace.');
    open();
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();
    // It is doing a job it was given; there is nobody in it to write to, and
    // nothing to stop (see render)
    expect($<HTMLElement>('#composer').hidden).toBe(true);

    looking('/projects/demo', false);
    expect(llm.describe).not.toHaveBeenCalled();
    expect($('#thread-title').textContent).toBe('Getting to know the project');
    // ...and still nobody, now that it is done: what it found is in the note
    expect($<HTMLElement>('#composer').hidden).toBe(true);
  });

  it('is kept, with what it did, after a restart', async () => {
    looking('/projects/demo', true);
    event('/projects/demo', { type: 'thought', text: 'Looking at the layout.' });
    looking('/projects/demo', false);
    open();
    await start();
    expect(ours()).toEqual(['Getting to know the project']);
    $<HTMLElement>('#thread-list li.thread.automatic .name').click();
    await flush();
    expect(messages().join('\n')).toContain('Looking at the layout.');
  });

  it('starts a thread of its own for the next look, rather than writing under an answer', () => {
    looking('/projects/demo', true);
    event('/projects/demo', { type: 'thought', text: 'The first look.' });
    looking('/projects/demo', false);
    looking('/projects/demo', true);
    event('/projects/demo', { type: 'thought', text: 'The second look.' });
    expect(toggle().textContent).toContain('1 automatic thread running');
    open();
    expect(ours()).toEqual(['Getting to know the project', 'Getting to know the project']);
  });

  it('picks up a look that began before this window opened', async () => {
    threads.looking.mockResolvedValue(['/projects/demo']);
    await start();
    await flush();
    expect(toggle().textContent).toContain('1 automatic thread running');
  });

  it('shows it only under the workspace it is about, and only when that is open', () => {
    looking('/projects/other', true);
    expect(toggle()).toBeNull();

    looking('/projects/demo', true);
    expect(toggle()).not.toBeNull();
    $<HTMLElement>('#thread-list li.group').click();
    expect(toggle()).toBeNull();
  });

  it('takes no notice of events for a workspace nothing is known about', () => {
    event('/projects/unknown', { type: 'thought', text: 'nothing' });
    expect(messages().join('\n')).not.toContain('nothing');
    expect(toggle()).toBeNull();
  });
});

describe('what a workspace is keeping, on a right-click in the sidebar', () => {
  const rightClick = async (el: Element) => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
  };
  const group = (n = 0) => $$<HTMLElement>('#thread-list li.group')[n];
  const body = () => $('#workspace-dialog-body').textContent ?? '';
  const notesList = () => $('#workspace-notes-list').textContent ?? '';
  const open = () => $<HTMLDialogElement>('#workspace-dialog').open;
  // Typing in the notes search box, which waits for the typing to stop before
  // it asks for anything (see SEARCH_DELAY_MS)
  const typeNoteQuery = async (query: string) => {
    const box = $<HTMLInputElement>('#workspace-notes-query');
    box.value = query;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flush();
  };

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('shows the notes every thread in that workspace is given', async () => {
    threads.workspace.mockResolvedValue({
      note: 'A TypeScript parser, tested with Vitest.',
      writtenAt: new Date().toISOString(),
      surveying: false,
      notes: [],
      moreNotes: 0,
    });
    await rightClick(group());
    expect(open()).toBe(true);
    expect(threads.workspace).toHaveBeenCalledWith('/projects/demo');
    expect($('#workspace-dialog-name').textContent).toBe('demo');
    expect(body()).toContain('Workspace notes');
    expect(body()).toContain('A TypeScript parser, tested with Vitest.');
    // The path, how many threads are in it, and how old what is being read is
    const about = $('#workspace-dialog-path').textContent ?? '';
    expect(about).toContain('/projects/demo');
    expect(about).toContain('1 thread');
    expect(about).toContain('written just now');
  });

  it('says so for a workspace nothing has been written about yet', async () => {
    threads.workspace.mockResolvedValue({ note: '', writtenAt: null, surveying: false, notes: [], moreNotes: 0 });
    threads.relook.mockResolvedValue('');
    threads.looking.mockResolvedValue([]);
    await rightClick(group());
    expect(body()).toContain('Nothing has been written about this workspace yet');
  });

  it('says a look is going on when one is', async () => {
    threads.workspace.mockResolvedValue({ note: '', writtenAt: null, surveying: true, notes: [], moreNotes: 0 });
    await rightClick(group());
    expect(body()).toContain('An explorer is going through this workspace now');
    expect($('#workspace-dialog-path').textContent).toContain('being looked at now');
  });

  it('shows the notes behind that one note, newest first, with what each came from', async () => {
    threads.workspace.mockResolvedValue({
      note: 'A TypeScript parser.',
      writtenAt: null,
      surveying: false,
      notes: [
        {
          subject: 'Running the tests',
          content: 'npm test runs vitest from the top.',
          writtenAt: new Date().toISOString(),
          files: ['package.json', 'vitest.config.mts'],
        },
      ],
      moreNotes: 0,
    });
    await rightClick(group());
    expect($('#workspace-notes-label').textContent).toBe('Notes · 1');
    const shown = notesList();
    expect(shown).toContain('Running the tests');
    expect(shown).toContain('npm test runs vitest from the top.');
    // What it was worked out from, and how old it is
    expect(shown).toContain('package.json, vitest.config.mts');
    expect(shown).toContain('written just now');
  });

  it('marks a note whose files have moved on since it was written', async () => {
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [
        {
          subject: 'The parser',
          content: 'It parses tokens.',
          writtenAt: new Date().toISOString(),
          files: ['src/parser.ts', 'src/lexer.ts'],
          drift: { changed: ['src/parser.ts'], gone: ['src/lexer.ts'] },
        },
      ],
      moreNotes: 0,
    });
    await rightClick(group());
    const stale = $('#workspace-notes-list .note-stale');
    expect(stale?.textContent).toBe('src/lexer.ts is no longer there; src/parser.ts has changed');
    // Still shown: it is the best anybody has written about this
    expect(notesList()).toContain('It parses tokens.');
  });

  it('says which thread a note belongs to while it is still only that thread’s', async () => {
    const mine = saved().threads[0];
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [
        {
          subject: 'The new emitter',
          content: 'Added in this thread.',
          writtenAt: new Date().toISOString(),
          files: [],
          thread: mine.id,
        },
      ],
      moreNotes: 0,
    });
    await rightClick(group());
    expect(notesList()).toContain(`in the thread “${mine.title}”`);
  });

  it('says how many there are when it is showing only the newest of them', async () => {
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [{ subject: 'One', content: 'A note.', writtenAt: new Date().toISOString(), files: [] }],
      moreNotes: 49,
    });
    await rightClick(group());
    expect($('#workspace-notes-label').textContent).toBe('Notes · 50 · showing the newest 1');
  });

  it('says so for a workspace nothing has been written down in', async () => {
    await rightClick(group());
    expect(notesList()).toContain('Nothing has been written down here yet');
    expect($('#workspace-notes-label').textContent).toBe('Notes');
  });

  it('searches them by meaning, the same way a model does, once enough has been typed', async () => {
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [{ subject: 'One', content: 'A note.', writtenAt: new Date().toISOString(), files: [] }],
      moreNotes: 0,
    });
    threads.searchNotes.mockResolvedValue([
      {
        subject: 'The docker image',
        content: 'One image per toolchain.',
        writtenAt: new Date().toISOString(),
        files: ['src/sandbox/docker.ts'],
      },
    ]);
    await rightClick(group());

    // Too short to search by meaning, so nothing is asked for
    await typeNoteQuery('do');
    expect(threads.searchNotes).not.toHaveBeenCalled();
    expect(notesList()).toContain('A note.');

    await typeNoteQuery('which docker image');
    expect(threads.searchNotes).toHaveBeenCalledWith('/projects/demo', 'which docker image');
    expect($('#workspace-notes-label').textContent).toBe('Notes matching “which docker image” · 1');
    expect(notesList()).toContain('One image per toolchain.');

    // Clearing the box puts the newest back
    await typeNoteQuery('');
    expect(notesList()).toContain('A note.');
  });

  it('says when no note is about what was searched for, and when the search failed', async () => {
    threads.searchNotes.mockResolvedValue([]);
    await rightClick(group());
    await typeNoteQuery('the docker image');
    expect(notesList()).toContain('No note here is about that.');

    threads.searchNotes.mockRejectedValue(new Error('No Ollama reachable.'));
    await typeNoteQuery('the parser');
    expect(notesList()).toContain('could not be searched: No Ollama reachable.');
  });

  it('leaves the results of a search alone while a look fills the note above them', async () => {
    threads.searchNotes.mockResolvedValue([
      { subject: 'The docker image', content: 'One image per toolchain.', writtenAt: null as never, files: [] },
    ]);
    await rightClick(group());
    await typeNoteQuery('the docker image');
    threads.workspace.mockResolvedValue({
      note: 'A fresh note.',
      writtenAt: null,
      surveying: false,
      notes: [{ subject: 'Something else', content: 'Not what was searched for.', writtenAt: '', files: [] }],
      moreNotes: 0,
    });
    threads.relook.mockResolvedValue('A fresh note.');
    $('#workspace-dialog-relook').click();
    await flush();
    expect(body()).toContain('A fresh note.');
    expect(notesList()).toContain('One image per toolchain.');
    expect(notesList()).not.toContain('Not what was searched for.');
  });

  it('throws one of those notes away when the user asks, and shows what is left', async () => {
    const one = (subject: string) => ({ subject, content: `What ${subject} is.`, writtenAt: '', files: [] });
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [one('The parser'), one('Running the tests')],
      moreNotes: 0,
    });
    threads.forgetNote.mockResolvedValue(true);
    await rightClick(group());
    expect($('#workspace-notes-label').textContent).toBe('Notes · 2');

    // What is left is read back from the store rather than patched on screen,
    // so the count in the heading says what is really there
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [one('Running the tests')],
      moreNotes: 0,
    });
    $$<HTMLButtonElement>('#workspace-notes-list .note .delete')[0].click();
    await flush();
    expect(threads.forgetNote).toHaveBeenCalledWith('/projects/demo', 'The parser', undefined);
    expect($('#workspace-notes-label').textContent).toBe('Notes · 1');
    expect(notesList()).not.toContain('What The parser is.');
    expect(notesList()).toContain('What Running the tests is.');
  });

  it('names the thread a note still belongs to when throwing it away', async () => {
    const mine = saved().threads[0];
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [
        { subject: 'The new emitter', content: 'Added in this thread.', writtenAt: '', files: [], thread: mine.id },
      ],
      moreNotes: 0,
    });
    threads.forgetNote.mockResolvedValue(true);
    await rightClick(group());
    $<HTMLButtonElement>('#workspace-notes-list .note .delete').click();
    await flush();
    expect(threads.forgetNote).toHaveBeenCalledWith('/projects/demo', 'The new emitter', mine.id);
  });

  it('runs the search again when one is thrown away from its results, not the newest instead', async () => {
    threads.searchNotes.mockResolvedValue([
      { subject: 'The docker image', content: 'One image per toolchain.', writtenAt: '', files: [] },
    ]);
    threads.forgetNote.mockResolvedValue(true);
    await rightClick(group());
    await typeNoteQuery('which docker image');

    threads.searchNotes.mockResolvedValue([]);
    $<HTMLButtonElement>('#workspace-notes-list .note .delete').click();
    await flush();
    expect(threads.searchNotes).toHaveBeenLastCalledWith('/projects/demo', 'which docker image');
    expect($('#workspace-notes-label').textContent).toBe('Notes matching “which docker image” · 0');
  });

  it('says on the button when a note could not be thrown away, and lets it be tried again', async () => {
    threads.workspace.mockResolvedValue({
      note: '',
      writtenAt: null,
      surveying: false,
      notes: [{ subject: 'The parser', content: 'It parses tokens.', writtenAt: '', files: [] }],
      moreNotes: 0,
    });
    threads.forgetNote.mockRejectedValue(new Error('notes.json is read-only.'));
    await rightClick(group());
    const button = $<HTMLButtonElement>('#workspace-notes-list .note .delete');
    button.click();
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.title).toContain('could not be thrown away: notes.json is read-only.');
    expect(notesList()).toContain('It parses tokens.');
  });

  it('says plainly when the notes could not be read', async () => {
    threads.workspace.mockRejectedValue(new Error('nope'));
    await rightClick(group());
    expect(body()).toContain('could not be read');
  });

  it('throws the notes away and sends an explorer through again when asked', async () => {
    threads.workspace.mockResolvedValue({
      note: 'A stale note.',
      writtenAt: null,
      surveying: false,
      notes: [],
      moreNotes: 0,
    });
    await rightClick(group());
    expect(body()).toContain('A stale note.');

    const relook = $<HTMLButtonElement>('#workspace-dialog-relook');
    expect(relook.disabled).toBe(false);
    // The look is held open so the dialog can be caught mid-way
    let finish!: (note: string) => void;
    threads.relook.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
    threads.workspace.mockResolvedValue({ note: '', writtenAt: null, surveying: true, notes: [], moreNotes: 0 });
    relook.click();
    await flush();

    // It cannot be asked for twice, and says what is going on
    expect(threads.relook).toHaveBeenCalledWith('/projects/demo', expect.any(String));
    expect(relook.disabled).toBe(true);
    expect(relook.textContent).toBe('Looking…');
    expect(body()).toContain('An explorer is going through this workspace now');

    // ...and fills in with what it wrote once it is over
    threads.workspace.mockResolvedValue({
      note: 'A fresh note.',
      writtenAt: new Date().toISOString(),
      surveying: false,
      notes: [],
      moreNotes: 0,
    });
    finish('A fresh note.');
    await flush();
    expect(body()).toContain('A fresh note.');
    expect(relook.disabled).toBe(false);
    expect(relook.textContent).toBe('Look again');
  });

  it('cannot be asked for while a look is already going on', async () => {
    threads.workspace.mockResolvedValue({ note: '', writtenAt: null, surveying: true, notes: [], moreNotes: 0 });
    await rightClick(group());
    const relook = $<HTMLButtonElement>('#workspace-dialog-relook');
    expect(relook.disabled).toBe(true);
    relook.click();
    await flush();
    expect(threads.relook).not.toHaveBeenCalled();
  });

  it('says what the workspace has now when the look could not be made', async () => {
    threads.workspace.mockResolvedValue({
      note: 'The note it had.',
      writtenAt: null,
      surveying: false,
      notes: [],
      moreNotes: 0,
    });
    await rightClick(group());
    threads.relook.mockRejectedValue(new Error('no models'));
    $('#workspace-dialog-relook').click();
    await flush();
    // The note it had is kept, and the button is ready to be tried again
    expect(body()).toContain('The note it had.');
    expect($<HTMLButtonElement>('#workspace-dialog-relook').disabled).toBe(false);
  });

  it('leads on to naming the workspace, and to a new thread in it', async () => {
    await rightClick(group());
    $('#workspace-dialog-rename').click();
    expect(open()).toBe(false);
    expect($<HTMLDialogElement>('#rename-workspace-dialog').open).toBe(true);
    $('#rename-workspace-cancel').click();

    const before = threadTitles().length;
    await rightClick(group());
    $('#workspace-dialog-new').click();
    expect(open()).toBe(false);
    expect(threadTitles().length).toBe(before + 1);
  });

  it('has nothing to show for the general chats, which are in no workspace', async () => {
    await newThread(null);
    await flush();
    const general = $$<HTMLElement>('#thread-list li.group').find((g) => g.title === '');
    await rightClick(general!);
    expect(open()).toBe(false);
  });
});

describe('what a thread is keeping, on a right-click in the sidebar', () => {
  const rightClick = async (el: Element) => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
  };
  const item = (n = 0) => $$<HTMLElement>('#thread-list li.thread')[n];
  const body = () => $('#thread-dialog-body').textContent ?? '';

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  // Working a change through in four steps buys a plan the user can stop
  // before anything happens, and costs four passes over the model where one
  // would have done, so it is theirs to turn on (see harness/phases.ts)
  describe('planning a change before making it', () => {
    const mode = () => $<HTMLSelectElement>('#thread-plan-mode');
    const section = () => $('#thread-plan');
    // The thread on screen, which is the one the messages below go to: the
    // sidebar is grouped by workspace and does not run in the order the
    // threads are saved in
    const open = () => $('#thread-list li.thread.active');
    // The reply to the message the setup sent is still running, and a thread
    // with one in flight takes the next submit as Stop
    const asks = async (what: string) => {
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await type(what);
    };
    const setPlan = async (to: 'always' | 'auto' | 'never') => {
      await rightClick(open());
      mode().value = to;
      mode().dispatchEvent(new Event('change'));
      $('#thread-dialog-close').click();
    };

    const kept = () => saved().threads.map((t: { plan?: string }) => t.plan);

    it('is offered for a thread with code in it, and left to the model until it is asked for', async () => {
      await rightClick(open());
      expect(section().hidden).toBe(false);
      expect(mode().value).toBe('auto');
      expect(kept().every((plan: string | undefined) => plan === undefined)).toBe(true);
    });

    it('is not offered for a general chat, which has no files to plan a change to', async () => {
      await newThread(null);
      await rightClick(open());
      expect(section().hidden).toBe(true);
    });

    it('is kept with the thread and sent with what it asks for next, whether always or never', async () => {
      await setPlan('always');
      expect(kept()).toContain('always');
      await asks('change the parser');
      expect(sent().plan).toBe('always');
      await setPlan('never');
      expect(kept()).toContain('never');
      await asks('change the lexer');
      expect(sent().plan).toBe('never');
    });

    it('goes back to the model deciding, and stops being sent, when it is put back', async () => {
      await setPlan('never');
      await setPlan('auto');
      expect(kept().every((plan: string | undefined) => plan === undefined)).toBe(true);
      await asks('change the parser');
      expect(sent().plan).toBeUndefined();
    });

    it('is remembered after a restart, and shown as it was left', async () => {
      await setPlan('never');
      await start();
      await rightClick(open());
      expect(mode().value).toBe('never');
    });

    it('reads a thread saved when this was a switch that was on as always', async () => {
      await setPlan('always');
      const state = saved();
      for (const t of state.threads) if (t.plan) t.plan = true;
      onDisk = JSON.stringify(state);
      await start();
      await rightClick(open());
      expect(mode().value).toBe('always');
    });

    it('is offered for a thread with code, unchecked, and is sent with what it asks for once checked', async () => {
      const investigate = () => $<HTMLInputElement>('#thread-investigate-mode');
      await rightClick(open());
      expect($('#thread-investigate').hidden).toBe(false);
      expect(investigate().checked).toBe(false);
      investigate().checked = true;
      investigate().dispatchEvent(new Event('change'));
      $('#thread-dialog-close').click();
      await asks('change the parser');
      expect(sent().investigate).toBe(true);
    });

    it("is one thread's own: another thread is still left to the model", async () => {
      await setPlan('always');
      emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
      await newThread('/projects/demo');
      await type('change the lexer');
      expect(sent().plan).toBeUndefined();
    });
  });

  it("shows the notes the thread keeps for itself, and what it made of the workspace's", async () => {
    threads.details.mockResolvedValue({
      context: 'Goal: build the parser. Done: the lexer.',
      note: 'A parser.\nBuilt with esbuild.',
      shared: 'A parser.',
    });
    await rightClick(item());
    expect($<HTMLDialogElement>('#thread-dialog').open).toBe(true);
    expect(threads.details).toHaveBeenCalledWith(expect.any(String), '/projects/demo');
    expect($('#thread-dialog-path').textContent).toBe('In demo');
    expect(body()).toContain('Thread context');
    expect(body()).toContain('Goal: build the parser. Done: the lexer.');
    // What it added to the workspace notes, as a diff
    expect(body()).toContain('Changes to the workspace notes');
    const diff = $$<HTMLElement>('#thread-dialog-body pre.diff span').map((el) => el.textContent?.trimEnd());
    expect(diff).toEqual([' A parser.', '+Built with esbuild.']);
    expect($('#thread-dialog-body pre.diff .add')!.textContent?.trim()).toBe('+Built with esbuild.');
  });

  it('marks what the thread added, removed and left alone in the middle of the notes', async () => {
    threads.details.mockResolvedValue({
      context: '',
      shared: 'What it is.\nHow it is built.\nA stale line.',
      note: 'What it is.\nHow it is tested.\nHow it is built.',
    });
    await rightClick(item());
    const diff = $$<HTMLElement>('#thread-dialog-body pre.diff span').map((el) => el.textContent?.trimEnd());
    // The smallest set of changes, not the first one that would do
    expect(diff).toEqual([' What it is.', '+How it is tested.', ' How it is built.', '-A stale line.']);
    const marked = (kind: string) =>
      $$<HTMLElement>(`#thread-dialog-body pre.diff .${kind}`).map((el) => el.textContent?.trimEnd());
    expect(marked('add')).toEqual(['+How it is tested.']);
    expect(marked('del')).toEqual(['-A stale line.']);
  });

  it('is all additions for a thread that wrote the notes from nothing', async () => {
    threads.details.mockResolvedValue({ context: '', shared: '', note: 'A parser.\nTested with Vitest.' });
    await rightClick(item());
    const diff = $$<HTMLElement>('#thread-dialog-body pre.diff span').map((el) => el.textContent?.trimEnd());
    expect(diff).toEqual(['+A parser.', '+Tested with Vitest.']);
  });

  it('says so when the thread has changed nothing and written nothing', async () => {
    threads.details.mockResolvedValue({ context: '', note: 'A parser.', shared: 'A parser.' });
    await rightClick(item());
    expect(body()).toContain('This thread has written nothing down for itself yet');
    expect(body()).toContain('This thread has not changed the workspace notes.');
    expect($('#thread-dialog-body pre.diff')).toBeNull();
  });

  it('leaves out the workspace notes for a general chat, which has none', async () => {
    await newThread(null);
    await type('hello');
    threads.details.mockResolvedValue({ context: 'Thinking.', note: '', shared: '' });
    await rightClick(item());
    expect($('#thread-dialog-path').textContent).toBe('A general chat, with no workspace');
    expect(body()).toContain('Thinking.');
    expect(body()).not.toContain('workspace notes');
  });

  it("leads on to the thread's file changes", async () => {
    threads.changes.mockResolvedValue({ files: [], baseline: true });
    await rightClick(item());
    $('#thread-dialog-changes').click();
    await flush();
    expect($<HTMLDialogElement>('#thread-dialog').open).toBe(false);
    expect($<HTMLDialogElement>('#changes-dialog').open).toBe(true);
  });
});

describe('a workspace that is looked at for the first time', () => {
  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('leaves a note that opens to show what was noted about the workspace, when it is pushed', async () => {
    surveyed('/projects/demo', 'A demo parser, tested with Vitest.');
    // The note the push left, which is not the only one on screen
    const note = () =>
      $$<HTMLElement>('#messages .note')
        .find((el) => el.textContent?.includes('Gathered context on this workspace'))!
        .querySelector('details') as HTMLDetailsElement;
    expect(messages()).toContain('note: Gathered context on this workspace');
    expect(note().open).toBe(false);
    expect(note().querySelector('pre')!.textContent).toBe('A demo parser, tested with Vitest.');

    // Once, however many times it is pushed
    surveyed('/projects/demo', 'A demo parser, tested with Vitest.');
    expect(messages().filter((line) => line === 'note: Gathered context on this workspace')).toHaveLength(1);

    // ...and it is kept with the thread
    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    emit(sentId(), { type: 'text', delta: 'Hello.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await start();
    expect(messages()).toContain('note: Gathered context on this workspace');
    expect(note().querySelector('pre')!.textContent).toBe('A demo parser, tested with Vitest.');
  });

  it('shows what was found in every thread in that workspace, and in no other', async () => {
    // A second thread in another workspace, which is the one on screen
    await newThread('/projects/other');
    await flush();
    surveyed('/projects/demo', 'A demo parser.');
    expect(messages()).not.toContain('note: Gathered context on this workspace');

    // The first thread, in the workspace that was looked at, was told
    $$<HTMLElement>('#thread-list li.thread:not(.active)')[0].click();
    await flush();
    expect(messages()).toContain('note: Gathered context on this workspace');
  });

  it('is not sent back to the model as part of the conversation', async () => {
    surveyed('/projects/demo', 'A demo parser.');
    emit(sentId(), { type: 'text', delta: 'Hello.' });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await type('next');
    expect(sent().messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'next' },
    ]);
  });
});

describe('a reply that has not started arriving', () => {
  // There is no bubble for it: the newest Work dropdown says "Working…" and
  // carries the dots, and is drawn empty if the reply has not made one yet
  const dots = () => $$('#messages .message.work summary .waiting i');
  const bubbles = () => $$('#messages .message.assistant');

  beforeEach(async () => {
    await type('hi');
    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    emit(sentId(), {
      type: 'model',
      provider: 'local',
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      sophistication: 1,
      reason: 'matched',
    });
  });

  it('shows three dots after "Working…" in the Work dropdown, with no bubble of its own', () => {
    expect(dots()).toHaveLength(3);
    expect($('#messages .waiting').getAttribute('role')).toBe('status');
    expect($('#messages .message.work').classList.contains('working')).toBe(true);
    expect($('#messages .message.work summary').textContent).toBe('Working…');
    expect(messages().at(-1)).toBe('work: Working…');
    expect(bubbles()).toEqual([]);
  });

  it('carries the wave on from where it was when the dropdown is rebuilt', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(5000);
    emit(sentId(), { type: 'thought', text: 'Thinking.' });
    // 5000 ms into a wave that goes round every 1200 ms
    expect($<HTMLElement>('#messages .waiting').style.getPropertyValue('--phase')).toBe('-200ms');
    now.mockRestore();
  });

  it('gives way to the reply as soon as its first words arrive', () => {
    emit(sentId(), { type: 'text', delta: 'Hello' });
    expect(dots()).toEqual([]);
    expect($$('#messages .message.working')).toEqual([]);
    expect(messages().join('\n')).not.toContain('Working…');
    expect(messages().at(-1)).toBe('assistant: Hello');
  });

  it('is not shown while the message is still being classified, or once the reply is over', async () => {
    emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 0 });
    expect(dots()).toEqual([]);
    expect(messages().join('\n')).not.toContain('Working…');
    await type('again');
    // Still the status line, not a bubble
    expect(dots()).toEqual([]);
    expect(messages().at(-1)).toBe('note: Classifying complexity & routing…');
  });

  it('marks the block already holding a thought as working, rather than adding a second', () => {
    emit(sentId(), { type: 'thought', text: 'Thinking.' });
    expect($$('#messages .message.work')).toHaveLength(1);
    expect($('#messages .message.work').classList.contains('working')).toBe(true);
    expect($('#messages .message.work summary').textContent).toBe('Working…');
    expect(dots()).toHaveLength(3);
    expect(messages().slice(-2)).toEqual(['work: Working…', 'thought: Thinking.']);
    expect(bubbles()).toEqual([]);

    emit(sentId(), { type: 'text', delta: 'Hello' });
    expect(dots()).toEqual([]);
    expect(messages().slice(-3)).toEqual(['work: Work', 'thought: Thinking.', 'assistant: Hello']);
  });

  it('draws a block of its own when a note came between the last Work block and the empty bubble', () => {
    emit(sentId(), { type: 'text', delta: 'Change a.ts.' });
    emit(sentId(), { type: 'plan', text: 'Change a.ts.' });
    expect(messages().slice(-2)).toEqual(['plan: PlanChange a.ts.', 'work: Working…']);
    expect($$('#messages .message.work')).toHaveLength(1);
    expect(dots()).toHaveLength(3);
    expect(bubbles()).toEqual([]);

    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 1, output: 1 }, steps: 2 });
    expect(dots()).toEqual([]);
    expect(messages().join('\n')).not.toContain('Working…');
  });
});

describe("a thread's changes to its workspace", () => {
  const FOLDER = '/projects/demo';
  const button = () => $<HTMLButtonElement>('#thread-changes');
  const dialog = () => $<HTMLDialogElement>('#changes-dialog');
  const apply = () => $<HTMLButtonElement>('#changes-apply');
  const status = () => $('#changes-status').textContent;
  const files = () => $$('#changes-files details summary').map((s) => s.textContent);
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  const changed = {
    files: [
      { path: 'src/a.ts', status: 'modified', binary: false, diff: '@@ -1,2 +1,2 @@\n line 1\n-old\n+new' },
      { path: 'src/new.ts', status: 'added', binary: false, diff: '@@ -0,0 +1 @@\n+hello' },
      { path: 'gone.txt', status: 'deleted', binary: false, diff: '' },
    ],
  };
  const open = async () => {
    button().click();
    await flush();
  };

  beforeEach(async () => {
    await newThread(FOLDER);
  });

  it('has a button only in a thread that was started in a workspace', async () => {
    expect(button().hidden).toBe(false);
    expect(button().textContent).toBe('Changes');
    await newThread(null);
    expect(button().hidden).toBe(true);
  });

  it('counts the changes after a reply, and cannot be opened while a reply is being written', async () => {
    threads.changes.mockResolvedValue(changed);
    await type('make the change');
    expect(button().disabled).toBe(true);
    expect(threads.changes).not.toHaveBeenCalled();

    finish();
    await flush();
    expect(threads.changes).toHaveBeenCalledWith(saved().activeId);
    expect(button().textContent).toBe('Changes (3)');
    expect(button().disabled).toBe(false);
  });

  it('marks the thread green in the sidebar while changes wait, even though it has been read', async () => {
    threads.changes.mockResolvedValue(changed);
    await type('make the change');
    finish();
    await flush();
    const dot = $('#thread-list li:not(.group) .status');
    expect(dot.classList.contains('changed')).toBe(true);
    expect(dot.title).toBe('Changes to write back');

    threads.changes.mockResolvedValue({ files: [] });
    await open();
    expect($$('#thread-list li:not(.group) .status')).toHaveLength(0);
  });

  it('keeps the count with the thread, so the mark is there again after a restart', async () => {
    threads.changes.mockResolvedValue(changed);
    await type('make the change');
    finish();
    await flush();
    await vi.waitFor(() => expect(saved().threads[0].changes).toBe(3), { timeout: 3000 });

    threads.changes.mockClear();
    await start();
    expect($('#thread-list li:not(.group) .status').classList.contains('changed')).toBe(true);
    expect(button().textContent).toBe('Changes (3)');
    expect(threads.changes).not.toHaveBeenCalled();

    threads.changes.mockResolvedValue({ files: [] });
    await open();
    await vi.waitFor(() => expect(saved().threads[0].changes).toBeUndefined(), { timeout: 3000 });
  });

  it('shows each changed file, opening to its diff, and writes nothing by being looked at', async () => {
    threads.changes.mockResolvedValue(changed);
    await open();
    expect(dialog().open).toBe(true);
    expect($('#changes-hint').textContent).toContain(FOLDER);
    expect(files()).toEqual(['Changedsrc/a.ts+1 −1', 'Addedsrc/new.ts+1 −0', 'Deletedgone.txt']);

    const [first, , last] = $$('#changes-files details');
    // Each line of the diff with its kind and its line numbers, old and new
    expect(
      [...first.querySelectorAll('.row')].map((row) => [
        row.className,
        ...[...row.querySelectorAll('.number')].map((n) => n.textContent),
        row.querySelector('code')!.textContent,
      ])
    ).toEqual([
      ['row hunk', '', '', '@@ -1,2 +1,2 @@'],
      ['row context', '1', '1', ' line 1'],
      ['row del', '2', '', '-old'],
      ['row add', '', '2', '+new'],
    ]);
    expect(last.querySelector('.diff')!.textContent).toBe('Nothing to show for this file.');
    expect(apply().disabled).toBe(false);
    expect(threads.applyChanges).not.toHaveBeenCalled();
  });

  it("reverts the thread's own copy when asked, and writes nothing to the workspace", async () => {
    threads.changes.mockResolvedValue(changed);
    await open();
    threads.discardChanges.mockResolvedValue(true);
    threads.changes.mockResolvedValue({ files: [] });
    $<HTMLButtonElement>('#changes-revert').click();
    await flush();
    expect(threads.discardChanges).toHaveBeenCalledWith(saved().activeId);
    expect(threads.applyChanges).not.toHaveBeenCalled();
    expect(status()).toBe("Reverted. The thread's files are as they were before its changes.");
    expect($<HTMLButtonElement>('#changes-revert').disabled).toBe(true);
  });

  it('says so when there is nothing to write, or when the changes cannot be told', async () => {
    await open();
    expect(status()).toBe('This thread has no changes waiting to be written to the workspace.');
    expect(apply().disabled).toBe(true);
    $('#changes-close').click();
    expect(dialog().open).toBe(false);

    threads.changes.mockResolvedValue({ files: [], unavailable: 'Its container was made without a record.' });
    await open();
    expect(status()).toBe('Its container was made without a record.');
    expect(apply().disabled).toBe(true);
  });

  it('writes the changes to the workspace when asked, and says what was written', async () => {
    threads.changes.mockResolvedValue(changed);
    threads.applyChanges.mockImplementation(async () => {
      threads.changes.mockResolvedValue({ files: [] });
      return { applied: ['src/a.ts', 'src/new.ts', 'gone.txt'], conflicts: [], skipped: [] };
    });
    await open();
    apply().click();
    await flush();

    expect(threads.applyChanges).toHaveBeenCalledWith(saved().activeId, FOLDER);
    expect(status()).toBe(`Wrote 3 files to ${FOLDER}.`);
    expect(files()).toEqual([]);
    expect(apply().disabled).toBe(true);
    expect(button().textContent).toBe('Changes');
  });

  it('forgets the count once the changes are written, even when they cannot be looked at again', async () => {
    threads.changes.mockResolvedValue(changed);
    await type('make the change');
    finish();
    await flush();
    await vi.waitFor(() => expect(saved().threads[0].changes).toBe(3), { timeout: 3000 });

    threads.applyChanges.mockImplementation(async () => {
      threads.changes.mockResolvedValue({ files: [], unavailable: 'Its container was made without a record.' });
      return { applied: ['src/a.ts', 'src/new.ts', 'gone.txt'], conflicts: [], skipped: [] };
    });
    await open();
    apply().click();
    await flush();

    expect(button().textContent).toBe('Changes');
    await vi.waitFor(() => expect(saved().threads[0].changes).toBeUndefined(), { timeout: 3000 });
  });

  it('names the files that clash, and says nothing was written', async () => {
    threads.changes.mockResolvedValue(changed);
    threads.applyChanges.mockResolvedValue({
      applied: [],
      conflicts: [{ path: 'src/a.ts', reason: 'The same lines were changed in the workspace and by the thread.' }],
      skipped: [{ path: 'link', reason: 'Links and nested repositories are not written back.' }],
    });
    await open();
    apply().click();
    await flush();

    expect(status()).toBe(
      'Nothing was written, because these files have changed in the workspace in ways that clash with the thread:\n' +
        '• src/a.ts: The same lines were changed in the workspace and by the thread.\n' +
        'Left out:\n' +
        '• link: Links and nested repositories are not written back.'
    );
    // The changes are still there to try again
    expect(files()).toHaveLength(3);
    expect(apply().disabled).toBe(false);
  });

  it('says what went wrong when writing fails outright', async () => {
    threads.changes.mockResolvedValue(changed);
    threads.applyChanges.mockRejectedValue(new Error('Docker is not running.'));
    await open();
    apply().click();
    await flush();
    expect(status()).toBe('Nothing was written: Docker is not running.');
  });
});

describe('picking up a reply the app closed on', () => {
  // The app going down while the reply was being written. Closing the window
  // runs the save it had pending, so the thread is on disk whole...
  const quit = async () => {
    window.dispatchEvent(new Event('beforeunload'));
    await start();
    await flush();
  };
  // ...while being killed outright leaves whatever had been saved by then
  const killed = async () => {
    await start();
    await flush();
  };
  const resumed = () => sent().resumed!;
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  // Everything after the user's message, which is where the reply picks up
  const after = () => messages().slice(1);

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('fix the parser');
  });

  it('asks for the reply again, below the work the cut-off one had done', async () => {
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'src/parse.ts' } });
    emit(sentId(), { type: 'tool_result', id: 't1', name: 'read_file', output: 'export const p = 1;', isError: false });
    emit(sentId(), { type: 'text', delta: 'The parser reads' });
    await quit();

    // What it did stays where it was, with the pick-up marked after it
    expect(after()).toEqual([
      'work: Work',
      'tool: Read src/parse.ts',
      'assistant: The parser reads',
      'note: The app closed while this reply was being written; picked up from here',
      'note: Classifying complexity & routing…',
    ]);
    // ...and the reply is being asked for again, as a reply to the same message
    expect(sent().messages.at(-1)).toEqual({ role: 'user', content: 'fix the parser' });
    expect(resumed().text).toBe('The parser reads');
    expect(resumed().did).toEqual(['read_file(path: src/parse.ts) returned: export const p = 1;']);
  });

  it('picks the reply up with the classification the message had, rather than classifying it again', async () => {
    const classification = { sophistication: 4, effort: 'high', category: 'coding', model: 'llama3.2:3b' } as const;
    emit(sentId(), { type: 'classification', ...classification, provider: 'local', usage: { input: 9, output: 1 } });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    // Killed outright: the classification was saved as soon as it came
    await killed();
    expect(resumed().classification).toEqual({ ...classification, provider: 'local' });

    // The note made the first time is the one the picked-up reply goes under
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    const notes = after().filter((m) => m.startsWith('note: Coding') || m.includes('Not classified'));
    expect(notes).toEqual(['note: Coding · 4/5 Complexity · high effort']);
  });

  it('has the message classified again when it never was before the app closed', async () => {
    emit(sentId(), { type: 'classification', failed: true, reason: 'timeout' });
    await quit();
    expect(resumed().classification).toBeUndefined();
  });

  it('does not carry the classification of an earlier reply over to a retry of it', async () => {
    emit(sentId(), { type: 'classification', sophistication: 1, effort: 'low', category: 'question', model: 'm' });
    emit(sentId(), { type: 'text', delta: 'Fixed it.' });
    finish();
    // Retried, and the app closes before the retry has been classified
    const el = $$('#messages .message')[messages().indexOf('user: fix the parser')];
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    $<HTMLButtonElement>('#menu-retry').click();
    await quit();
    expect(llm.send).toHaveBeenCalledTimes(3);
    expect(resumed().classification).toBeUndefined();
  });

  it('gives the model every bubble the cut-off reply had written, in order', async () => {
    emit(sentId(), { type: 'text', delta: 'Looking now.' });
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'list_files', input: {} });
    emit(sentId(), { type: 'tool_result', id: 't1', name: 'list_files', output: 'src/parse.ts', isError: false });
    emit(sentId(), { type: 'text', delta: 'It is one file.' });
    await quit();
    expect(resumed().text).toBe('Looking now.\n\nIt is one file.');
  });

  it('says of the call it closed on that there is no telling whether it ran', async () => {
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'run_command', input: { command: 'npm test' } });
    await quit();
    expect(resumed().did).toEqual([
      'run_command(command: npm test) — not known whether it ran: the app closed before it came back.',
    ]);
  });

  it('says which calls failed, and which left a file changed', async () => {
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'run_command', input: { command: 'npm test' } });
    emit(sentId(), { type: 'tool_result', id: 't1', name: 'run_command', output: 'no such script', isError: true });
    emit(sentId(), { type: 'tool_call', id: 't2', name: 'write_file', input: { path: 'src/parse.ts' } });
    emit(sentId(), {
      type: 'tool_result',
      id: 't2',
      name: 'write_file',
      output: 'Wrote src/parse.ts\n\n@@ -1 +1 @@\n-const p = 1;\n+const p = 2;',
      isError: false,
    });
    await quit();
    expect(resumed().did).toEqual([
      'run_command({ "command": "npm test" }) failed: no such script',
      'write_file(path: src/parse.ts) returned: Wrote src/parse.ts That file is changed in your container.',
    ]);
  });

  it('reports what its subagents brought back, and which of them never finished', async () => {
    emit(sentId(), { type: 'subagent', id: 's1', name: 'tests', task: 'read the tests', kind: 'explorer' });
    emit(sentId(), { type: 'subagent', id: 's2', name: 'build', task: 'read the build', kind: 'worker' });
    emit(sentId(), { type: 'subagent_done', id: 's1', text: 'They use vitest.', isError: false });
    await quit();
    expect(resumed().did).toEqual([
      'subagent tests (explorer), given "read the tests" reported: They use vitest.',
      'subagent build (worker), given "read the build" was still working when the app closed. ' +
        'It has been started again and its report will appear in the thread when it is done; do not hand it out again.',
    ]);
  });

  it('leaves the reply alone when the app closes on it a second time, rather than trying for ever', async () => {
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    await quit();
    expect(llm.send).toHaveBeenCalledTimes(2);

    // Down again while it was being picked up: something here may be why
    await quit();
    expect(llm.send).toHaveBeenCalledTimes(2);
    expect(after().at(-1)).toContain('left as it is');

    // ...and it is not picked at again on every launch from then on
    await quit();
    expect(llm.send).toHaveBeenCalledTimes(2);
    expect(after().filter((m) => m.includes('left as it is'))).toHaveLength(1);
  });

  it('shows a red dot in the sidebar on a thread the app left alone, until it is picked up again', async () => {
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    await quit();
    await quit();
    expect($$('#thread-list li.thread .status.failed')).toHaveLength(1);

    $<HTMLButtonElement>('#messages .message.error .continue').click();
    await flush();
    expect($$('#thread-list li.thread .status.failed')).toHaveLength(0);
  });

  it('picks the reply up from the Continue button on the error it was left with', async () => {
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'src/parse.ts' } });
    emit(sentId(), { type: 'tool_result', id: 't1', name: 'read_file', output: 'export const p = 1;', isError: false });
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    await quit();
    await quit();
    llm.send.mockClear();

    $<HTMLButtonElement>('#messages .message.error .continue').click();
    await flush();

    // The error is gone, and the reply is asked for again below what it had done
    expect(after().filter((m) => m.startsWith('error:'))).toEqual([]);
    expect(after().filter((m) => m.includes('picked up from here'))).toHaveLength(2);
    expect(llm.send).toHaveBeenCalledTimes(1);
    expect(sent().messages.at(-1)).toEqual({ role: 'user', content: 'fix the parser' });
    expect(resumed().text).toBe('Half an ans');
    expect(resumed().did).toEqual(['read_file(path: src/parse.ts) returned: export const p = 1;']);
  });

  it('has no Continue button on an error that is not a reply left alone', async () => {
    emit(sentId(), { type: 'error', message: 'rate limited' });
    await flush();
    expect($$('#messages .message.error')).toHaveLength(1);
    expect($$('#messages .continue')).toHaveLength(0);
  });

  it('is done with a reply that finished, however it finished', async () => {
    emit(sentId(), { type: 'text', delta: 'Fixed it.' });
    finish();
    await quit();
    expect(llm.send).toHaveBeenCalledTimes(1);
    expect(after()).toEqual(['assistant: Fixed it.']);
  });

  it('picks a reply up again after one that was picked up finished', async () => {
    emit(sentId(), { type: 'text', delta: 'Half an ans' });
    await quit();
    emit(sentId(), { type: 'text', delta: 'The rest of it.' });
    finish();
    // A later reply in the same thread, cut off in its turn
    await type('and the lexer');
    emit(sentId(), { type: 'text', delta: 'Half again' });
    await quit();
    expect(resumed().text).toBe('Half again');
  });

  it('picks up from what had been saved when the app was killed outright', async () => {
    emit(sentId(), { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'src/parse.ts' } });
    emit(sentId(), { type: 'tool_result', id: 't1', name: 'read_file', output: 'export const p = 1;', isError: false });
    emit(sentId(), { type: 'text', delta: 'The parser reads' });
    await killed();

    // Each call is written to disk as it happens, so the account is whole...
    expect(resumed().did).toEqual(['read_file(path: src/parse.ts) returned: export const p = 1;']);
    // ...while the prose, which is saved on a timer, is as far as it had got
    expect(resumed().text).toBeUndefined();
  });

  it('asks nothing of a thread the app closed on between replies', async () => {
    finish();
    llm.send.mockClear();
    await quit();
    expect(llm.send).not.toHaveBeenCalled();
    expect(messages().join('\n')).not.toContain('picked up');
  });
});

describe("reviewing a thread's changes", () => {
  const FOLDER = '/projects/demo';
  const changed = {
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        binary: false,
        diff: '@@ -1,3 +1,3 @@\n line 1\n-const x = 1;\n+const x = 2;\n line 3',
      },
      { path: 'src/new.ts', status: 'added', binary: false, diff: '@@ -0,0 +1 @@\n+export const y = 1;' },
    ],
  };
  const sendButton = () => $<HTMLButtonElement>('#changes-send');
  const rows = (file = 0) => [...$$('#changes-files details')[file].querySelectorAll<HTMLElement>('.row')];
  const row = (text: string, file = 0) => rows(file).find((r) => r.querySelector('code')!.textContent === text)!;
  const comments = () =>
    $$('#changes-files .comment').map((c) =>
      [...c.querySelectorAll('.entry')].map(
        (e) => `${e.querySelector('strong')!.textContent}: ${e.querySelector('span')!.textContent}`
      )
    );
  const open = async () => {
    $<HTMLButtonElement>('#thread-changes').click();
    await flush();
  };
  // Clicks a line of the diff and leaves a comment on it
  const comment = (line: string, text: string, file = 0) => {
    row(line, file).click();
    $<HTMLTextAreaElement>('#changes-files .comment-form textarea').value = text;
    $<HTMLFormElement>('#changes-files .comment-form').requestSubmit();
  };
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

  beforeEach(async () => {
    threads.changes.mockResolvedValue(changed);
    await newThread(FOLDER);
    await open();
  });

  it('lets the user comment on a line of a change, and shows the comment under that line', () => {
    expect(sendButton().disabled).toBe(true);
    comment('+const x = 2;', 'Why 2?');

    expect(comments()).toEqual([['You: Why 2?']]);
    expect(row('+const x = 2;').nextElementSibling!.classList.contains('comment')).toBe(true);
    expect($('#changes-files .comment small').textContent).toBe('not sent yet');
    expect($$('#changes-files details summary')[0].textContent).toContain('1 comment');
    expect(sendButton().textContent).toBe('Send 1 comment');
    expect(sendButton().disabled).toBe(false);
    expect(saved().threads[0].review).toMatchObject([{ id: 'c1', path: 'src/a.ts', row: '+const x = 2;', line: 2 }]);
  });

  it('adds nothing for an empty comment or a cancelled one, and lets an unsent comment be taken back', () => {
    comment('+const x = 2;', '   ');
    expect(comments()).toEqual([]);
    $<HTMLButtonElement>('#changes-files .comment-form button[type="button"]').click();
    expect($$('#changes-files .comment-form')).toEqual([]);

    comment('+const x = 2;', 'Remove me');
    $<HTMLButtonElement>('#changes-files .comment .remove').click();
    expect(comments()).toEqual([]);
    expect(saved().threads[0].review).toEqual([]);
    expect(sendButton().disabled).toBe(true);
  });

  it('sends the comments to the thread as a message, each with its id, its line and what was said', async () => {
    comment('+const x = 2;', 'Why 2?');
    comment('+export const y = 1;', 'Rename this to count.', 1);
    sendButton().click();
    await flush();

    expect($<HTMLDialogElement>('#changes-dialog').open).toBe(false);
    const text =
      'Review comments on your changes:\n\n' +
      '[c1] src/a.ts, line 2\n' +
      '> +const x = 2;\n' +
      'Me: Why 2?\n\n' +
      '[c2] src/new.ts, line 1\n' +
      '> +export const y = 1;\n' +
      'Me: Rename this to count.';
    // The model is sent the comments in full...
    expect(sent()).toMatchObject({ workspace: FOLDER, review: true });
    expect(sent().messages.at(-1)).toEqual({ role: 'user', content: text });
    // ...while the thread shows what the user did, a line per comment
    expect($$('#messages .user .open').map((el) => el.textContent)).toEqual([
      'Left a comment on src/a.ts, line 2',
      'Left a comment on src/new.ts, line 1',
    ]);
    expect(messages().at(-2)).not.toContain('Review comments on your changes');
  });

  it('still shows the prose of a review message saved before the comments were kept with it', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    // A message from a version that kept only the text
    const state = saved() as Record<string, unknown> & { threads: Record<string, unknown>[] };
    const thread = state.threads.find((t) => Array.isArray(t.messages)) as { messages: Record<string, unknown>[] };
    for (const m of thread.messages) if (m.review) delete m.carries;
    onDisk = JSON.stringify(state);
    await start();
    expect(messages().join('\n')).toContain('Review comments on your changes:');
    expect($$('#messages .user .open')).toHaveLength(0);
  });

  it('notes no complexity or model for the comments: that work is the reviewers’, each rated on its own', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();

    emit(sentId(), { type: 'classification', sophistication: 4, effort: 'high', category: 'coding', model: 'm' });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'matched',
    });
    emit(sentId(), { type: 'text', delta: 'Fixed both.' });
    finish();

    const shown = messages().join('\n');
    expect(shown).not.toMatch(/Complexity|effort|Classifying/);
    expect(shown).toContain('Fixed both.');
    expect($$('#messages .note details')).toHaveLength(0);
  });

  it('notes nothing either when the classifier failed on a review, where there is no rating to miss', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();

    emit(sentId(), { type: 'classification', failed: true, reason: 'timeout' });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'opus',
      name: 'Opus',
      sophistication: 4,
      reason: 'unclassified',
    });
    emit(sentId(), { type: 'text', delta: 'Fixed it.' });
    expect(messages().join('\n')).not.toContain('Not classified');
  });

  it('has each comment open the reviewer dealing with it, once one has taken it up', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    const line = () => $<HTMLButtonElement>('#messages .user .open');
    // Nobody has taken it up yet, so there is nothing to open
    expect(line().disabled).toBe(true);
    expect(line().title).toBe('Nobody has taken this up yet');

    emit(sentId(), { type: 'subagent', id: 's1', name: 'c1', task: 'deal with [c1]', kind: 'reviewer' });
    emit(sentId(), { type: 'subagent_update', id: 's1', event: { type: 'thought', text: 'It is the stride.' } });
    expect(line().disabled).toBe(false);
    expect(line().title).toBe('Open the reviewer dealing with it');

    line().click();
    await flush();
    expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'c1']);
    expect($('#agent-view').textContent).toContain('It is the stride.');
    expect($('#agent-view .message.user').textContent).toBe("Reviewer's Goaldeal with [c1]");
  });

  it('opens the review from the message, where each comment shows how far its reviewer has got', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    const dialog = () => $<HTMLDialogElement>('#changes-dialog');
    expect(dialog().open).toBe(false);
    $<HTMLButtonElement>('#messages .user .open-review').click();
    await flush();
    expect(dialog().open).toBe(true);
    // Nobody has taken it up yet, so there is nothing to show
    expect($$('#changes-files .comment .progress')).toHaveLength(0);

    emit(sentId(), { type: 'subagent', id: 's1', name: 'c1', task: 'deal with [c1]', kind: 'reviewer' });
    expect($('#changes-files .comment .progress').textContent).toContain('Reviewer working…');
    emit(sentId(), { type: 'subagent_update', id: 's1', event: { type: 'progress', percent: 40 } });
    expect($('#changes-files .comment .progress').textContent).toContain('Reviewer working… 40%');
    emit(sentId(), { type: 'subagent_done', id: 's1', text: 'Done.', isError: false });
    expect($('#changes-files .comment .progress').textContent).toContain('Reviewer finished');

    $<HTMLButtonElement>('#changes-files .comment .progress button').click();
    await flush();
    expect(dialog().open).toBe(false);
    expect($$('#tabs .tab .name').map((el) => el.textContent)).toEqual(['Thread', 'c1']);
  });

  it("puts the assistant's reply under the comment it answers, not in the thread as a tool", async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    emit(sentId(), {
      type: 'tool_call',
      id: 't1',
      name: 'reply_to_comment',
      input: { comment_id: 'c1', reply: 'Because the spec changed.' },
    });
    emit(sentId(), {
      type: 'tool_result',
      id: 't1',
      name: 'reply_to_comment',
      output: 'Reply posted.',
      isError: false,
    });
    emit(sentId(), { type: 'text', delta: 'Answered your question.' });
    finish();
    await flush();

    expect(messages().join('\n')).not.toContain('reply_to_comment');
    await open();
    expect(comments()).toEqual([['You: Why 2?', 'Assistant: Because the spec changed.']]);
    // Sent comments can no longer be taken back, and there is nothing new to send
    expect($$('#changes-files .comment .remove')).toEqual([]);
    expect(sendButton().disabled).toBe(true);
  });

  it('lets the user reply under a comment, and sends the whole exchange along with the reply', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    emit(sentId(), {
      type: 'tool_call',
      id: 't1',
      name: 'reply_to_comment',
      input: { comment_id: 'c1', reply: 'Because the spec changed.' },
    });
    finish();
    await flush();
    await open();

    $<HTMLButtonElement>('#changes-files .comment .reply').click();
    $<HTMLTextAreaElement>('#changes-files .comment-form textarea').value = 'Then add a comment saying so.';
    $<HTMLFormElement>('#changes-files .comment-form').requestSubmit();
    expect(comments()).toEqual([
      ['You: Why 2?', 'Assistant: Because the spec changed.', 'You: Then add a comment saying so.'],
    ]);

    sendButton().click();
    await flush();
    expect(sent().messages.at(-1)!.content).toBe(
      'Review comments on your changes:\n\n' +
        '[c1] src/a.ts, line 2\n' +
        '> +const x = 2;\n' +
        'Me: Why 2?\n' +
        'You: Because the spec changed.\n' +
        'Me: Then add a comment saying so.'
    );
  });

  it('keeps a comment whose line has since changed, below the diff, and the comments survive a restart', async () => {
    comment('+const x = 2;', 'Why 2?');
    threads.changes.mockResolvedValue({
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          binary: false,
          diff: '@@ -1,3 +1,3 @@\n line 1\n-const x = 1;\n+const LIMIT = 2;\n line 3',
        },
      ],
    });
    $('#changes-close').click();
    await start();
    await open();

    expect(comments()).toEqual([['You: Why 2?']]);
    expect($('#changes-files .outdated').textContent).toBe('On lines that have since changed:');
    expect($('#changes-files .was').textContent).toBe('+const x = 2;');
  });

  it('ignores a reply to a comment that does not exist, and a retry sends the comments as a review again', async () => {
    comment('+const x = 2;', 'Why 2?');
    sendButton().click();
    await flush();
    emit(sentId(), {
      type: 'tool_call',
      id: 't1',
      name: 'reply_to_comment',
      input: { comment_id: 'c9', reply: 'Lost.' },
    });
    emit(sentId(), { type: 'error', code: 'other', message: 'It broke.' });
    await flush();
    expect(saved().threads[0].review[0].entries).toHaveLength(1);
    expect(saved().threads[0].messages.find((m: { role: string }) => m.role === 'user')).toMatchObject({
      review: true,
    });
  });

  it('clears the comments once the changes are written to the workspace', async () => {
    comment('+const x = 2;', 'Why 2?');
    threads.applyChanges.mockResolvedValue({ applied: ['src/a.ts'], conflicts: [], skipped: [] });
    threads.changes.mockResolvedValue({ files: [] });
    $<HTMLButtonElement>('#changes-apply').click();
    await flush();
    expect(saved().threads[0].review).toEqual([]);
  });
});

describe('how tool use is shown', () => {
  const tools = () => $$('#messages .tool summary').map((s) => s.textContent);
  const sections = (n = 0) =>
    [...$$('#messages .tool details')[n].querySelectorAll('.label')].map((label) => [
      label.textContent,
      label.nextElementSibling!.textContent,
    ]);
  const called = (id: string, name: string, input: Record<string, unknown> = {}) =>
    emit(sentId(), { type: 'tool_call', id, name, input });
  const returned = (id: string, name: string, output = 'ok', isError = false) =>
    emit(sentId(), { type: 'tool_result', id, name, output, isError });
  const finish = () =>
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });

  beforeEach(async () => {
    await type('hi');
  });

  it.each([
    ['run_command', 'Running a command…', 'Ran a command'],
    ['read_file', 'Reading a file…', 'Read a file'],
    ['write_file', 'Writing a file…', 'Wrote a file'],
    ['list_files', 'Listing files…', 'Listed files'],
    ['search_workspace', 'Searching workspace…', 'Searched workspace'],
    ['save_context', 'Saving its notes…', 'Saved its notes'],
    ['update_workspace_context', 'Updating workspace context…', 'Updated workspace context'],
  ])('calls %s by what it does, not by its name', (name, doing, did) => {
    called('c1', name);
    expect(tools()).toEqual([doing]);
    returned('c1', name);
    expect(tools()).toEqual([did]);
  });

  it('says what the tool is working on: the search, the file or the command', () => {
    called('c1', 'search_workspace', { query: 'where are API keys stored', max_results: 5 });
    expect(tools()).toEqual(['Searching "where are API keys stored"…']);
    returned('c1', 'search_workspace');
    called('c2', 'read_file', { path: 'src/settings.ts' });
    returned('c2', 'read_file');
    called('c3', 'run_command', { command: 'npm test\n  -- --run' });
    returned('c3', 'run_command');
    called('c4', 'write_file', { path: 'notes.md', content: 'x' });
    called('c5', 'list_files', { path: 'src' });
    expect(tools()).toEqual([
      'Searched "where are API keys stored"',
      'Read src/settings.ts',
      'Ran npm test -- --run',
      'Writing notes.md…',
      'Listing src…',
    ]);
  });

  it('cuts a long input short in the label, and still names a failed call by its input', () => {
    called('c1', 'run_command', { command: 'x'.repeat(200) });
    expect(tools()).toEqual([`Running ${'x'.repeat(60)}……`]);
    returned('c1', 'run_command', 'no', true);
    expect(tools()).toEqual([`Ran ${'x'.repeat(60)}… (failed)`]);
  });

  it('moves on to the next call still out as results come back, then names the first with how many more', () => {
    called('c1', 'read_file', { path: 'a.ts' });
    called('c2', 'read_file', { path: 'b.ts' });
    called('c3', 'read_file', { path: 'c.ts' });
    returned('c1', 'read_file');
    expect(tools()).toEqual(['Reading b.ts… (2 of 3)']);
    returned('c3', 'read_file');
    expect(tools()).toEqual(['Reading b.ts… (2 of 3)']);
    returned('c2', 'read_file');
    expect(tools()).toEqual(['Read a.ts +2 more']);
  });

  describe('a file the agent wrote', () => {
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n line 1\n-const x = 1;\n+const x = 2;\n line 3';
    const write = (id: string, path: string, output: string) => {
      called(id, 'write_file', { path, content: 'line 1\nconst x = 2;\nline 3\n' });
      returned(id, 'write_file', output);
    };
    const rows = () => [...$$('#messages .tool pre.diff span')].map((row) => [row.className, row.textContent]);

    it('shows what the write changed as a diff, with added and removed lines marked', () => {
      write('c1', 'src/a.ts', `Wrote src/a.ts\n\n${diff}`);
      expect(tools()).toEqual(['Wrote src/a.ts']);
      expect(sections()).toEqual([
        ['Input', 'path: src/a.ts'],
        ['Output', 'Wrote src/a.ts'],
        ['Changes', `${diff}\n`],
      ]);
      expect(rows()).toEqual([
        ['', '--- a/src/a.ts\n'],
        ['', '+++ b/src/a.ts\n'],
        ['', '@@ -1,3 +1,3 @@\n'],
        ['', ' line 1\n'],
        ['del', '-const x = 1;\n'],
        ['add', '+const x = 2;\n'],
        ['', ' line 3\n'],
      ]);
    });

    it('keeps the diff whole, blank lines and all, where other output is kept only in brief', () => {
      const body = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? '+' : `+line ${i}`)).join('\n');
      const long = `--- a/b.md\n+++ b/b.md\n@@ -0,0 +1,30 @@\n${body}`;
      write('c1', 'b.md', `Wrote b.md\n\n${long}`);
      expect($('#messages .tool pre.diff').textContent).toBe(`${long}\n`);
    });

    it('has no diff to show when the file is as it was, or when the write failed', () => {
      write('c1', 'same.ts', 'Wrote same.ts (no changes)');
      expect($$('#messages .tool pre.diff')).toEqual([]);
      expect(sections().at(-1)).toEqual(['Output', 'Wrote same.ts (no changes)']);

      emit(sentId(), { type: 'text', delta: 'Next.' });
      called('c2', 'write_file', { path: '/proc/x', content: 'y' });
      returned('c2', 'write_file', 'Read-only file system', true);
      expect($$('#messages .tool pre.diff')).toEqual([]);
    });

    it("shows each file's diff when several are written in turn, and keeps them after a restart", async () => {
      write('c1', 'src/a.ts', `Wrote src/a.ts\n\n${diff}`);
      write('c2', 'src/b.ts', 'Wrote src/b.ts\n\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+new');
      expect(tools()).toEqual(['Wrote src/a.ts +1 more']);
      expect(sections().map(([label]) => label)).toEqual([
        '1. Input',
        'Output',
        'Changes',
        '2. Input',
        'Output',
        'Changes',
      ]);

      finish();
      await start();
      expect($$('#messages .tool pre.diff')).toHaveLength(2);
    });

    it('shows an edit the same way: the file by name, and what the edit changed', () => {
      called('c1', 'edit_file', { path: 'src/a.ts', old_text: 'const x = 1;', new_text: 'const x = 2;' });
      expect(tools()).toEqual(['Editing src/a.ts…']);
      returned('c1', 'edit_file', `Edited src/a.ts\n\n${diff}`);
      expect(tools()).toEqual(['Edited src/a.ts']);
      expect(sections()).toEqual([
        ['Input', 'path: src/a.ts'],
        ['Output', 'Edited src/a.ts'],
        ['Changes', `${diff}\n`],
      ]);
      expect(rows().filter(([kind]) => kind)).toEqual([
        ['del', '-const x = 1;\n'],
        ['add', '+const x = 2;\n'],
      ]);
    });

    it('shows what an edit was given when it failed, since there is no diff to show for it', () => {
      called('c1', 'edit_file', { path: 'src/a.ts', old_text: 'nope', new_text: 'x' });
      returned('c1', 'edit_file', '"old_text" was not found in src/a.ts.', true);
      expect(tools()).toEqual(['Edited src/a.ts (failed)']);
      expect(sections()[0]).toEqual(['Error', '"old_text" was not found in src/a.ts.']);
      expect(sections()[1][1]).toContain('"old_text": "nope"');
    });

    it('leaves the output of other tools as it was, even when it looks like a diff', () => {
      called('c1', 'run_command', { command: 'git diff' });
      returned('c1', 'run_command', `exit code 0\n\n${diff}`);
      expect($$('#messages .tool pre.diff')).toEqual([]);
    });
  });

  it('falls back on the name of a tool it has no words for', () => {
    called('c1', 'get_weather');
    expect(tools()).toEqual(['Running get_weather…']);
    returned('c1', 'get_weather');
    expect(tools()).toEqual(['Used get_weather']);
  });

  it('rolls calls to the same tool, one after another, into one entry that lists each of them', () => {
    called('c1', 'read_file', { path: 'a.ts' });
    called('c2', 'read_file', { path: 'b.ts' });
    called('c3', 'read_file', { path: 'c.ts' });
    expect(tools()).toEqual(['Reading a.ts… (1 of 3)']);
    expect($$('#messages .message.tool')).toHaveLength(1);

    returned('c1', 'read_file', 'contents of a');
    returned('c2', 'read_file', 'contents of b');
    returned('c3', 'read_file', 'contents of c');
    expect(tools()).toEqual(['Read a.ts +2 more']);
    expect(sections()).toEqual([
      ['1. Input', 'path: a.ts'],
      ['Output', 'contents of a'],
      ['2. Input', 'path: b.ts'],
      ['Output', 'contents of b'],
      ['3. Input', 'path: c.ts'],
      ['Output', 'contents of c'],
    ]);
  });

  it('keeps saying the tool is at work until every call in the entry is back, and counts the ones that failed', () => {
    called('c1', 'run_command', { command: 'ls' });
    called('c2', 'run_command', { command: 'cat missing' });
    returned('c1', 'run_command', 'a.ts');
    expect(tools()).toEqual(['Running cat missing… (2 of 2)']);

    returned('c2', 'run_command', 'No such file', true);
    expect(tools()).toEqual(['Ran ls +1 more (1 failed)']);
    expect($('#messages .tool details').className).toBe('failed');
    expect(sections()).toEqual([
      ['1. Input', 'command: ls'],
      ['Output', 'a.ts'],
      ['2. Error', 'No such file'],
      ['Input', '{\n  "command": "cat missing"\n}'],
    ]);
  });

  it('starts a new entry when a different tool, a thought or some of the reply comes in between', () => {
    called('c1', 'read_file');
    called('c2', 'search_workspace');
    called('c3', 'read_file');
    emit(sentId(), { type: 'thought', text: 'Now the other one.' });
    called('c4', 'read_file');
    emit(sentId(), { type: 'text', delta: 'Found it.' });
    called('c5', 'read_file');
    called('c6', 'read_file');
    expect(tools()).toEqual([
      'Reading a file…',
      'Searching workspace…',
      'Reading a file…',
      'Reading a file…',
      'Reading a file… (1 of 2)',
    ]);
  });

  it('leaves a single call as it was: no count, and its parts unnumbered', () => {
    called('c1', 'read_file', { path: 'a.ts' });
    returned('c1', 'read_file', 'contents');
    expect(tools()).toEqual(['Read a.ts']);
    expect(sections()).toEqual([
      ['Input', 'path: a.ts'],
      ['Output', 'contents'],
    ]);
  });

  it('stays open as more calls join the entry, and is rolled up the same way after a restart', async () => {
    called('c1', 'read_file', { path: 'a.ts' });
    const entry = () => $<HTMLDetailsElement>('#messages .tool details');
    entry().open = true;
    entry().dispatchEvent(new Event('toggle'));
    called('c2', 'read_file', { path: 'b.ts' });
    expect(entry().open).toBe(true);

    returned('c1', 'read_file');
    returned('c2', 'read_file');
    finish();
    await start();
    expect(tools()).toEqual(['Read a.ts +1 more']);
  });

  it('rolls up tool notes saved before tools had names of their own', async () => {
    finish();
    const state = saved();
    state.threads[0].messages.push(
      { role: 'tool', text: 'Used read_file', callId: 'o1', inputSummary: 'path: a', output: 'x' },
      { role: 'tool', text: 'Used read_file (failed)', callId: 'o2', input: '{}', failure: 'no' }
    );
    onDisk = JSON.stringify(state);
    await start();
    expect(tools()).toEqual(['Read a +1 more (1 failed)']);
  });

  it('deletes the whole entry, every call in it, from the menu', async () => {
    called('c1', 'read_file');
    called('c2', 'read_file');
    returned('c1', 'read_file');
    returned('c2', 'read_file');
    emit(sentId(), { type: 'text', delta: 'Done.' });
    finish();
    $('#messages .message.tool').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    $<HTMLButtonElement>('#menu-delete').click();
    expect(tools()).toEqual([]);
    expect(saved().threads[0].messages.filter((m: { role: string }) => m.role === 'tool')).toEqual([]);
  });
});

describe("asking before the model reads a file on the user's computer", () => {
  const card = () => document.querySelector<HTMLElement>('#messages .message.file-access');
  const buttons = () => [...(card()?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
  const press = (label: string) =>
    [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)?.click();
  const dot = () => document.querySelector<HTMLElement>('#thread-list li.thread .status');
  const asked = (id: string, path: string, isFolder = false, canRemember = true) =>
    ({
      type: 'file_access',
      id,
      path,
      folder: isFolder ? path : path.slice(0, path.lastIndexOf('/')),
      isFolder,
      canRemember,
    }) as const;

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('names the file and offers to allow it once, or for good, as the file or its folder', async () => {
    emit(sentId(), asked('a1', '/home/me/.npmrc'));
    await flush();
    expect(card()?.querySelector('p')?.textContent).toBe('The model wants to read /home/me/.npmrc on your computer.');
    expect(buttons()).toEqual([
      'Deny',
      'Allow once',
      'Allow for this thread',
      'Always allow this file in this workspace',
      'Always allow /home/me in this workspace',
    ]);
    expect($('#messages').textContent).toContain('Waiting for your approval');
  });

  it('offers only the folder where it is a folder that is asked for', async () => {
    emit(sentId(), asked('a1', '/home/me/notes', true));
    await flush();
    expect(card()?.querySelector('p')?.textContent).toContain('the folder /home/me/notes');
    expect(buttons()).toEqual([
      'Deny',
      'Allow once',
      'Allow for this thread',
      'Always allow this folder in this workspace',
    ]);
  });

  it.each([
    ['Deny', 'deny'],
    ['Allow once', 'once'],
    ['Allow for this thread', 'thread'],
    ['Always allow this file in this workspace', 'file'],
    ['Always allow /home/me in this workspace', 'folder'],
  ])('sends %s as %s, and the question goes', async (label, answer) => {
    emit(sentId(), asked('a1', '/home/me/.npmrc'));
    await flush();
    press(label);
    expect(llm.allowFileAccess).toHaveBeenCalledWith('a1', answer);
    expect(card()).toBeNull();
    expect($('#messages').textContent).not.toContain('Waiting for your approval');
  });

  it('puts questions that arrive together one after another, in order', async () => {
    emit(sentId(), asked('a1', '/home/me/one'));
    emit(sentId(), asked('a2', '/home/me/two'));
    await flush();
    expect(card()?.querySelector('p')?.textContent).toContain('/home/me/one');
    press('Allow once');
    expect(card()?.querySelector('p')?.textContent).toContain('/home/me/two');
    expect($('#messages').textContent).toContain('Waiting for your approval');
    press('Deny');
    expect(llm.allowFileAccess.mock.calls).toEqual([
      ['a1', 'once'],
      ['a2', 'deny'],
    ]);
    expect(card()).toBeNull();
  });

  it('flags the thread in the sidebar while it waits', async () => {
    emit(sentId(), asked('a1', '/home/me/.npmrc'));
    await flush();
    expect(dot()?.className).toBe('status approval');
    press('Allow once');
    expect(dot()?.className).toBe('status working');
  });

  it('drops the questions, unanswered, when the reply is stopped', async () => {
    emit(sentId(), asked('a1', '/home/me/one'));
    emit(sentId(), asked('a2', '/home/me/two'));
    await flush();
    $<HTMLButtonElement>('#send').click();
    expect(llm.cancel).toHaveBeenCalledWith(sentId());
    expect(llm.allowFileAccess).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });
});

describe("asking before the model runs a command on the user's computer that could lose work", () => {
  const card = () => document.querySelector<HTMLElement>('#messages .message.command-access');
  const buttons = () => [...(card()?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
  const press = (label: string) =>
    [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)?.click();
  const asked = (id: string, command: string, why = '"--force" overrides a check git makes') =>
    ({ type: 'command_access', id, command, path: '/projects/demo', why }) as const;

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('shows the command, where it would run and what is risky about it, and offers the one answer', async () => {
    emit(sentId(), asked('c1', 'git push --force origin main'));
    await flush();
    expect(card()?.querySelector('p')?.textContent).toBe(
      'The model wants to run a command in /projects/demo on your computer: ' + '"--force" overrides a check git makes.'
    );
    expect(card()?.querySelector('.command code')?.textContent).toBe('git push --force origin main');
    expect(buttons()).toEqual(["Don't run it", 'Run it once']);
    expect($('#messages').textContent).toContain('Waiting for your approval');
  });

  it.each([
    ["Don't run it", false],
    ['Run it once', true],
  ])('sends %s as %s, and the question goes', async (label, allowed) => {
    emit(sentId(), asked('c1', 'git reset --hard'));
    await flush();
    press(label);
    expect(llm.allowCommand).toHaveBeenCalledWith('c1', allowed);
    expect(card()).toBeNull();
    expect($('#messages').textContent).not.toContain('Waiting for your approval');
  });

  // The command is the question a reply is most likely stuck on, so it is put first of the two
  it('is asked before a file waiting to be read, and both are asked in turn', async () => {
    emit(sentId(), {
      type: 'file_access',
      id: 'a1',
      path: '/home/me/.npmrc',
      folder: '/home/me',
      isFolder: false,
      canRemember: true,
    });
    emit(sentId(), asked('c1', 'git clean -fd'));
    await flush();
    expect(card()?.querySelector('.command code')?.textContent).toBe('git clean -fd');
    press('Run it once');
    expect(card()).toBeNull();
    expect(document.querySelector('#messages .message.file-access')).not.toBeNull();
    expect($('#messages').textContent).toContain('Waiting for your approval');
  });

  it('drops the question, unanswered, when the reply is stopped', async () => {
    emit(sentId(), asked('c1', 'git push --force'));
    await flush();
    $<HTMLButtonElement>('#send').click();
    expect(llm.cancel).toHaveBeenCalledWith(sentId());
    expect(llm.allowCommand).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });
});

describe('asking before a model above the approval level is used', () => {
  const card = () => document.querySelector<HTMLElement>('#messages .message.approval');
  const dot = () => document.querySelector<HTMLElement>('#thread-list li.thread .status');
  const approval = (name: string, fallbackName: string) =>
    ({
      type: 'approval',
      provider: 'anthropic',
      model: 'm',
      name,
      sophistication: 5,
      ceiling: 3,
      fallbackName,
      timeoutMs: 60_000,
    }) as const;
  const deadline = () => card()?.querySelector('.deadline')?.textContent;

  beforeEach(async () => {
    await newThread('/projects/demo');
    await type('hi');
  });

  it('puts the question in the thread, and sends the answer the user gives', async () => {
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    expect(card()?.querySelector('p')?.textContent).toBe(
      'Opus (5/5) is above your approval level of 3. Approve it, or use Haiku?'
    );
    expect(card()?.querySelector('.decline')?.textContent).toBe('Use Haiku');
    expect($('#messages').textContent).toContain('Waiting for your approval');
    card()?.querySelector<HTMLButtonElement>('.approve')?.click();
    expect(llm.approve).toHaveBeenCalledWith(sentId(), true);
    expect(card()).toBeNull();
    expect($('#messages').textContent).not.toContain('Waiting for your approval');
  });

  // The question is only asked for so long: the harness goes on with the
  // fallback if nobody answers (see APPROVAL_TIMEOUT_MS), and the card says how
  // long is left of that time
  it('counts down the time the question has left', async () => {
    // Only the clock is stood still, so that the second it reads can be moved
    // on by hand; the tick that redraws the card is the app's own (see usage.ts)
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      emit(sentId(), approval('Opus', 'Haiku'));
      await flush();
      expect(deadline()).toBe('Using Haiku in 60s');
      vi.setSystemTime(Date.now() + 5000);
      await vi.waitFor(() => expect(deadline()).toBe('Using Haiku in 55s'), { timeout: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });

  // The window is not the one keeping the time, so the card goes when the reply
  // says which model it went with rather than on a clock of its own
  it('takes the question away, unanswered, when the time ran out', async () => {
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'haiku',
      name: 'Haiku',
      sophistication: 2,
      reason: 'not_approved',
    });
    await flush();
    expect(card()).toBeNull();
    expect(llm.approve).not.toHaveBeenCalled();
    expect($('#messages').textContent).not.toContain('Waiting for your approval');
    expect(dot()?.className).toBe('status working');
    expect(host.badge).toHaveBeenLastCalledWith(0);
  });

  it('sends a no when the user declines', async () => {
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    card()?.querySelector<HTMLButtonElement>('.decline')?.click();
    expect(llm.approve).toHaveBeenCalledWith(sentId(), false);
    expect(card()).toBeNull();
  });

  it('flags the thread in the sidebar with an orange dot while it waits', async () => {
    expect(dot()?.className).toBe('status working');
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    expect(dot()?.className).toBe('status approval');
    expect(dot()?.title).toBe('Needs your approval');
    card()?.querySelector<HTMLButtonElement>('.approve')?.click();
    expect(dot()?.className).toBe('status working');
  });

  it('flags a thread that is not showing, and puts no question in the one that is', async () => {
    const asked = sentId();
    await newThread('/projects/other');
    emit(asked, approval('Opus', 'Haiku'));
    await flush();
    expect(card()).toBeNull();
    expect(document.querySelectorAll('#thread-list li.thread .status.approval')).toHaveLength(1);
  });

  it("counts the thread on the app's icon while it waits", async () => {
    expect(host.badge).toHaveBeenLastCalledWith(0);
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    expect(host.badge).toHaveBeenLastCalledWith(1);
    card()?.querySelector<HTMLButtonElement>('.approve')?.click();
    expect(host.badge).toHaveBeenLastCalledWith(0);
  });

  it('drops the question, unanswered, when the reply is stopped', async () => {
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    $<HTMLButtonElement>('#send').click();
    expect(llm.cancel).toHaveBeenCalledWith(sentId());
    expect(llm.approve).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('says in the note that a lower model is being used when the user declines', async () => {
    emit(sentId(), approval('Opus', 'Haiku'));
    await flush();
    card()?.querySelector<HTMLButtonElement>('.decline')?.click();
    emit(sentId(), { type: 'classification', sophistication: 5, effort: 'high', category: 'coding', model: 'm' });
    emit(sentId(), {
      type: 'model',
      provider: 'anthropic',
      model: 'haiku',
      name: 'Haiku',
      sophistication: 3,
      reason: 'not_approved',
    });
    expect(messages()).toEqual([
      'user: hi',
      'note: Coding · 5/5 Complexity · high effort · using a lower model: Haiku (3/5)',
      'work: Working…',
    ]);
  });
});

describe('the model asking the user a question', () => {
  const card = () => document.querySelector<HTMLElement>('#messages .message.question');
  const dot = () => document.querySelector<HTMLElement>('#thread-list li.thread .status');
  const options = () => [...(card()?.querySelectorAll<HTMLButtonElement>('button.option') ?? [])];
  const other = () => card()?.querySelector<HTMLInputElement>('input.other') as HTMLInputElement;
  const sendButton = () => card()?.querySelector<HTMLButtonElement>('button.send') as HTMLButtonElement;
  const question = { type: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] } as const;
  const shown: { title: string; options: NotificationOptions }[] = [];

  beforeEach(async () => {
    shown.length = 0;
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        constructor(title: string, options: NotificationOptions) {
          shown.push({ title, options });
        }
        addEventListener(): void {}
      }
    );
    await newThread('/projects/demo');
    await type('hi');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the question in the thread with a button for each option', async () => {
    emit(sentId(), question);
    await flush();
    expect(card()?.querySelector('p')?.textContent).toBe('Which database?');
    expect(options().map((one) => one.textContent)).toEqual(['Postgres', 'SQLite']);
    expect(other().placeholder).toBe('Answer in your own words…');
    expect($('#messages').textContent).toContain('Waiting for your answer');
  });

  it('sends the option that is clicked, and takes the card away, keeping the exchange in the thread', async () => {
    emit(sentId(), question);
    await flush();
    options()[1].click();
    expect(llm.answer).toHaveBeenCalledWith(sentId(), 'SQLite');
    expect(card()).toBeNull();
    expect($('#messages').textContent).not.toContain('Waiting for your answer');
    expect(messages()).toContain('note: Asked: Which database?\nYou answered: SQLite');
  });

  it("sends the user's own words with Send, or with Enter", async () => {
    emit(sentId(), question);
    await flush();
    other().value = ' MySQL ';
    other().dispatchEvent(new Event('input', { bubbles: true }));
    expect(sendButton().disabled).toBe(false);
    sendButton().click();
    expect(llm.answer).toHaveBeenCalledWith(sentId(), 'MySQL');
    expect(card()).toBeNull();
  });

  it('answers on Enter', async () => {
    emit(sentId(), question);
    await flush();
    other().value = 'DuckDB';
    other().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(llm.answer).toHaveBeenCalledWith(sentId(), 'DuckDB');
  });

  it('does not send a blank answer', async () => {
    emit(sentId(), question);
    await flush();
    expect(sendButton().disabled).toBe(true);
    other().value = '   ';
    other().dispatchEvent(new Event('input', { bubbles: true }));
    expect(sendButton().disabled).toBe(true);
    other().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    sendButton().click();
    expect(llm.answer).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
  });

  it('flags the thread in the sidebar with a dot that says it needs an answer', async () => {
    emit(sentId(), question);
    await flush();
    expect(dot()?.className).toBe('status approval');
    expect(dot()?.title).toBe('Needs your answer');
    options()[0].click();
    expect(dot()?.className).toBe('status working');
  });

  it('counts the thread on the app’s icon while it waits', async () => {
    emit(sentId(), question);
    await flush();
    expect(host.badge).toHaveBeenLastCalledWith(1);
    options()[0].click();
    expect(host.badge).toHaveBeenLastCalledWith(0);
  });

  it('tells the user of a question in a thread that is not showing', async () => {
    const asked = sentId();
    await newThread('/projects/other');
    emit(asked, question);
    await flush();
    expect(card()).toBeNull();
    expect(shown.map(({ options: { body } }) => body)).toEqual(['Which database?']);
  });

  it('drops the question, unanswered, when the reply is stopped', async () => {
    emit(sentId(), question);
    await flush();
    $<HTMLButtonElement>('#send').click();
    expect(llm.cancel).toHaveBeenCalledWith(sentId());
    expect(llm.answer).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });
});

describe("having a reply's changes checked by a model", () => {
  const card = () => document.querySelector<HTMLElement>('#messages .message.review');
  const check = () => card()?.querySelector<HTMLButtonElement>('button.check');
  const model = { provider: 'anthropic', model: 'opus-id' };
  const changed = { files: [{ path: 'a.ts', status: 'modified', binary: false, diff: '@@ -1 +1 @@\n-a\n+b' }] };
  const finish = (text = 'I changed a.ts.') => {
    emit(sentId(), { type: 'model', ...model, name: 'Opus', sophistication: 5, reason: 'matched' });
    if (text) emit(sentId(), { type: 'text', delta: text });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
  };

  beforeEach(async () => {
    threads.changes.mockResolvedValue(changed);
    await newThread('/projects/demo');
    await type('change a');
  });

  it('offers the review only once the reply is over and has left changes', async () => {
    emit(sentId(), { type: 'model', ...model, name: 'Opus', sophistication: 5, reason: 'matched' });
    emit(sentId(), { type: 'text', delta: 'I changed a.ts.' });
    expect(card()).toBeNull();
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
    expect(check()?.textContent).toBe('Review changes');
  });

  it('offers nothing when the reply changed nothing', async () => {
    threads.changes.mockResolvedValue({ files: [] });
    finish();
    await flush();
    expect(card()).toBeNull();
  });

  it('sends the request and the reply with the model that wrote it, and shows a pass', async () => {
    llm.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus 5' });
    finish();
    await flush();
    check()?.click();
    expect(check()?.disabled).toBe(true);
    expect(check()?.textContent).toBe('Reviewing…');
    await flush();
    expect(llm.verify).toHaveBeenCalledWith({
      thread: saved().activeId,
      request: 'change a',
      output: 'I changed a.ts.',
      ...model,
      // ...and the workspace, which is what has the changes tried as well as read
      workspace: '/projects/demo',
    });
    expect(card()).toBeNull();
    expect(messages().at(-1)).toBe('note: Review passed · Opus 5');
    expect(llm.send).toHaveBeenCalledTimes(1);
  });

  it("adds the review's tokens to the turn's Tokens note, and keeps the pass the last note", async () => {
    const used = {
      purpose: 'verification',
      provider: 'anthropic',
      model: 'Opus 5',
      input: 3000,
      output: 200,
      cost: 0.02,
    };
    llm.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus 5', usage: used });
    emit(sentId(), { type: 'model', ...model, name: 'Opus', sophistication: 5, reason: 'matched' });
    emit(sentId(), { type: 'text', delta: 'I changed a.ts.' });
    emit(sentId(), {
      type: 'usage',
      purpose: 'reply',
      ...model,
      input: 2000,
      output: 500,
      cost: 0.018,
    });
    emit(sentId(), { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 1 });
    await flush();
    const tokens = () => saved().threads[0].messages.find((m: { usage?: unknown[] }) => m.usage);
    const before = messages().find((one) => one.startsWith('note: Tokens'));
    expect(before).toBeDefined();
    check()?.click();
    await flush();
    await vi.waitFor(() => expect(saved().threads[0].messages.at(-1).text).toContain('Review passed'), {
      timeout: 3000,
    });
    const note = tokens();
    expect(note.usage.map((one: { purpose: string }) => one.purpose)).toEqual(['reply', 'verification']);
    expect(note.passes).toHaveLength(2);
    expect(note.passes.at(-1)).toEqual({ purpose: 'verification', model: 'Opus 5', input: 3000 });
    expect(note.text).not.toBe(before?.replace('note: ', ''));
    expect(messages().find((one) => one.startsWith('note: Tokens'))).toBe(`note: ${note.text}`);
    expect(messages().at(-1)).toBe('note: Review passed · Opus 5');
  });

  it('puts the problems to the thread and sets it working on them', async () => {
    llm.verify.mockResolvedValue({ passed: false, problems: '- It left b.ts alone.', model: 'Opus 5' });
    finish();
    await flush();
    check()?.click();
    await flush();
    expect(messages().slice(-3, -1)).toEqual([
      'note: Review found problems · Opus 5',
      expect.stringContaining('user: A reviewer checked your changes'),
    ]);
    expect(llm.send).toHaveBeenCalledTimes(2);
    const request = sent();
    expect(request.messages.at(-1)?.content).toContain('- It left b.ts alone.');
    expect(request.messages.at(-1)?.role).toBe('user');
    // Not offered again until that reply is over
    expect(card()).toBeNull();
    finish();
    await flush();
    expect(check()?.textContent).toBe('Review changes');
  });

  // A review that tried the changes says so, keeps what it did under the note,
  // and passes that on with the problems, so the fix can be checked the same way
  describe('that tried the changes', () => {
    const checked = '- ran `npm test`: 12 passed\n- in the app, sent "hi": the reply never arrived';

    it('says it tried them, and keeps what the reviewer did under the note', async () => {
      llm.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus 5', tested: true, checked });
      finish();
      await flush();
      check()?.click();
      await flush();
      expect(messages().at(-1)).toBe('note: Review passed · Opus 5 · tried in the thread');
      expect(saved().threads[0].messages.at(-1).summary).toBe(checked);
      const note = [...document.querySelectorAll('#messages .message.summary')].at(-1);
      expect(note?.querySelector('summary')?.textContent).toBe('Review passed · Opus 5 · tried in the thread');
      expect(note?.textContent).toContain('the reply never arrived');
    });

    it('puts how the problems were found to the thread along with them', async () => {
      llm.verify.mockResolvedValue({
        passed: false,
        problems: '- Sending a message shows no reply.',
        model: 'Opus 5',
        tested: true,
        checked,
      });
      finish();
      await flush();
      check()?.click();
      await flush();
      const asked = sent().messages.at(-1)?.content;
      expect(asked).toContain('- Sending a message shows no reply.');
      expect(asked).toContain('What the reviewer did to check them:');
      expect(asked).toContain('in the app, sent "hi": the reply never arrived');
    });
  });

  it('says why when the review could not be made, and offers it again', async () => {
    llm.verify.mockRejectedValue(new Error('No models.'));
    finish();
    await flush();
    check()?.click();
    await flush();
    expect(messages().at(-2)).toBe('error: The review could not be made: No models.');
    expect(llm.send).toHaveBeenCalledTimes(1);
    expect(check()?.textContent).toBe('Review changes');
  });

  it('is not offered again after a pass, even after a restart', async () => {
    llm.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus 5' });
    finish();
    await flush();
    check()?.click();
    await flush();
    await vi.waitFor(() => expect(saved().threads[0].messages.at(-1).text).toContain('Review passed'), {
      timeout: 3000,
    });
    await start();
    await flush();
    expect(card()).toBeNull();
  });

  describe('automatically', () => {
    beforeEach(() => {
      llm.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus 5' });
    });

    it('checks a reply that left changes once it is over, when the setting is on', async () => {
      settings.autoReview = true;
      finish();
      await flush();
      expect(llm.verify).toHaveBeenCalledTimes(1);
      expect(llm.verify).toHaveBeenCalledWith(expect.objectContaining({ request: 'change a', ...model }));
    });

    it('checks nothing when the setting is off', async () => {
      finish();
      await flush();
      expect(llm.verify).not.toHaveBeenCalled();
    });

    it('checks nothing when the reply changed nothing', async () => {
      settings.autoReview = true;
      threads.changes.mockResolvedValue({ files: [] });
      finish();
      await flush();
      expect(llm.verify).not.toHaveBeenCalled();
    });

    it('checks nothing when the reply was stopped', async () => {
      settings.autoReview = true;
      emit(sentId(), { type: 'model', ...model, name: 'Opus', sophistication: 5, reason: 'matched' });
      emit(sentId(), { type: 'text', delta: 'I changed a.ts.' });
      emit(sentId(), { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 1 });
      await flush();
      expect(llm.verify).not.toHaveBeenCalled();
    });

    it("does not check the reply to the app's own request to fix what a review found", async () => {
      llm.verify.mockResolvedValue({ passed: false, problems: '- It left b.ts alone.', model: 'Opus 5' });
      settings.autoReview = true;
      finish();
      await flush();
      expect(llm.verify).toHaveBeenCalledTimes(1);
      expect(llm.send).toHaveBeenCalledTimes(2);
      finish();
      await flush();
      expect(llm.verify).toHaveBeenCalledTimes(1);
    });

    it('checks nothing when the reply failed', async () => {
      settings.autoReview = true;
      emit(sentId(), { type: 'model', ...model, name: 'Opus', sophistication: 5, reason: 'matched' });
      emit(sentId(), { type: 'text', delta: 'I changed a.ts.' });
      emit(sentId(), { type: 'error', message: 'Overloaded' });
      await flush();
      expect(llm.verify).not.toHaveBeenCalled();
    });
  });
});

describe('the approval level in the settings', () => {
  it('shows the saved level, and saves a new one at once', async () => {
    settings.approvalCeiling = 3;
    await start();
    $('#open-settings').click();
    await flush();
    const select = $<HTMLSelectElement>('#approval-ceiling');
    expect(select.value).toBe('3');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(settingsApi.save).toHaveBeenCalledWith({ approvalCeiling: 1 });
  });
});

describe('automatic review in the settings', () => {
  it('shows the saved setting, and saves a change at once', async () => {
    settings.autoReview = true;
    await start();
    $('#open-settings').click();
    await flush();
    const box = $<HTMLInputElement>('#auto-review');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(settingsApi.save).toHaveBeenCalledWith({ autoReview: false });
  });

  it('turns it on when the box is ticked', async () => {
    $('#open-settings').click();
    await flush();
    const box = $<HTMLInputElement>('#auto-review');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(settingsApi.save).toHaveBeenCalledWith({ autoReview: true });
  });
});

describe('the theme editor in the settings', () => {
  it('saves a theme value when its input changes', async () => {
    $('#open-settings').click();
    await flush();
    const input = $<HTMLInputElement>('[data-theme-var="--bg"]');
    expect(input).not.toBeNull();
    input.value = '#112233';
    input.dispatchEvent(new Event('change'));
    expect(settingsApi.save).toHaveBeenCalledWith({ theme: { '--bg': '#112233' } });
  });

  it('applies a theme from settings on start, and clears it on reset', async () => {
    settings.theme = { '--bg': '#abcdef' };
    document.documentElement.style.setProperty('--bg', 'initial');
    await start();
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#abcdef');
    settingsApi.save.mockResolvedValueOnce({ ...settings, theme: {} });
    $('#theme-reset').click();
    await flush();
    expect(settingsApi.save).toHaveBeenCalledWith({ theme: {} });
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
  });
});

describe('what the stylesheet says about the workspace notes list', () => {
  // A thread's own lines are notes too (.message.note). A rule that put a line
  // between one note and the next, written for the list, drew the top of an
  // empty bubble between two of the thread's lines — "Waiting for your answer"
  // and the tokens a reply had spent — wherever they came one after the other.
  it('keeps what goes between one note and the next to the list', () => {
    const sheet = fs.readFileSync(path.join(process.cwd(), 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...sheet.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap(([, list]) =>
      list.split(',').map((one) => one.trim())
    );
    const between = selectors.filter((selector) => /\.note\s*[+~]/.test(selector));
    expect(between.length).toBeGreaterThan(0);
    for (const selector of between) expect(selector).toMatch(/^#workspace-notes-list\s/);
  });
});
