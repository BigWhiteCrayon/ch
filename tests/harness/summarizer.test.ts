import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), stream: vi.fn() }));
vi.mock('../../src/llm', () => mocks);

import { PROMPT, summarize } from '../../src/harness/summarizer';

const small = model({ id: 'llama:3b', sophistication: 1 });
const sonnet = model({ id: 'sonnet', provider: 'anthropic', local: false, sophistication: 3 });
const opus = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
const messages = [
  { role: 'user' as const, content: 'How do I parse JSON in Rust?' },
  { role: 'assistant' as const, content: 'Use serde_json.' },
];
const sent = () => mocks.stream.mock.calls[0][0] as ChatRequest;
const replyWith = (...events: ChatEvent[]) => mocks.stream.mockImplementation(() => from(events));

beforeEach(() => {
  mocks.listModels.mockReset();
  mocks.stream.mockReset();
  mocks.listModels.mockResolvedValue({ models: [opus, sonnet, small], providers: [] });
  replyWith(
    { type: 'text', delta: ' The user is parsing ' },
    { type: 'text', delta: 'JSON in Rust.\n' },
    { type: 'done', stopReason: 'end_turn' }
  );
});

describe('summarize', () => {
  it('asks a model to summarize the conversation and returns what it wrote', async () => {
    await expect(summarize({ messages })).resolves.toEqual({ text: 'The user is parsing JSON in Rust.' });
    expect(sent().system).toBe(PROMPT);
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content:
          '<conversation>\n' +
          'user: How do I parse JSON in Rust?\n\n' +
          'assistant: Use serde_json.\n' +
          '</conversation>\n\n' +
          'Write the summary.',
      },
    ]);
  });

  it('reports the tokens the summary took and what they cost', async () => {
    mocks.listModels.mockResolvedValue({
      models: [model({ id: 'claude-sonnet-5-5', provider: 'anthropic', local: false, sophistication: 3 })],
      providers: [],
    });
    replyWith(
      { type: 'text', delta: 'Summary.' },
      { type: 'done', stopReason: 'end_turn', usage: { input: 3000, output: 200 } }
    );
    await expect(summarize({ messages })).resolves.toEqual({
      text: 'Summary.',
      // 3,000 in at $2 per million plus 200 out at $10 per million
      usage: {
        purpose: 'summary',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        input: 3000,
        output: 200,
        cost: 0.008,
      },
    });
  });

  it('uses the cheapest model rated strong, or the best there is', async () => {
    await summarize({ messages });
    expect(sent()).toMatchObject({ provider: 'anthropic', model: 'sonnet' });

    mocks.stream.mockClear();
    mocks.listModels.mockResolvedValue({ models: [small], providers: [] });
    await summarize({ messages });
    expect(sent()).toMatchObject({ provider: 'local', model: 'llama:3b' });
  });

  it('includes the earlier summary so that it can be folded in', async () => {
    await summarize({ messages, summary: 'They set up a Rust project.' });
    const { content } = sent().messages[0] as { content: string };
    expect(content).toMatch(/^<earlier_summary>\nThey set up a Rust project\.\n<\/earlier_summary>\n\n<conversation>/);
  });

  it('shortens very long messages', async () => {
    await summarize({ messages: [{ role: 'user', content: 'x'.repeat(9000) }] });
    const { content } = sent().messages[0] as { content: string };
    expect(content).toContain(`${'x'.repeat(6000)} [...]`);
    expect(content).not.toContain('x'.repeat(6001));
  });

  it('keeps the summary to a bounded length', async () => {
    await summarize({ messages });
    // Room for a model's own reasoning as well as the summary
    expect(sent().maxTokens).toBe(4000);
    expect(PROMPT).toContain('no more than 600 words');
  });

  it('asks the summary to open with the topic and what the user is working toward', async () => {
    await summarize({ messages });
    expect(sent().system).toContain('one or two sentences naming what the conversation is about');
    expect(sent().system).toContain('what the user is working toward');
    expect(sent().system).toContain('images or attachments');
  });

  it.each([
    ['there are no models', () => mocks.listModels.mockResolvedValue({ models: [], providers: [] })],
    [
      'the model reports an error',
      () => replyWith({ type: 'text', delta: 'Partial' }, { type: 'error', code: 'other', message: 'boom' }),
    ],
    ['the model writes nothing', () => replyWith({ type: 'done', stopReason: 'end_turn' })],
    [
      'the call throws',
      () =>
        mocks.stream.mockImplementation(() => {
          throw new Error('exploded');
        }),
    ],
    ['the models cannot be listed', () => mocks.listModels.mockRejectedValue(new Error('offline'))],
  ])('resolves with null when %s', async (_name, arrange) => {
    arrange();
    await expect(summarize({ messages })).resolves.toBeNull();
  });
});
