import { describe, expect, it, vi } from 'vitest';
import {
  byField,
  line,
  oneOf,
  report,
  run,
  score,
  within,
  type Case,
  type Mark,
  type Suite,
} from '../../evals/harness';
import { parse } from '../../evals/run';
import { DEFAULT_LEVELS } from '../../evals/judges';

// The eval harness itself is ordinary code and is tested as such: the cases
// it runs call real models, but how it marks and counts them does not.

const mark = (field: string, ok: boolean): Mark => ({ field, wanted: 'a', got: ok ? 'a' : 'b', ok });

// A suite over numbers: each case wants the answer to be the number it names
function suiteOf(
  answers: number[],
  cases: { name: string; want: number; ambiguous?: string }[]
): Suite<number, number> {
  const given = [...answers];
  return {
    name: 'demo',
    about: 'what it does',
    setUp: async () => ({
      model: 'test-model',
      run: async () => given.shift() ?? 0,
    }),
    cases: cases.map(({ name, want, ambiguous }): Case<number, number> => ({
      name,
      input: want,
      ambiguous,
      grade: (got) => [within('answer', [want, want], got)],
    })),
  };
}

describe('marking a field', () => {
  it('passes a value the case allows and fails one it does not', () => {
    expect(oneOf('effort', ['low', 'medium'], 'medium')).toEqual({
      field: 'effort',
      wanted: 'low or medium',
      got: 'medium',
      ok: true,
    });
    expect(oneOf('effort', ['low'], 'high')).toMatchObject({ ok: false, wanted: 'low', got: 'high' });
  });

  it('passes a number inside the range, ends included, and fails one outside', () => {
    expect(within('sophistication', [2, 4], 2).ok).toBe(true);
    expect(within('sophistication', [2, 4], 4).ok).toBe(true);
    expect(within('sophistication', [2, 4], 3).ok).toBe(true);
    expect(within('sophistication', [2, 4], 5).ok).toBe(false);
    expect(within('sophistication', [2, 4], 1).ok).toBe(false);
  });

  it('reads a range of one as a single number, and anything unreadable as wrong', () => {
    expect(within('sophistication', [3, 3], 3)).toMatchObject({ wanted: '3', ok: true });
    expect(within('sophistication', [1, 5], undefined)).toMatchObject({ got: 'undefined', ok: false });
    expect(within('sophistication', [1, 5], 'three')).toMatchObject({ got: 'three', ok: false });
  });
});

describe('counting up a run', () => {
  const result = {
    suite: 'demo',
    model: 'm',
    options: { runs: 2 },
    ms: 1000,
    cases: [
      {
        name: 'all right',
        marks: [
          [mark('a', true), mark('b', true)],
          [mark('a', true), mark('b', true)],
        ],
        errors: [],
      },
      {
        name: 'half right',
        marks: [
          [mark('a', true), mark('b', false)],
          [mark('a', true), mark('b', true)],
        ],
        errors: [],
      },
      { name: 'broken', marks: [], errors: ['no model'] },
      { name: 'ambiguous', ambiguous: 'no one answer', marks: [[mark('a', false), mark('b', false)]], errors: [] },
    ],
  };

  it('scores a run as right only when every field of it was right', () => {
    // Four runs that count: two from the first case, two from the second
    expect(score(result)).toEqual({ ok: 3, of: 4, errors: 1 });
  });

  it('leaves the ambiguous cases out of the score, and their fields out of the tallies', () => {
    expect(byField(result)).toEqual([
      { field: 'a', ok: 4, of: 4 },
      { field: 'b', ok: 3, of: 4 },
    ]);
  });

  it('says so in the report when cases were left out, and how long it took', () => {
    const lines = report(result).join('\n');
    expect(lines).toContain('3/4 runs wholly right (75%)');
    expect(lines).toContain('1 could not run');
    expect(lines).toContain('a                100% (4/4)');
    expect(lines).toContain('b                75% (3/4)');
    expect(lines).toContain('1 case(s) left out of the score');
    expect(lines).toContain('took 1s');
  });
});

