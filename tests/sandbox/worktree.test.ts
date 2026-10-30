import { EventEmitter } from 'events';
import { join } from 'path';
import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for child_process.spawn. Each test supplies `respond`, which
// decides how a git command ends; nothing is really run.
type Outcome = { code?: number | null; stdout?: string; stderr?: string };

const proc = vi.hoisted(() => ({
  spawn: undefined as any,
  respond: (_args: string[]): Outcome => ({ code: 0 }),
}));

proc.spawn = vi.fn((command: string, args: string[], options: any) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  Promise.resolve().then(() => {
    const outcome = proc.respond(args);
    if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout));
    if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
    child.emit('close', outcome.code ?? 0);
  });
  return child;
});

vi.mock('child_process', () => ({ spawn: (...args: any[]) => proc.spawn(...args) }));

import { branches, commit, ensureWorktree, mainWorktree, pull, push, remove, status } from '../../src/sandbox/worktree';

const REPO = '/home/me/project';
const ROOT = '/data';
const hash = crypto.createHash('sha256').update(REPO).digest('hex').slice(0, 12);

// What was run, as the arguments after "git -C <repo>"
const ran = () => proc.spawn.mock.calls.map((call: any[]) => (call[1] as string[]).slice(2));

beforeEach(() => {
  proc.spawn.mockClear();
  proc.respond = () => ({ code: 0 });
});

describe('branches', () => {
  it('lists the local branches and the current one', async () => {
    proc.respond = (args) => (args[2] === 'for-each-ref' ? { stdout: 'main\nfeature/x\n' } : { stdout: 'main\n' });
    expect(await branches(REPO)).toEqual({ current: 'main', names: ['main', 'feature/x'] });
    expect(proc.spawn.mock.calls[0][0]).toBe('git');
    expect(proc.spawn.mock.calls[0][1].slice(0, 2)).toEqual(['-C', REPO]);
    expect(proc.spawn.mock.calls[0][2].env).toBeDefined();
  });

  it('has no current branch when HEAD is detached', async () => {
    proc.respond = (args) => (args[2] === 'for-each-ref' ? { stdout: 'main\n' } : { stdout: '\n' });
    expect(await branches(REPO)).toEqual({ current: null, names: ['main'] });
  });

  it('has nothing for a folder that is not a repository', async () => {
    proc.respond = () => ({ code: 128, stderr: 'fatal: not a git repository' });
    expect(await branches(REPO)).toEqual({ current: null, names: [] });
  });
});

describe('mainWorktree', () => {
  // Git lists the user's own checkout first, whichever worktree it is asked in
  const listing =
    `worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\n` +
    '\nworktree /data/wt\nHEAD def\nbranch refs/heads/feature\n';

  it('is the first worktree git lists, asked in the repository', async () => {
    proc.respond = () => ({ stdout: listing });
    expect(await mainWorktree(REPO)).toBe(REPO);
    expect(ran()[0]).toEqual(['worktree', 'list', '--porcelain']);
  });

  it('is the same folder asked in a worktree of that repository', async () => {
    proc.respond = () => ({ stdout: listing });
    expect(await mainWorktree('/data/wt')).toBe(REPO);
  });

  it('is nothing for a folder that is not a repository', async () => {
    proc.respond = () => ({ code: 128, stderr: 'fatal: not a git repository' });
    expect(await mainWorktree(REPO)).toBeNull();
  });

  it('is nothing when git lists no worktree at all', async () => {
    proc.respond = () => ({ stdout: '\n' });
    expect(await mainWorktree(REPO)).toBeNull();
  });
});

