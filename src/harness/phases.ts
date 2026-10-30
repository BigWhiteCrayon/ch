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
// The name of the handout tool alone, from the module that only declares it:
// the finding-out step may send explorers, and a prompt that names the tool
// has to name it as the model sees it (see tools/subagents.ts). Taken from
// ../subagents/kind rather than ../subagents so that this stays a leaf.
import { ASK_TOOL, TOOL_NAME } from '../subagents/kind';

// In order. A reply starts at the first and ends by finishing the last.
export const ORDER: Phase[] = ['explore', 'plan', 'execute', 'respond'];

// The steps of an investigation, which reads and writes up and changes nothing:
// find out, then say what was found.
export const INVESTIGATION: Phase[] = ['explore', 'report'];

// An investigation with no workspace to read: there is nothing to find out, so
// it is only written up.
export const WRITE_UP: Phase[] = ['report'];

export const last = (phase: Phase, order: Phase[] = ORDER) => phase === order[order.length - 1];
export const next = (phase: Phase, order: Phase[] = ORDER): Phase | undefined => order[order.indexOf(phase) + 1];

// Whether a step has tools at all. The two that do not are the two whose
// whole job is to write something: given a tool, a model reaches for it.
export const hasTools = (phase: Phase) => phase === 'explore' || phase === 'execute';

// Whether what a step writes is read by the user. The plan is put in front of
// them before any of the work happens, and the answer is the reply itself;
// what the other two write is a handover to the step after them, and a step
// told to write what the user will read while it is writing for itself has
// been given two jobs and will not finish either.
export const readByUser = (phase: Phase) => phase === 'plan' || phase === 'respond' || phase === 'report';

// Whether a tool is offered in a step. A tool that says nothing is offered
// wherever there are tools, which is what a tool that only reads wants (see
// Tool.phases).
//
// The planning step is the exception to having none: it may stop to ask the
// user something, since the plan is where a reading of the request is settled
// and a question is better put before it than after it. That is all it is
// offered, and the step's instructions are built as for a step with no tools
// (see systemFor in index.ts).
export const offers = (tool: Tool, phase: Phase) =>
  phase === 'plan' ? tool.name === ASK_TOOL : hasTools(phase) && (tool.phases?.includes(phase) ?? true);

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
export const spent = (why: 'rounds' | 'window' = 'rounds') =>
  `${
    why === 'window'
      ? 'There is no more room in this window for finding out, so the step ends here rather than when your rounds ' +
        'would have'
      : 'Your rounds for finding out are spent'
  }. The tools are still listed above, and are no longer yours to call: a call made now is not
run, and the round it would have taken does not exist. What you have is what you have, so write it
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

To see how something looks or behaves, run the real application rather than writing a one-off screenshot script. For
a change that is only for the demo, copy the project to /tmp/demo, excluding node_modules, and symlink
/workspace/node_modules into it. Make the demo edits there, and run the real app from that copy: a web app is started
as a server and given to screenshot with url, a desktop app given to screenshot with command. Either can come with an
optional steps list to click, type, eval or wait in it first: each step is {action, selector, text, expression, ms}.
Use that, not a CDP or puppeteer script. Use record
for behaviour over time, by url or by command with cwd=/tmp/demo. The screenshots and recordings you take here are
shown to the user under the plan, so take them only where they help it: the current state of something, or a bug as
it happens.

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

Search the workspace's notes with search_workspace_notes before you search the code, and again whenever a fresh
part of the project comes into the work: what you are about to spend rounds working out, somebody working here may
have worked out and written down already.

Then search the code and read the files the search points to, the tests among them: a test is the shortest statement
of what the code it covers is supposed to do, and reading one is often quicker than reading what it covers. Where
the question is about the history rather than the code as it stands — when something changed, who changed it, what a
commit did — run_reading_command answers it in one call.

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

End this step by writing down what you found: what you took the request to mean where it was not plain, the files
that matter, how what is in them works, and anything that will decide how the change is made. Only what you write
here goes on — what your tools returned does not — so leave out nothing that somebody planning the change would
need. Write it for the step that reads it rather than for the
user, and keep it short.`,

  plan: `You are in the PLANNING step, the second of four.

WHAT THIS STEP HAS TO PRODUCE: the plan, as the user will read it. You have no tools here but ${ASK_TOOL}, so writing
it is the only thing you can do, and it is the whole of what the step is for.

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

Then check the work as a whole. Run the project's tests, or its build, for what was changed: each coder checks its
own piece, and what none of them can see is whether the pieces fit together. Where the code shows the plan was wrong
and a coder did what was right instead, keep that and note it.

If the change is to how something looks (a page, a stylesheet, a component), or the user asked to see something, take
a screenshot of the result yourself once the coders are back: start whatever serves it with a command, detached so
that the command returns, and give screenshot its address. Look at it. If it is wrong, put that right the way you
would any other piece. The screenshots you take are shown to the user under the last step's reply, so take the one
that shows what was asked about — and take it here, since the step that writes the reply has no tools and cannot
draw one for you.

To show or screenshot something, run the real application rather than writing a one-off screenshot script. For a
change that is only for the demo (seeded data, forced states), copy the project to /tmp/demo, excluding node_modules,
and symlink /workspace/node_modules into it. Make the demo edits there with sed -i or write_file, and run the real app
from that copy: a web app is started as a server and given to screenshot with url; a desktop app is given to
screenshot with command and cwd=/tmp/demo. The same running copy can be filmed with the record tool, by url or by
command (with cwd=/tmp/demo). Either kind of screenshot can come with an optional steps list to click, type, eval or
wait in it first: each step is {action, selector, text, expression, ms}. Use that, not a CDP or puppeteer script, to
click, type or set state before the shot. What steps cannot do is make up the data the app shows: for a state that
needs data, write the file or data directory the app loads at start-up before launching it, so what is drawn is the
app reading its own state. Never put demo edits into /workspace.

End this step by writing down what was done: the files that changed, what changed in them, what you ran and what it
said, and, for each screenshot or recording you took, what it shows. That account is all the last step is given, so
anything the user should be told has to be in it, the screenshot or recording there is to point to included.`,

  respond: `You are in the ANSWERING step, the last of four.

WHAT THIS STEP HAS TO PRODUCE: the reply the user reads. You have no tools — the work is done — so this is the goal
and the only thing left to do. The account of what was done is above.

Lead with the change itself, then say briefly what it does and why, and anything you could not verify. Leave out
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
};

// What the window calls each step while it is going on
export const LABELS: Record<Phase, string> = {
  explore: 'Finding out…',
  plan: 'Planning…',
  execute: 'Making the changes…',
  respond: 'Writing the answer…',
  report: 'Writing up the investigation…',
};
