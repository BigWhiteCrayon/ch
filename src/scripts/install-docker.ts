#!/usr/bin/env node
// Installs Docker if it is missing, then makes sure it is running. Runs
// automatically after `npm install`, or by hand with `npm run install-docker`.
//
//   macOS    Colima + the docker CLI through Homebrew (no sudo, no GUI)
//   Linux    Docker's official install script, if sudo works without a password
//   Windows  Docker Desktop through winget
//
// Never fails the surrounding `npm install`: problems are reported and the
// app still works for plain chat without Docker.
//
// Set CH_SKIP_DOCKER_INSTALL=1 to skip. Pass --dry-run to only print the plan.

import { spawnSync } from 'child_process';
import fs from 'fs';
import { toolEnv } from '../sandbox/env';

// Everything the installer touches outside itself, so tests can stand in for it
export interface System {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  isRoot: boolean;
  exists(file: string): boolean;
  // Runs quietly; true if the command exited with 0
  succeeds(command: string, args: string[]): boolean;
  // Runs with its output shown; true if the command exited with 0
  run(command: string, args: string[]): boolean;
  log(message: string): void;
}

export function realSystem(argv: string[] = process.argv): System {
  const env = toolEnv();
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    dryRun: argv.includes('--dry-run'),
    isRoot: process.getuid?.() === 0,
    exists: (file) => fs.existsSync(file),
    succeeds: (command, args) => spawnSync(command, args, { env, stdio: 'ignore' }).status === 0,
    run: (command, args) => spawnSync(command, args, { env, stdio: 'inherit' }).status === 0,
    log: (message) => console.log(`[docker] ${message}`),
  };
}

export function findBrew(system: System): string | undefined {
  // On Apple Silicon prefer the native Homebrew over an older Intel-prefix one
  const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  if (system.arch !== 'arm64') candidates.reverse();
  return candidates.find((candidate) => system.exists(candidate));
}

export function main(system: System = realSystem()): void {
  const { log, dryRun } = system;
  let installedColima = false;

  const run = (command: string, args: string[]) => {
    log(`${dryRun ? 'would run' : 'running'}: ${command} ${args.join(' ')}`);
    return dryRun ? true : system.run(command, args);
  };
  const hasDocker = () => system.succeeds('docker', ['--version']);
  const daemonRunning = () => system.succeeds('docker', ['info']);

  function installMac(): boolean {
    const brew = findBrew(system);
    if (!brew) {
      log('Homebrew is needed to install Docker automatically. Install it from https://brew.sh');
      log('then run: npm run install-docker');
      return false;
    }
    installedColima = true;
    return run(brew, ['install', 'colima', 'docker']);
  }

  function installLinux(): boolean {
    if (!system.isRoot && !system.succeeds('sudo', ['-n', 'true'])) {
      log('Installing Docker needs administrator rights. Run this yourself:');
      log('  curl -fsSL https://get.docker.com | sudo sh');
      return false;
    }
    const sh = system.isRoot ? 'sh' : 'sudo sh';
    return run('sh', ['-c', `curl -fsSL https://get.docker.com | ${sh}`]);
  }

  function installWindows(): boolean {
    if (!system.succeeds('winget', ['--version'])) {
      log('Install Docker Desktop from https://www.docker.com/products/docker-desktop/');
      return false;
    }
    return run('winget', ['install', '-e', '--id', 'Docker.DockerDesktop']);
  }

  function install(): boolean {
    if (system.platform === 'darwin') return installMac();
    if (system.platform === 'linux') return installLinux();
    if (system.platform === 'win32') return installWindows();
    log(`Automatic install is not supported on ${system.platform}.`);
    return false;
  }

  function start(): boolean {
    // Colima is what the macOS install sets up; the first start downloads its VM
    if (installedColima || system.succeeds('colima', ['version'])) return run('colima', ['start']);
    log('Docker is installed but not running. Start Docker, then use the app.');
    return false;
  }

  if (system.env.CH_SKIP_DOCKER_INSTALL || system.env.CI) {
    log('Skipping Docker setup.');
    return;
  }

  if (hasDocker()) {
    log('Docker is already installed.');
  } else {
    log('Docker was not found. Installing it...');
    if (!install()) return;
    if (!dryRun && !hasDocker()) {
      log('The install finished but the "docker" command is still not available.');
      return;
    }
  }

  if (!dryRun && daemonRunning()) {
    log('Docker is running. Threads can use their sandboxes.');
  } else if (start()) {
    log(dryRun ? 'Dry run complete; nothing was changed.' : 'Docker is ready.');
  }
}

if (typeof require !== 'undefined' && require.main === module) main();
