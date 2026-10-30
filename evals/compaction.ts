// Judging whether a compaction keeps what the work needs.
//
// When a reply fills its context window, the older half of it — mostly tool
// results — is handed to compaction jobs, and their notes stand in for the
// messages from then on (see ../src/harness/compactor.ts). The reply carries
// on from the notes alone. So a compaction that reads well and leaves the one
// thing out is worse than no compaction at all: the model does not know the
// file it is editing has gone, and writes its next edit against a paraphrase.
//
// The prompt asks for two different things, and the hard part is telling them
// apart. Code the assistant still needs — what it is changing, what its change
// has to match, the signature it is calling, the test it has to satisfy — is to
// be carried through character for character, with its line numbers. Everything
// else is prose: what was looked for, what a command printed, what turned out
// not to matter. A model that fences the lot has not compacted anything; one
// that prose-ifies the lot has thrown the work away.
//
// Five things are judged, all of them mechanically. There is no judge model
// here, because none is needed: "the same characters as the record" and "names
// this path" are facts about strings, and a judge would only add its own
// unsteadiness to the measurement.
//
//   code      the code the assistant still needs is in the notes, character for
//             character. The one that matters most, and the one the prompt is
//             most emphatic about: a paraphrase will be trusted and will be
//             wrong
//   lines     the line numbers came through with it, so the assistant can say
//             which lines it means in the edit it is about to make
//   facts     the paths, identifiers, commands and values the work turns on are
//             named. A note saying "the test fails" saves nobody anything
//   invented  nothing in a fenced block that was not in the record. This is how
//             a paraphrase shows itself: code that reads plausibly, is formatted
//             like the record's, and does not appear in it
//   shorter   the notes come to a good deal less than the record. A model that
//             keeps everything passes the four fields above and has freed no
//             room, which is the whole purpose
//
// Two cases expect code NOT to be kept, which is what keeps the suite honest:
// without them a model that fences the entire record would score full marks on
// four fields out of five.

import { BIT_LENGTH, PROMPT, bits, record, summarize, writingRoom } from '../src/harness/compactor';
import * as llm from '../src/llm';
import type { ChatMessage, ModelInfo } from '../src/types';
import { within, type Case, type Mark, type Suite } from './harness';
import { configure } from './judges';

export interface Input {
  // The record of the work, as the messages it is made of. Turned into the
  // text a job reads by the app's own record() and bits(), so a case cannot
  // drift from what compaction really sends.
  messages: ChatMessage[];
  // The findings of an earlier compaction, which a later one reads again along
  // with the new work rather than carrying forward unread
  carried?: string;
}

export interface Expected {
  // Lines of code that must come through exactly as the record has them,
  // without their line-number prefix
  keepsCode?: readonly string[];
  // The line numbers that must come with them
  keepsLines?: readonly string[];
  // Code that is in the record but was only read in passing: a path and a
  // sentence, says the prompt, so quoting it whole is a miss
  dropsCode?: readonly string[];
  // What the notes must name, each as the spellings that would do
  facts?: readonly (readonly string[])[];
  // What the notes may come to, as a fraction of the record they were taken
  // from. Low where the record is mostly noise, higher where most of it is
  // code that has to survive.
  shorter: readonly [number, number];
}

export interface Output {
  // The notes, one job's after another, as they would go into the message that
  // stands in for the record
  notes: string;
  // What the jobs were given, for the report and for the size they are judged
  // against
  record: string;
  jobs: number;
  // Why there is nothing to judge: every job failed
  why?: string;
}

