// The two tools a subagent puts its thread on a branch of its own with: making the branch, and moving the thread onto
// it. Git and the sandbox are mocked, so what is tested is what the tools ask of them, what they tell the model, and
// what they tell the harness.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext } from '../../src/types';

const worktree = vi.hoisted(() => ({ mainWorktree: vi.fn(), branches: vi.fn(), ensureWorktree: vi.fn() }));
vi.mock('../../src/sandbox/worktree', () => worktree);

const docker = vi.hoisted(() => ({ setWorkspace: vi.fn(), exec: vi.fn() }));
vi.mock('../../src/sandbox/docker', async () => {
  const actual = await vi.importActual<typeof import('../../src/sandbox/docker')>('../../src/sandbox/docker');
  return { ...actual, ...docker };
});

const fs = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('fs', () => fs);

import { init, tools } from '../../src/tools/branches';

const signal = new AbortController().signal;
const createBranch = tools.find((tool) => tool.name === 'create_branch') as Tool;
const enterBranch = tools.find((tool) => tool.name === 'enter_branch') as Tool;

// The tools remember the branches they made for as long as the process lives, so each test uses a thread of its own
let count = 0;
const nextThread = () => `thread-${++count}`;
const REPO = '/projects/demo';
const FOLDER = '/data/worktrees/abc/fix-upload-retry';

function contextFor(over: Partial<ToolContext> = {}): ToolContext & { emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { signal, threadId: nextThread(), workspace: REPO, emit, ...over } as ToolContext & {
    emit: ReturnType<typeof vi.fn>;
  };
}

// Makes the branch for a thread, which is what has to have happened before it can be moved onto
async function made(context: ToolContext, name = 'fix-upload-retry') {
  await createBranch.run({ name }, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  init('/data');
  worktree.mainWorktree.mockResolvedValue(REPO);
  worktree.branches.mockResolvedValue({ current: 'main', names: ['main'] });
  worktree.ensureWorktree.mockResolvedValue(FOLDER);
  docker.exec.mockResolvedValue({ code: 0, output: '' });
  fs.existsSync.mockReturnValue(true);
});

describe('what the model is told about them', () => {
  it('offers both only to a subagent in a workspace, and not to a step that only reads', () => {
    const shown = tools.map(({ name, agentOnly, needsWorkspace, phases }) => [name, agentOnly, needsWorkspace, phases]);
    expect(shown).toEqual([
      ['create_branch', true, true, ['execute']],
      ['enter_branch', true, true, ['execute']],
    ]);
  });

  it('names the tool that does the moving in the one that only makes the branch', () => {
    expect(createBranch.description).toContain('enter_branch');
  });
});

describe('create_branch', () => {
  it('makes the branch from what the thread has checked out, and says where it went', async () => {
    const result = await createBranch.run({ name: 'fix-upload-retry' }, contextFor());
    expect(worktree.branches).toHaveBeenCalledWith(REPO);
    expect(worktree.ensureWorktree).toHaveBeenCalledWith(REPO, '/data', 'fix-upload-retry', 'main', true);
    expect(result).toContain('fix-upload-retry');
    expect(result).toContain('main');
    expect(result).toContain(FOLDER);
    expect(result).toContain('enter_branch');
  });

  // A thread already on a branch makes its next one where the user's own checkout would have
  it('makes it in the repository the thread works from, not in the worktree', async () => {
    worktree.mainWorktree.mockResolvedValue(REPO);
    worktree.branches.mockResolvedValue({ current: 'feature', names: ['main', 'feature'] });
    await createBranch.run({ name: 'spin-off' }, contextFor({ workspace: '/data/worktrees/abc/feature' }));
    expect(worktree.mainWorktree).toHaveBeenCalledWith('/data/worktrees/abc/feature');
    expect(worktree.ensureWorktree).toHaveBeenCalledWith(REPO, '/data', 'spin-off', 'feature', true);
  });

  it('trims the name', async () => {
    await createBranch.run({ name: '  fix-upload-retry ' }, contextFor());
    expect(worktree.ensureWorktree).toHaveBeenCalledWith(REPO, '/data', 'fix-upload-retry', 'main', true);
  });

  it('rejects a blank name without touching the repository', async () => {
    await expect(createBranch.run({ name: '  ' }, contextFor())).rejects.toThrow('"name" must be a non-empty');
    await expect(createBranch.run({}, contextFor())).rejects.toThrow('"name" must be a non-empty');
    expect(worktree.ensureWorktree).not.toHaveBeenCalled();
  });

  it('says so for a folder that is not a repository', async () => {
    worktree.mainWorktree.mockResolvedValue(null);
    await expect(createBranch.run({ name: 'x' }, contextFor())).rejects.toThrow('not a Git repository');
    expect(worktree.ensureWorktree).not.toHaveBeenCalled();
  });

  it('says so when nothing is checked out to branch from', async () => {
    worktree.branches.mockResolvedValue({ current: null, names: ['main'] });
    await expect(createBranch.run({ name: 'x' }, contextFor())).rejects.toThrow('no branch checked out');
    expect(worktree.ensureWorktree).not.toHaveBeenCalled();
  });

  // Why the two are separate: a name already taken is answered, not fatal
  it('passes on what git said about a name already in use', async () => {
    worktree.ensureWorktree.mockRejectedValue(new Error("fatal: a branch named 'x' already exists"));
    await expect(createBranch.run({ name: 'x' }, contextFor())).rejects.toThrow('already exists');
  });

  it('refuses a thread with no workspace', async () => {
    await expect(createBranch.run({ name: 'x' }, contextFor({ workspace: undefined }))).rejects.toThrow('no workspace');
  });

  it('refuses a message with no thread', async () => {
    await expect(createBranch.run({ name: 'x' }, contextFor({ threadId: undefined }))).rejects.toThrow('no thread');
  });
});

