// The steps a coding change is worked through: find out, say what you are
// going to do, do it, say what you did.
//
// The decision loop used to be one long run of tool calls under one set of
// instructions, with the order of the work asked for in prose (see
// TASK_PROMPTS.coding in index.ts) and nothing to make it happen. A model
// holding tools always has a cheaper next move than writing a plan, so the
// plan was the step that went missing — which is the one step the user is
// there for, since it is their chance to stop the work before it happens.
//
// So the order is the harness's now rather than the prompt's. Two things make
// it hold:
//
// * The tools change with the step. Nothing that writes is offered while the
//   model is still working out what to do, and in `plan` and `respond` there
//   are no tools at all — writing is the only move left, so it gets made. In
//   `execute` nothing writes a file either: the change is made by the coders
//   the step hands it to, so handing it out is the only way to make it, and
//   each piece is made by somebody holding that piece and nothing else.
//
// * Each step is given the one before it, not everything that has happened.
//   What carries forward is what that step wrote down: its findings, then the
//   plan, then the account of what was done. The tool calls and their results
//   are left behind with the step that made them. A step therefore starts
//   nearly empty, and what the next one knows is what the last one thought
//   worth saying — which is also what the user is shown.
//
// What does carry across everything is the thread's context note, because the
// model writes that with a tool and the container keeps it: it is read afresh
// as each step's instructions are built (see systemPrompt in index.ts). A
// step with something to pass on that does not belong in its closing words
// has somewhere to put it.

import type { Phase, Tool } from '../types';
// The names of the three tools that hand work out, from the module that only
// declares them: the finding-out step and the planning step may send work out,
// and a prompt that names a tool has to name it as the model sees it (see
// tools/subagents.ts). Taken from ../subagents/kind rather than ../subagents so
// that this stays a leaf.
import { ASK_TOOL, MESSAGE_TOOL, TOOL_NAME, WAIT_TOOL } from '../subagents/kind';
// ...and the name of the tool a model asks for more rounds with, from the
// module that holds what the asking gets (see ./allowance.ts). A step is told
// about it in the same breath as its allowance, because a ceiling that can be
// raised is a different thing to work under than one that cannot.
import { MAX_GRANTS, TOOL_NAME as MORE_TOOL } from './allowance';

// In order. A reply starts at the first and ends by finishing the last.
export const ORDER: Phase[] = ['explore', 'plan', 'execute', 'respond'];

// The three tools that hand work out, offered together and withheld together
// (see the loop that withholds them at the bottom of the chain in
// ../index.ts). Named here rather than imported, for the same reason the
// handout tool's name is taken from ../subagents/kind: to keep this a leaf.
const HANDS_WORK_OUT = new Set([TOOL_NAME, WAIT_TOOL, MESSAGE_TOOL]);

// The steps of an investigation, which reads and writes up and changes nothing:
// find out, then say what was found.
export const INVESTIGATION: Phase[] = ['explore', 'report'];

// An investigation with no workspace to read: there is nothing to find out, so
// it is only written up.
export const WRITE_UP: Phase[] = ['report'];

// The steps of a suggestion, which finds out how the code stands and then
// suggests a change to it: find out, then suggest. The finding-out step is the
// same one an investigation starts with; the suggest step is the one that holds
// the tools that make the change (see hasTools) and is read by the user (see
// readByUser) — the change is made in a demo copy and reverted, so it is the
// suggestion's words and its pictures that reach the user, not the files.
//
// A suggestion with no workspace to read is only written up, like an
// investigation without one (see WRITE_UP).
export const SUGGESTION: Phase[] = ['explore', 'suggest'];

export const last = (phase: Phase, order: Phase[] = ORDER) => phase === order[order.length - 1];
export const next = (phase: Phase, order: Phase[] = ORDER): Phase | undefined => order[order.indexOf(phase) + 1];

// Whether a step has tools at all. The two that do not are the two whose
// whole job is to write something: given a tool, a model reaches for it.
export const hasTools = (phase: Phase) => phase === 'explore' || phase === 'execute' || phase === 'suggest';

// Whether what a step writes is read by the user. The plan is put in front of
// them before any of the work happens, and the answer is the reply itself;
// what the other two write is a handover to the step after them, and a step
// told to write what the user will read while it is writing for itself has
// been given two jobs and will not finish either.
export const readByUser = (phase: Phase) =>
  phase === 'plan' || phase === 'respond' || phase === 'report' || phase === 'suggest';

// Whether a tool is offered in a step. A tool that says nothing is offered
// wherever there are tools, which is what a tool that only reads wants (see
// Tool.phases).
//
// The planning step is the exception to having none. It stops to ask the user
// something, since the plan is where a reading of the request is settled and a
// question is better put before it than after it. It may also send work out: the
// plan is the step that decides how the change is cut, and an explorer reads in
// a window of its own, so a plan that needs to know something across a part of
// the project the finding-out step did not reach is better planned with it than
// one that names a file it never saw. What it may send is only an explorer, which
// reads and writes notes and changes nothing (see the refusal in
// ../tools/subagents.ts), so the three tools that hand work out are offered to it
// as well as the one that asks. Those four are all it is offered; its
// instructions are built as for a step with no tools, so it is not told how to
// break the work up or how to make the change (see systemFor in index.ts).
export const offers = (tool: Tool, phase: Phase) =>
  phase === 'plan'
    ? tool.name === ASK_TOOL || HANDS_WORK_OUT.has(tool.name)
    : hasTools(phase) && (tool.phases?.includes(phase) ?? true);

