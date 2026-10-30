import { beforeEach, describe as group, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), stream: vi.fn() }));
vi.mock('../../src/llm', () => mocks);

import { MAX_LENGTH, NOTHING, PROMPT, clean, suggest } from '../../src/harness/suggester';

const tiny = model({ id: 'llama3.2:3b', sophistication: 1 });
const bigger = model({ id: 'qwen:9b', sophistication: 3 });
const haiku = model({ id: 'haiku', provider: 'anthropic', local: false, sophistication: 1 });
const sent = () => mocks.stream.mock.calls[0][0] as ChatRequest;
const replyWith = (...events: ChatEvent[]) => mocks.stream.mockImplementation(() => from(events));
const asked = {
  messages: [
    { role: 'user' as const, content: 'Fix it' },
    { role: 'assistant' as const, content: 'Done. Add a test?' },
  ],
};

beforeEach(() => {
  mocks.listModels.mockReset();
  mocks.stream.mockReset();
  mocks.listModels.mockResolvedValue({ models: [bigger, haiku, tiny], providers: [] });
  replyWith({ type: 'text', delta: 'Yes, ' }, { type: 'text', delta: 'add one' }, { type: 'done', stopReason: 'stop' });
});

group('clean', () => {
  it.each([
    ['Yes, add one', 'Yes, add one'],
    ['  "Yes, add one"\n', 'Yes, add one'],
    ['User: Yes, add one', 'Yes, add one'],
    ['use snake_case here', 'use snake_case here'],
    [NOTHING, ''],
    [' none. ', ''],
    ['', ''],
  ])('takes the suggestion out of %j', (reply, text) => {
    expect(clean(reply)).toBe(text);
  });

  it('gives none for a reply that runs on', () => {
    expect(clean('word '.repeat(MAX_LENGTH))).toBe('');
  });
});

group('suggest', () => {
  it('asks the simplest local model what the user would say next, and returns it', async () => {
    await expect(suggest(asked)).resolves.toEqual({ text: 'Yes, add one' });
    expect(sent()).toMatchObject({ provider: 'local', model: 'llama3.2:3b', system: PROMPT, brief: true });
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content: "<user>\nFix it\n</user>\n\n<assistant>\nDone. Add a test?\n</assistant>\n\nThe user's next message:",
      },
    ]);
  });

  it('sends only the latest messages, keeping the end of a long one', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: i === 5 ? `${'x'.repeat(2000)} the end` : `message ${i}`,
    }));
    await suggest({ messages });
    const content = sent().messages[0].content;
    expect(content).not.toContain('message 1');
    expect(content).toContain('message 2');
    expect(content).toContain('[...] ');
    expect(content).toContain('x the end');
    expect(content).not.toContain('x'.repeat(1500));
  });

  it.each([
    ['there is no local model', () => mocks.listModels.mockResolvedValue({ models: [haiku], providers: [] })],
    ['the model reports an error', () => replyWith({ type: 'error', code: 'other', message: 'boom' })],
    [
      'the model says there is nothing',
      () => replyWith({ type: 'text', delta: NOTHING }, { type: 'done', stopReason: 'stop' }),
    ],
    ['listing the models fails', () => mocks.listModels.mockRejectedValue(new Error('offline'))],
  ])('gives no suggestion when %s', async (_name, arrange) => {
    arrange();
    await expect(suggest(asked)).resolves.toBeNull();
  });

  it('asks no model when the assistant has not spoken last', async () => {
    await expect(suggest({ messages: [] })).resolves.toBeNull();
    await expect(suggest({ messages: [asked.messages[0]] })).resolves.toBeNull();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
