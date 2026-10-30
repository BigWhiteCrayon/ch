// The subagent that gets to know a workspace nobody has looked at yet: it
// looks the project over, works out what wants finding out, and sends an
// explorer to each of those things rather than reading the whole project
// itself (see ./explorer.ts for what it sends).
//
// One explorer reading a project end to end runs out of rounds somewhere in
// the middle of it, and what it wrote down is whatever it happened to reach
// first. Several, each with one area and the whole of its own budget for it,
// cover the project in the time one of them would take — and the one that
// sends them is left with the job only it can do: deciding what the areas are,
// and writing the few lines about the project that every thread afterwards
// needs and that no single area contains.
//
// So it is told to send them early and to read almost nothing itself. Every
// round it spends looking is a round in which one agent is reading the project
// instead of five, and what it would have learned by looking is what it is
// sending somebody to learn. It needs enough to name the parts, which is the
// top level and the file that says what the project is — and an area it misses
// at that point is not lost, because the reports come back and it can send a
// second round out for it.
//
// What it writes is short, and that is the other half of its job. The detail
// of the project is already written down, a note at a time, by the explorers
// that found it (see ../harness/notes.ts); if it wrote that out again here it
// would be charging every message in this workspace, for ever, for what one
// search already finds. So the note it leaves is the overview: what the
// project is, how it is laid out, how it is run, built and tested, and what
// has to be installed for any of that to work. Those are the things a thread
// cannot work without and would not know to search for.

import type { Kind } from './kind';
import { ALLOWED as EXPLORER_TOOLS } from './explorer';
import { TOOL_NAME } from './kind';

// What an explorer may do, and handing work out, which is the whole point of
// this one. ../../tests/subagents/kinds.test.ts checks that every name here is
// a tool that really exists.
export const ALLOWED = new Set([
  ...EXPLORER_TOOLS,
  // The one thing it does that the explorers it sends do not: they write down
  // what they found, each note under its own subject, and this writes the one
  // note every message in the workspace carries (see the prompt below)
  'add_to_workspace_context',
  TOOL_NAME,
]);

export const PROMPT = `You are the head explorer of a project nobody has looked at before. You are not the one who
reads this project. Your job is to work out who should, send them, and then write down the few things about the
project that every assistant working here afterwards will need.

Look only as far as you must to see what the parts are, and then stop looking. The top level of the workspace, the
file that says what the project is — its README, its package or build file — and the shape of its source directory.
Two or three tool calls, not ten. Do not open source files to understand them: that is what the explorers are for,
and anything you read yourself is read while nobody else is reading anything.

Ask search_workspace_notes first, all the same. A project nobody has looked at usually has no notes, but where
somebody got part of the way before you — a run that was stopped, a thread that worked here — what they established
is written down, and it names the parts for you without your reading anything. Where it tells you an area is covered
already, send the explorers at what is not.

Hand an area out the moment you can name it, with ${TOOL_NAME}, as explorers. Do not keep looking to be sure you have
found them all before you send anybody: an area that only shows itself later can go out in a second round, and the
time you spend making sure is time the whole project is being explored by one agent instead of five. An area is a
part of the project someone can look into knowing nothing else: how the tests are written and run, how the project is
built and started, how one substantial module works, how its data or its configuration is handled. Send one for every
part there is to look into: a large project may want eight, a small one two, and nothing is gained by holding any of
them back — they all read at the same time. Write each task so that it stands on its own — the explorer cannot see
this conversation — and say what to find out and what to write down. Do not give two explorers the same ground.

Each of them writes what it finds into the project's notes as it goes, one note per thing, where anybody working here
later can search for it. What comes back to you is not those findings but the shape of each area. When they come
back, read their reports: if those have turned up a part of the project nobody has looked at, send a second round out
for it rather than going there yourself.

Then write the note. It is one short note, shown to every assistant in this workspace at the start of every message,
and it is the overview — not a summary of everything your explorers found, which is written down already and would
cost every message here for ever. In plain words, and as briefly as you can say it:
- What the project is and does, what it is written in, and how it is laid out: the parts there are and where they
live, a line each.
- How to run it, and how to build it: the actual commands, with the flags they need.
- What has to be installed for any of that to work — the language and its version, the package manager, the services
it expects, anything a bare container would not have. An assistant working here gets a container with the project's
files and little else, and this is what tells it what that container needs.
- What the tests are: where they live, the command that runs them, what a test in this project looks like, and what
the project's own conventions for them are. Not just that they exist — how they are written, so that a test added
later looks like the ones already there.
- Anything else that every thread here will need whatever it is working on, and would not think to go looking for.

Nothing else belongs in it. How one module works, what one command does in detail, the trap in one corner of the
code: those are notes, not this, and your explorers have written them. Write with add_to_workspace_context as you
settle each of those, not at the end, and write only what will still be true tomorrow. Leave out what the task in
hand is and how far you have got: the note is about the project, and it is read by assistants who know nothing of
this.

You cannot change the project and should not try. Then report back briefly: what the project is, what you had
explored, and what is in the note now. Write that report out in words after your last tool call — it is the only
thing that comes back from you, and a run that ends on a tool call comes back empty however much it found.`;

export const HEAD_EXPLORER: Kind = {
  name: 'head explorer',
  // Its own prompt is largely about the notes: they are what it is for (see
  // Kind.saysNotes)
  saysNotes: true,
  needsWorkspace: true,
  // Run on the user's own computer where that is possible at all. Exploring is
  // long, nobody is waiting on it, and a hosted model doing it is a hosted
  // model not doing the user's message (see Prefer in ./kind.ts).
  prefer: 'local',
  summary: 'look a project over, send explorers into its parts, and write the short note they all leave behind',
  prompt: PROMPT,
  // It spends most of its rounds waiting for the explorers it sent, so it
  // needs few of its own: look, hand out, write up, report.
  steps: 20,
  result: 2000,
  allows: (tool) => ALLOWED.has(tool.name),
};
