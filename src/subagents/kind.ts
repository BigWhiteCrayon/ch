// What a kind of subagent is. The kinds themselves are one to a file beside
// this one; the loop that runs any of them is in ./run.ts.
//
// A kind exists so that the pieces that differ between jobs are named in one
// place rather than threaded through as arguments: a reviewer answering one
// comment, a coder making one change and an explorer looking into one corner
// of a project want different instructions, different tools and different
// room to work in, but the loop that runs them is the same loop.
//
// This file holds only what every kind needs, so that a kind can import it
// without importing its siblings.

import type { Prefer } from '../harness/router';
import type { ModelInfo, Tool, ToolContext } from '../types';
import type { Finding, Task } from './run';

// The tool a model hands work out with (defined in ../tools/subagents.ts).
// Named here because a kind has to say whether it may use it: most may not,
// and the ones that may (see ./explorer.ts) are kept from going on for ever by
// depth rather than by refusal.
export const TOOL_NAME = 'hand_to_subagent';

// ...and the one it collects a subagent it did not wait for with (defined in
// ../tools/subagents.ts). A kind that may hand work out may wait for it: the
// two are the same act, a round apart.
export const WAIT_TOOL = 'wait_for_subagent';

// ...and the one it writes to a subagent of its own with while that subagent
// is still working, and is answered by (defined in ../tools/subagents.ts, and
// the letterbox behind it in ./mailbox.ts). Refused to a kind that cannot hand
// work out, for the same reason as handing out itself: the names it would be
// writing to are the names of its own siblings, each of them in the middle of
// a piece that is none of its business.
export const MESSAGE_TOOL = 'message_subagent';

// The tool a model stops to ask the user something with (defined in
// ../tools/ask.ts). No subagent may use it: several of them run at once, out
// of the user's sight, and a question from one of them has nobody to be put to.
export const ASK_TOOL = 'ask_user';

// How deep the chain of subagents may go. A reply hands out at depth 0, so a
// subagent it sent is at 1 and may hand out again; what that one sends is at 2
// and may not. Two levels is what the work actually calls for — an explorer
// that finds its area is really three areas can split it, and the three have
// nothing left to split — and the limit matters because the tree grows by
// multiplication: five sent by five sent by five is a hundred and twenty-five.
export const MAX_HANDOUT_DEPTH = 2;

export interface Kind {
  // What this kind is called: in its own line in the thread, in the log, and
  // in the tool call that asks for one
  name: string;
  // One line for the model choosing between the kinds (see ../tools/subagents.ts)
  summary: string;
  // What one of them is told it is, and what it is for
  prompt: string;
  // Rounds of tool calls one of them gets. It has one piece of work, so it
  // needs far fewer than the model that sent it.
  steps: number;
  // ...and the fewest it can be given, however little work the piece looks
  // like from outside. Effort is rated by how much looking a piece needs (see
  // the effort description in ../tools/subagents.ts, where low is "one or two
  // calls answer it"), and for most kinds that is the whole of it: a worker
  // asked one small question really is done in two rounds. A kind whose own
  // prompt tells it to do several things in order has a floor under that
  // which no rating takes away, and says so here (see CODER.least).
  least?: number;
  // What it brings back, in characters: enough to be useful, bounded so that
  // several of them cannot fill the window of the model that has to read them
  result: number;
  // Which side of the machine this kind's work belongs on, where that matters
  // more than picking the least capable model that can do it (see Prefer in
  // ../harness/router.ts). Exploring is the case: it is long, it is nobody's
  // message, and run on hosted models it queues behind — and ahead of — what
  // the user actually asked for.
  prefer?: Prefer;
  // Whether this kind's own prompt already tells it what it is to do with the
  // workspace's notes. An explorer's notes are its output and most of its
  // prompt is about them (see ./explorer.ts and ./head.ts), so saying the
  // general thing after that would be repeating in weaker words what it has
  // just been told more precisely. Every other kind is told it, since every
  // other kind has the tools and none of their prompts mentions them (see
  // SUBAGENT_PROMPT in ../harness/notes.ts).
  saysNotes?: boolean;
  // Whether it only makes sense in a thread that was started in a workspace. An
  // explorer's work is the workspace and the note on it, so one sent in a thread
  // without a workspace would have nothing to look at and nowhere to write.
  needsWorkspace?: boolean;
  // Whether it may use a tool
  allows(tool: Tool): boolean;
  // What runs one of them, where the loop beside this file is not what this
  // kind wants. Unset — which is every kind but one — means ./run.ts: a few
  // rounds of tool calls, one piece of work, a report at the end.
  //
  // The one kind that sets it is the agent (see ./agent.ts), which goes
  // through the whole of the reply flow instead (see ./thread.ts). It is named
  // here rather than branched on in ./run.ts so that the loop that runs the
  // small kinds does not have to know that the other kind exists: a kind is
  // where the things that differ between jobs are named, and which loop runs
  // it is the largest of those things.
  run?: Runner;
}

// What a runner is given and what it brings back, which is what ./run.ts's own
// loop takes: the piece, the thread it is working in, the model it was routed
// to, and the models there are for anything it routes itself.
export type Runner = (
  piece: Task,
  context: ToolContext,
  model: { provider: string; model: string },
  models: ModelInfo[]
) => Promise<Finding>;

// The tools that overwrite something shared, which no subagent may use: with
// several of them at work at once, a wholesale write is one subagent throwing
// away what another just did. An explorer adds to the workspace note instead
// of replacing it (see ./explorer.ts), and the note as a whole is the
// business of the model that sent them.
export const OVERWRITES_SHARED = new Set(['update_workspace_context']);

// The tools that make a workspace for the thread and move it in. Which workspace the thread lives in is the reply's
// to decide, and several subagents at work at once would each make one.
//
// The branch tools (../tools/branches.ts) are the one move a subagent may make, and are deliberately not here: a
// subagent is where it is found that the work wants a branch of its own. They are safe where these are not because
// they leave the container alone — only where the thread's changes are written back changes — and because the first
// subagent to move the thread is the one that moves it, which the tool itself sees to.
export const MOVES_THREAD = new Set(['create_workspace', 'enter_workspace']);

// The tools whose whole point is to put something in front of the user, which
// a subagent cannot do: what it returns is a written report, and anything else
// it produced is dropped when it ends. A screenshot is not here — a subagent
// takes one to look at its own work, which is worth the three seconds, and
// says in its report how to draw it (see ./coder.ts). A recording buys the
// same look for a great deal more: the model sees frames of it, which is what
// screenshots already are, and the clip itself — the one thing recording is
// for — goes nowhere.
export const SHOWS_THE_USER = new Set(['record']);

// What no kind of subagent may do, whatever else it is allowed
export const forbidden = (tool: Tool): boolean =>
  tool.name === TOOL_NAME ||
  tool.name === MESSAGE_TOOL ||
  tool.name === ASK_TOOL ||
  OVERWRITES_SHARED.has(tool.name) ||
  MOVES_THREAD.has(tool.name) ||
  SHOWS_THE_USER.has(tool.name);
