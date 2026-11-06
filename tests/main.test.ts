import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { from } from './helpers';

// Electron and every module main.ts wires together are replaced, so these
// tests cover only the wiring: which IPC channel does what.
const electron = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  listeners: {} as Record<string, (...args: any[]) => any>,
  appEvents: {} as Record<string, (...args: any[]) => any>,
  windows: [] as any[],
  // The windows still open, which is what BrowserWindow.getAllWindows gives.
  // Apart from `windows`, which is every window ever made.
  open: [] as any[],
  quit: vi.fn(),
  setDockIcon: vi.fn(),
  showOpenDialog: vi.fn(),
  showErrorBox: vi.fn(),
  openExternal: vi.fn(),
  // The app being brought forward (see host:show)
  focus: vi.fn(),
  // The window a sender belongs to, if it still has one
  windowOf: vi.fn(),
  ready: Promise.resolve(),
  // What the app has named itself (app.setName)
  name: 'Electron',
}));

// The menu itself is tested in menu.test.ts; here it is only what main does
// with it (see showMenu)
const menu = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock('../src/menu', () => menu);

// Likewise the right-click menu, which is tested in contextmenu.test.ts
vi.mock('../src/contextmenu', () => ({ attach: vi.fn() }));

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows = () => electron.open;
    static fromWebContents = electron.windowOf;
    loadFile = vi.fn();
    // What the window does about links and navigation
    openHandler: (details: { url: string }) => { action: string } = () => ({ action: 'allow' });
    events: Record<string, (...args: any[]) => any> = {};
    destroyed = false;
    isDestroyed = () => this.destroyed;
    // Whether it is minimised, and what it was asked to do about being raised
    minimized = false;
    isMinimized = () => this.minimized;
    restore = vi.fn(() => {
      this.minimized = false;
    });
    show = vi.fn();
    webContents = {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
        this.openHandler = handler;
      },
      on: (name: string, listener: (...args: any[]) => any) => {
        this.events[name] = listener;
      },
      // What the main process pushes at the window (see project:looking)
      send: vi.fn(),
    };
    constructor(public options: any) {
      electron.windows.push(this);
      electron.open.push(this);
    }
  }
  return {
    BrowserWindow,
    dialog: { showOpenDialog: electron.showOpenDialog, showErrorBox: electron.showErrorBox },
    shell: { openExternal: electron.openExternal },
    app: {
      whenReady: () => electron.ready,
      on: (name: string, listener: (...args: any[]) => any) => {
        electron.appEvents[name] = listener;
      },
      quit: electron.quit,
      getPath: (name: string) => `/user/${name}`,
      getVersion: () => '0.1.0',
      setName: (name: string) => {
        electron.name = name;
      },
      getName: () => electron.name,
      focus: electron.focus,
      // Only macOS has one (see the icon in main.ts)
      dock: { setIcon: electron.setDockIcon },
    },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => {
        electron.handlers[channel] = handler;
      },
      on: (channel: string, listener: (...args: any[]) => any) => {
        electron.listeners[channel] = listener;
      },
    },
  };
});

const mocks = vi.hoisted(() => ({
  harness: {
    run: vi.fn(),
    summarize: vi.fn(),
    describe: vi.fn(),
    suggest: vi.fn(),
    verify: vi.fn(),
    answerFileAccess: vi.fn(),
    access: { configure: vi.fn() },
    answerApproval: vi.fn(),
    answerQuestion: vi.fn(),
    tools: { register: vi.fn(), stats: vi.fn() },
    project: {
      init: vi.fn(),
      due: vi.fn(),
      survey: vi.fn(),
      onSurveyed: vi.fn(),
      onLook: vi.fn(),
      looking: vi.fn(),
      watch: vi.fn(),
      get: vi.fn(),
      writtenAt: vi.fn(),
      surveying: vi.fn(),
      relook: vi.fn(),
      registerTools: vi.fn(),
      adopt: vi.fn(),
      promote: vi.fn(),
      forgetThread: vi.fn(),
    },
    // The detail behind the workspace's note (see harness/notes.ts)
    notes: {
      init: vi.fn(),
      promote: vi.fn(),
      forgetThread: vi.fn(),
      all: vi.fn(() => [] as unknown[]),
      remove: vi.fn(),
      check: vi.fn(() => ({ changed: [], gone: [], unchecked: [] })),
      search: vi.fn(),
    },
    review: { registerTools: vi.fn() },
    subagents: { registerTools: vi.fn(), retry: vi.fn(), forgetThread: vi.fn() },
  },
  llm: { configure: vi.fn(), listModels: vi.fn() },
  feedback: { record: vi.fn() },
  tools: { registerAll: vi.fn(), branches: { init: vi.fn() } },
  ollama: { status: vi.fn(), pull: vi.fn() },
  // What the app needs installed, and installing it (see src/setup)
  setup: { status: vi.fn(), installDocker: vi.fn(), cancel: vi.fn(), download: vi.fn() },
  sandbox: {
    registerTools: vi.fn(),
    init: vi.fn(),
    sweep: vi.fn(() => Promise.resolve({ removed: [], stopped: [], volumes: [], images: [] })),
    remove: vi.fn(),
    stopAll: vi.fn(),
    readContext: vi.fn(),
    restoreContext: vi.fn(),
    configure: vi.fn(),
    changes: { list: vi.fn(), apply: vi.fn(), snapshot: vi.fn(), revert: vi.fn() },
    recipes: { init: vi.fn() },
    readFileInWorkspace: vi.fn(),
    worktree: {
      branches: vi.fn(),
      ensureWorktree: vi.fn(),
      status: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
      pull: vi.fn(),
      remove: vi.fn(),
    },
  },
  search: {
    init: vi.fn(),
    configure: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    forget: vi.fn(),
    threads: { index: vi.fn(), search: vi.fn() },
  },
  settings: {
    load: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    publicView: vi.fn(),
    readable: vi.fn(),
    allowRead: vi.fn(),
  },
  store: { load: vi.fn(), save: vi.fn(), saveMedia: vi.fn(), threadIds: vi.fn(() => null) },
  log: { init: vi.fn(), watchProcess: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: vi.fn() },
}));

vi.mock('../src/harness', () => mocks.harness);
vi.mock('../src/llm', () => mocks.llm);
vi.mock('../src/feedback', () => mocks.feedback);
vi.mock('../src/tools', () => mocks.tools);
vi.mock('../src/llm/ollama', () => mocks.ollama);
vi.mock('../src/log', () => mocks.log);
vi.mock('../src/store', () => mocks.store);
vi.mock('../src/sandbox', () => mocks.sandbox);
vi.mock('../src/search', () => mocks.search);
vi.mock('../src/settings', () => mocks.settings);
vi.mock('../src/setup', () => mocks.setup);

const saved = {
  local: { baseURL: 'http://localhost:11434/v1', apiKey: '' },
  // What a thread's container is built from; '' lets the workspace decide
  sandbox: { image: '' },
  // Whether only this computer's models may be used (see the app's menu)
  offline: false,
};

// The window a message came from
function sender() {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) };
}

