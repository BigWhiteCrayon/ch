// A harness for judging prompts against examples of what they should produce.
//
// A prompt is not code: it either gets the model to do the right thing often
// enough or it doesn't, and the only way to know is to ask the model. So these
// are not unit tests and they are not run by `npm test`: they call real models,
// they cost time and tokens, and they do not give the same answer twice. They
// are run on purpose, with `npm run eval`, when a prompt has been changed.
//
// A suite is a list of cases, each an input and what a good answer to it looks
// like. A case is graded field by field, so a near miss reads as a near miss
// rather than a failure: the aim is to see which way a prompt is drifting, not
// to go green. Every case may be run more than once (--runs), since a prompt
// that is right four times in five is a different thing from one that is right
// always, and one run cannot tell them apart.

// How a field of one answer was judged
export interface Mark {
  field: string;
  // What the case asked for, as something readable
  wanted: string;
  got: string;
  ok: boolean;
}

export interface Case<Input, Output> {
  name: string;
  input: Input;
  // Judges one answer, a mark per field
  grade(output: Output): Mark[];
  // Set where there is no one right answer, and the case is kept for what it
  // shows rather than for passing: it is reported but left out of the score
  ambiguous?: string;
}

export interface Suite<Input, Output> {
  name: string;
  // What is being judged, for the report's heading
  about: string;
  // Whether what is judged depends on the model, and so is worth running once
  // per model (see ./judges.ts). A suite that judges something else - the
  // search index, say - is run once however many models there are.
  perModel?: boolean;
  // Prepares whatever the cases need (models, servers), once
  setUp(options: RunOptions): Promise<{ model: string; run(input: Input): Promise<Output> }>;
  cases: Case<Input, Output>[];
}

export interface RunOptions {
  // Times to run each case: more tells you how steady the prompt is
  runs: number;
  // Only the cases whose name contains this
  only?: string;
  // The model to judge with, where the suite can be told
  model?: string;
}

// What one case came to over its runs
export interface CaseResult {
  name: string;
  ambiguous?: string;
  // A mark per field per run
  marks: Mark[][];
  // Anything that stopped a run outright
  errors: string[];
}

export interface SuiteResult {
  suite: string;
  model: string;
  options: RunOptions;
  cases: CaseResult[];
  ms: number;
}

// How often each field was right, over every run of every case that counts
export function byField(result: SuiteResult): { field: string; ok: number; of: number }[] {
  const totals = new Map<string, { ok: number; of: number }>();
  for (const one of result.cases) {
    if (one.ambiguous) continue;
    for (const run of one.marks) {
      for (const mark of run) {
        const total = totals.get(mark.field) ?? { ok: 0, of: 0 };
        total.of++;
        if (mark.ok) total.ok++;
        totals.set(mark.field, total);
      }
    }
  }
  return [...totals].map(([field, { ok, of }]) => ({ field, ok, of }));
}

// A case passes a run when every field of it was right
const passed = (run: Mark[]) => run.length > 0 && run.every((mark) => mark.ok);

// How many runs were wholly right, over the cases that count
export function score(result: SuiteResult): { ok: number; of: number; errors: number } {
  let ok = 0;
  let of = 0;
  let errors = 0;
  for (const one of result.cases) {
    errors += one.errors.length;
    if (one.ambiguous) continue;
    for (const run of one.marks) {
      of++;
      if (passed(run)) ok++;
    }
  }
  return { ok, of, errors };
}

// Runs a suite and reports what happened, case by case, as it goes.
// say: where the report goes, a line at a time
export async function run<Input, Output>(
  suite: Suite<Input, Output>,
  options: RunOptions,
  say: (line: string) => void = console.log
): Promise<SuiteResult> {
  const started = Date.now();
  const { model, run: ask } = await suite.setUp(options);
  const chosen = suite.cases.filter((one) => !options.only || one.name.includes(options.only));
  say(`\n${suite.name}: ${suite.about}`);
  say(`judged with ${model}, ${chosen.length} cases × ${options.runs} run(s)\n`);

  const cases: CaseResult[] = [];
  for (const one of chosen) {
    const result: CaseResult = { name: one.name, ambiguous: one.ambiguous, marks: [], errors: [] };
    for (let i = 0; i < options.runs; i++) {
      try {
        result.marks.push(one.grade(await ask(one.input)));
      } catch (err) {
        result.errors.push((err as Error).message);
      }
    }
    cases.push(result);
    say(line(result));
  }

  const result = { suite: suite.name, model, options, cases, ms: Date.now() - started };
  for (const summary of report(result)) say(summary);
  return result;
}

// One case as a line: how its runs went, and what was wrong with them
export function line(result: CaseResult): string {
  const wins = result.marks.filter(passed).length;
  const of = result.marks.length;
  const mark = result.ambiguous ? '~' : wins === of && of > 0 ? '✓' : wins > 0 ? '±' : '✗';
  const tally = of > 1 ? ` ${wins}/${of}` : '';
  // Only the fields that went wrong, and only once each however often
  const wrong = [
    ...new Map(
      result.marks
        .flat()
        .filter((m) => !m.ok)
        .map((m) => [`${m.field}${m.wanted}${m.got}`, m])
    ).values(),
  ].map((m) => `${m.field}: wanted ${m.wanted}, got ${m.got}`);
  const notes = [...result.errors.map((e) => `failed: ${e}`), ...wrong];
  const why = notes.length > 0 ? `\n      ${notes.join('\n      ')}` : '';
  const aside = result.ambiguous ? ` (no one right answer: ${result.ambiguous})` : '';
  return `  ${mark}${tally} ${result.name}${aside}${why}`;
}

// The closing lines: the score overall, then field by field
export function report(result: SuiteResult): string[] {
  const { ok, of, errors } = score(result);
  const percent = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)}%`);
  const lines = [
    '',
    `${ok}/${of} runs wholly right (${percent(ok, of)})${errors > 0 ? `, ${errors} could not run` : ''}`,
  ];
  for (const { field, ok: right, of: tried } of byField(result)) {
    lines.push(`  ${field.padEnd(16)} ${percent(right, tried)} (${right}/${tried})`);
  }
  const skipped = result.cases.filter((one) => one.ambiguous).length;
  if (skipped > 0) lines.push(`  ${skipped} case(s) left out of the score as having no one right answer`);
  lines.push(`took ${(result.ms / 1000).toFixed(0)}s`);
  return lines;
}

// ---- Marking helpers, for suites to grade with

// Right when the answer is one of the values the case allows
export function oneOf(field: string, allowed: readonly string[], got: unknown): Mark {
  return {
    field,
    wanted: allowed.join(' or '),
    got: String(got),
    ok: allowed.includes(String(got)),
  };
}

// Right when the answer falls in the range the case allows, ends included
export function within(field: string, [low, high]: readonly [number, number], got: unknown): Mark {
  const value = Number(got);
  return {
    field,
    wanted: low === high ? String(low) : `${low}-${high}`,
    got: Number.isFinite(value) ? String(value) : String(got),
    ok: Number.isFinite(value) && value >= low && value <= high,
  };
}
