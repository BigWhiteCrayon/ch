// Subagents: the kinds of them there are, and the loop that runs one. The
// tool a model hands work out with is defined in ../tools/subagents.ts.
//
// When the model sees several pieces of work that don't depend on each other,
// it hands them out through one tool call and they are done at once. The call
// does not return until every one of them has finished, so the model has all
// of their findings before it writes its answer.
//
// Each kind is a file of its own beside this one: what it is told, how long it
// gets, and which tools it may use. ./kind.ts says what a kind is and ./run.ts
// runs any of them.

import { SOPHISTICATION } from '../llm/sophistication';
import type { Effort, Phase, ToolContext } from '../types';
import type { Comment } from '../harness/review';
import { AGENT } from './agent';
import { CODER } from './coder';
import { EXPLORER } from './explorer';
import { TOOL_NAME, type Kind } from './kind';
import { REVIEWER } from './reviewer';
import { run, type Task } from './run';
import { WORKER } from './worker';

export { AGENT } from './agent';
export { CODER } from './coder';
export { EXPLORER } from './explorer';
export { HEAD_EXPLORER } from './head';
export { REVIEWER } from './reviewer';
export { WORKER } from './worker';
export { MAX_HANDOUT_DEPTH, MESSAGE_TOOL, TOOL_NAME, WAIT_TOOL, type Kind } from './kind';
export {
  PLAIN,
  findings,
  forgetThread,
  report,
  run,
  specsFor,
  stillRunning,
  waitFor,
  type Finding,
  type Task,
} from './run';
export { RETRY_LEVEL, byAnyName, retry } from './retry';
// The letterbox a subagent is written to through while it works. Named here
// because the two loops that deliver from it are in two places: the loop
// beside it (see ./run.ts) and the reply flow, for a subagent that is run
// through the whole of it (see ./thread.ts and ../harness/index.ts).
export * as mailbox from './mailbox';

// Every kind a model may ask for by name, in the order the tool lists them.
// A reviewer is not here: one is sent per comment when a message carries
// review comments (see reviewComments), never asked for.
// The agent is last because it is the heaviest thing on the list and the
// rarest right answer: a job, not a piece of work (see ./agent.ts).
export const KINDS: Kind[] = [CODER, EXPLORER, WORKER, AGENT];

// What a kind is called in a tool call, and what the model is told it is for
export const DEFAULT_KIND = WORKER;

// The kind of that name, or undefined if there is no such kind
export const byName = (name: string): Kind | undefined => KINDS.find((kind) => kind.name === name);

// A rating a model can be taken at its word for: a whole number from 1 to 5,
// as the classifier's own are (see ../harness/classifier.ts)
const rated = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;

// The efforts there are, in the order the schema offers them
const EFFORTS: Effort[] = ['low', 'medium', 'high'];

// Quotes the bare words a model writes where JSON wants a string, which is how
// every stringified batch in the log was broken: {"effort":medium}. Done
// outside string literals only, so a task whose own prose says "effort: medium"
// is left exactly as it was written.
function quoted(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += json[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    out += ch;
    if (ch === '"') {
      inString = true;
    } else if (ch === ':') {
      const after = json.slice(i + 1);
      const word = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(?=\s*[,}\]])/.exec(after);
      // true, false and null are JSON already; anything else in a value's
      // place was meant as a string and is read as one
      if (word && !['true', 'false', 'null'].includes(word[2])) {
        out += word[1] + JSON.stringify(word[2]);
        i += word[0].length;
      }
    }
  }
  return out;
}

// What a model handed in when it wrote the array out as a string instead of
// sending one, which is what every refused batch in the log had done: the
// tasks come whole, in a 3-7KB string, and throwing them away costs the round
// and the plan. Returns the tasks if the string can be read as them.
function parsed(given: string): unknown {
  for (const text of [given, quoted(given)]) {
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) return value;
    } catch {
      // The next repair, or the refusal below
    }
  }
  return undefined;
}