// The fenced blocks of the notes, each as its lines, with any line-number
// prefix and indentation taken off
export function fenced(notes: string): string[][] {
  const blocks = notes.match(/```[^\n]*\n([\s\S]*?)(?:```|$)/g) ?? [];
  return blocks
    .map((block) =>
      block
        .replace(/```[^\n]*\n?/g, '')
        .split('\n')
        .map(bare)
        .filter((line) => line.length > 0)
    )
    .filter((lines) => lines.length > 0);
}

// What a fenced block turned out to be. A fence is for code quoted from the
// record, so a block is judged by how much of it is: mostly the record's own
// lines and it is a quotation, and any line that is not belongs to the model;
// hardly any and the fence is not a quotation at all, which is its own fault —
// whatever reads the notes next cannot tell such a block from quoted code.
export function kinds(notes: string, from: Set<string>): { strays: string[]; notQuotes: number } {
  const strays: string[] = [];
  let notQuotes = 0;
  for (const lines of fenced(notes)) {
    const mine = lines.filter((line) => !from.has(line));
    if (mine.length > lines.length / 2) notQuotes++;
    else strays.push(...mine);
  }
  return { strays, notQuotes };
}

// A line without the line number the record puts in front of it, and without
// the indentation either: a model that re-indents a block as it quotes it has
// still carried the code through, so both sides of every comparison are trimmed
export const bare = (line: string) => line.replace(/^\s*\d+[:|]/, '').trim();

// Whether every spelling group is named somewhere in the notes
export function missing(notes: string, facts: readonly (readonly string[])[]): string[] {
  const text = notes.toLowerCase();
  return facts
    .filter((spellings) => !spellings.some((word) => text.includes(word.toLowerCase())))
    .map((spellings) => spellings[0]);
}

// Code is "there" when the record's line appears in the notes with its own
// characters. Leading indentation is allowed to differ, since a model that
// re-indents a block into a fence has still carried the code itself through;
// anything inside the line must match.
const has = (notes: string, line: string) => notes.includes(line.trim());

export function grade(got: Output, expected: Expected): Mark[] {
  if (got.why) return [{ field: 'code', wanted: 'notes', got: got.why, ok: false }];
  const marks: Mark[] = [];

  if (expected.keepsCode) {
    const lost = expected.keepsCode.filter((line) => !has(got.notes, line));
    marks.push({
      field: 'code',
      wanted: `${expected.keepsCode.length} lines, character for character`,
      got: lost.length === 0 ? 'all of them' : `lost ${lost.length}: ${lost.map((l) => l.trim()).join(' / ')}`,
      ok: lost.length === 0,
    });
  }

  if (expected.keepsLines) {
    const absent = expected.keepsLines.filter((number) => !new RegExp(`\\b${number}\\b`).test(got.notes));
    marks.push({
      field: 'lines',
      wanted: `line numbers ${expected.keepsLines.join(', ')}`,
      got: absent.length === 0 ? 'all of them' : `no ${absent.join(', ')}`,
      ok: absent.length === 0,
    });
  }

  // Code the prompt says to leave as a path and a sentence. Judged on whole
  // blocks rather than single lines: a model may fairly quote one line of it
  // to say which function it means.
  if (expected.dropsCode) {
    const quoted = expected.dropsCode.filter((line) => has(got.notes, line));
    const tooMany = quoted.length > Math.floor(expected.dropsCode.length / 2);
    marks.push({
      field: 'code',
      wanted: `${expected.dropsCode.length} lines read in passing left out`,
      got: tooMany ? `quoted ${quoted.length} of them` : `left out ${expected.dropsCode.length - quoted.length}`,
      ok: !tooMany,
    });
  }

  if (expected.facts) {
    const absent = missing(got.notes, expected.facts);
    marks.push({
      field: 'facts',
      wanted: `names ${expected.facts.map((spellings) => spellings[0]).join(', ')}`,
      got: absent.length === 0 ? 'all of them' : `no mention of ${absent.join(', ')}`,
      ok: absent.length === 0,
    });
  }

  // Two different faults, told apart because they want different answers. A
  // stray line inside an otherwise faithful quotation is code the model wrote
  // itself, which the prompt warns will be trusted and will be wrong. A fence
  // holding no quotation at all is prose dressed as code.
  const fromRecord = new Set(got.record.split('\n').map(bare));
  const { strays, notQuotes } = kinds(got.notes, fromRecord);
  marks.push({
    field: 'invented',
    wanted: 'no code in a quotation that was not in the record',
    got: strays.length === 0 ? 'none' : `${strays.length} line(s): ${strays.slice(0, 2).join(' / ')}`,
    ok: strays.length === 0,
  });
  marks.push({
    field: 'fences',
    wanted: 'every fenced block a quotation from the record',
    got: notQuotes === 0 ? 'all of them' : `${notQuotes} fence(s) of prose`,
    ok: notQuotes === 0,
  });

  const fraction = got.record.length === 0 ? 0 : got.notes.length / got.record.length;
  marks.push(within('shorter', expected.shorter, Number(fraction.toFixed(2))));
  return marks;
}

// ---- Building a record, in the shape the app's record() turns messages into

let next = 0;
const called = (name: string, input: Record<string, unknown>, output: string, isError = false): ChatMessage[] => {
  const id = `c${++next}`;
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name, input }] },
    { role: 'tool', toolCallId: id, name, content: output, isError },
  ];
};
const read = (path: string, lines: string) => called('read_file', { path }, lines);
const ran = (command: string, output: string, isError = false) => called('run_command', { command }, output, isError);
const searched = (query: string, output: string) => called('search_workspace', { query }, output);

// Lines as read_file gives them: numbered from `from`
const numbered = (from: number, code: string) =>
  code
    .split('\n')
    .map((line, i) => `${from + i}: ${line}`)
    .join('\n');

// ---- The code the cases are about, written out once so that what a case
// expects to survive is the same text the record contains

const PICK = `export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {
  if (!hit.text) return [];
  const all = hit.text.split('\\n');
  const words = keywords(query);
  let best = 0;
  let most = 0;
  all.forEach((line, i) => {
    const lower = line.toLowerCase();
    const score = words.filter((word) => lower.includes(word)).length;
    if (score > most) {
      most = score;
      best = i;
    }
  });
  const from = Math.max(0, best - context);
  const to = Math.min(all.length, best + context + 1);
  return all.slice(from, to).map((line, i) => ({ line: hit.start + from + i, text: line }));
}`;

const MERGE = `export function mergeBlocks(blocks: Block[]): Block[] {
  const kept: Block[] = [];
  const touches = (a: Block, b: Block) => a[0].line <= last(b) + 1 && last(a) + 1 >= b[0].line;
  for (const block of blocks) {
    if (block.length === 0) continue;
    const at = kept.findIndex((other) => touches(block, other));
    if (at === -1) {
      kept.push([...block]);
      continue;
    }
    kept[at] = join(kept[at], block);
  }
  return kept;
}`;

// A long, dull file the assistant only glanced at: the sort of thing that fills
// a window and is worth a sentence
const SETTINGS = Array.from(
  { length: 150 },
  (_, i) => `  ${['anthropic', 'openai', 'local', 'sandbox'][i % 4]}${i}: { apiKey: '', disabledModels: [] },`
).join('\n');

// A case, with what it expects kept on it: the suite only needs grade(), but a
// test checks every expectation against the record the case hands over, so that
// a case cannot ask for a line the record never had
export type Graded = Case<Input, Output> & { expected: Expected };

// Tool output of the kind that fills a context window: a wide search and a long
// test run. A real job reads the whole turn, most of it this sort of thing, so
// the cases carry some — a case built only of the code it cares about would
// measure compaction on a record nothing like the ones it gets.
//
// Most of these cases are bit-sized, which is a good deal less than a job
// reads (see compactor.readable): what they measure is whether the prompt holds
// up, not whether it holds up over a record of the length one job now gets.
// The last case is built to the size a job really reads, because the prompt
// fails differently there — see A_LONG_TURN below.
const WIDE_SEARCH = Array.from({ length: 40 }, (_, i) => {
  const dir = ['src/harness', 'src/llm', 'src/search', 'src/tools', 'tests/harness'][i % 5];
  return `${dir}/file${i}.ts\n  ${12 + i * 7}: export function thing${i}(input: Input): Output {\n  …`;
}).join('\n');

const LONG_RUN = [
  ...Array.from({ length: 45 }, (_, i) => ` ✓ tests/unit/case${i}.test.ts (${3 + (i % 9)} tests) ${4 + i}ms`),
  ' ✗ tests/search/embeddings.test.ts > pick > does not run off either end',
  ' Test Files  1 failed | 44 passed (45)',
].join('\n');

// A build's own chatter, which is worth nothing once it has been read
const BUILD_LOG = Array.from(
  { length: 50 },
  (_, i) => `[${String(i).padStart(3, '0')}] transpiling src/${['harness', 'llm', 'search', 'tools'][i % 4]}/f${i}.ts`
).join('\n');

// ---- A record the size a job really gets
//
// The cases above are two to ten thousand characters. A real one is forty to
// seventy thousand, and the prompt fails differently at that length: asked for
// code "character for character" over a record that is mostly code, a small
// model stops choosing which code and starts copying the record back out. That
// is not a worse version of the failures above, it is a different one — it
// passes `code`, passes `invented`, and frees no room at all.
//
// Measured on the compaction that ran a thread's window out on 2026-10-23: a
// 70,904-character record, a job still transcribing src/main.ts line by line
// when its 213 seconds ran out, and nothing in the notes that was not already
// in the record. Nothing in the suite as it stood could have caught it.

// A whole file as the assistant reads one: a few hundred lines of ordinary
// code, none of which the work turns on. Every line differs from every other,
// so that a quotation of any of it can be told from a paraphrase.
const bulk = (stem: string, count: number): string =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const Stem = stem[0].toUpperCase() + stem.slice(1);
    switch (n % 7) {
      case 0:
        return `}`;
      case 1:
        return `// ${stem}: what step ${n} is for, and why it sits where it does`;
      case 2:
        return `export function ${stem}Step${n}(input: ${Stem}Input): ${Stem}Output {`;
      case 3:
        return `  const held${n} = registry.get('${stem}.${n}') ?? fallbacks.${stem}[${n}];`;
      case 4:
        return `  if (!held${n}) throw new Error('nothing registered for ${stem} step ${n}');`;
      case 5:
        return `  log.debug('${stem}.step', { step: ${n}, of: ${count}, held: held${n}.name });`;
      default:
        return `  return shape(held${n}, input, { at: ${n}, from: '${stem}' });`;
    }
  }).join('\n');

