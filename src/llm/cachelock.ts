// Which conversation a local model is keeping its prompt for.
//
// A local server keeps the work it did on one prompt and reuses whatever the
// next prompt begins with (Ollama reports what it reused as
// prompt_eval_cached_count). A step that carries on from the step before it
// therefore reads only what was added since; the same step, after something
// else has been through the model, reads the conversation again from the top.
// Measured on a 27,944-token step of a coding reply: 8,028 tokens to read
// where the prefix held, all 27,944 where it did not, and a hundred and
// fifteen seconds instead of ten.
//
// So a model is kept for one conversation at a time. Every request says whose
// prompt it is with ChatRequest.cacheKey — a thread's id, or a subagent's —
// and whoever the model last answered keeps it: that conversation's next
// request goes straight through, and another's waits (see HOLD_MS). This is
// not a lock held while a conversation works: a reply spends most of its time
// running tools, and what the hold is for is stopping the gap between two of
// its steps being filled by a request that would cost it the whole prompt.
//
// The hold ends when the prefix does. Part of that is said from outside, by
// whoever knows the prompt has changed shape rather than grown: a phase that
// changed the tools, a compaction that rewrote the conversation, a message
// pushed in mid-reply, work handed to subagents, the reply ending (see broke).
// The rest is here: a request with no cacheKey is one of the app's own one-off
// prompts — classifying a message, compacting a record, summarising a thread,
// asking for a shorter report — which shares a prefix with nothing and ends
// the hold it finds by running at all.
//
// Only local models are held. A hosted provider's cache is keyed on the prompt
// rather than on a slot in memory (see providers/anthropic.ts), so two threads
// taking turns there cost each other nothing, and only local requests wait
// their turn in the first place (see index.ts).

import type { ChatMessage } from '../types';
import * as log from '../log';

// How long a model is kept for the conversation it last answered, with
// nothing arriving from it.
//
// It covers the gap between two steps of a reply, which is what a tool call
// costs: a search or a read is under a second, and the whole round of them
// with the container prepared around it is a second or two. Long enough to
// cover that and some slack; short enough that a conversation which has
// actually stopped — waiting on a command that runs for a minute, or on the
// user — hands the model on rather than leaving it idle for want of asking.
export const HOLD_MS = 5000;

// A model is held per provider as well as per name: two providers can offer
// the same model id, and they are not the same copy in the same memory.
export const modelKey = (provider: string, model: string): string => `${provider}/${model}`;

// Model -> whose prompt it holds, and when that conversation last had it
const holds = new Map<string, { key: string; at: number }>();

// What to tell when a hold is given up, so that whatever was waiting on it
// starts rather than waiting out a hold that is already gone. Set by index.ts,
// which is where the waiting is kept.
let freed: (() => void) | undefined;
export function whenFreed(start: () => void): void {
  freed = start;
}

// Whose prompt the model is holding, where the hold is still good
export function holder(model: string, now = Date.now()): string | undefined {
  const hold = holds.get(model);
  if (!hold) return undefined;
  if (hold.at + HOLD_MS > now) return hold.key;
  // Nothing has come from it within the hold, so it has given the model up.
  // Forgotten as it is read rather than on a timer: a hold that has run out
  // says nothing either way, and the queue asks before it does anything.
  holds.delete(model);
  log.debug('llm.lock', { model, key: hold.key, lock: 'lapsed' });
  return undefined;
}

// How long a request for this model should wait for the conversation holding
// it, or 0 where it may go now. A conversation never waits for itself, and
// the app's own one-off prompts (no key) never wait at all: what they would be
// waiting for is a prefix they are about to overwrite whenever they run.
export function waitFor(model: string, key: string | undefined, now = Date.now()): number {
  if (!key) return 0;
  const holding = holder(model, now);
  const hold = holds.get(model);
  if (!holding || !hold || holding === key) return 0;
  return hold.at + HOLD_MS - now;
}

// Said when a request runs: what the model holds from here is this request's
// prompt, and the hold starts again from now. A request with no key leaves
// nothing worth keeping behind it, so it ends the hold rather than taking one.
export function held(model: string, key: string | undefined, now = Date.now()): void {
  const was = holds.get(model);
  if (!key) {
    if (was) log.debug('llm.lock', { model, key: was.key, lock: 'broke', why: 'one-off prompt' });
    holds.delete(model);
    return;
  }
  holds.set(model, { key, at: now });
  if (was?.key !== key) log.debug('llm.lock', { model, key, lock: 'took', from: was?.key });
}

// Said when a conversation's prefix is gone, by whoever knows it is: its
// prompt no longer carries on from the one the model read (see brokeBy), it
// has handed its work to subagents, or there will not be another prompt from it
// at all. Whatever it was holding is given up at once rather than kept for the
// rest of the hold by a conversation that cannot use it, and whatever was
// waiting on that hold is started.
export function broke(key: string | undefined, why: string): void {
  if (!key) return;
  let gave = false;
  for (const [model, hold] of holds) {
    if (hold.key !== key) continue;
    holds.delete(model);
    gave = true;
    log.debug('llm.lock', { model, key, lock: 'broke', why });
  }
  if (gave) freed?.();
}

// Every hold forgotten, for tests and for settings being rebuilt: the models
// themselves are reloaded then, and what they were holding went with them.
export function forget(): void {
  holds.clear();
}

// What a step of a reply sent, in the parts a hold on the model turns on: two
// steps that agree on all three carry on from one another, and two that do not
// are two prompts the server has to read from the top (see brokeBy).
export interface Shape {
  // The instructions, which a reply worked through in steps changes at every
  // step boundary (see harness/phases.ts)
  system: string;
  // The tools it was offered, by name. Ollama's renderers put the tool
  // definitions above the instructions rather than below them: on qwen3.5:9b,
  // two steps whose system prompts shared 4,391 characters had 32 tokens in
  // common — the preamble above the tools — once their tool lists differed, so
  // a step that changes its tools keeps none of its prompt.
  tools: string;
  // How many of the turns are the user's. A reply that pushes a message of its
  // own in mid-flight moves the last of them, and the renderers write the
  // turns before the last user turn differently from the ones after it:
  // measured on a step whose nudge was pushed in this way, 8,028 of its 27,944
  // tokens came from the cache and the other 19,916 were read again, at a
  // hundred and fifteen seconds. The count and not the position, so that a
  // result or a reply being appended — which is all a step usually does —
  // reads as the carrying on that it is.
  users: number;
}

export const shapeOf = (
  system: string | undefined,
  tools: readonly { name: string }[] | undefined,
  messages: readonly ChatMessage[]
): Shape => ({
  system: system ?? '',
  tools: (tools ?? []).map(({ name }) => name).join(' '),
  users: messages.reduce((n, message) => (message.role === 'user' ? n + 1 : n), 0),
});

// Why the second of two steps cannot carry on from the first, or nothing where
// it can. The reason is for the log: what is done about it is the same either
// way (see broke).
export function brokeBy(was: Shape, now: Shape): string | undefined {
  if (was.tools !== now.tools) return 'tools changed';
  if (was.system !== now.system) return 'instructions changed';
  if (was.users !== now.users) return 'message pushed in';
  return undefined;
}
