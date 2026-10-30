import { describe, expect, it } from 'vitest';
import { PROMPT, bits, readable, record } from '../../src/harness/compactor';
import { USES, bare, cases, fenced, grade, kinds, missing, suite } from '../../evals/compaction';
import type { Expected, Output } from '../../evals/compaction';

const out = (notes: string, from = ''): Output => ({ notes, record: from, jobs: 1 });
const marks = (got: Output, expected: Expected) =>
  Object.fromEntries(grade(got, expected).map((mark) => [mark.field, mark.ok]));
const got = (output: Output, expected: Expected, field: string) =>
  grade(output, expected).find((mark) => mark.field === field)?.got;

describe('what the suite is built on', () => {
  it('judges the prompt the app really compacts with, not a copy of it', () => {
    expect(USES.PROMPT).toBe(PROMPT);
  });

  it('splits a record into jobs the way the app does', () => {
    expect(USES.BIT_LENGTH).toBeGreaterThan(0);
    const long = cases.find((one) => one.name.includes('too long for one job'))!;
    const parts = bits(record(long.input.messages));
    expect(parts.length).toBeGreaterThan(1);
  });
});

describe('the cases', () => {
  // A case that asks for a line the record never had would mark every model
  // wrong for ever, and the suite would look like a failing prompt
  it.each(cases.map((one) => [one.name, one] as const))('can be answered at all: %s', (_name, one) => {
    const text = [one.input.carried ?? '', ...record(one.input.messages)].join('\n\n');
    const lines = new Set(text.split('\n').map(bare));
    for (const wanted of one.expected.keepsCode ?? []) expect(lines).toContain(bare(wanted));
    for (const glanced of one.expected.dropsCode ?? []) expect(lines).toContain(bare(glanced));
    for (const number of one.expected.keepsLines ?? []) expect(text).toMatch(new RegExp(`\\b${number}\\b`));
    for (const spellings of one.expected.facts ?? []) {
      expect(spellings.some((word) => text.toLowerCase().includes(word.toLowerCase()))).toBe(true);
    }
  });

  // The failure this suite missed was one of length: at ten thousand
  // characters the prompt is read as "choose the code that matters", and at
  // sixty thousand the same prompt is read as "copy the record out". A suite
  // of short cases cannot tell the two apart, and scored full marks on the job
  // that ran a thread's window out.
  it('includes a case the length of a record a job really reads', () => {
    const lengths = cases.map((one) => [one.input.carried ?? '', ...record(one.input.messages)].join('\n\n').length);
    const longest = Math.max(...lengths);
    expect(longest).toBeGreaterThan(40000);
    // ...and still one job's worth, since a case split over two would be
    // measuring something else again
    expect(longest).toBeLessThanOrEqual(readable(32768));
  });

  it('includes cases that expect code to be left out, so fencing everything cannot pass', () => {
    const honest = cases.filter((one) => {
      const everything = out('```\n' + record(one.input.messages).join('\n') + '\n```');
      return grade(everything, { shorter: [0, 0.5] }).some((mark) => !mark.ok);
    });
    expect(honest.length).toBeGreaterThan(0);
  });

  it('runs once per model, since this is a prompt small models find hard', () => {
    expect(suite.perModel).toBe(true);
    expect(suite.name).toBe('compaction');
  });
});

describe('reading the notes', () => {
  it('takes the lines out of each fenced block, without their line numbers', () => {
    const notes = 'src/a.ts\n```ts\n620: const x = 1;\n621:   return x;\n```\nand some prose';
    expect(fenced(notes)).toEqual([['const x = 1;', 'return x;']]);
  });

  it('keeps the blocks apart, since each is judged on its own', () => {
    expect(fenced('```\n1: a;\n```\nprose\n```\n2: b;\n```')).toEqual([['a;'], ['b;']]);
  });

  it('copes with a fence the model never closed', () => {
    expect(fenced('```ts\n1: const x = 1;')).toEqual([['const x = 1;']]);
  });

  it('finds nothing in notes that are all prose', () => {
    expect(fenced('It reads the file and returns the lines.')).toEqual([]);
  });

  it('tells a quotation with a stray line from a fence that is not a quotation at all', () => {
    const from = new Set(['const x = 1;', 'return x;']);
    // Mostly the record's own lines, with one the model wrote itself
    const quoted = kinds('```\nconst x = 1;\nreturn x;\nreturn y;\n```', from);
    expect(quoted).toEqual({ strays: ['return y;'], notQuotes: 0 });
    // Nothing of the record in it: prose dressed as code
    const prose = kinds('```\n- Looked for: the function pick\n- Found: it in embeddings.ts\n```', from);
    expect(prose).toEqual({ strays: [], notQuotes: 1 });
  });

  it('strips the line number however the record wrote it', () => {
    expect(bare('620: const x = 1;')).toBe('const x = 1;');
    expect(bare('  620| const x = 1;')).toBe('const x = 1;');
    expect(bare('const x = 1;')).toBe('const x = 1;');
  });

  it('names a fact under any of its spellings', () => {
    expect(missing('node v16.20.2 is too old', [['v16.20.2', '16.20']])).toEqual([]);
    expect(missing('the build failed', [['TS2353']])).toEqual(['TS2353']);
  });
});