// The four the assistant read to find its way around, and will not touch. In
// the failure this is drawn from they were src/main.ts, src/renderer.ts,
// src/harness/index.ts and src/preload.ts, read whole, one after another.
// The line counts are what fits: the case has to stay inside one job's
// reading (see the length test in tests/evals/compaction.test.ts), and that
// came down from about 70,000 characters to 56,682 when the estimate behind it
// was corrected — it had been handing a job half again the record its window
// held (see CHARS_PER_TOKEN in ../src/llm/tokens.ts). Still forty thousand
// characters of code that does not matter, which is what the case is for.
const GLANCED = {
  'src/main.ts': bulk('host', 215),
  'src/renderer.ts': bulk('view', 180),
  'src/harness/index.ts': bulk('reply', 225),
  'src/preload.ts': bulk('bridge', 160),
} as const;

const A_LONG_TURN: ChatMessage[] = [
  ...searched('where is a tool call run and its result put back', WIDE_SEARCH),
  ...Object.entries(GLANCED).flatMap(([path, text]) => read(path, numbered(1, text))),
  ...ran('npm run build', BUILD_LOG),
  // ...and, at the end of all that, the one thing the next edit depends on
  ...read('src/search/embeddings.ts', numbered(620, PICK)),
  ...ran(
    'npx vitest run tests/search',
    `${LONG_RUN}\n  → pick returned 0 lines for a hit whose text is empty (tests/search/embeddings.test.ts:378)`
  ),
];

