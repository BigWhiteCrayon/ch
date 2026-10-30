import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatMessage, ChatRequest } from '../../src/types';
import { SOPHISTICATION } from '../../src/llm/sophistication';
import { CHARS_PER_TOKEN } from '../../src/llm/tokens';
import { from, unwrapped } from '../helpers';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  // A job stays where it is unless a test says there is somewhere to move it
  // to (see failoverTo in src/harness/compactor.ts)
  isOffline: vi.fn(() => false),
  isLocal: vi.fn(() => false),
  listModels: vi.fn(async () => ({ models: [], providers: [] })),
}));
vi.mock('../../src/llm', () => mocks);
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // How long the compaction has been going, which is what bounds its tries
  since: vi.fn(() => 7),
}));
vi.mock('../../src/log', () => log);

import {
  BIT_LENGTH,
  CARRIED,
  CARRIED_BITS,
  CONTINUED,
  DEFAULT_WINDOW,
  FLOOR,
  MAX_RECORD,
  PROMPT,
  TRIES,
  bits,
  compact,
  enough,
  finish,
  nearlyFull,
  notesRoom,
  pieces,
  quoteBlocks,
  quoteLines,
  readable,
  size,
  split,
  timeoutFor,
  writingRoom,
} from '../../src/harness/compactor';

const signal = () => new AbortController().signal;
const model = { provider: 'local', model: 'qwen' };
const jobs = () => mocks.stream.mock.calls.map(([request]) => request as ChatRequest);
const answer = (reply: (n: number, record: string) => ChatEvent[]) =>
  mocks.stream.mockImplementation((request: ChatRequest) =>
    from(reply(mocks.stream.mock.calls.length, request.messages[0]?.content ?? ''))
  );
// Notes that stand for the record they were made from, as a real job's do: a
// job that answers a long record with a line is treated as having failed (see
// FLOOR in the compactor), so a stub that always wrote one would be testing
// the failure path everywhere. Padded only as far as the floor, so the short
// records elsewhere still get exactly the note the tests name.
const standsFor = (note: string, record: string) =>
  note + '.'.repeat(Math.max(0, Math.ceil(record.length * FLOOR) - note.length));

// A round of exploring: the model calls a tool and gets a result back
const round = (n: number, result = `result ${n}`): ChatMessage[] => [
  {
    role: 'assistant',
    content: `Looking at ${n}.`,
    toolCalls: [{ id: `c${n}`, name: 'read_file', input: { path: `f${n}.ts` } }],
  },
  { role: 'tool', toolCallId: `c${n}`, name: 'read_file', content: result, isError: false },
];
const task: ChatMessage = { role: 'user', content: 'Explore the workspace.' };

beforeEach(() => {
  log.since.mockReturnValue(7);
  log.warn.mockClear();
  log.info.mockClear();
  mocks.stream.mockReset();
  answer((n, record) => [
    { type: 'text', delta: standsFor(` finding ${n} `, record) },
    { type: 'done', stopReason: 'end_turn' },
  ]);
});

describe('size and nearlyFull', () => {
  it('estimates tokens from the text of the messages, their tool calls and the system prompt', () => {
    expect(size([], 'x'.repeat(280))).toBe(100);
    expect(size([{ role: 'user', content: 'x'.repeat(840) }])).toBe(300);
    expect(size(round(1))).toBeGreaterThan(size([{ role: 'assistant', content: 'Looking at 1.' }]));
  });

  it('calls a window nearly full past seven tenths of it, assuming a window for a model that names none', () => {
    expect(nearlyFull(7001, 10000)).toBe(true);
    expect(nearlyFull(7000, 10000)).toBe(false);
    expect(nearlyFull(DEFAULT_WINDOW * 0.7 + 1, null)).toBe(true);
    expect(nearlyFull(DEFAULT_WINDOW * 0.7, undefined)).toBe(false);
  });
});

