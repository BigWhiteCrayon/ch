// The tool a model hands independent pieces of work out with, to be done at
// once by subagents. What a subagent is, what each kind of them is for and
// how one runs are in ../subagents.

import {
  DEFAULT_KIND,
  KINDS,
  MESSAGE_TOOL,
  TOOL_NAME,
  WAIT_TOOL,
  mailbox,
  parse,
  report,
  run,
  waitFor,
} from '../subagents';
import type { Phase, Tool } from '../types';

// The kinds the model may ask for, as a line each, so that the choice is
// described where it is made
const choices = KINDS.map(({ name, summary }) => `- ${name}: ${summary}`).join('\n');

// The one kind of subagent that cannot change anything, and so the only kind
// a step that changes nothing may send: an explorer reads and writes notes, in
// its own window rather than in the step's (see ../subagents/explorer.ts). Both
// the finding-out step and the planning step are such a step — the plan holds no
// tool that writes a file, so a coder sent from either would make its own
// instructions untrue — and both may send explorers only.
const READS_ONLY = 'explorer';

// The steps that hold no tool that changes anything, and so may send one kind
// of subagent only: the finding-out step and the planning step (see offers in
// ../harness/phases.ts, which offers the handout tools to both). What a step that
// may send no coder is told about handing out, and what its call is refused for,
// are the same in the two.
const explorerOnly = (phase?: Phase) => phase === 'explore' || phase === 'plan';

// The description in the parts a step may or may not be told. The finding-out
// step may send one kind and no other (see run below), so it is given neither
// the kinds it cannot ask for nor the reasons for choosing between them: a
// description is resent on every round of every request, and the choice it
// would be describing is one the model would be refused if it ever made it.
const WHAT_IT_IS = `Hand pieces of a job to subagents, each working in the same container on the same files as you.
Each one starts with nothing but the task you write for it, and that is the point: a piece stated plainly and done by
someone holding only that piece is done better than the same piece done by you, holding the whole conversation
alongside it. They also run at the same time, so the pieces cost about what the longest of them costs.`;

// What choosing the agent kind means, said wherever the kinds are listed. It
// is the one kind with no bound on what it may spend — no limit on its rounds,
// and subagents of its own — so when it is the right answer and when it is not
// are worth a paragraph rather than a line in the list.
const THE_AGENT = `An agent is for a part of the request that is a job rather than a piece of work: one that has to
be found out about before it can be done, or that is really several changes with an order between them. It works the
way you do — it reads, plans, changes, checks, and hands pieces of its own out — and it costs accordingly. So it is
the wrong answer for anything a coder or a worker could finish, and the right one where handing a job to a worker
would bring back the first third of it and a report saying so. Start it without waiting (blocking: false) where you
want to be able to talk to it as it works: an agent stays for as long as you have anything more to say to it, and
${MESSAGE_TOOL} is how you say it.`;

const EVERY_KIND = `Use it when a job splits into pieces that do not depend on each other and each takes real work:
making the same kind of change in several places, or finding out about several parts of the project at once. Do not
use it for work where one piece needs the result of another, for something you can do in a single tool call, or for
pieces that would write to the same file.

Say which kind of subagent each piece wants. They are told different things and given different tools, so the kind is
most of what decides whether a piece comes back done:
${choices}

${THE_AGENT}

A piece for a coder is always rated lower than the complexity of this thread's request; a higher rating is lowered
to fit.`;

// ...and in the doing step, where it is not one way of working but the only
// one: that step holds no tool that writes a file (see ../tools/sandbox.ts), so
// a change reaches the files through a coder or not at all. What EVERY_KIND
// says about a single tool call is untrue here for the same reason.
const MAKES_THE_CHANGE = `In this step this is how the change is made: no tool here writes a file, so every change
in the plan goes to a coder, which makes it in this container's files and checks it. The other kinds are for what the
doing still needs — something looked up, something checked — and what you keep for yourself is what needs the whole
job in view.

Hand out as many pieces as are genuinely independent. Never give two pieces the same file to write: that is one
piece, however much of it there is. Never hand out a piece that needs what another piece is doing; wait for that one
and hand this out after it.

Say which kind of subagent each piece wants. They are told different things and given different tools, so the kind is
most of what decides whether a piece comes back done:
${choices}

${THE_AGENT}

A piece for a coder is always rated lower than the complexity of this thread's request; a higher rating is lowered
to fit.`;

const READERS_ONLY = `In this step every piece goes to an explorer, which reads the project and writes what it finds
into the workspace's notes, in a window of its own rather than in yours. Hand out as many at once as there are parts
of the project that do not depend on each other.`;

