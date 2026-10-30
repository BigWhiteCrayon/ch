import { afterEach, describe, expect, it } from 'vitest';
import { bySophistication, resolveSophistication, setOverrides } from '../../src/llm/sophistication';

afterEach(() => setOverrides({}));

describe('resolveSophistication', () => {
  it.each([
    ['claude-fable-5-1', 5],
    ['claude-mythos-5-1', 5],
    ['claude-opus-5-5', 4],
    ['claude-sonnet-5-5', 3],
    ['claude-haiku-4-5', 2],
    ['claude-something-new', 3],
  ])('rates the Anthropic model %s as %i', (id, level) => {
    expect(resolveSophistication('anthropic', id)).toBe(level);
  });

  it.each([
    ['gpt-x-nano', 1],
    ['gpt-x-mini', 2],
    ['gpt-3.5-turbo', 2],
    ['gpt-x-pro', 5],
    ['gpt-x', 4],
  ])('rates the OpenAI model %s as %i', (id, level) => {
    expect(resolveSophistication('openai', id)).toBe(level);
  });

  it('checks OpenAI patterns in order, so a small "pro" variant stays small', () => {
    expect(resolveSophistication('openai', 'gpt-x-pro-mini')).toBe(2);
  });

  it.each([
    ['llama3.2:3b', 0], // under 5B: original default 1 - 1
    ['phi:2.7b', 0], // under 5B: original default 1 - 1
    ['mistral:7b', 1], // 5B to under 30B: original default 2 - 1
    ['qwen2.5:14b', 1], // 5B to under 30B: original default 2 - 1
    ['qwen2.5-coder:32b', 2], // 30B and up: original default 3 - 1
    ['llama3.1:70b', 2], // 30B and up: original default 3 - 1
  ])('estimates the local model %s as one level below its original default', (id, level) => {
    expect(resolveSophistication('local', id)).toBe(level);
  });

  it('rates a local model with no size in its name as 0 (original default 1 - 1)', () => {
    expect(resolveSophistication('local', 'mistral:latest')).toBe(0);
  });

  it('treats an unknown provider like a local one', () => {
    expect(resolveSophistication('lmstudio', 'big-model:40b')).toBe(2); // 30B and up
    expect(resolveSophistication('lmstudio', 'tiny-model')).toBe(0); // no size in the name
  });

  it('lets a manual level win over the rules, only for that exact model', () => {
    setOverrides({ 'local/llama3.2:3b': 5, 'anthropic/claude-opus-5-5': 1 });
    expect(resolveSophistication('local', 'llama3.2:3b')).toBe(5);
    expect(resolveSophistication('anthropic', 'claude-opus-5-5')).toBe(1);
    // Other providers unchanged
    expect(resolveSophistication('openai', 'llama3.2:3b')).toBe(4);
  });

  it('lets a manual level of 0 win over the rules', () => {
    setOverrides({ 'local/qwen2.5-coder:32b': 0 });
    expect(resolveSophistication('local', 'qwen2.5-coder:32b')).toBe(0);
  });

  it('goes back to the rules after overrides are cleared', () => {
    setOverrides({ 'local/qwen2.5-coder:32b': 5 });
    setOverrides(undefined);
    expect(resolveSophistication('local', 'qwen2.5-coder:32b')).toBe(2);
  });
});

describe('bySophistication', () => {
  it('sorts the most sophisticated first', () => {
    const sorted = [{ sophistication: 2 }, { sophistication: 5 }, { sophistication: 3 }].sort(bySophistication);
    expect(sorted.map((m) => m.sophistication)).toEqual([5, 3, 2]);
  });
});
