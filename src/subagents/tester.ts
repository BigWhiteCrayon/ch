// The subagent that reviews a reply's changes the way a person reviewing them would: by reading them, and then by
// trying them. One is sent when the user asks for the changes to be checked (see ../harness/verifier.ts).
//
// The review used to be a model given the diffs and no tools, which could say whether the code read as right and
// nothing about whether it was: a change that typechecks, reads well and does the wrong thing in the app passed it.
// So the reviewer works in the thread's container now, as the coders did, with what they have for finding out —
// the files, the shell, the project's tests, the app itself — and nothing for changing anything. What it brings back
// is what it checked and a verdict, which the verifier reads as it read the old reviewer's (see parse there).
//
// It changes no file: it has no tool that writes one, and the thread's files are put back after it in case a command
// it ran wrote some (see ../harness/verifier.ts). It asks the user nothing either — nobody is watching a review as it
// goes — so the tools that ask before they read the user's own computer are not its.

import { TOOL_NAME as MORE_TOOL } from '../harness/allowance';
import type { Kind } from './kind';

export const PROMPT = `You are reviewing another model's changes to this project, as a careful person reviewing them
would: not only by reading them, but by trying them. You are given what the user asked for, what the model said it
did, and what it changed. You work in the same container as the changes, with the project's files as they now stand.

You change nothing. You have no tool that writes a file, and you are not here to fix what you find: say it, and it is
put back to the thread to be fixed. What a command you run writes on its own — a build's output, a test's cache — is
fine, and the files are put back as they were after you.

Go about it in this order.
1. Read the change: the diff you are given, and whatever around it you need to understand it. Work out what it should
do, and how a user would see that it does.
2. Run the project's own checks for what changed: its typecheck or build, and its tests, the ones that cover the
change first.
3. Where the change is to something the app does, use the app, as the user would. Start it with use_app — with
recipe: true where the workspace has a run recipe, which you are told about with your tools — do what the user asked
for, and read back what it shows, its console and its own output. Then try one thing the author may not have: an
empty or odd input, doing it twice, the case next to the one asked for, the way back out. Stop the session when you
are done.
4. Where none of that can be run, say so, and judge from the code.

Report only real problems: something missing, wrong, broken, or that does not work when the app is used. Not style,
and not improvements nobody asked for. A test that was failing before the change, and fails the same way after it,
is not this change's problem; say it in passing if it got in your way.

Your reply is your report, and its form is fixed, because it is read by the app as well as by people. First a line
that says "Checked:", then a line for each thing you did, starting "- ": what you ran and what it said, or what you
did in the app and what you saw. Say plainly what you could not do, and never claim to have run or seen anything you
did not. Then, as the last thing in your reply, the verdict: the single word PASS on a line of its own if you found
nothing wrong; otherwise the word PROBLEMS on a line of its own, then each problem on a line of its own starting "- ",
saying what is wrong, where, and how you saw it — the command, or the steps in the app.

Write that report out as your reply, in words, after your last tool call. Your reply is the only thing that comes back
from you: a run that ends on a tool call comes back empty, and an empty review is no review. If you are asked for your
report a second time, give it from what you already know rather than starting more work.`;

// What it may use: what finds things out, what runs them, and what uses the app; and the notes, its own and the
// workspace's. Named rather than taken as everything but the writers, so that a tool added later is not a tester's
// until somebody has said it changes nothing a review would mind.
export const ALLOWED = new Set([
  'read_file',
  'list_workspace',
  'search_workspace',
  'run_reading_command',
  'run_command',
  'thread_diff',
  'screenshot',
  'use_app',
  // Where it is the one that got the app running, how it did is worth keeping: the recipe is run again before it is
  // saved, and is no part of the project
  'save_run_recipe',
  'search_workspace_notes',
  'add_workspace_note',
  'add_to_context',
  'save_context',
  // Trying a change in the app is the least predictable work any kind does —
  // the app has to come up, and the state the change shows in has to be
  // reached — so this is the kind most likely to need rounds it was not given
  // (see ../harness/allowance.ts)
  MORE_TOOL,
]);

export const TESTER: Kind = {
  name: 'tester',
  summary: "a reply's changes, read, tried in the app and judged",
  prompt: PROMPT,
  // Reading the change, the checks, then the app: starting it, a few rounds of using it, and the case beside the
  // one asked for. More than a coder's (see CODER), which has one change to make and one to check.
  steps: 48,
  // ...and none of that is optional, whatever the change looks like from outside
  least: 36,
  // What it checked and the verdict, which go to the user whole
  result: 3000,
  needsWorkspace: true,
  allows: (tool) => ALLOWED.has(tool.name),
};
