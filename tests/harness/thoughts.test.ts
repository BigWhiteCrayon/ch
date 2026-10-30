import { describe, expect, it } from 'vitest';
import { reasoner } from '../../src/harness/thoughts';

// Feeds reasoning through a reasoner in the given pieces, as the thoughts it
// is gathered into
function reason(...pieces: string[]) {
  const r = reasoner();
  return [...pieces.flatMap((piece) => r.reason(piece)), ...r.end()].map((thought) => thought.text);
}

describe('reasoner', () => {
  it('gathers the fragments a model reasons in into whole thoughts', () => {
    expect(reason('The user ', 'wants the capital ', 'of France.')).toEqual(['The user wants the capital of France.']);
  });

  it('passes a paragraph on as soon as it is whole, so that it is read as it is written', () => {
    const r = reasoner();
    expect(r.reason('First, find the file.')).toEqual([]);
    expect(r.reason('\n\nThen read it.')).toEqual([{ type: 'thought', text: 'First, find the file.' }]);
    expect(r.end()).toEqual([{ type: 'thought', text: 'Then read it.' }]);
  });

  it('wraps each thought onto one line, and keeps nothing that is only whitespace', () => {
    expect(reason('  Looking\n  at\tthe code.  ')).toEqual(['Looking at the code.']);
    expect(reason('\n\n   \n\n')).toEqual([]);
    expect(reason('')).toEqual([]);
  });

  it('breaks a long paragraph at the last sentence that ends within the limit', () => {
    const sentence = `${'x'.repeat(98)}. `;
    const [first, second] = reason(sentence.repeat(10));
    // Six whole sentences fit in 600 characters; the rest follow
    expect(first).toBe(sentence.repeat(6).trim());
    expect(second).toBe(sentence.repeat(4).trim());
  });

  it('breaks a long paragraph with no sentence in it at a word, rather than mid-word', () => {
    const [first] = reason(`${'word '.repeat(200)}end`);
    expect(first.length).toBeLessThanOrEqual(600);
    expect(first.endsWith('word')).toBe(true);
  });

  it('breaks reasoning that is one long run of characters wherever the limit falls', () => {
    const [first, second] = reason('y'.repeat(900));
    expect(first).toBe('y'.repeat(600));
    expect(second).toBe('y'.repeat(300));
  });

  it('gathers reasoning however it is split across fragments', () => {
    const whole = 'Looking for the file.\n\nFound it in src.\n\nNow reading it.';
    for (let size = 1; size <= 12; size++) {
      const pieces = whole.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) as string[];
      expect(reason(...pieces)).toEqual(['Looking for the file.', 'Found it in src.', 'Now reading it.']);
    }
  });
});