function one(name: string, input: Input, expected: Expected, ambiguous?: string): Graded {
  return { name, input, ambiguous, expected, grade: (got) => grade(got, expected) };
}

export const cases: Graded[] = [
  // ---- Code the assistant is in the middle of changing. If this is lost the
  // reply writes its next edit against a paraphrase of the function.
  one(
    'keeps the function it is editing, with its line numbers',
    {
      messages: [
        ...searched('where are the lines of a match chosen', WIDE_SEARCH),
        ...read('src/search/embeddings.ts', numbered(620, PICK)),
        ...ran('npx vitest run tests/search', LONG_RUN),
      ],
    },
    {
      keepsCode: [
        'export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {',
        'const from = Math.max(0, best - context);',
        'return all.slice(from, to).map((line, i) => ({ line: hit.start + from + i, text: line }));',
      ],
      keepsLines: ['620', '636'],
      facts: [['src/search/embeddings.ts'], ['pick'], ['vitest', 'test']],
      // The code is the only part worth its room, and it is a small part of this
      shorter: [0.05, 0.5],
    }
  ),

  // ---- Two files, one being changed and one it has to keep in step with.
  // Both are needed, which is the case a model that keeps only the first fails.
  one(
    'keeps both the code it is changing and the code it must match',
    {
      messages: [
        ...searched('where are the blocks of a result put together', WIDE_SEARCH),
        ...read('src/search/embeddings.ts', numbered(620, PICK)),
        ...read('src/search/results.ts', numbered(43, MERGE)),
        ...ran('npx tsc --noEmit', "src/search/results.ts(45,41): error TS2304: Cannot find name 'last'."),
      ],
    },
    {
      keepsCode: [
        'export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {',
        'export function mergeBlocks(blocks: Block[]): Block[] {',
        'const touches = (a: Block, b: Block) => a[0].line <= last(b) + 1 && last(a) + 1 >= b[0].line;',
      ],
      keepsLines: ['620', '43'],
      facts: [['TS2304'], ["Cannot find name 'last'", 'last']],
      // Two functions have to survive, so more of this record is worth its room
      shorter: [0.1, 0.7],
    }
  ),

  // ---- The honest half: a file read once, in passing, that has nothing to do
  // with the change. A model that fences this has compacted nothing.
  one(
    'leaves a file it only glanced at as a path and a sentence',
    {
      messages: [
        ...searched('where are settings kept', 'src/settings.ts\n  15: function defaults(): Settings {'),
        ...read('src/settings.ts', numbered(15, SETTINGS)),
        ...read('src/search/embeddings.ts', numbered(620, PICK)),
        ...ran('npx vitest run tests/search', 'FAIL pick > shows nothing for a piece that could not be read'),
      ],
    },
    {
      // The one it is working on still has to survive...
      keepsCode: ['export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {'],
      // ...while the one it glanced at does not
      dropsCode: SETTINGS.split('\n').slice(0, 20),
      facts: [['src/settings.ts'], ['src/search/embeddings.ts']],
      shorter: [0.05, 0.6],
    }
  ),

  // ---- No code in it at all: a search and two commands. Everything here is
  // prose, and the facts are the paths and the numbers.
  one(
    'turns a search and a command into prose, keeping the paths and the numbers',
    {
      messages: [
        ...searched(
          'where is the model chosen',
          [
            'src/harness/router.ts',
            '  52: const sufficient = models.filter',
            'src/llm/sophistication.ts',
            '  18: export function resolveSophistication',
            WIDE_SEARCH,
          ].join('\n')
        ),
        ...ran('node --version', 'v16.20.2'),
        ...ran('npm test', 'Test Files  3 failed | 39 passed (42)\nTests  11 failed | 1354 passed (1365)'),
      ],
    },
    {
      facts: [['src/harness/router.ts'], ['src/llm/sophistication.ts'], ['v16.20.2', '16.20'], ['11'], ['1354']],
      // Nothing here is worth keeping verbatim, so it should come to very little
      shorter: [0.02, 0.35],
    }
  ),

  // ---- A failing command is the thing most worth keeping exactly: the next
  // step is chosen from the error, and a paraphrased error sends it elsewhere.
  one(
    'keeps an error exactly, since the next step is chosen from it',
    {
      messages: [
        ...ran('npm run build', `${BUILD_LOG}\nsh: tsc: command not found`, true),
        ...ran(
          'npx tsc --noEmit',
          'src/llm/providers/anthropic.ts(93,43): error TS2353: ' +
            "'cache_control' does not exist in type 'BetaFallbackBlockParam'.",
          true
        ),
      ],
    },
    {
      facts: [['TS2353'], ['cache_control'], ['BetaFallbackBlockParam'], ['src/llm/providers/anthropic.ts'], ['93']],
      shorter: [0.1, 1.1],
    }
  ),

  // ---- The second pass. Findings are read again and condensed with the new
  // work, so code that survived once has to survive being re-read — which is
  // where a long reply loses it.
  one(
    'carries code through a second compaction instead of summarizing its own notes',
    {
      carried: [
        'src/search/embeddings.ts, the function being changed:',
        '```ts',
        numbered(620, PICK),
        '```',
        'The test tests/search/embeddings.test.ts fails: pick returns [] for a piece whose text is empty.',
        'Looked through the rest of src/search and src/harness; nothing else touches how lines are picked.',
      ].join('\n'),
      messages: [
        ...searched('what else reads the blocks of a result', WIDE_SEARCH),
        ...ran('npx vitest run tests/search', LONG_RUN),
        ...read(
          'tests/search/embeddings.test.ts',
          numbered(
            378,
            "it('does not run off either end', () => {\n" +
              "  expect(embeddings.pick(hit, 'parse', 10)).toHaveLength(5);\n});"
          )
        ),
      ],
    },
    {
      keepsCode: [
        'export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {',
        'if (!hit.text) return [];',
      ],
      keepsLines: ['620'],
      facts: [['src/search/embeddings.ts'], ['tests/search/embeddings.test.ts']],
      // The carried code has to survive, and the new work is mostly noise
      shorter: [0.05, 0.6],
    }
  ),

  // ---- Longer than one job takes, so the record is split and the notes are
  // several jobs' put together, as they are in life
  one(
    'keeps the code when the record is too long for one job',
    {
      messages: [
        ...read('src/settings.ts', numbered(15, SETTINGS)),
        ...read('src/search/results.ts', numbered(43, MERGE)),
        ...read('src/search/embeddings.ts', numbered(620, PICK)),
        ...ran('npx vitest run', 'FAIL tests/search/index.test.ts > runs of lines that overlap'),
      ],
    },
    {
      keepsCode: [
        'export function mergeBlocks(blocks: Block[]): Block[] {',
        'export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {',
      ],
      facts: [['src/search/results.ts'], ['src/search/embeddings.ts']],
      shorter: [0.05, 0.8],
    }
  ),

  // ---- The length a job really gets, where the prompt stops being read as
  // "choose the code that matters" and starts being read as "copy the record
  // out" (see A_LONG_TURN). Four whole files the assistant will not touch, and
  // one function at the end of them that the next edit depends on.
  one(
    'picks the one thing that matters out of a record the length of a real one',
    { messages: A_LONG_TURN },
    {
      // The function being changed still has to come through exactly, after
      // forty thousand characters of code that does not matter
      keepsCode: [
        'export function pick(hit: Hit, query: string, context: number): { line: number; text: string }[] {',
        'return all.slice(from, to).map((line, i) => ({ line: hit.start + from + i, text: line }));',
      ],
      keepsLines: ['620'],
      // The four read to find the way around are a path and a sentence each.
      // Taken from the middle of two of them, so that a job which copies only
      // the start of the record is caught as readily as one that copies it all.
      dropsCode: [
        ...GLANCED['src/main.ts'].split('\n').slice(40, 70),
        ...GLANCED['src/harness/index.ts'].split('\n').slice(120, 150),
      ].filter((line) => line.trim().length > 0),
      facts: [
        ['src/search/embeddings.ts'],
        ['pick'],
        ['src/main.ts'],
        ['src/harness/index.ts'],
        ['tests/search/embeddings.test.ts', '378'],
      ],
      // Wide, because on this case it is `dropsCode` that catches a job which
      // transcribes rather than compacts: thirty of the sixty lines taken from
      // the middle of two files it was told to leave alone, which is a fact
      // about what was quoted and not about how long the notes came out.
      //
      // A narrow upper bound here would measure the ceiling instead. The job
      // is cut off at twice the notes it was asked for (see writingRoom), and
      // the notes it is asked for are a tenth of the record, so no job can
      // come back with much past a fifth of it whatever the prompt says. A
      // bound under that fifth fails the jobs the ceiling stopped; one over it
      // can never fail at all. Neither says anything about the prompt, so this
      // is left as a backstop against the ceiling being raised or dropped.
      //
      // The lower bound is the compactor's own FLOOR: notes under it would
      // have been refused as too little to stand for the record.
      shorter: [0.02, 0.9],
    }
  ),
];

