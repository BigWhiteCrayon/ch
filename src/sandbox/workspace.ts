// Workspaces: plain folders, each its own git repository, for threads that are not tied to a project the user already
// has. They all live under one directory so that the app can tell its own folders from the user's. This runs git on
// the host and must not import electron, so that it can be used and tested outside the app.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { toolEnv } from './env';

type GitResult = { code: number | null; output: string; missing: boolean };

// Runs git in the folder and resolves with how it ended and what it wrote. `missing` tells a git that is not
// installed from one that failed, because only the first has a message of its own.
function git(folder: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', folder, ...args], { env: toolEnv() });
    let output = '';
    const collect = (chunk: Buffer | string) => {
      output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ code: null, output: err.message, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => resolve({ code, output, missing: false }));
  });
}

// Like git(), but a failure is thrown, with git's own output as the message
async function run(folder: string, args: string[]): Promise<string> {
  const result = await git(folder, args);
  if (result.missing) throw new Error('The "git" command was not found, so a workspace cannot be set up.');
  if (result.code !== 0) throw new Error(result.output.trim() || `git ${args[0]} failed.`);
  return result.output;
}

// The directory that holds the workspaces. CH_WORKSPACES_DIR moves it, which is also how tests keep clear of the
// user's real folders.
export function root(): string {
  const configured = process.env.CH_WORKSPACES_DIR;
  return configured && configured.trim() ? configured : path.join(os.homedir(), 'ch-workspaces');
}

// A name the user typed, made into one safe folder name: no separators or other characters a file system may object
// to, and no leading dot or dash that would make it hidden or look like an option.
export function folderName(name: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  if (!safe) throw new Error('A workspace needs a name.');
  return safe;
}

// Makes a new folder under `parent` and sets it up as a repository; resolves with its absolute path. The folder
// never exists already: a taken name gets "-2", "-3" and so on.
export async function create(name: string, parent = root()): Promise<string> {
  const base = folderName(name);
  fs.mkdirSync(parent, { recursive: true });
  // mkdirSync without `recursive` fails if the folder exists, so claiming the name and checking it are one step and
  // two creations at the same moment cannot end up in the same folder.
  let folder = '';
  for (let n = 1; n <= 100 && !folder; n++) {
    const candidate = path.resolve(parent, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(candidate);
      folder = candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  if (!folder) throw new Error(`There are too many workspaces called "${base}".`);

  try {
    await run(folder, ['init']);
    // Not `init -b main`, which older gits do not have
    await run(folder, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    // A commit needs an identity. Only fill in what the user has not set, and only for this repository.
    const identity: [string, string][] = [
      ['user.email', 'ch@localhost'],
      ['user.name', 'ch'],
    ];
    for (const [key, value] of identity) {
      const current = await git(folder, ['config', key]);
      if (!current.missing && current.output.trim()) continue;
      await run(folder, ['config', key, value]);
    }
    // Branches and worktrees (see worktree.ts) need a commit to start from
    await run(folder, ['commit', '--allow-empty', '-m', 'Initial commit']);
  } catch (err) {
    // Do not leave a half-made folder behind to take up the name
    fs.rmSync(folder, { recursive: true, force: true });
    throw err;
  }
  return folder;
}

// Whether the folder is a workspace the app made: a direct child of `parent` that is a repository with a commit.
// Symlinks are resolved first, so a link or a ".." cannot make a folder elsewhere look managed.
export async function isManaged(workspace: string, parent = root()): Promise<boolean> {
  try {
    const real = fs.realpathSync(workspace);
    if (path.dirname(real) !== fs.realpathSync(parent)) return false;
    if (!fs.statSync(real).isDirectory()) return false;
    return (await git(real, ['rev-parse', '--verify', 'HEAD'])).code === 0;
  } catch {
    return false;
  }
}
