// Every tool a model can call, in one place: this folder holds what each one
// is called, what the model is told about it, and what calling it does. The
// work itself mostly lives elsewhere — the container, the embeddings, the
// notes on a workspace — and these are the faces those things show a model.
//
// They are registered with the harness's registry at startup (see
// ../harness/tools.ts, which is the registry rather than any tool).

import { breadth } from '../harness/phases';
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
import * as steps from './steps';
import * as subagents from './subagents';
import * as threads from './threads';
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
  steps,
  subagents,
  threads,
  sync,
  workspaces,
};

// In the order they are registered, which is the order a model is shown them
// once the ones its step does not offer are taken out (see toolsFor in
// ../harness/index.ts).
//
// Written widest first: a tool every step offers above a tool one step offers,
// so that two steps of a reply share as much of the list as they have in
// common. What that buys, and why the order is sorted rather than written out,
// is in ../harness/phases.breadth. The order here is what the sort starts from,
// which settles the tools of equal breadth: a sort that keeps what it is given
// where it finds it.
const registered: Tool[] = [
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
  // The threads a model can list and message, the cross-thread counterpart of the
  // subagent tools just above (see ./threads.ts)
  ...threads.tools,
  ask.tool,
  // Asking for more rounds than the allowance holds, which every loop that
  // counts rounds answers (see ../harness/allowance.ts)
  steps.tool,
  sync.tool,
  diff.tool,
  // Last, so that the tools a general chat has and a workspace chat has not are at the end of the list it is sent
  ...workspaces.tools,
  // ...and the ones only a subagent is shown, which no reply's list ends with at all
  ...branches.tools,
];

export const all: Tool[] = [...registered].sort((a, b) => breadth(b) - breadth(a));

export function registerAll(registry: { register(tool: Tool): void }): void {
  for (const tool of all) registry.register(tool);
}
