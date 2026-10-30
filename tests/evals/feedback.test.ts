import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { casesFrom, grade, name, read, unreplayable, type Verdict } from '../../evals/feedback';
import type { Classification } from '../../src/types';

let dir: string;
const write = (...lines: string[]): string => {
  const file = path.join(dir, 'verdicts.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
};

const rated: Classification = {
  sophistication: 4,
  effort: 'high',
  category: 'coding',
  model: 'llama3.2:3b',
};
const turns = [{ role: 'user' as const, content: 'can you include the screenshots?' }];
const verdict = (more: Partial<Verdict> = {}): Verdict => ({
  rating: 'bad',
  request: 'can you include the screenshots?',
  classification: rated,
  messages: turns,
  ...more,
});
const got = (more: Partial<Extract<Classification, { sophistication: number }>> = {}): Classification => ({
  sophistication: 2,
  effort: 'medium',
  category: 'coding',
  ...more,
});
const marks = (output: Classification, one: Verdict) =>
  grade(output, one).map((m) => `${m.field} ${m.ok ? 'ok' : `wanted ${m.wanted}, got ${m.got}`}`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-verdicts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading the app record', () => {
  it('reads one verdict per line', () => {
    const file = write(JSON.stringify(verdict()), JSON.stringify(verdict({ rating: 'good' })));
    expect(read(file).map((v) => v.rating)).toEqual(['bad', 'good']);
  });

  it('skips a line it cannot read, the file being appended to by a running app', () => {
    const file = write(JSON.stringify(verdict()), '{"rating":"bad","req', '', JSON.stringify(verdict()));
    expect(read(file)).toHaveLength(2);
  });

  it('is empty rather than failing when there is no record at all', () => {
    expect(read(path.join(dir, 'nothing.jsonl'))).toEqual([]);
  });
});

describe('what a verdict can be judged on', () => {
  it('scores one that kept its conversation', () => {
    expect(unreplayable(verdict())).toBeUndefined();
  });

  it('will not score one recorded before the conversation was kept', () => {
    // Replaying a message without its turns rates it lower than it was rated
    // in the app, which would read as the prompt having improved
    expect(unreplayable(verdict({ messages: undefined }))).toMatch(/without the turns/);
  });

  it('will not score one the app never managed to rate', () => {
    const failed = { failed: true as const, reason: 'no models' };
    expect(unreplayable(verdict({ classification: failed }))).toMatch(/never managed to rate/);
  });
});

describe('grading against a verdict', () => {
  it('asks a too_high rating to come down, and nothing else', () => {
    const one = verdict({ problems: ['too_high'] });
    expect(marks(got({ sophistication: 2 }), one)).toEqual(['sophistication ok']);
    expect(marks(got({ sophistication: 4 }), one)).toEqual(['sophistication wanted below 4, got 4']);
    expect(marks(got({ sophistication: 5 }), one)).toEqual(['sophistication wanted below 4, got 5']);
  });

  it('asks a too_low rating to come up', () => {
    const one = verdict({ problems: ['too_low'], classification: { ...rated, sophistication: 2 } });
    expect(marks(got({ sophistication: 3 }), one)).toEqual(['sophistication ok']);
    expect(marks(got({ sophistication: 2 }), one)).toEqual(['sophistication wanted above 2, got 2']);
  });

  it('asks a wrong_type rating for any other kind', () => {
    const one = verdict({ problems: ['wrong_type'] });
    expect(marks(got({ category: 'question' }), one)).toEqual(['category ok']);
    expect(marks(got({ category: 'coding' }), one)).toEqual(['category wanted anything but coding, got coding']);
  });

  it('grades both when the rating was too high and the wrong kind', () => {
    const one = verdict({ problems: ['too_high', 'wrong_type'] });
    expect(marks(got({ sophistication: 2, category: 'question' }), one)).toEqual(['sophistication ok', 'category ok']);
    expect(marks(got({ sophistication: 2, category: 'coding' }), one)).toEqual([
      'sophistication ok',
      'category wanted anything but coding, got coding',
    ]);
  });

  it('holds a rating called good where it was, give or take the sampling', () => {
    const one = verdict({ rating: 'good', problems: undefined });
    expect(marks(got({ sophistication: 4 }), one)).toEqual(['sophistication ok', 'category ok']);
    expect(marks(got({ sophistication: 3 }), one)).toEqual(['sophistication ok', 'category ok']);
    expect(marks(got({ sophistication: 2 }), one)).toEqual(['sophistication wanted 4 (±1), got 2', 'category ok']);
    expect(marks(got({ sophistication: 4, category: 'question' }), one)).toEqual([
      'sophistication ok',
      'category wanted coding, got question',
    ]);
  });

  it('reports a bad rating with no problem named rather than passing it', () => {
    expect(marks(got(), verdict({ problems: [] }))).toEqual([
      'verdict wanted what was wrong with it, got bad, with no problem named',
    ]);
  });

  it('fails every field when the classifier could not be read at all', () => {
    const failed = { failed: true as const, reason: 'timed out' };
    expect(marks(failed, verdict({ problems: ['too_high'] }))).toEqual([
      'sophistication wanted to move off 4, got timed out',
    ]);
  });
});

describe('turning verdicts into cases', () => {
  it('names a case by what was wrong, the model rated, and the message', () => {
    expect(name(verdict({ problems: ['too_high'] }), 0)).toBe(
      '1 too_high [llama3.2:3b] can you include the screenshots?'
    );
    expect(name(verdict({ rating: 'good', problems: undefined }), 6)).toContain('7 good');
  });

  it('passes the recorded conversation, workspace and summary to the classifier', () => {
    const [one] = casesFrom([verdict({ workspace: '/projects/demo', summary: 'Earlier: the shots.' })]);
    expect(one.input).toEqual({ messages: turns, workspace: '/projects/demo', summary: 'Earlier: the shots.' });
    expect(one.ambiguous).toBeUndefined();
  });

  it('falls back to the message alone for a verdict with no conversation, but marks it unscored', () => {
    const [one] = casesFrom([verdict({ messages: undefined })]);
    expect(one.input.messages).toEqual([{ role: 'user', content: 'can you include the screenshots?' }]);
    expect(one.ambiguous).toMatch(/without the turns/);
  });
});