// Whether this reply is worked through in steps at all.
//
// Working a change through in four steps buys a plan the user can stop before
// anything happens, and costs four passes over the model where one would have
// done. A thread set to plan always pays that and one set never to does not
// (see plan in ../renderer.ts); for any other, whether this task is worth it is
// asked of a model when it starts (see planner.ts), which is why `plan` is
// here: it is the answer to that, and false is no plan.
//
// Beyond that, only a coding change in a workspace: a question has nothing to
// explore, and a thread with no workspace has no files to plan changes to.
//
// A reply picked up after the app closed is left out as well. It has already
// done work it is being told not to do again, and starting it at `explore`
// would have it plan afresh and leave the user looking at two plans for the
// one message.
//
// An investigation is the other way in: asked for outright, by the thread's
// setting or by the classifier judging the message one, rather than from a
// coding task. With a workspace to read it is worked through in two steps,
// finding out and writing up (see INVESTIGATION); without one, it is only
// written up (see WRITE_UP). It is left out when resumed for the same reason.
export function forReply({
  plan,
  category,
  workspace,
  tools,
  resumed,
}: {
  plan: boolean;
  category: string;
  workspace: boolean;
  tools: boolean;
  resumed: boolean;
}): Phase[] | null {
  if (category === 'investigation' && !resumed) return workspace && tools ? INVESTIGATION : WRITE_UP;
  if (category === 'suggestion' && !resumed) return workspace && tools ? SUGGESTION : WRITE_UP;
  return plan && category === 'coding' && workspace && tools && !resumed ? ORDER : null;
}

// How much of a reply's rounds of tool calls the finding-out step may have.
//
// It needs a cap because nothing else stops it. A model holding tools can
// always find one more thing worth reading, and nothing it reads is ever
// wasted from where it is standing — so the step runs until the window is
// full, and the reply that was meant to buy the user a plan arrives as a
// message saying it ran out of room (see OUT_OF_ROOM in ./index.ts). The
// doing step is the one that needs the rounds: it has to read what it
// changes, change it, and run the tests.
//
// A share rather than a number, since the whole budget already follows the
// effort the message was judged to need (see maxSteps), and a floor under it
// so that the smallest budget still leaves room to search twice and read what
// the searches point at.
//
// A sixth, which is about two searches and the files they point at. It was a
// third, and a third was still deep enough to read a module end to end: what
// the step is for is finding the parts the change touches and how they work,
// not coming to understand the area, and a step that goes deeper than that is
// spending the plan's room on an understanding that the plan never asked for.
// Only rounds of looking are counted — writing a note is free (see WRITES_DOWN
// in ./index.ts) — so the shallower pass costs the notes nothing.
const FINDING_SHARE = 1 / 6;
const MIN_FINDING_ROUNDS = 5;

// ...and no more than the window can hold, which the share above knows nothing
// about. A round of tool calls is an allowance of turns; what runs out first on
// a small model is not the turns but the room, because everything a round
// returns stays in front of the step until the step ends. A reply on a 32k
// model was being told it had twenty rounds of looking when the window had
// room for two: it spent them, filled the window, and the user got the message
// that says it ran out of room (see OUT_OF_ROOM in ./index.ts) in place of the
// plan the four steps exist to buy them.
//
// So the number the step is told is the smaller of what its effort bought and
// what its window affords. The floor above does not apply to the second: five
// rounds it has no room for is the same lie in a smaller number, and one round
// honestly stated is something a model can work with — it hands the rest to
// explorers, which read in windows of their own (see BUDGET below).
//
// The estimate is deliberately coarse, and it is of an average round rather
// than the worst one: a page of a file read with its line numbers is the
// dearest thing a round can return, and that page is sized to the window
// itself (see pageFor in ../tools/sandbox.ts), while a search, a search of the
// notes or a reading command costs a fraction of it. What the estimate is for
// is keeping the number in the same order of magnitude as the room, not
// predicting the next call.
//
// Cutting the share costs the reply nothing, which is what makes a ceiling
// here safe: the whole budget is unchanged, and what the finding-out step does
// not spend the doing step does (see maxSteps and BUDGET below).
const ROUND_SHARE = 0.04;
const BIG_ROUND = 3000;
// What the step's own instructions, the tools' descriptions and the
// conversation take before it has looked at anything
const PROMPT_RESERVE = 8000;
// The share of a window at which the harness starts condensing, which is the
// point this is keeping the step below (see nearlyFull in ./compactor.ts)
const NEARLY_FULL = 0.7;

export function findingRounds(limit: number, window?: number): number {
  const byEffort = Math.max(MIN_FINDING_ROUNDS, Math.floor(limit * FINDING_SHARE));
  if (!window) return byEffort;
  const perRound = Math.min(window * ROUND_SHARE, BIG_ROUND);
  const affords = Math.floor((window * NEARLY_FULL - PROMPT_RESERVE) / perRound);
  return Math.max(1, Math.min(byEffort, affords));
}

// Whether that allowance is the window's doing rather than the effort's.
//
// It is the question the step actually needs answered, because it changes what
// it should do rather than only how much of it: a step whose rounds ran out
// should look less, and a step whose room runs out first should look elsewhere
// — at explorers, which read in windows of their own (see BUDGET).
export const windowBound = (limit: number, window?: number): boolean =>
  window !== undefined && findingRounds(limit, window) < findingRounds(limit);

