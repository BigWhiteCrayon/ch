// The loop that runs a subagent, whatever kind it is (see ./kind.ts).
//
// A subagent works in the thread's own container, on the same files as the
// model that sent it (see ../sandbox). That is the point — it is another pair
// of hands on the same work, not a separate workspace — but it also means two
// subagents writing the same file will tread on each other, so every kind's
// prompt tells it to keep to the piece it was given.
//
// Each one gets its own small decision loop with the tools its kind allows.

import * as llm from '../llm';
import * as cachelock from '../llm/cachelock';
import { priced } from '../llm/pricing';
import * as log from '../log';
import type {
  AgentEvent,
  ChatMessage,
  Effort,
  ModelInfo,
  ProviderDoneEvent,
  Tool,
  ToolCall,
  ToolContext,
} from '../types';
import { splitToolReturn } from '../types';
import { readContext } from '../sandbox';
import { toolsPrompt } from '../tools/sandbox';
import { SUBAGENT_PROMPT as NOTES } from '../harness/notes';
import { compact, nearlyFull, size } from '../harness/compactor';
import * as discoveries from '../harness/discoveries';
import { route } from '../harness/router';
import { CODER } from './coder';
import { MAX_HANDOUT_DEPTH, TOOL_NAME, WAIT_TOOL } from './kind';
import { announcing } from '../harness/announced';
import * as mailbox from './mailbox';
import * as thoughts from '../harness/thoughts';
import * as tools from '../harness/tools';
import type { Kind } from './kind';

// How much a step of a subagent's work may answer with. Room for its
// reasoning and for a tool call that carries a whole block of code with it:
// an edit_file replacing a long function is thousands of characters of input
// before the model has said a word about why. It was 4,000 — about one such
// edit and nothing else — and a call cut off part way through is not a call:
// a local server reads what it can of it and fails on the rest, which is how
// ten rounds of finished work came back as a parse error (see the salvage in
// work).
//
// A ceiling against a runaway rather than a size for the answer. What
// actually bounds a step is the window the model was loaded with — 32,768
// tokens for a local one (see ../llm/ollama.CONTEXT_LENGTH), less whatever
// the conversation has already taken — and a step that runs into that comes
// back cut off, is condensed, and is tried again (see stopReason in work).
const STEP_TOKENS = 16000;
// What asking for a shorter report may answer with, which is not the above:
// the report has to fit in kind.result characters, a thousand tokens at the
// most generous kind (see room), so the room here is for a model that thinks
// before it writes rather than for a longer report.
const SHORTEN_TOKENS = 4000;
// How many times a report that ran long is asked to make itself fit, before
// its end is cut off instead (see shorten)
const SHORTENINGS = 3;
// ...and the least of its room a shortened report can come back filling. It
// was asked to lose nothing it means, so one that comes back a fraction of
// the length it was allowed has not been shortened, it has been thrown away.
const KEEPS = 0.25;
// What a subagent's own note is put under, where it has one from before
const KEPT = 'This is the note you kept when you last worked on something here. Nobody else can write to it.';
// Said to every kind, since every kind has one. It matters more to a subagent
// than to a thread: a subagent is one pass with a few rounds in it, and what it
// does not write down is gone the moment that pass ends.
const OWN_NOTE = `You have a context note of your own. It is yours alone: not the thread's, and not any other
subagent's, so nothing you write in it can be written over by work going on beside you, and nothing you read from it
is anybody else's. Add to it with add_to_context as you go — what you have found, where you found it, what you have
ruled out — and it comes back to you if you are ever run again. Your tool results do not: this pass is all they last,
and what you wrote down is what is left of them.`;
// What a subagent is told about the workspace's notes (see
// ../harness/notes.ts). Said only where it has the tools for them, which is a
// thread with a workspace and a kind allowed to use them: a subagent told to
// search notes it cannot search spends a round finding that out. And not to
// the kinds whose own prompt is about the notes already (see Kind.saysNotes),
// which would be told the general thing straight after the particular one.
const notesFor = (kind: Kind, specs: ToolSpecs): string[] => {
  if (kind.saysNotes) return [];
  const has = (name: string) => specs.some((spec) => spec.name === name);
  return has('search_workspace_notes') && has('add_workspace_note') ? [NOTES] : [];
};

// How long its report may be. Said to it because the limit is enforced by
// cutting (see kind.result in work): a report written over it does not come
// back shortened, it comes back stopping mid-sentence, and the model has no
// way of knowing that happened. The number is the kind's own, so a kind given
// more room says so rather than every kind being told the smallest figure.
const room = (kind: Kind): string =>
  `Your report has to fit in ${kind.result} characters, which is about ${Math.round(kind.result / 6)} words.
Whatever runs past that is cut off mid-sentence and reaches nobody, so decide what is worth the room before you write
rather than running long and hoping. If you have more than fits, report the findings and leave out the working behind
them; what you have written to your note keeps, and your report is not the only copy.`;

// ...and how many rounds of tool calls it has to work in. Said for the same
// reason the report length is: the limit is enforced rather than negotiated —
// on the last round it is asked to report from what it has, and a call it
// makes then is not run (see asking in work) — and a subagent that learns the
// number by being cut off has already spent what knowing it would have saved. The figure
// is the piece's own rather than its kind's, a piece of low effort getting half
// of them and one of high effort twice (see stepsFor).
const rounds = (steps: number): string =>
  `You have ${steps} rounds of tool calls to work in. That is a ceiling, not a target: on the last of them you are
asked to report from what you already know, and a tool you call then is not run, so a round spent making sure of
something you already believe is a round you do not get back. Decide on the strength of what you have and move.
Reading on costs you twice over, besides: everything a tool returns stays in front of you for the rest of this
pass, so a window filled with files you did not need is boiled down to whatever you had written in your note by
then.`;

// Asking a subagent to make its own report fit, when it wrote more than its
// kind has room for. It is given its own words and the limit and nothing
// else: not the task, not the tool results behind the report, not its kind's
// prompt. The finding out is over by this point — what is left is saying the
// same thing in less room — and anything else left in the window is something
// to be drawn back into answering instead of shortening.
const shortenPrompt = (limit: number, length: number): string =>
  `The report below is one you wrote, and it is too long: it is ${length} characters and has to fit in ${limit}, so
${length - limit} characters have to go. Write it again short enough to fit, losing nothing it means. Keep every
finding, and keep the paths, names, commands and numbers exactly as they are spelled — those are what it is worth
reading for. Take the room out of the words around them instead: say a thing once rather than twice, drop the
lead-in and the summing-up at the end, and leave out what the reader could work out from what is left. Do not add
anything, do not say that you shortened it, and do not write anything but the report itself. Write it as plain
prose, with no Markdown of any kind, whatever the one below does.`;

