import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelList, Settings } from '../../src/types';

// What the commands it asks about do. Keyed by the command, since what it runs
// is one of a handful: docker, winget, sudo.
const proc = vi.hoisted(() => ({
  calls: [] as string[],
  // null stands for a command that is not on this computer (ENOENT)
  codes: {} as Record<string, number | null>,
}));

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    proc.calls.push([command, ...args].join(' '));
    const child: any = new EventEmitter();
    const code = proc.codes[command];
    Promise.resolve().then(() => {
      if (code === null || code === undefined) {
        const error: NodeJS.ErrnoException = new Error(`spawn ${command} ENOENT`);
        error.code = 'ENOENT';
        child.emit('error', error);
        return;
      }
      child.emit('close', code);
    });
    return child;
  },
}));

const mocks = vi.hoisted(() => ({
  ollama: { status: vi.fn(), SUGGESTED: [] as unknown[] },
  llm: { listModels: vi.fn() },
  settings: { get: vi.fn() },
  // Only the name of the model the search is built on matters here
  embeddings: { MODEL: 'nomic-embed-text' },
  // Where the macOS installer looks for Homebrew
  installer: { findBrew: vi.fn(), realSystem: vi.fn(() => ({})) },
}));

vi.mock('../../src/llm', () => mocks.llm);
vi.mock('../../src/llm/ollama', () => ({
  status: mocks.ollama.status,
  // The suggestions the flow recommends from, which the real list holds
  SUGGESTED: [
    { name: 'llama3.2:3b', memoryGB: 4 },
    { name: 'qwen2.5:7b', memoryGB: 8 },
    { name: 'qwen2.5:14b', memoryGB: 16 },
    { name: 'qwen2.5:32b', memoryGB: 32 },
  ],
}));
vi.mock('../../src/settings', () => mocks.settings);
vi.mock('../../src/search/embeddings', () => mocks.embeddings);
vi.mock('../../src/scripts/install-docker', () => mocks.installer);

let checks: typeof import('../../src/setup/checks');

const saved = (over: Partial<Settings> = {}) =>
  ({
    anthropic: { apiKey: '', disabledModels: [] },
    openai: { apiKey: '', disabledModels: [] },
    local: { baseURL: 'http://localhost:11434/v1', apiKey: '' },
    setup: { completed: false, version: 0, skipped: [] },
    ...over,
  }) as Settings;

// A local model as the provider registry lists it
const local = (id: string, sophistication: number) => ({ id, local: true, sophistication });
const listed = (models: unknown[]) => ({ models, providers: [] }) as unknown as ModelList;

beforeEach(async () => {
  proc.calls = [];
  // Docker installed and up, and no package manager, unless a test says so
  proc.codes = { docker: 0 };
  mocks.ollama.status.mockResolvedValue({
    reachable: true,
    url: 'http://localhost:11434',
    installed: [],
    suggested: [],
  });
  mocks.llm.listModels.mockResolvedValue(listed([]));
  mocks.settings.get.mockReturnValue(saved());
  mocks.installer.findBrew.mockReturnValue('/opt/homebrew/bin/brew');
  vi.resetModules();
  checks = await import('../../src/setup/checks');
});

describe('what Docker is doing', () => {
  it('asks once, because a docker that cannot run at all is the answer to both questions', async () => {
    await expect(checks.dockerStatus()).resolves.toMatchObject({ installed: true, running: true });
    expect(proc.calls).toContain('docker info');
    expect(proc.calls.filter((call) => call.startsWith('docker')).length).toBe(1);
  });

  it('reads a command that is not there as no Docker, and one that fails as a daemon that is down', async () => {
    proc.codes = {};
    await expect(checks.dockerStatus()).resolves.toMatchObject({ installed: false, running: false });

    proc.codes = { docker: 1 };
    await expect(checks.dockerStatus()).resolves.toMatchObject({ installed: true, running: false });
  });

  it('can install it on a Mac with Homebrew, and not on one without', async () => {
    await expect(checks.canInstallDocker('darwin')).resolves.toBe(true);
    mocks.installer.findBrew.mockReturnValue(undefined);
    await expect(checks.canInstallDocker('darwin')).resolves.toBe(false);
  });

  it('wants winget on Windows and a sudo that does not ask on Linux', async () => {
    proc.codes = { winget: 0, sudo: 1 };
    await expect(checks.canInstallDocker('win32')).resolves.toBe(true);
    await expect(checks.canInstallDocker('linux')).resolves.toBe(false);
    expect(proc.calls).toContain('sudo -n true');

    proc.codes = { sudo: 0 };
    await expect(checks.canInstallDocker('linux')).resolves.toBe(true);
    await expect(checks.canInstallDocker('win32')).resolves.toBe(false);
  });
});

