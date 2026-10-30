import { describe, expect, it } from 'vitest';
import { embeddable, isBoundary, split } from '../../src/search/chunks';

// A function of the given length, as a top-level declaration
const fn = (name: string, body = 100) => `function ${name}() {\n  ${'x'.repeat(body)}\n}`;
const linesOf = (text: string) => text.split('\n');

describe('where a piece may end', () => {
  it.each([
    ['function parse() {', true],
    ['export const FILE = 1;', true],
    ['class Parser {', true],
    ['# a python comment', true],
    ['}', false],
    [')', false],
    ['  }', false],
    ['  const inside = 1;', false],
    ['\tconst tabbed = 1;', false],
    ['', false],
    ['   ', false],
  ])('reads %j as %j', (line, expected) => {
    expect(isBoundary(line)).toBe(expected);
  });
});

describe('splitting a file', () => {
  it('gives nothing for a file with nothing in it', () => {
    expect(split('')).toEqual([]);
    expect(split('\n\n  \n')).toEqual([]);
  });

  it('keeps a short file whole, numbered from its first line', () => {
    const text = 'const a = 1;\nconst b = 2;\n';
    expect(split(text)).toEqual([{ start: 1, end: 2, text: 'const a = 1;\nconst b = 2;' }]);
  });

  it('cuts a long file into pieces that each know their lines', () => {
    const text = Array.from({ length: 20 }, (_, i) => fn(`f${i}`)).join('\n');
    const chunks = split(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Every piece names lines that are really in the file
    const all = linesOf(text);
    for (const chunk of chunks) {
      expect(chunk.start).toBeGreaterThanOrEqual(1);
      expect(chunk.end).toBeLessThanOrEqual(all.length);
      expect(chunk.text).toBe(all.slice(chunk.start - 1, chunk.end).join('\n'));
    }
  });

  it('cuts where something new begins, not in the middle of it', () => {
    const text = Array.from({ length: 20 }, (_, i) => fn(`f${i}`)).join('\n');
    for (const chunk of split(text).slice(1)) {
      // Each piece after the first starts on a line that begins something,
      // allowing for the lines repeated from the piece before
      const first = linesOf(chunk.text).find((line) => line.trim());
      expect(first).toBeDefined();
      expect(/^(function|})/.test(first as string)).toBe(true);
    }
  });

  it('repeats a few lines, so a match across a join is not lost from both sides', () => {
    const text = Array.from({ length: 20 }, (_, i) => fn(`f${i}`)).join('\n');
    const chunks = split(text);
    const [first, second] = chunks;
    expect(second.start).toBeLessThanOrEqual(first.end);
    expect(second.start).toBeGreaterThan(first.start);
  });

  it('covers every line of the file between them', () => {
    const text = Array.from({ length: 20 }, (_, i) => fn(`f${i}`)).join('\n');
    const chunks = split(text);
    const covered = new Set<number>();
    for (const chunk of chunks) for (let line = chunk.start; line <= chunk.end; line++) covered.add(line);
    expect(covered.size).toBe(linesOf(text).length);
  });

  it('cuts a file with nowhere good to cut rather than keeping it whole', () => {
    // One enormous line, as a minified file or a data blob is
    const chunks = split(`const data = "${'y'.repeat(20000)}";\n`);
    expect(chunks).toHaveLength(1);
    // ...and one made of indented lines alone, which offer no boundary
    const indented = Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const many = split(indented);
    expect(many.length).toBeGreaterThan(1);
    for (const chunk of many) expect(chunk.text.length).toBeLessThanOrEqual(3100);
  });

  it('leaves out a piece that is only whitespace', () => {
    const text = `${fn('first')}\n${'\n'.repeat(50)}\n${fn('second')}`;
    for (const chunk of split(text)) expect(chunk.text.trim()).not.toBe('');
  });
});

describe('what gets embedded', () => {
  it('puts the path in front of the lines, so a query can match on it', () => {
    expect(embeddable('src/search/embeddings.ts', { start: 1, end: 1, text: 'const a = 1;' })).toBe(
      'src/search/embeddings.ts\n\nconst a = 1;'
    );
  });
});
