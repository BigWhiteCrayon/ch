// Running an agent subagent: the one kind that is put through the whole of the
// reply flow rather than the small loop in ./run.ts. What the kind is and why
// it exists are in ./agent.ts.
//
// There is almost nothing of a loop here, and that is the point. The reply
// flow already knows how to work a job through — it classifies what it has
// been given, routes it to a model that suits it, works a coding change
// through in steps, condenses when the window fills, hands pieces out, and
// answers (see ../harness/index.ts). An agent is that flow, called with the
// task in the user's place, with three things said about it:
//
// - it is a subagent (see HarnessRequest.agent), which is what keeps it out of
//   the tools that belong to the thread itself and gives it a context note of
//   its own under its own name;
// - it is not bounded by rounds (see HarnessRequest.rounds);
// - and it is talked to rather than merely waited for, which is the loop that
//   is here: when the model that sent it writes while it is between turns, the
//   letter goes in as a turn of its own and the flow is run again (see
//   ./mailbox.ts, and the harness's own step loop for a letter that arrives
//   while it is working).
//
// Its events are passed on as the window already shows an agent's (see
// AgentEvent in ../types.ts), with one exception worth knowing about: the
// subagents it hands work out to report through the thread rather than through
// it, so they appear beside it in the window rather than inside it. A tab for
// a subagent of a subagent would be a place nobody looks, and the thing worth
// seeing about an agent's coders is the same thing that is worth seeing about
// the thread's own.

import * as log from '../log';
import * as mailbox from './mailbox';
import { shorten } from './run';
import type { Finding, Task } from './run';
import type { AgentEvent, ChatMessage, HarnessEvent, ModelInfo, Phase, ToolContext } from '../types';

// What the window is told when the flow reaches a step of a coding change (see
// ../harness/phases.ts). A thread shows these as the steps they are; a
// subagent's tab has thoughts and tool calls and nothing else, so each is said
// as the line a person watching would want.
const STEPS: Record<Phase, string> = {
  explore: 'Finding out how this part of the project works.',
  plan: 'Working out what to change.',
  execute: 'Making the change.',
  respond: 'Writing up what it did.',
  report: 'Writing up what it found.',
};

// What came back from one turn of the flow
interface Turn {
  // What it wrote for whoever sent it, which is its report
  text: string;
  // What went wrong, where something did
  failure: string;
  // The model that actually answered, where the flow said: its own choice when
  // the piece carried no rating, and worth having for the shortening below
  model?: { provider: string; model: string };
}

// Puts one turn through the reply flow and passes its work on as it happens.
async function turn(
  messages: ChatMessage[],
  name: string,
  depth: number,
  // What the window knows this agent by, which what it spends is charged to
  id: string,
  context: ToolContext,
  // The model to answer on, where the piece was rated and so has one, and
  // undefined to let the flow route the task on its own merits
  picked: { provider: string; model: string } | undefined,
  says: (event: AgentEvent) => void
): Promise<Turn> {
  // Imported here rather than at the top of the file because the harness
  // imports the subagents — it is the thing that hands work out — and a module
  // that imports it back is a cycle that resolves differently depending on
  // which of the two something else loads first. Asked for at the moment it is
  // used, long after both have loaded, there is no cycle to resolve.
  const { run } = await import('../harness');
  const { emit, signal } = context;
  const result: Turn = { text: '', failure: '' };
  // Its own rounds are the flow's business; no requestId is passed, which is
  // what keeps it from asking the user anything or being offered a model that
  // needs the user's say-so (see run in ../harness/index.ts)
  const events = run(
    {
      thread: context.threadId,
      workspace: context.workspace,
      messages,
      rounds: Infinity,
      agent: { name, depth },
      ...(picked ? { provider: picked.provider, model: picked.model } : {}),
    },
    signal
  );
  for await (const event of events) {
    switch (event.type) {
      // Its report, which is the whole of what comes back from it
      case 'text':
        result.text += event.delta;
        break;
      // What it is doing, in the shape a subagent's work is already shown in
      case 'thought':
      case 'tool_call':
      case 'tool_result':
      case 'queued':
      case 'waited':
      case 'condensing':
      case 'condensed':
      case 'shortening':
      case 'progress':
      case 'rate_limited':
      case 'fell_back':
        says(event);
        break;
      // The step it has reached, and the plan it wrote: a thread shows both as
      // things of their own, and a tab has thoughts to show them as
      case 'phase':
        says({ type: 'thought', text: STEPS[event.phase] });
        break;
      case 'plan':
        says({ type: 'thought', text: event.text });
        break;
      // Which model it is on. Said as a thought because the row for this agent
      // was written before the flow had routed it, and a piece that carried no
      // rating is routed by the flow rather than by whoever sent it.
      case 'model':
        result.model = { provider: event.provider, model: event.model };
        says({ type: 'thought', text: `Answering on ${event.name}.` });
        break;
      // Its own subagents, reported through the thread rather than through it
      // (see the head of this file), and the two facts about the thread that
      // are the thread's to show: where it has moved its work to
      case 'subagent':
      case 'subagent_update':
      case 'subagent_done':
      case 'branch':
      case 'workspace':
      // ...and a file on the user's own computer that it wants to read, or a
      // command there that could lose work, which only the user can allow
      // (see ../harness/access.ts)
      case 'file_access':
      case 'command_access':
        emit?.(event);
        break;
      // What it has spent, charged to this agent so that its own row carries
      // it. Anything already charged to a subagent of its own keeps that.
      case 'usage':
      case 'tokens':
        emit?.({ ...event, subagent: event.subagent ?? id });
        break;
      case 'error':
        result.failure = event.message;
        break;
      default:
        // 'classification', 'step', 'images', 'approval', 'question', 'done':
        // the first two say nothing a tab can show, the images and clips a
        // subagent takes are for its own eyes (see SHOWS_THE_USER in
        // ./kind.ts), and the last three cannot happen without a requestId
        break;
    }
  }
  return result;
}