// Said to every kind, because every kind's report is read by a model and by
// nothing else. Markdown costs room twice over — the markers going out, and
// the room they take in the window of whoever has to read several reports at
// once — and buys nothing, since a subagent's report is never rendered for
// anyone.
export const PLAIN = `Write your report as plain prose. No Markdown: no headings, no bold or italics, no bullet or
numbered lists, no tables and no code fences. It goes to another model, which reads it as it stands and renders none
of it, so the markers cost room and buy nothing. Write paths, commands and identifiers plainly, with no backticks
around them, spelled exactly as they are. Use ordinary paragraphs, and a line of its own for each thing where you
would otherwise have reached for a list. This is about your report. What you write through a tool — a reply to the
user, a line in a note — is that tool's business and not covered here.`;

// What every kind is told about being written to, because every kind can be:
// the letterbox is kept by the loop and not by the kind (see ./mailbox.ts).
//
// Said to all of them in the same words for the same reason the report length
// is: the thing it describes is enforced rather than negotiated. A letter will
// arrive in the middle of a round whether or not the subagent was expecting
// one, and what it writes in that round goes back to whoever wrote to it
// whether or not it meant it as an answer. A subagent that does not know this
// reads the letter as a new task — which is what one of them did with "how are
// you getting on?", reporting its progress as its final report and stopping
// with the work half done.
const MESSAGES = `The assistant that sent you can write to you while you work. Its message arrives as a turn of its
own in the middle of what you are doing, marked as being from it, and whatever you write in the round that reads it
goes straight back to it. That is the one thing you can say that reaches anybody before your report.

So answer it in that same round, in a sentence or two, and make the tool call you were going to make in the same
turn: the answer is not a round of its own, and a turn that holds only an answer spends one and moves the work
nowhere. It may narrow what you were given, tell you something it has just found out, or ask how far along you are.
None of that is a new task. Where what it says does change the work, that is the instruction to follow from then on,
and say in your report that it changed.

You cannot start one of these yourself. Nothing you ask reaches it unless it has written to you first, which is why
your report has to carry everything you have to say.`;

// How often a subagent is asked how far along it is: every third round of
// tool calls. Often enough that the window is not showing a figure from ten
// minutes ago, rare enough that the asking is a line at the end of a turn it
// was going to be sent anyway rather than a thing it spends its rounds on.
const PROGRESS_EVERY = 3;
// Asking for it. Said as a share of what is left rather than of what is done,
// because that is the thing a model part-way through a job can actually
// judge: it knows what it still has to look at.
const PROGRESS = `Begin your next message with a line of its own reading "Remaining: NN%", where NN is your estimate
of how much of what you were given is still to do — 100 if you have not started, 0 if you are about to report. Judge
it by the work left, not by the rounds left. Write that line and nothing else about it: no explanation, no apology
for the estimate, and nothing if you are already writing your report.

The line is not an answer and does not end your turn. Write it and carry straight on in the same turn, making
whatever tool call you were going to make. A turn holding the line, a sentence about what you are about to do, and
no call spends a round and moves nothing.`;
// ...and taking it back out. It is a status for the window, not something the
// model said, so it never reaches the report or the thread's view of the work.
// Taken out of every step and not only the ones that asked: the asking is a
// turn and stays in the conversation (see tell in work), so a model may go on
// answering it unasked, which is a fresher figure for the ring and costs the
// line it is written on.
const REMAINING = /^[ \t]*\**\s*remaining:\s*(\d{1,3})\s*%?\**[ \t]*\r?\n?/im;
function takeProgress(text: string): { text: string; percent?: number } {
  const found = REMAINING.exec(text);
  if (!found) return { text };
  const remaining = Math.min(100, Number(found[1]));
  return { text: text.replace(REMAINING, ''), percent: 100 - remaining };
}

// What a subagent is told when it said what it was going to do and then
// stopped with rounds still in hand. It names the two things it can do from
// there — the call, or the report — and does not tell it that it went wrong: a
// model told only that tends to apologise and stop again (see ANNOUNCED in
// ../harness/index.ts, which says the same thing to a reply).
const CARRY_ON =
  'You have not reported yet and you have rounds left. What you just wrote said what you were going to do rather ' +
  'than doing it: that turn made no tool call, so nothing happened and nothing you wrote in it has reached anyone. ' +
  'Carry on from where you are, and make the call itself — a tool is called by calling it, not by writing it out in ' +
  'your message. If the work really is finished, write your report instead and say what you did.';
// How many times that is said to one subagent. Each asking costs it a round of
// its own budget, so this is a ceiling against a model that only ever narrates
// rather than room for the work.
const MAX_CARRY_ONS = 2;

const TIMEOUT_MS = 5 * 60 * 1000;
// Asked for its report: once it is out of rounds, and again if it ever stops
// without writing one (see the nudge in work). Its tools stay in front of it
// and are said to be no use rather than taken away, which is a thing a local
// model does not believe either way (see tools in work).
const REPORT_NOW =
  'Your rounds are spent. Your tools are still listed, but nothing you call now will be run and nothing will come ' +
  'back from it, so a call is a round spent on nothing. Report what you have found now, from what you already ' +
  'know. Where you were part way through working something out, say what you believe and say that you did not ' +
  'confirm it: a report that marks what is unsettled is worth more to whoever sent you than one that leaves it out.';
// What is said to a model still waiting on an answer when the subagent it
// wrote to ended in a way the loop running it could not report (see the net
// around the runners in findings)
const UNFINISHED = 'The subagent stopped before it could answer: its work ended in a failure.';
// What a subagent that came back with nothing is said to have done
const CUT_OFF = 'The subagent was cut off before it could report: whoever sent it ran out of time.';
const NOTHING_REPORTED = 'The subagent finished without reporting anything.';
const NOTHING_WRITTEN =
  'You stopped without reporting anything. Write your report now, as your reply, in words. Your reply is the only ' +
  'thing that comes back from you: anything you worked out without writing it down reaches nobody.';
// ...and what one is told when the answer it was part way through went wrong
// at the provider rather than at the model (see the salvage in work). Said
// differently from the nudge above because it is a different thing: it did not
// stop, it was cut off, and what it needs asking for is the report and not the
// work over again.
const AFTER_FAILURE =
  'Something went wrong with your last answer and none of it reached us. Nothing you did before it is lost: the ' +
  'files you changed are as you left them. Write your report now, as your reply, in words, from what you already ' +
  'know, and do not do the work again.';
// How many times a subagent that stops without a report is asked for one. Once:
// a model with nothing to say the second time has nothing to say.
const MAX_NUDGES = 1;
// How many of its calls stand in for a report it never wrote (see account).
// The newest of them: a run that was cut off short of reporting is read for
// where it had got to, not for where it started.
const ACCOUNT_CALLS = 10;
// ...and how much of what one of them was called on is worth keeping. A path
// is short; a command can be a screenful.
const ACCOUNT_CHARS = 60;
// What that account is headed with, so that what follows reads as the record
// of the work rather than as the subagent's own account of it
const WHAT_IT_DID = 'The subagent did not write a report. What it did, from the record of its work:';

