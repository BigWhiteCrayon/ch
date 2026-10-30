import { describe, expect, it } from 'vitest';
import * as project from '../../src/harness/project';
import * as sandbox from '../../src/sandbox';
import { NOTE, USES, answer, cases, grade, lost, missing, searchWorld, suite, systemPrompt } from '../../evals/notes';
import type { Expected, Output, World, Written } from '../../evals/notes';
import type { ToolCall } from '../../src/types';

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, input });
const note = (content: string, step: number, tool = 'save_context'): Written => ({ tool, content, step });
const out = (wrote: Written[], steps: string[][] = [['read_file'], ['save_context']]): Output => ({
  wrote,
  steps,
  answered: true,
});
const marks = (got: Output, expected: Expected) =>
  Object.fromEntries(grade(got, expected).map((mark) => [mark.field, mark.ok]));
const got = (output: Output, expected: Expected, field: string) =>
  grade(output, expected).find((mark) => mark.field === field)?.got;

const expected: Expected = { keeps: [['the cause'], ['embeddings.ts']], notes: [1, 3] };

describe('what the model is working under', () => {
  it('is what the app really tells a workspace thread, not a copy of it', () => {
    const prompt = systemPrompt(NOTE);
    expect(prompt).toContain(sandbox.PROMPT);
    expect(prompt).toContain(sandbox.workspacePrompt('/projects/demo'));
    expect(prompt).toContain(project.prompt(NOTE, true));
  });

  it('gives the model rounds enough to search, read and still write', () => {
    expect(USES.MAX_STEPS).toBeGreaterThanOrEqual(6);
  });
});

describe('the scripted world', () => {
  const world: World = {
    files: {
      'src/a.ts': '1: export function alpha() {}',
      'src/b.ts': '1: export function beta() {}',
    },
    commands: [{ when: 'vitest', output: 'FAIL one test', isError: true }],
  };

  // A search that answers the same thing whatever it is asked teaches a model
  // that searching is pointless, and then the fixture is what gets measured
  it('answers a search from the query, not with a fixed block', () => {
    expect(answer(call('search_workspace', { query: 'where is alpha' }), world).output).toContain('src/a.ts');
    expect(answer(call('search_workspace', { query: 'where is alpha' }), world).output).not.toContain('src/b.ts');
    expect(answer(call('search_workspace', { query: 'where is beta' }), world).output).toContain('src/b.ts');
  });

  it('says so when nothing matches, rather than answering with everything', () => {
    expect(answer(call('search_workspace', { query: 'kubernetes ingress' }), world).output).toBe('No matches.');
  });

  it('ignores the short words of a query, which match everything and say nothing', () => {
    expect(searchWorld('the a of is', world.files)).toBe('No matches.');
  });

  it('lists what is under a path when asked for one', () => {
    expect(answer(call('list_workspace', { path: 'src/a' }), world).output).toBe('src/a.ts');
    expect(answer(call('list_workspace', { path: 'nowhere' }), world).output).toBe('Nothing there.');
  });

  it('returns a file it has, and an error for one it has not', () => {
    expect(answer(call('read_file', { path: 'src/a.ts' }), world)).toEqual({
      output: '1: export function alpha() {}',
      isError: false,
    });
    expect(answer(call('read_file', { path: 'src/nope.ts' }), world)).toMatchObject({ isError: true });
  });

  it('matches a command on what it contains, so flags do not have to be guessed', () => {
    expect(answer(call('run_command', { command: 'npx vitest run tests/' }), world)).toMatchObject({
      output: 'FAIL one test',
      isError: true,
    });
  });

  it('says a command it does not know was not found, rather than pretending it worked', () => {
    expect(answer(call('run_command', { command: 'make build' }), world)).toMatchObject({ isError: true });
  });

  it('accepts a note without comment, so writing one is never what stops a run', () => {
    expect(answer(call('save_context', { content: 'x' }), world)).toEqual({ output: 'Context saved.', isError: false });
    expect(answer(call('add_to_context', { content: 'x' }), world).isError).toBe(false);
    expect(answer(call('add_to_workspace_context', { content: 'x' }), world).isError).toBe(false);
  });

  it('lets a write to a file appear to work, since the run is about the notes', () => {
    expect(answer(call('edit_file', { path: 'src/a.ts' }), world)).toEqual({ output: 'Done.', isError: false });
  });
});