describe('grading', () => {
  const CODE = 'export function pick(hit: Hit): Line[] {';
  const expected: Expected = {
    keepsCode: [CODE],
    keepsLines: ['620'],
    facts: [['src/search/embeddings.ts']],
    shorter: [0.1, 0.9],
  };
  const RECORD = `Result of read_file:\n620: ${CODE}\n621:   return [];`;

  it('passes notes that carry the code, its line numbers and the facts', () => {
    const notes = `src/search/embeddings.ts, being changed:\n\`\`\`ts\n620: ${CODE}\n\`\`\`\nIt returns no lines yet.`;
    expect(marks(out(notes, RECORD + 'x'.repeat(200)), expected)).toEqual({
      code: true,
      lines: true,
      facts: true,
      invented: true,
      fences: true,
      shorter: true,
    });
  });

  it('separates code the model wrote itself from prose it put in a fence', () => {
    const stray = `\`\`\`ts\n620: ${CODE}\n621:   return hit.lines.map(toLine);\n\`\`\``;
    expect(marks(out(stray, RECORD + 'x'.repeat(200)), expected)).toMatchObject({
      invented: false,
      fences: true,
    });
    const dressed = '```\n- Looked at the file\n- Ran the tests\n```';
    expect(marks(out(dressed, RECORD + 'x'.repeat(200)), { shorter: [0, 1] })).toMatchObject({
      invented: true,
      fences: false,
    });
  });

  it('fails the code when it was described instead of quoted', () => {
    const notes = 'src/search/embeddings.ts: pick() takes a hit and returns an array of lines. Line 620.';
    const result = marks(out(notes, RECORD + 'x'.repeat(200)), expected);
    expect(result.code).toBe(false);
    // The facts and the line number can still be right, which is the point of
    // grading field by field
    expect(result.facts).toBe(true);
    expect(result.lines).toBe(true);
  });

  it('says which lines were lost, so a near miss reads as one', () => {
    const two = { ...expected, keepsCode: [CODE, 'return [];'] };
    const notes = `\`\`\`ts\n620: ${CODE}\n\`\`\``;
    expect(got(out(notes, RECORD + 'x'.repeat(200)), two, 'code')).toContain('lost 1');
  });

  it('allows the indentation to change but not the line itself', () => {
    const indented = { ...expected, keepsCode: ['  return [];'] };
    expect(marks(out('```\n621: return [];\n```', RECORD + 'x'.repeat(200)), indented).code).toBe(true);
    const altered = { ...expected, keepsCode: ['return []; // nothing yet'] };
    expect(marks(out('```\n621: return [];\n```', RECORD + 'x'.repeat(200)), altered).code).toBe(false);
  });

  it('catches code that was never in the record, which is the shape of a paraphrase', () => {
    const notes = `\`\`\`ts\n620: ${CODE}\n621:   return hit.lines.map(toLine);\n\`\`\``;
    const result = grade(out(notes, RECORD + 'x'.repeat(200)), expected);
    const invented = result.find((mark) => mark.field === 'invented')!;
    expect(invented.ok).toBe(false);
    expect(invented.got).toContain('return hit.lines.map(toLine);');
  });

  it('judges every case against a record the size a job really reads', () => {
    for (const one of cases) {
      const text = [one.input.carried ?? '', ...record(one.input.messages)].join('\n\n');
      expect(text.length).toBeGreaterThan(1000);
    }
  });

  it('does not count prose as invented code', () => {
    const notes = 'pick() returns hit.lines.map(toLine) now, which is new.';
    expect(marks(out(notes, RECORD + 'x'.repeat(200)), { shorter: [0, 1] }).invented).toBe(true);
  });

  it('fails a compaction that freed no room, however faithful it was', () => {
    const everything = `\`\`\`\n${RECORD}\n\`\`\``;
    expect(marks(out(everything, RECORD), expected).shorter).toBe(false);
  });

  it('fails one that threw the work away, which is as wrong as keeping it all', () => {
    expect(marks(out('Looked at some files.', 'x'.repeat(4000)), { ...expected, shorter: [0.1, 0.9] }).shorter).toBe(
      false
    );
  });

  it('counts quoting what was only glanced at as a miss, and a line or two of it as fair', () => {
    const glanced = ['  a0: 1,', '  b1: 2,', '  c2: 3,', '  d3: 4,'];
    const dropped: Expected = { dropsCode: glanced, shorter: [0, 1] };
    const whole = `\`\`\`\n${glanced.join('\n')}\n\`\`\``;
    expect(marks(out(whole, glanced.join('\n')), dropped).code).toBe(false);
    expect(
      marks(out('src/settings.ts holds the defaults, such as `  a0: 1,`.', glanced.join('\n')), dropped).code
    ).toBe(true);
  });

  it('reports a run where every job came back empty, rather than scoring it', () => {
    const why = { ...out(''), why: 'every job of 3 came back empty' };
    expect(grade(why, expected)).toEqual([
      { field: 'code', wanted: 'notes', got: 'every job of 3 came back empty', ok: false },
    ]);
  });
});
