import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostBridge,
  Installable,
  LlmBridge,
  OllamaBridge,
  SettingsBridge,
  SetupBridge,
  ThreadsBridge,
} from './types';

const llm: LlmBridge = {
  listModels: (options) => ipcRenderer.invoke('llm:models', options),
  send: (requestId, request) => ipcRenderer.send('llm:send', requestId, request),
  summarize: (request) => ipcRenderer.invoke('llm:summarize', request),
  describe: (request) => ipcRenderer.invoke('llm:describe', request),
  suggest: (request) => ipcRenderer.invoke('llm:suggest', request),
  verify: (request) => ipcRenderer.invoke('llm:verify', request),
  feedback: (feedback) => ipcRenderer.send('llm:feedback', feedback),
  cancel: (requestId) => ipcRenderer.send('llm:cancel', requestId),
  allowFileAccess: (id, answer) => ipcRenderer.send('llm:allow-file-access', id, answer),
  allowCommand: (id, allowed) => ipcRenderer.send('llm:allow-command', id, allowed),
  approve: (requestId, approved) => ipcRenderer.send('llm:approve', requestId, approved),
  answer: (requestId, answer) => ipcRenderer.send('llm:answer', requestId, answer),
  onEvent: (callback) => {
    ipcRenderer.on('llm:event', (_event, requestId, event) => callback(requestId, event));
  },
  retrySubagent: (request) => ipcRenderer.invoke('llm:retry-subagent', request),
  onSubagentEvent: (callback) => {
    ipcRenderer.on('llm:subagent-event', (_event, threadId, id, event) => callback(threadId, id, event));
  },
};

const threads: ThreadsBridge = {
  chooseWorkspace: () => ipcRenderer.invoke('thread:choose-workspace'),
  open: (threadId, workspace) => ipcRenderer.send('thread:open', threadId, workspace),
  branches: (workspace) => ipcRenderer.invoke('thread:branches', workspace),
  prepareBranch: (workspace, branch, base, create) =>
    ipcRenderer.invoke('thread:prepare-branch', workspace, branch, base, create),
  branchStatus: (worktree) => ipcRenderer.invoke('thread:branch-status', worktree),
  commitBranch: (worktree, message) => ipcRenderer.invoke('thread:branch-commit', worktree, message),
  pushBranch: (worktree) => ipcRenderer.invoke('thread:branch-push', worktree),
  pullBranch: (worktree) => ipcRenderer.invoke('thread:branch-pull', worktree),
  removeWorktree: (workspace, worktree) => ipcRenderer.invoke('thread:remove-worktree', workspace, worktree),
  remove: (threadId) => ipcRenderer.send('thread:delete', threadId),
  changes: (threadId) => ipcRenderer.invoke('thread:changes', threadId),
  applyChanges: (threadId, workspace) => ipcRenderer.invoke('thread:apply-changes', threadId, workspace),
  revert: (threadId, request, options) => ipcRenderer.invoke('thread:revert', threadId, request, options),
  discardChanges: (threadId) => ipcRenderer.invoke('thread:discard-changes', threadId),
  load: () => ipcRenderer.sendSync('threads:load'),
  save: (state) => ipcRenderer.send('threads:save', state),
  saveNow: (state) => {
    ipcRenderer.sendSync('threads:save', state);
  },
  // Sync, as saveNow, so the bytes are on disk by the time the window is gone
  // (see beforeunload in renderer/threads.ts)
  saveMedia: (items) => {
    ipcRenderer.sendSync('threads:save-media', items);
  },
  loadMedia: () => ipcRenderer.sendSync('threads:load-media'),
  workspace: (workspace) => ipcRenderer.invoke('workspace:details', workspace),
  workspaceFile: (workspace, relPath, from, to) =>
    ipcRenderer.invoke('workspace:file', workspace, relPath, from, to),
  details: (threadId, workspace) => ipcRenderer.invoke('thread:details', threadId, workspace),
  relook: (workspace, threadId) => ipcRenderer.invoke('workspace:relook', workspace, threadId),
  looking: () => ipcRenderer.invoke('workspaces:looking'),
  onLooking: (callback) => {
    ipcRenderer.on('project:looking', (_event, workspace, going, task) => callback(workspace, going, task));
  },
  onLookEvent: (callback) => {
    ipcRenderer.on('project:look-event', (_event, workspace, event) => callback(workspace, event));
  },
  onSurveyed: (callback) => {
    ipcRenderer.on('project:surveyed', (_event, workspace, note) => callback(workspace, note));
  },
  index: (pieces) => ipcRenderer.invoke('threads:index', pieces),
  search: (query) => ipcRenderer.invoke('threads:search', query),
  searchNotes: (workspace, query) => ipcRenderer.invoke('workspace:search-notes', workspace, query),
  forgetNote: (workspace, subject, threadId) =>
    ipcRenderer.invoke('workspace:forget-note', workspace, subject, threadId),
};

const ollama: OllamaBridge = {
  status: () => ipcRenderer.invoke('ollama:status'),
  pull: (name) => ipcRenderer.send('ollama:pull', name),
  cancel: (name) => ipcRenderer.send('ollama:cancel', name),
  onProgress: (callback) => {
    ipcRenderer.on('ollama:progress', (_event, progress) => callback(progress));
  },
};

const setup: SetupBridge = {
  status: () => ipcRenderer.invoke('setup:status'),
  installDocker: () => ipcRenderer.send('setup:install-docker'),
  cancel: () => ipcRenderer.send('setup:cancel'),
  download: (what: Installable) => ipcRenderer.send('setup:download', what),
  onProgress: (callback) => {
    ipcRenderer.on('setup:progress', (_event, progress) => callback(progress));
  },
};

const settings: SettingsBridge = {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  onChanged: (callback) => {
    ipcRenderer.on('settings:changed', (_event, updated) => callback(updated));
  },
};

// Where the page is drawn, which its own top bar is laid out around
const host: HostBridge = {
  platform: process.platform,
  show: () => ipcRenderer.send('host:show'),
  badge: (count) => ipcRenderer.send('host:badge', count),
};

// The Api suffix keeps these clear of the renderer's own `ollama` and
// `settings` variables, which share the page's global scope
contextBridge.exposeInMainWorld('host', host);
contextBridge.exposeInMainWorld('llm', llm);
contextBridge.exposeInMainWorld('threads', threads);
contextBridge.exposeInMainWorld('ollamaApi', ollama);
contextBridge.exposeInMainWorld('setupApi', setup);
contextBridge.exposeInMainWorld('settingsApi', settings);
