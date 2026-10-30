// Letters from the model that sent a subagent, and the answers that come back.
//
// A subagent used to be something a model started and then waited for: it
// wrote the task, handed it out, and the next it heard was the report. That is
// right for a piece of work small enough to be stated once and stated well,
// and wrong for everything larger — a piece that turns out to need narrowing,
// a piece whose sender has since learned the thing that changes it, a piece
// that has been running for five minutes with nothing said about how it is
// getting on. In every one of those cases the only move the model had was to
// let the work run to the end and then hand it out again.
//
// So a subagent has a letterbox for as long as it runs. The model that sent it
// writes with message_subagent (see ../tools/subagents.ts); the letter arrives
// as a turn of its own in the subagent's next round; and what the subagent
// says in the next round that says anything at all is what the tool call
// returns. One letter, one answer, in the work rather than after it — not a
// tool that reports a delivery and leaves the answer to turn up in the report,
// by which time the model has stopped wanting it.
//
// The box belongs to the thread and not to whoever sent the subagent, because
// that is what a name belongs to: no two subagents of one thread run under the
// same name (see findings in ./run.ts), and a name is what a letter is
// addressed to. A subagent of a subagent is therefore reachable by the same
// means as any other, which is deliberate — they are all at work in the one
// container on the one job.
//
// Nothing here waits for ever. A subagent that ends with letters unanswered
// answers them with its report (see close), one that is let go stops listening
// (see release), and a letter nobody has got to in ANSWER_MS is given back to
// the model with that said plainly, so a reply cannot be lost to a subagent
// that went quiet.

import * as log from '../log';

// How long the model that wrote waits for an answer. A subagent answers in its
// next round, and a round is a call to a model with a tool call at the end of
// it, so the wait is one of those and not an instant. Long enough for a round
// that reads a file and thinks about it, short enough that a subagent which
// has stopped answering does not hold up the reply that wrote to it.
export const ANSWER_MS = 3 * 60 * 1000;

// What the model is told when the time is up. It is not a failure: the letter
// was delivered, and a subagent that has not answered yet is usually mid-call
// rather than ignoring it.
const NO_ANSWER_YET =
  'It has not answered yet: it was still working when the wait ran out. The message reached it, so what it has to ' +
  'say about it will come with its report. Do not send it again.';

// What a letter is put to a subagent as, wherever it is put to one: in the
// middle of its work by the loop running it (see ./run.ts and the step loop in
// ../harness/index.ts), or between turns by the agent runner (see
// ./thread.ts).
//
// Framed rather than passed on bare, because a message arriving out of nowhere
// in the middle of a piece of work is read as part of the work: a subagent
// given "skip the legacy routes" with nothing around it has been handed a new
// task, as far as it can tell, and will set about it instead of what it was
// doing. Three things have to be said with it — who it is from, that the
// answer goes back to them, and which of the two instructions wins where they
// disagree.
export const WROTE_TO_YOU = (text: string): string =>
  `The assistant that sent you has written to you while you work. This is what it says:

${text}

Answer it in a sentence or two in this turn, in words — what you write goes straight back to it, and it is waiting —
and then carry straight on with what you were doing. Where what it says changes the work you were given, that is the
instruction to follow from here. Where it only asks you something, answer it and get on with what you were doing.`;

// What a subagent is told when it answered a letter and called nothing that
// round.
//
// Such a round is not a report, whatever it reads like, and the loops that run
// a subagent end on a round that writes without calling (see ./run.ts and the
// reply flow). Read as a report it is the worst of both: the work stops in the
// middle, and the sentence the subagent wrote for whoever asked it a question
// is handed back as the whole of what it was sent to do. One of them, asked
// how it was getting on, answered "two of the four files, the third is the
// awkward one" and that became its report.
//
// So it is told what actually happened — the answer landed, and the work is
// still its — rather than what a round with no call in it usually means (see
// CARRY_ON in ./run.ts, which says nothing you wrote has reached anyone, and
// would be untrue here).
export const ANSWERED = `That answer has gone back to the assistant that wrote to you, so nothing you said there is
lost. It was not your report, though: you have rounds left and the work you were given is still yours. Carry on from
where you were and make the call you were about to make. Report when the work is done, not when you have answered a
message.`;

// What a letter is answered with when the subagent wrote nothing in the round
// that read it.
//
// A model that reads a letter and answers with a tool call has answered
// nothing, and the model waiting at the other end is owed something truer than
// silence: what it called stands in for what it did not say, which at least
// tells the asker that the message was read and that the work is going on. The
// same stand-in the small loop makes of a run that never reported (see account
// in ./run.ts).
export const answered = (said: string, calls: { name: string }[]): string => {
  if (said.trim()) return said.trim();
  if (calls.length === 0) return 'It read your message and wrote nothing back in that round.';
  const what = [...new Set(calls.map(({ name }) => name))].join(', ');
  return `It read your message and carried straight on working without writing anything back: ${what}.`;
};

