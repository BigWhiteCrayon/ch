import { EventEmitter } from 'events';
import { join } from 'path';
import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for child_process.spawn. Each test supplies `respond`, which
// decides how a git command ends; nothing is really run.
// `stderrFirst` has what git says reach the caller before what it writes, which is the way round it comes when the
// two are pipes and only one of them is buffered: a caller that reads the two as one stream sees them interleaved.
type Outcome = { code?: number | null; stdout?: string; stderr?: string; stderrFirst?: boolean };

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
    const say = {
      out: () => outcome.stdout && child.stdout.emit('data', Buffer.from(outcome.stdout)),
      err: () => outcome.stderr && child.stderr.emit('data', Buffer.from(outcome.stderr)),
    };
    if (outcome.stderrFirst) {
      say.err();
      say.out();
    } else {
      say.out();
      say.err();
    }
    child.emit('close', outcome.code ?? 0);
  });
  return child;
});

vi.mock('child_process', () => ({ spawn: (...args: any[]) => proc.spawn(...args) }));

import {
  branches,
  checkedOutAt,
  commit,
  defaultBranch,
  ensureWorktree,
  isMainWorktree,
  mainWorktree,
  mergeToDefault,
  pull,
  push,
  remove,
  status,
} from '../../src/sandbox/worktree';

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

