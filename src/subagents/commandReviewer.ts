// The subagent that judges whether a git command that could lose work may run
// without the user being asked. One is sent when a command that could throw work
// away or reach a repository elsewhere is about to run and the user has not yet
// been put to (the gate that wires it is the runner in ../harness/commandReview.ts,
// which runs it from the command-approval gate in ../tools/hostReading.ts; the tool
// that asks the user is the one it is standing in for).
//
// It is a judge, not a doer. It is given the user's request, the command and the
// folder it would run in, and why the command is considered risky. It may read
// the repository state — its history, its diff, what is uncommitted — to see
// whether what the command would throw away is in fact what the user meant to
// throw away, but it runs nothing itself, writes nothing, and moves the thread
// nowhere: a reviewer that ran the very command it was judging would not be
// judging it, and one that changed anything would be changing what it was asked
// to stand still and look at. What it brings back is what it checked and a
// verdict, which the gate reads as it read the tester's (see ./tester.ts).

import { TOOL_NAME as MORE_TOOL } from '../harness/allowance';
import type { Kind } from './kind';

export const PROMPT = `You are a command reviewer. A git command that could lose work is about to run in a
repository, and you have been asked to judge whether it may run without the user being put to. A run that you
approve is a run the user never sees and cannot stop, so holding is the safe side of any doubt.

You are given three things.
1. The user's request: what the user is asking for, which is the only reason a destructive command is in place at all.
2. The command, and the folder it would run in: the exact thing that would be done, and where.
3. Why it is considered risky: the reason this command is one that could throw work away or reach a repository
elsewhere — a force, a reset, a clean, a push, or the like.

Judge whether it may run without asking. Read the repository state to decide: its history, its diff, what is
uncommitted — anything read-only that tells you what the command would touch. Do not run the command itself, and
do not change anything: you are not the one that runs it, and a repository you left as you found it is the only
one your verdict can stand on.

Approve only when the command is non-destructive, or is clearly within what the user asked for: the thing it would
throw away is what the user meant to throw away, and the request names it. Otherwise hold: where what is at stake is
not clearly within the request, or where you cannot tell from the repository, the user is asked rather than the work
thrown away.

Say what you checked first, then the verdict last. Your reply is your report, and its form is fixed, because it is
read by the app as well as by people. First the things you looked at — the command and folder, what you read of the
repository, and how it bore on the request — one line for each, starting "- ". Then, as the last thing in your reply,
the verdict: the single word APPROVE on a line of its own if the command may run without the user being asked;
otherwise the word HOLD on a line of its own, then a line for each reason, each starting "- ", naming what the
command would do and why it is not within the request.

Write that report out as your reply, in words, after your last tool call. Your reply is the only thing that comes
back from you: a run that ends on a tool call comes back empty, and an empty verdict is no verdict. If you are asked
for your report a second time, give it from what you already know rather than starting more work.`;

// What it may use: what reads things out, and what writes down where it got to.
// Named rather than taken as everything but the writers, so that a tool added
// later is not a reviewer's until somebody has said it changes nothing a verdict
// would mind. It has no tool that runs a command that could change the
// repository: run_host_command, which reaches the repository on the user's own
// computer, is not here, and neither is run_command, which runs anything at all
// (see ./explorer.ts, which is the one read-only kind and which still lets it
// read the repository read-only). A judge that could run the command it is
// judging, or change what it is judging it against, is no judge.
export const ALLOWED = new Set([
  'read_file',
  'list_workspace',
  'search_workspace',
  // The commands that only read — history, counts, what is installed — and not
  // run_command or run_host_command, which could run the very command under
  // judgement. Reading the repository's state through this is the most the
  // reviewer does, and it is read-only.
  'run_reading_command',
  // ...and reading what was written down about the workspace before, which is
  // how it sees whether the state it is judging is anything unusual
  'search_workspace_notes',
  // A note of its own: what it has read and worked out so far, where nothing
  // else can write over it. For how far it has got, which is nobody else's
  // business; nothing it judges is written to the workspace's notes, because a
  // verdict is about one command at one moment, and is not a thing to be
  // searched for afterwards.
  'add_to_context',
  'save_context',
  // The verdict can come back sooner than the rounds it was given, and can run
  // short of them where the repository it is judging is larger than the request
  // looked — one of the cases the asking is for (see ../harness/allowance.ts)
  MORE_TOOL,
]);

export const COMMAND_REVIEWER: Kind = {
  name: 'command-reviewer',
  summary: 'a git command that could lose work, judged safe to run without the user being asked',
  prompt: PROMPT,
  // A little reading — the command, a look at the repository's state — and then
  // a decision. Far less than a tester, which reads a change and tries it in the
  // app; this one runs nothing and ends on a verdict.
  steps: 16,
  // What it checked and the verdict, which go to whoever runs the command next
  result: 2000,
  // It is run by the gate, which may sit in a thread with no workspace (a
  // command that could lose work is asked about in any thread), and a kind that
  // wants one throws when run without it (see ../harness/commandReview.ts, where
  // it is run, and findings in ./run.ts, which throws for a workspace-wanting
  // kind sent in a thread with no workspace). It reads the command's folder,
  // not the thread's workspace, so it wants none.
  needsWorkspace: false,
  allows: (tool) => ALLOWED.has(tool.name),
};
