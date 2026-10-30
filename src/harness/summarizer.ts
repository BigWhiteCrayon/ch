// Condenses a thread into a summary that stands in for its messages. A thread
// that has been idle for a while is summarized (see the renderer), and from
// then on the model is given the summary in place of the messages it covers,
// which keeps long threads quick and cheap to continue.
//
// summarize() never throws; it resolves with null when no summary could be made.

import * as llm from '../llm';
import { SOPHISTICATION } from '../llm/sophistication';
import { priced } from '../llm/pricing';
import * as log from '../log';
import type { Summary, SummaryRequest, Usage } from '../types';
import { route } from './router';

const TIMEOUT_MS = 120000;
// Well over the 600 words asked for: a model that reasons first spends its
// reasoning out of the same allowance
const MAX_TOKENS = 4000;
const MAX_MESSAGE_LENGTH = 6000;

export const PROMPT =
  'You are given a conversation between a user and an assistant, and you write the summary that will replace it. ' +
  'The assistant will carry on the conversation later seeing only your summary, not the conversation, so ' +
  'include everything it would need: what the user is trying to do, the facts and preferences they gave, the ' +
  'decisions made and the reasons for them, what has been done so far and what is still open, and the exact names ' +
  'that matter, such as files, functions, commands and values. If you are given an earlier summary, fold what still ' +
  'matters from it into yours. Leave out pleasantries and anything that was later corrected or replaced. ' +
  'Open with one or two sentences naming what the conversation is about and what the user is working toward, ' +
  'including any images or attachments being discussed. Then give the current state of the work. ' +
  'Write plain prose or short lists, in no more than 600 words, with no preamble.';

function transcript({ messages, summary }: SummaryRequest): string {
  const lines = messages.map((m) => {
    const text = m.content.length > MAX_MESSAGE_LENGTH ? `${m.content.slice(0, MAX_MESSAGE_LENGTH)} [...]` : m.content;
    return `${m.role}: ${text}`;
  });
  const earlier = summary ? `<earlier_summary>\n${summary}\n</earlier_summary>\n\n` : '';
  return `${earlier}<conversation>\n${lines.join('\n\n')}\n</conversation>\n\nWrite the summary.`;
}

export async function summarize(request: SummaryRequest): Promise<Summary | null> {
  const started = performance.now();
  const failed = (error: string, model?: string) => {
    log.warn('summary', { ok: false, ms: log.since(started), messages: request.messages.length, model, error });
    return null;
  };
  try {
    const { models } = await llm.listModels();
    // A summary is relied on for the rest of the thread, so it is worth a
    // strong model: the cheapest one rated at least that, else the best there is
    const model = route(models, { sophistication: SOPHISTICATION.STRONG }, {});
    if (!model) return failed('No models available.');

    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: PROMPT,
        messages: [{ role: 'user', content: transcript(request) }],
        maxTokens: MAX_TOKENS,
        log: { purpose: 'summary' },
      },
      AbortSignal.timeout(TIMEOUT_MS)
    );
    let text = '';
    let usage: Usage | undefined;
    for await (const event of events) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') return failed(event.message, model.id);
    }
    if (!text.trim()) return failed('The model wrote nothing.', model.id);
    log.info('summary', {
      ok: true,
      ms: log.since(started),
      messages: request.messages.length,
      provider: model.provider,
      model: model.id,
      input: usage?.input,
      output: usage?.output,
    });
    return {
      text: text.trim(),
      usage: usage && priced('summary', model.provider, model.id, usage, models),
    };
  } catch (err) {
    return failed((err as Error).message);
  }
}