describe('the cases', () => {
  // A case whose world does not hold what the case says must be found in it
  // would mark every model wrong for ever
  it.each(cases.map((one) => [one.name, one] as const))('can be answered from its world: %s', (_name, one) => {
    const { world } = one.input;
    // A fact may be the command that worked as much as anything it printed, so
    // what the world can be asked counts as part of what it holds
    // A path is as findable as anything in a file: the model sees it in a search
    // result or a listing before it ever reads the file
    const everything = [
      ...Object.keys(world.files),
      ...Object.values(world.files),
      ...world.commands.flatMap((c) => [c.when, c.output]),
    ]
      .join('\n')
      .toLowerCase();
    for (const spellings of one.expected.keeps) {
      expect(spellings.some((word) => everything.includes(word.toLowerCase()))).toBe(true);
    }
  });

  it('asks for fewer notes than there are rounds, so writing after every call is not the aim', () => {
    for (const one of cases) expect(one.expected.notes[1]).toBeLessThan(USES.MAX_STEPS);
  });

  // A world of four files is read out in a round, and a model with nothing left
  // to look at loops instead of working
  it('gives each case a project too large to exhaust in a round', () => {
    for (const one of cases) expect(Object.keys(one.input.world.files).length).toBeGreaterThanOrEqual(10);
  });

  it('hides what each case is about among files that are about nothing', () => {
    for (const one of cases) {
      const found = Object.keys(one.input.world.files).filter((path) =>
        one.expected.keeps.some((spellings) => spellings.some((word) => path.includes(word)))
      );
      // Some of the files matter and most of them do not
      expect(found.length).toBeLessThan(Object.keys(one.input.world.files).length / 2);
    }
  });
});

describe('grading', () => {
  it('passes a run that wrote as it went and named what it found', () => {
    const wrote = [note('the cause is in embeddings.ts, line 622', 2)];
    expect(marks(out(wrote, [['read_file'], ['save_context'], ['edit_file']]), expected)).toEqual({
      wrote: true,
      asFound: true,
      keeps: true,
      kept: true,
      notes: true,
    });
  });

  it('fails a run that wrote nothing, and says what it did instead', () => {
    const nothing = out([], [['search_workspace'], ['read_file'], ['edit_file']]);
    expect(marks(nothing, expected)).toEqual({ wrote: false });
    expect(got(nothing, expected, 'wrote')).toContain('search_workspace → read_file → edit_file');
  });

  it('fails a run that saved it all for the last step', () => {
    const late = out([note('the cause is in embeddings.ts', 3)], [['read_file'], ['read_file'], ['save_context']]);
    expect(marks(late, expected)).toMatchObject({ wrote: true, asFound: false, keeps: true });
    expect(got(late, expected, 'asFound')).toContain('only on the last');
  });

  it('fails a note that says it looked rather than what it found', () => {
    const vague = out([note('Investigated the search code and the test setup.', 2)]);
    expect(marks(vague, expected)).toMatchObject({ keeps: false });
    expect(got(vague, expected, 'keeps')).toContain('the cause');
  });

  it('catches a rewrite that dropped what the note already said', () => {
    const first = note('the cause is in embeddings.ts, where the guard on line 622 never fires', 2);
    const second = note('npx vitest is the command that works, not npm test', 4);
    expect(marks(out([first, second]), expected)).toMatchObject({ kept: false });
    expect(got(out([first, second]), expected, 'kept')).toContain('dropped');
  });

  it('holds an append blameless, since it says nothing about the rest of the note', () => {
    const first = note('the cause is in embeddings.ts, where the guard on line 622 never fires', 2);
    const added = note('npx vitest is the command that works', 4, 'add_to_context');
    expect(marks(out([first, added]), expected)).toMatchObject({ kept: true });
  });

  it('counts the steps that wrote, not the notes, so two notes in one step are one step', () => {
    const twice = [note('the cause, embeddings.ts', 2), note('and more about embeddings.ts', 2)];
    expect(got(out(twice), { ...expected, notes: [1, 1] }, 'notes')).toBe('1');
  });

  it('fails a run that wrote after every single call', () => {
    const every = [1, 2, 3, 4, 5].map((step) => note(`step ${step}: the cause in embeddings.ts`, step));
    expect(marks(out(every, [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]), expected)).toMatchObject({ notes: false });
  });

  it('reports a run that never got going, rather than scoring it', () => {
    const broken: Output = { wrote: [], steps: [], answered: false, why: 'qwen did not answer within 300 seconds.' };
    expect(grade(broken, expected)).toEqual([
      { field: 'wrote', wanted: 'notes', got: 'qwen did not answer within 300 seconds.', ok: false },
    ]);
  });
});

describe('what counts as lost', () => {
  it('ignores a short line, which a rewrite may fairly reword', () => {
    expect(lost([note('## Where I am', 1), note('## Progress', 2)])).toEqual([]);
  });

  it('names a long line the rewrite dropped', () => {
    const before = note('the guard on line 622 never fires because "".split returns [""]', 1);
    expect(lost([before, note('something else entirely about the tests', 2)])).toHaveLength(1);
  });

  it('is clean when the rewrite carried the line through', () => {
    const line = 'the guard on line 622 never fires because "".split returns [""]';
    expect(lost([note(line, 1), note(`${line}\nand npx vitest is the command`, 2)])).toEqual([]);
  });
});

describe('naming a fact', () => {
  it('takes any of its spellings', () => {
    expect(missing('npx vitest is what works', [['npx vitest', 'npm ci']])).toEqual([]);
    expect(missing('nothing useful', [['npx vitest', 'npm ci']])).toEqual(['npx vitest']);
  });
});