describe('ensureWorktree', () => {
  const listing = (branch: string) =>
    `worktree ${REPO}\n` +
    'HEAD abc\n' +
    `branch refs/heads/main\n` +
    '\n' +
    `worktree /elsewhere/wt\n` +
    'HEAD def\n' +
    `branch refs/heads/${branch}\n`;

  it('reuses a worktree that already has the branch', async () => {
    proc.respond = (args) => (args[2] === 'worktree' && args[3] === 'list' ? { stdout: listing('dev') } : { code: 0 });
    expect(await ensureWorktree(REPO, ROOT, 'dev', 'main', false)).toBe('/elsewhere/wt');
    expect(ran().some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
    expect(ran().findIndex((args) => args[1] === 'prune')).toBeLessThan(ran().findIndex((args) => args[1] === 'list'));
  });

  it('creates the branch with -b from the base', async () => {
    proc.respond = (args) =>
      args[2] === 'worktree' && args[3] === 'list' ? { stdout: listing('other') } : { code: 0 };
    const path = join(ROOT, 'worktrees', hash, encodeURIComponent('feature/x'));
    expect(await ensureWorktree(REPO, ROOT, 'feature/x', 'main', true)).toBe(path);
    expect(ran().at(-1)).toEqual(['worktree', 'add', '-b', 'feature/x', path, 'main']);
  });

  it('adds a worktree for an existing branch', async () => {
    proc.respond = (args) =>
      args[2] === 'worktree' && args[3] === 'list' ? { stdout: listing('other') } : { code: 0 };
    const path = join(ROOT, 'worktrees', hash, 'dev');
    expect(await ensureWorktree(REPO, ROOT, 'dev', 'main', false)).toBe(path);
    expect(ran().at(-1)).toEqual(['worktree', 'add', path, 'dev']);
  });

  it('rejects a branch name git refuses', async () => {
    proc.respond = (args) => (args[2] === 'check-ref-format' ? { code: 1, stderr: 'fatal: bad name\n' } : { code: 0 });
    await expect(ensureWorktree(REPO, ROOT, 'bad..name', 'main', true)).rejects.toThrow('fatal: bad name');
    expect(ran()).toHaveLength(1);
  });

  it('reports why git could not add the worktree', async () => {
    proc.respond = (args) =>
      args[2] === 'worktree' && args[3] === 'add' ? { code: 128, stderr: 'fatal: already exists\n' } : { code: 0 };
    await expect(ensureWorktree(REPO, ROOT, 'dev', 'main', true)).rejects.toThrow('fatal: already exists');
  });
});

const WT = '/data/worktrees/abc/feature';

describe('status', () => {
  // What git says for each command the status is made of
  const answers = (upstream: string | null, counts: string, porcelain: string) => (args: string[]) => {
    if (args[2] === 'rev-parse') return upstream ? { stdout: `${upstream}\n` } : { code: 128, stderr: 'no upstream' };
    if (args[2] === 'rev-list') return { stdout: counts };
    if (args[2] === 'status') return { stdout: porcelain };
    return { code: 0 };
  };

  it('counts the commits ahead of and behind the upstream', async () => {
    proc.respond = answers('origin/feature', '1\t2\n', '');
    expect(await status(WT)).toEqual({ upstream: 'origin/feature', ahead: 2, behind: 1, dirty: false });
    // The left of the range is the upstream's, so those are the commits this branch is behind by
    expect(ran()).toContainEqual(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    expect(proc.spawn.mock.calls[0][1].slice(0, 2)).toEqual(['-C', WT]);
  });

  it('has no counts, and does not ask for them, without an upstream', async () => {
    proc.respond = answers(null, '', ' M a.ts\n');
    expect(await status(WT)).toEqual({ upstream: null, ahead: 0, behind: 0, dirty: true });
    expect(ran().some((args) => args[0] === 'rev-list')).toBe(false);
  });

  it('says why it cannot tell when the folder is not a worktree', async () => {
    proc.respond = (args) =>
      args[2] === 'status' ? { code: 128, stderr: 'fatal: not a git repository\n' } : { code: 128 };
    await expect(status(WT)).rejects.toThrow('fatal: not a git repository');
  });
});

describe('commit', () => {
  it('commits everything with the message', async () => {
    proc.respond = (args) => (args[2] === 'status' ? { stdout: 'M  a.ts\n' } : { code: 0 });
    expect(await commit(WT, '  Add a  ')).toBe(true);
    expect(ran()).toEqual([
      ['add', '-A'],
      ['status', '--porcelain'],
      ['commit', '-m', 'Add a'],
    ]);
  });

  it('does nothing, and says so, when there is nothing to commit', async () => {
    proc.respond = () => ({ code: 0, stdout: '' });
    expect(await commit(WT, 'Add a')).toBe(false);
    expect(ran().some((args) => args[0] === 'commit')).toBe(false);
  });

  it('turns away a blank message before touching anything', async () => {
    await expect(commit(WT, '   ')).rejects.toThrow('needs a message');
    expect(proc.spawn).not.toHaveBeenCalled();
  });

  it("reports git's reason when the commit fails", async () => {
    proc.respond = (args) =>
      args[2] === 'commit' ? { code: 1, stderr: 'Author identity unknown\n' } : { code: 0, stdout: 'M  a.ts\n' };
    await expect(commit(WT, 'Add a')).rejects.toThrow('Author identity unknown');
  });
});

describe('push', () => {
  it('sets the upstream the first time, and returns it', async () => {
    let pushed = false;
    proc.respond = (args) => {
      if (args[2] === 'rev-parse') return pushed ? { stdout: 'origin/feature\n' } : { code: 128 };
      if (args[2] === 'branch') return { stdout: 'feature\n' };
      if (args[2] === 'push') pushed = true;
      return { code: 0 };
    };
    expect(await push(WT)).toBe('origin/feature');
    expect(ran()).toContainEqual(['push', '-u', 'origin', 'feature']);
  });

  it('is a plain push once there is an upstream', async () => {
    proc.respond = (args) => (args[2] === 'rev-parse' ? { stdout: 'origin/feature\n' } : { code: 0 });
    expect(await push(WT)).toBe('origin/feature');
    expect(ran()).toContainEqual(['push']);
    expect(ran().some((args) => args.includes('-u'))).toBe(false);
  });

  it('has nothing to push from a detached HEAD', async () => {
    proc.respond = (args) => (args[2] === 'rev-parse' ? { code: 128 } : { stdout: '\n' });
    await expect(push(WT)).rejects.toThrow('not on a branch');
    expect(ran().some((args) => args[0] === 'push')).toBe(false);
  });

  it("reports git's reason when the push is refused", async () => {
    proc.respond = (args) => {
      if (args[2] === 'rev-parse') return { stdout: 'origin/feature\n' };
      return args[2] === 'push' ? { code: 1, stderr: 'rejected: non-fast-forward\n' } : { code: 0 };
    };
    await expect(push(WT)).rejects.toThrow('rejected: non-fast-forward');
  });
});

describe('pull', () => {
  it('only fast-forwards', async () => {
    await pull(WT);
    expect(ran()).toEqual([['pull', '--ff-only']]);
  });

  it('says why when the branches have gone different ways', async () => {
    proc.respond = () => ({ code: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' });
    await expect(pull(WT)).rejects.toThrow('Not possible to fast-forward');
  });
});

describe('remove', () => {
  it('removes the worktree without forcing, then prunes', async () => {
    await remove(REPO, WT);
    expect(proc.spawn.mock.calls[0][1].slice(0, 2)).toEqual(['-C', REPO]);
    expect(ran()).toEqual([
      ['worktree', 'remove', WT],
      ['worktree', 'prune'],
    ]);
  });

  it('leaves a worktree that has uncommitted work in it, and says so', async () => {
    proc.respond = () => ({ code: 128, stderr: "fatal: '/wt' contains modified or untracked files\n" });
    await expect(remove(REPO, WT)).rejects.toThrow('contains modified or untracked files');
    expect(ran()).toEqual([['worktree', 'remove', WT]]);
  });
});
