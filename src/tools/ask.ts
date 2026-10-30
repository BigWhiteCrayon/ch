// The tool a model stops to ask the user something with. The question is put
// to the user in the thread, as a notification and a card; the model gets back
// whatever they said (see ask in ../harness/index.ts, which holds the reply
// until they do, and 'question' in HarnessEvent).

import { ASK_TOOL } from '../subagents/kind';
import type { Tool } from '../types';

// More than this is a menu rather than a question, and each is a button
export const MAX_OPTIONS = 6;

// What is made of the options a model gave: only the ones that say something,
// each once, and no more than there is room for
export function cleanOptions(options: unknown): string[] {
  if (options === undefined) return [];
  if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) {
    throw new Error('"options" must be a list of strings.');
  }
  const kept = options.map((option: string) => option.trim()).filter(Boolean);
  return [...new Set(kept)].slice(0, MAX_OPTIONS);
}

export const tool: Tool = {
  name: ASK_TOOL,
  description: `Stop and ask the user a question, and wait for the answer. They are told you are waiting, so use it only
for what you cannot settle yourself and cannot sensibly guess: a request that could mean two quite different things, a
choice between approaches that only they can make, a fact about their intentions that nothing in the workspace says.
Do not use it for what the code, the notes or a search can tell you, or to ask permission for something you were
already asked to do.

Ask one thing at a time, in a sentence or two they can answer without seeing your work. Give the answers you think are
likely in "options", most likely first: they are offered as buttons, and the user may answer in their own words
instead, so do not add an "other" option. Leave "options" out for a question that has no short answers.`,
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question, which the user reads without the rest of your work in front of them.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: `Likely answers, each a few words, at most ${MAX_OPTIONS}.`,
      },
    },
    required: ['question'],
  },
  async run(input, { ask }) {
    if (typeof input?.question !== 'string' || !input.question.trim()) {
      throw new Error('"question" must be a non-empty string.');
    }
    const options = cleanOptions(input.options);
    if (!ask) throw new Error('There is nobody to ask here. Carry on with your best reading and say what it is.');
    const answer = await ask(input.question.trim(), options);
    return `The user answered: ${answer}`;
  },
};

export function registerTools(registry: { register(tool: Tool): void }): void {
  registry.register(tool);
}
