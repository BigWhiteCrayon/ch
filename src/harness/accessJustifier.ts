// Writes the model's own reason for wanting a file or a command on the user's
// computer, shown on the card it is asked about (see access.ts) so the user can
// judge it, not only see what it asks for.
//
// Like a thread's description (see describer.ts) and its suggestion of what to
// say next (see suggester.ts) this is a one-off prompt of its own, and like
// them it is done by the simplest local model: free to run, and nothing is sent
// anywhere for the sake of a reason. Without a local model there is no reason,
// and the card is shown without one rather than the question held for it. It is
// done without holding the user up: the question is shown at once, and the
// reason arrives in its own event when the call has written it (see the
// 'access_justification' event and the card in the renderer's approvals).
//
// justify() never throws; it resolves with '' where no reason could be written,
// which the card shows without one rather than without a card.

import * as llm from '../llm';
import * as log from '../log';
import type { ChatMessage } from '../types';
import { pickModel } from './describer';

const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 120;
// The end of the conversation is where the request lives, so it is the end that
// is kept, as a suggestion is (see suggester.ts)
const RECENT_MESSAGES = 4;
const MAX_MESSAGE_LENGTH = 800;
export const MAX_LENGTH = 240; // characters of a reason kept

// What is asked of the model: one or two sentences on why it wants what it is
// after, in words the user reads without the model's own work in front of them.
// It is told the path (and, for a command, the command and what is risky about
// it, since those are what the card already shows) so it need not restate them.
const PROMPT = `You are the model that asked to read a file or run a command on the user's computer, and the user is
being asked to allow it. Write the reason you want it, in one or two sentences, in words the user can judge without
seeing your work. Say what you need it for and what you will do with it; do not restate the path, and do not ask a
question. If you cannot say why, write nothing. Reply with only the reason: no quotes, and nothing before or after it.`;

// The last few messages, each cut to length, as the model's reason is read from
// the conversation it is in. The request is at the end, so it is the end that is
// kept.
function transcript(messages: ChatMessage[]): string {
  const lines = messages.slice(-RECENT_MESSAGES).map(({ role, content }) => {
    const text = (content ?? '').trim();
    const kept = text.length > MAX_MESSAGE_LENGTH ? `[...] ${text.slice(-MAX_MESSAGE_LENGTH)}` : text;
    return `<${role}>\n${kept}\n</${role}>`;
  });
  return `${lines.join('\n\n')}`;
}

// What the model is asking for, as it is named on the card: the path, or for a
// command the command and what is risky about it.
function want({
  target,
  isFolder,
  command,
  why,
}: { target: string; isFolder: boolean; command?: string; why?: string }): string {
  if (command) return `run the command "${command}" in ${target}${why ? ` — ${why}` : ''}`;
  return `read ${isFolder ? 'the folder' : 'the file'} ${target}`;
}

// Takes the reason out of the reply: its first line, without the quotes and a
// lead-in a small model tends to add. '' for a reply that said nothing.
export function clean(reply: string): string {
  const line = reply.split('\n').find((l) => l.trim()) ?? '';
  const text = line
    .replace(/^\s*(the reason is|reason|why)\s*:?\s*/i, '')
    .replace(/[*_`#]/g, '')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH).trimEnd()}…` : text;
}

export interface JustifyRequest {
  // What the model asked for, as the card shows it
  target: string;
  isFolder: boolean;
  // For a command: the command itself and what is risky about it (see
  // hostReading.ts sensitive)
  command?: string;
  why?: string;
  // The conversation the request is in, so the reason fits it
  conversation?: ChatMessage[];
  signal: AbortSignal;
}

// The model's reason for the access, or '' where none could be written. Never
// throws: a call that could not be made leaves the card without a reason rather
// than failing the question the user is being asked.
export async function justify(request: JustifyRequest): Promise<string> {
  const started = performance.now();
  const failed = (error: string, model?: string) => {
    log.warn('access.justification', { ok: false, ms: log.since(started), model, error });
    return '';
  };
  try {
    // Nothing to ask with, or the reply is already stopped: leave the card
    // without a reason rather than make a call nobody is waiting on
    if (request.signal.aborted) return '';
    const { models } = await llm.listModels();
    const model = pickModel(models);
    // Not a failure: there is simply nothing to write it with
    if (!model) return '';
    if (request.signal.aborted) return '';
    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: PROMPT,
        messages: [
          {
            role: 'user',
            content: `${transcript(request.conversation ?? [])}\n\nYou are about to ${want(request)}. Why?`,
          },
        ],
        maxTokens: MAX_TOKENS,
        brief: true,
        think: false,
        timeoutMs: TIMEOUT_MS,
        log: { purpose: 'access_justification' },
      },
      request.signal
    );
    let reply = '';
    for await (const event of events) {
      if (event.type === 'text') reply += event.delta;
      else if (event.type === 'error') return failed(event.message, model.id);
    }
    const text = clean(reply);
    if (!text) return failed('The model wrote nothing.', model.id);
    log.info('access.justification', { ok: true, ms: log.since(started), model: model.id, reason: Boolean(text) });
    return text;
  } catch (err) {
    return failed((err as Error).message);
  }
}