const HOW_TO_WRITE_ONE = `Rate each piece as well: how capable a model it needs, and how much work it is. A piece goes
to the least capable model that meets its rating, so rating the easy pieces low is what makes handing work out quick
and cheap — and a piece rated below what it really needs comes back wrong. Rate what the piece takes, not what the
whole job takes.

Each piece is a task you write for a subagent that cannot see this conversation, and it reads the files for itself.
Keep the task to a few sentences (don't over-explain): the change needed, the file it is in, any decision already made
that the code cannot show, and what to report back. Leave out code the subagent will read for itself, the reasoning
behind the plan, and the other pieces. It cannot ask you anything. Give each a short name you will recognise its
findings by.

What you can do, once a piece you did not wait for is running, is write to it with ${MESSAGE_TOOL} and be answered:
to narrow it, to tell it something you have since found out, or to ask how far along it is. So a task that was stated
imperfectly is worth a message rather than a second subagent.`;

const described = (middle: string) => [WHAT_IT_IS, middle, HOW_TO_WRITE_ONE].join('\n\n');

// What it takes, given the kinds the step asking may send. Where there is only
// one, the enum is that one and `kind` is required: the default is a worker,
// and a worker asked for from the finding-out step is refused, so leaving the
// field out there costs a round to be told so.
const schema = (kinds: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'The pieces to do at once, one entry each.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A few words naming this piece, for you to recognise its findings by.',
          },
          kind: {
            type: 'string',
            enum: kinds,
            description:
              kinds.length === 1
                ? `Which kind of subagent is to do this piece. In this step it can only be "${kinds[0]}".`
                : `Which kind of subagent is to do this piece. Defaults to ${DEFAULT_KIND.name}.`,
          },
          task: {
            type: 'string',
            description: `a short statement of the work, where to look, and what to report back.`,
          },
          complexity: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: `How capable a model this piece needs, which decides which model does it. 1: a small
model is enough — reading one file, a mechanical change, a plain lookup. 2: easy work that still needs care.
3: most explanations, and work touching a few files. 4: hard work — a change across a module, or finding a fault
from its symptoms. 5: the most capable model there is. Rate the piece, not the job it came from: a job of 5 is
usually mostly 2s and 3s, which is the point of handing them out.`,
          },
          blocking: {
            type: 'boolean',
            description: `Whether to wait for this piece before carrying on. True, the default, returns its finding
with the others. False starts it and returns at once, leaving you to get on with work that does not depend on it;
collect it later with ${WAIT_TOOL}, and write to it meanwhile with ${MESSAGE_TOOL}. Use false for a piece whose
answer you do not need yet — a search to have ready, a check on something you will come to — for anything you may
want to talk to while it works, and for an agent you mean to keep. True for a piece you cannot go on without.`,
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: `How much work the piece is, which decides how many rounds of tool calls it gets. low:
one or two calls answer it. medium: some looking and a few steps. high: many steps, or work across several files.`,
          },
        },
        required: kinds.length === 1 ? ['name', 'task', 'kind'] : ['name', 'task'],
      },
    },
  },
  required: ['tasks'],
});

const EVERY_KIND_SCHEMA = schema(KINDS.map(({ name }) => name));
const READERS_ONLY_SCHEMA = schema([READS_ONLY]);

export const tool: Tool = {
  name: TOOL_NAME,
  // In the doing step, in the finding-out step, in the planning step, and in the
  // suggest step: the four are the steps a plan or a suggestion is worked through
  // and before it. In the two that change nothing (finding out, planning) it is
  // the way out of reading a project into a window that has a plan to fit in, and
  // there only an explorer may be sent (see run below). In the suggest step the
  // change being made in a demo copy that is reverted, so it falls to EVERY_KIND,
  // the change reaching the files through whoever is handed the piece (see
  // phases.SUGGESTION). What it may hand out in the changeless steps is checked in
  // run below.
  phases: ['explore', 'plan', 'execute', 'suggest'],
  description: described(EVERY_KIND),
  describe: (phase) =>
    described(explorerOnly(phase) ? READERS_ONLY : phase === 'execute' ? MAKES_THE_CHANGE : EVERY_KIND),
  inputSchema: EVERY_KIND_SCHEMA,
  schemaFor: (phase) => (explorerOnly(phase) ? READERS_ONLY_SCHEMA : EVERY_KIND_SCHEMA),

  async run(input, context) {
    const pieces = parse(input);
    // A step that changes nothing cannot change anything it sends either: a coder
    // handed out from the finding-out or planning step would make the step's own
    // instructions untrue (see ../harness/phases.ts). Refused by naming the kind
    // it should have asked for, which is a thing the model can act on.
    if (explorerOnly(context.phase)) {
      const wrong = pieces.filter((piece) => piece.kind.name !== READS_ONLY);
      if (wrong.length > 0) {
        throw new Error(
          `This step only hands work to the "${READS_ONLY}" kind, which reads and writes notes and cannot change ` +
            `anything: ${wrong.map(({ name }) => `"${name}"`).join(', ')} asked for ` +
            `${[...new Set(wrong.map((piece) => `"${piece.kind.name}"`))].join(', ')}. Send explorers to find out ` +
            'how things work, and leave the changes to the doing step, which has every kind.'
        );
      }
    }
    return run(pieces, context);
  },
};