beforeEach(async () => {
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) {
      if (typeof mock === 'function') mock.mockReset();
    }
  }
  mocks.harness.tools.register.mockReset();
  mocks.harness.tools.stats.mockReset();
  Object.values(mocks.harness.project).forEach((mock) => mock.mockReset());
  Object.values(mocks.sandbox.worktree).forEach((mock) => mock.mockReset());
  mocks.log.since.mockReturnValue(5);
  mocks.settings.load.mockReturnValue(saved);
  mocks.settings.get.mockReturnValue(saved);
  mocks.settings.publicView.mockReturnValue({ public: true });
  // The threads the sweep goes by (see sandbox/docker.ts)
  mocks.store.threadIds.mockReturnValue(['t1', 't2']);
  mocks.sandbox.sweep.mockResolvedValue({ removed: [], stopped: [], volumes: [], images: [] });
  // What there is to switch between, which the Offline and Fast switches are
  // greyed out without (see refreshAvailable in main.ts)
  mocks.setup.status.mockResolvedValue({
    local: { models: 1 },
    keys: { anthropic: false, openai: false },
  });
  electron.windows = [];
  electron.open = [];
  electron.quit.mockReset();
  electron.showOpenDialog.mockReset();
  electron.openExternal.mockReset();
  electron.showErrorBox.mockReset();
  menu.install.mockReset();
  electron.windowOf.mockReset();
  electron.focus.mockReset();
  vi.resetModules();
  await import('../src/main');
  await electron.ready;
});

