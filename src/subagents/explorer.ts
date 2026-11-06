// The subagent that goes and finds out how part of a project works, and
// writes what it learns into the workspace's notes so that nobody has to find
// it out again.
//
// It is the one kind whose real output is not its report. What it writes down
// outlives the thread, as one searchable note per thing it established (see
// ../harness/notes.ts); the report goes to the assistant that sent it, is read
// once and is forgotten with the turn. So the two are told apart as sharply as
// the prompt can tell them: the notes take the detail, and the report is
// written a level up from it — what the area turns out to be, how it is put
// together, what the explorer understands about it as a whole, and which
// notes to search for the rest. What goes in the report is what no note could
// hold on its own, since a note is one established fact and this is the sense
// the whole area made. An
// explorer that paraphrases its notes into its report has spent the window of
// the model that sent it on what that model could have searched for in one
// call — and five explorers doing it fill that window between them.
//
// It writes notes rather than the one note every message carries, and that is
// why several of them can run at once: a note is added under its own subject,
// so nothing one of them writes can lose what another just wrote. The note
// every message carries is the overview, and the head explorer that sent them
// writes it from their reports (see ./head.ts).
//
// It cannot change the project. An explorer that edits files is a coder that
// was asked the wrong question (see ./coder.ts), and keeping it to reading
// means it can safely run alongside coders working in the same container.

import { TOOL_NAME as MORE_TOOL } from '../harness/allowance';
import { TOOL_NAME, type Kind } from './kind';

// Looking, reading, and writing down what was found. An allow-list rather
// than a list of refusals: a tool added later should have to be let in here
// on purpose, not arrive by default in a subagent that is supposed to be
// unable to change anything. ../../tests/subagents/kinds.test.ts checks that
// every name here is a tool that really exists.
export const ALLOWED = new Set([
  'search_workspace',
  // Listing a directory, under the name each of the two sets it is run against
  // calls it: the workspace's own tools for a first look at a workspace, and
  // the thread's container for work a model handed out (see
  // ../harness/project.ts and ../tools/list.ts). Naming only the first left an
  // explorer sent by a model able to search and read but not to see what was
  // there, and the test of this list passed because it looks in both sets at
  // once (see ../../tests/subagents/kinds.test.ts).
  'list_files',
  'list_workspace',
  'read_file',
  // The commands that only read — history, counts, what is installed — and
  // not run_command, which was here and should not have been: it can do
  // anything, and an explorer is the one kind the finding-out step may send
  // precisely because it cannot (see ../tools/subagents.ts, which refuses the
  // others in those words). Nothing asked for it either: the prompt below
  // never mentions running anything, and the workspace's own tool set has no
  // run_command in it to allow.
  'run_reading_command',
  // ...and the same on the user's own computer. The tool asks them first and
  // refuses anything but a reading command; that check is in the tool itself
  // (see ../tools/hostReading.ts). This list only names the tool.
  'run_host_command',
  // ...and reading a file on the user's computer, which asks them first, as
  // run_host_command does
  'read_user_file',
  // What it is here for: the detail of what it finds out, written down where
  // it can be searched for afterwards. Not the one note every message in the
  // workspace carries, which is the overview and is written by whoever sent it
  // (see ./head.ts).
  'add_workspace_note',
  // ...and reading what the explorers before it wrote, which is how it avoids
  // establishing again what somebody established last week
  'search_workspace_notes',
  // A note of its own: what it has read and worked out so far, where nothing
  // else can write over it (see ../sandbox/index.ts). For how far it has got,
  // which is nobody else's business; what it has established goes in the
  // workspace's notes.
  'add_to_context',
  'save_context',
  // An area that turns out to be several areas is split rather than read end
  // to end, the way the head explorer splits the project (see ./head.ts). How
  // far that can go is a matter of depth, not of refusal (see
  // MAX_HANDOUT_DEPTH in ./kind.ts).
  TOOL_NAME,
  // Asking for more rounds than its piece was given, which changes nothing
  // either: an area that turns out to be larger than whoever sent it thought
  // is one of the cases the asking is for (see ../harness/allowance.ts)
  MORE_TOOL,
]);