// Collecting what was handed out without waiting. A tool of its own rather
// than a mode of the other: waiting is not handing work out, and a model that
// has to fill in a tasks array to wait for something will fill it in with
// something.
export const waitTool: Tool = {
  name: WAIT_TOOL,
  // Wherever work can be handed out, since work handed out and not waited for
  // has to be collectable in the same step (see tool above)
  phases: ['explore', 'plan', 'execute', 'suggest'],
  description: `Wait for subagents you handed out with ${TOOL_NAME} and did not wait for, and get what they found.
Returns when they have all finished, with a report from each, the same as if you had waited for them in the first
place.

Name the ones you want. Name none and it waits for everything of yours still running. Call it when you reach work
that needs what they are finding out — or before you answer, so that nothing you started is still running when you
are done.`,
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'The names you gave them. Leave it out to wait for all of them.',
      },
    },
  },

  async run(input, context) {
    const given = (input as { names?: unknown } | null)?.names;
    const names = Array.isArray(given) ? given.filter((name): name is string => typeof name === 'string') : undefined;
    const found = await waitFor(context.threadId, names);
    if (found.length === 0) return 'Nothing of yours was still running.';
    return report(found);
  },
};

// Writing to a subagent that is still working, and being answered by it.
//
// A tool of its own rather than something handing work out can do, for the
// same reason waiting is: the three are three different acts. This one is the
// only one of them that is a conversation — it returns what the subagent says
// about what was written to it, in the round that read it, rather than a
// receipt (see ../subagents/mailbox.ts).
export const messageTool: Tool = {
  // Wherever work can be handed out: a subagent that cannot be written to from
  // the step that started it cannot be written to at all (see tool above)
  phases: ['explore', 'plan', 'execute', 'suggest'],
  name: MESSAGE_TOOL,
  description: `Write to a subagent of yours that is still working, and get back what it says.

What you write arrives as a turn of its own in the middle of that subagent's work, and this returns what it writes in
the round that reads your message — a sentence or two in its own words. It then carries straight on with what it was
doing, following your message over what it was originally given wherever the two disagree.

Use it when something has changed since you handed the piece out: half of what you asked for has turned out to be
unnecessary, another piece has come back and bears on this one, you want to narrow what it is doing, or you want to
know how far along it is before deciding what to do next. One message costs you a round and costs it nothing;
handing the same piece out again costs the whole of it twice over, and throws away what the first one had done.

Only the subagents you started without waiting for (blocking: false) can be written to: one you are waiting for has
this round of yours, so there is nobody at your end to write it. An agent is the one most worth talking to — it has a
whole job rather than a piece, and it stays for as long as you have anything more to say to it, until you collect it
with ${WAIT_TOOL}. Name the subagent by the name you gave it.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name you gave the subagent when you handed the piece out.',
      },
      message: {
        type: 'string',
        description: `What to say to it, written for somebody who cannot see this conversation: say the thing itself
rather than referring back to anything here. A few sentences at most.`,
      },
    },
    required: ['name', 'message'],
  },

  async run(input, context) {
    const { name, message } = input as { name?: unknown; message?: unknown };
    const to = typeof name === 'string' ? name.trim() : '';
    const said = typeof message === 'string' ? message.trim() : '';
    if (!to) throw new Error('"name" has to be the name you gave the subagent you want to write to.');
    if (!said) throw new Error('"message" has to be what you want to say to it.');
    return mailbox.send(context.threadId, to, said, context.signal);
  },
};

// Named as the other tool files are, so that ./index reads them all alike
export const tools: Tool[] = [tool, waitTool, messageTool];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const one of tools) registry.register(one);
}