describe('enter_branch', () => {
  it('moves the thread, tells the harness, and notes it in the context note', async () => {
    const context = contextFor();
    await made(context);
    const result = await enterBranch.run({ name: 'fix-upload-retry' }, context);

    expect(docker.setWorkspace).toHaveBeenCalledWith(context.threadId, FOLDER);
    expect(context.emit).toHaveBeenCalledTimes(1);
    expect(context.emit).toHaveBeenCalledWith({
      type: 'branch',
      branch: { name: 'fix-upload-retry', base: 'main', worktree: FOLDER },
    });
    const [threadId, command, options] = docker.exec.mock.calls[0];
    expect(threadId).toBe(context.threadId);
    expect(command).toContain('cat >>');
    expect(options.input).toContain('fix-upload-retry');
    expect(options.input.endsWith('\n')).toBe(true);
    expect(result).toContain('fix-upload-retry');
  });

  // The container is the whole point of the design: its files and its baseline are left alone
  it('leaves the container and its changes where they are', async () => {
    const context = contextFor();
    await made(context);
    await enterBranch.run({ name: 'fix-upload-retry' }, context);
    expect(docker.exec).toHaveBeenCalledTimes(1);
    expect(docker.exec.mock.calls[0][1]).not.toContain('init');
  });

  it('points the thread at the branch before it tells the harness', async () => {
    const context = contextFor();
    await made(context);
    await enterBranch.run({ name: 'fix-upload-retry' }, context);
    expect(docker.setWorkspace.mock.invocationCallOrder[0]).toBeLessThan(context.emit.mock.invocationCallOrder[0]);
  });

  it('still moves, and still tells the harness, when the note cannot be written', async () => {
    docker.exec.mockRejectedValue(new Error('container is gone'));
    const context = contextFor();
    await made(context);
    const result = await enterBranch.run({ name: 'fix-upload-retry' }, context);
    expect(docker.setWorkspace).toHaveBeenCalledWith(context.threadId, FOLDER);
    expect(context.emit).toHaveBeenCalledTimes(1);
    expect(result).toContain('fix-upload-retry');
  });

  it('refuses a branch no subagent in this thread made', async () => {
    const context = contextFor();
    await expect(enterBranch.run({ name: 'fix-upload-retry' }, context)).rejects.toThrow('No branch named');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('refuses a branch made for another thread', async () => {
    await made(contextFor());
    const other = contextFor();
    await expect(enterBranch.run({ name: 'fix-upload-retry' }, other)).rejects.toThrow('No branch named');
    expect(other.emit).not.toHaveBeenCalled();
  });

  it('refuses one whose folder has since gone', async () => {
    const context = contextFor();
    await made(context);
    fs.existsSync.mockReturnValue(false);
    await expect(enterBranch.run({ name: 'fix-upload-retry' }, context)).rejects.toThrow('is gone');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
  });

  // Several subagents work at once and the thread has one place to live
  it('lets the first subagent move the thread and turns the next one away', async () => {
    const context = contextFor();
    await made(context, 'fix-upload-retry');
    await made(context, 'other-idea');
    await enterBranch.run({ name: 'fix-upload-retry' }, context);
    docker.setWorkspace.mockClear();

    await expect(enterBranch.run({ name: 'other-idea' }, context)).rejects.toThrow('already been moved onto');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
    expect(context.emit).toHaveBeenCalledTimes(1);
  });

  it('says so, without moving anything again, when the same branch is asked for twice', async () => {
    const context = contextFor();
    await made(context);
    await enterBranch.run({ name: 'fix-upload-retry' }, context);
    const result = await enterBranch.run({ name: 'fix-upload-retry' }, context);
    expect(result).toContain('already');
    expect(context.emit).toHaveBeenCalledTimes(1);
  });

  // The thread works from the folder it began the message with, so the move has taken effect once a later message
  // arrives from the branch's own folder — and from there the thread may be moved on again
  it('lets a thread that has caught up with its branch be moved on to another', async () => {
    const threadId = nextThread();
    const moving = contextFor({ threadId });
    await made(moving);
    await enterBranch.run({ name: 'fix-upload-retry' }, moving);

    const later = contextFor({ threadId, workspace: FOLDER });
    worktree.branches.mockResolvedValue({ current: 'fix-upload-retry', names: ['main', 'fix-upload-retry'] });
    worktree.ensureWorktree.mockResolvedValue('/data/worktrees/abc/second-thought');
    await made(later, 'second-thought');
    await enterBranch.run({ name: 'second-thought' }, later);
    expect(later.emit).toHaveBeenCalledWith({
      type: 'branch',
      branch: { name: 'second-thought', base: 'fix-upload-retry', worktree: '/data/worktrees/abc/second-thought' },
    });
  });

  it('rejects a blank name', async () => {
    const context = contextFor();
    await expect(enterBranch.run({ name: ' ' }, context)).rejects.toThrow('"name" must be a non-empty');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a thread with no workspace', async () => {
    const context = contextFor({ workspace: undefined });
    await expect(enterBranch.run({ name: 'x' }, context)).rejects.toThrow('no workspace');
  });

  it('refuses a message with no thread', async () => {
    const context = contextFor({ threadId: undefined });
    await expect(enterBranch.run({ name: 'x' }, context)).rejects.toThrow('no thread');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
  });

  it('refuses when there is nobody to tell', async () => {
    const context = contextFor({ emit: undefined });
    await made(context);
    await expect(enterBranch.run({ name: 'fix-upload-retry' }, context)).rejects.toThrow('cannot be moved');
    expect(docker.setWorkspace).not.toHaveBeenCalled();
  });
});
