import { describe, expect, it } from 'vitest';
import * as project from '../../src/harness/project';
import * as sandbox from '../../src/sandbox';
import { cases, grade, history, missing, suite, systemPrompt, written } from '../../evals/context';
import type { Expected, Output } from '../../evals/context';
import type { ToolCall } from '../../src/types';

const NOTE = 'It is a TypeScript Electron app.';
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, input });
const wrote = (tool: string, content = 'what it found out'): Output => written([call(tool, { content })], '') as Output;
const marks = (got: Output, expected: Expected) =>
  Object.fromEntries(grade(got, expected).map((mark) => [mark.field, mark.ok]));
const got = (output: Output, expected: Expected, field: string) =>
  grade(output, expected).find((mark) => mark.field === field)?.got;

describe('what the model is working under', () => {
  it('is what the app really tells a thread about its two notes, not a copy of it', () => {
    const prompt = systemPrompt(NOTE);
    expect(prompt).toContain(sandbox.PROMPT);
    expect(prompt).toContain(project.prompt(NOTE, true));
    expect(prompt).toContain(NOTE);
  });

  it('says there is a workspace, since every case is in one', () => {
    expect(systemPrompt(NOTE)).toContain(sandbox.workspacePrompt('/projects/demo'));
  });

  it('offers the note tools by their real names, so a case cannot drift from the app', () => {
    const prompt = systemPrompt(NOTE);
    expect(prompt).toContain('save_context');
    expect(prompt).toContain('update_workspace_context');
  });
});

