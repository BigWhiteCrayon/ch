// Writes a suggestion for what the user might say next: shown in the message
// box as faint text after a reply, and filled in if they press Tab (see the
// renderer's suggestion.ts).
//
// Like the thread's description (see describer.ts) this is done lazily, after
// a reply and off to one side, and it is small work, so it goes to the simplest
// local model: free to run, and nothing is sent anywhere for the sake of a
// hint. Without a local model there is no suggestion.
//
// Most replies leave nothing worth suggesting, and the model is told that
// "nothing" is a fine answer. suggest() never throws; it resolves with null
// when there is no suggestion.

import * as llm from '../llm';
import * as log from '../log';
import type { Suggestion, SuggestionRequest } from '../types';
import { pickModel } from './describer';

const TIMEOUT_MS = 60000;
const MAX_TOKENS = 100;
const RECENT_MESSAGES = 4;
// The end of a message is where it asks something, so it is the end that is kept
const MAX_MESSAGE_LENGTH = 1500;
export const MAX_LENGTH = 200; // characters of suggestion kept
export const NOTHING = 'NONE';

export const PROMPT = `You are given the end of a conversation between a user and an assistant. If the assistant's
last message asks the user something or offers a next step, write the reply the user is most likely to send. Write it
in the first person, as if you are the user typing it to the assistant ("Yes, go ahead", "I'd rather use Postgres"):
never speak as the assistant, and never describe the user in the third person. Keep it as short as they would write
it: a few words, and at most one sentence. If nothing in the message calls for a reply, or you cannot tell what the user
would say, write ${NOTHING}. Reply with only the user's message or ${NOTHING}: no quotes, and nothing before or after
it.`;

function transcript(messages: SuggestionRequest['messages']): string {
  const lines = messages.slice(-RECENT_MESSAGES).map(({ role, content }) => {
    const text = content.trim();
    const kept = text.length > MAX_MESSAGE_LENGTH ? `[...] ${text.slice(-MAX_MESSAGE_LENGTH)}` : text;
    return `<${role}>\n${kept}\n</${role}>`;
  });
  return `${lines.join('\n\n')}\n\nThe user's next message:`;
}

// Takes the suggestion out of the reply: all of it, without the quotes and
// "User:" a small model tends to add. '' if there is none, which is what
// NONE, and a suggestion that runs on past MAX_LENGTH, both come to: a long
// one is not a hint but the model carrying on the conversation itself.
export function clean(reply: string): string {
  const text = reply
    .replace(/^\s*(user|you)\s*:/i, '')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  if (text.toUpperCase().replace(/[^A-Z]/g, '') === NOTHING) return '';
  return text.length > MAX_LENGTH ? '' : text;
}

export async function suggest(request: SuggestionRequest): Promise<Suggestion | null> {
  const started = performance.now();
  const failed = (error: string, model?: string) => {
    log.warn('suggestion', { ok: false, ms: log.since(started), model, error });
    return null;
  };
  try {
    // A suggestion answers the assistant: there is none to give before it has spoken
    if (request.messages.at(-1)?.role !== 'assistant') return null;
    const { models } = await llm.listModels();
    const model = pickModel(models);
    // Not a failure: there is simply nothing to write it with
    if (!model) return null;

    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: PROMPT,
        messages: [{ role: 'user', content: transcript(request.messages) }],
        maxTokens: MAX_TOKENS,
        brief: true,
        log: { purpose: 'suggestion' },
      },
      AbortSignal.timeout(TIMEOUT_MS)
    );
    let reply = '';
    for await (const event of events) {
      if (event.type === 'text') reply += event.delta;
      if (event.type === 'error') return failed(event.message, model.id);
    }
    const text = clean(reply);
    log.info('suggestion', { ok: true, ms: log.since(started), model: model.id, suggested: Boolean(text) });
    return text ? { text } : null;
  } catch (err) {
    return failed((err as Error).message);
  }
}