describe('how a long entry is cut into pieces', () => {
  // A file as a tool result shows it: a header, then numbered lines
  const file = (lines: number, path = 'src/router.ts') =>
    [
      `Result of read_file:`,
      `${path}:`,
      ...Array.from({ length: lines }, (_, i) => `${i + 1}\tconst step${i} = run(${i});`),
    ].join('\n');

  it('leaves an entry that already fits exactly as it is', () => {
    const short = file(10);
    expect(short.length).toBeLessThan(BIT_LENGTH);
    expect(pieces(short)).toEqual([short]);
  });

  it('cuts between lines, so that no line of code is halved', () => {
    const entry = file(900);
    const cut = pieces(entry);
    expect(cut.length).toBeGreaterThan(1);
    const whole = new Set(entry.split('\n'));
    for (const piece of cut) {
      // Every line of every piece is a whole line of the entry, or one of the
      // lines added to say where the piece came from
      for (const line of piece.split('\n')) {
        if (line.includes(CONTINUED) || line.startsWith('```')) continue;
        expect(whole.has(line)).toBe(true);
      }
    }
  });

  it('keeps every line of the entry, in order, across the pieces', () => {
    const entry = file(900);
    const kept = pieces(entry)
      .flatMap((piece) => piece.split('\n'))
      .filter((line) => !line.includes(CONTINUED));
    expect(kept.filter((line) => line.startsWith('1\t'))).toHaveLength(1);
    expect(kept.at(-1)).toBe('900\tconst step899 = run(899);');
    // Nothing is lost: every line of the entry is somewhere in the pieces
    for (const line of entry.split('\n')) expect(kept).toContain(line);
  });

  it('keeps every piece inside a bit', () => {
    for (const entry of [file(900), 'x'.repeat(BIT_LENGTH * 3), `a\n${'y'.repeat(BIT_LENGTH * 2)}\nb`]) {
      for (const piece of pieces(entry)) expect(piece.length).toBeLessThanOrEqual(BIT_LENGTH);
    }
  });

  it('says where a piece cut from the middle came from, so the job can place it', () => {
    const cut = pieces(file(900));
    expect(cut[0]).not.toContain(CONTINUED);
    for (const piece of cut.slice(1)) {
      expect(piece.split('\n')[0]).toBe(`Result of read_file: ${CONTINUED}`);
    }
  });

  it('closes a fenced block at the cut and opens another after it', () => {
    // Findings read again are fenced by construction, and a cut inside a block
    // would leave code that does not look like code
    const body = Array.from({ length: 700 }, (_, i) => `${i + 1}\tconst step${i} = run(${i});`).join('\n');
    const entry = `Earlier notes.\n\nsrc/router.ts:\n\`\`\`ts\n${body}\n\`\`\`\n\nThe rest is prose.`;
    const cut = pieces(entry);
    expect(cut.length).toBeGreaterThan(1);
    // Each piece has an even number of fences: none of them ends inside a block
    for (const piece of cut) {
      const fences = piece.split('\n').filter((line) => line.startsWith('```'));
      expect(fences.length % 2).toBe(0);
    }
    // ...and a piece cut from inside the block is told which block it is in,
    // and what path it was filed under
    expect(cut[1]).toContain('src/router.ts:');
    expect(cut[1].split('\n')[1]).toBe('src/router.ts:');
    expect(cut[1].split('\n')[2]).toBe('```ts');
  });

  it('cuts a single line longer than a piece where it must, having no boundary', () => {
    const entry = `Result of run_command:\n${'z'.repeat(BIT_LENGTH * 2)}`;
    const cut = pieces(entry);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join('').match(/z/g)).toHaveLength(BIT_LENGTH * 2);
    expect(cut[1]).toContain(CONTINUED);
  });

  it('packs the pieces of several entries into bits, as before', () => {
    const packed = bits([file(10), file(12), file(900)]);
    for (const bit of packed) expect(bit.length).toBeLessThanOrEqual(BIT_LENGTH + 2);
    expect(packed.length).toBeGreaterThan(1);
    expect(packed[0]).toContain('const step9 = run(9);');
  });
});
describe('what a compaction job is asked for', () => {
  it('tells the job the record is being thrown away, and what of it cannot be got back', () => {
    expect(unwrapped(PROMPT)).toContain('carries on from your notes alone');
    // Not everything in the record is lost with it, and a job told that it is
    // keeps the files as readily as the findings — which is how a job comes to
    // copy the record back out instead of compacting it (see quoteLines)
    expect(unwrapped(PROMPT)).toContain("The project's files are still there");
    expect(unwrapped(PROMPT)).toContain('What it cannot get back is what it worked out');
    expect(unwrapped(PROMPT)).toContain('the assistant will not know that it is missing');
  });

  it('asks for the code that still matters verbatim, with its path and line numbers', () => {
    expect(unwrapped(PROMPT)).toContain('character for character');
    expect(unwrapped(PROMPT)).toContain('fenced block under the path it came from');
    expect(unwrapped(PROMPT)).toContain('line numbers the record gives it');
    // And says why, since a model asked only to summarise will summarise code
    expect(unwrapped(PROMPT)).toContain('worse than no code at all');
    expect(unwrapped(PROMPT)).toContain('Do not retype it from memory, tidy it, shorten it');
  });

  it('asks for a file it only read as a path and a sentence, not a block', () => {
    expect(unwrapped(PROMPT)).toContain('read from a file to find something out is not quoted at all');
    expect(unwrapped(PROMPT)).toContain('a path, a range of lines and a sentence');
    expect(unwrapped(PROMPT)).toContain('not being judged on how short your notes are');
    // Scoped to findings: it used to say "something", which a job applied to
    // the code as well, and the code is the one place where keeping what you
    // are unsure of is wrong
    expect(unwrapped(PROMPT)).toContain('unsure whether a finding belongs');
  });

  it('puts the findings before the code, so a job that is cut off loses the quotations', () => {
    const text = unwrapped(PROMPT);
    expect(text).toContain('Write three things, in this order');
    expect(text.indexOf('what it found out')).toBeLessThan(text.indexOf('Third, the code, last of all'));
    expect(text).toContain('it is the quotations at the end that should be missing');
  });

  it('bounds the quoting, and says what to spend the bound on first', () => {
    expect(unwrapped(PROMPT)).toContain('You are told below how many lines you may quote');
    expect(unwrapped(PROMPT)).toContain('code that is in the record and nowhere else');
    expect(unwrapped(PROMPT)).toContain('the code its next edit has to match');
    // ...and what to do at the limit, since a bound with no way out is ignored
    expect(unwrapped(PROMPT)).toContain('write the path and the line range instead');
  });

  it('gives the job room to write up the whole turn, scaled to the window it has', async () => {
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    // Room for what the eight jobs this replaced wrote between them, since one
    // job now writes all of it; the prompt is what compresses it, not this
    expect(jobs()[0].maxTokens).toBe(writingRoom(size(round(1)) * 3, DEFAULT_WINDOW));
    expect(notesRoom(DEFAULT_WINDOW)).toBeGreaterThan(2500);
    // ...and never so much of a small window that there is no room left to read
    expect(notesRoom(8000)).toBe(2000);
  });
});

