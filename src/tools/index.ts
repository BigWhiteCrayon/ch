// Every tool a model can call, in one place: this folder holds what each one
// is called, what the model is told about it, and what calling it does. The
// work itself mostly lives elsewhere — the container, the embeddings, the
// notes on a workspace — and these are the faces those things show a model.
//
// They are registered with the harness's registry at startup (see
// ../harness/tools.ts, which is the registry rather than any tool).

import type { Tool } from '../types';
import * as ask from './ask';
import * as branches from './branches';
import * as context from './context';
import * as diff from './diff';
import * as files from './files';
import * as hostReading from './hostReading';
import * as list from './list';
import * as notes from './notes';
import * as reading from './reading';
import * as review from './review';
import * as sandbox from './sandbox';
import * as search from './search';
import * as subagents from './subagents';
import * as sync from './sync';
import * as workspaces from './workspaces';

export {
  ask,
  branches,
  context,
  diff,
  hostReading,
  list,
  notes,
  reading,
  review,
  sandbox,
  search,
  subagents,
  sync,
  workspaces,
};

// In the order a model is shown them, which is the order they are registered
export const all: Tool[] = [
  ...sandbox.tools,
  ...reading.tools,
  ...files.tools,
  ...hostReading.tools,
  ...search.tools,
  ...list.tools,
  ...review.tools,
  ...context.tools,
  ...notes.tools,
  ...subagents.tools,
  ask.tool,
  sync.tool,
  diff.tool,
  // Last, so that the tools a general chat has and a workspace chat has not are at the end of the list it is sent
  ...workspaces.tools,
  // ...and the ones only a subagent is shown, which no reply's list ends with at all
  ...branches.tools,
];

export function registerAll(registry: { register(tool: Tool): void }): void {
  for (const tool of all) registry.register(tool);
}