// What is said of an agent that was stopped before it had written anything
const CUT_OFF = 'The agent was cut off before it reported: whoever sent it ran out of time.';
const NOTHING_REPORTED = 'The agent finished without reporting anything.';

// Runs one agent: the flow, once for the job it was given and once more for
// every message the model that sent it writes to it afterwards.
//
// Never throws, as the loop in ./run.ts does not: what went wrong comes back as
// the agent's finding, because the model that handed the job out has to be able
// to read what happened to it in the same place it reads everything else.
export async function work(
  piece: Task,
  context: ToolContext,
  model: { provider: string; model: string },
  _models: ModelInfo[]
): Promise<Finding> {
  const { name, task, kind } = piece;
  const { signal, emit } = context;
  const id = crypto.randomUUID();
  // One further down than whoever sent this one, so that what it hands out in
  // turn knows where it stands (see MAX_HANDOUT_DEPTH in ./kind.ts)
  const depth = (context.depth ?? 0) + 1;
  const says = (event: AgentEvent) => emit?.({ type: 'subagent_update', id, event });
  // The model it was rated for, where it was rated. A piece with no rating is
  // routed by the flow itself, on what the task turns out to be, so nothing is
  // said here about which model it is on and the flow says it when it knows
  // (see the 'model' event above).
  const picked = piece.complexity ? model : undefined;
  emit?.({
    type: 'subagent',
    id,
    name,
    task,
    kind: kind.name,
    complexity: piece.complexity,
    effort: piece.effort,
    ...(picked ? { model: picked.model } : {}),
  });

  // It stays for further messages only where the model that sent it has the
  // run of its own round to write them in: a job waited for is a job whose
  // sender is blocked on it, and there is nobody to talk to it (see
  // Task.blocking and waitFor in ./run.ts, which is what lets it go).
  const resident = piece.blocking === false;
  const messages: ChatMessage[] = [{ role: 'user', content: task }];
  const started = performance.now();
  mailbox.open(context.threadId, name);
  const where = { thread: context.threadId, agent: name, kind: kind.name };
  let answer = '';
  let failure = '';
  let answering = picked;
  let turns = 0;
  // Letters taken between turns, answered with the turn they brought on. A
  // letter taken while it was working is answered by the step that read it.
  let waiting: { answer(said: string): void }[] = [];
  for (;;) {
    turns++;
    let said: Turn;
    try {
      said = await turn(messages, name, depth, id, context, answering, says);
    } catch (err) {
      said = { text: '', failure: (err as Error).message };
    }
    answering = said.model ?? answering;
    failure = said.failure;
    if (said.text.trim()) answer = said.text.trim();
    // What it said goes back to whoever wrote to it, and into its own history
    // so that the turn after this one can see what it answered
    const back = answer || failure || NOTHING_REPORTED;
    for (const letter of waiting) letter.answer(back);
    waiting = [];
    if (failure || !resident || signal.aborted) break;
    messages.push({ role: 'assistant', content: back });
    // Nothing more is coming: it has been collected, or the work was stopped
    if (!(await mailbox.arrived(context.threadId, name, signal))) break;
    const letters = mailbox.take(context.threadId, name);
    for (const letter of letters) {
      // In the same words a letter that arrives while it is working is put to
      // it in (see the step loop in ../harness/index.ts)
      messages.push({ role: 'user', content: mailbox.WROTE_TO_YOU(letter.text) });
      waiting.push(letter);
    }
  }

  // Longer than there is room for, so it is asked to say the same thing in
  // less rather than being cut off mid-sentence (see shorten in ./run.ts)
  const wrote = answer.length;
  if (!signal.aborted && !failure && wrote > kind.result) {
    says({ type: 'shortening' });
    answer = await shorten(answer, kind, name, answering ?? model, signal);
  }
  const isError = Boolean(failure) || !answer.trim();
  const text = signal.aborted
    ? `${CUT_OFF}${answer.trim() ? ` What it had written: ${answer.trim()}` : ''}`
    : [failure, answer.trim()].filter(Boolean).join(' ') || NOTHING_REPORTED;
  const cut = text.length > kind.result;
  log.info('subagent.agent', {
    ...where,
    ok: !isError,
    cutOff: signal.aborted || undefined,
    ms: log.since(started),
    turns,
    chars: text.length,
    wrote: wrote > kind.result ? wrote : undefined,
    cut: cut || undefined,
    error: isError ? text : undefined,
  });
  const finding = { name, task, text: text.slice(0, kind.result), isError };
  // Whatever was written to it and never answered is answered with its report,
  // and nothing more can be addressed to it (see mailbox.close)
  mailbox.close(context.threadId, name, finding.text);
  emit?.({ type: 'subagent_done', id, text: finding.text, isError, cut: cut || undefined });
  return finding;
}