describe('the ceiling a job writes under', () => {
  it('gives a job twice the notes it is asked for, and no more', () => {
    // The record that ran the window out: a target of 7,100 characters, and a
    // job still copying the record out at 14,596 when the timeout cut it off
    expect(writingRoom(70904, 32768)).toBe(Math.ceil((7100 * 2) / CHARS_PER_TOKEN));
    // Well under the quarter-window it used to be given, which is the point:
    // a job that copies the record now meets a ceiling before the timeout
    expect(writingRoom(70904, 32768)).toBeLessThan(notesRoom(32768) / 1.5);
  });

  it('never gives less than a job can write notes in, however short the record', () => {
    expect(writingRoom(0, DEFAULT_WINDOW)).toBe(1000);
    expect(writingRoom(2000, DEFAULT_WINDOW)).toBe(1000);
  });

  it('never gives more than the window leaves, however long the record', () => {
    expect(writingRoom(500000, 8000)).toBe(notesRoom(8000));
    expect(writingRoom(500000, DEFAULT_WINDOW)).toBe(notesRoom(DEFAULT_WINDOW));
  });

  it('scales the ceiling to the record the job was actually given', async () => {
    const many = Array.from({ length: 20 }, (_, i) => round(i + 1, 'z'.repeat(4000))).flat();
    await compact([task, ...many], model, signal());
    const read = String(jobs()[0].messages[0].content).match(/<record>\n([\s\S]*)\n<\/record>/)?.[1] ?? '';
    expect(jobs()[0].maxTokens).toBe(writingRoom(read.length, DEFAULT_WINDOW));
    // A record this long is past the floor and under the window: the ceiling
    // is the record's own size talking, not either bound
    expect(jobs()[0].maxTokens).toBeGreaterThan(1000);
    expect(jobs()[0].maxTokens).toBeLessThan(notesRoom(DEFAULT_WINDOW));
  });
});

describe('notes that were cut off part-way', () => {
  const cutOff = (text: string, how: ChatEvent) => answer(() => [{ type: 'text', delta: text }, how]);
  const timedOut: ChatEvent = { type: 'error', code: 'other', message: 'did not answer within 120 seconds.' };
  const ranOut: ChatEvent = { type: 'done', stopReason: 'length' };
  const notes = (record: string) => `What it found.\n${'.'.repeat(Math.ceil(record.length * FLOOR))}\nand more`;

  it('keeps what the job had written when the timeout cut it off', async () => {
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const record = String(given.map((m) => m.content).join(''));
    cutOff(notes(record), timedOut);
    const { messages } = await compact(given, model, signal());
    // The record's place is taken, rather than the whole compaction being lost
    expect(messages).not.toBe(given);
    expect(String(messages[0].content)).toContain('What it found.');
  });

  it('keeps what it had written when the ceiling stopped it', async () => {
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const record = String(given.map((m) => m.content).join(''));
    cutOff(notes(record), ranOut);
    const { messages } = await compact(given, model, signal());
    expect(String(messages[0].content)).toContain('What it found.');
  });

  it('still treats a job that wrote nothing at all as a job that failed', async () => {
    cutOff('', timedOut);
    const given = [task, ...round(1)];
    await expect(compact(given, model, signal())).resolves.toMatchObject({ messages: given });
  });

  it('drops the half-written line a cut leaves, which was never in any file', () => {
    expect(finish('a finding\nsrc/router.ts:\n  12\tconst step = ru')).toBe('a finding\nsrc/router.ts:');
    // Nothing to keep: one line, and it is the half-written one
    expect(finish('const step = ru')).toBe('');
  });

  it('closes a fence the cut left open, so what follows is not read as code', () => {
    expect(finish('see below\n```ts\nconst a = 1;\nconst b = 2')).toBe('see below\n```ts\nconst a = 1;\n```');
    // A block the job did close is left exactly as it is
    expect(finish('```ts\nconst a = 1;\n```\nand then some prose that was cut')).toBe('```ts\nconst a = 1;\n```');
  });
});

