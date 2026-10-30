import { describe, expect, it, vi } from 'vitest';
import { MAX_OPTIONS, cleanOptions, tool } from '../../src/tools/ask';
import type { ToolContext } from '../../src/types';

const context = (ask?: ToolContext['ask']): ToolContext => ({
  signal: new AbortController().signal,
  threadId: 'thread',
  ask,
});

describe('cleanOptions', () => {
  it('is empty where there are none', () => {
    expect(cleanOptions(undefined)).toEqual([]);
  });

  it('trims, drops blanks and repeats', () => {
    expect(cleanOptions([' A ', '', 'B', 'A', '  '])).toEqual(['A', 'B']);
  });

  it('keeps no more than there is room for', () => {
    const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, i) => `option ${i}`);
    expect(cleanOptions(many)).toEqual(many.slice(0, MAX_OPTIONS));
  });

  it('refuses what is not a list of strings', () => {
    expect(() => cleanOptions('A')).toThrow('"options" must be a list of strings.');
    expect(() => cleanOptions(['A', 2])).toThrow('"options" must be a list of strings.');
  });
});

describe('ask_user', () => {
  it('puts the question and the options to the user and returns what they said', async () => {
    const ask = vi.fn().mockResolvedValue('the second');
    const result = await tool.run({ question: ' Which? ', options: ['first', ' ', 'second'] }, context(ask));
    expect(ask).toHaveBeenCalledWith('Which?', ['first', 'second']);
    expect(result).toBe('The user answered: the second');
  });

  it('asks without options', async () => {
    const ask = vi.fn().mockResolvedValue('whatever');
    await tool.run({ question: 'Anything?' }, context(ask));
    expect(ask).toHaveBeenCalledWith('Anything?', []);
  });

  it('wants a question', async () => {
    const ask = vi.fn();
    await expect(tool.run({}, context(ask))).rejects.toThrow('"question" must be a non-empty string.');
    await expect(tool.run({ question: '  ' }, context(ask))).rejects.toThrow('non-empty');
    expect(ask).not.toHaveBeenCalled();
  });

  it('says so where there is nobody to ask', async () => {
    await expect(tool.run({ question: 'Which?' }, context())).rejects.toThrow('There is nobody to ask here.');
  });

  it('passes on a question that went unanswered', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('The reply was stopped before the user answered.'));
    await expect(tool.run({ question: 'Which?' }, context(ask))).rejects.toThrow('stopped');
  });
});
