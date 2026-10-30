import { describe, expect, it } from 'vitest';
import { MAX_TASKS, TOOL_NAME, prompt } from '../../src/subagents';
import { SOPHISTICATION } from '../../src/llm/sophistication';
import { breakdown, cases, grade, sharedFiles, suite, systemPrompt } from '../../evals/subagents';
import type { Output } from '../../evals/subagents';
import type { ToolCall } from '../../src/types';

// A breakdown as the model would have asked for it
const piece = (name: string, task: string, kind = 'worker') => ({ name, task, kind });
// Long enough to be saying where to look and what to report, as a real one is
const real = (what: string) => `${what}. Look through the files under src/ and report what you find, in full.`;
const handed = (...tasks: { name: string; task: string; kind: string }[]): Output => ({ tasks });

const marks = (got: Output, expected: Parameters<typeof grade>[1]) =>
  Object.fromEntries(grade(got, expected).map((mark) => [mark.field, mark.ok]));

describe('what the model is working under', () => {
  it('tells it how to break work up, since that is what is being judged', () => {
    expect(systemPrompt(true)).toContain(TOOL_NAME);
    // The app's own instructions, word for word, rather than a copy of them
    // that could drift: what is judged here is what the app really says
    expect(systemPrompt(true)).toContain(prompt(SOPHISTICATION.STRONG));
  });

  it('says there is a workspace only when the case has one', () => {
    expect(systemPrompt(true)).toContain('workspace');
    expect(systemPrompt(false)).not.toContain('started this thread in the workspace');
  });
});

describe('reading the breakdown out of what the model did', () => {
  const call = (input: unknown): ToolCall => ({ id: 'c1', name: TOOL_NAME, input: input as ToolCall['input'] });

  it('takes the pieces, with the kind each was given', () => {
    const got = breakdown([call({ tasks: [{ name: 'one', task: real('Find the parser'), kind: 'explorer' }] })], '');
    expect(got.tasks).toEqual([{ name: 'one', task: real('Find the parser'), kind: 'explorer' }]);
    expect(got.why).toBeUndefined();
  });

  it('gives a piece the ordinary kind when none was asked for', () => {
    const got = breakdown([call({ tasks: [{ name: 'one', task: real('Check it') }] })], '');
    expect(got.tasks[0].kind).toBe('worker');
  });

  it('counts an answer with no tool call as the job kept whole, which is sometimes right', () => {
    const got = breakdown([], 'I will do this myself, since each part needs the one before it.');
    expect(got).toMatchObject({ tasks: [], kept: 'answered' });
    expect(got.why).toBeUndefined();
  });

  it('counts starting the work with another tool as the job kept whole', () => {
    // Doing it yourself is what keeping a job whole looks like when there are
    // tools to do it with, and it is the right answer for half these cases
    const got = breakdown([{ id: 'c1', name: 'read_file', input: { path: 'src/parser.ts' } }], '');
    expect(got).toMatchObject({ tasks: [], kept: 'began it with read_file' });
    expect(got.why).toBeUndefined();
  });

  it('is not fooled into reading a reply that said nothing at all as a job kept whole', () => {
    expect(breakdown([], '  ').why).toBe('wrote nothing and called nothing');
  });

  it('counts a call the app itself would reject as a breakdown that did not happen', () => {
    // The app's own reader decides this, so the suite cannot drift from it
    expect(breakdown([call({ tasks: [] })], '').why).toMatch(/unusable tasks/);
    expect(breakdown([call({ tasks: [{ name: 'one' }] })], '').why).toMatch(/no "task" to do/);
    expect(breakdown([call({ tasks: [{ name: 'one', task: 'x', kind: 'wizard' }] })], '').why).toMatch(/wizard/);
  });
});