describe('the room the job is given', () => {
  it('reads more of the record the larger the window, up to a ceiling', () => {
    expect(readable(32000)).toBeGreaterThan(BIT_LENGTH);
    expect(readable(200000)).toBeGreaterThan(readable(32000));
    // Past the ceiling a job holds more in mind than a model reliably does
    expect(readable(200000)).toBe(MAX_RECORD);
    expect(readable(1000000)).toBe(MAX_RECORD);
    // However small the window, a job is given a bit: one too small to read a
    // bit in is too small to have got here, and a job given nothing finds none
    expect(readable(2000)).toBe(BIT_LENGTH);
    expect(readable(null)).toBe(readable(DEFAULT_WINDOW));
  });

  it('leaves the record it reads and the notes it writes inside the window', () => {
    for (const window of [32000, 128000, 200000]) {
      const asked = Math.ceil((readable(window) + PROMPT.length) / 3.5) + notesRoom(window);
      expect(asked).toBeLessThan(window);
    }
  });

  it('reads only as much as the window allows, so a small window is not overrun', async () => {
    const many = Array.from({ length: 40 }, (_, i) => round(i + 1, 'z'.repeat(4000))).flat();
    await compact([task, ...many], { ...model, window: 16000 }, signal());
    const sent = String(jobs()[0].messages[0].content).match(/<record>\n([\s\S]*)\n<\/record>/)?.[1] ?? '';
    expect(sent).not.toBe('');
    expect(sent.length).toBeLessThanOrEqual(readable(16000));
    expect(sent.length).toBeLessThan(readable(DEFAULT_WINDOW));
  });
});

// Every compaction that failed in the log was a local model, and qwen3.5:9b
// came back with nothing three times over three tries, spending 274, 464 and
// 504 seconds to do it. Another try at the same model is the one thing
// measured not to work (see failoverTo in src/harness/compactor.ts).
describe('a job its own model cannot do', () => {
  // A local model to start from, and a hosted one to be moved to
  const hosted = (over: Record<string, unknown> = {}) => ({
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    name: 'Sonnet',
    local: false,
    disabled: false,
    sophistication: SOPHISTICATION.ADVANCED,
    ...over,
  });
  beforeEach(() => {
    mocks.isLocal.mockReturnValue(true);
    mocks.isOffline.mockReturnValue(false);
    mocks.listModels.mockResolvedValue({ models: [hosted()], providers: [] });
  });
  const nothingThenFound = () =>
    answer((n) =>
      n === 1
        ? [{ type: 'done', stopReason: 'end_turn' }]
        : [
            { type: 'text', delta: 'found it' },
            { type: 'done', stopReason: 'end_turn' },
          ]
    );

  it('moves the job to a hosted model rather than asking the local one again', async () => {
    nothingThenFound();
    const { messages } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'claude-sonnet-5-5']);
    expect(split(messages[0].content).carried).toBe('found it');
  });

  it('moves it once only, so a job cannot walk down the whole list of models', async () => {
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });

  it('makes the move even once the whole of it has spent what it may', async () => {
    // Which is what a local model that times out does: the budget is there to
    // stop the same model being asked twice, and this is a different one
    log.since.mockReturnValue(10 * 60 * 1000);
    nothingThenFound();
    const { messages } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'claude-sonnet-5-5']);
    expect(split(messages[0].content).carried).toBe('found it');
    log.since.mockReturnValue(7);
  });

  it('says where the job went, and what it was asked of, in what it logs', async () => {
    nothingThenFound();
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(log.info.mock.calls.map(([event]) => event)).toContain('compaction.failover');
    expect(log.info.mock.calls.find(([event]) => event === 'compaction.failover')?.[1]).toMatchObject({
      from: 'qwen',
      to: 'claude-sonnet-5-5',
    });
    // ...and the compaction itself names both ends of it
    expect(log.info.mock.calls.find(([event]) => event === 'compaction')?.[1]).toMatchObject({
      model: 'claude-sonnet-5-5',
      from: 'qwen',
    });
  });

  // Offline is the user saying nothing of theirs leaves the machine, and a
  // compaction is the whole of a conversation
  it('stays where it is while offline is switched on, and fails as it did', async () => {
    mocks.isOffline.mockReturnValue(true);
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const { messages } = await compact(given, model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'qwen', 'qwen']);
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(messages).toBe(given);
  });

  it.each([
    ['there is no hosted model to move it to', []],
    ['the only hosted model is switched off', [{ disabled: true }]],
    ['the only hosted model is not capable enough', [{ sophistication: SOPHISTICATION.BASIC }]],
  ])('stays where it is when %s', async (_why, over) => {
    mocks.listModels.mockResolvedValue({ models: over.map((one) => hosted(one)), providers: [] });
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'qwen', 'qwen']);
  });

  it('does not move a job that was already on a hosted model', async () => {
    mocks.isLocal.mockReturnValue(false);
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    await compact([task, ...round(1), ...round(2), ...round(3)], { provider: 'anthropic', model: 'sonnet' }, signal());
    expect(jobs().map((job) => job.model)).toEqual(['sonnet', 'sonnet', 'sonnet']);
  });

  it('keeps the compaction going when it cannot find out what there is to move to', async () => {
    mocks.listModels.mockRejectedValue(new Error('The provider could not be reached.'));
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs().map((job) => job.model)).toEqual(['qwen', 'qwen', 'qwen']);
  });
});

