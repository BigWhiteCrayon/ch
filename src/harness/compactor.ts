// Keeps a long tool-driven piece of work inside its model's context window.
// When the conversation so far (mostly tool results) is close to filling the
// window, the older part of it is handed to a compaction job: a model that
// boils the whole of it down to what was learned from it. Those findings then
// stand in for the messages they came from.
//
// One job reads the whole turn, rather than one job to each bit of it. Jobs
// split over a record cannot see each other's part of it: work that a later
// bit had overtaken was written up from an earlier one as though it still
// stood, and what came back was several accounts of the same overlapping work.
// One job sees the record whole, so it can drop what was superseded, say a
// thing once, and spend its room on what is left. Against that, it is the only
// job there is — where a failed bit used to cost an eighth of the record, a
// failed job now costs the whole compaction, so it is tried twice before that
// is accepted (see TRIES).
//
// A reply is usually compacted more than once, and each compaction reads the
// findings of the one before along with the new work, so that what it leaves
// behind is a condensation of the whole reply. Carrying those findings
// forward unread instead would add to them every time, until the findings
// alone filled the window they are there to keep room in and every step of
// the reply ended in another compaction.
//
// Prose is enough for most of what a tool returned, but not for code the
// assistant is working on: a summary of a function it is about to edit would
// be trusted and would be wrong. So a job is asked to carry the code that
// still matters through verbatim, line numbers and all, and to put only the
// rest in its own words (see PROMPT).
//
// compact() never throws. A job that comes back with nothing leaves nothing to
// put in the record's place, so the messages are left exactly as they were:
// taking them away and putting nothing there would cost the model everything
// it had found and save it only room it cannot use.

import * as llm from '../llm';
import { SOPHISTICATION } from '../llm/sophistication';
import { CHARS_PER_TOKEN, sizeOf } from '../llm/tokens';
import * as log from '../log';
import { cheapestFirst } from './router';
import type { ChatMessage, Usage } from '../types';