describe('judging a job that should be handed out', () => {
  const wanted = { split: true, tasks: [2, 4] as const, kinds: ['coder', 'explorer'] as const };
  const good = handed(piece('a', real('Change src/a.ts'), 'coder'), piece('b', real('Change src/b.ts'), 'coder'));

  it('passes a breakdown that is independent, well addressed and stands on its own', () => {
    expect(marks(good, wanted)).toEqual({ split: true, tasks: true, kinds: true, standalone: true, distinct: true });
  });

  it('fails it for being kept whole, and judges nothing else: there are no pieces to judge', () => {
    expect(marks({ tasks: [] }, wanted)).toEqual({ split: false });
  });

  it('fails a piece that points back at a conversation its subagent cannot see', () => {
    for (const pointing of [
      'Make the same change as we discussed, across the module and its tests.',
      'Do this for the other files, like the first one, and report what changed.',
      'Apply the approach described above to the remaining handlers in src/.',
    ]) {
      const got = handed(piece('a', real('Change src/a.ts'), 'coder'), piece('b', pointing, 'coder'));
      expect(marks(got, wanted).standalone).toBe(false);
    }
  });

  it('fails a piece too short to say where to look or what to bring back', () => {
    const got = handed(piece('a', real('Change src/a.ts'), 'coder'), piece('b', 'Fix the parser.', 'coder'));
    expect(marks(got, wanted).standalone).toBe(false);
  });

  it('fails two coders given the same file, which is the failure that loses work', () => {
    const got = handed(
      piece('a', real('Add error handling to src/parser.ts'), 'coder'),
      piece('b', real('Add a test beside src/parser.ts'), 'coder')
    );
    expect(marks(got, wanted).distinct).toBe(false);
  });

  it('allows two explorers the same file, since reading one twice costs only time', () => {
    const got = handed(
      piece('a', real('Work out what src/parser.ts does'), 'explorer'),
      piece('b', real('Work out who calls src/parser.ts'), 'explorer')
    );
    expect(marks(got, wanted).distinct).toBe(true);
  });

  it('fails a kind that cannot do the piece', () => {
    const got = handed(piece('a', real('Change src/a.ts'), 'coder'), piece('b', real('Change src/b.ts'), 'worker'));
    expect(marks(got, wanted).kinds).toBe(false);
  });

  it('fails a job cut into one piece, or into more than may be handed out', () => {
    expect(marks(handed(piece('a', real('Change src/a.ts'), 'coder')), wanted).tasks).toBe(false);
    const many = Array.from({ length: 5 }, (_, i) => piece(`t${i}`, real(`Change src/${i}.ts`), 'coder'));
    expect(marks(handed(...many), wanted).tasks).toBe(false);
  });
});

describe('judging a job that should stay whole', () => {
  it('passes it for being kept whole, and asks nothing else of it', () => {
    expect(marks({ tasks: [] }, { split: false })).toEqual({ split: true });
  });

  it('fails it for being handed out, however good the pieces look', () => {
    const got = handed(piece('a', real('Change src/a.ts'), 'coder'), piece('b', real('Change src/b.ts'), 'coder'));
    expect(marks(got, { split: false })).toEqual({ split: false });
  });

  it('fails a reply that neither answered nor handed anything out', () => {
    expect(marks({ tasks: [], why: 'wrote nothing and called nothing' }, { split: false }).split).toBe(false);
  });
});

describe('files named in more than one piece', () => {
  it('finds a file two pieces both name, and ignores one only a single piece names', () => {
    expect(sharedFiles(['edit src/a.ts', 'edit src/a.ts and src/b.ts'])).toEqual(['src/a.ts']);
    expect(sharedFiles(['edit src/a.ts', 'edit src/b.ts'])).toEqual([]);
  });

  it('counts a file named twice in one piece as named once', () => {
    expect(sharedFiles(['edit src/a.ts, then test src/a.ts', 'edit src/b.ts'])).toEqual([]);
  });
});

describe('the cases', () => {
  it('judges both splitting and keeping whole, so neither habit can pass by itself', () => {
    // Grading a breakdown that handed nothing out says which the case wanted:
    // the case is content iff it wanted the job kept whole
    const scored = cases.filter((one) => !one.ambiguous);
    const wantsWhole = scored.filter((one) => one.grade({ tasks: [] })[0].ok);
    expect(wantsWhole.length).toBeGreaterThan(1);
    expect(scored.length - wantsWhole.length).toBeGreaterThan(1);
  });

  it('gives every case a grader and a name of its own', () => {
    expect(new Set(cases.map((one) => one.name)).size).toBe(cases.length);
    expect(cases.every((one) => typeof one.grade === 'function')).toBe(true);
  });

  it('never asks for more pieces than may be handed out at once', () => {
    for (const one of cases) {
      const many = Array.from({ length: MAX_TASKS }, (_, i) => piece(`t${i}`, real(`Change src/${i}.ts`), 'explorer'));
      // A breakdown of exactly MAX_TASKS is never failed for its size
      const size = one.grade(handed(...many)).find((mark) => mark.field === 'tasks');
      if (size) expect(size.ok).toBe(true);
    }
  });

  it('is the suite the runner offers', () => {
    expect(suite.name).toBe('subagents');
    expect(suite.cases).toBe(cases);
  });
});
