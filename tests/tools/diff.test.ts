import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/types';

const changes = vi.hoisted(() => ({ list: vi.fn(), describeChanges: vi.fn() }));
vi.mock('../../src/sandbox/changes', () => changes);

import { TOOL_NAME, tool } from '../../src/tools/diff';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  threadId: THREAD,
  workspace: '/projects/demo',
  ...over,
});

beforeEach(() => {
  changes.list.mockReset();
  changes.describeChanges.mockReset();
  changes.list.mockResolvedValue({ files: [] });
  changes.describeChanges.mockReturnValue('You have not changed anything since the last sync.');
});

describe('the tool a thread looks over its own changes by', () => {
  it('is offered where files are changed, and only where there is a workspace', () => {
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.needsWorkspace).toBe(true);
    expect(tool.phases).toEqual(['execute']);
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('says what the diff is measured from', () => {
    expect(tool.description).toContain('last time your copy was brought level');
  });

  it('hands back the thread’s changes in words', async () => {
    await expect(tool.run({}, context())).resolves.toBe('You have not changed anything since the last sync.');
    expect(changes.list).toHaveBeenCalledWith(THREAD);
    expect(changes.describeChanges).toHaveBeenCalledWith({ files: [] });
  });

  it('says plainly when there is no workspace', async () => {
    await expect(tool.run({}, context({ workspace: undefined }))).rejects.toThrow('no workspace');
    await expect(tool.run({}, context({ threadId: undefined }))).rejects.toThrow('no workspace');
    expect(changes.list).not.toHaveBeenCalled();
  });
});
