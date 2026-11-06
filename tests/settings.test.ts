import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Electron is replaced: a temp workspace for user data and a reversible stand-in
// for the OS-backed encryption, so nothing touches the real keychain.
const electron = vi.hoisted(() => ({
  userData: '',
  encryptionAvailable: true,
  setUsePlainTextEncryption: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.encryptionAvailable,
    setUsePlainTextEncryption: electron.setUsePlainTextEncryption,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decryptString: (data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this machine');
      return Buffer.from(text.slice(4), 'base64').toString();
    },
  },
}));

let settings: typeof import('../src/settings');
const file = () => path.join(electron.userData, 'settings.enc');

// A fresh copy of the module, as after an app restart
async function restart() {
  vi.resetModules();
  settings = await import('../src/settings');
  return settings.load();
}

beforeEach(async () => {
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-settings-'));
  electron.encryptionAvailable = true;
  electron.setUsePlainTextEncryption.mockClear();
  vi.stubEnv('LOCAL_LLM_BASE_URL', '');
  vi.stubEnv('CH_TEST_MODE', '');
  vi.stubEnv('CH_TEST_SETTINGS', '');
  await restart();
});

afterEach(() => {
  fs.rmSync(electron.userData, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// The app run to be tested, in a thread's container against the stand-in for Ollama (see ../src/scripts/fake-ollama.ts)
describe('test mode', () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('starts past setup and offline, so the app opens on itself and nothing reaches a hosted model', async () => {
    vi.stubEnv('CH_TEST_MODE', '1');
    vi.stubEnv('LOCAL_LLM_BASE_URL', 'http://localhost:11500/v1');
    const loaded = await restart();
    expect(loaded.offline).toBe(true);
    expect(loaded.setup.completed).toBe(true);
    expect(loaded.setup.version).toBeGreaterThan(1000);
    expect(loaded.local.baseURL).toBe('http://localhost:11500/v1');
  });

  it('takes CH_TEST_SETTINGS as what was saved, keeping its own defaults for what that leaves out', async () => {
    vi.stubEnv('CH_TEST_MODE', '1');
    vi.stubEnv('CH_TEST_SETTINGS', JSON.stringify({ autoReview: true, approvalCeiling: 2 }));
    const loaded = await restart();
    expect(loaded).toMatchObject({ autoReview: true, approvalCeiling: 2, offline: true, setup: { completed: true } });
  });

  it('reads what was saved over CH_TEST_SETTINGS, once something has been', async () => {
    vi.stubEnv('CH_TEST_MODE', '1');
    vi.stubEnv('CH_TEST_SETTINGS', JSON.stringify({ fast: false }));
    await restart();
    settings.update({ fast: true });
    expect((await restart()).fast).toBe(true);
  });

  it("saves with Electron's own key on Linux, where a container has no keyring, and only in test mode", async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await restart();
    expect(electron.setUsePlainTextEncryption).not.toHaveBeenCalled();
    vi.stubEnv('CH_TEST_MODE', '1');
    await restart();
    expect(electron.setUsePlainTextEncryption).toHaveBeenCalledWith(true);
  });

  it('ignores CH_TEST_SETTINGS outside test mode', async () => {
    vi.stubEnv('CH_TEST_SETTINGS', JSON.stringify({ offline: true }));
    expect((await restart()).offline).toBe(false);
  });
});

describe('defaults', () => {
  it('starts with no keys, nothing disabled, and Ollama as the local server', () => {
    expect(settings.get()).toEqual({
      anthropic: { apiKey: '', disabledModels: [] },
      openai: { apiKey: '', disabledModels: [] },
      local: { baseURL: 'http://localhost:11434/v1', apiKey: '' },
      sophistication: {},
      sandbox: { image: '' },
      offline: false,
      fast: false,
      autoReview: false,
      approvalCeiling: 5,
      theme: {},
      readable: { global: [], workspaces: {} },
      setup: { completed: false, version: 0, skipped: [] },
    });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('keeps a limit on the context of local models until it is taken away', async () => {
    settings.update({ local: { maxContext: 16384.5 } });
    expect(settings.get().local.maxContext).toBe(16384);
    expect(settings.publicView().local.maxContext).toBe(16384);
    settings.update({ local: { baseURL: 'http://other:1/v1' } });
    expect(settings.get().local.maxContext).toBe(16384);
    settings.update({ local: { maxContext: 100 } });
    expect(settings.get().local.maxContext).toBe(4096);
    settings.update({ local: { maxContext: null } });
    expect(settings.get().local).not.toHaveProperty('maxContext');
  });

  it('takes the default local server from LOCAL_LLM_BASE_URL', async () => {
    vi.stubEnv('LOCAL_LLM_BASE_URL', 'http://gpu-box:8080/v1');
    expect((await restart()).local.baseURL).toBe('http://gpu-box:8080/v1');
  });
});

describe('update', () => {
  it('saves everything in an encrypted file that survives a restart', async () => {
    settings.update({
      anthropic: { apiKey: 'sk-ant-secret', disabledModels: ['claude-haiku-4-5'] },
      openai: { apiKey: 'sk-openai-secret' },
      local: { baseURL: 'http://other:1/v1', apiKey: 'local-secret' },
      sophistication: { 'local/llama3.2:3b': 4 },
      sandbox: { image: 'node:22-bookworm-slim' },
      offline: true,
      fast: true,
    });

    const raw = fs.readFileSync(file(), 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).not.toContain('anthropic');

    expect(await restart()).toEqual({
      anthropic: { apiKey: 'sk-ant-secret', disabledModels: ['claude-haiku-4-5'] },
      openai: { apiKey: 'sk-openai-secret', disabledModels: [] },
      local: { baseURL: 'http://other:1/v1', apiKey: 'local-secret' },
      sophistication: { 'local/llama3.2:3b': 4 },
      sandbox: { image: 'node:22-bookworm-slim' },
      offline: true,
      fast: true,
      autoReview: false,
      approvalCeiling: 5,
      theme: {},
      readable: { global: [], workspaces: {} },
      setup: { completed: false, version: 0, skipped: [] },
    });
  });

  it('writes the file readable only by the user', () => {
    settings.update({ anthropic: { apiKey: 'k' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps a key that the patch leaves out, removes one set to null, and trims a new one', () => {
    settings.update({ anthropic: { apiKey: 'first' }, openai: { apiKey: 'keep-me' } });
    settings.update({ anthropic: { apiKey: '  second \n' }, openai: { disabledModels: ['gpt-x'] } });
    expect(settings.get().anthropic.apiKey).toBe('second');
    expect(settings.get().openai).toEqual({ apiKey: 'keep-me', disabledModels: ['gpt-x'] });

    settings.update({ openai: { apiKey: null } });
    expect(settings.get().openai.apiKey).toBe('');
    expect(settings.get().anthropic.apiKey).toBe('second');
  });

  it('replaces the disabled list and drops entries that are not model ids', () => {
    settings.update({ anthropic: { disabledModels: ['a', 'b'] } });
    settings.update({ anthropic: { disabledModels: ['c', 7, null] as unknown as string[] } });
    expect(settings.get().anthropic.disabledModels).toEqual(['c']);
  });

  it('falls back to the default server when the URL is blanked', () => {
    settings.update({ local: { baseURL: 'http://other:1/v1' } });
    settings.update({ local: { baseURL: '   ' } });
    expect(settings.get().local.baseURL).toBe('http://localhost:11434/v1');
  });

  it('keeps a valid theme across a restart', async () => {
    settings.update({
      theme: {
        '--bg': '#ff0000',
        '--panel': '#00ff00',
        '--border': '#0000ff',
      },
    });

    expect(settings.get().theme).toEqual({
      '--bg': '#ff0000',
      '--panel': '#00ff00',
      '--border': '#0000ff',
    });

    await restart();
    expect(settings.get().theme).toEqual({
      '--bg': '#ff0000',
      '--panel': '#00ff00',
      '--border': '#0000ff',
    });
  });

  it('drops unknown keys and non-hex values in a theme', () => {
    settings.update({
      theme: {
        '--bg': '#ffaa00',
        '--unknown-key': '#abcd1234', // not a THEME_VAR
        '--border': 'not-a-color',
      },
    });

    expect(settings.get().theme).toEqual({
      '--bg': '#ffaa00',
    });
  });

  it('omitted theme stays as it was, but {} resets to an empty object', () => {
    settings.update({
      theme: { '--bg': '#abc123' },
    });
    expect(settings.get().theme).toEqual({ '--bg': '#abc123' });

    settings.update({ anthropic: { apiKey: 'k' } });
    expect(settings.get().theme).toEqual({ '--bg': '#abc123' });

    settings.update({ theme: {} });
    expect(settings.get().theme).toEqual({});
  });

  it('loads a bad saved theme as an empty object', async () => {
    const old = { theme: 'string-not-object' };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(old)).toString('base64')}`);
    electron.encryptionAvailable = true;
    await restart();
    expect(settings.get().theme).toEqual({});

    const badHex = { theme: { '--bg': '#GGGGGG' } };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(badHex)).toString('base64')}`);
    await restart();
    expect(settings.get().theme).toEqual({});

    const partialBad = { theme: { '--bg': '#ff0000', '--panel': '#not-hex' } };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(partialBad)).toString('base64')}`);
    await restart();
    expect(settings.get().theme).toEqual({ '--bg': '#ff0000' });
  });

  it('replaces the sophistication levels, keeping only whole levels from 0 to 5', () => {
    settings.update({ sophistication: { old: 2 } });
    settings.update({
      sophistication: {
        a: 1,
        b: 5,
        zero: 0,
        negative: -1,
        six: 6,
        fraction: 2.5,
        text: 'high' as unknown as number,
      },
    });
    expect(settings.get().sophistication).toEqual({ a: 1, b: 5, zero: 0 });
  });

  it('leaves the levels alone when the patch does not mention them', () => {
    settings.update({ sophistication: { a: 3 } });
    settings.update({ anthropic: { apiKey: 'k' } });
    expect(settings.get().sophistication).toEqual({ a: 3 });
  });

  it('switches offline on and off, and takes nothing else for an answer', () => {
    settings.update({ offline: true });
    expect(settings.get().offline).toBe(true);
    expect(settings.publicView().offline).toBe(true);

    // Left out of a patch, it stays as it is
    settings.update({ anthropic: { apiKey: 'k' } });
    expect(settings.get().offline).toBe(true);

    settings.update({ offline: 'yes' as unknown as boolean });
    expect(settings.get().offline).toBe(false);
  });

  it('switches fast mode on and off, independently of offline', () => {
    settings.update({ fast: true });
    expect(settings.get().fast).toBe(true);
    expect(settings.publicView().fast).toBe(true);
    expect(settings.get().offline).toBe(false);

    // Left out of a patch, it stays as it is
    settings.update({ offline: true });
    expect(settings.get().fast).toBe(true);

    settings.update({ fast: 'yes' as unknown as boolean });
    expect(settings.get().fast).toBe(false);
  });

  it('switches automatic review on and off, and starts with it off', () => {
    expect(settings.get().autoReview).toBe(false);

    settings.update({ autoReview: true });
    expect(settings.get().autoReview).toBe(true);
    expect(settings.publicView().autoReview).toBe(true);

    settings.update({ fast: true });
    expect(settings.get().autoReview).toBe(true);

    settings.update({ autoReview: 'yes' as unknown as boolean });
    expect(settings.get().autoReview).toBe(false);
  });

  it('takes an approval ceiling from 1 to 5 and ignores anything else', () => {
    settings.update({ approvalCeiling: 3 });
    expect(settings.get().approvalCeiling).toBe(3);
    expect(settings.publicView().approvalCeiling).toBe(3);

    settings.update({ approvalCeiling: 9 });
    expect(settings.get().approvalCeiling).toBe(3);

    settings.update({ approvalCeiling: 2.5 });
    expect(settings.get().approvalCeiling).toBe(3);

    // Left out of a patch, it stays as it is
    settings.update({ anthropic: { apiKey: 'k' } });
    expect(settings.get().approvalCeiling).toBe(3);
  });

  it('changes nothing if the settings cannot be encrypted', () => {
    settings.update({ anthropic: { apiKey: 'before' } });
    electron.encryptionAvailable = false;
    expect(() => settings.update({ anthropic: { apiKey: 'after' } })).toThrow('Encryption is not available');
    expect(settings.get().anthropic.apiKey).toBe('before');
  });

  it('returns the updated settings', () => {
    expect(settings.update({ openai: { apiKey: 'k' } }).openai.apiKey).toBe('k');
  });
});

describe('what the model may read on the user’s computer', () => {
  it('is nothing until the user allows something', () => {
    expect(settings.readable('/w')).toEqual([]);
    expect(settings.readable()).toEqual([]);
  });

  it('remembers an allowed file or folder for its workspace only, across a restart', async () => {
    settings.allowRead('/w', '/home/me/.npmrc');
    settings.allowRead('/w', '/home/me/notes');
    settings.allowRead('/other', '/home/me/log');
    await restart();
    expect(settings.readable('/w')).toEqual(['/home/me/.npmrc', '/home/me/notes']);
    expect(settings.readable('/other')).toEqual(['/home/me/log']);
    expect(settings.readable()).toEqual([]);
  });

  it('adds the global list to every workspace’s own', async () => {
    const saved = { readable: { global: ['/etc/hosts'], workspaces: { '/w': ['/home/me/a'] } } };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(saved)).toString('base64')}`);
    await restart();
    expect(settings.readable('/w')).toEqual(['/etc/hosts', '/home/me/a']);
    expect(settings.readable('/other')).toEqual(['/etc/hosts']);
    expect(settings.readable()).toEqual(['/etc/hosts']);
  });

  it('is not added to twice, and is kept by an ordinary update', () => {
    settings.allowRead('/w', '/home/me/a');
    settings.allowRead('/w', '/home/me/a');
    settings.update({ fast: true });
    expect(settings.readable('/w')).toEqual(['/home/me/a']);
  });

  it('takes only absolute paths, and is not changed by one that could not be saved', () => {
    settings.allowRead('/w', 'relative/file');
    expect(settings.readable('/w')).toEqual([]);
    electron.encryptionAvailable = false;
    expect(() => settings.allowRead('/w', '/home/me/a')).toThrow('Encryption is not available');
    expect(settings.readable('/w')).toEqual([]);
  });

  it('reads a damaged list as an empty one', async () => {
    const saved = { readable: { global: 'x', workspaces: { '/w': [1, 'rel', '/ok'], '/v': 'y' } } };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(saved)).toString('base64')}`);
    await restart();
    expect(settings.get().readable).toEqual({ global: [], workspaces: { '/w': ['/ok'] } });
  });
});

describe('load', () => {
  it('uses defaults, without overwriting the file, when it cannot be decrypted', async () => {
    fs.writeFileSync(file(), 'garbage from another machine');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await restart()).anthropic.apiKey).toBe('');
    expect(error).toHaveBeenCalled();
    expect(fs.readFileSync(file(), 'utf8')).toBe('garbage from another machine');
  });

  it('reads offline back as a boolean, whatever the file says', async () => {
    const old = { offline: 'true' };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(old)).toString('base64')}`);
    expect((await restart()).offline).toBe(false);
  });

  it('fills in settings added since the file was written', async () => {
    // A file from an older version: no openai section, no disabledModels
    const old = { anthropic: { apiKey: 'k' }, local: { baseURL: 'http://x/v1' } };
    fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify(old)).toString('base64')}`);
    expect(await restart()).toEqual({
      anthropic: { apiKey: 'k', disabledModels: [] },
      openai: { apiKey: '', disabledModels: [] },
      local: { baseURL: 'http://x/v1', apiKey: '' },
      sophistication: {},
      sandbox: { image: '' },
      offline: false,
      fast: false,
      autoReview: false,
      approvalCeiling: 5,
      theme: {},
      readable: { global: [], workspaces: {} },
      setup: { completed: false, version: 0, skipped: [] },
    });
  });

  it('keeps a saved approval ceiling from 1 to 5, and falls back to 5 for anything else', async () => {
    const save = (approvalCeiling: unknown) =>
      fs.writeFileSync(file(), `enc:${Buffer.from(JSON.stringify({ approvalCeiling })).toString('base64')}`);

    save(3);
    expect((await restart()).approvalCeiling).toBe(3);

    for (const bad of [0, 6, 2.5, 'x']) {
      save(bad);
      expect((await restart()).approvalCeiling).toBe(5);
    }
  });
});

describe('publicView', () => {
  it('reports whether keys exist but never the keys themselves', () => {
    settings.update({
      anthropic: { apiKey: 'sk-ant-secret', disabledModels: ['m'] },
      local: { apiKey: 'local-secret' },
      sophistication: { 'local/a': 2 },
      theme: { '--bg': '#abcdef' },
    });
    const view = settings.publicView();
    expect(view).toEqual({
      anthropic: { hasKey: true, disabledModels: ['m'] },
      openai: { hasKey: false, disabledModels: [] },
      local: { baseURL: 'http://localhost:11434/v1', hasKey: true },
      sandbox: { image: '' },
      sophistication: { 'local/a': 2 },
      offline: false,
      fast: false,
      autoReview: false,
      approvalCeiling: 5,
      theme: { '--bg': '#abcdef' },
      setup: { completed: false, version: 0, skipped: [] },
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });
});

// What the user has been led through installing (see setup/checks.ts). The
// flow reports the step it got through rather than the whole record, so this
// is a merge rather than a replacement.
describe('the setup record', () => {
  it('remembers what was finished, against which set of requirements', () => {
    expect(settings.get().setup).toEqual({ completed: false, version: 0, skipped: [] });
    settings.update({ setup: { completed: true, version: 2 } });
    expect(settings.publicView().setup).toEqual({ completed: true, version: 2, skipped: [] });
  });

  it('keeps what one step skipped when a later one says it is done', () => {
    settings.update({ setup: { skipped: ['docker'] } });
    settings.update({ setup: { completed: true, version: 1 } });
    expect(settings.get().setup).toEqual({ completed: true, version: 1, skipped: ['docker'] });
  });

  it('takes nothing on trust from the file, nor from a patch', async () => {
    settings.update({ setup: { completed: 'yes' as unknown as boolean, version: -3, skipped: [1 as never, 'a'] } });
    expect(settings.get().setup).toEqual({ completed: false, version: 0, skipped: ['a'] });

    const file = path.join(electron.userData, 'settings.enc');
    const bad = { setup: { completed: 1, version: 'x', skipped: 'docker' } };
    fs.writeFileSync(file, `enc:${Buffer.from(JSON.stringify(bad)).toString('base64')}`);
    expect((await restart()).setup).toEqual({ completed: false, version: 0, skipped: [] });
  });
});
