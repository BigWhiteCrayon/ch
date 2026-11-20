import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RosterEntry, ToolContext } from '../../src/types';

// Mimics the roster module: the threads are pushed in with set, list filters out
// the one asking, and busy reads the activity of the thread asked about.
const roster = vi.hoisted(() => {
  let entries: RosterEntry[] = [];
  return {
    set: vi.fn((value: RosterEntry[]) => (entries = value)),
    list: vi.fn((excludeId?: string) =>
      excludeId ? entries.filter((e) => e.id !== excludeId) : entries
    ),
    busy: vi.fn((id: string) =>
      entries.some((e) => e.id === id && e.activity === 'working')
    ),
    deliver: vi.fn(),
  };
});
vi.mock('../../src/roster', () => roster);

const worktree = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../../src/sandbox/worktree', () => worktree);

import { tools } from '../../src/tools/threads';

const context = (): ToolContext => ({ signal: new AbortController().signal, threadId: 'me' });

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  id: 't2',
  title: 'Fix upload',
  activity: 'idle',
  changes: 0,
  ...over,
});

beforeEach(() => {
  roster.set.mockReset();
  roster.list.mockReset();
  roster.deliver.mockReset();
  worktree.status.mockReset();
  roster.set([
    entry({ id: 't2', title: 'Fix upload' }),
    entry({ id: 't3', title: 'Docs', activity: 'working', changes: 2 }),
  ]);
});

describe('the two cross-thread tools', () => {
  it('lists the other threads and what each is doing', async () => {
    const out = await tools[0].run({}, context());
    expect(out).toContain('Fix upload');
    expect(out).toContain('Docs');
    expect(out).toContain('working');
    expect(out).toContain('2 files not yet written back');
  });

  it('does not list its own thread', async () => {
    roster.set([entry({ id: 'me', title: 'This thread' }), entry({ id: 't2', title: 'Fix upload' })]);
    const out = await tools[0].run({}, context());
    expect(out).not.toContain('This thread');
    expect(out).toContain('Fix upload');
  });

  it('sends a message to the threads it is told to, and reports it was sent', async () => {
    roster.set([entry({ id: 't2', title: 'Fix upload' })]);
    const out = await tools[1].run({ targets: ['t2'], message: 'merge from main and push' }, context());
    expect(roster.deliver).toHaveBeenCalledWith('t2', 'merge from main and push');
    expect(out).toContain('Sent to Fix upload');
    expect(out).toContain('now working on it');
  });

  it('skips a thread that is already working', async () => {
    roster.set([entry({ id: 't2', title: 'Fix upload', activity: 'working' })]);
    const out = await tools[1].run({ targets: ['t2'], message: 'do it' }, context());
    expect(roster.deliver).not.toHaveBeenCalled();
    expect(out).toContain('Not sent to');
    expect(out).toContain('already working');
  });

  it('reports a thread that is not there', async () => {
    roster.set([]);
    const out = await tools[1].run({ targets: ['nope'], message: 'do it' }, context());
    expect(out).toContain('No such thread');
  });

  it('refuses an empty message', async () => {
    await expect(tools[1].run({ targets: ['t2'], message: '' }, context())).rejects.toThrow();
  });
});