// What a subagent did, read back off its own conversation, for one that never
// wrote a report.
//
// A subagent whose last answer fails, or which answers the call for its report
// with another tool call, has usually done the work and lost only the writing
// up of it: the files it changed are in the container either way (see
// ../sandbox). Reporting that as "finished without reporting anything" sent
// whoever handed the work out looking for a subagent that had done nothing,
// when the files under it had already changed. Empty where it really did
// nothing, which is the one case that sentence was right about.
export function account(messages: ChatMessage[]): string {
  // What each call was, by its id, so that a result can be named by the call
  // it answers rather than by the tool alone
  const named = new Map<string, string>();
  const ran: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const input = call.input ?? {};
        const on = ['path', 'command', 'query', 'pattern']
          .map((key) => input[key])
          .find((value) => typeof value === 'string' && value.trim().length > 0);
        named.set(call.id, on ? `${call.name} on ${String(on).trim().slice(0, ACCOUNT_CHARS)}` : call.name);
      }
    } else if (message.role === 'tool') {
      ran.push(`${named.get(message.toolCallId) ?? message.name}${message.isError ? ' (failed)' : ''}`);
    }
  }
  if (ran.length === 0) return '';
  const kept = ran.slice(-ACCOUNT_CALLS);
  const earlier = ran.length > kept.length ? `${ran.length - kept.length} calls before these, then ` : '';
  return `${WHAT_IT_DID} ${earlier}${kept.join('; ')}.`;
}

// One piece of work, and the kind of subagent that is to do it
export interface Task {
  name: string;
  task: string;
  kind: Kind;
  // How capable a model this piece needs, 1 to 5, rated as a message is rated
  // (see ../harness/classifier.ts) but by the model handing it out, which has
  // just read the whole job and knows which parts of it are hard. It picks the
  // model this piece runs on, exactly as a message's rating picks the model
  // that answers it. Left out, the piece is done by whichever model handed it
  // out, which is what used to happen to all of them.
  complexity?: number;
  // How much work it is, which sets how many rounds it gets (see stepsFor)
  effort?: Effort;
  // Whether the model that handed it out waits for it. Left out, it does: a
  // piece whose answer is wanted now is the ordinary case. Set false for work
  // whose answer is wanted later — it is started, the call returns without it,
  // and it is collected with waitFor when the answer is needed.
  blocking?: boolean;
  // Rounds of tool calls for this piece alone, where neither its kind's budget
  // nor its effort is right for it. The workspace's first look uses it: the
  // note it writes is read by every thread in that workspace from then on, so
  // it is worth more rounds than an explorer sent after one thing (see
  // ../harness/project.ts).
  steps?: number;
}

// What a piece of work is given to do it in. A kind's own budget is what a
// piece of middling effort gets; one that is less or more than that gets less
// or more, but never less than the kind can be done in at all (see
// Kind.least). A number asked for by name beats all of it.
const EFFORT_STEPS: Record<Effort, number> = { low: 0.5, medium: 1, high: 2 };

export function stepsFor(task: Task): number {
  if (task.steps !== undefined) return task.steps;
  const asked = Math.round(task.kind.steps * EFFORT_STEPS[task.effort ?? 'medium']);
  return Math.max(1, task.kind.least ?? 1, asked);
}

// The model a piece of work runs on: the least capable one that meets its
// rating, as a message's rating is served (see ../harness/router.ts). A piece
// with no rating, or a rating nothing can meet, is done by whoever handed it
// out. Fast mode (see ../llm/index.ts) prefers a hosted model, over whatever
// side the kind would rather have.
export function modelFor(task: Task, models: ModelInfo[], asking: Route): Route {
  if (!task.complexity) return asking;
  const picked = route(models, { sophistication: task.complexity }, {}, llm.isFast() ? 'hosted' : task.kind.prefer);
  return picked ? { provider: picked.provider, model: picked.id } : asking;
}

// The provider and model a piece runs on, which is all a request needs of it
type Route = { provider: string; model: string };

// What a subagent came back with
export interface Finding {
  name: string;
  task: string;
  text: string;
  isError: boolean;
}

