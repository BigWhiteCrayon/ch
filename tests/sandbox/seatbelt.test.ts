// Confining a command on the user's own computer (see ../../src/sandbox/seatbelt.ts). What the profiles allow is
// the kernel's to decide, so on a Mac the commands here are run for real, and what they are kept from is tried.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as seatbelt from '../../src/sandbox/seatbelt';

describe('where commands can be confined', () => {
  it('is a Mac, and nowhere else', () => {
    expect(seatbelt.available('linux')).toBe(false);
    expect(seatbelt.available('win32')).toBe(false);
  });
});

describe('the argv that confines a command', () => {
  it('runs the command itself, unchanged, under sandbox-exec', () => {
    const argv = seatbelt.confine(['grep', '-rn', 'a b', '.']);
    expect(argv[0]).toBe(seatbelt.SANDBOX_EXEC);
    expect(argv.slice(-4)).toEqual(['grep', '-rn', 'a b', '.']);
    expect(argv[2]).toContain('(deny file-write*)');
    expect(argv[2]).toContain('(deny network*)');
  });

  it('gives the folders it may write in as parameters, never as part of the profile', () => {
    const odd = path.join(os.tmpdir(), 'a") (allow file-write* (subpath "/');
    const argv = seatbelt.confine(['git', 'commit'], [odd]);
    expect(argv[2]).not.toContain(odd);
    expect(argv).toContain(`W0=${odd}`);
    // ...and always the temporary folder, where git and its hooks keep what they are working on
    expect(argv.some((arg) => arg === `W1=${fs.realpathSync(os.tmpdir())}`)).toBe(true);
  });
});

describe.runIf(seatbelt.available())('what a confined command is kept from', () => {
  let dir: string;
  let outside: string;
  const run = (argv: string[], writable: string[] | null = null, cwd = dir) => {
    const [program, ...args] = seatbelt.confine(argv, writable);
    return spawnSync(program, args, { cwd, encoding: 'utf8' });
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.seatbelt-outside-')));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'b\na\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('reads, and writes nothing at all, wherever it is pointed', () => {
    expect(run(['cat', 'a.txt']).stdout).toBe('b\na\n');
    // What got round the lists of what may be named: a reading program's own flag that writes
    expect(run(['sort', '-o', 'a.txt', 'a.txt']).status).not.toBe(0);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('b\na\n');
    expect(run(['touch', path.join(outside, 'x')]).status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'x'))).toBe(false);
  });

  it('reaches no network, and asks no system service to act for it', () => {
    expect(run(['curl', '-s', '-m', '5', 'https://example.com']).status).not.toBe(0);
    expect(run(['defaults', 'write', 'com.example.ch-seatbelt-test', 'k', 'v']).status).not.toBe(0);
  });

  it('runs the git that ships with macOS without a warning, its temporary folder found', () => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const ran = run(['git', 'status', '--short']);
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe('');
  });

  it('lets a git that changes the repository write there and nowhere else, its hooks included', () => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\necho escaped > '${path.join(outside, 'hook.txt')}'\n`, { mode: 0o755 });
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    expect(run(['git', 'add', 'a.txt'], [dir]).status).toBe(0);
    // The hook is what fails, and git with it: the commit does not happen
    expect(run(['git', ...identity, 'commit', '-qm', 'one'], [dir]).status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'hook.txt'))).toBe(false);
    fs.rmSync(hook);
    expect(run(['git', ...identity, 'commit', '-qm', 'one'], [dir]).status).toBe(0);
    expect(spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout).toContain('one');
  });
});
