import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../src/types';
import { from, model } from './helpers';

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('../src/llm', () => mocks);

import { decide } from '../src/harness/planner';

const small = model({ id: 'llama:3b', sophistication: 1 });

const text = (delta: string): ChatEvent => ({ type: 'text', delta });
const done = (stopReason = 'end_turn'): ChatEvent => ({ type: 'done', stopReason });
const requests = () => mocks.stream.mock.calls.map(([request]) => request as ChatRequest);

const messages = [
  { role: 'user' as const, content: 'move the database calls behind one interface' },
  { role: 'assistant' as const, content: 'Which database?' },
];

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.stream.mockImplementation(() => from([text('plan'), done()]));
});

describe('asking whether a task needs a plan', () => {
  it('sends the summary of the earlier conversation when there is one', async () => {
    await decide({ messages, summary: 'The repo uses Postgres via pg.' }, [small], new AbortController().signal);
    const prompt = String(requests()[0].messages[0].content);
    expect(prompt).toContain('<summary>\nThe repo uses Postgres via pg.\n</summary>');
    expect(prompt.indexOf('<summary>')).toBeLessThan(prompt.indexOf('<conversation>'));
  });

  it('sends no summary when there is none', async () => {
    await decide({ messages }, [small], new AbortController().signal);
    const prompt = String(requests()[0].messages[0].content);
    expect(prompt).not.toContain('<summary>');
    expect(prompt.endsWith('Answer:')).toBe(true);
  });
});
