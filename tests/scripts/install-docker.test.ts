import { describe, expect, it } from 'vitest';
import { findBrew, main, type System } from '../../src/scripts/install-docker';

// A stand-in for the machine: which commands succeed, which files exist.
function fakeSystem(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  isRoot?: boolean;
  files?: string[];
  // Commands ("docker info") that exit 0 when checked quietly
  working?: string[];
  // Called for every command run for real; returns whether it succeeded
  onRun?: (command: string, state: { working: Set<string> }) => boolean;
}) {
  const working = new Set(options.working ?? []);
  const ran: string[] = [];
  const logs: string[] = [];
  const system: System = {
    platform: options.platform ?? 'darwin',
    arch: options.arch ?? 'arm64',
    env: options.env ?? {},
    dryRun: options.dryRun ?? false,
    isRoot: options.isRoot ?? false,
    exists: (file) => (options.files ?? []).includes(file),
    succeeds: (command, args) => working.has([command, ...args].join(' ')),
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      ran.push(line);
      return options.onRun ? options.onRun(line, { working }) : true;
    },
    log: (message) => logs.push(message),
  };
  return { system, ran, logs };
}

describe('findBrew', () => {
  it('prefers the native Homebrew on Apple Silicon', () => {
    const { system } = fakeSystem({
      arch: 'arm64',
      files: ['/usr/local/bin/brew', '/opt/homebrew/bin/brew'],
    });
    expect(findBrew(system)).toBe('/opt/homebrew/bin/brew');
  });

  it('prefers the Intel prefix on Intel Macs', () => {
    const { system } = fakeSystem({
      arch: 'x64',
      files: ['/usr/local/bin/brew', '/opt/homebrew/bin/brew'],
    });
    expect(findBrew(system)).toBe('/usr/local/bin/brew');
  });

  it('returns undefined when Homebrew is not installed', () => {
    expect(findBrew(fakeSystem({}).system)).toBeUndefined();
  });
});

describe('main', () => {
  it.each(['CH_SKIP_DOCKER_INSTALL', 'CI'])('does nothing when %s is set', (name) => {
    const { system, ran, logs } = fakeSystem({ env: { [name]: '1' } });
    main(system);
    expect(ran).toEqual([]);
    expect(logs).toEqual(['Skipping Docker setup.']);
  });

  it('changes nothing when Docker is installed and running', () => {
    const { system, ran, logs } = fakeSystem({ working: ['docker --version', 'docker info'] });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.at(-1)).toContain('Docker is running');
  });

  it('starts Colima when Docker is installed but not running', () => {
    const { system, ran, logs } = fakeSystem({ working: ['docker --version', 'colima version'] });
    main(system);
    expect(ran).toEqual(['colima start']);
    expect(logs.at(-1)).toBe('Docker is ready.');
  });

  it('asks the user to start Docker when it is not running and Colima is absent', () => {
    const { system, ran, logs } = fakeSystem({ working: ['docker --version'] });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.at(-1)).toContain('installed but not running');
  });

  it('installs Colima and Docker through Homebrew on macOS, then starts Colima', () => {
    const { system, ran, logs } = fakeSystem({
      files: ['/opt/homebrew/bin/brew'],
      onRun: (command, { working }) => {
        if (command.includes('brew install')) working.add('docker --version');
        return true;
      },
    });
    main(system);
    expect(ran).toEqual(['/opt/homebrew/bin/brew install colima docker', 'colima start']);
    expect(logs.at(-1)).toBe('Docker is ready.');
  });

  it('explains how to get Homebrew when it is missing on macOS', () => {
    const { system, ran, logs } = fakeSystem({});
    main(system);
    expect(ran).toEqual([]);
    expect(logs.join('\n')).toContain('https://brew.sh');
  });

  it('stops when the install command fails', () => {
    const { system, ran } = fakeSystem({ files: ['/opt/homebrew/bin/brew'], onRun: () => false });
    main(system);
    expect(ran).toEqual(['/opt/homebrew/bin/brew install colima docker']);
  });

  it('reports when the install succeeded but docker is still not found', () => {
    const { system, ran, logs } = fakeSystem({ files: ['/opt/homebrew/bin/brew'] });
    main(system);
    expect(ran).toHaveLength(1);
    expect(logs.at(-1)).toContain('still not available');
  });

  it('only prints the plan on a dry run', () => {
    const { system, ran, logs } = fakeSystem({ dryRun: true, files: ['/opt/homebrew/bin/brew'] });
    main(system);
    expect(ran).toEqual([]);
    expect(logs).toContain('would run: /opt/homebrew/bin/brew install colima docker');
    expect(logs).toContain('would run: colima start');
    expect(logs.at(-1)).toBe('Dry run complete; nothing was changed.');
  });

  it('uses the official script through sudo on Linux when sudo needs no password', () => {
    const { system, ran } = fakeSystem({
      platform: 'linux',
      working: ['sudo -n true'],
      onRun: (_command, { working }) => {
        working.add('docker --version');
        working.add('docker info');
        return true;
      },
    });
    main(system);
    expect(ran).toEqual(['sh -c curl -fsSL https://get.docker.com | sudo sh']);
  });

  it('skips sudo on Linux when already root', () => {
    const { system, ran } = fakeSystem({ platform: 'linux', isRoot: true });
    main(system);
    expect(ran).toEqual(['sh -c curl -fsSL https://get.docker.com | sh']);
  });

  it('prints the command instead of prompting for a password on Linux', () => {
    const { system, ran, logs } = fakeSystem({ platform: 'linux' });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.join('\n')).toContain('curl -fsSL https://get.docker.com | sudo sh');
  });

  it('installs Docker Desktop through winget on Windows', () => {
    const { system, ran } = fakeSystem({ platform: 'win32', working: ['winget --version'] });
    main(system);
    expect(ran[0]).toBe('winget install -e --id Docker.DockerDesktop');
  });

  it('points to the download page on Windows without winget', () => {
    const { system, ran, logs } = fakeSystem({ platform: 'win32' });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.join('\n')).toContain('docker.com/products/docker-desktop');
  });

  it('says so on a platform it cannot install for', () => {
    const { system, logs } = fakeSystem({ platform: 'freebsd' });
    main(system);
    expect(logs.at(-1)).toContain('not supported on freebsd');
  });
});
