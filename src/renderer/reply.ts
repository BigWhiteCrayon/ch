import type { Message, Resumed, Thread } from './types.js';
import {
  idleTimers,
  inflight,
  messagesEl,
  models,
  requests,
  setToTheEnd,
  SUMMARY_IDLE_MS,
  SUMMARY_MIN_MESSAGES,
} from './shared.js';
import { activeThread, addMessage, save, sourceOf, state } from './threads.js';
import { loadModels, noModelsMessage, selectedModel } from './models.js';
import { clock, recordUsage } from './usage.js';
import { render } from './thread-view.js';
import { toolOf } from './tool-calls.js';
import { shorten } from './events.js';
import { retrySubagent, resumedSubagent } from './sidebar.js';
import { dropSuggestion } from './suggestion.js';

// Sending and receiving

export const CLASSIFYING = 'Classifying complexity & routing…';
// What a coding change is doing, step by step (see harness/phases.ts). Kept
// here rather than taken from the harness because it is what the user reads,
// and the window owns its own words.
export const PHASES: Record<import('./types').Phase, string> = {
  explore: 'Finding out what this touches…',
  plan: 'Working out a plan…',
  execute: 'Making the changes…',
  respond: 'Writing the answer…',
  report: 'Writing up the investigation…',
};
// ...and the same steps once they are over
export const PHASES_DONE: Record<import('./types').Phase, string> = {
  explore: 'Found out what this touches',
  plan: 'Worked out a plan',
  execute: 'Made the changes',
  respond: 'Wrote the answer',
  report: 'Wrote up the investigation',
};
// The explore step of an investigation is named for investigating, not for
// touching things: what it is doing and what it did are said the same way
export const phaseName = (phase: import('./types').Phase, investigating?: boolean): string =>
  phase === 'explore' && investigating ? 'Investigating…' : PHASES[phase];
export const phaseNameDone = (phase: import('./types').Phase, investigating?: boolean): string =>
  phase === 'explore' && investigating ? 'Investigated' : PHASES_DONE[phase];
// Shown instead while the classifier's model is busy with another request
export const WAITING = 'Waiting on in-progress request…';
// ...and the same wait with the model named, for the waits that happen once one
// has been chosen. A local model answers one conversation at a time and keeps
// itself for the one whose prompt it is holding, so a reply that has not
// started may be waiting on another thread's reply or on its subagents rather
// than on anything of its own (see llm/cachelock.ts).
export const waitingTurn = (model: string) => `Waiting its turn for ${model}…`;
export const CONDENSING = 'Condensing context…';
// What stays in the log once it is done
export const CONDENSED = 'Context condensed';
export const SHORTENING = 'Shortening a report that ran long…';
// What a reply says while its subagents work. The reply itself can do nothing
// until they are done, so the dots would be saying the model is writing when
// it is not.
export const waitingOn = (n: number) => `Waiting on ${n} subagent${n === 1 ? '' : 's'}…`;
// The kinds of task a message can be classified as
export const CATEGORY_NAMES: Record<string, string> = {
  coding: 'Coding',
  question: 'Question',
  investigation: 'Investigation',
  general: 'General',
};

export async function send(text: string): Promise<void> {
  const thread = activeThread();
  setToTheEnd(true);
  const asked = addMessage(thread, 'user', text);
  render();
  await reply(thread, asked);
}

// Where the reply to a user message ends: at the next user message, or at the
// end of the thread
export function endOfTurn(thread: Thread, asked: Message): number {
  const start = thread.messages.indexOf(asked) + 1;
  const next = thread.messages.findIndex((m, i) => i >= start && m.role === 'user');
  return next === -1 ? thread.messages.length : next;
}

// What stands in for a turn that left nothing of the assistant's in the
// thread. A reply can end with no words for the user — a model that writes its
// answer into its reasoning, a cancellation, a failure — and the user can
// delete the answer to a message and keep the message; the thoughts, tool
// calls and errors that are left either way are not conversation, so none of
// it comes through here. Without something in its place the two user messages
// either side of it meet, and a model handed a request with no answer under
// it answers that one again along with the one actually being asked. So the
// gap is declared, and declared as not a request waiting to be served.
export const NO_REPLY_KEPT =
  `[The assistant's reply to the message above is not in this transcript. That message is not an\n` +
  `unanswered request: answer only the most recent message.]`;

