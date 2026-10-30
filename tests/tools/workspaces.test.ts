// The two tools a general chat gets a workspace of its own with: making the folder, and moving the thread into it.
// The sandbox is mocked, so what is tested is what the tools ask of it and what they tell the model and the harness.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext } from '../../src/types';

const workspaces = vi.hoisted(() => ({ create: vi.fn(), isManaged: vi.fn() }));
vi.mock('../../src/sandbox/workspace', () => workspaces);

const docker = vi.hoisted(() => ({ adopt: vi.fn(), filesToCopy: vi.fn(), exec: vi.fn() }));
vi.mock('../../src/sandbox/docker', async () => {
  const actual = await vi.importActual<typeof import('../../src/sandbox/docker')>('../../src/sandbox/docker');
  return { ...actual, ...docker };
});

import { tools } from '../../src/tools/workspaces';

const signal = new AbortController().signal;
const createWorkspace = tools.find((tool) => tool.name === 'create_workspace') as Tool;
const enterWorkspace = tools.find((tool) => tool.name === 'enter_workspace') as Tool;

// The tool remembers the threads it has moved for as long as the process lives, so each test uses a thread of its own
let count = 0;
const nextThread = () => `thread-${++count}`;
const path = '/home/me/.workspaces/bird-tracker';

function contextFor(over: Partial<ToolContext> = {}): ToolContext & { emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { signal, threadId: nextThread(), emit, ...over } as ToolContext & { emit: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaces.create.mockResolvedValue(path);
  workspaces.isManaged.mockResolvedValue(true);
  docker.filesToCopy.mockResolvedValue([]);
  docker.adopt.mockResolvedValue(undefined);
  docker.exec.mockResolvedValue({ code: 0, output: '' });
});

describe('what the model is told about them', () => {
  it('offers both only to a general chat, and not to a step that only reads', () => {
    expect(tools.map(({ name, generalOnly, phases }) => [name, generalOnly, phases])).toEqual([
      ['create_workspace', true, ['execute']],
      ['enter_workspace', true, ['execute']],
    ]);
  });
});

describe('create_workspace', () => {
  it('makes the workspace with the name given and returns its path', async () => {
    const result = await createWorkspace.run({ name: 'bird-tracker' }, contextFor());
    expect(workspaces.create).toHaveBeenCalledWith('bird-tracker');
    expect(result).toContain(path);
    expect(result).toContain('enter_workspace');
  });

  it('trims the name', async () => {
    await createWorkspace.run({ name: '  bird-tracker ' }, contextFor());
    expect(workspaces.create).toHaveBeenCalledWith('bird-tracker');
  });

  it('rejects a blank name without making anything', async () => {
    await expect(createWorkspace.run({ name: '   ' }, contextFor())).rejects.toThrow('"name" must be a non-empty');
    await expect(createWorkspace.run({}, contextFor())).rejects.toThrow('"name" must be a non-empty');
    expect(workspaces.create).not.toHaveBeenCalled();
  });
});

describe('enter_workspace', () => {
  it('moves the thread in, tells the harness, and notes it in the context note', async () => {
    const context = contextFor();
    const result = await enterWorkspace.run({ path }, context);

    expect(docker.adopt).toHaveBeenCalledWith(context.threadId, path);
    expect(context.emit).toHaveBeenCalledTimes(1);
    expect(context.emit).toHaveBeenCalledWith({ type: 'workspace', workspace: path });
    expect(docker.exec).toHaveBeenCalledTimes(1);
    const [threadId, command, options] = docker.exec.mock.calls[0];
    expect(threadId).toBe(context.threadId);
    expect(command).toContain('cat >>');
    expect(options.input).toContain(path);
    expect(options.input.endsWith('\n')).toBe(true);
    expect(result).toContain(path);
    expect(result).toContain('next message');
  });

  it('adopts before it emits', async () => {
    const context = contextFor();
    await enterWorkspace.run({ path }, context);
    expect(docker.adopt.mock.invocationCallOrder[0]).toBeLessThan(context.emit.mock.invocationCallOrder[0]);
  });

  it('still moves, and still tells the harness, when the note cannot be written', async () => {
    docker.exec.mockRejectedValue(new Error('container is gone'));
    const context = contextFor();
    const result = await enterWorkspace.run({ path }, context);
    expect(docker.adopt).toHaveBeenCalledWith(context.threadId, path);
    expect(context.emit).toHaveBeenCalledWith({ type: 'workspace', workspace: path });
    expect(result).toContain('next message');
  });

  it('refuses a thread that is already in a workspace', async () => {
    const context = contextFor({ workspace: '/projects/demo' });
    await expect(enterWorkspace.run({ path }, context)).rejects.toThrow('already in a workspace');
    expect(docker.adopt).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('refuses a message with no thread', async () => {
    const context = contextFor({ threadId: undefined });
    await expect(enterWorkspace.run({ path }, context)).rejects.toThrow('no thread');
    expect(docker.adopt).not.toHaveBeenCalled();
  });

  it('refuses when there is nobody to tell', async () => {
    const context = contextFor({ emit: undefined });
    await expect(enterWorkspace.run({ path }, context)).rejects.toThrow('cannot be moved');
    expect(docker.adopt).not.toHaveBeenCalled();
  });

  it('refuses a relative path', async () => {
    const context = contextFor();
    await expect(enterWorkspace.run({ path: 'bird-tracker' }, context)).rejects.toThrow('whole path');
    expect(workspaces.isManaged).not.toHaveBeenCalled();
    expect(docker.adopt).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('refuses a blank path', async () => {
    const context = contextFor();
    await expect(enterWorkspace.run({ path: ' ' }, context)).rejects.toThrow('"path" must be a non-empty');
    expect(docker.adopt).not.toHaveBeenCalled();
  });

  it('refuses a folder that create_workspace did not make', async () => {
    workspaces.isManaged.mockResolvedValue(false);
    const context = contextFor();
    await expect(enterWorkspace.run({ path: '/etc' }, context)).rejects.toThrow('not a workspace made with');
    expect(workspaces.isManaged).toHaveBeenCalledWith('/etc');
    expect(docker.adopt).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('refuses a folder that already has files in it', async () => {
    docker.filesToCopy.mockResolvedValue(['README.md']);
    const context = contextFor();
    await expect(enterWorkspace.run({ path }, context)).rejects.toThrow('already has files');
    expect(docker.filesToCopy).toHaveBeenCalledWith(path);
    expect(docker.adopt).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('answers a repeat call for the same path without moving again', async () => {
    const context = contextFor();
    await enterWorkspace.run({ path }, context);
    context.emit.mockClear();

    const result = await enterWorkspace.run({ path }, context);
    expect(result).toContain('already');
    expect(result).toContain(path);
    expect(docker.adopt).toHaveBeenCalledTimes(1);
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('refuses a different path for a thread that has moved', async () => {
    const context = contextFor();
    await enterWorkspace.run({ path }, context);

    await expect(enterWorkspace.run({ path: '/home/me/.workspaces/other' }, context)).rejects.toThrow(
      `already moved into ${path}`
    );
    expect(docker.adopt).toHaveBeenCalledTimes(1);
    expect(context.emit).toHaveBeenCalledTimes(1);
  });
});
