// Encrypted settings store: API keys and user configuration.
//
// The whole file is encrypted with Electron's safeStorage, which uses a key
// held by the OS (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
// Only usable after the app's 'ready' event.

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import * as log from './log';
import type { PublicSettings, ReadableSettings, Settings, SettingsPatch, SetupSettings } from './types';

export const THEME_VARS = [
  '--bg',
  '--panel',
  '--border',
  '--text',
  '--muted',
  '--accent',
  '--bubble',
  '--asked-by-app',
];

const defaultLocalURL = () => process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1';

function defaults(): Settings {
  return {
    anthropic: { apiKey: '', disabledModels: [] },
    openai: { apiKey: '', disabledModels: [] },
    // Any OpenAI-compatible server: Ollama (default), llama.cpp server, LM Studio, ...
    local: { baseURL: defaultLocalURL(), apiKey: '' },
    sophistication: {},
    // '' lets each workspace decide from its own files (see sandbox/docker.ts)
    sandbox: { image: '' },
    // Hosted models are on offer until the user says otherwise
    offline: false,
    // Local models are preferred until the user asks for speed
    fast: false,
    // Whether a reply that changed files is reviewed by a model as soon as it
    // is over
    autoReview: false,
    // Every model is used without asking until the user lowers the ceiling
    approvalCeiling: 5,
    theme: {},
    // Reading anything on the user's computer is asked about until they allow it
    readable: { global: [], workspaces: {} },
    // Nobody has been led through installing anything yet (see setup/checks.ts)
    setup: { completed: false, version: 0, skipped: [] },
  };
}

export function cleanSetup(value: unknown): SetupSettings {
  const saved = (typeof value === 'object' && value !== null ? value : {}) as Partial<SetupSettings>;
  return {
    completed: saved.completed === true,
    version: Number.isInteger(saved.version) && (saved.version as number) >= 0 ? (saved.version as number) : 0,
    skipped: Array.isArray(saved.skipped) ? saved.skipped.filter((id): id is string => typeof id === 'string') : [],
  };
}

const cleanPaths = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)))]
    : [];

export function cleanReadable(value: unknown): ReadableSettings {
  const saved = (typeof value === 'object' && value !== null ? value : {}) as Partial<ReadableSettings>;
  const workspaces: Record<string, string[]> = {};
  const given = saved.workspaces;
  if (typeof given === 'object' && given !== null && !Array.isArray(given)) {
    for (const [workspace, paths] of Object.entries(given)) {
      const clean = cleanPaths(paths);
      if (clean.length > 0) workspaces[workspace] = clean;
    }
  }
  return { global: cleanPaths(saved.global), workspaces };
}

export function cleanTheme(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  const hexPattern = /^#[0-9a-f]{6}$/i;
  for (const [key, val] of Object.entries(value)) {
    if (THEME_VARS.includes(key) && typeof val === 'string' && hexPattern.test(val)) {
      result[key] = val;
    }
  }
  return result;
}

const isLevel = (level: unknown): level is number =>
  typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 5;

let settings = defaults();

const filePath = () => path.join(app.getPath('userData'), 'settings.enc');

export function load(): Settings {
  settings = defaults();
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(filePath());
  } catch {
    return settings; // nothing saved yet
  }
  try {
    const saved = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<Settings>;
    const base = defaults();
    settings = {
      anthropic: { ...base.anthropic, ...saved.anthropic },
      openai: { ...base.openai, ...saved.openai },
      local: { ...base.local, ...saved.local },
      sophistication: { ...saved.sophistication },
      sandbox: { ...base.sandbox, ...saved.sandbox },
      offline: saved.offline === true,
      fast: saved.fast === true,
      autoReview: saved.autoReview === true,
      approvalCeiling: isLevel(saved.approvalCeiling) ? saved.approvalCeiling : 5,
      theme: cleanTheme(saved.theme),
      readable: cleanReadable(saved.readable),
      setup: cleanSetup(saved.setup),
    };
  } catch (err) {
    console.error(`Could not read ${filePath()}; using default settings.`, (err as Error).message);
    log.error('settings.load', { ok: false, error: (err as Error).message });
  }
  return settings;
}

