// What the app needs before it can be used, and which of it is here.
//
// The answer is data rather than an error, because every one of these is
// something the user can be led through fixing (see renderer/setup.ts) and
// because two parts of the app ask the same question for different reasons:
// the flow on the way in, and the switches in the title bar that have nothing
// to do without a hosted or a local model (see drawOffline in
// renderer/models.ts).
//
// Nothing here changes anything. Installing is install.ts.

import { spawn } from 'child_process';
import os from 'os';
import { FLOOR } from '../harness/classifier';
import * as llm from '../llm';
import * as ollama from '../llm/ollama';
import { SUGGESTED } from '../llm/ollama';
import { resolveSophistication } from '../llm/sophistication';
import { toolEnv } from '../sandbox/env';
import { MODEL as EMBEDDING_MODEL } from '../search/embeddings';
import { findBrew, realSystem } from '../scripts/install-docker';
import * as settings from '../settings';
import type { DockerReadiness, LocalReadiness, SetupStatus } from '../types';

// The set of requirements the flow walks. Raised when the app comes to need
// something it didn't, so a user who has been through the flow is shown the
// new step rather than nothing (see wanted) or the whole flow again.
export const SETUP_VERSION = 1;

// How long a command asked about Docker may take. `docker info` with no daemon
// behind it is the slow case: it waits on a socket nobody is listening to.
const PROBE_MS = 8000;

// Ollama lists "qwen2.5:7b" as itself but "llama3.2" as "llama3.2:latest",
// so a model is matched either way round
const installedHas = (installed: { name: string }[], model: string) =>
  installed.some(({ name }) => name === model || name === `${model}:latest`);

// Runs a command only to see how it goes. ENOENT — the command is not on this
// computer — is reported as such rather than thrown, since that is the answer
// to most of what is asked here.
export async function probe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = toolEnv()
): Promise<{ ran: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'ignore', timeout: PROBE_MS });
    child.on('error', () => resolve({ ran: false, code: null }));
    child.on('close', (code) => resolve({ ran: true, code }));
  });
}

// Whether Docker is here, and whether it is up. One command answers both: a
// `docker info` that cannot run at all means no Docker, and one that runs and
// fails means a daemon that isn't up (see sandbox/docker.startDaemon).
export async function dockerStatus(): Promise<DockerReadiness> {
  const info = await probe('docker', ['info']);
  const automatic = await canInstallDocker();
  if (!info.ran) return { installed: false, running: false, automatic };
  return { installed: true, running: info.code === 0, automatic };
}

// Whether this computer has something to install Docker with, which decides
// whether the flow offers to do it or points at the download page. Mirrors
// what scripts/install-docker.ts will actually try (Homebrew on macOS, the
// official script with sudo on Linux, winget on Windows).
export async function canInstallDocker(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') return Boolean(findBrew(realSystem()));
  if (platform === 'win32') return (await probe('winget', ['--version'])).code === 0;
  if (platform === 'linux') {
    if (process.getuid?.() === 0) return true;
    return (await probe('sudo', ['-n', 'true'])).code === 0;
  }
  return false;
}

// The models worth downloading on this computer: the suggested ones that are
// not here yet and that its memory can hold, largest first. Largest first
// because the flow offers the first of them as its recommendation, and the
// biggest model a machine can hold is the best one it can route to.
export function recommend(suggested: LocalReadiness['recommended'], memoryGB: number): LocalReadiness['recommended'] {
  return suggested.filter((m) => m.memoryGB <= memoryGB).sort((a, b) => b.memoryGB - a.memoryGB);
}

export const memoryGB = (total = os.totalmem()) => Math.round(total / 1024 ** 3);

// What can be answered with on this computer. Ollama is asked for what it has
// downloaded, and the provider registry for what is actually on offer: a
// local server that isn't Ollama — LM Studio, llama.cpp — serves models
// without answering Ollama's own API, and those count (see llm/index.ts).
export async function localStatus(): Promise<LocalReadiness> {
  const status = await ollama.status(settings.get().local);
  const listed = await llm.listModels({ includeDisabled: true });
  const local = listed.models.filter((m) => m.local);
  const gb = memoryGB();
  // Downloaded but not on offer is still downloaded: a model switched off, or
  // one Ollama has and the registry has not caught up with, is not missing
  const names = [...new Set([...local.map((m) => m.id), ...status.installed.map((m) => m.name)])];
  return {
    reachable: status.reachable,
    url: status.url,
    installed: status.installed,
    recommended: recommend(
      SUGGESTED.map((m) => ({ ...m, sophistication: resolveSophistication('local', m.name) })).filter(
        (m) => !installedHas(status.installed, m.name)
      ),
      gb
    ),
    memoryGB: gb,
    models: names.filter((name) => name !== EMBEDDING_MODEL && !name.startsWith(`${EMBEDDING_MODEL}:`)).length,
    routable: names.some((name) => resolveSophistication('local', name) >= FLOOR),
    embedding: installedHas(
      status.installed.length > 0 ? status.installed : names.map((name) => ({ name })),
      EMBEDDING_MODEL
    ),
    embeddingModel: EMBEDDING_MODEL,
  };
}

// Everything at once, so that no two steps of the flow disagree about the
// same thing.
export async function status(): Promise<SetupStatus> {
  const [local, docker] = await Promise.all([localStatus(), dockerStatus()]);
  const saved = settings.get();
  const keys = { anthropic: Boolean(saved.anthropic.apiKey), openai: Boolean(saved.openai.apiKey) };
  const canAnswer = local.models > 0 || keys.anthropic || keys.openai;
  // Ollama is required, embedding model and all: it is the only thing here
  // that serves one, and a workspace search without it is keyword matching
  // wearing the name of something better (see search/embeddings.ts). Which
  // part of this is missing is the flow's to say (see blocking in
  // renderer/setup.ts); whether anything is, is settled here.
  const ready = local.reachable && local.embedding && canAnswer;
  return {
    local,
    docker,
    keys,
    canAnswer,
    ready,
    canRunCode: docker.installed && docker.running,
    canSearch: local.embedding,
    setup: saved.setup,
    version: SETUP_VERSION,
    wanted: wanted({ ready, docker, setup: saved.setup }),
    platform: process.platform,
  };
}

// Whether the flow should open itself. Never for something the user said they
// would go without, and never for something that is only recommended — but
// always for what it requires, however many times it has been finished
// before: an Ollama that has stopped, or an embedding model that has been
// deleted, leaves the app without a part of itself again.
//
// Docker is here as well, for the case that is nobody's fault: Colima does not
// come back after a reboot (see scripts/install-docker.ts), so a user who set
// Docker up and then restarted their computer has a thread that cannot run
// anything and no way to tell why. Only when it was set up and has gone —
// never when it was skipped.
export function wanted({ ready, docker, setup }: Pick<SetupStatus, 'ready' | 'docker' | 'setup'>): boolean {
  if (!ready) return true;
  if (!setup.completed) return true;
  if (setup.version < SETUP_VERSION) return true;
  return docker.installed && !docker.running && !setup.skipped.includes('docker');
}