// The part of these messages that is conversation: what the user said (and what
// the app asked for itself, which is the user's turn as far as the model is
// concerned, see fromApp), and what the assistant said as the final answer
// of its reply (see markFinal), without the notes, thoughts and tool calls
// around it. A turn from before final was kept, or one that was cut off before
// it was marked, has no such mark, so there the last words before the next user
// message stand for the answer instead. Always alternating from the user's side:
// see NO_REPLY_KEPT.
export function conversation(messages: Message[]): { role: 'user' | 'assistant'; content: string }[] {
  const answers = new Set<Message>();
  let turn: Message[] = [];
  const close = (): void => {
    const said = turn.filter((m) => m.role === 'assistant' && m.text);
    const answer = said.findLast((m) => m.final) ?? said.at(-1);
    if (answer) answers.add(answer);
    turn = [];
  };
  for (const m of messages) {
    if (m.role === 'user') close();
    else turn.push(m);
  }
  close();

  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if ((m.role !== 'user' && m.role !== 'assistant') || !m.text) continue;
    if (m.role === 'assistant' && !answers.has(m)) continue;
    if (m.role === 'user' && out.at(-1)?.role === 'user') out.push({ role: 'assistant', content: NO_REPLY_KEPT });
    out.push({ role: m.role, content: m.text });
  }
  return out;
}

// Summaries: a thread that has been idle for a while is condensed by a model
// (see harness/summarizer.ts). The messages stay on screen as they were; only
// what the model is sent changes.

// The thread was just used: it is due a summary once it has been left alone
export function touch(thread: Thread): void {
  thread.lastActive = Date.now();
  summarizeWhenIdle(thread, SUMMARY_IDLE_MS);
}

// Threads whose description is being written right now
export const describing = new Set<string>();

// Brings the thread's title up to date with what the user has asked for in
// it: a few words written by a small local model. Lazy: it runs after a reply,
// nothing waits for it, and a thread it can't describe keeps the title it has.
export async function describeThread(thread: Thread): Promise<void> {
  // What the app asked for itself, such as the problems a review found, is not what the thread is about
  const asked = thread.messages.filter((m) => m.role === 'user' && m.text && !m.fromApp).map((m) => m.text);
  if (asked.length === 0 || asked.length === thread.described) return;
  if (describing.has(thread.id) || inflight.has(thread.id)) return;

  describing.add(thread.id);
  const result = await window.llm.describe({ requests: asked }).catch(() => null);
  describing.delete(thread.id);
  // No description this time: tried again after the thread's next reply
  if (!result || !state.threads.includes(thread)) return;

  thread.title = result.text;
  thread.described = asked.length;
  if (result.usage) recordUsage(thread, result.usage);
  save();
  const top = messagesEl.scrollTop;
  render();
  messagesEl.scrollTop = top;
}

export function summarizeWhenIdle(thread: Thread, delay: number): void {
  clearTimeout(idleTimers.get(thread.id));
  idleTimers.set(
    thread.id,
    setTimeout(() => summarizeThread(thread), Math.max(0, delay))
  );
}

export async function summarizeThread(thread: Thread): Promise<void> {
  idleTimers.delete(thread.id);
  if (inflight.has(thread.id) || !state.threads.includes(thread)) return;
  const fresh = thread.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text && !m.summarized);
  if (fresh.length < SUMMARY_MIN_MESSAGES) return;

  const result = await window.llm
    .summarize({ messages: conversation(fresh), summary: thread.summary })
    .catch(() => null);
  // No summary this time: the thread is tried again after its next use
  if (!result || !state.threads.includes(thread)) return;

  const summary = result.text;
  if (result.usage) recordUsage(thread, result.usage);
  thread.summary = summary;
  for (const m of fresh) m.summarized = true;
  // One note marks how far the summary reaches; it opens to show the summary
  thread.messages = thread.messages.filter((m) => m.summary === undefined);
  const covered = thread.messages.findLastIndex((m) => m.summarized);
  thread.messages.splice(covered + 1, 0, {
    role: 'note',
    text: 'Conversation so far summarized',
    summary,
    thoughtId: crypto.randomUUID(),
  });
  save();
  if (thread.id === state.activeId) {
    const top = messagesEl.scrollTop;
    render();
    messagesEl.scrollTop = top;
  }
}

// Asks for a reply to one of the thread's user messages. The model sees the
// conversation up to that message, and the reply goes directly after it, so
// this serves a new message as well as a retry of an earlier one.
//
// resumed: what an earlier run of this same reply had done before the app
// closed on it. That work stays in the thread and the reply carries on below
// it, rather than in place of it (see resumeCutOff).
// The request that last set out to answer each user message. The main process
// holds the thread's files as they were when that request started, and this is
// what asks for them back (see the retry below). Kept here rather than on the
// message because it is worth nothing once the app closes: the snapshot it
// names goes with the process that took it.
export const attempts = new WeakMap<Message, string>();