describe('startup', () => {
  it('loads settings, configures the providers, registers the sandbox and search tools, and opens a window', () => {
    expect(mocks.llm.configure).toHaveBeenCalledWith(saved);
    // Every tool there is, registered from the one place they are defined
    expect(mocks.tools.registerAll).toHaveBeenCalledWith(mocks.harness.tools);
    // Where the worktrees of the branches a subagent makes are kept
    expect(mocks.tools.branches.init).toHaveBeenCalledWith('/user/userData');
    // ...and how each workspace's app is run
    expect(mocks.sandbox.recipes.init).toHaveBeenCalledWith('/user/userData');
    // ...and where a container that could not be removed is written down
    expect(mocks.sandbox.init).toHaveBeenCalledWith('/user/userData');
    // What the user has allowed the model to read on their computer is kept in the settings
    expect(mocks.harness.access.configure).toHaveBeenCalledWith({
      readable: mocks.settings.readable,
      allow: mocks.settings.allowRead,
    });
    expect(electron.windows).toHaveLength(1);
    expect(electron.windows[0].options.webPreferences.preload).toMatch(/preload\.js$/);
    expect(electron.windows[0].loadFile.mock.calls[0][0]).toMatch(/index\.html$/);
  });

  it("starts the log in the app's log workspace before anything else, and watches for crashes", () => {
    expect(mocks.log.init).toHaveBeenCalledWith('/user/logs');
    expect(mocks.log.watchProcess).toHaveBeenCalled();
    expect(mocks.log.init.mock.invocationCallOrder[0]).toBeLessThan(mocks.settings.load.mock.invocationCallOrder[0]);
    expect(mocks.log.info).toHaveBeenCalledWith('app.start', expect.objectContaining({ version: '0.1.0' }));
  });

  it('logs errors from the window, and the window dying', () => {
    const [win] = electron.windows;
    win.events['console-message']({ level: 'info', message: 'fine', lineNumber: 1, sourceId: 'renderer.js' });
    expect(mocks.log.error).not.toHaveBeenCalled();
    win.events['console-message']({
      level: 'error',
      message: 'x is undefined',
      lineNumber: 12,
      sourceId: 'renderer.js',
    });
    expect(mocks.log.error).toHaveBeenCalledWith('renderer.error', {
      error: 'x is undefined',
      source: 'renderer.js:12',
    });
    win.events['render-process-gone']({}, { reason: 'crashed', exitCode: 11 });
    expect(mocks.log.error).toHaveBeenCalledWith('renderer.gone', { reason: 'crashed', exitCode: 11 });
  });

  it('configures providers before the window can ask for models', () => {
    const configured = mocks.llm.configure.mock.invocationCallOrder[0];
    const opened = electron.windows[0].loadFile.mock.invocationCallOrder[0];
    expect(configured).toBeLessThan(opened);
  });

  it('calls itself ch, and opens the window under that name', () => {
    expect(electron.name).toBe('ch');
    // The page then adds the project to it (see renderer.ts)
    expect(electron.windows[0].options.title).toBe('ch');
  });

  it('keeps the window isolated from Node', () => {
    const prefs = electron.windows[0].options.webPreferences;
    expect(prefs.nodeIntegration).toBeUndefined();
    expect(prefs.contextIsolation).toBeUndefined();
  });

  it("opens web and email links in the user's browser, and nothing in a new window", () => {
    const [win] = electron.windows;
    expect(win.openHandler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    expect(win.openHandler({ url: 'mailto:someone@example.com' })).toEqual({ action: 'deny' });
    expect(electron.openExternal.mock.calls).toEqual([['https://example.com/docs'], ['mailto:someone@example.com']]);

    expect(win.openHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(electron.openExternal).toHaveBeenCalledTimes(2);
  });

  it('never lets the window navigate away from the app', () => {
    const event = { preventDefault: vi.fn() };
    electron.windows[0].events['will-navigate'](event, 'https://example.com');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  // What earlier sessions left behind: a container whose thread was deleted
  // while Docker was down, one a session that was killed left running, and the
  // caches and images nothing uses (see sweep in sandbox/docker.ts)
  it('cleans up after earlier sessions, with the threads there still are', () => {
    expect(mocks.sandbox.sweep).toHaveBeenCalledWith(['t1', 't2']);
    // After the window: nothing waits on it
    const swept = mocks.sandbox.sweep.mock.invocationCallOrder[0];
    expect(swept).toBeGreaterThan(electron.windows[0].loadFile.mock.invocationCallOrder[0]);
  });

  it('takes no thread container away when the threads cannot be told', async () => {
    mocks.store.threadIds.mockReturnValue(null);
    mocks.sandbox.sweep.mockClear();
    vi.resetModules();
    await import('../src/main');
    await electron.ready;
    expect(mocks.sandbox.sweep).toHaveBeenCalledWith(undefined);
  });

  it('reopens a window on activate only when none is open', () => {
    electron.appEvents.activate();
    expect(electron.windows).toHaveLength(1);
    electron.open = [];
    electron.appEvents.activate();
    expect(electron.windows).toHaveLength(2);
  });
});

describe('quitting', () => {
  it('stops the sandbox containers before quitting', () => {
    electron.appEvents['before-quit']();
    expect(mocks.sandbox.stopAll).toHaveBeenCalled();
  });

  it('logs how each tool did over the session', () => {
    const stats = { run_command: { calls: 2, failures: 1, avgMs: 40, maxMs: 70 } };
    mocks.harness.tools.stats.mockReturnValue(stats);
    electron.appEvents['before-quit']();
    expect(mocks.log.info).toHaveBeenCalledWith('app.quit', { tools: stats });
  });

  it('quits when all windows close, except on macOS', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      electron.appEvents['window-all-closed']();
      expect(electron.quit).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      electron.appEvents['window-all-closed']();
      expect(electron.quit).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('llm channels', () => {
  it('always lists models afresh for the UI', async () => {
    mocks.llm.listModels.mockResolvedValue({ models: [], providers: [] });
    await electron.handlers['llm:models']({}, { includeDisabled: true });
    expect(mocks.llm.listModels).toHaveBeenCalledWith({ includeDisabled: true, fresh: true });
    await electron.handlers['llm:models']({}, undefined);
    expect(mocks.llm.listModels).toHaveBeenLastCalledWith({ fresh: true });
  });

  it('suggests what the user might say next through the harness', async () => {
    mocks.harness.suggest.mockResolvedValue({ text: 'Yes, add one' });
    const request = { messages: [{ role: 'assistant', content: 'Add a test?' }] };
    await expect(electron.handlers['llm:suggest']({}, request)).resolves.toEqual({ text: 'Yes, add one' });
    expect(mocks.harness.suggest).toHaveBeenCalledWith(request);
  });

  it('describes a thread through the harness', async () => {
    mocks.harness.describe.mockResolvedValue({ text: 'Parsing JSON' });
    const request = { requests: ['How do I parse JSON?'] };
    await expect(electron.handlers['llm:describe']({}, request)).resolves.toEqual({ text: 'Parsing JSON' });
    expect(mocks.harness.describe).toHaveBeenCalledWith(request);
  });

  it("has a reply's changes checked through the harness", async () => {
    const verdict = { passed: true, problems: '', model: 'Opus' };
    mocks.harness.verify.mockResolvedValue(verdict);
    const request = { thread: 't', request: 'Add a flag', output: 'Done.' };
    await expect(electron.handlers['llm:verify']({}, request)).resolves.toEqual(verdict);
    expect(mocks.harness.verify).toHaveBeenCalledWith(request, { untouched: expect.any(Function) });
  });

  // A review that tries the changes has the thread's files put back afterwards, which would throw away the changes of
  // a reply begun on the thread while it ran (see harness/verifier.ts)
  it('tells the review whether a reply has started on the thread since it began', async () => {
    mocks.harness.verify.mockResolvedValue({ passed: true, problems: '', model: 'Opus' });
    await electron.handlers['llm:verify']({}, { thread: 't', request: 'Add a flag', output: 'Done.' });
    const { untouched } = mocks.harness.verify.mock.calls[0][1];
    expect(untouched()).toBe(true);
    mocks.harness.run.mockReturnValue(from([{ type: 'done', stopReason: 'end_turn', steps: 1, usage: {} }]));
    await electron.listeners['llm:send']({ sender: sender() }, 'r1', { thread: 't' });
    expect(untouched()).toBe(false);
  });

  it("keeps the user's verdict on a classification", () => {
    const verdict = { rating: 'bad', problems: ['too_low'], request: 'Hi', thread: 't' };
    electron.listeners['llm:feedback']({}, verdict);
    expect(mocks.feedback.record).toHaveBeenCalledWith(verdict);
  });

  it('summarizes a conversation through the harness', async () => {
    mocks.harness.summarize.mockResolvedValue('The summary.');
    const request = { messages: [{ role: 'user', content: 'hi' }], summary: 'Earlier.' };
    await expect(electron.handlers['llm:summarize']({}, request)).resolves.toBe('The summary.');
    expect(mocks.harness.summarize).toHaveBeenCalledWith(request);
  });

  it('runs a message through the harness and forwards every event to its window', async () => {
    const events = [{ type: 'text', delta: 'hi' }, { type: 'done' }];
    mocks.harness.run.mockReturnValue(from(events));
    const window = sender();
    const request = { thread: 't', messages: [] };

    await electron.listeners['llm:send']({ sender: window }, 'r1', request);
    expect(mocks.harness.run.mock.calls[0][0]).toBe(request);
    expect(window.send.mock.calls).toEqual([
      ['llm:event', 'r1', events[0]],
      ['llm:event', 'r1', events[1]],
    ]);
  });

  it('logs the start of a reply, and how it ended and how long it took', async () => {
    const usage = { input: 30, output: 8 };
    mocks.harness.run.mockReturnValue(from([{ type: 'done', stopReason: 'end_turn', steps: 2, usage }]));
    const request = { thread: 't', workspace: '/projects/demo', messages: [{ role: 'user', content: 'hi' }] };
    await electron.listeners['llm:send']({ sender: sender() }, 'r1', request);

    expect(mocks.harness.run.mock.calls[0][2]).toBe('r1');
    expect(mocks.log.info).toHaveBeenCalledWith('request.start', {
      request: 'r1',
      thread: 't',
      messages: 1,
      workspace: true,
      summarized: false,
      picked: undefined,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('request.end', {
      request: 'r1',
      thread: 't',
      ms: 5,
      ok: true,
      stopReason: 'end_turn',
      steps: 2,
      input: 30,
      output: 8,
    });
  });

  it('runs one failed subagent again, passing its work to every window as it happens', async () => {
    mocks.harness.subagents.retry.mockImplementation(async (_asked: unknown, emit: (event: unknown) => void) => {
      emit({ type: 'thought', text: 'Trying again.' });
      return { text: 'They use vitest.', isError: false };
    });
    const asked = { thread: 't', id: 's1', name: 'tests', task: 'read the tests', kind: 'worker' };

    await expect(electron.handlers['llm:retry-subagent']({ sender: sender() }, asked)).resolves.toEqual({
      text: 'They use vitest.',
      isError: false,
    });
    expect(mocks.harness.subagents.retry.mock.calls[0][0]).toBe(asked);
    // The work goes to the window whichever one asked for it: a subagent
    // belongs to its thread, which every window shows
    expect(electron.windows[0].webContents.send.mock.calls).toEqual([
      ['llm:subagent-event', 't', 's1', { type: 'thought', text: 'Trying again.' }],
    ]);
  });

  it('logs a reply that failed as an error, whether the harness reported it or threw', async () => {
    mocks.harness.run.mockReturnValue(from([{ type: 'error', code: 'rate_limit', status: 429, message: 'slow down' }]));
    await electron.listeners['llm:send']({ sender: sender() }, 'r1', { thread: 't' });
    expect(mocks.log.error).toHaveBeenLastCalledWith('request.end', {
      request: 'r1',
      thread: 't',
      ms: 5,
      ok: false,
      code: 'rate_limit',
      status: 429,
      error: 'slow down',
    });

    const bug = new Error('bug');
    mocks.harness.run.mockImplementation(async function* () {
      throw bug;
    });
    await expect(electron.listeners['llm:send']({ sender: sender() }, 'r2', { thread: 't' })).rejects.toBe(bug);
    expect(mocks.log.error).toHaveBeenLastCalledWith(
      'request.end',
      expect.objectContaining({ request: 'r2', error: bug })
    );
  });

  it('cancels the right request, and only while it is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.harness.run.mockImplementation(async function* () {
      await gate;
    });

    const running = electron.listeners['llm:send']({ sender: sender() }, 'r1', {});
    const signal = mocks.harness.run.mock.calls[0][1] as AbortSignal;

    electron.listeners['llm:cancel']({}, 'someone-else');
    expect(signal.aborted).toBe(false);
    electron.listeners['llm:cancel']({}, 'r1');
    expect(signal.aborted).toBe(true);

    release();
    await running;
    // Finished requests are forgotten, so a late cancel is harmless
    expect(() => electron.listeners['llm:cancel']({}, 'r1')).not.toThrow();
  });

  it("passes the user's answer about reading a file on to harness.answerFileAccess", () => {
    const listener = electron.listeners['llm:allow-file-access'];
    listener({}, 'ask-1', 'folder');
    expect(mocks.harness.answerFileAccess).toHaveBeenCalledWith('ask-1', 'folder');
  });

  it('registers an llm:approve handler which calls harness.answerApproval', async () => {
    mocks.harness.answerApproval.mockReset();
    const listener = electron.listeners['llm:approve'];
    expect(listener).toBeDefined();

    // approve with true
    listener({}, 'r1', true);
    expect(mocks.harness.answerApproval).toHaveBeenCalledWith('r1', true);
    mocks.harness.answerApproval.mockClear();

    // approve with false
    listener({}, 'r2', false);
    expect(mocks.harness.answerApproval).toHaveBeenCalledWith('r2', false);
    mocks.harness.answerApproval.mockClear();

    // approve with undefined (non-true) should be treated as false
    listener({}, 'r3', undefined);
    expect(mocks.harness.answerApproval).toHaveBeenCalledWith('r3', false);
    mocks.harness.answerApproval.mockClear();

    // approve with 'yes' string should be treated as false
    listener({}, 'r4', 'yes');
    expect(mocks.harness.answerApproval).toHaveBeenCalledWith('r4', false);
  });

  it('registers an llm:answer handler which calls harness.answerQuestion', async () => {
    mocks.harness.answerQuestion.mockReset();
    const listener = electron.listeners['llm:answer'];
    expect(listener).toBeDefined();

    listener({}, 'r1', 'the second one');
    expect(mocks.harness.answerQuestion).toHaveBeenCalledWith('r1', 'the second one');
    mocks.harness.answerQuestion.mockClear();

    // Anything but a string is no answer
    listener({}, 'r2', undefined);
    expect(mocks.harness.answerQuestion).toHaveBeenCalledWith('r2', '');
  });

  it('stops the harness if the window is closed mid-reply', async () => {
    mocks.harness.run.mockReturnValue(
      from([
        { type: 'text', delta: 'a' },
        { type: 'text', delta: 'b' },
      ])
    );
    const window = sender();
    window.isDestroyed.mockReturnValue(true);

    await electron.listeners['llm:send']({ sender: window }, 'r1', {});
    expect(window.send).not.toHaveBeenCalled();
    expect((mocks.harness.run.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });
});

describe('thread channels', () => {
  it('asks for a workspace in a dialog attached to the window, and returns the one chosen', async () => {
    const win = { id: 1 };
    const from = sender();
    electron.windowOf.mockReturnValue(win);
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/projects/demo'] });

    await expect(electron.handlers['thread:choose-workspace']({ sender: from })).resolves.toBe('/projects/demo');
    expect(electron.windowOf).toHaveBeenCalledWith(from);
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] })
    );
  });

  it('returns null when the user backs out of the workspace dialog', async () => {
    electron.windowOf.mockReturnValue({ id: 1 });
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(electron.handlers['thread:choose-workspace']({ sender: sender() })).resolves.toBeNull();
  });

  it('still asks when the window cannot be found', async () => {
    electron.windowOf.mockReturnValue(null);
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/projects/demo'] });
    await expect(electron.handlers['thread:choose-workspace']({ sender: sender() })).resolves.toBe('/projects/demo');
    expect(electron.showOpenDialog.mock.calls[0][0]).toMatchObject({ properties: expect.any(Array) });
  });

  it("lists a workspace's branches through the sandbox", async () => {
    const found = { current: 'main', names: ['main', 'dev'] };
    mocks.sandbox.worktree.branches.mockResolvedValue(found);
    await expect(electron.handlers['thread:branches']({}, '/projects/demo')).resolves.toEqual(found);
    expect(mocks.sandbox.worktree.branches).toHaveBeenCalledWith('/projects/demo');
  });

  it("prepares a branch's worktree under the app's data folder, and returns its path", async () => {
    mocks.sandbox.worktree.ensureWorktree.mockResolvedValue('/user/userData/worktrees/demo-feature');
    await expect(
      electron.handlers['thread:prepare-branch']({}, '/projects/demo', 'feature', 'main', true)
    ).resolves.toBe('/user/userData/worktrees/demo-feature');
    expect(mocks.sandbox.worktree.ensureWorktree).toHaveBeenCalledWith(
      '/projects/demo',
      '/user/userData',
      'feature',
      'main',
      true
    );
  });

  it("reports where a branch's worktree stands, and commits, pushes and pulls it there", async () => {
    const standing = { upstream: 'origin/feature', ahead: 1, behind: 0, dirty: false };
    mocks.sandbox.worktree.status.mockResolvedValue(standing);
    await expect(electron.handlers['thread:branch-status']({}, '/worktrees/feature')).resolves.toEqual(standing);
    expect(mocks.sandbox.worktree.status).toHaveBeenCalledWith('/worktrees/feature');

    mocks.sandbox.worktree.commit.mockResolvedValue(true);
    await expect(electron.handlers['thread:branch-commit']({}, '/worktrees/feature', 'Add a')).resolves.toBe(true);
    expect(mocks.sandbox.worktree.commit).toHaveBeenCalledWith('/worktrees/feature', 'Add a');

    mocks.sandbox.worktree.push.mockResolvedValue('origin/feature');
    await expect(electron.handlers['thread:branch-push']({}, '/worktrees/feature')).resolves.toBe('origin/feature');
    expect(mocks.sandbox.worktree.push).toHaveBeenCalledWith('/worktrees/feature');

    mocks.sandbox.worktree.pull.mockResolvedValue(undefined);
    await electron.handlers['thread:branch-pull']({}, '/worktrees/feature');
    expect(mocks.sandbox.worktree.pull).toHaveBeenCalledWith('/worktrees/feature');
  });

  it('passes on why git refused, rather than swallowing it', async () => {
    mocks.sandbox.worktree.push.mockRejectedValue(new Error('rejected: non-fast-forward'));
    await expect(electron.handlers['thread:branch-push']({}, '/worktrees/feature')).rejects.toThrow('non-fast-forward');
  });

  it('removes a worktree that nothing is using any more', async () => {
    mocks.sandbox.worktree.remove.mockResolvedValue(undefined);
    await electron.handlers['thread:remove-worktree']({}, '/projects/demo', '/worktrees/feature');
    expect(mocks.sandbox.worktree.remove).toHaveBeenCalledWith('/projects/demo', '/worktrees/feature');
  });

  it('hands the window its saved threads, and saves them, answering at once', () => {
    mocks.store.load.mockReturnValue('{"threads":[]}');
    const loading: { returnValue?: unknown } = {};
    electron.listeners['threads:load'](loading);
    expect(loading.returnValue).toBe('{"threads":[]}');

    const saving: { returnValue?: unknown } = {};
    electron.listeners['threads:save'](saving, '{"threads":[1]}');
    expect(mocks.store.save).toHaveBeenCalledWith('{"threads":[1]}');
    expect(saving.returnValue).toBe(true);
  });

  // The window waits on this one, and stays frozen until it is answered
  it('saves the media sidecar, answering at once', () => {
    const items = [{ id: 'a', mediaType: 'image/png', data: 'base64-a' }];
    const saving: { returnValue?: unknown } = {};
    electron.listeners['threads:save-media'](saving, items);
    expect(mocks.store.saveMedia).toHaveBeenCalledWith(items);
    expect(saving.returnValue).toBe(true);
  });

  it('brings the window forward for a notification the user clicked', () => {
    const win = new (class {
      destroyed = false;
      isDestroyed = () => this.destroyed;
      minimized = false;
      isMinimized = () => this.minimized;
      restore = vi.fn();
      show = vi.fn();
    })();
    const from = sender();
    electron.windowOf.mockReturnValue(win);

    electron.listeners['host:show']({ sender: from });
    expect(electron.windowOf).toHaveBeenCalledWith(from);
    expect(win.show).toHaveBeenCalled();
    // The window showing is not the app coming forward on macOS
    expect(electron.focus).toHaveBeenCalledWith({ steal: true });
    // Nothing to restore: it was not minimised
    expect(win.restore).not.toHaveBeenCalled();
  });

  it('unminimises the window first, when it was minimised', () => {
    const win = new (class {
      isDestroyed = () => false;
      isMinimized = () => true;
      restore = vi.fn();
      show = vi.fn();
    })();
    electron.windowOf.mockReturnValue(win);
    electron.listeners['host:show']({ sender: sender() });
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
  });

  it('says nothing to a window that has gone', () => {
    electron.windowOf.mockReturnValue(null);
    expect(() => electron.listeners['host:show']({ sender: sender() })).not.toThrow();
    electron.windowOf.mockReturnValue({ isDestroyed: () => true });
    expect(() => electron.listeners['host:show']({ sender: sender() })).not.toThrow();
    expect(electron.focus).not.toHaveBeenCalled();
  });

  it("starts the search server for an opened thread's workspace", () => {
    electron.listeners['thread:open']({}, 'thread-1', '/projects/demo');
    expect(mocks.search.open).toHaveBeenCalledWith('thread-1', '/projects/demo');
  });

  it('has a workspace looked at when it is opened for the first time, and only then', () => {
    mocks.harness.project.due.mockReturnValue(true);
    electron.listeners['thread:open']({}, 'thread-1', '/projects/demo');
    expect(mocks.harness.project.due).toHaveBeenCalledWith('/projects/demo');
    expect(mocks.harness.project.survey).toHaveBeenCalledWith('/projects/demo', 'thread-1');

    mocks.harness.project.survey.mockClear();
    mocks.harness.project.due.mockReturnValue(false);
    electron.listeners['thread:open']({}, 'thread-2', '/projects/demo');
    expect(mocks.harness.project.survey).not.toHaveBeenCalled();
  });

  it("wears the app's own mark rather than Electron's, in the dock and on the window", () => {
    // macOS shows it in the dock, where a window's icon is ignored; Windows
    // and Linux take it from the window and have no dock to set
    const [icon] = electron.setDockIcon.mock.calls[0];
    expect(icon).toMatch(/assets[/\\]icon\.png$/);
    expect(electron.windows[0].options.icon).toBe(icon);
    // ...and it is really there, drawn from assets/icon.svg beside it
    expect(fs.existsSync(icon)).toBe(true);
  });

  it("keeps the notes on workspaces in the app's data folder, both kinds of them", () => {
    expect(mocks.harness.project.init).toHaveBeenCalledWith('/user/userData');
    expect(mocks.harness.notes.init).toHaveBeenCalledWith('/user/userData');
  });

  // One of the workspace's detailed notes as the store keeps one
  const kept = (over: Record<string, unknown> = {}) => ({
    workspace: '/projects/demo',
    subject: 'Running the tests',
    content: 'npm test runs vitest.',
    writtenAt: '2026-10-06T10:00:00.000Z',
    files: [{ path: 'package.json', digest: 'abc' }],
    ...over,
  });

  it('tells the window what a workspace is keeping, for the user to read', async () => {
    mocks.harness.project.get.mockReturnValue('A TypeScript parser.');
    mocks.harness.project.writtenAt.mockReturnValue('2026-10-06T10:00:00.000Z');
    mocks.harness.project.surveying.mockReturnValue(false);
    mocks.harness.notes.all.mockReturnValue([kept()]);
    expect(electron.handlers['workspace:details']({}, '/projects/demo')).toEqual({
      note: 'A TypeScript parser.',
      writtenAt: '2026-10-06T10:00:00.000Z',
      surveying: false,
      // The detailed notes behind that one, with their files by name: the
      // fingerprints they keep of them are no use to a reader
      notes: [
        {
          subject: 'Running the tests',
          content: 'npm test runs vitest.',
          writtenAt: '2026-10-06T10:00:00.000Z',
          thread: undefined,
          files: ['package.json'],
        },
      ],
      moreNotes: 0,
    });
    expect(mocks.harness.project.get).toHaveBeenCalledWith('/projects/demo');
  });

  it('says of each note shown whether what it was worked out from has moved on since', async () => {
    mocks.harness.notes.all.mockReturnValue([kept()]);
    mocks.harness.notes.check.mockReturnValue({ changed: ['package.json'], gone: [], unchecked: [] });
    const { notes } = electron.handlers['workspace:details']({}, '/projects/demo');
    expect(notes[0].drift).toEqual({ changed: ['package.json'], gone: [] });
    expect(mocks.harness.notes.check).toHaveBeenCalledWith('/projects/demo', kept());
  });

  it('lists the newest of them and says how many more there are, a workspace keeping hundreds', async () => {
    mocks.harness.notes.all.mockReturnValue(Array.from({ length: 62 }, (_, i) => kept({ subject: `Thing ${i}` })));
    const details = electron.handlers['workspace:details']({}, '/projects/demo');
    expect(details.notes).toHaveLength(50);
    expect(details.notes[0].subject).toBe('Thing 0');
    expect(details.moreNotes).toBe(12);
  });

  it('searches the notes by meaning for the window, the same way a model searches them', async () => {
    mocks.harness.notes.search.mockResolvedValue({
      hits: [kept({ score: 0.7, drift: { changed: ['package.json'], gone: [], unchecked: [] } })],
      by: 'meaning',
    });
    await expect(
      electron.handlers['workspace:search-notes']({}, '/projects/demo', 'how are tests run')
    ).resolves.toEqual([
      {
        subject: 'Running the tests',
        content: 'npm test runs vitest.',
        writtenAt: '2026-10-06T10:00:00.000Z',
        thread: undefined,
        files: ['package.json'],
        drift: { changed: ['package.json'], gone: [] },
      },
    ]);
    const [workspace, query] = mocks.harness.notes.search.mock.calls[0];
    expect([workspace, query]).toEqual(['/projects/demo', 'how are tests run']);
  });

  it('throws one of those notes away when the user does, that being nobody else’s to do', () => {
    mocks.harness.notes.remove.mockReturnValue(true);
    expect(electron.handlers['workspace:forget-note']({}, '/projects/demo', 'Running the tests', 't1')).toBe(true);
    expect(mocks.harness.notes.remove).toHaveBeenCalledWith('/projects/demo', 'Running the tests', 't1');
  });

  it('says so when the note was already gone, a window showing one it no longer has', () => {
    mocks.harness.notes.remove.mockReturnValue(false);
    expect(electron.handlers['workspace:forget-note']({}, '/projects/demo', 'The parser')).toBe(false);
    expect(mocks.harness.notes.remove).toHaveBeenCalledWith('/projects/demo', 'The parser', undefined);
  });

  it('reads a file of a workspace by the name a reply gave it, for the user to open', () => {
    mocks.sandbox.readFileInWorkspace.mockReturnValue({ path: 'src/main.ts', lines: ['a', 'b'], from: 1, total: 2 });
    expect(electron.handlers['workspace:file']({}, '/projects/demo', 'src/main.ts', 1, 2)).toEqual({
      path: 'src/main.ts',
      lines: ['a', 'b'],
      from: 1,
      total: 2,
    });
    expect(mocks.sandbox.readFileInWorkspace).toHaveBeenCalledWith('/projects/demo', 'src/main.ts', 1, 2);
  });

  it('reads a whole file when a reply names no lines', () => {
    mocks.sandbox.readFileInWorkspace.mockReturnValue({ path: 'a.txt', lines: ['x'], from: 1, total: 1 });
    expect(electron.handlers['workspace:file']({}, '/projects/demo', 'a.txt')).toEqual({
      path: 'a.txt',
      lines: ['x'],
      from: 1,
      total: 1,
    });
    expect(mocks.sandbox.readFileInWorkspace).toHaveBeenCalledWith('/projects/demo', 'a.txt', undefined, undefined);
  });

  it('passes on what the explorer says while it works, so the window can show the work', async () => {
    // What the main process does when a look begins: watch it and send on
    // everything it says
    const said = [
      { type: 'thought', text: 'Looking for where it starts.' },
      { type: 'tool_call', id: 'c1', name: 'search_workspace', input: { query: 'entry' } },
    ];
    mocks.harness.project.watch.mockImplementation(async function* () {
      yield* said;
      return 'A parser.';
    });
    const [listener] = mocks.harness.project.onLook.mock.calls[0];
    listener('/projects/demo', true, 'Get to know the project.');
    await vi.waitFor(() =>
      expect(electron.windows[0].webContents.send.mock.calls.filter(([c]) => c === 'project:look-event')).toHaveLength(
        2
      )
    );
    const sent = electron.windows[0].webContents.send.mock.calls;
    expect(sent.find(([c]) => c === 'project:looking')?.slice(1)).toEqual([
      '/projects/demo',
      true,
      'Get to know the project.',
    ]);
    expect(sent.filter(([c]) => c === 'project:look-event').map(([, , e]) => e)).toEqual(said);
  });

  it('watches nothing when a look has ended', () => {
    const [listener] = mocks.harness.project.onLook.mock.calls[0];
    listener('/projects/demo', false);
    expect(mocks.harness.project.watch).not.toHaveBeenCalled();
  });

  it("looks at a workspace again when the window asks, from the open thread's container", async () => {
    mocks.harness.project.relook.mockResolvedValue('A fresh note.');
    await expect(electron.handlers['workspace:relook']({}, '/projects/demo', 'thread-1')).resolves.toBe(
      'A fresh note.'
    );
    expect(mocks.harness.project.relook).toHaveBeenCalledWith('/projects/demo', 'thread-1');
  });

  it("tells the window what a thread is keeping: its own notes, and what it made of the workspace's", async () => {
    mocks.sandbox.readContext.mockResolvedValue('Goal: build the parser.');
    mocks.harness.project.get.mockImplementation((_workspace: string, thread?: string) =>
      thread ? 'A parser, now built with esbuild.' : 'A parser.'
    );
    await expect(electron.handlers['thread:details']({}, 'thread-1', '/projects/demo')).resolves.toEqual({
      context: 'Goal: build the parser.',
      note: 'A parser, now built with esbuild.',
      shared: 'A parser.',
    });
    expect(mocks.sandbox.readContext).toHaveBeenCalledWith('thread-1');
  });

  it('has no workspace notes to tell it about for a thread that has no workspace', async () => {
    mocks.sandbox.readContext.mockResolvedValue('Goal: think.');
    mocks.harness.project.get.mockReset();
    await expect(electron.handlers['thread:details']({}, 'thread-1', undefined)).resolves.toEqual({
      context: 'Goal: think.',
      note: '',
      shared: '',
    });
    expect(mocks.harness.project.get).not.toHaveBeenCalled();
  });

  it("lists a thread's changes, and writes them to its workspace when asked", async () => {
    mocks.sandbox.changes.list.mockReset().mockResolvedValue({ files: [] });
    mocks.sandbox.changes.apply.mockReset().mockResolvedValue({ applied: ['a.txt'], conflicts: [], skipped: [] });
    await expect(electron.handlers['thread:changes']({}, 'thread-1')).resolves.toEqual({ files: [] });
    expect(mocks.sandbox.changes.list).toHaveBeenCalledWith('thread-1');
    expect(mocks.sandbox.changes.apply).not.toHaveBeenCalled();

    await expect(electron.handlers['thread:apply-changes']({}, 'thread-1', '/projects/demo')).resolves.toMatchObject({
      applied: ['a.txt'],
    });
    expect(mocks.sandbox.changes.apply).toHaveBeenCalledWith('thread-1', '/projects/demo');
    // What it learned about the project goes back with its files: the note
    // every message carries, and the notes behind it
    expect(mocks.harness.project.promote).toHaveBeenCalledWith('/projects/demo', 'thread-1');
    expect(mocks.harness.notes.promote).toHaveBeenCalledWith('/projects/demo', 'thread-1');
  });

  it('leaves what a thread learned where it was when none of its changes were applied', async () => {
    mocks.sandbox.changes.apply.mockReset().mockResolvedValue({ applied: [], conflicts: [], skipped: ['a.txt'] });
    await electron.handlers['thread:apply-changes']({}, 'thread-1', '/projects/demo');
    expect(mocks.harness.project.promote).not.toHaveBeenCalled();
    expect(mocks.harness.notes.promote).not.toHaveBeenCalled();
  });

  it("throws away a thread's changes back to its last write-back, and never writes to the workspace", async () => {
    mocks.sandbox.changes.revert.mockReset().mockResolvedValue(true);
    await expect(electron.handlers['thread:discard-changes']({}, 'thread-1')).resolves.toBe(true);
    expect(mocks.sandbox.changes.revert).toHaveBeenCalledWith('thread-1', null);
    expect(mocks.sandbox.changes.apply).not.toHaveBeenCalled();
  });

  // An attempt the user throws away has still done whatever its tools did and
  // written down what it found, and the window asks for that undone before
  // trying again (see the retry in ../src/renderer/message-menu.ts)
  describe("putting a thrown-away attempt's work back", () => {
    const start = (request: string, thread = 'thread-1') => {
      mocks.harness.run.mockReturnValue(from([{ type: 'done' }]));
      return electron.listeners['llm:send']({ sender: sender() }, request, { thread, messages: [] });
    };

    it('takes a snapshot as each reply starts, and goes back to it when asked', async () => {
      mocks.sandbox.changes.snapshot.mockResolvedValue('tree-before');
      mocks.sandbox.readContext.mockResolvedValue('Goal: build the parser.');
      mocks.sandbox.changes.revert.mockResolvedValue(true);
      await start('r1');
      expect(mocks.sandbox.changes.snapshot).toHaveBeenCalledWith('thread-1');
      // The note the attempt is about to write over is taken with the files
      expect(mocks.sandbox.readContext).toHaveBeenCalledWith('thread-1');

      await expect(electron.handlers['thread:revert']({}, 'thread-1', 'r1')).resolves.toBe(true);
      expect(mocks.sandbox.changes.revert).toHaveBeenCalledWith('thread-1', 'tree-before');
      expect(mocks.sandbox.restoreContext).toHaveBeenCalledWith('thread-1', 'Goal: build the parser.');
    });

    // The note is where a reply keeps what it found and what it did, so an
    // attempt nobody kept has no standing to tell the next one either — even
    // where the files it wrote are being left alone
    it('puts the note back but leaves the files where they are when asked for the note alone', async () => {
      mocks.sandbox.changes.snapshot.mockResolvedValue('tree-before');
      mocks.sandbox.readContext.mockResolvedValue('Found the parser in src/a.ts.');
      await start('r1');
      await expect(electron.handlers['thread:revert']({}, 'thread-1', 'r1', { files: false })).resolves.toBe(false);
      expect(mocks.sandbox.restoreContext).toHaveBeenCalledWith('thread-1', 'Found the parser in src/a.ts.');
      expect(mocks.sandbox.changes.revert).not.toHaveBeenCalled();
    });

    // The snapshot held is of the thread's latest reply; a message answered
    // before that one is not the message it belongs to
    it('refuses an attempt that is not the one it holds the files for', async () => {
      mocks.sandbox.changes.snapshot.mockResolvedValue('tree-before');
      await start('r1');
      await start('r2');
      await expect(electron.handlers['thread:revert']({}, 'thread-1', 'r1')).resolves.toBe(false);
      expect(mocks.sandbox.changes.revert).not.toHaveBeenCalled();
    });

    it('goes back only once, so a second ask cannot undo the attempt after it', async () => {
      mocks.sandbox.changes.snapshot.mockResolvedValue('tree-before');
      mocks.sandbox.changes.revert.mockResolvedValue(true);
      await start('r1');
      await electron.handlers['thread:revert']({}, 'thread-1', 'r1');
      await expect(electron.handlers['thread:revert']({}, 'thread-1', 'r1')).resolves.toBe(false);
      expect(mocks.sandbox.changes.revert).toHaveBeenCalledTimes(1);
    });

    it('has nothing to go back to for a thread that never sent anything', async () => {
      await expect(electron.handlers['thread:revert']({}, 'thread-9', 'r1')).resolves.toBe(false);
      expect(mocks.sandbox.changes.revert).not.toHaveBeenCalled();
      expect(mocks.sandbox.restoreContext).not.toHaveBeenCalled();
    });

    // A turn that began before the thread had a container has no snapshot of
    // its own; the container's own record is where its files go back to
    it('passes on that there was no snapshot to take', async () => {
      mocks.sandbox.changes.snapshot.mockResolvedValue(null);
      mocks.sandbox.changes.revert.mockResolvedValue(true);
      await start('r1');
      await electron.handlers['thread:revert']({}, 'thread-1', 'r1');
      expect(mocks.sandbox.changes.revert).toHaveBeenCalledWith('thread-1', null);
    });
  });

  it("removes a deleted thread's container, its code index and what was said in it", () => {
    electron.listeners['thread:delete']({}, 'thread-1');
    expect(mocks.sandbox.remove).toHaveBeenCalledWith('thread-1');
    expect(mocks.search.forget).toHaveBeenCalledWith('thread-1');
    // ...and anything it handed out and never waited for
    expect(mocks.harness.subagents.forgetThread).toHaveBeenCalledWith('thread-1');
    // ...and the notes it had not written back to the workspace
    expect(mocks.harness.project.forgetThread).toHaveBeenCalledWith('thread-1');
    expect(mocks.harness.notes.forgetThread).toHaveBeenCalledWith('thread-1');
  });

  it('indexes the threads the window hands it, and says nothing when there is nothing to embed with', async () => {
    const pieces = [{ thread: 't1', title: 'Parsing', at: 0, request: 'how do I parse?', reply: 'With a parser.' }];
    await electron.handlers['threads:index']({}, pieces);
    expect(mocks.search.threads.index.mock.calls[0][0]).toBe(pieces);

    // No Ollama to embed with is ordinary: it is logged, not thrown at the window
    mocks.search.threads.index.mockRejectedValueOnce(new Error('No Ollama reachable.'));
    await expect(electron.handlers['threads:index']({}, pieces)).resolves.toBeUndefined();
    expect(mocks.log.warn).toHaveBeenCalledWith('threads.index', { ok: false, error: 'No Ollama reachable.' });
  });

  it('searches what was said in the threads', async () => {
    mocks.search.threads.search.mockResolvedValue([{ thread: 't1', score: 0.8 }]);
    await expect(electron.handlers['threads:search']({}, 'parser')).resolves.toEqual([{ thread: 't1', score: 0.8 }]);
    expect(mocks.search.threads.search.mock.calls[0][0]).toBe('parser');
  });
});

describe('ollama channels', () => {
  it('reports status for the configured local server', async () => {
    mocks.ollama.status.mockResolvedValue({ reachable: true });
    await expect(electron.handlers['ollama:status']()).resolves.toEqual({ reachable: true });
    expect(mocks.ollama.status).toHaveBeenCalledWith(saved.local);
  });

  it('downloads a model, forwarding progress and then completion', async () => {
    mocks.ollama.pull.mockImplementation(async (_config, _name, report) => {
      report({ status: 'pulling', percent: 50 });
    });
    const window = sender();
    await electron.listeners['ollama:pull']({ sender: window }, 'llama3.2:3b');

    expect(mocks.ollama.pull.mock.calls[0].slice(0, 2)).toEqual([saved.local, 'llama3.2:3b']);
    expect(window.send.mock.calls).toEqual([
      ['ollama:progress', { name: 'llama3.2:3b', status: 'pulling', percent: 50 }],
      ['ollama:progress', { name: 'llama3.2:3b', done: true }],
    ]);
  });

  it('reports a failed download', async () => {
    mocks.ollama.pull.mockRejectedValue(new Error('file does not exist'));
    const window = sender();
    await electron.listeners['ollama:pull']({ sender: window }, 'bogus');
    expect(window.send).toHaveBeenCalledWith('ollama:progress', {
      name: 'bogus',
      done: true,
      error: 'file does not exist',
    });
  });

  it('cancels a download and reports it as cancelled, not as an error message', async () => {
    mocks.ollama.pull.mockImplementation(
      (_config, _name, _report, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        })
    );
    const window = sender();
    const pulling = electron.listeners['ollama:pull']({ sender: window }, 'big-model');
    electron.listeners['ollama:cancel']({}, 'big-model');
    await pulling;
    expect(window.send).toHaveBeenCalledWith('ollama:progress', {
      name: 'big-model',
      done: true,
      error: 'Download cancelled.',
    });
  });

  it('ignores a second request for a model that is already downloading, then allows it again after', async () => {
    let release!: () => void;
    mocks.ollama.pull.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const event = { sender: sender() };

    const first = electron.listeners['ollama:pull'](event, 'm');
    await electron.listeners['ollama:pull'](event, 'm');
    expect(mocks.ollama.pull).toHaveBeenCalledTimes(1);

    release();
    await first;
    electron.listeners['ollama:pull'](event, 'm');
    expect(mocks.ollama.pull).toHaveBeenCalledTimes(2);
  });

  it('does not send progress to a window that has closed', async () => {
    mocks.ollama.pull.mockResolvedValue(undefined);
    const window = sender();
    window.isDestroyed.mockReturnValue(true);
    await electron.listeners['ollama:pull']({ sender: window }, 'm');
    expect(window.send).not.toHaveBeenCalled();
  });
});

describe('getting the app ready to use', () => {
  it('reports what is set up and what is not, asked afresh every time', async () => {
    const status = { local: { models: 2 }, keys: { anthropic: true, openai: false } };
    mocks.setup.status.mockResolvedValue(status);
    await expect(electron.handlers['setup:status']({})).resolves.toBe(status);
  });

  it('installs Docker, sending the installer’s own output to the window that asked', () => {
    const window = sender();
    electron.listeners['setup:install-docker']({ sender: window });
    const report = mocks.setup.installDocker.mock.calls[0][0];
    report({ line: '[docker] Docker was not found. Installing it...' });
    report({ done: true, ok: true });
    expect(window.send.mock.calls).toEqual([
      ['setup:progress', { line: '[docker] Docker was not found. Installing it...' }],
      ['setup:progress', { done: true, ok: true }],
    ]);
  });

  it('says nothing to a window that has closed while the installer ran', () => {
    const window = sender();
    window.isDestroyed.mockReturnValue(true);
    electron.listeners['setup:install-docker']({ sender: window });
    mocks.setup.installDocker.mock.calls[0][0]({ line: 'anything' });
    expect(window.send).not.toHaveBeenCalled();
  });

  it('gives up on an install, and opens what it cannot install itself in a browser', () => {
    electron.listeners['setup:cancel']({});
    expect(mocks.setup.cancel).toHaveBeenCalled();
    electron.listeners['setup:download']({}, 'ollama');
    expect(mocks.setup.download).toHaveBeenCalledWith('ollama');
  });
});

describe('the app’s menu, which holds the Offline switch', () => {
  // The switch as the menu offers it, and the state it was built with
  const put = () => menu.install.mock.calls.at(-1)![0];
  const throwIt = (on: boolean) => put().onOffline(on);

  it('is put up before the window, so the default menu is never seen', () => {
    expect(menu.install.mock.calls[0][0]).toMatchObject({ name: 'ch', offline: false });
    expect(menu.install.mock.invocationCallOrder[0]).toBeLessThan(
      electron.windows[0].loadFile.mock.invocationCallOrder[0]
    );
  });

  // Finding out what there is to switch between means asking Ollama and
  // Docker, which takes long enough that the menu would otherwise be the last
  // thing to go up. It goes up without them and is put up again when the
  // answer arrives: a switch that becomes usable reads better than one that
  // was offered and did nothing.
  it('greys the switches out until it knows what there is to switch between', () => {
    expect(menu.install.mock.calls[0][0]).toMatchObject({ offlineEnabled: false, fastEnabled: false });
    expect(put()).toMatchObject({ offlineEnabled: true, fastEnabled: false });
  });

  it('offers Fast once a hosted key is there to prefer', async () => {
    mocks.setup.status.mockResolvedValue({ local: { models: 0 }, keys: { anthropic: true, openai: false } });
    await electron.handlers['setup:status']({});
    expect(put()).toMatchObject({ offlineEnabled: false, fastEnabled: true });
  });

  // A switch that is on can always be turned off, whatever is available: it is
  // the way out of an Offline Mode whose last local model has gone
  it('leaves a switch that is on usable, so there is a way back', async () => {
    mocks.settings.get.mockReturnValue({ ...saved, offline: true, fast: true });
    mocks.setup.status.mockResolvedValue({ local: { models: 0 }, keys: { anthropic: false, openai: false } });
    await electron.handlers['setup:status']({});
    expect(put()).toMatchObject({ offlineEnabled: true, fastEnabled: true });
  });

  it('shows the switch as the settings have it', async () => {
    mocks.settings.get.mockReturnValue({ ...saved, offline: true });
    vi.resetModules();
    menu.install.mockClear();
    await import('../src/main');
    await electron.ready;
    expect(put().offline).toBe(true);
  });

  it('saves the switch, reconfigures the providers, and tells every window', () => {
    const updated = { ...saved, offline: true };
    mocks.settings.update.mockReturnValue(updated);
    mocks.llm.configure.mockClear();

    throwIt(true);
    expect(mocks.settings.update).toHaveBeenCalledWith({ offline: true });
    expect(mocks.llm.configure).toHaveBeenCalledWith(updated);
    expect(electron.windows[0].webContents.send).toHaveBeenCalledWith('settings:changed', { public: true });
    expect(mocks.log.info).toHaveBeenCalledWith('settings.offline', { offline: true });
  });

  it('puts the menu up again afterwards, with the tick the setting ended up at', () => {
    mocks.settings.update.mockImplementation(() => {
      mocks.settings.get.mockReturnValue({ ...saved, offline: true });
      return { ...saved, offline: true };
    });
    throwIt(true);
    expect(put().offline).toBe(true);
  });

  it('says why when the switch could not be saved, and leaves the tick where it was', () => {
    mocks.settings.update.mockImplementation(() => {
      throw new Error('Encryption is not available');
    });
    mocks.llm.configure.mockClear();

    throwIt(true);
    expect(electron.showErrorBox).toHaveBeenCalledWith('ch', 'Encryption is not available');
    expect(mocks.llm.configure).not.toHaveBeenCalled();
    expect(electron.windows[0].webContents.send).not.toHaveBeenCalledWith('settings:changed', expect.anything());
    // The setting never changed, so neither does the menu
    expect(put().offline).toBe(false);
  });

  it('is put up again after the window saves settings, in case that was the switch', () => {
    mocks.settings.update.mockReturnValue({ ...saved, offline: true });
    mocks.settings.get.mockReturnValue({ ...saved, offline: true });
    menu.install.mockClear();
    electron.handlers['settings:save']({}, { offline: true });
    expect(put().offline).toBe(true);
  });
});

describe('settings channels', () => {
  it('returns only the public view', () => {
    expect(electron.handlers['settings:get']()).toEqual({ public: true });
  });

  it('saves a patch, reconfigures the providers with the result, and returns the public view', () => {
    const updated = { updated: true, sandbox: { image: 'node:22-bookworm-slim' } };
    mocks.settings.update.mockReturnValue(updated);
    mocks.llm.configure.mockClear();

    const patch = { anthropic: { apiKey: 'k' } };
    expect(electron.handlers['settings:save']({}, patch)).toEqual({ public: true });
    expect(mocks.settings.update).toHaveBeenCalledWith(patch);
    expect(mocks.llm.configure).toHaveBeenCalledWith(updated);
    // ...and the sandbox hears which image to build a container from
    expect(mocks.sandbox.configure).toHaveBeenCalledWith('node:22-bookworm-slim');
  });

  it('does not reconfigure anything when saving fails', () => {
    mocks.settings.update.mockImplementation(() => {
      throw new Error('Encryption is not available');
    });
    mocks.llm.configure.mockClear();
    expect(() => electron.handlers['settings:save']({}, {})).toThrow('Encryption is not available');
    expect(mocks.llm.configure).not.toHaveBeenCalled();
  });
});
