// Git worktrees for threads that work on a branch of a repository. Each branch
// gets a checkout of its own under the app's data directory, so that a thread
// can work on it without disturbing what the user has checked out in the
// repository itself. This runs git on the host and must not import electron,
// so that it can be used and tested outside the app.

import { spawn } from 'child_process';
import crypto from 'crypto';
import { join } from 'path';
import { toolEnv } from './env';
import type { BranchStatus } from '../types';

type GitResult = { code: number | null; output: string };

// Runs git in the repository and resolves with how it ended and what it wrote.
// A git that cannot be started resolves like one that failed, so that callers
// have only the exit code to look at.
function git(repo: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...args], { env: toolEnv() });
    let output = '';
    const collect = (chunk: Buffer | string) => {
      output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ code: null, output: err.code === 'ENOENT' ? 'The "git" command was not found.' : err.message });
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

// The local branches of a repository and the one checked out. `current` is null
// when HEAD is detached. A folder that is not a repository has no branches.
export async function branches(repo: string): Promise<{ current: string | null; names: string[] }> {
  const list = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (list.code !== 0) return { current: null, names: [] };
  const current = await git(repo, ['branch', '--show-current']);
  return {
    current: (current.code === 0 && current.output.trim()) || null,
    names: list.output.split('\n').filter(Boolean),
  };
}

// The repository's main worktree: the folder the user has checked out, whichever of its worktrees `dir` is. Git lists
// that one first. Branches and their folders are made against it, so that a branch asked for by a thread already on
// one lands where it would have had the thread been on what the user has checked out. Null for a folder that is not a
// repository.
export async function mainWorktree(dir: string): Promise<string | null> {
  const listed = await git(dir, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return null;
  const first = listed.output.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() || null : null;
}

// The remote branch the worktree's branch tracks, like "origin/feature"; null if it tracks none
async function upstreamOf(worktree: string): Promise<string | null> {
  const found = await git(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return found.code === 0 ? found.output.trim() || null : null;
}

// Where the worktree's branch stands: what it tracks, how far ahead of and behind that it is, and whether there is
// work in the folder that is not committed
export async function status(worktree: string): Promise<BranchStatus> {
  const upstream = await upstreamOf(worktree);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await git(worktree, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    // "<behind>\t<ahead>": the left side of the range is the upstream's
    const [left, right] = counts.output.trim().split(/\s+/).map(Number);
    if (counts.code === 0) [behind, ahead] = [left || 0, right || 0];
  }
  const changed = await git(worktree, ['status', '--porcelain']);
  if (changed.code !== 0) throw new Error(changed.output.trim());
  return { upstream, ahead, behind, dirty: changed.output.trim() !== '' };
}

// Commits everything in the worktree. False, with nothing done, if there was nothing to commit.
export async function commit(worktree: string, message: string): Promise<boolean> {
  if (!message.trim()) throw new Error('A commit needs a message.');
  const added = await git(worktree, ['add', '-A']);
  if (added.code !== 0) throw new Error(added.output.trim());
  const changed = await git(worktree, ['status', '--porcelain']);
  if (changed.code !== 0) throw new Error(changed.output.trim());
  if (!changed.output.trim()) return false;
  const made = await git(worktree, ['commit', '-m', message.trim()]);
  if (made.code !== 0) throw new Error(made.output.trim());
  return true;
}

// Pushes the worktree's branch to origin. The first time it also makes origin's the branch's upstream, so that
// later pushes, pulls and the counts in status() have something to compare with. Resolves with the upstream.
export async function push(worktree: string): Promise<string> {
  const before = await upstreamOf(worktree);
  let pushed: GitResult;
  if (before) {
    pushed = await git(worktree, ['push']);
  } else {
    const current = await git(worktree, ['branch', '--show-current']);
    const name = current.output.trim();
    if (current.code !== 0 || !name) throw new Error('This worktree is not on a branch, so there is nothing to push.');
    pushed = await git(worktree, ['push', '-u', 'origin', name]);
  }
  if (pushed.code !== 0) throw new Error(pushed.output.trim());
  return (await upstreamOf(worktree)) ?? before ?? '';
}

// Brings the upstream's new commits into the worktree. Fast-forward only: a branch that has gone its own way is for
// the user to reconcile, not for the app to merge on its own.
export async function pull(worktree: string): Promise<void> {
  const pulled = await git(worktree, ['pull', '--ff-only']);
  if (pulled.code !== 0) throw new Error(pulled.output.trim());
}

// Takes a worktree away once nothing is using it. Without --force git refuses one that has uncommitted or untracked
// files in it, so work is never thrown away here; the branch and its commits stay in the repository either way.
export async function remove(repo: string, worktree: string): Promise<void> {
  const removed = await git(repo, ['worktree', 'remove', worktree]);
  if (removed.code !== 0) throw new Error(removed.output.trim());
  await git(repo, ['worktree', 'prune']);
}

// The path of a worktree with the branch checked out, making one under `root`
// if there is none. With `create` the branch is made first, starting at `base`.
export async function ensureWorktree(
  repo: string,
  root: string,
  branch: string,
  base: string,
  create: boolean
): Promise<string> {
  // Git's own rules, so that a name that would be refused later, or that would
  // be read as an option, is turned away before anything is touched.
  const valid = await git(repo, ['check-ref-format', '--branch', branch]);
  if (valid.code !== 0) throw new Error(valid.output.trim() || `"${branch}" is not a valid branch name.`);

  // A worktree whose folder has been deleted still counts as having the branch
  // checked out until it is pruned, and would make the add below fail.
  await git(repo, ['worktree', 'prune']);
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) throw new Error(listed.output.trim());
  for (const entry of listed.output.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/);
    if (lines.includes(`branch refs/heads/${branch}`)) {
      const found = lines.find((line) => line.startsWith('worktree '));
      if (found) return found.slice('worktree '.length);
    }
  }

  // The repository's path keeps two repositories that have a branch of the same
  // name apart; the branch is encoded because it may contain slashes.
  const folder = join(
    root,
    'worktrees',
    crypto.createHash('sha256').update(repo).digest('hex').slice(0, 12),
    encodeURIComponent(branch)
  );
  const added = await git(
    repo,
    create ? ['worktree', 'add', '-b', branch, folder, base] : ['worktree', 'add', folder, branch]
  );
  if (added.code !== 0) throw new Error(added.output.trim());
  return folder;
}