describe('how the job is run', () => {
  it('asks the job again when it comes back with nothing, before giving the compaction up', async () => {
    // Nothing the first time, findings the second
    answer((n) =>
      n === 1
        ? [{ type: 'done', stopReason: 'end_turn' }]
        : [
            { type: 'text', delta: 'found it' },
            { type: 'done', stopReason: 'end_turn' },
          ]
    );
    const { messages } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs()).toHaveLength(2);
    expect(split(messages[0].content).carried).toBe('found it');
  });

  it('asks again when the job throws on the way out, rather than giving up on the throw', async () => {
    let calls = 0;
    mocks.stream.mockImplementation(() =>
      (async function* () {
        if (++calls === 1) throw new Error('Socket hung up.');
        yield { type: 'text', delta: 'found it' } as ChatEvent;
        yield { type: 'done', stopReason: 'end_turn' } as ChatEvent;
      })()
    );
    const { messages } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(calls).toBe(2);
    expect(split(messages[0].content).carried).toBe('found it');
  });

  it('gives up after TRIES throws, leaving the messages as they were', async () => {
    mocks.stream.mockImplementation(() =>
      (async function* () {
        throw new Error('Socket hung up.');
      })()
    );
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const { messages } = await compact(given, model, signal());
    expect(jobs()).toHaveLength(TRIES);
    expect(messages).toBe(given);
  });

  it('asks no more than TRIES times, however often the job comes back empty', async () => {
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const { messages } = await compact(given, model, signal());
    expect(jobs()).toHaveLength(TRIES);
    expect(messages).toBe(given);
  });

  it('asks a job not to reason, which would spend the whole ceiling and return nothing', async () => {
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs()[0]).toMatchObject({ think: false, maxTokens: writingRoom(0, DEFAULT_WINDOW) });
  });

  it('runs one job for the whole turn, rather than one to each bit of it', async () => {
    const many = Array.from({ length: 6 }, (_, i) => round(i + 1, 'z'.repeat(4000))).flat();
    await compact([task, ...many], model, signal());
    expect(jobs()).toHaveLength(1);
    // Every round that was compacted is in the one record it was given, so it
    // can see what one round made of another; the latest are kept, not read
    const sent = String(jobs()[0].messages[0].content);
    for (let n = 1; n <= 4; n++) expect(sent).toContain(`f${n}.ts`);
    for (const n of [5, 6]) expect(sent).not.toContain(`f${n}.ts`);
  });

  it('reads as much of a long record as the window leaves room for, and says what it left', async () => {
    const many = Array.from({ length: 40 }, (_, i) => round(i + 1, 'z'.repeat(4000))).flat();
    await compact([task, ...many], model, signal());
    expect(jobs()).toHaveLength(1);
    const sent = String(jobs()[0].messages[0].content);
    expect(sent.length).toBeLessThanOrEqual(readable(DEFAULT_WINDOW));
    const { unread } = log.info.mock.calls.at(-1)![1] as { unread: number };
    expect(unread).toBeGreaterThan(0);
  });

  it('reads the latest bits, since the latest work is likeliest to still matter', async () => {
    const many = Array.from({ length: 40 }, (_, i) => round(i + 1, `marker${i} ${'z'.repeat(4000)}`)).flat();
    await compact([task, ...many], model, signal());
    const sent = jobs().map((j) => String(j.messages[0].content));
    // The first rounds never reach a job; the last ones do
    expect(sent.some((bit) => bit.includes('marker0 '))).toBe(false);
    expect(sent.some((bit) => bit.includes('marker35'))).toBe(true);
  });

  it('runs nothing at all once the work has been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const given = [task, ...round(1), ...round(2), ...round(3)];
    await expect(compact(given, model, controller.signal)).resolves.toMatchObject({ messages: given });
    expect(jobs()).toEqual([]);
  });
});