export async function reply(thread: Thread, asked: Message, resumed?: Resumed): Promise<void> {
  // At the end of the turn: that is the message itself for a reply just asked
  // for, and after whatever is already there for one picked up or asked again
  const insert = (message: Message) => thread.messages.splice(endOfTurn(thread, asked), 0, message);
  // The suggestion was for what the reply above it left to say, which has now been said
  dropSuggestion(thread);
  if (models.length === 0) await loadModels();
  if (models.length === 0) {
    insert({ role: 'error', text: noModelsMessage() });
    save();
    render();
    return;
  }
  // Left undefined on Auto, so the harness routes the message itself
  const model = selectedModel();

  // The summary covers the thread up to some point, so it can't be used when
  // retrying a message from before that point
  const summary = asked.summarized ? undefined : thread.summary;
  const history = conversation(
    thread.messages.slice(0, thread.messages.indexOf(asked) + 1).filter((m) => !(summary && m.summarized))
  );
  touch(thread);

  // A new reply, or a retry, has the message classified afresh; one picked up
  // after the app closed keeps the rating it had, and the note showing it
  if (!resumed) {
    delete asked.classification;
    delete asked.reviewed;
    delete asked.approval;
  }
  const note = resumed?.classification
    ? turnOf(thread, asked).findLast((m) => m.role === 'note' && m.classifier !== undefined)
    : undefined;

  // Every message is first classified and routed to a model (see the harness)
  const message: Message = { role: 'assistant', text: '', streaming: true, status: CLASSIFYING };
  insert(message);
  const requestId = crypto.randomUUID();
  inflight.set(thread.id, requestId);
  attempts.set(asked, requestId);
  // On disk before the request goes out, so that however the app goes down
  // from here, the next launch knows this reply never finished
  asked.pending ??= 0;
  save();
  requests.set(requestId, {
    startedAt: Date.now(),
    thread,
    message,
    asked,
    note,
    usage: [],
    thoughts: [],
    calls: [],
    subagents: new Map(),
    live: new Map(),
  });
  clock(Date.now());
  render();

  window.llm.send(requestId, {
    thread: thread.id,
    workspace: sourceOf(thread),
    summary,
    provider: model?.provider,
    model: model?.id,
    messages: history,
    review: asked.review,
    resumed,
    plan: thread.plan,
    investigate: thread.investigate,
  });
}

// Picking up a reply the app closed in the middle of.
//
// Nothing of the conversation the model was having is kept: the tool calls it
// had made, its reasoning and the model's own place in the exchange all lived
// in the process that went away. What is kept is the thread, which is saved
// as it is written (see save), and the thread's container, which is kept when
// the app quits so that the files its tools changed are still changed (see
// ../sandbox/docker.ts).
//
// So the reply is asked for again, and the model answering is handed an
// account of what the cut-off one had done and written (see the harness's
// pickedUp). It carries on below that work rather than in place of it: what
// was done really was done, and the user can see it.

// What the thread shows where the app closed on a reply
export const PICKED_UP_NOTE = 'The app closed while this reply was being written; picked up from here';
// ...and what it shows instead when that has now happened twice to the same
// message. Something about this reply may be what is closing the app, so it
// is left alone and the user decides whether to ask for it again.
export const LEFT_ALONE =
  'The app closed again while this reply was being picked up, so it has been left as it is. ' +
  'Continue to pick it up from where it stopped, or retry it from the message menu to start it over.';
// How many times a reply is picked up before it is left alone
export const MAX_PICKUPS = 1;
// How much of the account of a cut-off reply is given to the model
export const ACCOUNT_INPUT = 200; // characters of what a call was given
export const ACCOUNT_OUTPUT = 400; // characters of what came back from it
export const ACCOUNT_CALLS = 30; // calls, the most recent kept

// Everything a reply left in the thread: the notes, thoughts, tool calls and
// prose between the message it answers and whatever came after it
export function turnOf(thread: Thread, asked: Message): Message[] {
  return thread.messages.slice(thread.messages.indexOf(asked) + 1, endOfTurn(thread, asked));
}

// Called when a reply reaches its end: the last words the assistant wrote in
// the turn are its final answer. A turn that ended on a tool call with no words
// after it has none, and nothing is marked.
export function markFinal(thread: Thread, asked: Message): void {
  if (!thread.messages.includes(asked)) return;
  const last = turnOf(thread, asked).findLast((m) => m.role === 'assistant' && m.text);
  if (last) last.final = true;
}