// How full the window may get before the older messages are compacted. The
// rest is left for the next tool results and the model's own writing.
//
// It was six tenths while every result a reply had read stayed in front of it to
// the end. It went to eight tenths once a note set aside what it was written
// from, because the room a reply needed then came back to it as it went, and
// condensing at six tenths was spending a pass over the model on room that was
// about to be freed anyway.
//
// Setting results aside is off for now (see SETTING_ASIDE in ./index.ts), so
// every result a reply reads stays in front of it again and this is once more
// the only thing that frees any room. It is seven tenths, between the two:
// low enough that a reply has room left for the next results while the job
// runs, without going back to six until that is measured (evals/compaction.ts).
//
// Every figure above was arrived at while the count this is compared against
// ran a fifth low (see CHARS_PER_TOKEN in ../llm/tokens.ts, since corrected),
// so a reply condensed at "seven tenths" was really at something nearer nine.
// Seven tenths now means seven tenths, which is the mark those measurements
// were reaching for; what they show about where it belongs is unchanged, but
// the next measurement is the first one taken at the mark it names.
const FULL = 0.7;
// Assumed for a model that doesn't say how large its window is
export const DEFAULT_WINDOW = 32000;
// The latest messages are kept as they are: the model is still working from them
const KEEP_RECENT = 4;
// What the record is cut into, so that it can be cut down to the room a job has
// without the cut falling anywhere it would do harm (see pieces)
export const BIT_LENGTH = 8000;
// At most this many bits of what a job reads may be findings carried from an
// earlier compaction. They are read again, and condensed along with the new
// work, rather than simply kept: a compaction that only ever added to them
// would grow the task message without bound, until the findings alone filled
// the window they exist to keep room in.
export const CARRIED_BITS = 4;
// Tries the job gets. It is the whole compaction now, so a job that comes back
// with nothing no longer costs an eighth of the record as a failed bit did: it
// costs the reply, which carries on filling a window that nothing will free
// and ends for want of room (see OUT_OF_ROOM in ./index.ts). Three, because
// that makes another try far cheaper than the turn it saves, and because the
// failures measured are mostly a model writing nothing at all — about one job
// in seven over eighteen compactions of real work — which another try often
// gets past.
export const TRIES = 3;
// Room for a job's notes at its largest. It writes up the whole turn rather
// than one bit of it: measured over eighteen compactions of real work, the
// eight jobs this used to run wrote 5,261 tokens between them, at most 7,459.
const MAX_TOKENS = 8000;
// The most record one job will read, however much room its window leaves.
// Past this a job is being asked to hold more in mind at once than a model
// reliably does, and code comes back paraphrased where it was to be quoted,
// which is the one thing a compaction must not do. This is the knob: raise it
// and more of a long turn reaches the job, at that risk (evals/compaction.ts).
export const MAX_RECORD = 240000;
// Taken off the room a job is given to read, since CHARS_PER_TOKEN is an
// estimate and a record that overruns the window is refused outright. It
// therefore has to cover the densest record and not the average one:
// CHARS_PER_TOKEN is the mean of what 45 real prompts measured against
// anthropic's count (2.79 characters a token), and the densest of them came to
// 2.39, so 2.39/2.8 is where this sits. It was 0.9, which against the old
// CHARS_PER_TOKEN of 3.5 handed a job 3.15 characters for every token of room
// it had — a sixth more record than its window held on ordinary content, and
// a third more on the densest.
const MARGIN = 0.85;
// How long one job may take. The jobs go to the provider at once but a local
// one serves them in turn, so this is passed as the request's own limit rather
// than imposed here with a timeout of our own: a limit set here would start
// while the job was still queued behind the others, and all but the first
// would spend it waiting and be cut off without having run (see ../llm).
//
// It was a flat two minutes, and a job has to read the whole record before it
// can write a word of it: measured on qwen3.5:9b, a job on a 55,000-character
// record was cut off at two minutes having written 149 characters, and one on
// 72,694 characters having written 19 — all of it spent reading. The same
// record read again, from the cache, was written up in 91 seconds. So a job
// that is cut off before it has written anything was never given long enough
// to answer, and the two minutes stand as the floor rather than the whole.
//
// Three milliseconds a character over that floor, from the reading rate those
// cut-off jobs show (around 460 characters a second) and the writing rate of
// the ones that finished (around 85), which puts a 55,000-character record at
// under three minutes and the largest a window allows at the ceiling below.
// The timeout is a backstop and not a schedule: a hosted model is through it
// in a tenth of the time, and nothing waits on it that has not already gone
// wrong.
const TIMEOUT_MS = 120000;
const MS_PER_CHAR = 3;
const LONGEST_MS = 480000;
export const timeoutFor = (chars: number): number =>
  Math.min(LONGEST_MS, Math.max(TIMEOUT_MS, Math.round(chars * MS_PER_CHAR)));

// What the whole compaction may spend, however its tries fail.
//
// The tries are worth having because most failures cost almost nothing: a job
// that comes back with nothing comes back at once, and another try gets past
// it (see TRIES). A job cut off by the timeout is the other kind — it spent
// the lot, and a model writing a copy of the record will spend it again, which
// is what three tries at a record it cannot write up did: six minutes of a
// reply for nothing, and the subagent waiting on it cut off at thirteen. So
// the fast failures keep their tries and the slow ones do not: one full-length
// try, and half as much again for a retry that reads the record from the cache
// rather than afresh.
const budgetFor = (chars: number): number => Math.round(timeoutFor(chars) * 1.5);

// What the findings are put under, in the message that stands in for the
// record they were taken from
export const CARRIED = `What you found earlier (the tool results themselves have been set aside to save room; any code
below is quoted from them exactly as it was):`;