describe('how long a job is given', () => {
  // A job reads the whole record before it writes a word of it, and the flat
  // two minutes this had went on reading records it could not finish
  it('grows with the record it has to read, from a floor and up to a ceiling', () => {
    expect(timeoutFor(0)).toBe(120000);
    expect(timeoutFor(20000)).toBe(120000);
    expect(timeoutFor(60000)).toBe(180000);
    expect(timeoutFor(MAX_RECORD)).toBe(480000);
  });

  it('is what the job asks the provider for, for the record that job reads', async () => {
    const many = Array.from({ length: 12 }, (_, i) => round(i + 10, 'y'.repeat(5000))).flat();
    await compact([task, ...many], model, signal());
    const asked = jobs()[0];
    const sent = String(asked.messages[0].content);
    expect(asked.timeoutMs).toBeGreaterThan(120000);
    // From the record alone, so no more than the whole message it went in
    expect(asked.timeoutMs).toBeLessThanOrEqual(timeoutFor(sent.length));
  });

  // Three tries at a record the model cannot write up is three times the wait
  // for the same nothing, and the reply waits on all of it
  it('stops asking again once the whole of it has spent what it may', async () => {
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    log.since.mockReturnValue(10 * 60 * 1000);
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const { messages } = await compact(given, model, signal());
    // Tried once, and not again at the cost of another full-length try
    expect(jobs()).toHaveLength(1);
    expect(messages).toBe(given);
  });

  it('gives the tries to a job that fails without spending it', async () => {
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(jobs()).toHaveLength(TRIES);
  });
});