describe('isMainWorktree', () => {
  const listing =
    `worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\n` +
    '\nworktree /data/wt\nHEAD def\nbranch refs/heads/feature\n';
  // Git lists the worktrees, and says which one's top level the folder asked about is in
  const toplevel = (top: string) => (args: string[]) =>
    args[2] === 'worktree' ? { stdout: listing } : { stdout: `${top}\n` };

  it("is true in the root of the user's checkout", async () => {
    proc.respond = toplevel(REPO);
    expect(await isMainWorktree(REPO)).toBe(true);
    expect(ran()).toContainEqual(['rev-parse', '--show-toplevel']);
  });

  it('is true in a folder inside the checkout', async () => {
    proc.respond = toplevel(REPO);
    expect(await isMainWorktree(`${REPO}/src`)).toBe(true);
  });

  it('is false in a worktree of the repository', async () => {
    proc.respond = toplevel('/data/wt');
    expect(await isMainWorktree('/data/wt')).toBe(false);
  });

  it('is false for a folder that is not in a repository', async () => {
    proc.respond = () => ({ code: 128, stderr: 'fatal: not a git repository' });
    expect(await isMainWorktree(REPO)).toBe(false);
  });

  it('is false when git cannot say where the top level is', async () => {
    proc.respond = (args) => (args[2] === 'worktree' ? { stdout: listing } : { code: 128, stderr: 'fatal' });
    expect(await isMainWorktree(REPO)).toBe(false);
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

describe('defaultBranch', () => {
  it("answers with what origin's HEAD points at", async () => {
    proc.respond = () => ({ stdout: 'origin/trunk\n' });
    expect(await defaultBranch(REPO)).toBe('trunk');
  });

  it('falls back to whichever usual name the repository has a branch under', async () => {
    proc.respond = (args) => {
      if (args.includes('symbolic-ref')) return { code: 1 };
      return { code: args.includes('refs/heads/master') ? 0 : 1 };
    };
    expect(await defaultBranch(REPO)).toBe('master');
  });

  it('is null where it has neither', async () => {
    proc.respond = () => ({ code: 1 });
    expect(await defaultBranch(REPO)).toBeNull();
  });
});

describe('mergeToDefault', () => {
  const WORK = '/data/trees/feature';
  const SHA = '1111111111111111111111111111111111111111';
  const WAS = '2222222222222222222222222222222222222222';

  // Answers the calls the merge makes. Each test says only what it is about; the rest is a branch two commits ahead
  // of a main that has not moved, in a folder with nothing uncommitted in it, main checked out nowhere.
  const repo = (state: {
    current?: string;
    dirty?: string;
    ahead?: string;
    behind?: string;
    conflicts?: string[];
    mergeFails?: boolean;
    heldBy?: string;
    ffFails?: boolean;
  }) => {
    proc.respond = (args: string[]): Outcome => {
      const at = args[1];
      const rest = args.slice(2);
      const [sub, ...flags] = rest;
      if (sub === 'symbolic-ref') return { stdout: 'origin/main\n' };
      if (sub === 'branch' && flags[0] === '--show-current') return { stdout: `${state.current ?? 'feature'}\n` };
      if (sub === 'status') return { stdout: state.dirty ?? '' };
      if (sub === 'rev-list') {
        const range = rest[rest.length - 1];
        const counting = range.startsWith('main..');
        const count = (counting ? state.ahead : state.behind) ?? (counting ? '2' : '0');
        return { stdout: `${count}\n` };
      }
      if (sub === 'merge-tree') {
        // As git writes it: the merged tree, the files that clashed, then a blank line and an account of them —
        // which is git talking, not a filename, and has no business in what the model is told
        return state.conflicts
          ? {
              code: 1,
              stdout: ['atree', ...state.conflicts, '', ...state.conflicts.map((f) => `CONFLICT: in ${f}`)].join('\n'),
              stderr: 'Auto-merging src/app.ts\n',
              stderrFirst: true,
            }
          : { stdout: 'atree\n' };
      }
      if (sub === 'merge' && flags.includes('--ff-only')) return state.ffFails ? { code: 1, stdout: 'not clean' } : {};
      if (sub === 'merge' && flags.includes('--abort')) return {};
      if (sub === 'merge') return state.mergeFails ? { code: 1, stdout: 'CONFLICT' } : {};
      if (sub === 'rev-parse' && flags[0] === 'HEAD') return { stdout: `${SHA}\n` };
      if (sub === 'rev-parse') return { stdout: `${WAS}\n` };
      if (sub === 'worktree' && flags[0] === 'list') {
        return {
          stdout: state.heldBy
            ? `worktree ${REPO}\nbranch refs/heads/other\n\nworktree ${state.heldBy}\nbranch refs/heads/main\n`
            : `worktree ${REPO}\nbranch refs/heads/other\n`,
        };
      }
      if (at === WORK && sub === 'commit') return {};
      return {};
    };
  };

  // Every git run, as "<folder> <args>", so that what was run where can be read in one line
  const where = () =>
    proc.spawn.mock.calls.map((call: any[]) => {
      const args = call[1] as string[];
      return `${args[1]} ${args.slice(2).join(' ')}`;
    });

  it('moves main forward onto the branch without checking it out anywhere', async () => {
    repo({});
    const merged = await mergeToDefault(REPO, WORK);
    expect(merged).toEqual({ branch: 'feature', target: 'main', sha: SHA, brought: false, already: false });
    // The ref is moved on its own, and told what it is expected to be at
    expect(where()).toContain(`${REPO} update-ref refs/heads/main ${SHA} ${WAS}`);
    // ...and nothing anywhere checked main out to do it
    expect(where().some((line) => /checkout|switch|worktree add/.test(line))).toBe(false);
  });

  it("brings main into the branch first, in the branch's own folder, when main has moved on", async () => {
    repo({ behind: '3' });
    const merged = await mergeToDefault(REPO, WORK);
    expect(merged.brought).toBe(true);
    const lines = where();
    expect(lines).toContain(`${WORK} merge --no-edit main`);
    // The merge that could conflict happens in the thread's folder, before main is moved at all
    expect(lines.findIndex((l) => l === `${WORK} merge --no-edit main`)).toBeLessThan(
      lines.findIndex((l) => l.startsWith(`${REPO} update-ref`))
    );
  });

  it('refuses while there is work in the folder that is not committed, and does nothing', async () => {
    repo({ dirty: ' M src/app.ts\n' });
    await expect(mergeToDefault(REPO, WORK)).rejects.toThrow('not committed');
    expect(where().some((line) => /merge|update-ref/.test(line))).toBe(false);
  });

  it('refuses a merge that would conflict, naming the files, without changing anything', async () => {
    repo({ behind: '3', conflicts: ['src/app.ts', 'styles.css'] });
    // The files, and only the files: git's own account of them is not a list of names
    await expect(mergeToDefault(REPO, WORK)).rejects.toThrow('conflicts in src/app.ts, styles.css.');
    const lines = where();
    expect(lines.some((line) => line.includes('merge --no-edit'))).toBe(false);
    expect(lines.some((line) => line.includes('update-ref'))).toBe(false);
  });

  it('fast-forwards the worktree that holds main, rather than moving the ref out from under it', async () => {
    repo({ heldBy: '/home/me/project' });
    await mergeToDefault(REPO, WORK);
    const lines = where();
    expect(lines).toContain('/home/me/project merge --ff-only feature');
    expect(lines.some((line) => line.includes('update-ref'))).toBe(false);
  });

  it('says so when that worktree has work of its own in the way, rather than forcing it', async () => {
    repo({ heldBy: '/home/me/project', ffFails: true });
    await expect(mergeToDefault(REPO, WORK)).rejects.toThrow('could not be moved forward');
  });

  it('does nothing when main already has the branch', async () => {
    repo({ ahead: '0' });
    const merged = await mergeToDefault(REPO, WORK);
    expect(merged.already).toBe(true);
    expect(where().some((line) => /merge|update-ref/.test(line))).toBe(false);
  });

  it('refuses a folder that is on main itself', async () => {
    repo({ current: 'main' });
    await expect(mergeToDefault(REPO, WORK)).rejects.toThrow('nothing to merge into it');
  });
});

describe('checkedOutAt', () => {
  it('answers with the worktree holding the branch, or null', async () => {
    proc.respond = () => ({
      stdout: `worktree ${REPO}\nbranch refs/heads/main\n\nworktree /data/f\nbranch refs/heads/feature\n`,
    });
    expect(await checkedOutAt(REPO, 'feature')).toBe('/data/f');
    expect(await checkedOutAt(REPO, 'nothing')).toBeNull();
  });
});
