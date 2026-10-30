// The tool a thread looks over its own changes by: what it has changed in its
// container since its workspace was last brought level (see ./sync.ts), or since
// it was copied in if it never has been. The same diff the user is shown when
// they look over the thread's changes (see ../sandbox/changes.ts).

import * as changes from '../sandbox/changes';
import type { Tool } from '../types';

export const TOOL_NAME = 'thread_diff';

export const tool: Tool = {
  name: TOOL_NAME,
  // There is nothing to see until files are being changed
  phases: ['execute'],
  needsWorkspace: true,
  description: `See the changes you have made to the files in your copy of the workspace, as a diff for each changed
file. They are measured from the last time your copy was brought level with the workspace (see sync_workspace), or from
when it was first copied if that has not happened yet. Files you did not touch are not shown, and nor are files that
came in from the workspace when it was last synced.

Use it to check what you have actually done before you say the work is done.`,
  inputSchema: { type: 'object', properties: {} },

  async run(_input, { threadId, workspace }) {
    if (!threadId || !workspace) throw new Error('This thread has no workspace to have changes in.');
    return changes.describeChanges(await changes.list(threadId));
  },
};

export function registerTools(registry: { register(tool: Tool): void }): void {
  registry.register(tool);
}
