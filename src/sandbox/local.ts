// A thread's sandbox as a folder rather than a container, for an app that is itself running in a container: the app
// being tested, in the thread's container of a model checking a change to it (see CH_SANDBOX in ./docker.ts). There
// is no Docker in there to make a container with, and none is needed, since what is around the app is a container
// already. Nowhere else: a folder keeps nothing a command does from the machine it runs on, which is the whole of
// what a container is for, so this is refused outside one (see active).
//
// Everything else about a thread is written for a container whose files are at /workspace, with the record of them
// at BASELINE_DIR — the tools, the prompts, what models are told and what they write back — and a folder cannot be
// put at /workspace for one thread's commands alone: that takes a mount namespace, which a container without
// privileges is not allowed to make. So the paths are translated where commands come in instead. A command is run
// from the thread's folder with /workspace and the baseline's path in it made the thread's own, and what it says has
// the thread's folder made /workspace again. Nothing else sees a difference, and two threads stay apart.
//
// What a command writes into a file is not translated, any more than the files themselves are: only what is said on
// the command line and what comes back from it as words. A read of a file's bytes comes back untouched (see read).

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { toolEnv } from './env';

// Where the threads' folders are made, one for each, under its id
export const ROOT = '/tmp/ch-sandbox';
const MAX_OUTPUT = 30000; // characters of command output kept, as for a container
const KILL_GRACE_MS = 5000;

// Whether threads are to have folders: asked for with CH_SANDBOX=local, and only granted inside a container, where
// the container is the sandbox. Asked for anywhere else it is refused, so that a variable left set on somebody's own
// computer cannot run a model's commands loose on it.
export function active(env: NodeJS.ProcessEnv = process.env, inContainer = isContainer()): boolean {
  return env.CH_SANDBOX === 'local' && inContainer;
}

function isContainer(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

export interface Folders {
  root: string;
  workspace: string;
  baseline: string;
}

export function folders(threadId: string, root = ROOT): Folders {
  const own = path.join(root, threadId);
  return { root: own, workspace: path.join(own, 'workspace'), baseline: path.join(own, 'baseline.git') };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path where it stands as a path, and not as the start of a longer name: /workspace, /workspace/a.ts, '/workspace'
// and /workspace; but not /workspaces
const asPath = (prefix: string) => new RegExp(`${escape(prefix)}(?![\\w.-])`, 'g');

// What a command says, made to say the thread's own folders. The baseline first, being the longer and the one that
// is not under the other.
export function inward(command: string, own: Folders, workdir: string, baselineDir: string): string {
  return command.replace(asPath(baselineDir), own.baseline).replace(asPath(workdir), own.workspace);
}

// ...and what comes back, made to say the paths the thread knows
export function outward(output: string, own: Folders, workdir: string, baselineDir: string): string {
  return output.replace(asPath(own.baseline), baselineDir).replace(asPath(own.workspace), workdir);
}

// What a command run for a thread is given: the app's own tool environment, less what is the app's and not the
// thread's — the switches it was run with for testing, and Electron's — which a command run by a model in the thread
// has no business seeing, and which would change how the project's own tests behave if it ran them
export function environment(base: NodeJS.ProcessEnv = toolEnv()): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !/^(CH_|ELECTRON_)/.test(name)));
}

export interface Ran {
  code: number | null;
  output: string;
}

// Runs a shell command from the thread's folder. Stopped after `timeoutSeconds`, with everything it started, and
// then said as `timeout` says it in a container: exit code 124.
export function run(
  own: Folders,
  command: string,
  { input, signal, timeoutSeconds = 120 }: { input?: string | Buffer; signal?: AbortSignal; timeoutSeconds?: number }
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    // Its own process group, so that it and what it starts can be stopped together
    const child = spawn('bash', ['-lc', command], { cwd: own.workspace, env: environment(), detached: true });
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT) output += chunk;
    };
    const stop = (how: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, how);
      } catch {
        // Gone already
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutSeconds * 1000);
    const aborted = () => stop('SIGKILL');
    signal?.addEventListener('abort', aborted, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (output.length >= MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[output truncated]`;
      resolve({ code: timedOut ? 124 : code, output });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Runs a command from the thread's folder and resolves with exactly what it wrote to stdout, whatever it is
export function read(own: Folders, command: string): Promise<{ code: number | null; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: own.workspace,
      env: environment(),
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, data: Buffer.concat(chunks) }));
  });
}

export const exists = (own: Folders) => fs.existsSync(own.workspace);

// Makes the thread's folder and, for a thread in a workspace, copies the workspace in: the files named, as a
// container is given them (see filesToCopy in ./docker.ts), or all of them where none are.
export async function make(own: Folders, workspace?: string, files?: string[] | null): Promise<void> {
  fs.mkdirSync(own.workspace, { recursive: true });
  if (!workspace) return;
  if (files) {
    for (const file of files) {
      const to = path.join(own.workspace, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(path.join(workspace, file), to, { verbatimSymlinks: true });
    }
  } else {
    fs.cpSync(workspace, own.workspace, { recursive: true, verbatimSymlinks: true });
  }
}

export function remove(own: Folders): void {
  fs.rmSync(own.root, { recursive: true, force: true });
}