function save(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption is not available on this system, so settings were not saved.');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(settings));
  fs.writeFileSync(filePath(), encrypted, { mode: 0o600 });
}

export function get(): Settings {
  return settings;
}

// Applies a partial update and saves it. For API keys: a string sets the key,
// null removes it, and leaving it out keeps the current one.
export function update(patch: SettingsPatch): Settings {
  const next = structuredClone(settings);

  for (const provider of ['anthropic', 'openai', 'local'] as const) {
    const apiKey = patch[provider]?.apiKey;
    if (apiKey !== undefined) next[provider].apiKey = (apiKey ?? '').trim();
  }
  for (const provider of ['anthropic', 'openai'] as const) {
    const disabled = patch[provider]?.disabledModels;
    if (Array.isArray(disabled)) {
      next[provider].disabledModels = disabled.filter((id) => typeof id === 'string');
    }
  }
  if (patch.local?.baseURL !== undefined) {
    next.local.baseURL = patch.local.baseURL.trim() || defaultLocalURL();
  }
  if (patch.sandbox?.image !== undefined) next.sandbox.image = patch.sandbox.image.trim();
  if (patch.offline !== undefined) next.offline = patch.offline === true;
  if (patch.fast !== undefined) next.fast = patch.fast === true;
  if (patch.autoReview !== undefined) next.autoReview = patch.autoReview === true;
  if (isLevel(patch.approvalCeiling)) next.approvalCeiling = patch.approvalCeiling;
  if (patch.sophistication) {
    next.sophistication = {};
    for (const [model, level] of Object.entries(patch.sophistication)) {
      if (Number.isInteger(level) && level >= 0 && level <= 5) next.sophistication[model] = level;
    }
  }
  if (patch.theme !== undefined) next.theme = cleanTheme(patch.theme);
  // The flow reports what it got through rather than replacing the record, so
  // a step that says it is done doesn't forget what an earlier one skipped
  if (patch.setup) next.setup = cleanSetup({ ...next.setup, ...patch.setup });

  const previous = settings;
  settings = next;
  try {
    save();
  } catch (err) {
    settings = previous;
    throw err;
  }
  return settings;
}

// What the model may read on the user's computer in a workspace without asking:
// the global list and the workspace's own
export function readable(workspace?: string): string[] {
  const { global, workspaces } = settings.readable;
  return [...global, ...(workspace ? (workspaces[workspace] ?? []) : [])];
}

// Remembers a file or folder as readable in one workspace. The model never
// names a workspace or a path here: both come from the question the user said
// yes to (see harness/access.ts).
export function allowRead(workspace: string, entry: string): void {
  if (!path.isAbsolute(entry) || readable(workspace).includes(entry)) return;
  const next = structuredClone(settings);
  next.readable.workspaces[workspace] = [...(next.readable.workspaces[workspace] ?? []), entry];
  const previous = settings;
  settings = next;
  try {
    save();
  } catch (err) {
    settings = previous;
    throw err;
  }
}

export function publicView(): PublicSettings {
  return {
    anthropic: {
      hasKey: Boolean(settings.anthropic.apiKey),
      disabledModels: settings.anthropic.disabledModels,
    },
    openai: {
      hasKey: Boolean(settings.openai.apiKey),
      disabledModels: settings.openai.disabledModels,
    },
    local: { baseURL: settings.local.baseURL, hasKey: Boolean(settings.local.apiKey) },
    sophistication: settings.sophistication,
    sandbox: settings.sandbox,
    offline: settings.offline,
    fast: settings.fast,
    autoReview: settings.autoReview,
    approvalCeiling: settings.approvalCeiling,
    theme: settings.theme,
    setup: settings.setup,
  };
}
