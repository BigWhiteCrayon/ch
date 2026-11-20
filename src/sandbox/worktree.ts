// Git worktrees for threads that work on a branch of a repository. Each branch
// gets a checkout of its own under the app's data directory, so that a thread
// can work on it without disturbing what the user has checked out in the
// repository itself. This runs git on the host and must not import electron,
// so that it can be used and tested outside the app.

import { spawn } from 'child_process';
import crypto from 'crypto';
import { join, resolve } from 'path';
import { toolEnv } from './env';
import type { BranchStatus } from '../types';

// `output` is everything git said, which is what an error carries; `stdout` is what it wrote to be read, kept apart
// for the one caller that parses rather than reports (see mergeToDefault).
type GitResult = { code: number | null; output: string; stdout: string };

// Runs git in the repository and resolves with how it ended and what it wrote.
// A git that cannot be started resolves like one that failed, so that callers
// have only the exit code to look at.
function git(repo: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...args], { env: toolEnv() });
    let output = '';
    let out = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      out += chunk;
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      output += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      const message = err.code === 'ENOENT' ? 'The "git" command was not found.' : err.message;
      resolve({ code: null, output: message, stdout: '' });
    });
    child.on('close', (code) => resolve({ code, output, stdout: out }));
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

// Work on one worktree waiting its turn. Threads on the same branch share the worktree's folder, so what one writes
// and commits there must not be interleaved with another's. Keyed by the folder, in this process only.
const turns = new Map<string, Promise<unknown>>();
export function withWorktreeLock<T>(worktree: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(worktree);
  const run = (turns.get(key) ?? Promise.resolve()).then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  turns.set(key, settled);
  // Nothing is left behind once the last one in line is done
  void settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key);
  });
  return run;
}

// Commits just these files, as they are in the worktree now, so that what else is loose or staged there (another
// thread's work) stays out of it. Resolves with the new commit's hash, or null, with nothing done, if the files are
// already as the branch has them.
export async function commitPaths(worktree: string, paths: string[], message: string): Promise<string | null> {
  if (!message.trim()) throw new Error('A commit needs a message.');
  if (paths.length === 0) return null;
  const run = (...args: string[]) => git(worktree, ['--literal-pathspecs', ...args]);
  const added = await run('add', '-A', '--', ...paths);
  if (added.code !== 0) throw new Error(added.output.trim());
  const staged = await run('diff', '--cached', '--quiet', '--', ...paths);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(staged.output.trim());
  // Naming the paths again makes the commit take only them, whatever else is staged
  const made = await run('commit', '-m', message.trim(), '--', ...paths);
  if (made.code !== 0) throw new Error(made.output.trim());
  const head = await run('rev-parse', 'HEAD');
  if (head.code !== 0) throw new Error(head.output.trim());
  return head.stdout.trim();
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

// The repository's default branch: what "main" means in it, asked of the repository rather than assumed, since not
// every one calls it that. What origin's HEAD points at is the answer where there is a remote to have one; failing
// that, whichever of the two usual names the repository has a branch under. Null where it has neither.
export async function defaultBranch(repo: string): Promise<string | null> {
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0) {
    const name = head.output.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const name of ['main', 'master']) {
    const found = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    if (found.code === 0) return name;
  }
  return null;
}

// The worktree holding `branch`, or null where none does. A branch no worktree has checked out can be moved on by
// its ref alone; one a worktree holds has files that the ref moving would leave behind it (see mergeToDefault).
export async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) throw new Error(listed.output.trim());
  for (const entry of listed.output.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/);
    if (!lines.includes(`branch refs/heads/${branch}`)) continue;
    const found = lines.find((line) => line.startsWith('worktree '));
    if (found) return found.slice('worktree '.length).trim() || null;
  }
  return null;
}

export interface Merged {
  // The branch merged, and the branch it was merged into
  branch: string;
  target: string;
  // Where the target stands now
  sha: string;
  // Whether the target had moved on and was brought into the branch on the way
  brought: boolean;
  // Whether the target already had the branch, so that nothing was done
  already: boolean;
}

