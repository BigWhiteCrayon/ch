// The subagent that is an agent in its own right: one whole job, done by
// something that works the way the thread itself works.
//
// Every other kind beside this file is a pair of hands for one piece of work.
// It is given a task it could not have worked out for itself, a handful of
// rounds, one small loop with no steps in it and a few thousand characters to
// report in, and all of that is right for a piece: a piece stated plainly and
// held to is done better by somebody holding only the piece. What it is wrong
// for is a job. A job has to be found out about before it can be planned, and
// planned before it can be done, and the doing turns up things that change the
// plan; a job wants the ordering, the condensing and the budget that the reply
// flow already has, and it wants to be able to hand pieces of itself out in
// turn. Handed to a worker with eight rounds, a job comes back as the first
// third of itself and a report that says so.
//
// So this kind does not run in the loop beside it. It goes through the whole of
// the reply flow — classified, routed, worked through in steps, condensed when
// its window fills, and answered (see ../harness/index.ts, and ./thread.ts for
// the running of it). What that buys is the three things a piece does not get:
//
// - No bound on its rounds. A reply gets what its effort bought; this gets
//   what the job takes, and what stops it is the work being done, the user
//   stopping it, or its own model's window (see ./thread.ts).
// - Every tool, the handing out of work included. It can split its own job
//   between coders and explorers exactly as a reply does, which is the thing
//   no other kind can do for a job that is really six jobs.
// - A conversation. The model that sent it can write to it while it works and
//   is answered in words, and it stays for as long as that model has anything
//   more to say to it (see ./mailbox.ts). An agent is something you talk to;
//   that is most of what makes it one.
//
// What it is not is a thread of its own. It works in the container the thread
// works in, on the same files, beside its siblings, and it keeps its own
// context note under its own name so that nothing it writes down can be
// written over (see contextFile in ../sandbox/index.ts). Its report goes back
// to the model that sent it and nothing it writes reaches the user directly.

import { ASK_TOOL, MESSAGE_TOOL, MOVES_THREAD, OVERWRITES_SHARED, SHOWS_THE_USER, type Kind } from './kind';
import { work } from './thread';
import type { Tool } from '../types';

// How much its report may be: the whole account of a job, which is more than
// any piece needs and still has to be read by the model that sent it alongside
// everything else it is holding. Said to it in its own prompt below, since
// what runs it does not say it (see room in ./run.ts, which is the small
// loop's way of saying the same thing).
export const RESULT = 8000;

// What it may not do, which is the short list: everything else it has.
//
// It is written out here rather than taken from forbidden() because two of
// that function's refusals are the opposite of the point of this kind — it
// hands work out, and it writes to what it handed out. What is left of that
// list is what holds for an agent as much as for a pair of hands: it cannot
// ask the user anything, because it is one of several working out of the
// user's sight and a question from it has nobody to be put to; it cannot
// replace the workspace's note or record for the user, because those are the
// business of the reply that sent it; and it cannot move the thread into a
// workspace, because where the thread lives is not its to decide.
export const allows = (tool: Tool): boolean =>
  tool.name !== ASK_TOOL &&
  !OVERWRITES_SHARED.has(tool.name) &&
  !MOVES_THREAD.has(tool.name) &&
  !SHOWS_THE_USER.has(tool.name) &&
  // The review tools answer the user's comments on the thread's changes, which
  // is a reviewer's job and nobody else's (see ./reviewer.ts)
  !tool.needsReview;

export const PROMPT = `You have been given a job of your own by another assistant, which is working on a larger
request and has handed you this part of it whole. You are not that assistant's pair of hands for one small task: you
have the job, every tool it has, no limit on how many rounds you take, and subagents of your own to hand pieces of it
to. Work it through as it needs working through — find out what you need to know, decide what to do, do it, check it
— and then report back.

Do the job you were given and nothing beyond it. You are one of several at work in this container at the same time,
on the same files, each with a different part of the same request. So read whatever you need, but write only where
your own job is: do not refactor, rename, reformat or tidy anything outside it, however much it wants doing, because
somebody else may be in that file at this moment and a change nobody asked for is a change the assistant that sent
you cannot account for. Where your job turns out to need something you were not told about, make the smallest change
that works and say so in your report.

Hand out the parts of it that are plainer than the whole, and keep the rest. A job is usually several pieces of work:
the parts that need the whole of it in view, and the parts that are plain once somebody has looked. Send the second
kind out — a corner of the project to read, the same change in each of several places, something to check — and get
on with the first kind while they run. Keep for yourself the deciding, anything where one part's result changes what
the next part should be, and the writing of your report.

You cannot ask the user anything and you must not try. Nobody is watching your work: you are one of several running
at once, out of the user's sight, and a question you ask them reaches nobody. Where something is genuinely undecided,
either settle it the way the code around it suggests and say in your report what you settled and why, or say that it
is open and what the choices were. The assistant that sent you can take it to the user; you cannot.

What you can do is answer that assistant, because it can write to you while you work. Its message arrives as a turn
of its own in the middle of your work, and what you say in that turn goes straight back to it — the one thing you can
say that reaches anybody before your report. Answer in a sentence or two, plainly, and carry straight on with what you
were doing. Where its message changes the job, the new instruction is the one to follow, and say in your report that
it changed. You still cannot start one of these: nothing you say reaches it unless it has written to you first.

Your report goes to that assistant and to nobody else, and it is all that assistant will ever know of your work.
It has to fit in ${RESULT} characters, about ${Math.round(RESULT / 6)} words, and whatever runs past that is cut off
mid-sentence and reaches nobody, so decide what is worth the room before you write. Give it what it cannot get any
other way: what you did and where, file by file, in a line or two each; what you ran to check it and what that said;
what you decided that the code could not have told it; what you could not do; and anything you found that the rest of
the request turns on. Leave out the working behind all of that, and do not paste whole files. Where you have written
things down — in your own context note, in the project's notes — your report can point at them rather than copying
them in.

Write that report out as your reply, in words, after your last tool call. Your reply is the only thing that comes
back from you: a run that ends on a tool call, or that works out what to say and never writes it down, comes back
empty however much it did, and then nothing you changed can be accounted for.`;

export const AGENT: Kind = {
  name: 'agent',
  summary:
    'a whole part of the request, done by an agent that works as you do: no round limit, every tool, subagents of ' +
    'its own, and it can be written to while it works',
  prompt: PROMPT,
  // Nothing counts its rounds. This is the written form of that: the flow it
  // runs in is given no ceiling at all (see ./thread.ts), and what ends it is
  // the job being done, the user stopping it, or the window of the model doing
  // it. Every other kind has a number here because a piece of work that has
  // not been done in eight rounds is usually a piece that was stated wrongly;
  // a job is not like that, and cutting one off part way through leaves the
  // files half changed, which is worse than letting it finish.
  steps: Infinity,
  result: RESULT,
  // The flow it runs in tells it about the workspace's notes itself (see
  // notes.prompt in ../harness/index.ts), so the subagent loop's general word
  // about them would be the same thing said twice (see Kind.saysNotes)
  saysNotes: true,
  allows,
  // Which is the whole point of it: the reply flow, not the loop in ./run.ts
  run: work,
};
