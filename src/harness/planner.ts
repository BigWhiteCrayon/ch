// Decides whether a coding task is worked through in steps, with a plan the
// user can read before anything is changed (see phases.ts), or in one run.
//
// A thread set to plan always does. For every other thread the answer is asked
// for here, once, when a coding task in a workspace is started: a plan buys
// the user a chance to stop the work before it happens, and costs four passes
// over the model where one would have done, so it is worth it for a change
// with choices in it and a waste for a one-line fix.
//
// It has a prompt of its own, apart from the classifier's, and is kept small:
// the classifier's rating says how hard the task is, and this asks only the
// one thing the rating does not. decide() never throws, and a reply that
// cannot be read means no plan, which is what a thread does unless told to.

import * as llm from '../llm';
import type { ChatMessage, ModelInfo, Usage } from '../types';
import { pickModel } from './classifier';

const TIMEOUT_MS = 30000;
const RECENT_MESSAGES = 2;
const MAX_MESSAGE_LENGTH = 600;
const MAX_SUMMARY_LENGTH = 1500;

// Every line says one thing, and the model reads it a line at a time, so the
// lines are joined rather than wrapped.
export const PROMPT =
  'Decide whether a coding task needs a plan the user can read before any file is changed. Do not do the task. ' +
  'Reply with only "plan" or "no plan".\n' +
  'plan: the change spreads over several files, or there is more than one reasonable way to make it.\n' +
  'no plan: a small change described exactly, in one place, where a plan would only repeat the request.\n' +
  'Where it is close, reply "no plan".\n' +
  'Examples:\n' +
  'fix the typo in the README -> no plan\n' +
  'rename the variable x to count in utils.py -> no plan\n' +
  'give the importer a --dry-run flag that prints what it would write -> plan\n' +
  'pull the database calls out of the handlers and behind one interface -> plan';

export interface Decision {
  plan: boolean;
  // What was asked, when a model was: named so that the tokens it used can be
  // accounted for
  model?: string;
  provider?: string;
  usage?: Usage;
  // Why the answer is the default, when the model could not give one
  reason?: string;
}

// The last of the conversation: enough to make sense of a message like "yes,
// do that", and no more, since this runs before the work does.
function conversation(messages: ChatMessage[], summary?: string): string {
  const recent = messages.slice(-RECENT_MESSAGES).map((m) => {
    const text = m.content.length > MAX_MESSAGE_LENGTH ? `${m.content.slice(0, MAX_MESSAGE_LENGTH)} [...]` : m.content;
    return `${m.role}: ${text}`;
  });
  const trimmed = summary?.trim() ?? '';
  const head =
    trimmed === ''
      ? ''
      : `<summary>\n${
          trimmed.length > MAX_SUMMARY_LENGTH ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH)} [...]` : trimmed
        }\n</summary>\n\n`;
  return `${head}<conversation>\n${recent.join('\n\n')}\n</conversation>\n\nAnswer:`;
}

// "no plan" is looked for alongside "plan" so that the first of them in the
// reply wins, "no plan" being the one that contains the other. Null when the
// reply says neither.
export function parse(reply: string): boolean | null {
  const said = /\b(no plan|plan)\b/i.exec(reply)?.[1].toLowerCase();
  return said === undefined ? null : said === 'plan';
}

// models: the enabled models, as returned by llm.listModels()
export async function decide(
  request: { messages: ChatMessage[]; summary?: string },
  models: ModelInfo[],
  signal: AbortSignal
): Promise<Decision> {
  let model: string | undefined;
  let provider: string | undefined;
  let usage: Usage | undefined;
  try {
    // An easy question, so it goes where the classifier's does: the least
    // sophisticated model there is
    const asked = pickModel(models);
    if (!asked) return { plan: false, reason: 'No models available.' };
    model = asked.id;
    provider = asked.provider;
    const events = llm.stream(
      {
        provider,
        model,
        system: PROMPT,
        messages: [{ role: 'user', content: conversation(request.messages, request.summary) }],
        // The reply is waiting on this
        priority: true,
        brief: true,
        timeoutMs: TIMEOUT_MS,
        log: { purpose: 'planning' },
      },
      signal
    );

    let reply = '';
    for await (const event of events) {
      if (event.type === 'text') reply += event.delta;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') return { plan: false, reason: event.message, model, provider };
    }
    const plan = parse(reply);
    return plan === null
      ? { plan: false, reason: 'The reply was neither "plan" nor "no plan".', model, provider, usage }
      : { plan, model, provider, usage };
  } catch (err) {
    return { plan: false, reason: (err as Error).message, model, provider };
  }
}
