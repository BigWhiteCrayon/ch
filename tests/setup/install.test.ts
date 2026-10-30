import { EventEmitter } from 'events';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupProgress } from '../../src/types';

// Electron's own way of running a Node script in a process of its own, and
// the browser it opens a download page in
const electron = vi.hoisted(() => ({
  forks: [] as { script: string; args: string[]; options: any; child: any }[],
  opened: [] as string[],
  // What fork throws, for the one case where it cannot start at all
  failWith: null as Error | null,
}));

vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => electron.opened.push(url) },
  utilityProcess: {
    fork: (script: string, args: string[], options: any) => {
      if (electron.failWith) throw electron.failWith;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      electron.forks.push({ script, args, options, child });
      return child;
    },
  },
}));

vi.mock('../../src/log', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

let install: typeof import('../../src/setup/install');
// Everything the installer reported, in the order it came
let heard: SetupProgress[];
const report = (progress: SetupProgress) => heard.push(progress);
const running = () => electron.forks.at(-1)!;

beforeEach(async () => {
  electron.forks = [];
  electron.opened = [];
  electron.failWith = null;
  heard = [];
  vi.resetModules();
  install = await import('../../src/setup/install');
});

describe('installing Docker', () => {
  it('runs the same script as the command line, beside the compiled main process', () => {
    install.installDocker(report);
    expect(running().script).toBe(install.SCRIPT);
    expect(path.basename(install.SCRIPT)).toBe('install-docker.js');
    expect(install.SCRIPT).toContain(`${path.sep}scripts${path.sep}`);
    expect(running().options.stdio).toBe('pipe');
  });

  // The script skips itself for an unattended install. Asked for by a user who
  // has just clicked a button, it is not one.
  it('takes away the skips that are meant for npm install', () => {
    vi.stubEnv('CH_SKIP_DOCKER_INSTALL', '1');
    vi.stubEnv('CI', 'true');
    install.installDocker(report);
    expect(running().options.env.CH_SKIP_DOCKER_INSTALL).toBeUndefined();
    expect(running().options.env.CI).toBeUndefined();
    // ...and keeps the Homebrew directories the installer is found in
    expect(running().options.env.PATH).toContain('/opt/homebrew/bin');
    vi.unstubAllEnvs();
  });

  it('reports whole lines, however the output arrives in chunks', () => {
    install.installDocker(report);
    running().child.stdout.emit('data', Buffer.from('[docker] Docker was not fo'));
    expect(heard).toEqual([]);
    running().child.stdout.emit('data', Buffer.from('und. Installing it...\n[docker] running'));
    expect(heard).toEqual([{ line: '[docker] Docker was not found. Installing it...' }]);
  });

  it('reports what the installer put on stderr too, which is where Homebrew talks', () => {
    install.installDocker(report);
    running().child.stderr.emit('data', Buffer.from('==> Fetching colima\n'));
    expect(heard).toEqual([{ line: '==> Fetching colima' }]);
  });

  it('says the last line even when nothing ended it, then that it is over', () => {
    install.installDocker(report);
    running().child.stdout.emit('data', Buffer.from('[docker] Docker is ready.'));
    running().child.emit('exit', 0);
    expect(heard).toEqual([{ line: '[docker] Docker is ready.' }, { done: true, ok: true }]);
  });

  it('reports an install that exited badly as one, and stops holding the process', () => {
    install.installDocker(report);
    running().child.emit('exit', 1);
    expect(heard).toEqual([{ done: true, ok: false }]);
    expect(install.installing()).toBe(false);
  });

  it('runs one at a time, and another afterwards', () => {
    install.installDocker(report);
    install.installDocker(report);
    expect(electron.forks).toHaveLength(1);
    expect(install.installing()).toBe(true);

    running().child.emit('exit', 0);
    install.installDocker(report);
    expect(electron.forks).toHaveLength(2);
  });

  it('reports a process that could not be started at all, rather than throwing at the window', () => {
    electron.failWith = new Error('no such file');
    install.installDocker(report);
    expect(heard).toEqual([{ done: true, ok: false, error: 'no such file' }]);
    expect(install.installing()).toBe(false);
  });

  it('gives up on the one that is running, and lets another be started', () => {
    install.installDocker(report);
    const { child } = running();
    install.cancel();
    expect(child.kill).toHaveBeenCalled();
    expect(install.installing()).toBe(false);
    install.installDocker(report);
    expect(electron.forks).toHaveLength(2);
  });
});

describe('what the app cannot install itself', () => {
  it('opens the download page in the user’s own browser', () => {
    install.download('ollama');
    install.download('docker');
    expect(electron.opened).toEqual([install.DOWNLOADS.ollama, install.DOWNLOADS.docker]);
    expect(install.DOWNLOADS.ollama).toContain('ollama.com');
  });

  it('opens nothing for anything else', () => {
    install.download('nonsense' as 'ollama');
    expect(electron.opened).toEqual([]);
  });
});

// A packaged app runs out of an archive, and a process cannot be started from
// inside one (see SCRIPT)
describe('where the installer is found', () => {
  const packaged = path.join('/Apps', 'ch.app', 'Contents', 'Resources', 'app.asar', 'dist', 'setup');

  it('is the copy left unpacked beside the archive, in a packaged app', () => {
    expect(install.scriptPath(packaged, () => true)).toBe(
      path.join('/Apps', 'ch.app', 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'scripts', 'install-docker.js')
    );
  });

  it('falls back to the archive itself, which Electron can at least read', () => {
    expect(install.scriptPath(packaged, () => false)).toContain(`app.asar${path.sep}`);
  });

  it('is the script where it lies when the app is not packaged at all', () => {
    const dir = path.join('/work', 'ch', 'dist', 'setup');
    expect(install.scriptPath(dir, () => true)).toBe(path.join('/work', 'ch', 'dist', 'scripts', 'install-docker.js'));
  });
});