describe('a case as a line', () => {
  it('marks one that was always right, and says nothing more', () => {
    expect(line({ name: 'tidy', marks: [[mark('a', true)]], errors: [] })).toBe('  ✓ tidy');
  });

  it('marks one that was sometimes right, with the tally and what was wrong', () => {
    const out = line({ name: 'shaky', marks: [[mark('effort', true)], [mark('effort', false)]], errors: [] });
    expect(out).toContain('± 1/2 shaky');
    expect(out).toContain('effort: wanted a, got b');
  });

  it('marks one that was never right', () => {
    expect(line({ name: 'wrong', marks: [[mark('a', false)]], errors: [] })).toContain('✗ wrong');
  });

  it('says the same thing once however many runs went the same way', () => {
    const out = line({ name: 'steady', marks: [[mark('a', false)], [mark('a', false)]], errors: [] });
    expect(out.match(/wanted a, got b/g)).toHaveLength(1);
  });

  it('marks an ambiguous case apart, and says why it is kept', () => {
    const out = line({ name: 'odd', ambiguous: 'could be either', marks: [[mark('a', false)]], errors: [] });
    expect(out).toContain('~ odd');
    expect(out).toContain('no one right answer: could be either');
  });

  it('says what stopped a run that could not happen', () => {
    expect(line({ name: 'broken', marks: [], errors: ['the server went away'] })).toContain(
      'failed: the server went away'
    );
  });
});

describe('running a suite', () => {
  const lines: string[] = [];
  const say = (text: string) => lines.push(text);

  it('runs each case the number of times asked for and reports as it goes', async () => {
    lines.length = 0;
    const suite = suiteOf(
      [1, 1, 2, 9],
      [
        { name: 'first', want: 1 },
        { name: 'second', want: 2 },
      ]
    );
    const result = await run(suite, { runs: 2 }, say);
    expect(result.cases.map((c) => c.marks.length)).toEqual([2, 2]);
    expect(score(result)).toEqual({ ok: 3, of: 4, errors: 0 });
    // The heading names what is being judged and with what
    expect(lines[0]).toContain('demo: what it does');
    expect(lines[1]).toContain('judged with test-model, 2 cases × 2 run(s)');
  });

  it('runs only the cases whose name matches when told to', async () => {
    lines.length = 0;
    const suite = suiteOf(
      [1, 2],
      [
        { name: 'workspace: one', want: 1 },
        { name: 'other', want: 2 },
      ]
    );
    const result = await run(suite, { runs: 1, only: 'workspace' }, say);
    expect(result.cases.map((c) => c.name)).toEqual(['workspace: one']);
  });

  it('keeps going when a case throws, and counts it as unrun', async () => {
    lines.length = 0;
    const suite = suiteOf(
      [],
      [
        { name: 'throws', want: 1 },
        { name: 'fine', want: 0 },
      ]
    );
    suite.setUp = async () => ({
      model: 'm',
      run: async (want: number) => {
        if (want === 1) throw new Error('the model said nothing');
        return 0;
      },
    });
    const result = await run(suite, { runs: 1 }, say);
    expect(result.cases[0].errors).toEqual(['the model said nothing']);
    expect(result.cases[1].marks).toHaveLength(1);
    expect(score(result)).toMatchObject({ errors: 1, ok: 1 });
  });
});

describe('the command line', () => {
  it('runs every suite once by default', () => {
    expect(parse([])).toEqual({
      suites: [],
      runs: 1,
      only: undefined,
      model: undefined,
      levels: DEFAULT_LEVELS,
      strict: false,
    });
  });

  it('takes the suites to run, and the flags', () => {
    expect(
      parse(['classifier', '--runs=5', '--only=workspace', '--model=llama3.2:3b', '--levels=1,3', '--strict'])
    ).toEqual({
      suites: ['classifier'],
      runs: 5,
      only: 'workspace',
      model: 'llama3.2:3b',
      levels: [1, 3],
      strict: true,
    });
  });

  it.each([['--runs=0'], ['--runs=-2'], ['--runs=lots'], ['--runs=']])('reads %s as one run', (arg) => {
    expect(parse([arg]).runs).toBe(1);
  });

  it('keeps a model name that has an equals sign in it', () => {
    expect(parse(['--model=a=b']).model).toBe('a=b');
  });
});