// What the finding-out step is told its allowance is. Told rather than only
// enforced: a model that knows what it has paces itself, and one that finds
// out by being cut off has already spent the room (the same reason a subagent
// is told how long its report may be — see room in ../subagents/run.ts).
// tight: the allowance is what the window affords rather than what the effort
// bought (see windowBound). Worth saying, and worth saying what to do about
// it: a model told only that it has few rounds spends them the same way it
// would have spent many, on the first few files, and then has neither the
// rounds nor the room. The way out is the one thing in this step that does not
// cost the window — an explorer reads in its own.
export const BUDGET = (rounds: number, tight = false) =>
  [
    `You have ${rounds} rounds of looking in this step: searches, reads, and commands that tell you something. That is
a ceiling, not a target. Most changes are found in a handful of them, and what you leave unspent goes to the doing
step, which needs it more. If you spend them all, the tools are taken away and you are asked for what you have —
which is the same ending as stopping on your own, reached later and with less to show.

The ceiling can be raised, and one kind of work should raise it: where what you are doing is reproducing a fault
rather than reading up on a change, how many rounds it takes cannot be known from the request, and ${MORE_TOOL}
asks for more of them. Say what you have established, what is still open and what the rounds are for. ${MAX_GRANTS}
such grants are all anyone gets, and they are for a guess that has to be tested against the running thing, not for
one more look at something you already believe.

Writing something down does not count against it. A round spent only on add_workspace_note, add_to_context or
save_context tells you nothing you did not already have, so it costs you nothing here: you can never buy yourself
more reading by leaving your findings unwritten, and leaving them unwritten is the one thing in this step that
cannot be undone later.`,
    tight
      ? `That is fewer rounds than the effort of this request alone would have bought you, and the reason is room
rather than effort: everything a round returns stays in front of you until this step ends, so the room runs out
before the rounds would. Reading this project into this window yourself is not a plan that ends well — you would
spend the lot on the first few files and have neither the rounds nor the room for the rest.

So look elsewhere rather than less. Hand every question wider than a single file to an explorer: it reads in a window
of its own, not in yours, and what comes back is a few sentences and notes you can search for the one line you need.
Several at once cost you one round between them. Keep your own reading for the one or two files the change actually
lands in, and let the explorers have the rest.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

// ...and what it is told when they are gone. This is the only place it is
// told: the step's instructions and its tools stay exactly as they were, so
// that a local server can keep what it has already read of the prompt and
// read only this (see systemFor in ./index.ts). So this has to say what the
// instructions no longer do — that the tools listed above are not to be
// called — and a call made anyway is dropped rather than run (see spent in
// ./index.ts), which leaves writing down what it has as the only move it can
// make: the same thing that makes the planning step work at all.
// why: which of the two ran out. The step ends when its rounds are gone or
// when the window is nearly full, whichever comes first (see the loop in
// ./index.ts), and a model with rounds still in hand that is told it has spent
// them has been told something it can see is untrue of itself.
// mayAsk: whether a grant of more rounds is still to be had (see
// ./allowance.ts). Where it is, this says so and names the one call the step
// may still make, because a model that has just been told its tools are dead
// will not try a tool to revive them unless it is told that one works. Where
// it is not — two grants already spent, or a window with no room for what
// another round would return — it is not mentioned at all: a door that cannot
// be opened is worse than no door, since the model spends a round finding out.
export const spent = (why: 'rounds' | 'window' = 'rounds', mayAsk = false) =>
  `${
    why === 'window'
      ? 'There is no more room in this window for finding out, so the step ends here rather than when your rounds ' +
        'would have'
      : 'Your rounds for finding out are spent'
  }. The tools are still listed above, and are no longer yours to call: a call made now is not
run, and the round it would have taken does not exist.${
    mayAsk
      ? ` One call is still answered, and it is ${MORE_TOOL}: where what is left is an experiment rather than another
read — a fault you have reproduced and not yet explained, a guess that one run would settle — ask for the rounds to
do it, saying what you have and what they are for. Where it is not, do not ask; write down what you have instead.`
      : ''
  } What you have is what you have, so write it
down now: what you took the request to mean where it was not plain, the files that matter, how what is in them
works, and anything that will decide how the change is made. Not a plan — the step after this one
writes that, and what you write now is all it will have.

Where you were part way through working something out, write down what you believe and say that you did not confirm
it. The doing step reads the files again and can settle it there; what cannot be settled later is a write-up that
was never written.`;

// The doing step's reading is not capped, and was.
//
// It had a cap of a few rounds before its first handout, on the ground that
// what its reading led to was not there: while that step held the tools that
// write, reading ended in an edit, and once the change went out to coders the
// same reading ended in nothing. Two replies in the log spent seventeen and
// thirty-three rounds between the plan and the first thing anybody did with
// it, which was nothing, and the cap was what stopped a third.
//
// What it also stopped was the step finding out that the plan was wrong. A plan
// is written by a step with no tools from a write-up by a step that has run out
// of them, so the file it names can be a file the change does not go in — and
// then the reading the cap treats as putting the work off is the work: it is
// the first point in the reply where anything is read against the plan rather
// than from it. The reply this was taken off for had a plan that put the
// threads' save() and load() in harness/index.ts, which has neither; the doing
// step was stalled at five rounds, told to hand the plan out, and handed three
// coders a file with nothing in it to change. Capping the reading bought the
// handout and lost the change.
//
// So the reading is the step's own to spend now, and what bounds it is what
// bounds the reply: the step budget (see maxSteps in ./index.ts) and the
// window, which condenses and then ends the reply when it fills. That is a
// weaker bound than a cap and it is the honest one — a step reading towards a
// plan it has reason to doubt cannot be told in advance how many rounds the
// doubt is worth.
//
// What is kept is the telling. The step's own instructions still say that
// reading is not how it starts and that a file read to confirm what the plan
// already says is a piece that should have been handed out (see
// PROMPTS.execute), and the claims the plan rests on are checked against the
// files the finding-out step actually opened before the plan is written at all
// (see ./grounding.ts) — which is the cheaper place to catch the wrong file,
// and the reason the cap is affordable to lose.

// How many times a step that ended without writing anything is asked again
// for the words the next step is given.
//
// The finding-out step is asked harder than the others, because it is the one
// whose words are the whole of what the step after it has: the planning step
// has no tools and cannot go and look, so a finding-out step that writes
// nothing leaves it planning from the user's request alone — which is the one
// thing the four steps exist to stop. The others are asked once: a model with
// nothing to say the second time has nothing to say.
export const asks = (phase: Phase) => (phase === 'explore' ? 3 : 1);

// What the model is told it is doing, added to its instructions for the step.
// Each says what the step is for, what it has to work with, and what ends it.
export const PROMPTS: Record<Phase, string> = {
  explore: `You are in the FINDING OUT step, the first of four.

WHAT THIS STEP HAS TO PRODUCE: a write-up of how the code this request concerns works, handed on to the step that
plans the change. That write-up is the only thing that leaves this step — not your tool results, not your reasoning
— so it is the goal, and everything else here is in service of it.

You can run code in this step to find things out: start the app, run a test, reproduce a bug. run_command is offered
for that, alongside the tools that read, the ones that write down what you have read, run_reading_command, which runs
a counting or a reading command and refuses anything that could write, run_host_command, which is how the project's
history is read — your copy was made without its .git, so git log belongs there and not here — and ${TOOL_NAME},
which hands reading out to explorers
and to no other kind. What you cannot do is write a project file: the shell refuses writes to the project, so a demo
is made under /tmp and never in /workspace. You are not planning the change either — the step after this
one does that, from what you write at the end of this one.

To find out how something behaves, use the real application, not a script of your own. A script written to /tmp that
imports a module and calls it checks the code apart from the way the app uses it, and it is gone when this step ends.
Start the app with use_app instead. Where the workspace has a run recipe — you are told whether it has one, with
what it does — use_app with recipe: true builds it, starts whatever runs beside it, launches it and waits for it to
come up, all in one call, and that is the quickest way to the running app by a wide margin. Where there is none, a
web app's server goes first, with run_command, then use_app with its url; a desktop app is given with its command.
Either way, use it as the user would: click, type, press keys, and read back what it shows with the
text and eval steps, along with what it wrote to its console and its own output. The session stays up between
calls, so reproduce the bug one move at a time and look after each. Stop it when you are done.

Where what you need to see depends on data, give the app the data rather than changing its code: its own fixtures or
seed command where the project has them, or a data directory under /tmp written with the state you want and given to
the app at start-up. Only where the state cannot be reached that way, copy the project to /tmp/demo, excluding
node_modules, symlink /workspace/node_modules into it, and make the demo edits there.

To show how something looks, use screenshot — or use_app with screenshot: true — and record for behaviour over time,
given a use_app session to record the steps as they happen. The screenshots and recordings you take here are shown
to the user under the plan, so take them only where they help it: the current state of something, or a bug as it
happens. Where you got the app running and the workspace had no recipe, save how you did it with save_run_recipe:
the next thread that has to reproduce something starts from the running app instead of working the launch out
again. Note where its data lives with add_workspace_note, for the same reason.

Go about it in this order.

Start with the request itself, before you search anything. A request is usually less definite than it looks, and what
it leaves open is the likeliest thing to send the whole reply the wrong way: "add caching" does not say what to cache
or where it is kept, "make it faster" does not say which of the slow things to make faster, "fix the login bug" names
no bug, and "tidy this up" covers everything from renaming one thing to taking a module apart. So say to yourself
what the request does not pin down — which thing it means, where the thing goes, what it should be called, how far it
is meant to reach — and then watch for the answer while you read. The code usually settles it: a project has one
obvious place for a thing, and one way it already does things of that kind, and a request that is vague in the
abstract has one sensible reading here.

Where the code settles it, that is your reading and it needs no remark. Where it does not — where the request could
mean two things and this project would support either — write down both, and which you would take, in the write-up at
the end. You are not the last word either: the plan is put in front of the user before any of it happens, so a
reading you name is one they can correct in a sentence, and a reading you keep to yourself is one they discover from
the finished change. Naming it costs a line. Guessing silently costs the reply.

Where the two readings would send the change to quite different places and nothing you can read will tell you which
the user means, ${ASK_TOOL} stops and asks them, and the answer comes back to you. That is the exception: it takes
the user away from what they were doing, so it is for the question the whole change turns on, not for a detail you can
name a reading of.

Where the request says something is broken, see it happen before you read for it. A fault you have reproduced tells
you in one round what the code will not tell you in five: which input reaches it, what it does instead of what it
should, and where it stops. So run the thing — the project's tests for a failing test, use_app for anything the user
would do in the app, the command they ran for a command — and get the failure in front of you, with its message and
its stack, before you go looking for its cause in the files. Then work from the failure rather than from the
request: the line it names, what called that, and the value it did not expect. Where it will not reproduce, that is
itself a finding, and the write-up has to say so rather than leaving the next step to plan a fix for a fault nobody
has seen.

That is the work this step's rounds are worth asking to extend. A guess tested against the running thing is worth
more than three read off the code, and testing one costs a round whichever way it comes out — so where the rounds
run out mid-experiment, ask for more with ${MORE_TOOL} rather than writing up a cause you have not established.

Take the pictures here too, where there is anything to see. A fault that shows on screen goes in a screenshot, and
one that only shows while something happens goes in a recording of a use_app session: both are shown to the user
underneath the plan, so what they read is the plan against the fault as it actually behaves rather than against a
description of it.

Search the workspace's notes with search_workspace_notes before you search the code, and again whenever a fresh
part of the project comes into the work: what you are about to spend rounds working out, somebody working here may
have worked out and written down already.

Then search the code and read the files the search points to, the tests among them: a test is the shortest statement
of what the code it covers is supposed to do, and reading one is often quicker than reading what it covers. Where
the question is about the history rather than the code as it stands — when something changed, who changed it, what a
commit did — run_host_command answers it in one call, in the project's folder on the user's computer: your copy has
no .git, so git run in it finds no repository.

Send explorers for anything wider than that. You may hand work out here with ${TOOL_NAME}, to explorers and to no
other kind, and it is the difference between a step that can look at four parts of a project and one that can look
at one. An explorer reads in a window of its own, not in yours: it comes back with a few sentences on the shape of
what it read and leaves the detail in the workspace's notes, where you or the doing step can search for the one
line either of them needs. Reading those four areas yourself would cost you the window the plan has to be written
in, and you would be the only one who ever saw any of it.

So the rule of thumb: one file, or one thing in one file, read it yourself. A part of the project you would have to
read several files to understand — how a module fits together, how something is done across a directory, what some
other area does that this change has to match — hand it to an explorer and carry on with the rest while it works.
Hand out as many as there are independent areas, write each task for somebody who cannot see this conversation, and
say what to find out and what to report. You cannot hand out a change: an explorer cannot write to the project, and
no other kind may be sent from this step.

Write a note with add_workspace_note the moment you establish something, rather than at the end of the step: a note
written while the file is in front of you is worth more than one written afterwards from memory, and this step's
tool results are gone when it
ends. Write more of them than feels necessary — the bar is not "is this worth a note" but "did this cost me anything
to find out" — since none of it costs you a round of looking. The step that leaves six notes behind and understood
less is worth more to this project than the one that understood everything and left none.

Do not say what you are going to change, do not weigh one way of doing it against another, and do not begin writing
the change out in prose. A plan made here is read by nobody: the planning step is handed what you write and writes the
plan from it, so whatever you settle here it has to settle again. What it cannot do is go and look — it has no tools
at all — so what it knows about this project is what you tell it.

Where the request was that something is broken, none of that is the stopping point: stop when you have reproduced
the fault and can say what causes it, with the evidence that says so. A located fault is what the plan needs, and a
plan written from a guess about where the fault lives sends coders to the wrong file with every confidence. Where
you got as far as ruling things out and no further, that is what you write down, said as plainly as that.

Stop as soon as you can explain how the code the change touches works: which files it lives in, what each of them
does with what it is given, what calls what, and the conventions the code around it keeps. Keep to what the change
touches, and no further: you are not here to come to understand the area — that is an explorer's job — and the plan
does not ask for it. You do not have to have satisfied yourself about every case, or followed a call three files out
to see where it ends; the doing step reads the files again before it changes them, so a gap left here costs a read
later.

Reading on is not free, and it is not free in a way that is easy to miss from in here. Everything your tools return
stays in front of you for the rest of this step, so the search you make to settle a doubt is room the plan and the
change will not have. Two searches and the files they point at are usually the whole of it. If you are reading a file
to confirm something you already believe, you are finished — write it down instead.

Where it was a fault, the write-up carries the diagnosis as well: how to reproduce it, what the cause is, the
evidence for that, what would show it was wrong, and how sure you are. Say which of those you established and which
you did not, since the plan is written from this and cannot go back and look.

End this step by writing down what you found: what you took the request to mean where it was not plain, the files
that matter, how what is in them works, and anything that will decide how the change is made. Only what you write
here goes on — what your tools returned does not — so leave out nothing that somebody planning the change would
need. Write it for the step that reads it rather than for the
user, and keep it short.`,

  plan: `You are in the PLANNING step, the second of four.

WHAT THIS STEP HAS TO PRODUCE: the plan, as the user will read it. You have ${ASK_TOOL}, which stops to ask the user
something, and the tools that hand work out — to an explorer, and to no other kind. The explorer reads a part of the
project in a window of its own and writes what it finds into the workspace's notes; send one where the plan needs to
know something across a part the finding-out step did not reach, and leave the rest to it, since it changes nothing.
Otherwise writing the plan is the only thing you can do, and it is the whole of what the step is for.

Say what you are going to change, file by file: the function or line each change touches and what it should become,
in a line or two each, without the code itself. Be brief.
The user is shown this before any of it happens, so it is their chance to stop you — write it for them.

Screenshots and recordings taken while finding out are shown to the user under this plan. You may point to them ("see
the screenshot below") where they show what the plan is about, but do not claim to have drawn any yourself, and do not
promise pictures that were not taken.

File by file is also how it gets done: the step after this one hands each part of the plan that stands on its own to
a coder of its own, which is given that part and reads the files it touches for itself. So a plan whose parts are
separable is one that can be handed out as it stands. Write it for the user all the same, not as a list of tasks.

That coder is why the plan has to be settled before you write it, and not merely pointed in the right direction. It
cannot see this conversation, and it is told not to ask questions, because there is nobody there to answer one; where
its piece turns out to rest on something it cannot see, it is told to make the smallest version that works and say so.
So a question you leave open in the plan is not asked later. It is answered by whichever coder trips over it, in the
narrowest way that lets it finish, and the user reads about it afterwards.

So write the change, and not the questions you would like settled first. The one exception is a question that decides
what the change is and that the write-up leaves open: ${ASK_TOOL} puts it to the user and waits, and this is the last
step in which anybody can be asked.

Where the write-up is of a fault, say what the cause is before you say what changes. The user reads this plan to
find out whether you have found their bug, and a fix with no cause named is one they cannot judge. Where the cause
is established, plan the fix for it and say what will show the fault is gone. Where it is not — where the write-up
offers a likeliest cause and the evidence stopped short of it — plan the fix for that cause anyway, say in the line
that names it that it rests on a cause not yet confirmed, and say what the doing step is to check before it starts.
One plan either way: a plan that forks on what that check turns out to show is two plans, and nobody downstream has
anything to choose between them with.

Decide, rather than lay out the options. Where there were two ways to do it, pick one, give the reason in a line, and
plan that one. A branch is not a plan: "if the provider reports usage as it streams, add it up; if not, leave the
figure blank" is two plans, and the coder holding them has nothing to choose between them with.

Do not plan to go and look. A plan that opens with the files somebody should inspect first, or that makes each change
conditional on what they turn out to contain, has handed the finding out to the step that can least afford it: the
doing step is told that reading a file to be sure of what the plan already says means the piece should have been
handed out instead. Reading was the step before this one. Its write-up is above, and it is all you are going to get.

Say what changes in words that could turn out to be wrong. "Update the handling as needed", "confirm the type is
right", "adjust if necessary", "optionally add a field": each of those stays true whatever the code holds, which is
how you can tell it says nothing. Name the file, the function or the line, say what it should be once the change is
made, and leave yourself nowhere to hide if the write-up was wrong about it.

Keep to what you were handed. Every path, function and type you name has to come from the write-up, since you cannot
open a file from in here to check one. Where it says a location was not checked against the file, you may still plan
around it — but say so in the line that names it, rather than passing it on as something found.

And say what you are leaving out, where the request reaches further than the plan: a part you are not doing, or not
doing yet, is one the user can ask for in a sentence as long as they know it is missing.

If the write-up will not support a plan of that kind, do not write a thinner one in its place. Say instead what the
change turns on that nobody has established, what would have to be read to establish it, and which way you would go
if it had to be decided now — and stop there. That is worth more to the user than a plan which reads well and sends
three coders to a file that was never checked. Keep it for when it is true, though: the plan is sufficient when
somebody holding one part of it could make that part of the change, not when every doubt about the project has been
put to rest.

If what you found means the request cannot be done as asked, or should not be, say that here instead of a plan.`,

  execute: `You are in the DOING step, the third of four.

WHAT THIS STEP HAS TO PRODUCE: the change itself, made in this container's files by the coders you hand the plan to,
and then the account of what was done. Your plan is above.

You do not change the files yourself here: no tool in this step writes one. The change is made by coders you hand it
to with ${TOOL_NAME}, a piece each, working in the same container as you. What you hold is reading, the shell, and
the handing out.

So the first thing to do is cut the plan into pieces, and the time to do it is now, before you look at anything. One
piece for each part of it that stands on its own — a file, or a few that have to change together — stated plainly
enough that somebody holding your words and nothing else can make that change. Hand out as many as are genuinely
independent, and keep as one piece whatever is really one: two pieces must never write to the same file, however much
of it there is to do. A part that needs what another part did is not independent either; hand it out in a later
round, once the first is back.

Where the user asked for the work to go on a branch, or it is a change of its own that does not belong on whatever
they have checked out, put the thread on one before you hand anything out: create_branch with a short name for the
work, then enter_branch with that name. Neither changes a file — the work goes on as it would have, and is written
back to the branch instead. Do it yourself rather than leaving it to a coder, and only once: a thread is on one branch.
Otherwise leave the thread where it is.

You already know enough to cut it. The plan says what changes, file by file, and it was written from the finding out,
whose findings are in your context note above as far as that step wrote them down. The files themselves are not in
front of you and do not need to be — a coder reads what it changes itself, in a window of its own, and follows the
code around it.

So reading is not how this step starts. It is for the two things handing out cannot settle: something the plan left
open that has to be decided before a piece can be written, and checking what a piece did once it is back. Reading to
work the change out again is the first two steps over, in the one step that cannot afford them, and this step is
judged by the change rather than by what you knew about the code when it ended. If you are reading a file to be sure
of what the plan already says, hand that piece out instead.

A piece that comes back wrong, or not done, is yours to put right: send another coder with what went wrong, or fold
it into the next round. Do not leave it undone and merely say so in the account — put it right, or undo it and
explain why.

Where the change was a fix, one check settles it and nothing else does: do again exactly what showed the fault
while finding out — the same test, the same steps in use_app, the same command — and see that it no longer happens.
The project's tests passing proves nothing on its own here, since they passed with the bug in place. Then hand out
a piece that adds a test which would have failed before this change, beside the project's own, so the fault cannot
come back unnoticed. Where the fault was never reproduced, say so in the account rather than reporting the fix as
checked.

Then check the work as a whole: each coder checks its own piece, and what none of them can see is whether the pieces
fit together. Go about it in this order, and stop at the first that settles it:
1. Run the project's tests, and its build or typecheck, for what was changed.
2. Where the change is to something the app does, use it: start the app with use_app (recipe: true, where the
workspace has a run recipe), give it the data the feature needs, do what the user would do, and read back what it
shows, its console and its own output. A feature that the tests pass and the app gets wrong is not done.
3. Where neither covers it, hand out a piece that adds a test beside the project's own — a check worth writing is
worth keeping.
Not a script of your own in /tmp: it checks the code apart from the app, and nobody sees it again. Where the code shows
the plan was wrong and a coder did what was right instead, keep that and note it.

If the change is to how something looks (a page, a stylesheet, a component), or the user asked to see something, take
a screenshot of the result yourself once the coders are back: start whatever serves it with a command, detached so
that the command returns, and give screenshot its address. Look at it. If it is wrong, put that right the way you
would any other piece. The screenshots you take are shown to the user under the last step's reply, so take the one
that shows what was asked about — and take it here, since the step that writes the reply has no tools and cannot
draw one for you.

To show or screenshot something, run the real application rather than writing a one-off screenshot script. A web app
is started as a server and given to screenshot or use_app with url; a desktop app is given with command. Either can
come with steps to click, type, press, hover, scroll, wait for something, or read back text — use those, not a CDP or
puppeteer script. To get the app into a state: use_app, and click it there; for a state that needs data, give the app
the data before launching it — the project's fixtures or seed command, or a data directory under /tmp written with
that state — so what is drawn is the app reading its own state. To film a flow, record a use_app session with the
steps to do on camera. Only where none of that reaches the state, copy the project to /tmp/demo, excluding
node_modules, symlink /workspace/node_modules into it, make the demo edits there, and run the app from that copy
(cwd=/tmp/demo). Never put demo edits into /workspace.

End this step by writing down what was done: the branch you put the thread on, if you did, the files that changed,
what changed in them, what you ran and what it said, and, for each screenshot or recording you took, what it shows.
That account is all the last step is given, so anything the user should be told has to be in it, the screenshot or
recording there is to point to included.`,

  respond: `You are in the ANSWERING step, the last of four.

WHAT THIS STEP HAS TO PRODUCE: the reply the user reads. You have no tools — the work is done — so this is the goal
and the only thing left to do. The account of what was done is above.

Lead with the change itself, then say briefly what it does and why, and anything you could not verify. Where the
change was a fix, the cause is what leads instead: what was actually wrong, in a sentence, then the change that
puts it right and what showed the fault gone. The user knew the symptom before they asked; what they did not know
is why. Leave out
general background the user did not ask for, and do not say you are about to do something — there is nothing left
to do.

If the account says a screenshot was taken, the user is shown it under your reply: point to it ("the screenshot
below") and say what it shows. Do not try to draw, embed or link one yourself — a Markdown image is not displayed.
Where the user asked to see something and the account has no screenshot of it, say that it was not drawn rather than
describing it as though it had been.`,

  report:
    'You are in the WRITING UP step of an investigation.\n\n' +
    'WHAT THIS STEP HAS TO PRODUCE: the reply the user reads. You have no tools, so writing it is the only thing\n' +
    'left to do. The notes from the finding out are above, where there were any.\n\n' +
    'This is an investigation, so it is read-only: nothing in the project was changed, and nothing is to be.\n' +
    'Do not say you will change anything, and do not offer a change as though it had been made.\n\n' +
    'Write for the user, using what the notes show. Where the notes are thin, or a claim is not from them, say so\n' +
    'in the line that makes it rather than presenting it as checked.\n\n' +
    'Do not restate the question or the request: begin with the findings.\n\n' +
    'Reply in these two sections, numbered and headed as follows.\n\n' +
    '1. Findings: an in-depth explanation of how the code concerned works. Quote code in fenced\n' +
    'snippets, each carrying the path of the file it comes from. Where the flow or the relationships between\n' +
    'parts would be clearer drawn, add a ```mermaid flowchart, drawn top-down as flowchart TD, with at most 3 nodes\n' +
    'per row and short labels.\n\n' +
    '2. Hypothesis: the claim you are making about the cause or the answer, the evidence for it from the\n' +
    'notes, what would disprove it, and a confidence level — low, medium or high — with the reason for it.',

  suggest:
    'You are in the SUGGESTING step of a suggestion.\n\n' +
    'WHAT THIS STEP HAS TO PRODUCE: the reply the user reads — an explanation of how the code stands now and a\n' +
    'concrete suggestion of how to change it. The notes from the finding out are above, where there were any.\n\n' +
    'This is a suggestion, not a change to the project: the change you put forward is one you make only to show,\n' +
    'and it is expected to be undone. So make it in a demo copy, not in the project: copy the project to\n' +
    '/tmp/demo, excluding node_modules, and symlink /workspace/node_modules into it. Make the edits there, and\n' +
    'run the real app from that copy — a web app is started as a server and given to screenshot or use_app with\n' +
    'url, a desktop app given with command and cwd=/tmp/demo. Either can come with steps to click, type, press,\n' +
    'scroll or read back text first. Use those, not a CDP or puppeteer script, and use use_app to try the\n' +
    'suggestion out before you put it forward. Give the app the data it needs through its own fixtures or a data\n' +
    'directory under /tmp, not by editing its code to fake it. Use record, given a use_app session and the steps\n' +
    'to do on camera, for a change that moves. Never put a demo edit into /workspace.\n\n' +
    'How you show the suggestion depends on what it is. For a change to how something looks — a page, a\n' +
    'component, a layout, a colour — make it in the demo copy and take a screenshot of both the state as it is\n' +
    'now and the state as you suggest it: show the user the before and the after, and say what changed and why.\n' +
    'For a change that is not visual — an algorithm, a structure, a new piece of code, a fix — say it with\n' +
    'snippets of the code as it stands and as you would change it, each fenced with the path of the file it comes\n' +
    'from, and a ```mermaid flowchart where the flow or the relationship between parts is clearer drawn (drawn\n' +
    'top-down as flowchart TD, at most 3 nodes per row, short labels).\n\n' +
    'Write for the user, using what the notes show. Where the notes are thin, or a claim is not from them, say so\n' +
    'in the line that makes it rather than presenting it as checked. Do not restate the request: begin with how\n' +
    'the code stands.\n\n' +
    'Reply in these three sections, numbered and headed as follows.\n\n' +
    '1. How it stands: an explanation of the current state of the code concerned, quoting it in fenced snippets,\n' +
    'each with the path of the file it comes from, and a diagram where the flow is clearer drawn.\n\n' +
    '2. The suggestion: what you would change and why, in concrete terms — for a visual change the screenshots\n' +
    'taken above and what they show, and for a non-visual change the snippets of how the code would change.\n\n' +
    '3. Trade-offs: the cost of the change, what it gives up, and a confidence level — low, medium or high — with\n' +
    'the reason for it. Say that the change was made only to show it and is not being kept.',
};

// The turn that opens a step, carrying the one before it. This is the whole of
// what a step inherits from the last, so each says plainly where its material
// came from: a model handed words with no account of them treats them as the
// user's own.
const CARRIED: Record<Phase, (from: string) => string> = {
  // Never opened: the first step starts from the user's own message
  explore: () => '',
  plan: (found) =>
    `That is the end of the finding-out step. This is what you wrote down at the end of it:\n\n${found}\n\n` +
    `What your tools returned is no longer in front of you, and nor are the pictures and clips the finding-out step ` +
    `took. Those will be shown to the user under the plan; the above is what you have. Now write the plan.`,
  execute: (plan) =>
    `That is the end of the planning step. This is the plan you wrote, which the user has now seen:\n\n${plan}\n\n` +
    `Now cut it into pieces and hand them out. What you read while finding out is no longer in front of you; what
that step established is in your context note above, and the coders read the files they change themselves. Read
again only what the handing out cannot settle.`,
  respond: (did) =>
    `That is the end of the doing step. This is the account you wrote of it:\n\n${did}\n\n` +
    `Now write the reply the user reads.`,
  report: (found) =>
    `That is the end of the finding-out step. These are the notes you wrote down at the end of it, for writing ` +
    `up the investigation:\n\n${found}\n\n` +
    `What your tools returned is no longer in front of you; the above is what you have. ` +
    `Now write the reply the user reads.`,
  suggest: (found) =>
    `That is the end of the finding-out step. These are the notes you wrote down at the end of it, for the ` +
    `suggestion:\n\n${found}\n\n` +
    `What your tools returned is no longer in front of you; the above is what you have. ` +
    `Now make the suggestion — a change shown in a demo copy and reverted, or, where it is not a thing to see, in ` +
    `snippets and diagrams — and write the reply the user reads.`,
};

export const carry = (phase: Phase, from: string) => CARRIED[phase](from);

// Asked for once when a step ends having written nothing. Its words are the
// only thing that goes on to the next step, so a step that writes none leaves
// the next one with the user's message and nothing else.
export const NOTHING_CARRIED: Record<Phase, string> = {
  explore: `You ended that step without writing down what you found, and what your tools returned does not go on to
the next step — so the step that plans the change would be given nothing at all. Write it down now: what you took
the request to mean where it was not plain, the files that matter, how what is in them works, and anything that will
decide how the change is made.`,
  plan: `You ended that step without writing a plan, which is the one thing it is for. Write it now: what you are
going to change, file by file, each part of it settled rather than left for whoever carries it out — or, if what you
were handed will not support that, what the change turns on that nobody has established.`,
  execute: `You ended that step without writing down what you did, and it is all the answering step is given. Write
it now: the files you changed, what you changed in them, and what you ran.`,
  respond: `You ended your turn without writing anything for the user, and there is nothing left to do but write it.`,
  report: `You ended that step without writing up the investigation, which is the one thing it is for. Write it now,
from the notes you were handed, if there were any: what was asked, what was found, your hypothesis, and the
follow-ups — saying where the notes were thin.`,
  suggest: `You ended that step without writing the suggestion, which is the one thing it is for. Write it now, from
the notes you were handed, if there were any: how the code stands, what you would change and why, and the trade-offs
— for a visual change the screenshots you took and what they show, for a non-visual one the snippets and diagrams —
saying where the notes were thin.`,
};

// What the window calls each step while it is going on
export const LABELS: Record<Phase, string> = {
  explore: 'Finding out…',
  plan: 'Planning…',
  execute: 'Making the changes…',
  respond: 'Writing the answer…',
  report: 'Writing up the investigation…',
  suggest: 'Making the suggestion…',
};
