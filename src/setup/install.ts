// Installing what the app needs, for the flow on the way in to drive (see
// renderer/setup.ts).
//
// Docker is installed by the very script `npm run install-docker` runs, in a
// process of its own. In a process of its own because it is the slow case of
// everything here — Homebrew fetching Colima, Colima building its VM, minutes
// at a time — and the installer is written against a synchronous `System`
// (see scripts/install-docker.ts): run in the main process it would hold the
// window still for the whole install. Forked, its output is a stream the flow
// can show as it arrives, and the user can give up on it.
//
// Ollama is not installed here. It ships as an application on macOS and
// Windows, which cannot be installed unattended, so the flow opens the
// download page and waits for Ollama to answer (see poll in renderer/setup.ts).
// Pretending to install it would mean reporting a success nobody could check.

import { shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'fs';
import path from 'path';
import * as log from '../log';
import { toolEnv } from '../sandbox/env';
import type { Installable, SetupProgress } from '../types';

// Where what we cannot install is downloaded from
export const DOWNLOADS: Record<Installable, string> = {
  docker: 'https://www.docker.com/products/docker-desktop/',
  ollama: 'https://ollama.com/download',
};

// The installer, beside the compiled main process (dist/scripts/).
//
// A packaged app runs out of an archive, and a process cannot be started from
// inside one. electron-builder is told to leave the compiled output unpacked
// beside it for exactly this (see asarUnpack in package.json), which is a real
// directory next to the archive with the same contents — including the modules
// the installer imports, which is why the whole of dist is unpacked and not
// only the script. Unpackaged, there is no archive and the path is itself.
export function scriptPath(dir: string, exists: (file: string) => boolean = fs.existsSync): string {
  const inside = path.join(dir, '..', 'scripts', 'install-docker.js');
  const beside = inside.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return beside !== inside && exists(beside) ? beside : inside;
}

export const SCRIPT = scriptPath(__dirname);

// The install running, if any. One at a time: two Homebrews installing the
// same thing at once is worse than a button that does nothing.
let running: UtilityProcess | null = null;

export const installing = () => running !== null;

// Runs the Docker installer, reporting its output a line at a time and saying
// when it is over.
//
// `ok` is only whether the installer exited cleanly, which says little: it
// reports what it could not do and exits 0 regardless, so that a failed
// install never fails the `npm install` it usually runs inside of. What
// actually came of it is for checks.status() to say.
export function installDocker(onProgress: (progress: SetupProgress) => void): void {
  if (running) return;

  // The installer skips itself for an unattended install and on CI. Asked for
  // by a user who clicked a button, it is neither.
  const env = { ...toolEnv() };
  delete env.CH_SKIP_DOCKER_INSTALL;
  delete env.CI;

  let child: UtilityProcess;
  try {
    child = utilityProcess.fork(SCRIPT, [], { stdio: 'pipe', env, serviceName: 'ch-install-docker' });
  } catch (err) {
    log.error('setup.installDocker', { ok: false, error: (err as Error).message });
    onProgress({ done: true, ok: false, error: (err as Error).message });
    return;
  }
  running = child;
  log.info('setup.installDocker', { script: SCRIPT });

  // The installer writes whole lines; a chunk is not one of them
  let rest = '';
  const read = (chunk: Buffer | string) => {
    rest += chunk.toString();
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) onProgress({ line });
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);

  child.on('exit', (code) => {
    if (rest.trim()) onProgress({ line: rest });
    rest = '';
    running = null;
    log.info('setup.installDocker', { ok: code === 0, code });
    onProgress({ done: true, ok: code === 0 });
  });
}

// Gives up on the install that is running. What it had already installed stays
// installed; the flow asks for the status again and shows whatever that is.
export function cancel(): void {
  running?.kill();
  running = null;
}

// Opens a download page in the user's own browser
export function download(what: Installable): void {
  const url = DOWNLOADS[what];
  if (url) shell.openExternal(url);
}
