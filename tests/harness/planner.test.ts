import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const stream = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm', () => ({ stream }));

import { PROMPT, decide, parse } from '../../src/harness/planner';

const replyWith = (text: string) =>
  stream.mockImplementation(() =>
    from<ChatEvent>([
      { type: 'text', delta: text },
      { type: 'done', stopReason: 'end_turn', usage: { input: 20, output: 2 } },
    ])
  );

const local = model({ id: 'mistral:7b', sophistication: 2 });
const hosted = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
const signal = () => new AbortController().signal;
const ask = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

beforeEach(() => {
  stream.mockReset();
});

describe('the prompt', () => {
  it('asks for "plan" or "no plan" and stays small', () => {
    expect(PROMPT).toContain('Reply with only "plan" or "no plan".');
    expect(PROMPT.length).toBeLessThan(1200);
  });
});

describe('parse', () => {
  it.each([
    ['plan', true],
    ['Plan.', true],
    ['no plan', false],
    ['**No plan**', false],
    ['No plan needed, so plan: none', false],
  ])('reads %j', (reply, expected) => expect(parse(reply)).toBe(expected));

  it('is null when the reply says neither', () => {
    expect(parse('yes')).toBeNull();
    expect(parse('')).toBeNull();
  });
});

describe('decide', () => {
  it('asks the least sophisticated model, with a prompt of its own, and reports its tokens', async () => {
    replyWith('plan');
    const decision = await decide(ask('add a --dry-run flag'), [hosted, local], signal());
    expect(decision).toEqual({
      plan: true,
      model: 'mistral:7b',
      provider: local.provider,
      usage: { input: 20, output: 2 },
    });
    const sent = stream.mock.calls[0][0] as ChatRequest;
    expect(sent.system).toBe(PROMPT);
    expect(sent.model).toBe('mistral:7b');
    expect(sent.messages[0].content).toContain('user: add a --dry-run flag');
  });

  it('says no plan when the model does', async () => {
    replyWith('no plan');
    expect((await decide(ask('fix the typo'), [local], signal())).plan).toBe(false);
  });

  it('keeps to the last of the conversation', async () => {
    replyWith('no plan');
    const messages = ['one', 'two', 'three'].map((content) => ({ role: 'user' as const, content }));
    await decide({ messages }, [local], signal());
    const sent = (stream.mock.calls[0][0] as ChatRequest).messages[0].content;
    expect(sent).not.toContain('one');
    expect(sent).toContain('three');
  });

  it('means no plan, and says why, when the reply cannot be read', async () => {
    replyWith('maybe');
    expect(await decide(ask('x'), [local], signal())).toMatchObject({ plan: false, reason: expect.any(String) });
  });

  it('means no plan when the model errors, throws, or there is none', async () => {
    stream.mockImplementation(() => from<ChatEvent>([{ type: 'error', message: 'down' } as ChatEvent]));
    expect(await decide(ask('x'), [local], signal())).toMatchObject({ plan: false, reason: 'down' });
    stream.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await decide(ask('x'), [local], signal())).toMatchObject({ plan: false, reason: 'boom' });
    expect(await decide(ask('x'), [], signal())).toMatchObject({ plan: false, reason: 'No models available.' });
  });
});