// Merges the worktree's branch into the repository's default branch, with that branch checked out nowhere for it.
//
// The order is the whole of it. What the target has and the branch has not is merged into the *branch* first, in the
// branch's own folder: that is where a conflict belongs, because that is where the thread works, where its container
// was made from and where what it settles on can be tried before anyone else sees it. Once that is done the branch
// holds everything the target holds, so the target has only to be moved forward onto it — a fast-forward, which
// needs no working tree and cannot conflict. The target therefore never holds a half-settled merge, and no folder
// anywhere has to have it checked out for this.
//
// Nothing is written where the first merge would conflict: it is tried against the commits first, and the merge only
// runs when that comes out clean.
export async function mergeToDefault(repo: string, tree: string): Promise<Merged> {
  const target = await defaultBranch(repo);
  if (!target) throw new Error('This repository has no main branch to merge into.');
  const current = await git(tree, ['branch', '--show-current']);
  const branch = current.output.trim();
  if (current.code !== 0 || !branch) throw new Error('This folder is not on a branch, so it has nothing to merge.');
  if (branch === target) throw new Error(`This folder is on ${target} itself, so there is nothing to merge into it.`);

  // Committed work only: what is merged is the branch's commits, and anything still loose in the folder would be
  // left out of the merge while looking as though it went in.
  const changed = await git(tree, ['status', '--porcelain']);
  if (changed.code !== 0) throw new Error(changed.output.trim());
  if (changed.output.trim()) {
    throw new Error(
      `There is work in ${tree} that is not committed, and a merge carries commits only. Commit it first, then ` +
        'merge.'
    );
  }

  const ahead = await git(repo, ['rev-list', '--count', `${target}..${branch}`]);
  if (ahead.code !== 0) throw new Error(ahead.output.trim());
  if (Number(ahead.output.trim()) === 0) {
    const at = await git(repo, ['rev-parse', target]);
    return { branch, target, sha: at.output.trim(), brought: false, already: true };
  }

  const behind = await git(repo, ['rev-list', '--count', `${branch}..${target}`]);
  if (behind.code !== 0) throw new Error(behind.output.trim());
  const brought = Number(behind.output.trim()) > 0;
  if (brought) {
    const tried = await git(repo, ['merge-tree', '--write-tree', '--name-only', branch, target]);
    if (tried.code !== 0) {
      // What it writes is the merged tree, then a line for each file that clashed, then a blank line and an account
      // of the clashes meant for reading. The names are what is wanted, so it stops at that blank line.
      const names: string[] = [];
      for (const line of tried.stdout.split(/\r?\n/).slice(1)) {
        if (!line.trim()) break;
        names.push(line.trim());
      }
      throw new Error(
        `${target} has moved on since ${branch} left it, and bringing it in conflicts in ` +
          `${names.join(', ') || 'this branch'}. Nothing has been changed. Settle it in ${tree} — merge ${target} ` +
          'there, fix what clashes and commit — then merge again.'
      );
    }
    const merged = await git(tree, ['merge', '--no-edit', target]);
    if (merged.code !== 0) {
      await git(tree, ['merge', '--abort']);
      throw new Error(
        `Bringing ${target} into ${branch} failed, and nothing has been changed: ${merged.output.trim()}`
      );
    }
  }

  const tip = await git(tree, ['rev-parse', 'HEAD']);
  if (tip.code !== 0) throw new Error(tip.output.trim());
  const sha = tip.output.trim();

  // Where a worktree holds the target, the move is that worktree's own fast-forward, so its files come with it and a
  // folder with uncommitted work in it refuses rather than being written over. Where none holds it, the ref is moved
  // on its own, told the commit it is expected to be at: a target that moved while this ran is refused, not lost.
  const held = await checkedOutAt(repo, target);
  if (held) {
    const forward = await git(held, ['merge', '--ff-only', branch]);
    if (forward.code !== 0) {
      throw new Error(
        `${target} is checked out in ${held} and could not be moved forward onto ${branch}: ${forward.output.trim()}`
      );
    }
  } else {
    const was = await git(repo, ['rev-parse', target]);
    if (was.code !== 0) throw new Error(was.output.trim());
    const moved = await git(repo, ['update-ref', `refs/heads/${target}`, sha, was.output.trim()]);
    if (moved.code !== 0) throw new Error(moved.output.trim());
  }
  return { branch, target, sha, brought, already: false };
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
