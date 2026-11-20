// The one place the two decision loops agree on how much work they get.
//
// There are two of them (see ../subagents/index.ts): a reply is worked through
// the whole of the harness flow (../index.ts), and a piece of work handed out to
// a subagent runs a small loop of its own (../subagents/run.ts). The two loops
// are deliberately different — a reply routes to a model and reads for the user,
// a piece does not — but the two that sized them apart used to be sized apart:
// the rounds an effort buys and the per-request time a call is given were each
// defined by both, and a value the two keep a copy of is a value that drifts.
//
// So the values that should be one are here, and both loops read them from this
// file rather than each keeping its own copy:
//
// - EFFORT_STEPS and WORKSPACE_STEPS, which together are how many rounds a reply
//   or a piece gets for an effort (see maxSteps below and stepsFor in
//   ../subagents/run.ts).
// - PER_REQUEST_TIMEOUT_MS, the time one model call is given, which the piece's
//   loop applies and the reply's flow does not (see below).
//
// What stays apart is said where it lives, and only the shared part is shared: a
// reply sets no per-request time at all, and a piece's rounds come off its own
// kind's budget (see ../subagents/run.ts), so this holds the multipliers and the
// cap, not the answer each loop works out from them.
//
// It imports neither the harness nor the subagents, so that both may import it
// without a cycle: the two loops already meet at ./allowance for the granting of
// rounds, and this is the same kind of shared thing beside it.

import type { Effort } from '../types';

// How the rounds a loop gets scale with the effort the work is judged to need:
// half for low, the whole for medium, twice for high. The one thing the reply's
// flow and the subagent's loop share — the reply's own rounds are 20 of medium
// (see NO_WORKSPACE_STEPS) and a piece's are its own kind's steps (see
// ../subagents/run.ts), but both are multiplied by this, so the two loops' "how
// many rounds does this effort buy" is one table rather than two that have to be
// kept in step.
export const EFFORT_STEPS: Record<Effort, number> = { low: 0.5, medium: 1, high: 2 };

// ...and how many times as many rounds a loop that has a workspace to work in
// gets, where finding, reading and changing files all take tool calls.
export const WORKSPACE_STEPS = 6;

// The rounds a reply of an effort gets with no workspace: 20 of medium, scaled by
// EFFORT_STEPS, so low is ten and high is forty. Written as a multiple of the
// same EFFORT_STEPS a piece is scaled by, which is why the two loops share this
// file: the no-workspace rounds a reply used to get (ten, twenty, forty) are the
// same three numbers a piece gets scaled from its own kind, and the two were the
// drift the two tables were made to prevent.
const NO_WORKSPACE_STEPS = 20;

// How many rounds of tool calls a reply may take before it is stopped (see the
// loop in ../index.ts). More for more effort, and six times as many in a thread
// that has a workspace to work in.
export function maxSteps(effort: Effort, inWorkspace: boolean): number {
  return Math.ceil(NO_WORKSPACE_STEPS * EFFORT_STEPS[effort] * (inWorkspace ? WORKSPACE_STEPS : 1));
}

// How long one model call a subagent makes is given before it is read as a
// failure (see ../subagents/run.ts, which passes it as ChatRequest.timeoutMs at
// every call it makes).
//
// A reply sets no such cap: an interactive reply is left to the user's own
// "stop it" rather than a clock, and the per-request deadline belongs to a
// request that another is waiting on (see ChatRequest.timeoutMs in ../types.ts
// and wholeBudget in ../llm/index.ts, which keep the two apart). So this value
// is the piece's cap, defined here because it is the one knob the two loops are
// kept in step on, and not applied by the reply's flow on purpose.
export const PER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
