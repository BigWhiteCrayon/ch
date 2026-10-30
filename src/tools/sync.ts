// The tool a thread brings itself level with its workspace by, before it says
// its work is done.
//
// A thread works on a copy of the workspace taken when its container was made,
// and the workspace does not stand still: the user edits a file, another thread
// writes its changes back. What that costs is paid at the end, when the changes
// are applied and a file will not go back — so this moves the cost forward, to
// where the thread still has the problem in mind and can do something about it
// (see ../sandbox/changes.ts).
//
// It is also run on the thread's behalf when a reply that changed files is
// about to end (see ../harness/index.ts), so the user is told the work is ready
// only when it is.

import * as changes from '../sandbox/changes';
import type { Tool } from '../types';

export const TOOL_NAME = 'sync_workspace';

export const tool: Tool = {
  name: TOOL_NAME,
  phases: ['execute'],
  needsWorkspace: true,
  description: `Bring your copy of the workspace level with the workspace itself, and find out whether your changes
still fit into it. The workspace is on the user's computer and does not stand still while you work: they edit files,
and other threads write their own changes back.

Returns three things. Files the workspace has moved on in that you had not touched are brought into your copy, and
named so that you know what you read of them is out of date. Files you both changed, where the two sets of changes
fit together, are named and need nothing. Files you both changed in ways that do not fit are named with the reason,
and the workspace's version of each is put where you can read it, for you to reconcile.

Call it when you have finished changing files, before you tell the user the work is done — it is run for you then in
any case, so calling it yourself only means finding out sooner. Call it again after reconciling anything it found.`,
  inputSchema: { type: 'object', properties: {} },

  async run(_input, { threadId, workspace }) {
    if (!threadId || !workspace) throw new Error('This thread has no workspace to be brought level with.');
    return changes.report(await changes.sync(threadId, workspace));
  },
};

export function registerTools(registry: { register(tool: Tool): void }): void {
  registry.register(tool);
}