export const PROMPT = `You are given part of the record of an assistant working in a project: the tools it called and
what came back. The assistant carries on from your notes alone — the record itself is being set aside to save room.

The project's files are still there, and the assistant can open any of them again at the cost of a tool call. What
it cannot get back is what it worked out: what it looked for, what it found, what it tried, what did not work, what
it had decided to do next. None of that is written down anywhere else, and the assistant will not know that it is
missing — it will simply go looking for what it has already found. That is what your notes are for.

Write three things, in this order.

First, where the work stands: what the assistant is doing, what it has settled, and what it was about to do next.

Second, what it found out, each in a line or two, with the exact paths, names, commands, values and line numbers the
fact rests on — src/search/embeddings.ts:620-648, not "the embeddings file". Keep all of them: what matters here is
how many of the facts survive, not how few words each one takes. Where you are unsure whether a finding belongs,
keep it.

Third, the code, last of all. Keep it exactly as the record shows it, character for character, in a fenced block
under the path it came from, with the line numbers the record gives it so that the assistant can say which lines it
means. Do not retype it from memory, tidy it, shorten it, or describe it in words instead. A paraphrase of code the
assistant is about to edit is worse than no code at all, because it will be trusted and it will be wrong.

You are told below how many lines you may quote. Spend them in this order: first on code that is in the record and
nowhere else — an edit the assistant has written but not saved, what a command printed, a diff, the text of a
failing test; then on the code its next edit has to match — the function it is changing, the signature it is
calling, the test it has to satisfy. When those are down, stop quoting.

Code the assistant read from a file to find something out is not quoted at all: it is a path, a range of lines and a
sentence saying what is there. The file has not gone anywhere, and a sentence is what tells the assistant whether to
open it again. If you reach the limit you were given, write the path and the line range instead and carry on in
prose.

If you run out of room, it is the quotations at the end that should be missing, and not the findings above them.

You are not being judged on how short your notes are — but quoting past the limit is how notes come to be long. No
preamble, and nothing but the notes and the code blocks.`;

// Room for a job's notes, which is MAX_TOKENS unless its window is too small to
// give that much away: a job left no room to write in has read for nothing.
export function notesRoom(window?: number | null): number {
  return Math.max(1000, Math.min(MAX_TOKENS, Math.floor((window ?? DEFAULT_WINDOW) / 4)));
}

// What one job may read, in characters of record: what its window leaves once
// its own prompt and its notes have their room, less MARGIN, and never more
// than MAX_RECORD. At least one bit either way — a window too small to read a
// bit in is too small to have got here, and a job given nothing finds nothing.
export function readable(window?: number | null): number {
  const spare = (window ?? DEFAULT_WINDOW) - notesRoom(window) - Math.ceil(PROMPT.length / CHARS_PER_TOKEN);
  return Math.max(BIT_LENGTH, Math.min(MAX_RECORD, Math.floor(spare * CHARS_PER_TOKEN * MARGIN)));
}

// Roughly how many tokens the messages take up (see ../llm/tokens.ts)
export const size = sizeOf;

// Whether messages of this size are close to filling a window of that many tokens
export function nearlyFull(tokens: number, window: number | null | undefined): boolean {
  return tokens > (window ?? DEFAULT_WINDOW) * FULL;
}

// A task message that has been compacted before carries the findings so far
// after the task itself (see the end of compact). This takes the two apart,
// so that the findings can be compacted again with the rest of the record
// instead of being carried forward whole.
export function split(content: string): { task: string; carried: string } {
  const separator = `\n\n${CARRIED}\n\n`;
  const at = content.indexOf(separator);
  if (at === -1) return { task: content, carried: '' };
  return { task: content.slice(0, at), carried: content.slice(at + separator.length) };
}

// The messages as a record a model can read
export function record(messages: ChatMessage[]): string[] {
  return messages.map((m) => {
    if (m.role === 'tool') return `Result of ${m.name}${m.isError ? ' (failed)' : ''}:\n${m.content}`;
    const calls = 'toolCalls' in m && m.toolCalls ? m.toolCalls : [];
    const called = calls.map((call) => `Called ${call.name} with ${JSON.stringify(call.input)}`);
    return [m.content.trim(), ...called].filter(Boolean).join('\n');
  });
}

