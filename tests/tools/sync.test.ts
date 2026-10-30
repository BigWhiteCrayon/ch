import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/types';

const changes = vi.hoisted(() => ({ sync: vi.fn(), report: vi.fn() }));
vi.mock('../../src/sandbox/changes', () => changes);

import { TOOL_NAME, tool } from '../../src/tools/sync';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  threadId: THREAD,
  workspace: '/projects/demo',
  ...over,
});

beforeEach(() => {
  changes.sync.mockReset();
  changes.report.mockReset();
  changes.sync.mockResolvedValue({ pulled: [], merged: [], clashes: [] });
  changes.report.mockReturnValue('Nothing clashes.');
});

describe('the tool a thread brings itself level with', () => {
  it('is offered only where there is a workspace to be level with', () => {
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.needsWorkspace).toBe(true);
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('says what it is for and when to call it, since nothing else tells the model', () => {
    expect(tool.description).toContain('does not stand still');
    expect(tool.description).toContain('before you tell the user the work is done');
    // ...and that calling it is not the only time it happens
    expect(tool.description).toContain('run for you');
  });

  it('brings the thread level and hands back what came of it, in words', async () => {
    await expect(tool.run({}, context())).resolves.toBe('Nothing clashes.');
    expect(changes.sync).toHaveBeenCalledWith(THREAD, '/projects/demo');
    expect(changes.report).toHaveBeenCalledWith({ pulled: [], merged: [], clashes: [] });
  });

  it('says plainly when there is no workspace or no container to be level with', async () => {
    await expect(tool.run({}, context({ workspace: undefined }))).rejects.toThrow('no workspace');
    await expect(tool.run({}, context({ threadId: undefined }))).rejects.toThrow('no workspace');
    expect(changes.sync).not.toHaveBeenCalled();
  });
});