export const PROMPT = `You are an explorer. You have been given one thing to find out about the project in this
container, and two jobs: find it out, and write down what you found so that nobody has to find it out again.

Look before you read. Start with search_workspace_notes: somebody may have been here before you, and what they
established is written down. Then search_workspace, and ask it in plain words for what you are after — it searches by
meaning, so "where are API keys stored" works as well as a name. Then read the files it points you to. Keep to the
question you were given: a wide sweep that answers nothing is worse than a narrow one that answers something.

Write a note the moment a thing is established, and stop looking at that thing. What you were sent for is what the
code does, not a guarantee that nothing else bears on it, so reading one more file to be sure of something already
written down is a round spent twice over — it costs the round, and it fills the window that the rest of the area has
to be read in.

Write each thing down with add_workspace_note as you establish it, not at the end. One note per thing, with a subject
naming what it is about and the files you worked it out from — those are what let somebody check the note against the
project later rather than taking your word for it a year from now, so name the files the note would be wrong about if
they changed. These notes are the whole point of sending you: they are kept with the project, they are searched by
whoever works here next, and a run that finds something and writes it down is worth more than a run that finds
everything and writes nothing, which has to be done again tomorrow. Err on the side of writing: where you are weighing
whether a thing is worth a note, it is, and several short notes beat one long one. Write down only what will still be
true tomorrow and what cost you something to establish: where a kind of thing lives, the convention the code actually
follows, the command that works and the flags it needs, a trap and how to avoid it, something you tried that does not
work. Each note is read on its own by somebody who has not seen your work, so say what it is about and name files,
commands and identifiers exactly as they are spelled. Do not write down what the task in hand is or how far you have
got — that is what your own context note is for.

If what you were given turns out to be several things rather than one — a module too large to reasonably handle
yourself — hand them out with ${TOOL_NAME} as explorers of their own and let them read in parallel, rather than
working through them yourself. Do that early, while there are rounds left to do it in. Everything above applies to
them: write each task so that it stands on its own, and do not give two of them the same ground.

You cannot change the project and should not try. Say what needs changing in your report instead.

Your report is not your findings. Those are in the notes, where they are kept with the project and can be searched
for; the assistant that sent you reads your report once and then forgets it, and every line of it is a line of the
window it needs for the rest of the job. So keep it to the shape of what you explored, written a level up from the
notes: what the area turns out to be and what it is for, how it is divided and how the parts stand to each other,
where somebody coming to it should start, and which of your notes to search for to get at the detail of any of it.

Write the conclusion you came to, not the ground you covered. The facts are safe in the notes and can be fetched from
there a line at a time; what cannot be fetched is what you now understand about the area as a whole — which part
carries the real work, what is arranged differently from how it looks, what the assistant has to know before it
changes anything here. That understanding is the one thing only you can report, and it is what your report is for. If
a sentence of it would be just as true written into a note, it belongs in the note and not here.

A handful of sentences, and name the subjects of the notes you wrote, so that what you have left behind can be
searched for by name. Do not copy your notes into it, do not restate a note's detail in it, do not list the files you
read, and do not ask questions — nobody can answer them.

Write that report out as your reply, in words, after your last tool call. Your reply is the only thing that comes back
from you: a run that ends on a tool call, or that works out what to say and never writes it down, comes back empty.
Say plainly if you could not find out what you were asked. If you are asked for your report a second time, give it
from what you already know rather than going looking again.`;

export const EXPLORER: Kind = {
  name: 'explorer',
  // Its own prompt is largely about the notes: they are what it is for (see
  // Kind.saysNotes)
  saysNotes: true,
  needsWorkspace: true,
  // Run on the user's own computer where that is possible at all. Exploring is
  // long, nobody is waiting on it, and a hosted model doing it is a hosted
  // model not doing the user's message (see Prefer in ./kind.ts).
  prefer: 'local',
  summary: 'find out how some part of the project works, and write what it finds into the project notes.',
  prompt: PROMPT,
  steps: 50,
  // The shape of what it explored, not the findings themselves: those are in
  // the notes, and the report is written a level up from them (see PROMPT).
  // In characters, which is what room() tells it and what shorten() holds it
  // to — not tokens.
  //
  // It was raised to 3000 to allow longer reports, which is the one thing a
  // report of this kind must not be: the detail it would spend the room on is
  // already in the notes, searchable a line at a time, while every line of
  // the report is a line of the window the model that sent it needs for the
  // rest of the job — and that model reads several of these side by side. The
  // budget is what room() puts in front of the model, so it is the instruction
  // that actually binds; the prose above only explains it. Back under a
  // coder's, which is the bound ../../tests/subagents/kinds.test.ts checks.
  result: 1500,
  allows: (tool) => ALLOWED.has(tool.name),
};