// A fenced block opens and closes with the same run of backticks or tildes, so
// one line does both and which it is depends on whether a block is open.
const FENCE = /^\s*(`{3,}|~{3,})/;
// How much of a line is replayed at the top of a continuation piece: enough for
// a path or a heading, little enough that the replay cannot crowd out the work
const LEAD_LENGTH = 200;
// Room kept in every piece for the lines replayed at the top of it and the
// fence closed at the bottom
const RESERVE = 4 * LEAD_LENGTH;
// Marks a piece that starts in the middle of the entry it was cut from, so that
// a job does not read it as the beginning of something
export const CONTINUED = '(continues)';

// The marker of the block this line opens or closes, or '' if it is not a fence.
// Long runs are read as the first ten characters alone: a fence of thirty
// backticks still pairs with itself, and no single line can eat the reserve.
const fenceOf = (line: string): string => FENCE.exec(line)?.[1].slice(0, 10) ?? '';

// A line as it is replayed at the top of a continuation piece
const lead = (line: string): string =>
  line.trim().length > LEAD_LENGTH ? `${line.trim().slice(0, LEAD_LENGTH)}…` : line.trim();

// One line as runs of at most `limit` characters
function runs(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const result: string[] = [];
  for (let at = 0; at < line.length; at += limit) result.push(line.slice(at, at + limit));
  return result;
}

// Splits one entry into pieces of at most BIT_LENGTH characters.
//
// The cut falls between lines, never inside one. A job is asked to quote the
// code it is given character for character, and it will do that to half a line
// as readily as to a whole one: the notes then hold a line of code that was
// never in the file, under the path it was never at, and the assistant edits
// against it.
//
// A cut inside a fenced block closes the fence above the cut and opens another
// below it, and the continuation piece replays the line the block was filed
// under along with the fence itself. Findings read again are fenced by
// construction — the prompt asks for the code in fences, under its path — so
// they are what this is mostly for: without it one half of a block arrives as
// code with no fence and no path, which is how a job comes to put a file's
// contents in its own words, and the other half arrives as a fence that never
// closes, which is how it comes to fence prose as though it were quoted.
//
// Every piece after the first also opens with the entry's first line, which is
// what says where the rest of it came from — the call, for a tool result.
//
// A single line longer than a piece has no boundary to cut on and is cut where
// it must be; all that can be kept for it is which entry it belongs to.
export function pieces(entry: string): string[] {
  if (entry.length <= BIT_LENGTH) return [entry];
  const head = `${lead(entry.split('\n', 1)[0])} ${CONTINUED}`.trim();
  const result: string[] = [];
  let piece: string[] = [];
  // The marker of the block open at this line, and the lines that open it again
  // in the next piece
  let fence = '';
  let opening: string[] = [];
  // The line before this one, which is where the path of a block that starts
  // here will be
  let previous = '';
  const length = () => piece.reduce((n, line) => n + line.length + 1, 0);
  const flush = () => {
    if (piece.length === 0) return;
    result.push([...piece, ...(fence ? [fence] : [])].join('\n'));
    piece = [head, ...opening];
  };
  for (const line of entry.split('\n')) {
    for (const run of runs(line, BIT_LENGTH - RESERVE)) {
      // Room for the line, and for the fence that would close an open block
      if (piece.length > 0 && length() + run.length + 1 + (fence ? fence.length + 1 : 0) > BIT_LENGTH) flush();
      piece.push(run);
      const marker = fenceOf(run);
      if (marker && !fence) {
        fence = marker;
        // Inside a block the path it is filed under is the line above it
        opening = [...(previous.trim() && !fenceOf(previous) ? [lead(previous)] : []), run.trim()];
      } else if (marker && marker === fence) {
        [fence, opening] = ['', []];
      }
      previous = run;
    }
  }
  flush();
  return result;
}

// Splits the record into bits of at most BIT_LENGTH characters, cutting an
// entry that is longer than that on its own (see pieces)
export function bits(entries: string[]): string[] {
  const result: string[] = [];
  let bit = '';
  for (const entry of entries.filter(Boolean)) {
    for (const piece of pieces(entry)) {
      if (bit && bit.length + piece.length > BIT_LENGTH) {
        result.push(bit);
        bit = '';
      }
      bit += `${bit ? '\n\n' : ''}${piece}`;
    }
  }
  if (bit) result.push(bit);
  return result;
}

// The job goes to the model that is answering, rather than to a smaller one.
// That was tried: a local provider serves one request at a time, so the eight
// jobs this used to run held the reply behind them for minutes, and handing
// them to a 3B instead looked like free speed.
//
// It is not. Measured against evals/compaction.ts, llama3.2:3b wrote notes
// *longer* than the record they replaced in four cases of six, fenced its own
// prose as though it were quoted code, and on the longest record returned
// nothing at all for every job — which drops the bit and leaves the reply
// carrying on without the file it was reading. qwen3.5:9b wrote none of those
// faults. A compaction is the only copy of the work it stands for, so it goes
// to the better model, and the reply waits for it.

// Exported for the evals, which judge this prompt against records whose
// findings are known (see evals/compaction.ts)
// What the job is asked for, with the size of what it is reading. A model
// told only to be brief writes a line and stops; told what notes for a record
// this size come to, it has something to measure its own answer against. The
// share is what a job that worked came back with, measured over the log:
// 7,252 characters of notes for 61,924 of record.
export const TENTH = 0.1;
// The least a job's notes can come to and still stand for the record. What
// they replace is about to be thrown away, so a job that answers a record of
// tens of thousands of characters with a line or two has not condensed it, it
// has lost it — and the assistant cannot tell, so it goes looking again for
// what it already found. Well under the tenth a job that worked comes back
// with, and well over what a job that has given up writes: measured over the
// log, 7,252 characters of notes for 61,924 of record against 51 for 72,427.
export const FLOOR = 0.02;
export const enough = (notes: string, record: string) => notes.trim().length >= record.length * FLOOR;
// What notes for a record this size come to, in characters. To the nearest
// hundred, since it is a sense of scale and not a quota — but never rounded
// away to nothing, which is what a short record would do to it and which would
// read as an instruction to write nothing at all.
export const targetFor = (chars: number): number => Math.max(100, Math.round((chars * TENTH) / 100) * 100);

// What the job is asked for, with the numbers that depend on the record in
// front of it. They go here rather than in PROMPT because this is the last
// thing the job reads before it answers, and because a budget has to be a
// number: the system prompt can only say that there is one.
const asked = (record: string) => {
  const target = targetFor(record.length);
  return (
    `Write the notes. A record of this size — ${record.length} characters — usually needs notes of around ` +
    `${target} characters. Much shorter than that and you have dropped something the assistant needed. ` +
    `Quote at most ${quoteLines(record.length)} lines of code in total, across at most ` +
    `${quoteBlocks(record.length)} fenced blocks.`
  );
};

// The share of a job's notes that may be quoted code. The rest is prose: the
// findings, which are the part nothing else can recover. A third, because the
// jobs that worked came back at about that — and because the failure this
// bounds is a job at ten tenths, copying the record back out.
export const QUOTE_SHARE = 1 / 3;
// A line of code, near enough, for turning a share of the notes into a number
// of lines. A number is the thing a small model can hold to; "which code the
// assistant still needs" is not.
const CHARS_PER_LINE = 40;
// Lines a job may quote, and the blocks it may spread them over.
//
// The floor is what two whole functions come to, so that on the records this
// was measured against — a few thousand characters, one or two functions that
// matter — the budget binds on nothing and the prompt is left to do the work.
// It starts to bite at about 48,000 characters of record, which is where the
// transcribing begins: the job that ran a window out was given 70,904.
export const MOST_LINES = 120;
const FEWEST_LINES = 40;
export const quoteLines = (chars: number): number =>
  Math.max(FEWEST_LINES, Math.min(MOST_LINES, Math.round((targetFor(chars) * QUOTE_SHARE) / CHARS_PER_LINE)));
export const quoteBlocks = (chars: number): number => Math.max(3, Math.min(8, Math.round(quoteLines(chars) / 12)));

// How far past the target a job may write before it is cut off. The target is
// what a job that worked comes back with; a job writing twice that is not
// writing longer notes, it is copying the record out, which is the failure
// this is here to stop.
export const OVERRUN = 2;

// The tokens a job may write. It was the whole of notesRoom, which is a
// quarter of the window — four times over what the job is asked for, so a
// model that reads "quote the code exactly" as "copy the record out" met no
// ceiling at all and ran until the timeout cut it off, by which point its
// notes were thrown away for having never finished (see summarize).
//
// Measured on the failure that prompted this: a 70,904-character record, a
// target of 7,100 characters, and a job still transcribing src/main.ts at
// 14,596 characters when 213 seconds ran out. A ceiling of twice the target
// stops that job in about forty seconds, with its notes kept.
//
// Never below notesRoom's own floor, and never above what the window allows:
// this is a cap on a job that is writing too much, not a second opinion on how
// much room there is.
export function writingRoom(chars: number, window?: number | null): number {
  const cap = Math.ceil((targetFor(chars) * OVERRUN) / CHARS_PER_TOKEN);
  return Math.min(notesRoom(window), Math.max(1000, cap));
}

// What is usable of notes that were cut off part-way, either by the timeout or
// by the ceiling above.
//
// A job stopped mid-stream leaves its last line half-written and, if it was
// quoting, a fence it never closed. The half-line goes: a line of code that
// was never in the file, filed under a path it was never at, is the one thing
// a compaction must not hand on, and the assistant cannot tell that it is
// half a line. The fence is then closed, so that whatever follows the notes in
// the message is not read as more quoted code.
//
// Everything above that last line stands: it is as much of the record as the
// job got to, which is worth more to the assistant than nothing at all. How
// much it is worth depends on what the job wrote first, which is the prompt's
// to settle and not this.
export function finish(text: string): string {
  const cut = text.lastIndexOf('\n');
  const kept = cut === -1 ? '' : text.slice(0, cut);
  let fence = '';
  for (const line of kept.split('\n')) {
    const marker = fenceOf(line);
    if (marker && !fence) fence = marker;
    else if (marker && marker === fence) fence = '';
  }
  return (fence ? `${kept}\n${fence}` : kept).trim();
}

export async function summarize(
  bit: string,
  provider: string,
  model: string,
  signal: AbortSignal,
  maxTokens = MAX_TOKENS
): Promise<{ text: string; usage: Usage }> {
  const events = llm.stream(
    {
      provider,
      model,
      system: PROMPT,
      messages: [{ role: 'user', content: `<record>\n${bit}\n</record>\n\n${asked(bit)}` }],
      maxTokens,
      // No reasoning: a model that reasons would spend the whole of the
      // ceiling above on it and come back with nothing to show
      think: false,
      timeoutMs: timeoutFor(bit.length),
      log: { purpose: 'compaction' },
    },
    signal
  );
  let text = '';
  // Counted even when the job fails part-way: the tokens were spent either way
  const usage: Usage = { input: 0, output: 0 };
  // Whether what came back is all the job meant to write, or as far as it got.
  // What it got to is kept either way — the notes it had written when the
  // timeout cut it off are notes, and throwing them away leaves the record
  // with nothing to stand in its place and the reply filling a window that
  // nothing will free (see TRIES). It is the caller that decides whether what
  // arrived is enough to stand for the record (see enough).
  let cut = false;
  for await (const event of events) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'done') {
      if (event.usage) {
        usage.input += event.usage.input;
        usage.output += event.usage.output;
      }
      // The ceiling, not the end of what it had to say
      if (event.stopReason === 'length') cut = true;
    }
    if (event.type === 'error') {
      cut = true;
      break;
    }
  }
  return { text: cut ? finish(text) : text.trim(), usage };
}

// What compacting took: the messages to carry on with, and the tokens the
// compaction jobs used, which the caller reports (see harness/index.ts).
// `messages` is the array it was given, unchanged, when nothing was compacted.
export interface Compaction {
  messages: ChatMessage[];
  usage: Usage;
  // The notes the job wrote, when it wrote any. They go into the messages as
  // the record's stand-in, and they are given back as well so that the caller
  // can keep them past the end of this reply: they are a condensation of
  // everything the reply did, written at cost, and the task message they stand
  // in is gone the moment the reply ends (see harness/index.ts).
  findings?: string;
}

// The least capable hosted model worth moving a failed job to. A compaction is
// the only copy of the work it stands for, so moving it to something that
// would write the same nothing buys another wait and no notes.
export const FAILOVER_FLOOR = SOPHISTICATION.CAPABLE;

// Where to send a job its own model could not do, or null if there is nowhere.
//
// Measured over the log: every compaction that failed was a local model, and
// qwen3.5:9b came back with nothing three times over three tries, spending
// 274, 464 and 504 seconds to do it. A model that returned nothing is not a
// model another try will get an answer out of, and the reply it is holding up
// ends for want of room (see TRIES). So the job moves once, to a model on
// another computer, which is the one thing about it that is different.
//
// Offline is the user saying nothing of theirs leaves the machine, and a
// compaction is the whole of a conversation. So it is asked here, before any
// model is looked for, and not only answered by the empty list that
// llm.listModels() returns while the switch is on: the job stays where it is
// and fails as it did, which is the honest outcome of the switch.
export async function failoverTo(from: string): Promise<{ provider: string; model: string } | null> {
  if (llm.isOffline() || !llm.isLocal(from)) return null;
  try {
    const { models } = await llm.listModels();
    const hosted = models
      .filter((m) => !m.local && !m.disabled && m.sophistication >= FAILOVER_FLOOR)
      .sort(cheapestFirst);
    return hosted.length > 0 ? { provider: hosted[0].provider, model: hosted[0].id } : null;
  } catch {
    // Nothing to move it to that can be found out about; the job stays put
    return null;
  }
}

// Compacts everything between the messages that set the task and the latest
// few, which are kept. Returns the messages to carry on with: the task with
// the findings so far added to it, then the latest messages. Returns the
// messages unchanged if there is nothing old enough to compact.
// head: how many messages, from the start, set the task and are left as they
// are: one for a piece of work with a single instruction, or the whole of the
// conversation so far for a reply to it. The last of them must be the user's.
export async function compact(
  messages: ChatMessage[],
  { provider, model, window }: { provider: string; model: string; window?: number | null },
  signal: AbortSignal,
  head = 1
): Promise<Compaction> {
  // The kept part must start with the model's own turn, so that no tool
  // result is left without the call it answers
  let keepFrom = Math.max(head, messages.length - KEEP_RECENT);
  while (keepFrom < messages.length && messages[keepFrom].role !== 'assistant') keepFrom++;
  const [before, task] = [messages.slice(0, head - 1), messages[head - 1]];
  const [old, recent] = [messages.slice(head, keepFrom), messages.slice(keepFrom)];
  const usage: Usage = { input: 0, output: 0 };
  if (old.length === 0 || task?.role !== 'user') return { messages, usage };

  const started = performance.now();
  const { task: instruction, carried: earlier } = split(task.content);
  // The findings so far go in at the front, oldest first, so that what comes
  // out is a condensation of the whole reply rather than the latest part of
  // it piled on top of the rest
  const carriedParts = bits(earlier ? [earlier] : []);
  const newParts = bits(record(old));
  // Whatever else goes unread, the findings so far are read: they stand for
  // every message already set aside, so letting them go loses all of it
  const keptCarried = carriedParts.slice(Math.max(0, carriedParts.length - CARRIED_BITS));
  // What is left of the job's reading room once the findings have had their
  // share of it
  const spare = readable(window) - keptCarried.reduce((n, bit) => n + bit.length + 2, 0);
  // The new work, latest first, for as long as there is room: the latest is
  // likeliest to still matter. One bit is read whether or not it fits, since a
  // job given none of the new work has nothing to condense.
  const readNew: string[] = [];
  let taken = 0;
  for (let at = newParts.length - 1; at >= 0; at--) {
    const next = taken + newParts[at].length + 2;
    if (readNew.length > 0 && next > spare) break;
    readNew.unshift(newParts[at]);
    taken = next;
  }
  const read = [...keptCarried, ...readNew];
  const unread = carriedParts.length - keptCarried.length + (newParts.length - readNew.length);
  // The whole of it as one record, which is what the one job reads
  const whole = read.join('\n\n');
  const findings: string[] = [];
  let summarized = 0;
  let tries = 0;
  // Asked again however the job failed — nothing written, an error from the
  // provider, or a throw on the way there — so each try stands on its own
  // rather than one throw ending them all (see TRIES). No wait between them:
  // what fails is mostly a model writing nothing, where waiting buys nothing,
  // and a provider that wants waiting for is waited for a step further down
  // (see ../llm/index.ts backoff). Never after the work has been cancelled.
  const budget = budgetFor(whole.length);
  // Where the job is being done, which is not always where it started: a local
  // model that fails is moved on rather than asked again (see failoverTo)
  let using = { provider, model };
  let moved = false;
  // Whether the try about to be made is the first on a model it has not been
  // tried on, which is the try likeliest to be the one that works. It is made
  // whatever the budget says, because the budget is there to stop a model
  // being asked twice for what it has already failed to write — and this is
  // not that.
  let fresh = false;
  while (!signal.aborted && summarized === 0 && tries < TRIES) {
    // The first try is always made; another only while the whole of it has
    // not spent what it may (see budgetFor)
    if (tries > 0 && !fresh && log.since(started) >= budget) break;
    fresh = false;
    tries++;
    try {
      const note = await summarize(whole, using.provider, using.model, signal, writingRoom(whole.length, window));
      usage.input += note.usage.input;
      usage.output += note.usage.output;
      if (note.text && enough(note.text, whole)) {
        findings.push(note.text);
        summarized = 1;
      } else if (note.text) {
        // Treated as a failure and asked again, like a job that wrote nothing:
        // putting this in the record's place would cost the assistant
        // everything it had found and save it only room it cannot use
        log.warn('compaction.try', {
          model: using.model,
          try: tries,
          of: TRIES,
          chars: note.text.length,
          of_record: whole.length,
          error: 'The job came back with too little to stand for the record.',
        });
      } else {
        log.warn('compaction.try', {
          model: using.model,
          try: tries,
          of: TRIES,
          error: 'The job came back with nothing.',
        });
      }
    } catch (err) {
      log.warn('compaction.try', { model: using.model, try: tries, of: TRIES, error: (err as Error).message });
    }
    // However it failed, the next try is somewhere else if there is anywhere
    // else: asking the same model again is what the measurements say does not
    // work. Only once, so a job cannot walk down the whole list of models.
    // Not after the work has been cancelled, and not on the last try, where
    // moving the job would only log a move that never happened
    if (summarized === 0 && !moved && !signal.aborted && tries < TRIES) {
      const to = await failoverTo(using.provider);
      if (to) {
        log.info('compaction.failover', { from: using.model, to: to.model, after: tries, of: TRIES });
        using = to;
        moved = true;
        fresh = true;
      }
    }
  }
  const where = {
    model: using.model,
    // Said only when the job did not end up where it started, so that a failed
    // compaction can be read back as the two models it was asked of
    ...(moved ? { from: model } : {}),
    ms: log.since(started),
    messages: old.length,
    bits: read.length,
    chars: whole.length,
    tries,
    unread,
    summarized,
    before: size(messages),
    ...usage,
  };

  // Nothing was summarized, so there is nothing to put in the messages' place
  if (findings.length === 0) {
    log.warn('compaction', { ...where, ok: false, error: 'The record could not be summarized.' });
    return { messages, usage };
  }
  log.info('compaction', { ...where, ok: true });

  const carried = `${CARRIED}\n\n${findings.join('\n\n')}`;
  // The task as the user set it, with the findings that now stand for
  // everything since. The findings replace the ones read above rather than
  // following them, so the message stays about the same length however many
  // times the reply is compacted.
  return {
    messages: [...before, { role: 'user', content: `${instruction}\n\n${carried}` }, ...recent],
    usage,
    findings: findings.join('\n\n'),
  };
}