export const suite: Suite<Input, Output> = {
  name: 'compaction',
  about: 'whether a compaction keeps the code and the facts the reply carries on from',
  // The prompt asks for something small models are known to find hard, so it is
  // worth seeing at every level
  perModel: true,

  async setUp({ model: wanted }) {
    configure();
    const { models, providers } = await llm.listModels({ fresh: true });
    const offered: ModelInfo[] = wanted
      ? models.filter((m) => m.id === wanted)
      : [...models].sort((a, b) => b.sophistication - a.sophistication).slice(0, 1);
    if (offered.length === 0) {
      const trouble = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
      throw new Error(
        [wanted ? `No model called "${wanted}".` : 'No models available.', ...trouble].join('\n') +
          `\nModels there are: ${models.map((m) => m.id).join(', ') || 'none'}`
      );
    }
    const [chosen] = offered;

    return {
      model: chosen.id,
      async run(input: Input): Promise<Output> {
        // Built exactly as a compaction builds it: the findings so far first,
        // then the new work, cut into bits on boundaries that do a record no
        // harm — and then read whole, by the one job (see compactor.compact)
        const parts = [...(input.carried ? bits([input.carried]) : []), ...bits(record(input.messages))];
        const whole = parts.join('\n\n');
        const signal = AbortSignal.timeout(300_000);
        // The ceiling the app gives a job for a record this size, so that a
        // model which answers by copying the record out is cut off here as it
        // is there (see writingRoom)
        const room = writingRoom(whole.length, chosen.contextWindow);
        const { text } = await summarize(whole, chosen.provider, chosen.id, signal, room);
        return {
          notes: text,
          record: whole,
          jobs: 1,
          why: text ? undefined : 'the job came back empty',
        };
      },
    };
  },

  cases,
};

// What the suite is built on, so a test can check the cases against the real
// thing rather than a copy of it
export const USES = { PROMPT, BIT_LENGTH };