// One letter, and the answer owed for it
interface Letter {
  text: string;
  // Given the subagent's own words, once it has said them. Said once: a letter
  // given back to the model for want of an answer (see ANSWER_MS) is a letter
  // whose answer now reaches nobody, and the subagent goes on working either
  // way.
  answer(said: string): void;
}

// What one subagent's box holds while it runs
interface Box {
  // Delivered and not yet taken into the subagent's conversation
  waiting: Letter[];
  // Woken when a letter arrives or when the subagent is let go, for one that
  // is waiting to be written to rather than working (see arrived)
  stir?: () => void;
  // It has been let go and is to finish: nothing more will be delivered
  released: boolean;
}

// Every box there is, by thread and then by the name the model knows the
// subagent by
const boxes = new Map<string, Map<string, Box>>();

const inThread = (threadId: string): Map<string, Box> => {
  const found = boxes.get(threadId) ?? new Map<string, Box>();
  boxes.set(threadId, found);
  return found;
};

// A subagent is running under this name and will take what is written to it.
// Called as its work starts, and before anything can be addressed to it.
export function open(threadId: string | undefined, name: string): void {
  if (!threadId) return;
  inThread(threadId).set(name, { waiting: [], released: false });
}

// Whoever can be written to in this thread, in the order they started
export const listening = (threadId: string | undefined): string[] => (threadId ? [...inThread(threadId).keys()] : []);

// The letters delivered since the last time this was asked, for the subagent
// to read in its next round. Taken rather than copied: a letter put into the
// conversation twice is answered twice.
export function take(threadId: string | undefined, name: string): Letter[] {
  const box = threadId ? inThread(threadId).get(name) : undefined;
  if (!box || box.waiting.length === 0) return [];
  return box.waiting.splice(0, box.waiting.length);
}

// Writes to a subagent and waits for what it says back.
//
// Throws where there is nobody of that name to write to, naming who there is:
// a model that addressed the wrong one can put that right in the same round,
// and one whose subagent has already finished is better told so than left
// waiting on an answer that is not coming.
export function send(
  threadId: string | undefined,
  name: string,
  text: string,
  signal: AbortSignal,
  withinMs = ANSWER_MS
): Promise<string> {
  const box = threadId ? inThread(threadId).get(name) : undefined;
  if (!box || box.released) {
    const open = listening(threadId).join(', ');
    throw new Error(
      `Nothing of yours called "${name}" is still running, so there is nobody of that name to write to. ` +
        `Still running: ${open || 'nothing'}.`
    );
  }
  return new Promise<string>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (said: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', stopped);
      resolve(said);
    };
    const stopped = () => settle('The reply was stopped before it answered.');
    const letter: Letter = { text, answer: settle };
    box.waiting.push(letter);
    box.stir?.();
    box.stir = undefined;
    log.info('subagent.letter', { thread: threadId, agent: name, chars: text.length });
    if (signal.aborted) return stopped();
    signal.addEventListener('abort', stopped, { once: true });
    timer = setTimeout(() => {
      log.warn('subagent.letter', { thread: threadId, agent: name, ok: false, error: 'no answer', ms: withinMs });
      settle(NO_ANSWER_YET);
    }, withinMs);
  });
}

// Waits for a letter for a subagent that has finished what it was given and is
// staying for whatever comes next (see ./thread.ts). True when one has
// arrived, false when it has been let go or the work was stopped.
export async function arrived(threadId: string | undefined, name: string, signal: AbortSignal): Promise<boolean> {
  const box = threadId ? inThread(threadId).get(name) : undefined;
  if (!box) return false;
  for (;;) {
    if (box.waiting.length > 0) return true;
    if (box.released || signal.aborted) return false;
    await new Promise<void>((resolve) => {
      box.stir = resolve;
      const stopped = () => resolve();
      signal.addEventListener('abort', stopped, { once: true });
    });
  }
}

// Lets a subagent go: it is to finish what it is saying and come back. Called
// when the model collects it (see waitFor in ./run.ts), which is the one thing
// that tells a subagent kept for further messages that there are none.
export function release(threadId: string | undefined, name: string): void {
  const box = threadId ? inThread(threadId).get(name) : undefined;
  if (!box) return;
  box.released = true;
  box.stir?.();
  box.stir = undefined;
}

// The subagent has finished. Whatever was written to it and never answered is
// answered with its report, which is the truest answer left: the question was
// about work that is now over, and the report is what that work came to.
export function close(threadId: string | undefined, name: string, report: string): void {
  const box = threadId ? inThread(threadId).get(name) : undefined;
  if (!box) return;
  inThread(threadId as string).delete(name);
  if (inThread(threadId as string).size === 0) boxes.delete(threadId as string);
  for (const letter of box.waiting) letter.answer(report);
}

// Forgets a thread's boxes, for a thread that is gone (see forgetThread in
// ./run.ts). Anything still waiting is answered rather than dropped: a promise
// nobody settles is a tool call that never returns.
export function forget(threadId: string): void {
  const open = boxes.get(threadId);
  if (!open) return;
  boxes.delete(threadId);
  for (const box of open.values()) for (const letter of box.waiting) letter.answer('The thread is gone.');
}