describe('what compacting takes', () => {
  it('reports what the job used', async () => {
    answer((n, record) => [
      { type: 'text', delta: standsFor(` finding ${n} `, record) },
      { type: 'done', stopReason: 'end_turn', usage: { input: 101, output: 10 } },
    ]);
    const many = Array.from({ length: 6 }, (_, i) => round(i + 10, 'y'.repeat(4000))).flat();
    const { usage } = await compact([task, ...many], model, signal());
    expect(jobs()).toHaveLength(1);
    expect(usage).toEqual({ input: 101, output: 10 });
  });

  it('counts a job whose model gave no counts as nothing, rather than failing', async () => {
    answer(() => [
      { type: 'text', delta: 'finding' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const { usage } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    expect(usage).toEqual({ input: 0, output: 0 });
  });

  it('counts what a job that failed had already used, over every try it was given', async () => {
    answer(() => [
      { type: 'done', stopReason: 'end_turn', usage: { input: 40, output: 5 } },
      { type: 'error', code: 'other', message: 'Connection lost.' },
    ]);
    const given = [task, ...round(1), ...round(2), ...round(3)];
    const { messages, usage } = await compact(given, model, signal());
    // The job is the whole compaction, so it is asked again before it is given
    // up on (see TRIES)
    expect(jobs()).toHaveLength(TRIES);
    expect(usage).toEqual({ input: 40 * TRIES, output: 5 * TRIES });
    // Nothing was found to carry over, so nothing was taken away either
    expect(messages).toBe(given);
  });

  it('reports nothing used when there was nothing old enough to compact', async () => {
    await expect(compact([task, ...round(1)], model, signal())).resolves.toMatchObject({
      usage: { input: 0, output: 0 },
    });
    expect(jobs()).toEqual([]);
  });
});

describe('compact', () => {
  it('replaces the older messages with what a model found in them, keeping the latest', async () => {
    const messages = [task, ...round(1), ...round(2), ...round(3), ...round(4)];
    const { messages: compacted } = await compact(messages, model, signal());

    expect(compacted).toEqual([
      {
        role: 'user',
        content: 'Explore the workspace.\n\n' + `${CARRIED}\n\n` + 'finding 1',
      },
      ...round(3),
      ...round(4),
    ]);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ ...model, system: PROMPT, log: { purpose: 'compaction' } });
    expect(jobs()[0].messages[0].content).toBe(
      '<record>\n' +
        'Looking at 1.\n' +
        'Called read_file with {"path":"f1.ts"}\n\n' +
        'Result of read_file:\n' +
        'result 1\n\n' +
        'Looking at 2.\n' +
        'Called read_file with {"path":"f2.ts"}\n\n' +
        'Result of read_file:\n' +
        'result 2\n' +
        '</record>\n\n' +
        // The job is told the size of what it is reading and what notes for a
        // record that size come to: a model told only to be brief writes a
        // line and stops (see asked)
        'Write the notes. A record of this size — 168 characters — usually needs notes of around 100 characters. ' +
        'Much shorter than that and you have dropped something the assistant needed. ' +
        `Quote at most ${quoteLines(168)} lines of code in total, across at most ${quoteBlocks(168)} fenced blocks.`
    );
  });

  it('never leaves a tool result without the call it answers', async () => {
    // Three results to one call: the cut falls after them, not among them
    const many: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: ['a', 'b', 'c'].map((id) => ({ id, name: 'read_file', input: {} })),
      },
      ...['a', 'b', 'c'].map((id): ChatMessage => ({
        role: 'tool',
        toolCallId: id,
        name: 'read_file',
        content: id,
        isError: false,
      })),
    ];
    const { messages: compacted } = await compact([task, ...round(1), ...many, ...round(2)], model, signal());
    expect(compacted.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(compacted.slice(1)).toEqual(round(2));
  });

  it('sends a long record to the one job whole, cut into pieces inside it', async () => {
    const messages = [task, ...round(1, 'a'.repeat(7000)), ...round(2, 'b'.repeat(20000)), ...round(3), ...round(4)];
    const { messages: compacted } = await compact(messages, model, signal());

    expect(jobs()).toHaveLength(1);
    const sent = String(jobs()[0].messages[0].content);
    // A result longer than a bit is still cut on a safe boundary, but the
    // pieces go to the same job rather than to one each
    expect(sent).toContain('a'.repeat(1000));
    expect(sent).toContain('b'.repeat(1000));
    expect(sent).toContain(CONTINUED);
    expect(split(compacted[0].content).carried.startsWith('finding 1')).toBe(true);
  });

  it('reads the findings of an earlier compaction again instead of losing them', async () => {
    const { messages: once } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    const before = jobs().length;
    const { messages: twice } = await compact([...once, ...round(4), ...round(5)], model, signal());
    // The findings so far went to a job of their own, first, so that what is
    // carried on is a condensation of the whole reply and not just its end
    expect(jobs()[before].messages[0].content).toContain('finding 1');
    expect(twice[0].content).toContain('finding 2');
    expect(twice.slice(1)).toEqual([...round(4), ...round(5)]);
  });

  it('leaves the messages alone when the record cannot be condensed, keeping the findings so far', async () => {
    const { messages: once } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    // From here on the job comes back with nothing, however often it is asked
    answer(() => [{ type: 'done', stopReason: 'end_turn' }]);
    const given = [...once, ...round(4), ...round(5)];
    const { messages: twice } = await compact(given, model, signal());
    // There is nothing to put in the record's place, so the record stays - and
    // with it the findings of the compaction before, which stand for messages
    // that are long gone and would be lost outright with them
    expect(twice).toBe(given);
    expect(split(twice[0].content).carried).toBe('finding 1');
    expect(log.warn).toHaveBeenCalledWith('compaction', expect.objectContaining({ summarized: 0 }));
  });

  it('keeps the task itself whole, with the findings standing in for the rest', async () => {
    const { messages: once } = await compact([task, ...round(1), ...round(2), ...round(3)], model, signal());
    const { task: instruction, carried } = split(once[0].content);
    expect(instruction).toBe('Explore the workspace.');
    expect(carried).toBe('finding 1');
    // A message that was never compacted is all task and no findings
    expect(split('Explore the workspace.')).toEqual({ task: 'Explore the workspace.', carried: '' });
  });

  it('does not grow the task message as a reply is compacted over and over', async () => {
    // Each job answers at the length a real one does, so that findings piled
    // on findings would show
    answer((n) => [
      { type: 'text', delta: `finding ${n} ${'detail '.repeat(400)}` },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    let messages: ChatMessage[] = [task];
    const lengths: number[] = [];
    for (let round_ = 1; round_ <= 10; round_++) {
      messages = [...messages, ...round(round_, 'z'.repeat(9000))];
      ({ messages } = await compact(messages, model, signal()));
      lengths.push(split(messages[0].content).carried.length);
    }
    // The findings level off instead of climbing with every pass. Growing
    // was what filled the window before, and so brought on a compaction at
    // every step for the rest of the reply.
    const settled = lengths.slice(4);
    expect(Math.max(...settled)).toBeLessThanOrEqual(settled[0] * 1.1);
    expect(Math.max(...settled)).toBeLessThan(CARRIED_BITS * 8200);
  });

  it('reads the findings so far first, even when the new work alone would fill the job', async () => {
    const carried = `${task.content}\n\n${CARRIED}\n\nwhat came before`;
    const many = Array.from({ length: 40 }, (_, i) => round(i + 1, 'z'.repeat(4000))).flat();
    await compact([{ role: 'user', content: carried }, ...many], model, signal());
    expect(jobs()).toHaveLength(1);
    const sent = String(jobs()[0].messages[0].content);
    expect(sent).toContain('what came before');
    // ...and they come first, so the job reads the reply in the order it happened
    expect(sent.indexOf('what came before')).toBeLessThan(sent.indexOf('read_file'));
  });

  it('leaves a short conversation alone, adding the findings to its last message', async () => {
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Now change the parser.' },
    ];
    const { messages: compacted } = await compact(
      [...conversation, ...round(1), ...round(2), ...round(3), ...round(4)],
      model,
      signal(),
      3
    );
    expect(compacted).toEqual([
      conversation[0],
      conversation[1],
      {
        role: 'user',
        content: 'Now change the parser.\n\n' + `${CARRIED}\n\n` + 'finding 1',
      },
      ...round(3),
      ...round(4),
    ]);
    // Only this reply's tool calls went to the compaction job, not the conversation
    expect(jobs()[0].messages[0].content).not.toContain('First answer.');
  });

  it('does nothing when the conversation leaves nothing of the reply old enough to compact', async () => {
    const conversation: ChatMessage[] = [
      task,
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'More.' },
    ];
    const messages = [...conversation, ...round(1), ...round(2)];
    await expect(compact(messages, model, signal(), 3)).resolves.toMatchObject({ messages });
  });

  it('marks a failed tool call as failed in the record', async () => {
    const failed: ChatMessage = {
      role: 'tool',
      toolCallId: 'c1',
      name: 'search_workspace',
      content: 'no answer',
      isError: true,
    };
    await compact([task, round(1)[0], failed, ...round(2), ...round(3)], model, signal());
    expect(jobs()[0].messages[0].content).toContain('Result of search_workspace (failed):\nno answer');
  });

  // Measured in the log: a job answered 72,427 characters of record with 51 of
  // notes and was taken at its word, so the assistant lost everything it had
  // found and went looking for it again
  it('treats notes too short to stand for the record as a job that failed', async () => {
    answer((n, record) => [
      // A line or two, whatever it was given
      { type: 'text', delta: n < TRIES ? 'Looked at some files.' : standsFor(` finding ${n} `, record) },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const many = Array.from({ length: 6 }, (_, i) => round(i + 1, 'y'.repeat(4000))).flat();
    const { messages: compacted } = await compact([task, ...many], model, signal());

    // Asked again rather than taken, and what it said is not what stands for
    // the record
    expect(jobs()).toHaveLength(TRIES);
    expect(compacted[0].content).not.toContain('Looked at some files.');
    expect(compacted[0].content).toContain(`finding ${TRIES}`);
    expect(log.warn).toHaveBeenCalledWith(
      'compaction.try',
      expect.objectContaining({ error: 'The job came back with too little to stand for the record.' })
    );
  });

  it('leaves the messages alone when every try comes back too short to stand for it', async () => {
    answer(() => [
      { type: 'text', delta: 'Looked at some files.' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const many = Array.from({ length: 6 }, (_, i) => round(i + 1, 'y'.repeat(4000))).flat();
    const messages = [task, ...many];
    const { messages: compacted } = await compact(messages, model, signal());
    // Nothing is put in the record's place: taking it away and putting a line
    // there would cost the assistant everything it had found
    expect(compacted).toBe(messages);
  });

  it('asks for no more than a short record can give, rather than for nothing at all', () => {
    // Rounded to the nearest hundred, a small record would otherwise be told
    // its notes should come to none
    expect(enough('x'.repeat(2), 'y'.repeat(100))).toBe(true);
    expect(enough('x', 'y'.repeat(100))).toBe(false);
  });

  it('still makes room when only some bits could be summarized', async () => {
    // The first job fails, the rest answer
    answer((n, record) =>
      n === 1
        ? [{ type: 'error', code: 'other', message: 'boom' }]
        : [
            { type: 'text', delta: standsFor(` finding ${n} `, record) },
            { type: 'done', stopReason: 'end_turn' },
          ]
    );
    const many = Array.from({ length: 6 }, (_, i) => round(i + 1, 'y'.repeat(4000))).flat();
    const { messages: compacted } = await compact([task, ...many], model, signal());
    expect(compacted[0].content).toContain('What you found earlier');
    expect(compacted[0].content).not.toContain('finding 1');
    expect(compacted[0].content).toContain('finding 2');
  });

  it('leaves the messages exactly as they were when no bit could be summarized', async () => {
    answer(() => [{ type: 'error', code: 'other', message: 'boom' }]);
    const given = [task, ...round(1), ...round(2), ...round(3), ...round(4)];
    // Taking the results away and putting nothing in their place would lose
    // the model everything it had found
    await expect(compact(given, model, signal())).resolves.toMatchObject({ messages: given });
    expect(log.warn).toHaveBeenCalledWith('compaction', expect.objectContaining({ ok: false, summarized: 0 }));
  });

  it('leaves the messages alone when none are old enough to compact', async () => {
    const messages = [task, ...round(1)];
    await expect(compact(messages, model, signal())).resolves.toMatchObject({ messages });
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