describe('what there is to answer with', () => {
  it('counts the local models the registry offers, whatever is serving them', async () => {
    // LM Studio: models on offer, and nothing answering Ollama's own API
    mocks.ollama.status.mockResolvedValue({
      reachable: false,
      url: 'http://localhost:1234/v1',
      installed: [],
      suggested: [],
    });
    mocks.llm.listModels.mockResolvedValue(listed([local('qwen2.5-coder:7b', 1)]));
    const status = await checks.localStatus();
    expect(status).toMatchObject({ reachable: false, models: 1, routable: true });
  });

  it('counts a model Ollama has downloaded but the registry has not caught up with', async () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'qwen2.5:7b', size: 4.7e9 }],
      suggested: [],
    });
    expect(await checks.localStatus()).toMatchObject({ models: 1, routable: true });
  });

  // The floor the classifier will trust (see harness/classifier.FLOOR), which
  // a 3B model is below: it can still answer, but routing will keep reaching
  // past it
  it('does not call a model that is below the classifier’s floor routable', async () => {
    mocks.llm.listModels.mockResolvedValue(listed([local('llama3.2:3b', 0)]));
    expect(await checks.localStatus()).toMatchObject({ models: 1, routable: false });
  });

  it('leaves the embedding model out of the count, and reports it on its own', async () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'nomic-embed-text:latest', size: 2.7e8 }],
      suggested: [],
    });
    expect(await checks.localStatus()).toMatchObject({ models: 0, embedding: true });
  });

  it('recommends the models this computer’s memory can hold, the largest first', () => {
    const suggested = [
      { name: 'llama3.2:3b', memoryGB: 4, sophistication: 0 },
      { name: 'qwen2.5:7b', memoryGB: 8, sophistication: 1 },
      { name: 'qwen2.5:32b', memoryGB: 32, sophistication: 2 },
    ];
    expect(checks.recommend(suggested, 16).map((m) => m.name)).toEqual(['qwen2.5:7b', 'llama3.2:3b']);
    expect(checks.recommend(suggested, 64).map((m) => m.name)).toEqual(['qwen2.5:32b', 'qwen2.5:7b', 'llama3.2:3b']);
  });

  it('leaves out what is already downloaded, so nothing is offered twice', async () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'qwen2.5:7b', size: 4.7e9 }],
      suggested: [],
    });
    const { recommended } = await checks.localStatus();
    expect(recommended.map((m) => m.name)).not.toContain('qwen2.5:7b');
  });
});

describe('the whole of it', () => {
  // Ollama answering, holding the embedding model, and a model to answer with
  const allOfIt = () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [
        { name: 'qwen2.5:7b', size: 4.7e9 },
        { name: 'nomic-embed-text:latest', size: 2.7e8 },
      ],
      suggested: [],
    });
  };

  it('says a message can be answered when there is a local model, or a key, and not otherwise', async () => {
    expect(await checks.status()).toMatchObject({ canAnswer: false });

    mocks.settings.get.mockReturnValue(saved({ anthropic: { apiKey: 'sk-ant', disabledModels: [] } }));
    expect(await checks.status()).toMatchObject({ canAnswer: true, keys: { anthropic: true, openai: false } });

    mocks.settings.get.mockReturnValue(saved());
    mocks.llm.listModels.mockResolvedValue(listed([local('qwen2.5:7b', 1)]));
    expect(await checks.status()).toMatchObject({ canAnswer: true });
  });

  it('says what the parts that are missing cost: code in a container, and search by meaning', async () => {
    proc.codes = { docker: 1 };
    expect(await checks.status()).toMatchObject({ canRunCode: false, canSearch: false });
  });

  // Ollama is required: the embedding model behind the workspace search is
  // served by nothing else here
  it('is not ready without Ollama, however many hosted keys there are', async () => {
    mocks.settings.get.mockReturnValue(saved({ anthropic: { apiKey: 'sk-ant', disabledModels: [] } }));
    expect(await checks.status()).toMatchObject({ canAnswer: true, ready: false });
  });

  it('is not ready with an Ollama that has no embedding model', async () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'qwen2.5:7b', size: 4.7e9 }],
      suggested: [],
    });
    expect(await checks.status()).toMatchObject({ canAnswer: true, canSearch: false, ready: false });
  });

  it('is not ready with an Ollama that has only the embedding model and nothing to answer with', async () => {
    mocks.ollama.status.mockResolvedValue({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'nomic-embed-text:latest', size: 2.7e8 }],
      suggested: [],
    });
    expect(await checks.status()).toMatchObject({ canAnswer: false, canSearch: true, ready: false });
  });

  it('is ready with Ollama answering, the embedding model, and something to answer with', async () => {
    allOfIt();
    expect(await checks.status()).toMatchObject({ ready: true, canAnswer: true, canSearch: true });
  });
});

describe('whether the flow should open itself', () => {
  const done = { completed: true, version: 1, skipped: [] };
  const docker = { installed: true, running: true, automatic: true };

  // Whatever has been finished before: an Ollama that has stopped, or an
  // embedding model that has been deleted, is a part of the app missing again
  it('always does when what it requires is not there, however often it has been finished', () => {
    expect(checks.wanted({ ready: false, docker, setup: done })).toBe(true);
    expect(checks.wanted({ ready: false, docker, setup: { ...done, skipped: ['local'] } })).toBe(true);
  });

  it('does until it has been finished, and then stops', () => {
    expect(checks.wanted({ ready: true, docker, setup: { ...done, completed: false } })).toBe(true);
    expect(checks.wanted({ ready: true, docker, setup: done })).toBe(false);
  });

  it('does again when the app has come to need something it did not', () => {
    expect(checks.wanted({ ready: true, docker, setup: { ...done, version: 0 } })).toBe(true);
    expect(checks.SETUP_VERSION).toBeGreaterThan(0);
  });

  // Colima does not come back after a reboot, which is nobody's fault and
  // leaves a thread unable to run anything with nothing said about why
  it('does when a Docker that was set up has stopped, but not when it was skipped', () => {
    const stopped = { installed: true, running: false, automatic: true };
    expect(checks.wanted({ ready: true, docker: stopped, setup: done })).toBe(true);
    expect(checks.wanted({ ready: true, docker: stopped, setup: { ...done, skipped: ['docker'] } })).toBe(false);
  });

  it('does not for a Docker that was never installed, which is a thing the user may not want', () => {
    const missing = { installed: false, running: false, automatic: true };
    expect(checks.wanted({ ready: true, docker: missing, setup: done })).toBe(false);
  });
});