// The tools a kind of subagent may use, as the model is shown them. `offer`
// is the set to pick from: every registered tool, unless the caller has its
// own set. The first look at a workspace has one, because it reads the workspace on
// the user's computer rather than a thread's copy of it in a container (see
// ../harness/project.ts).
export function specsFor(kind: Kind, context: ToolContext, offer: Tool[] = tools.list()) {
  // At the bottom of the chain, handing out is not offered rather than offered
  // and refused: a tool a subagent can see is a tool it will try (see
  // MAX_HANDOUT_DEPTH)
  const deep = (context.depth ?? 0) >= MAX_HANDOUT_DEPTH;
  return offer
    .filter((tool) => kind.allows(tool))
    .filter((tool) => !deep || tool.name !== TOOL_NAME)
    .filter((tool) => context.workspace || !tool.needsWorkspace)
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

type ToolSpecs = ReturnType<typeof specsFor>;

// Runs one call against a set of tools the caller supplied, answering in the
// shape ../harness/tools.execute does. Those tools are not in the registry,
// so its timing and failure counts are not kept for them.
async function run1(offer: Tool[], call: ToolCall, context: ToolContext) {
  const found = offer.find((tool) => tool.name === call.name);
  try {
    if (!found) throw new Error(tools.noSuchTool(call.name, offer));
    if (call.input === null) throw new Error('The tool input was not valid JSON.');
    const { text, images } = splitToolReturn(await found.run(call.input, context));
    return {
      id: call.id,
      name: call.name,
      output: typeof text === 'string' ? text : JSON.stringify(text),
      isError: false,
      ...(images && { images }),
    };
  } catch (err) {
    return { id: call.id, name: call.name, output: (err as Error).message, isError: true };
  }
}

// One ask: the model's own words back, and the room they have to fit in.
// Empty on anything going wrong, which the caller reads as a try that bought
// nothing.
async function askShorter(
  text: string,
  kind: Kind,
  name: string,
  model: { provider: string; model: string },
  signal: AbortSignal
): Promise<string> {
  let written = '';
  try {
    const events = llm.stream(
      {
        ...model,
        system: shortenPrompt(kind.result, text.length),
        messages: [{ role: 'user', content: text }],
        maxTokens: SHORTEN_TOKENS,
        timeoutMs: TIMEOUT_MS,
        log: { purpose: 'shorten', kind: kind.name, subagent: name },
      },
      signal
    );
    for await (const event of events) if (event.type === 'text') written += event.delta;
  } catch {
    return '';
  }
  return written.trim();
}

// Makes an over-long report fit by asking the model that wrote it to say the
// same thing in less room, and asking again while it is still over. A model
// often takes a long report most of the way down and stops short of the
// limit; cutting there throws away the end of a report that one more ask
// would have made fit, and the end of a report is where it says what it
// found.
//
// Each try starts from the shortest version so far rather than from the whole
// thing again, so what one try managed is not given back to the next to do
// over. The report stands as it was if nothing comes back shorter, so this
// can only improve what the reader is shown — losing a report to the business
// of shortening it would be worse than printing it long.
export async function shorten(
  text: string,
  kind: Kind,
  name: string,
  model: { provider: string; model: string },
  signal: AbortSignal
): Promise<string> {
  let best = text;
  for (let tries = 1; tries <= SHORTENINGS && !signal.aborted; tries++) {
    const short = await askShorter(best, kind, name, model, signal);
    const where = { kind: kind.name, subagent: name, try: tries, of: SHORTENINGS, limit: kind.result };
    // Nothing came back, or nothing shorter: the next try starts where this
    // one did
    if (!short || short.length >= best.length) {
      log.warn('subagent.shorten', { ...where, ok: false, from: best.length, chars: short.length });
      continue;
    }
    // Shorter, but so much shorter that it cannot still say what it said. It
    // was asked to lose nothing, and a report that has lost nearly all of it
    // would be taken for the whole of what the subagent found — and, once
    // kept, would be what the next try worked from.
    if (short.length < kind.result * KEEPS) {
      log.warn('subagent.shorten', { ...where, ok: false, from: best.length, chars: short.length, error: 'gutted' });
      continue;
    }
    best = short;
    log.info('subagent.shorten', { ...where, ok: true, chars: best.length, over: best.length > kind.result });
    if (best.length <= kind.result) break;
  }
  return best;
}

// Runs one subagent's decision loop, saying what it is doing as it goes.
// Never throws: what went wrong comes back as the subagent's finding.
async function work(
  piece: Task,
  context: ToolContext,
  model: { provider: string; model: string },
  specs: ToolSpecs,
  models: ModelInfo[],
  offer?: Tool[]
): Promise<Finding> {
  const { name, task, kind } = piece;
  const id = crypto.randomUUID();
  const { signal, emit } = context;
  // One further down than whoever sent this one, so that what it sends in turn
  // knows where it stands (see MAX_HANDOUT_DEPTH). An explorer it sends
  // reports its own work through the same feed, so emit is passed on rather
  // than dropped.
  const depth = (context.depth ?? 0) + 1;
  // What it is doing, as it does it, in the same shape the rest of a reply's
  // work is reported in: the window shows a subagent the way it shows a thread
  const says = (event: AgentEvent) => emit?.({ type: 'subagent_update', id, event });
  const thinks = (text: string) => says({ type: 'thought', text });
  // What it is, how hard it was reckoned to be, and who is doing it: the same
  // things a thread is told about its own reply (see the 'model' event)
  emit?.({
    type: 'subagent',
    id,
    name,
    task,
    kind: kind.name,
    complexity: piece.complexity,
    effort: piece.effort,
    model: model.model,
  });

  // From here it can be written to, and what is written to it arrives in the
  // round after it was sent (see the letters in the loop below). Before the
  // first thing this function waits on, because a piece started without
  // waiting can be written to in the sender's very next round, and a letterbox
  // opened an await later is one that was not there when the letter came.
  mailbox.open(context.threadId, name);

  const messages: ChatMessage[] = [{ role: 'user', content: task }];
  // Where the app picked this piece up where it closed on it, what it had done
  // goes in front of it, so the model carries on rather than starting over. The
  // small loop has no flow to splice it in for it, so it does the one the flow
  // does for a reply (see ../harness/index.ts). Imported the same way
  // ./thread.ts does it, since the flow is what imports this one back.
  if (context.resumed) {
    const { pickedUp } = await import('../harness');
    if (context.resumed.text) messages.push({ role: 'assistant', content: context.resumed.text });
    messages.push({ role: 'user', content: pickedUp(context.resumed) });
  }
  // Its own steps share a prompt the way a thread's passes do, and its own
  // prompt is not the thread's, so the key is the subagent's (see
  // ChatRequest.cacheKey)
  const cacheKey = `${context.threadId}/${name}`;
  // What the step before this one sent, for deciding whether a local model is
  // kept for this subagent or handed to the next (see cachelock.Shape)
  let sentBefore: cachelock.Shape | undefined;
  // How many rounds this piece gets, which it is told as well as held to
  const steps = stepsFor(piece);
  const started = performance.now();
  // Its own note, where it has kept one. A subagent writes to a file of its
  // own (see ../sandbox), so what it reads back is its own work and not the
  // thread's or another subagent's.
  const note = await readContext(context.threadId, name).catch(() => '');
  // Ordered from what changes least to what changes most, because a prompt
  // cache matches on a prefix and the first byte that differs from the
  // last request's throws away every identical byte after it. What is the same
  // for every subagent of a kind comes first, so that the ones sent out
  // together share it; then what is the piece's own (its rounds are set by
  // its effort), and last the note, which is the subagent's alone.
  const prompt = [
    kind.prompt,
    room(kind),
    PLAIN,
    MESSAGES,
    // A subagent condenses its own gathering the same way a thread does
    // (see condense below), so what it never wrote down goes the same way.
    // Its reply carries double here: it is also the report it hands back.
    //
    // Not for the kinds whose findings have a home of their own (see
    // Kind.saysNotes): an explorer writes what it establishes into the
    // workspace's notes as it goes, where it outlives the thread rather than
    // merely surviving a compaction, and its report is deliberately a level
    // up from that detail (see ./explorer.ts). Telling it to put what it
    // finds in its reply would be telling it to undo exactly that.
    specs.length > 0 && !kind.saysNotes ? discoveries.prompt(model.provider) : '',
    toolsPrompt(specs.map(({ name }) => name)),
    OWN_NOTE,
    ...notesFor(kind, specs),
    rounds(steps),
    ...(note ? [KEPT, note] : []),
  ]
    .filter(Boolean)
    .join('\n\n');
  let answer = '';
  let failure = '';
  // How much the model answering can hold, for a subagent that reads enough
  // to fill it. A model that doesn't say is left to run out on its own.
  const window = models.find((m) => m.provider === model.provider && m.id === model.model)?.contextWindow;

  // Boils down what it has gathered so far, saying when that starts and when
  // it is over. 'changed' is whether anything came of it, as for a thread's
  // own condensing (see harness/index.ts).
  const condense = async () => {
    says({ type: 'condensing' });
    const compacted = await compact(messages, { provider: model.provider, model: model.model, window }, signal);
    const changed = compacted.messages !== messages;
    messages.splice(0, messages.length, ...compacted.messages);
    says({ type: 'condensed', changed });
  };

  // Says something to the subagent in a turn of its own, which is where
  // anything said part-way through its work has to go.
  //
  // It used to be added to the instructions for the one step that needed it —
  // the progress line, the call for the report — and a model's thinking is
  // signed against the instructions it was produced under: the step after the
  // one that added a line sent that thinking back under the instructions
  // without it, and Anthropic refused the request outright (400, invalid
  // signature in a thinking block, "The `system` prompt differs from the one
  // this block was created with"). Six coders were lost that way across two
  // handouts, each at the first step where the wording changed with any of its
  // own thinking behind it. A turn costs nothing of the sort: the conversation
  // only ever grows, and what signs the thinking is what was in front of it.
  //
  // Said once, however many times the step it belongs to is run: a step is
  // started again when it is condensed and tried afresh, and again for each
  // time the subagent is asked for a report it did not write.
  const tell = (text: string) => {
    const end = messages.at(-1);
    if (end?.role === 'user' && end.content === text) return;
    messages.push({ role: 'user', content: text });
  };

  // A reply cut off with nothing written is condensed and tried again, once
  let retried = false;
  // Whether this step is asking again for a report the step before left
  // unwritten, and how many times that has been done
  let nudging = false;
  let nudges = 0;
  // How many times it has been told to carry on after a round in which it
  // said what it was going to do and did none of it (see CARRY_ON)
  let carriedOn = 0;
  // Whether this step is asking for a report because the step before it went
  // wrong mid-answer, and whether that has been done already: once per
  // subagent, a provider that fails twice running being one that is failing
  // rather than one that stumbled (see the salvage below)
  let recovering = false;
  let salvaged = false;
  // Whether it has run anything at all, which is what there is left to report
  // when its own words never arrive. Kept as a flag rather than read off the
  // messages, which condensing rewrites (see condense above).
  let worked = false;
  // How many rounds it got through, for the report when it is cut off
  let through = 0;
  // Letters it has been sent and not yet answered (see ./mailbox.ts). Kept
  // across steps rather than per step, because a step can end without the
  // model having said anything at all — cut off for length, or stopped without
  // a report — and such a step is retried. A letter answered there would be
  // answered with the nothing that step produced, and the round that does
  // answer it would have nobody left to answer.
  let letters: ReturnType<typeof mailbox.take> = [];
  for (let step = 1; step <= steps; step++) {
    // Whoever sent it has given up waiting, so there is nothing to come back
    // to. Without this it works through every round it has left, each one a
    // call the provider refuses the moment it is made.
    if (signal.aborted) break;
    through = step;
    // Out of rounds: told to report what it has, with no tools to put it off
    const last = step === steps;
    // Asking for the report rather than letting it work on: because it is out
    // of rounds, because it stopped without writing one, or because the answer
    // it was part way through went wrong and what it had done would otherwise
    // go back as nothing but the error (see the salvage below)
    const asking = last || nudging || recovering;
    // ...and, now and then, how far along it thinks it is, for the ring on its
    // tab (see PROGRESS). Never while it is being asked to report: at that
    // point how much is left is not the question.
    const counting = !asking && step % PROGRESS_EVERY === 0;
    // Reading files fills a window quickly, so the older tool results are
    // boiled down to findings when it is nearly full (see ../harness/compactor.ts)
    if (window && nearlyFull(size(messages, prompt), window)) {
      await condense();
    }
    const reasoning = thoughts.reasoner();
    const calls: ToolCall[] = [];
    let done: ProviderDoneEvent | undefined;
    // What it wrote, which goes back into its own history and is also what it
    // brings back as its report
    let text = '';
    // Its reasoning for this step, kept whole rather than only in the thoughts
    // it is broken into for the window: it is the only place a report written
    // by a model that leaves its reply empty can be read from (see the
    // fallback below).
    let reasoned = '';
    // How long this step kept whoever is waiting on it waiting, reported with
    // the tokens it used (see Latency). Per step rather than per subagent: a
    // subagent is a dozen calls to a model, and how long one of them takes is
    // the thing the two have in common with a thread's own (see
    // ../harness/index.ts, where the reply loop times itself the same way).
    const callStarted = performance.now();
    let firstTokenMs: number | undefined;
    let queuedMs = 0;

    // Anything the model that sent it has written to it since the last round.
    // Each goes in as a turn of its own, before the askings below: those are
    // about this round, and the letter is what the round has to deal with.
    // Only the ones that have just arrived are put to it — the rest are in its
    // conversation already, waiting on a round that says something (see
    // letters above).
    const fresh = mailbox.take(context.threadId, name);
    letters.push(...fresh);
    for (const letter of fresh) tell(mailbox.WROTE_TO_YOU(letter.text));
    // What this step has to say beyond the work itself. After the condensing
    // above, so that a step which boiled its gathering down still says it.
    if (asking) tell(recovering ? AFTER_FAILURE : nudging ? NOTHING_WRITTEN : REPORT_NOW);
    else if (counting) tell(PROGRESS);
    // Whether this step carries on from the one before it, which is what keeps
    // a local model on this subagent rather than handing it to the next one
    // waiting. A step told how far along it is, or asked for its report, has a
    // turn of its own in front of it and the last of those is no longer the
    // last, which costs a local model its prompt (see ../llm/cachelock.ts).
    const sending = cachelock.shapeOf(prompt, specs, messages);
    const why = sentBefore && cachelock.brokeBy(sentBefore, sending);
    if (why) cachelock.broke(cacheKey, why);
    sentBefore = sending;

    const events = llm.stream(
      {
        ...model,
        system: prompt,
        messages,
        // Its tools, on every step, the one that asks for its report
        // included. They used to be taken away for that step, to leave a
        // model with nothing to do but write, and that cost more than it
        // bought. A local model calls a tool anyway — the syntax is in its
        // template, not in what we send, so an empty list only means the call
        // it writes answers nothing — while the list changing is itself one
        // of the things that throws away a local model's prompt (see
        // cachelock.brokeBy). So the report step read the whole conversation
        // again, 89 of the 202 seconds one of them spent on its last call,
        // and the call it wrote came back through Ollama's own tool-call
        // parser, which failed on it ("XML syntax error on line 10:
        // unexpected EOF") and took ten rounds of finished work with it. The
        // tools stay, the prompt says plainly that a call now will not be run
        // (see REPORT_NOW), and one made anyway is read as no report rather
        // than run (see asking above).
        tools: specs,
        maxTokens: STEP_TOKENS,
        timeoutMs: TIMEOUT_MS,
        cacheKey,
        log: { purpose: 'subagent', kind: kind.name, subagent: name, step, nudge: nudging || undefined },
      },
      signal
    );
    for await (const event of events) {
      // Waiting behind another request says nothing about the model, so it is
      // taken off what the model is timed at and kept on its own
      // Its turn at the model, which it takes with the thread's other
      // subagents rather than a round each (see ../llm/cachelock.ts). Said in
      // its own work, so that one of several that has written nothing yet
      // reads as waiting rather than as stuck.
      if (event.type === 'queued') {
        says({ type: 'queued', model: model.model });
        continue;
      }
      if (event.type === 'waited') {
        queuedMs = event.ms;
        says({ type: 'waited', ms: event.ms });
        continue;
      }
      // What this step has used so far, for its own tab and for the thread's
      // running total; taken before the timing below, as a reply's are (see
      // ../harness/index.ts)
      if (event.type === 'tokens') {
        emit?.({
          type: 'tokens',
          subagent: id,
          ...priced('subagent', model.provider, model.model, event.usage, models),
          ...(event.estimated ? { estimated: true } : {}),
        });
        continue;
      }
      if (event.type !== 'error') firstTokenMs ??= log.since(callStarted) - queuedMs;
      if (event.type === 'text') {
        // As in the reply loop: reasoning still held back is a finished
        // thought once the words begin, and belongs before them
        if (!text) for (const part of reasoning.end()) thinks(part.text);
        text += event.delta;
      } else if (event.type === 'reasoning') {
        // Its reasoning is what the user sees of its work as it goes, and is
        // kept beside that for the report it may turn out to be all of (see
        // reasoned above)
        reasoned += event.delta;
        for (const part of reasoning.reason(event.delta)) thinks(part.text);
      } else if (event.type === 'tool_call') {
        calls.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === 'done') {
        done = event;
      } else if (event.type === 'rate_limited') {
        // Shown where its work is shown, so a subagent that is waiting does
        // not look like one that has stopped
        says(event);
      } else if (event.type === 'fell_back') {
        says(event);
      } else if (event.type === 'error') {
        failure = event.message;
        break;
      }
    }
    for (const part of reasoning.end()) thinks(part.text);
    // Something went wrong mid-answer. Where it had already run something,
    // that work is not lost with the answer — the files it changed are in the
    // container, and what it found is in the conversation — so it is asked
    // once for its report, as a step that stopped without writing one is,
    // rather than the whole run coming back as whatever message the provider
    // failed with. One of them failed this way on the last of ten rounds,
    // after an edit that had already landed, and reported nothing but a parse
    // error (see tools above).
    //
    // Once, and only where there is something to report: a subagent whose
    // first call fails has nothing to salvage, and a provider that cannot be
    // reached cannot be reached for the asking either.
    if (failure && worked && !salvaged && !signal.aborted) {
      salvaged = true;
      recovering = true;
      failure = '';
      step--;
      continue;
    }
    if (failure) break;

    // The "Remaining:" line, where it wrote one, taken out before anything
    // else looks at what it said: it is a status for the window, not a part
    // of the work and not a part of the report (see PROGRESS).
    const counted = takeProgress(text);
    text = counted.text;
    if (counted.percent !== undefined) says({ type: 'progress', percent: counted.percent });
    if (done?.usage && (done.usage.input || done.usage.output)) {
      emit?.({
        type: 'usage',
        // Which subagent it was, so that its own tab can say what it has used
        subagent: id,
        ...priced('subagent', model.provider, model.model, done.usage, models),
        ...(firstTokenMs === undefined
          ? {}
          : { latency: { totalMs: log.since(callStarted) - queuedMs, ...(queuedMs ? { queuedMs } : {}) } }),
      });
    }

    // Cut off before it wrote anything: there is no report in that, so what it
    // has gathered is boiled down and the step tried again, once. Without this
    // a subagent that read too much comes back empty-handed.
    if (done?.stopReason === 'length' && !text.trim() && calls.length === 0 && !retried) {
      retried = true;
      await condense();
      step--;
      continue;
    }

    // Stopped without writing a report: there is none in that, so it is asked
    // outright for one, and the step is not counted against it. A model that
    // puts its whole answer in its reasoning ends a step this way, having
    // done the work: without being asked again, what it found would go
    // nowhere (see log.ts). The same goes for one that calls a tool when it
    // was already being asked to report, since nothing it calls then is run
    // and the call is not an answer either.
    if (!text.trim() && (calls.length === 0 || asking) && nudges < MAX_NUDGES) {
      nudges++;
      nudging = true;
      step--;
      continue;
    }
    nudging = false;
    recovering = false;

    // What it said in the round that read them goes back to whoever wrote to
    // it, whether or not it was meant as an answer: a letter is answered in a
    // round of the work or not at all. A round that said nothing and called
    // nothing is not one of those — it has been retried above — so those
    // letters stay waiting for a round that says something.
    const wasWritten = letters.length > 0 && Boolean(text.trim() || reasoned.trim() || calls.length > 0);
    if (wasWritten) {
      const back = mailbox.answered(text || reasoned, calls);
      for (const letter of letters) letter.answer(back);
      letters = [];
    }

    // A round that answered a letter and called nothing is a round of its own
    // kind. It is not a report — reading it as one stops the work in the
    // middle and hands the sentence it wrote for whoever asked back as the
    // whole of its work (see mailbox.ANSWERED) — and it is not an announcement
    // either, because what it wrote did reach somebody. So it is told what
    // happened and the work goes on. Not where its rounds are spent or its
    // report has been asked for: there its words are the report, letter or no
    // letter.
    if (!asking && wasWritten && calls.length === 0 && carriedOn < MAX_CARRY_ONS) {
      carriedOn++;
      log.info('subagent.answered', { kind: kind.name, subagent: name, step, chars: text.trim().length });
      const said = text.trim() || reasoned.trim();
      if (said) messages.push({ role: 'assistant', content: said, raw: done?.raw });
      tell(mailbox.ANSWERED);
      continue;
    }

    // Said what it was going to do and then stopped, with rounds still in
    // hand. That is not a report, whatever it reads like, and reading it as
    // one is how six of the twenty-four coders in two days of the log came
    // back as findings that looked clean and described work that had not been
    // done: "Nothing is edited yet", "I have not edited anything yet", "the
    // edit is still to do", each handed to the thread as a subagent that had
    // finished, each one sent out again under another name. Every one of them
    // ended on a step that had asked how far along it was — steps 3 and 6 of
    // 10, PROGRESS_EVERY apart — because a step told to write a line writes
    // the line and ends its turn, and a turn with no call in it is what the
    // loop below takes for the end of the work.
    //
    // Told from a real report by the model's own words, two ways. Its
    // "Remaining:" line, where it wrote one, is its own account of having work
    // left. And a sentence about what it is about to look at is an intention
    // rather than a finding (see ../harness/announced.ts).
    //
    // The round is spent rather than handed back: the model was called for it,
    // and a step retried on its own number is a step that can be retried for
    // ever. What bounds the asking is MAX_CARRY_ONS.
    const unfinished = counted.percent !== undefined && counted.percent < 100;
    if (!asking && !wasWritten && calls.length === 0 && (unfinished || announcing(text)) && carriedOn < MAX_CARRY_ONS) {
      carriedOn++;
      log.info('subagent.announced', {
        kind: kind.name,
        subagent: name,
        step,
        ...(counted.percent === undefined ? {} : { remaining: 100 - counted.percent }),
        chars: text.trim().length,
      });
      // Its own words go back in with it, where it wrote any: without them the
      // turn it is being asked about is not in front of it. Nothing goes in
      // for a turn that held only the progress line, which is an empty
      // assistant turn and a thing some providers refuse (see tell above).
      const said = text.trim() || reasoned.trim();
      if (said) messages.push({ role: 'assistant', content: said, raw: done?.raw });
      tell(CARRY_ON);
      continue;
    }

    // Nothing more to call: what it wrote is what it brings back. A call
    // written on a step that asked for the report is not one of those — it is
    // not run — and what it wrote beside it, if anything, is the report.
    if (calls.length === 0 || asking) {
      answer = text.trim();
      // Nothing written for us, but it reasoned: some local models put the
      // whole report in their reasoning and leave the reply empty, and being
      // asked again does not move them. qwen3.5:9b wrote nothing else on any
      // of the 88 turns it took with tools in front of it, so its nudge went
      // on another tool call and three coders came back as failures over work
      // that had landed: five edits in one of them, a rewritten test file in
      // another. So the reasoning stands in for the report, as it does for a
      // reply that answered only in its thoughts (see NO_ANSWER in
      // ../harness/index.ts). Its progress line goes with it: that is a
      // status for the window wherever the model wrote it (see PROGRESS).
      if (!answer && reasoned.trim()) {
        const reported = takeProgress(reasoned);
        if (reported.percent !== undefined) says({ type: 'progress', percent: reported.percent });
        answer = reported.text.trim();
        // Reasoning runs long, and what it settled on is at its end. Left over
        // the room it would be sent to be shortened, which a model that
        // reasons answers by reasoning again: three tries of three minutes
        // each came back empty, and the cut that followed kept the start of
        // it, where it was still working the problem out (see shorten).
        if (answer.length > kind.result) answer = answer.slice(-kind.result).trimStart();
        log.warn('subagent.no-report', {
          kind: kind.name,
          subagent: name,
          step,
          reasoned: reasoned.length,
          action: 'reasoning',
        });
      }
      break;
    }
    // What it said before calling the tools, which is usually why it called them
    const aside = text.replace(/\s+/g, ' ').trim();
    if (aside) thinks(aside);
    for (const call of calls) says({ type: 'tool_call', ...call });
    // Its reasoning stands in for what it wrote where it wrote nothing, so
    // that a step it spent working something out is not a blank turn in its
    // own history. Ollama takes a `thinking` field on an assistant message
    // and discards it, so content is the only channel its words come back
    // through; where a provider keeps the thinking itself the raw turn is
    // what goes back and this is passed over (see raw in
    // ../llm/providers/anthropic.ts). Without it a model that reasons and
    // never writes reads its own last turn as empty and does the work again:
    // one coder read the same stretch of a file on four rounds running, and
    // another retried an edit that had already failed, three times.
    messages.push({
      role: 'assistant',
      content: text.trim() ? text : reasoned.trim(),
      toolCalls: calls,
      raw: done?.raw,
    });
    const results = await Promise.all(
      // A subagent's own tool calls are not shown: its lines say what it did
      calls.map((call) =>
        offer
          ? run1(offer, call, { ...context, agent: name, depth })
          : tools.execute(call, { ...context, agent: name, depth }, { kind: kind.name, subagent: name, step })
      )
    );
    worked = true;
    for (const result of results) {
      messages.push({
        role: 'tool',
        toolCallId: result.id,
        name: result.name,
        content: result.output,
        isError: result.isError,
        ...(result.images && { images: result.images }),
      });
      says({ type: 'tool_result', id: result.id, name: result.name, output: result.output, isError: result.isError });
    }
  }

  // Its work is done, so what the model is still holding of its prompt is of
  // no further use to it: the next subagent, or the thread it reports to, has
  // the model from here (see ../llm/cachelock.ts).
  cachelock.broke(cacheKey, 'subagent done');

  // Longer than its kind has room for. Rather than cutting it off mid-sentence
  // it is sent its own words back and asked to make them fit (see shorten);
  // the cut below stays as the backstop for a model that cannot. Only a real
  // report is worth the call: a failure or a cut-off run is short already.
  const wrote = answer.trim().length;
  if (!signal.aborted && !failure && wrote > kind.result) {
    says({ type: 'shortening' });
    answer = await shorten(answer.trim(), kind, name, model, signal);
  }

  const isError = Boolean(failure) || !answer.trim();
  // Three ways to come back with nothing, and they are not the same thing. A
  // subagent that was cut off was working when its time ran out; one that
  // simply stopped had the rounds and did not use them; and one that failed
  // says what failed. Reporting all three as "finished without reporting
  // anything" sent us looking at the model when the answer was the clock (see
  // TIMEOUT_MS in ../harness/project.ts).
  //
  // And where it never wrote the report but did the work, what it ran stands
  // in for one, after whatever failed: an edit that landed is worth knowing
  // about whether or not the model got round to saying so (see account).
  const did = isError ? account(messages) : '';
  const text = signal.aborted
    ? `${CUT_OFF} It was on round ${through} of ${steps}.`
    : [failure, answer.trim() || did].filter(Boolean).join(' ') || NOTHING_REPORTED;
  // Still over after being asked to make it fit, so the end of it is lost.
  // Worth saying rather than leaving the reader to notice the sentence that
  // stops: a report that was cut is a report that may be missing its point.
  const cut = text.length > kind.result;
  log.info('subagent', {
    kind: kind.name,
    subagent: name,
    ok: !isError,
    cutOff: signal.aborted || undefined,
    ms: log.since(started),
    chars: text.length,
    // What it wrote before being asked to make it fit, so that a kind whose
    // subagents always overrun is visible in the log rather than only in the
    // cost of shortening them
    wrote: wrote > kind.result ? wrote : undefined,
    cut: cut || undefined,
    error: isError ? text : undefined,
  });
  const finding = { name, task, text: text.slice(0, kind.result), isError };
  // Nothing more can be addressed to it, and anything written to it that it
  // never got round to answering is answered with its report, which is the
  // truest answer left (see mailbox.close)
  mailbox.close(context.threadId, name, finding.text);
  emit?.({ type: 'subagent_done', id, text: finding.text, isError, cut: cut || undefined });
  return finding;
}

// Runs a set of tasks as subagents, all at once, and reports what each came
// back with. The tasks need not be of one kind: each is run as the kind it
// carries, with the tools that kind allows. Never throws: a task that goes
// wrong comes back as a finding that says so.
export async function run(tasks: Task[], context: ToolContext, offer?: Tool[]): Promise<string> {
  const waited = await findings(tasks, context, offer);
  const left = tasks.filter((task) => task.blocking === false).map(({ name }) => name);
  const said = report(waited);
  if (left.length === 0) return said;
  const working =
    `Still working, and not waited for: ${left.join(', ')}. ` +
    `Carry on with what does not depend on ${left.length === 1 ? 'it' : 'them'}, and call ${WAIT_TOOL} for ` +
    `${left.length === 1 ? 'its finding' : 'their findings'} when you need ${left.length === 1 ? 'it' : 'them'}.`;
  return said ? `${said}\n\n${working}` : working;
}

// As run, but gives back what each subagent brought rather than the report
// made of them: for a caller that has to tell a subagent that failed from one
// that simply had little to say (see ../harness/project.ts).
// Subagents started but not waited for, by thread and by the name the model
// knows each one by (see waitFor). A thread's own, so that two threads working
// at once never collect each other's.
const running = new Map<string, Map<string, Promise<Finding>>>();

// Where this thread's are kept, made if it has none yet
function runningIn(threadId: string): Map<string, Promise<Finding>> {
  const found = running.get(threadId) ?? new Map<string, Promise<Finding>>();
  running.set(threadId, found);
  return found;
}

// What a thread has still out, oldest first
export const stillRunning = (threadId: string | undefined): string[] =>
  threadId ? [...runningIn(threadId).keys()] : [];

// Collects subagents that were handed out without waiting: the ones named, or
// everything still out if none are named. A name nobody knows is said so
// rather than waited on for ever.
export async function waitFor(threadId: string | undefined, names?: string[]): Promise<Finding[]> {
  const out = threadId ? runningIn(threadId) : new Map<string, Promise<Finding>>();
  const wanted = names?.length ? names : [...out.keys()];
  // Collecting one is also letting it go, which is the only thing that tells a
  // subagent kept on for further messages that there are none coming: an agent
  // that has answered its job waits to be written to, and waiting for it
  // without releasing it would be each of them waiting on the other (see
  // mailbox.release and ./thread.ts). Every one of them is released before any
  // of them is waited for, so that collecting three does not hold the second
  // and third open while the first finishes.
  for (const name of wanted) mailbox.release(threadId, name);
  const found: Finding[] = [];
  for (const name of wanted) {
    const waiting = out.get(name);
    if (!waiting) {
      found.push({
        name,
        task: '',
        text: `Nothing by that name is still running. Still out: ${[...out.keys()].join(', ') || 'nothing'}.`,
        isError: true,
      });
      continue;
    }
    out.delete(name);
    found.push(await waiting);
  }
  if (out.size === 0) running.delete(threadId ?? '');
  return found;
}

// Forgets what a thread had out, for a thread that is gone
export function forgetThread(threadId: string): void {
  running.delete(threadId);
  mailbox.forget(threadId);
}

// A coder piece is rated below the model that handed it out, so that what it is
// given is always simpler than what that model is itself doing. Any other
// piece, and any piece of a thread whose model has no known level, is left as
// it was. The level is the answering model's, so a thread served by a lesser
// model than the request asked for hands out lower in step with it, and never
// hands out to its own equal (see ToolContext.sophistication).
function capped(task: Task, sophistication: number | undefined): Task {
  if (task.kind.name !== CODER.name || sophistication === undefined) return task;
  const cap = sophistication - 1;
  return { ...task, complexity: Math.max(1, Math.min(task.complexity ?? cap, cap)) };
}

export async function findings(allTasks: Task[], context: ToolContext, offer?: Tool[]): Promise<Finding[]> {
  const tasks = allTasks.map((task) => capped(task, context.sophistication));
  if (!context.model) throw new Error('No model is available to run subagents.');
  const needsWorkspace = tasks.find(({ kind }) => kind.needsWorkspace && !context.workspace);
  if (needsWorkspace) {
    throw new Error(
      `The "${needsWorkspace.kind.name}" kind of subagent works in the workspace the thread was started in, and this ` +
        'thread has none.'
    );
  }
  const { model } = context;
  // Worked out once per kind rather than once per task: the tools a kind may
  // use are the same for every subagent of it
  const specs = new Map<string, ToolSpecs>();
  for (const { kind } of tasks) if (!specs.has(kind.name)) specs.set(kind.name, specsFor(kind, context, offer));
  const { models } = await llm.listModels();

  // No two at once under one name. The name is how a piece is waited for and
  // where its note is kept, so two pieces sharing one would collect each
  // other's findings and write over each other's notes — easily done now that
  // an explorer can send explorers of its own, and both call the thing they
  // are looking at "the tests".
  const taken = new Set(stillRunning(context.threadId));
  for (const [i, task] of tasks.entries()) {
    let name = task.name;
    for (let n = 2; taken.has(name); n++) name = `${task.name} (${n})`;
    taken.add(name);
    // The caller's own task as well as the copy, since it reads the name back
    // to say which pieces are still running (see run)
    task.name = allTasks[i].name = name;
  }

  const started = performance.now();
  // Whatever a local model was holding for the thread that handed this out is
  // of no use to it now: it has nothing to send until these come back, and
  // what they send is their own prompts. Given up here so that the first of
  // them starts rather than waiting out a hold nobody is using (see
  // ../llm/cachelock.ts).
  cachelock.broke(context.threadId, 'handed work out');
  // Every piece is started here, whether or not anyone waits for it: handing
  // work out and waiting for it are two things, and only the second is
  // optional (see waitFor).
  const begun = tasks.map((task) => ({
    task,
    // Each piece on the model its rating calls for, rather than all of them on
    // whichever model happened to hand them out — and in the loop its kind
    // asks for: the one above for a piece of work, and the whole of the reply
    // flow for a job handed to an agent (see Kind.run and ./thread.ts)
    work: (task.kind.run
      ? task.kind.run(task, context, modelFor(task, models, model), models)
      : work(task, context, modelFor(task, models, model), specs.get(task.kind.name) as ToolSpecs, models, offer)
    ).finally(() =>
      // Where a loop threw rather than returning, nothing has closed its
      // letterbox or answered what was written to it. close() does nothing the
      // second time, so the loops' own call is still the one that matters (see
      // ./mailbox.ts).
      mailbox.close(context.threadId, task.name, UNFINISHED)
    ),
  }));
  const out = runningIn(context.threadId ?? '');
  for (const { task, work: working } of begun) {
    if (task.blocking === false) out.set(task.name, working);
  }
  const found = await Promise.all(begun.filter(({ task }) => task.blocking !== false).map(({ work }) => work));
  log.info('subagents', {
    kind: [...new Set(tasks.map(({ kind }) => kind.name))].join(','),
    models: [...new Set(tasks.map((task) => modelFor(task, models, model).model))].join(','),
    thread: context.threadId,
    tasks: tasks.length,
    waited: found.length,
    failed: found.filter((f) => f.isError).length,
    ms: log.since(started),
  });
  return found;
}

// What the model that sent them reads: each piece, named, with what came back
export function report(findings: Finding[]): string {
  return findings
    .map(({ name, text, isError }) => `## ${name}${isError ? ' (did not finish)' : ''}\n\n${text}`)
    .join('\n\n');
}
