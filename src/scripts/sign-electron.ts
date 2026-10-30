#!/usr/bin/env node
// Gives the Electron the app runs under in development a signature macOS will
// accept notifications from. Runs automatically after `npm install`, or by
// hand with `npm run sign-electron`. macOS only; a no-op everywhere else.
//
// Electron's prebuilt macOS binaries ship with no signature of their own: the
// zip carries no _CodeSignature, so the bundle is left ad-hoc "linker-signed"
// with its Info.plist unbound and no sealed resources. macOS will not register
// a bundle in that state with Notification Center, so every notification the
// app posts fails with UNErrorCodeNotificationsNotAllowed — silently, since
// the HTML5 Notification in the page is given no error to report either (see
// notify in renderer.ts).
//
// Signing it ad-hoc, deeply, binds the Info.plist and seals the bundle, which
// is all macOS wants before it will let the app ask. Nothing here needs a
// certificate: the signature is only for this machine, and a packaged build
// signs itself properly anyway.
//
// Never fails the surrounding `npm install`: an app whose notifications do
// not show still runs, and everything else about it works.
//
// Set CH_SKIP_ELECTRON_SIGN=1 to skip. Pass --dry-run to only print the plan.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Everything the signer touches outside itself, so tests can stand in for it
export interface System {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  exists(file: string): boolean;
  // Runs with its output shown; true if the command exited with 0
  run(command: string, args: string[]): boolean;
  // What the command said about itself, on either stream; '' if it would not run
  read(command: string, args: string[]): string;
  log(message: string): void;
}

// Beside node_modules, wherever the package was installed
export const APP = path.join('node_modules', 'electron', 'dist', 'Electron.app');

export function realSystem(argv: string[] = process.argv): System {
  return {
    platform: process.platform,
    env: process.env,
    dryRun: argv.includes('--dry-run'),
    exists: (file) => fs.existsSync(file),
    run: (command, args) => spawnSync(command, args, { stdio: 'inherit' }).status === 0,
    read: (command, args) => {
      const done = spawnSync(command, args, { encoding: 'utf8' });
      return `${done.stdout ?? ''}${done.stderr ?? ''}`;
    },
    log: (message) => console.log(`[electron-sign] ${message}`),
  };
}

// Whether the bundle is already sealed, which is the part of a signature macOS
// is after. An unsigned bundle reports no sealed resources ("Sealed
// Resources=none"), and one that cannot be read at all is taken as unsigned.
export function isSealed(system: System): boolean {
  return /Sealed Resources version=/.test(system.read('codesign', ['-dv', '--verbose=2', APP]));
}

export function main(system: System = realSystem()): void {
  const { log, dryRun } = system;

  if (system.env.CH_SKIP_ELECTRON_SIGN === '1') return log('CH_SKIP_ELECTRON_SIGN=1, skipping.');
  // The other platforms' notifications ask nothing of the binary's signature
  if (system.platform !== 'darwin') return;
  if (!system.exists(APP)) return log(`No Electron at ${APP}, nothing to sign.`);
  if (isSealed(system)) return log('Electron is already signed.');

  const args = ['--force', '--deep', '--sign', '-', APP];
  log(`${dryRun ? 'would run' : 'running'}: codesign ${args.join(' ')}`);
  if (dryRun) return;
  if (system.run('codesign', args)) log('Signed; macOS will let the app post notifications.');
  // Worth saying, since the only sign of it otherwise is notifications never
  // appearing. Not worth stopping the install for.
  else log('Could not sign Electron. Notifications will not show until `npm run sign-electron` succeeds.');
}

// Not when a test imports it
if (require.main === module) main();
