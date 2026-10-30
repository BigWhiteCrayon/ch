import { beforeEach, describe as group, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), stream: vi.fn() }));
vi.mock('../../src/llm', () => mocks);

import { MAX_LENGTH, PROMPT, clean, describe, pickModel } from '../../src/harness/describer';

const tiny = model({ id: 'llama3.2:3b', sophistication: 1 });
const bigger = model({ id: 'qwen:9b', sophistication: 3 });
const haiku = model({ id: 'haiku', provider: 'anthropic', local: false, sophistication: 1 });
const sent = () => mocks.stream.mock.calls[0][0] as ChatRequest;
const replyWith = (...events: ChatEvent[]) => mocks.stream.mockImplementation(() => from(events));

beforeEach(() => {
  mocks.listModels.mockReset();
  mocks.stream.mockReset();
  mocks.listModels.mockResolvedValue({ models: [bigger, haiku, tiny], providers: [] });
  replyWith(
    { type: 'text', delta: 'Parsing JSON ' },
    { type: 'text', delta: 'in Rust\n' },
    { type: 'done', stopReason: 'stop' }
  );
});

group('pickModel', () => {
  it('picks the simplest local model, never a hosted one', () => {
    expect(pickModel([bigger, haiku, tiny])).toBe(tiny);
    expect(pickModel([haiku, bigger])).toBe(bigger);
    expect(pickModel([haiku])).toBeUndefined();
  });
});

group('clean', () => {
  it.each([
    ['Parsing JSON in Rust', 'Parsing JSON in Rust'],
    ['  "Parsing JSON in Rust."\n', 'Parsing JSON in Rust'],
    ['Title: **Parsing JSON in Rust**', 'Parsing JSON in Rust'],
    ['\n\n“Fix the login bug”\nThis title sums up...', 'Fix the login bug'],
    ["'Rename `config.ts`'", 'Rename config.ts'],
    ['', ''],
    ['"."', ''],
  ])('takes the title out of %j', (reply, title) => {
    expect(clean(reply)).toBe(title);
  });

  it('cuts a title that runs on', () => {
    const cut = clean('word '.repeat(40));
    expect(cut).toHaveLength(MAX_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
  });
});

group('describe', () => {
  it("asks the simplest local model for a title from the user's requests, and returns it", async () => {
    const result = await describe({ requests: ['How do I parse JSON in Rust?', 'Show me\n  an example'] });
    expect(result).toEqual({ text: 'Parsing JSON in Rust' });
    expect(sent()).toMatchObject({ provider: 'local', model: 'llama3.2:3b', system: PROMPT, brief: true });
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content: '<requests>\n1. How do I parse JSON in Rust?\n2. Show me an example\n</requests>\n\nTitle:',
      },
    ]);
    // Lazy work waits its turn behind everything else
    expect(sent().priority).toBeUndefined();
    expect(PROMPT).toContain('at most six words');
  });

  it('sends only the latest requests, each cut to a sensible length', async () => {
    const requests = Array.from({ length: 12 }, (_, i) => `request ${i + 1} ${'x'.repeat(i === 11 ? 500 : 0)}`);
    await describe({ requests });
    const content = sent().messages[0].content;
    expect(content).not.toContain('request 4 ');
    expect(content).toContain('1. request 5');
    expect(content).toContain(`8. request 12 ${'x'.repeat(289)} [...]`);
  });

  it('reports the tokens it took, which cost nothing on a local model', async () => {
    replyWith(
      { type: 'text', delta: 'A title' },
      { type: 'done', stopReason: 'stop', usage: { input: 90, output: 4 } }
    );
    await expect(describe({ requests: ['hi'] })).resolves.toEqual({
      text: 'A title',
      usage: { purpose: 'description', provider: 'local', model: 'llama3.2:3b', input: 90, output: 4, cost: 0 },
    });
  });

  it.each([
    ['there is no local model', () => mocks.listModels.mockResolvedValue({ models: [haiku], providers: [] })],
    ['the model reports an error', () => replyWith({ type: 'error', code: 'other', message: 'boom' })],
    [
      'the model writes nothing usable',
      () => replyWith({ type: 'text', delta: ' "" \n' }, { type: 'done', stopReason: 'stop' }),
    ],
    ['listing the models fails', () => mocks.listModels.mockRejectedValue(new Error('offline'))],
  ])('gives no description when %s', async (_name, arrange) => {
    arrange();
    await expect(describe({ requests: ['hi'] })).resolves.toBeNull();
  });

  it('asks no model when the user has asked for nothing', async () => {
    await expect(describe({ requests: [] })).resolves.toBeNull();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
