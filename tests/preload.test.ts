import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmBridge, OllamaBridge, SettingsBridge, SetupBridge, ThreadsBridge } from '../src/types';

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, any>,
  listeners: {} as Record<string, (...args: any[]) => void>,
  invoke: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed[name] = api;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    sendSync: electron.sendSync,
    on: (channel: string, listener: (...args: any[]) => void) => {
      electron.listeners[channel] = listener;
    },
  },
}));

import '../src/preload';

const llm = () => electron.exposed.llm as LlmBridge;
const threads = () => electron.exposed.threads as ThreadsBridge;
const ollama = () => electron.exposed.ollamaApi as OllamaBridge;
const settings = () => electron.exposed.settingsApi as SettingsBridge;
const setup = () => electron.exposed.setupApi as SetupBridge;

beforeEach(() => {
  electron.invoke.mockReset();
  electron.send.mockReset();
  electron.sendSync.mockReset();
});

describe('preload', () => {
  it('exposes exactly the six bridges, under names that avoid the renderer globals', () => {
    expect(Object.keys(electron.exposed).sort()).toEqual([
      'host',
      'llm',
      'ollamaApi',
      'settingsApi',
      'setupApi',
      'threads',
    ]);
  });

  it('tells the page which computer it is drawn on, for the bar it draws itself', () => {
    expect((electron.exposed.host as { platform: string }).platform).toBe(process.platform);
  });

  it('asks the main process to bring the window forward', () => {
    (electron.exposed.host as { show(): void }).show();
    expect(electron.send).toHaveBeenCalledWith('host:show');
  });

  it('asks what is set up, and for Docker to be installed, cancelled or downloaded', async () => {
    electron.invoke.mockResolvedValue({ canAnswer: true });
    await expect(setup().status()).resolves.toEqual({ canAnswer: true });
    expect(electron.invoke).toHaveBeenCalledWith('setup:status');

    setup().installDocker();
    expect(electron.send).toHaveBeenCalledWith('setup:install-docker');
    setup().cancel();
    expect(electron.send).toHaveBeenCalledWith('setup:cancel');
    setup().download('ollama');
    expect(electron.send).toHaveBeenLastCalledWith('setup:download', 'ollama');
  });

  it('passes on how an install is going', () => {
    const heard: unknown[] = [];
    setup().onProgress((progress) => heard.push(progress));
    electron.listeners['setup:progress']({}, { line: '[docker] installing' });
    expect(heard).toEqual([{ line: '[docker] installing' }]);
  });

  it('does not expose ipcRenderer itself', () => {
    const exposedFunctions = Object.values(electron.exposed).flatMap((api) => Object.values(api));
    expect(exposedFunctions).not.toContain(electron.invoke);
    expect(exposedFunctions).not.toContain(electron.send);
  });

  it("asks for a thread's changes, and for them to be written to its workspace", async () => {
    electron.invoke.mockResolvedValue({ files: [] });
    await expect(threads().changes('t1')).resolves.toEqual({ files: [] });
    expect(electron.invoke).toHaveBeenCalledWith('thread:changes', 't1');
    await threads().applyChanges('t1', '/projects/demo');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:apply-changes', 't1', '/projects/demo');
  });

  it("asks for a workspace's branches, and for a worktree on one of them", async () => {
    electron.invoke.mockResolvedValue({ current: 'main', names: ['main'] });
    await expect(threads().branches('/projects/demo')).resolves.toEqual({ current: 'main', names: ['main'] });
    expect(electron.invoke).toHaveBeenCalledWith('thread:branches', '/projects/demo');
    electron.invoke.mockResolvedValue('/worktrees/demo-feature');
    await expect(threads().prepareBranch('/projects/demo', 'feature', 'main', true)).resolves.toBe(
      '/worktrees/demo-feature'
    );
    expect(electron.invoke).toHaveBeenLastCalledWith(
      'thread:prepare-branch',
      '/projects/demo',
      'feature',
      'main',
      true
    );
  });

  it("asks how a branch's worktree stands, and to commit, push, pull and remove it", async () => {
    electron.invoke.mockResolvedValue({ upstream: null, ahead: 0, behind: 0, dirty: true });
    await expect(threads().branchStatus('/worktrees/feature')).resolves.toMatchObject({ dirty: true });
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:branch-status', '/worktrees/feature');

    await threads().commitBranch('/worktrees/feature', 'Add a');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:branch-commit', '/worktrees/feature', 'Add a');
    await threads().pushBranch('/worktrees/feature');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:branch-push', '/worktrees/feature');
    await threads().pullBranch('/worktrees/feature');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:branch-pull', '/worktrees/feature');
    await threads().removeWorktree('/projects/demo', '/worktrees/feature');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:remove-worktree', '/projects/demo', '/worktrees/feature');
  });

  it('asks what a workspace and a thread are keeping', async () => {
    electron.invoke.mockResolvedValue({ note: 'A parser.', writtenAt: null, surveying: false });
    await expect(threads().workspace('/projects/demo')).resolves.toMatchObject({ note: 'A parser.' });
    expect(electron.invoke).toHaveBeenCalledWith('workspace:details', '/projects/demo');

    electron.invoke.mockResolvedValue({ context: '', note: '', shared: '' });
    await threads().details('t1', '/projects/demo');
    expect(electron.invoke).toHaveBeenLastCalledWith('thread:details', 't1', '/projects/demo');

    electron.invoke.mockResolvedValue('A fresh note.');
    await expect(threads().relook('/projects/demo', 't1')).resolves.toBe('A fresh note.');
    expect(electron.invoke).toHaveBeenLastCalledWith('workspace:relook', '/projects/demo', 't1');
  });

  it('loads the saved threads and saves them, waiting for the save only when asked to', () => {
    electron.sendSync.mockReturnValue('{"threads":[]}');
    expect(threads().load()).toBe('{"threads":[]}');
    expect(electron.sendSync).toHaveBeenCalledWith('threads:load');

    threads().save('{"a":1}');
    expect(electron.send).toHaveBeenCalledWith('threads:save', '{"a":1}');
    threads().saveNow('{"a":2}');
    expect(electron.sendSync).toHaveBeenLastCalledWith('threads:save', '{"a":2}');
  });

  it('routes llm calls to their channels', async () => {
    electron.invoke.mockResolvedValue({ models: [], providers: [] });
    await expect(llm().listModels({ includeDisabled: true })).resolves.toEqual({ models: [], providers: [] });
    expect(electron.invoke).toHaveBeenCalledWith('llm:models', { includeDisabled: true });

    const request = { thread: 't', messages: [] };
    llm().send('r1', request);
    llm().cancel('r1');
    llm().allowFileAccess('ask-1', 'once');
    llm().approve('r1', true);
    llm().answer('r1', 'the second one');
    expect(electron.send.mock.calls).toEqual([
      ['llm:send', 'r1', request],
      ['llm:cancel', 'r1'],
      ['llm:allow-file-access', 'ask-1', 'once'],
      ['llm:approve', 'r1', true],
      ['llm:answer', 'r1', 'the second one'],
    ]);
  });

  it('asks the main process for a summary of a conversation', async () => {
    electron.invoke.mockResolvedValue('The summary.');
    const request = { messages: [{ role: 'user' as const, content: 'hi' }] };
    await expect(llm().summarize(request)).resolves.toBe('The summary.');
    expect(electron.invoke).toHaveBeenCalledWith('llm:summarize', request);
  });

  it('asks for a description of a thread', async () => {
    electron.invoke.mockResolvedValue({ text: 'Parsing JSON' });
    const request = { requests: ['How do I parse JSON?'] };
    await expect(llm().describe(request)).resolves.toEqual({ text: 'Parsing JSON' });
    expect(electron.invoke).toHaveBeenCalledWith('llm:describe', request);
  });

  it('asks for a suggestion of what to say next', async () => {
    electron.invoke.mockResolvedValue({ text: 'Yes, add one' });
    const request = { messages: [{ role: 'assistant' as const, content: 'Add a test?' }] };
    await expect(llm().suggest(request)).resolves.toEqual({ text: 'Yes, add one' });
    expect(electron.invoke).toHaveBeenCalledWith('llm:suggest', request);
  });

  it('asks for the changes of a reply to be checked', async () => {
    const verdict = { passed: false, problems: '- It forgot the tests.', model: 'Opus' };
    electron.invoke.mockResolvedValue(verdict);
    const request = { thread: 't', request: 'Add a flag', output: 'Done.', provider: 'ollama', model: 'm' };
    await expect(llm().verify(request)).resolves.toEqual(verdict);
    expect(electron.invoke).toHaveBeenCalledWith('llm:verify', request);
  });

  it("sends the user's verdict on a classification", () => {
    const verdict = { rating: 'good', request: 'Hi', thread: 't' };
    llm().feedback(verdict as never);
    expect(electron.send).toHaveBeenCalledWith('llm:feedback', verdict);
  });

  it('asks for one failed subagent to be run again, and delivers its work as it arrives', async () => {
    electron.invoke.mockResolvedValue({ text: 'They use vitest.', isError: false });
    const asked = { thread: 't', id: 's1', name: 'tests', task: 'read the tests', kind: 'worker' };
    await expect(llm().retrySubagent(asked)).resolves.toEqual({ text: 'They use vitest.', isError: false });
    expect(electron.invoke).toHaveBeenCalledWith('llm:retry-subagent', asked);

    const callback = vi.fn();
    llm().onSubagentEvent(callback);
    electron.listeners['llm:subagent-event']({ sender: 'ipc internals' }, 't', 's1', { type: 'condensing' });
    expect(callback).toHaveBeenCalledWith('t', 's1', { type: 'condensing' });
  });

  it('hands the threads over to be indexed, and asks what was said in them', async () => {
    const pieces = [{ thread: 't1', title: 'Containers', at: 0, request: 'why?', reply: 'because.' }];
    electron.invoke.mockResolvedValue(undefined);
    await threads().index(pieces);
    expect(electron.invoke).toHaveBeenCalledWith('threads:index', pieces);

    electron.invoke.mockResolvedValue([{ thread: 't1', score: 0.8 }]);
    await expect(threads().search('docker')).resolves.toEqual([{ thread: 't1', score: 0.8 }]);
    expect(electron.invoke).toHaveBeenCalledWith('threads:search', 'docker');
  });

  it("searches a workspace's detailed notes, which the dialog reads the same way a model does", async () => {
    electron.invoke.mockResolvedValue([{ subject: 'The docker image', content: 'One per toolchain.', files: [] }]);
    await expect(threads().searchNotes('/projects/demo', 'docker')).resolves.toEqual([
      { subject: 'The docker image', content: 'One per toolchain.', files: [] },
    ]);
    expect(electron.invoke).toHaveBeenCalledWith('workspace:search-notes', '/projects/demo', 'docker');
  });

  it('throws one of those notes away, by what it is about and whose it still is', async () => {
    electron.invoke.mockResolvedValue(true);
    await expect(threads().forgetNote('/projects/demo', 'The docker image', 't1')).resolves.toBe(true);
    expect(electron.invoke).toHaveBeenCalledWith('workspace:forget-note', '/projects/demo', 'The docker image', 't1');
  });

  it('delivers a setting changed from the app’s menu, without the IPC event object', () => {
    const callback = vi.fn();
    settings().onChanged(callback);
    electron.listeners['settings:changed']({ sender: 'ipc internals' }, { offline: true });
    expect(callback).toHaveBeenCalledWith({ offline: true });
  });

  it('delivers harness events without the IPC event object', () => {
    const callback = vi.fn();
    llm().onEvent(callback);
    electron.listeners['llm:event']({ sender: 'ipc internals' }, 'r1', { type: 'text', delta: 'hi' });
    expect(callback).toHaveBeenCalledWith('r1', { type: 'text', delta: 'hi' });
  });

  it('asks the main process to choose a workspace for a new thread', async () => {
    electron.invoke.mockResolvedValue('/projects/demo');
    await expect(threads().chooseWorkspace()).resolves.toBe('/projects/demo');
    expect(electron.invoke).toHaveBeenCalledWith('thread:choose-workspace');
  });

  it('routes thread opening and deletion', () => {
    threads().open('thread-1', '/projects/demo');
    threads().remove('thread-1');
    expect(electron.send.mock.calls).toEqual([
      ['thread:open', 'thread-1', '/projects/demo'],
      ['thread:delete', 'thread-1'],
    ]);
  });

  it('routes Ollama calls and progress', async () => {
    electron.invoke.mockResolvedValue({ reachable: true });
    await expect(ollama().status()).resolves.toEqual({ reachable: true });
    expect(electron.invoke).toHaveBeenCalledWith('ollama:status');

    ollama().pull('llama3.2:3b');
    ollama().cancel('llama3.2:3b');
    expect(electron.send.mock.calls).toEqual([
      ['ollama:pull', 'llama3.2:3b'],
      ['ollama:cancel', 'llama3.2:3b'],
    ]);

    const callback = vi.fn();
    ollama().onProgress(callback);
    electron.listeners['ollama:progress']({}, { name: 'llama3.2:3b', percent: 40 });
    expect(callback).toHaveBeenCalledWith({ name: 'llama3.2:3b', percent: 40 });
  });

  it('routes settings calls', async () => {
    electron.invoke.mockResolvedValue({ saved: true });
    await settings().get();
    await expect(settings().save({ anthropic: { apiKey: 'k' } })).resolves.toEqual({ saved: true });
    expect(electron.invoke.mock.calls).toEqual([['settings:get'], ['settings:save', { anthropic: { apiKey: 'k' } }]]);
  });
});