describe('the work the model is handed', () => {
  const input = {
    request: 'make the tests pass',
    found: [
      { name: 'run_command', input: { command: 'npm test' }, output: 'vitest: not found', isError: true },
      { name: 'run_command', input: { command: 'npm ci' }, output: 'added 412 packages' },
    ],
  };

  it('is the request, then every call it made and what came back', () => {
    expect(history(input)).toEqual([
      { role: 'user', content: 'make the tests pass' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_command', input: { command: 'npm test' } }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'run_command', content: 'vitest: not found', isError: true },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'run_command', input: { command: 'npm ci' } }] },
      { role: 'tool', toolCallId: 'c2', name: 'run_command', content: 'added 412 packages', isError: false },
    ]);
  });

  it('leaves the last result last, which is the thing just found out', () => {
    expect(history(input).at(-1)).toMatchObject({ content: 'added 412 packages' });
  });
});

describe('reading what the model did next', () => {
  it('tells the thread’s note from the workspace’s, whichever tool wrote it', () => {
    expect(wrote('save_context').wrote).toEqual([
      { where: 'thread', tool: 'save_context', content: 'what it found out' },
    ]);
    expect(wrote('update_workspace_context').wrote[0].where).toBe('workspace');
    expect(wrote('add_to_workspace_context').wrote[0].where).toBe('workspace');
  });

  it('counts carrying on with the work as writing nothing, and says what it did', () => {
    const output = written([call('read_file', { path: 'src/a.ts' }), call('edit_file')], '');
    expect(output.wrote).toEqual([]);
    expect(output.did).toEqual(['read_file', 'edit_file']);
  });

  it('notices a reply written instead, and a note written alongside the work', () => {
    expect(written([], 'The tests pass now.').answered).toBe(true);
    const both = written([call('edit_file'), call('save_context', { content: 'half done' })], '');
    expect(both.did).toEqual(['edit_file']);
    expect(both.wrote).toHaveLength(1);
  });

  it('keeps a note that was written with nothing in it, so the grading can see it', () => {
    expect(written([call('save_context', { content: 42 })], '').wrote[0].content).toBe('');
  });
});

describe('whether what it wrote names what it learned', () => {
  it('takes any of the spellings offered, whatever the case', () => {
    expect(missing('Run NPM CI first', [['npm ci', 'npm install']])).toEqual([]);
    expect(missing('run npm install first', [['npm ci', 'npm install']])).toEqual([]);
  });

  it('reports what is absent by its first spelling', () => {
    expect(missing('ran vitest directly instead', [['npm ci'], ['vitest']])).toEqual(['npm ci']);
    expect(missing('looked into it', [['npm ci'], ['vitest']])).toEqual(['npm ci', 'vitest']);
  });
});

describe('the marks', () => {
  const needsNote: Expected = { write: true, where: ['thread'], keeps: [['npm ci']] };

  it('is right about writing when a note was wanted and one was written', () => {
    expect(marks(wrote('save_context', 'run npm ci first'), needsNote)).toEqual({
      wrote: true,
      where: true,
      keeps: true,
    });
  });

  it('says what it did instead when it wrote nothing', () => {
    const output = written([call('edit_file')], '');
    expect(marks(output, needsNote).wrote).toBe(false);
    expect(got(output, needsNote, 'wrote')).toBe('nothing, ran edit_file');
    expect(got(written([], 'All done.'), needsNote, 'wrote')).toBe('nothing, answered');
  });

  it('fails a note put in the wrong place, and allows a case that takes either', () => {
    expect(marks(wrote('update_workspace_context', 'npm ci'), needsNote).where).toBe(false);
    const either: Expected = { write: true, where: ['thread', 'thread+workspace'] };
    expect(marks(wrote('save_context'), either).where).toBe(true);
    const bothWritten = written(
      [call('save_context', { content: 'x' }), call('add_to_workspace_context', { content: 'y' })],
      ''
    );
    expect(marks(bothWritten, either).where).toBe(true);
    expect(got(bothWritten, either, 'where')).toBe('thread+workspace');
  });

  it('fails a note that says nothing it found out', () => {
    const vague = wrote('save_context', 'Looked into the test setup and made progress.');
    expect(marks(vague, needsNote).keeps).toBe(false);
    expect(got(vague, needsNote, 'keeps')).toBe('no mention of npm ci');
  });

  it('judges what was kept only where the note was replaced, not added to', () => {
    const expected: Expected = { write: true, where: ['workspace'], whole: 'src/main.ts' };
    expect(marks(wrote('update_workspace_context', 'search is local now'), expected).whole).toBe(false);
    expect(marks(wrote('update_workspace_context', 'src/main.ts starts it; search is local now'), expected).whole).toBe(
      true
    );
    // Adding to the note cannot lose what it said, so there is nothing to judge
    expect(marks(wrote('add_to_workspace_context', 'search is local now'), expected).whole).toBeUndefined();
  });

  it('wants no note where there was nothing to learn, and only judges that', () => {
    expect(marks(written([call('run_command')], 'Deleted it.'), { write: false })).toEqual({ wrote: true });
    expect(marks(wrote('save_context'), { write: false })).toEqual({ wrote: false });
  });

  it('counts a model that failed outright as a miss, with the reason', () => {
    const failed: Output = { wrote: [], did: [], answered: false, why: 'rate limited' };
    expect(grade(failed, needsNote)).toEqual([{ field: 'wrote', wanted: 'a note', got: 'rate limited', ok: false }]);
  });
});

describe('the cases', () => {
  // Each case graded against a run that wrote nothing: the ones that want a
  // note fail it, and the one that wants none passes
  it('are all but one about writing, and that one is about not writing', () => {
    const quiet = written([call('read_file', { path: 'src/a.ts' })], '');
    const wantsNote = cases.filter((one) => !one.grade(quiet)[0].ok);
    expect(wantsNote).toHaveLength(cases.length - 1);
    // Without that one, a model that writes a note after every tool call would
    // score full marks here
    expect(cases.filter((one) => one.grade(quiet)[0].ok).map((one) => one.name)).toEqual([
      'nothing was found out, so there is nothing to write',
    ]);
  });

  it('ask for a note that names what was found out, not one that says it looked', () => {
    const vague = 'Investigated and made progress.';
    const vacuous = written(
      [call('save_context', { content: vague }), call('add_to_workspace_context', { content: vague })],
      ''
    );
    for (const one of cases) {
      const graded = one.grade(vacuous);
      // The case that wants no note has nothing to say about what is in one
      if (graded[0].wanted === 'no note') continue;
      expect(graded.some((mark) => mark.field === 'keeps' && !mark.ok)).toBe(true);
    }
  });

  it('judges one model at a time, since whether a model writes notes is the model’s doing', () => {
    expect(suite.perModel).toBe(true);
    expect(suite.name).toBe('context');
  });

  it('name the note each is about, so a run can be read without the file', () => {
    for (const one of cases) {
      expect(one.name).toMatch(/^(thread|workspace|nothing)/);
    }
  });
});