// The tasks the model asked for, if it asked for them properly
export function parse(input: Record<string, unknown>): Task[] {
  // A string where the array was asked for is read as the array it holds. When
  // it cannot be read, the refusal says that it arrived as a string, because
  // the message that did not say so left the model with nothing to change: it
  // handed out no work at all after three of the four refusals in the log.
  const given = typeof input.tasks === 'string' ? parsed(input.tasks) : input.tasks;
  if (typeof input.tasks === 'string' && given === undefined) {
    throw new Error(
      '"tasks" arrived as a string with the array written out inside it, and that string is not valid JSON, so ' +
        'the tasks in it could not be read. Send "tasks" as a real array of { name, task } objects rather than as ' +
        'a string of one.'
    );
  }
  if (!Array.isArray(given) || given.length === 0) {
    throw new Error('"tasks" must be a non-empty array of { name, task } objects.');
  }
  return given.map((task, i) => {
    const {
      name,
      task: what,
      kind: asked,
      complexity,
      effort,
      blocking,
    } = (task ?? {}) as {
      name?: unknown;
      task?: unknown;
      kind?: unknown;
      complexity?: unknown;
      effort?: unknown;
      blocking?: unknown;
    };
    if (typeof what !== 'string' || !what.trim()) {
      throw new Error(`Task ${i + 1} has no "task" to do.`);
    }
    // A kind that was not asked for is the ordinary one; a kind that was asked
    // for and does not exist is a mistake worth telling the model about,
    // rather than quietly giving it something else
    const kind = asked === undefined || asked === '' ? DEFAULT_KIND : byName(String(asked));
    if (!kind) {
      const names = KINDS.map(({ name: n }) => n).join(', ');
      throw new Error(`Task ${i + 1} asks for a "${String(asked)}" subagent; there is only: ${names}.`);
    }
    return {
      name: typeof name === 'string' && name.trim() ? name.trim() : `task ${i + 1}`,
      task: what.trim(),
      kind,
      // A rating that is not one is no rating: the piece is done by whoever
      // handed it out, which is what happened to every piece before there were
      // ratings at all. Better than refusing the whole call over a number.
      ...(rated(complexity) ? { complexity: Number(complexity) } : {}),
      ...(EFFORTS.includes(effort as Effort) ? { effort: effort as Effort } : {}),
      // Only a plain false means "do not wait for it": anything else, said or
      // not, is the ordinary case of waiting
      ...(blocking === false ? { blocking: false } : {}),
    };
  });
}

// One reviewer per comment the user left (see ./reviewer.ts). What each
// reviewer says to the user goes under their comment through
// reply_to_comment; what comes back here is for the summary.
export function reviewComments(comments: Comment[], context: ToolContext): Promise<string> {
  return run(
    comments.map(({ id, body }) => ({
      name: id,
      task: `This is the comment you are to deal with:\n\n${body}`,
      kind: REVIEWER,
    })),
    context
  );
}

// What a model is told about breaking a big job up. A job of any size is
// usually several pieces of work, and the model answering is being used for
// every one of them: the parts that need the whole picture, and the parts that
// are plain once someone has looked. Saying so turns the second kind into work
// that can be done at once, by subagents, while the model gets on with the
// first kind.
//
// Said only to a model capable enough to be worth asking: a model that cannot
// see the shape of a problem cannot usefully break one up, and would split
// what should have stayed whole. Which of them that is depends on the model
// answering, not on how much work the request looks like: a hard question
// with a short answer wants no splitting, and a long job given to a small
// model is not made easier by being cut up.
// How to split the work, which is the one thing the handout tool's own
// description cannot say: it describes a piece, and this is about the job the
// pieces are cut from. What it used to say about writing a piece — the kinds,
// that a subagent cannot see this conversation, not handing out a single tool
// call, not giving two of them the same file — is in that description, read at
// the moment the model writes the piece rather than here, and naming the kinds
// twice is also what let this contradict the step that may send only one.
const BREAK_UP = `This request takes enough work to be worth splitting. Before you start on it, look at the whole of
it and work out which parts do not depend on each other.

A part worth handing out is one that is plainer than the whole: it can be stated in a few sentences, it has a findable
answer or a definite change to make, and whoever does it needs to know nothing about the rest of the job. Looking into
one area of the project, reading how one thing works, making the same small change in each of several places, checking
whether something is used anywhere: each of those is a piece someone can do knowing only what you tell them.

Keep for yourself the parts that need the whole picture: deciding the shape of the answer, anything where one part's
result changes what the next part should be, and the last word on what the user gets. Those are what you are for.
Hand out the rest with ${TOOL_NAME}, as many as are genuinely independent and nothing that is really one piece, and
when their findings come back use them to do the part only you can do.`;

// The least capable model that is told how to break its work up (see
// ../llm/sophistication.ts): a large local model, or a mid-tier hosted one.
export const BREAKS_UP = SOPHISTICATION.STRONG;

// Whether the model answering is told how to break its work up: only one
// capable enough to do it well, and only one with the tools to hand any of it
// out. A model whose level isn't known is left alone.
//
// Not in a step of a coding change either, whatever the model, because each of
// the two that hold tools has its own account of what it hands out and that
// account is the truer one (see ../harness/phases.ts). The finding-out step is
// not working on the request at all — it is working out how the code it touches
// works, with a budget of rounds and one kind of subagent to spend them
// through. The doing step is not choosing whether to split: it holds no tool
// that writes a file, so every change in its plan goes out as a piece, and this
// would tell it to keep for itself parts it has no way to make.
export function prompt(sophistication: number | undefined, withTools = true, phase?: Phase): string {
  if (phase === 'explore' || phase === 'execute') return '';
  return withTools && (sophistication ?? 0) >= BREAKS_UP ? BREAK_UP : '';
}
