// Writes a thread's description: a few words on what the user has asked for,
// shown as the thread's name in place of the start of its first message.
//
// This is done lazily, after a reply and off to one side (see the renderer),
// and it is small work, so it goes to the simplest local model: free to run,
// and nothing is sent anywhere for the sake of a label. Without a local model
// there is no description, and the thread keeps the name it has.
//
// describe() never throws; it resolves with null when no description was made.

import * as llm from '../llm';
import { priced } from '../llm/pricing';
import * as log from '../log';
import type { Description, DescriptionRequest, ModelInfo, Usage } from '../types';
import { cheapestFirst } from './router';

const TIMEOUT_MS = 60000;
const MAX_TOKENS = 200;
const RECENT_REQUESTS = 8;
const MAX_REQUEST_LENGTH = 300;
export const MAX_LENGTH = 60; // characters of description kept

export const PROMPT = `You are given what a user asked for in a conversation, oldest first. Write a title for the
conversation that sums up what the user wants, in at most six words. Reply with only the title: no quotes, no full
stop, and nothing before or after it.`;

// The least sophisticated of the user's local models
export function pickModel(models: ModelInfo[]): ModelInfo | undefined {
  return models.filter((m) => m.local).sort(cheapestFirst)[0];
}

function requests(asked: string[]): string {
  const lines = asked.slice(-RECENT_REQUESTS).map((text, i) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return `${i + 1}. ${flat.length > MAX_REQUEST_LENGTH ? `${flat.slice(0, MAX_REQUEST_LENGTH)} [...]` : flat}`;
  });
  return `<requests>\n${lines.join('\n')}\n</requests>\n\nTitle:`;
}

// Takes the title out of the reply: its first line, without the quotes,
// Markdown and "Title:" a small model tends to add. '' if nothing is left.
export function clean(reply: string): string {
  const line = reply.split('\n').find((l) => l.trim()) ?? '';
  const text = line
    .replace(/^\s*title\s*:/i, '')
    .replace(/[*_`#]/g, '')
    .trim()
    .replace(/^["'“‘]+|["'”’.]+$/g, '')
    .trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH).trimEnd()}…` : text;
}

export async function describe(request: DescriptionRequest): Promise<Description | null> {
  const started = performance.now();
  const failed = (error: string, model?: string) => {
    log.warn('description', { ok: false, ms: log.since(started), model, error });
    return null;
  };
  try {
    if (request.requests.length === 0) return null;
    const { models } = await llm.listModels();
    const model = pickModel(models);
    // Not a failure: there is simply nothing to write it with
    if (!model) return null;

    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: PROMPT,
        messages: [{ role: 'user', content: requests(request.requests) }],
        maxTokens: MAX_TOKENS,
        brief: true,
        log: { purpose: 'description' },
      },
      AbortSignal.timeout(TIMEOUT_MS)
    );
    let reply = '';
    let usage: Usage | undefined;
    for await (const event of events) {
      if (event.type === 'text') reply += event.delta;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') return failed(event.message, model.id);
    }
    const text = clean(reply);
    if (!text) return failed('The model wrote nothing.', model.id);
    log.info('description', {
      ok: true,
      ms: log.since(started),
      model: model.id,
      input: usage?.input,
      output: usage?.output,
    });
    return { text, usage: usage && priced('description', model.provider, model.id, usage, models) };
  } catch (err) {
    return failed((err as Error).message);
  }
}