// What a cut-off reply had done, as the model picking it up is told it: a
// line per tool call and per subagent, oldest first, with in brief what came
// back. Thoughts are left out, since a model's reasoning cannot be handed
// back to it, and so are the app's own notes, which say nothing about the work.
export function accountOf(turn: Message[]): string[] {
  const lines = turn.flatMap((m) => {
    if (m.role === 'tool') {
      // A call that failed keeps the whole of what it was given, as JSON,
      // where one that worked keeps the summary; either reads as one line
      const given = m.inputSummary
        ? m.inputSummary.split('\n').join(', ')
        : (m.input ?? '').replace(/\s+/g, ' ').trim();
      const call = `${toolOf(m)}(${shorten(given, ACCOUNT_INPUT)})`;
      if (m.failure !== undefined) return [`${call} failed: ${shorten(m.failure, ACCOUNT_OUTPUT)}`];
      // A call with neither a result nor a failure is the one the app closed
      // on: it may have run, and there is no way to tell from here
      if (m.output === undefined) return [`${call} — not known whether it ran: the app closed before it came back.`];
      const changed = m.diff ? ' That file is changed in your container.' : '';
      return [`${call} returned: ${shorten(m.output, ACCOUNT_OUTPUT)}${changed}`];
    }
    if (m.role === 'subagent') {
      const given = `subagent ${m.text} (${m.kind ?? 'worker'}), given "${shorten(m.task ?? '', ACCOUNT_INPUT)}"`;
      if (m.failed) return [`${given} did not finish, so nothing came of it.`];
      // Still working when the app closed: it has been continued, but on its own,
      // so what it brings back goes in the thread and not to the model
      if (m.finding === undefined) {
        return [
          `${given} was still working when the app closed. It has been continued, and its report will ` +
            'appear in the thread when it is done; do not hand it out again.',
        ];
      }
      return [`${given} reported: ${shorten(m.finding ?? '', ACCOUNT_OUTPUT)}`];
    }
    return [];
  });
  // A long reply can have made a great many calls, and the last of them are
  // the ones it was in the middle of, so those are the ones kept
  if (lines.length <= ACCOUNT_CALLS) return lines;
  const left = lines.length - ACCOUNT_CALLS;
  return [`(${left} earlier ${left === 1 ? 'call' : 'calls'} left out of this list)`, ...lines.slice(-ACCOUNT_CALLS)];
}

// Replies the app closed in the middle of, picked up where they left off.
// Deferred to its own turn: the window finishes coming up first, so the user
// sees the thread as it was left before anything is added to it.
export function resumeCutOff(): void {
  let changed = false;
  for (const thread of state.threads) {
    const asked = thread.messages.find((m) => m.role === 'user' && m.pending);
    if (!asked) continue;
    changed = true;
    // The mark stays while the reply is picked up, so that an app that closes
    // on it again counts this attempt too. What clears it is the reply
    // reaching an end of its own (see the request's last event).
    if ((asked.pending ?? 0) > MAX_PICKUPS) {
      delete asked.pending;
      thread.messages.splice(endOfTurn(thread, asked), 0, { role: 'error', text: LEFT_ALONE });
      continue;
    }
    pickUp(thread, asked);
  }
  if (!changed) return;
  save();
  render();
}

// Asks for the reply to a message again, below what the cut-off one had done
// and with a note saying so
function pickUp(thread: Thread, asked: Message): void {
  const turn = turnOf(thread, asked);
  const resumed: Resumed = {
    // Every bubble of it: a reply writes into a new one after each tool call
    text: turn.flatMap((m) => (m.role === 'assistant' && m.text ? [m.text] : [])).join('\n\n') || undefined,
    did: accountOf(turn),
    answered: asked.review
      ? thread.review?.filter((c) => c.entries.some((e) => e.from === 'assistant')).map((c) => c.id)
      : undefined,
    classification: asked.classification,
    approval: asked.approval,
  };
  thread.messages.splice(endOfTurn(thread, asked), 0, {
    role: 'note',
    text: PICKED_UP_NOTE,
    thoughtId: crypto.randomUUID(),
  });
  void reply(thread, asked, resumed);
}

// The Continue button on LEFT_ALONE: the user says the reply is to be picked up
// after all, so it is, from what it had done, in place of the error
export function continueReply(thread: Thread, error: Message): void {
  if (inflight.has(thread.id)) return;
  const at = thread.messages.indexOf(error);
  const asked = thread.messages.slice(0, at).findLast((m) => m.role === 'user');
  if (at === -1 || !asked) return;
  thread.messages.splice(at, 1);
  pickUp(thread, asked);
}

// Subagents the app closed in the middle of, continued from where they left off.
// They are run on their own, as one the user asks for again is (see
// retrySubagent), with the account of what each had done so the run that follows
// carries on rather than starts over: the conversation of the reply that sent
// one out is gone with the process, so a reply picked up above is told this one
// has been continued and carries on without it. Each is continued once; one that
// has the app closed on it a second time is failed when it is loaded (see load).
export function resumeSubagents(): void {
  for (const thread of state.threads) {
    for (const subagent of thread.messages) {
      if (subagent.role !== 'subagent' || subagent.finding !== undefined) continue;
      subagent.restarts = (subagent.restarts ?? 0) + 1;
      void retrySubagent(thread, subagent, resumedSubagent(subagent));
    }
  }
}

// Token use: counted per model for the whole thread, and listed with its cost
// at the end of each request

// Adds together what each pass of a request used, so that a model that
// answered over several passes is one line rather than one line per pass.
