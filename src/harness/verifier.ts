// Checks a reply's changes, when the user asks: a model at least as capable as
// the one that wrote them is given what was asked for, the diffs of every file
// it changed and, as context only, what the reply said, and says whether the
// changes hold up.
//
// The changes are read from the thread's container rather than sent by the
// window, so that what is checked is what would be written back.
//
// A large change is reviewed a batch of files at a time (see batch), one call
// per batch, and the verdicts are added up: it passes only where every batch
// did. Every batch is told every path that changed, so that a reviewer holding
// part of a change does not report the rest of it as missing.
//
// verify() throws, with a message fit to show, when no verdict could be had.

import * as llm from '../llm';
import { priced } from '../llm/pricing';
import { bySophistication } from '../llm/sophistication';
import * as log from '../log';
import * as changes from '../sandbox/changes';
import type { FileChange, ModelInfo, ThreadChanges, Usage, Verification, VerificationRequest } from '../types';
import { cheapestFirst } from './router';

const TIMEOUT_MS = 300000;
// Room for the whole reply, thinking included. A reviewer thinks before it
// writes a word, and a brief request only turns off the account of that
// thinking, not the thinking itself (see ../llm/providers/anthropic.ts), so
// those tokens are spent out of this budget and never show up in the reply.
// What a verdict costs to write is a few hundred tokens; what the reasoning
// behind it costs grows with the diffs. This was 1500, which a 25k-token
// change spent entirely on thinking, leaving an empty reply to read.
const MAX_TOKENS = 8000;
const MAX_REQUEST_LENGTH = 4000; // characters of what the user asked for
const MAX_REPLY_LENGTH = 1500; // ...and of what the reply said, which is only context
// Diffs in any one batch. Small enough that the reasoning a batch draws out
// fits in MAX_TOKENS with room to write the verdict, which is what a single
// call over every diff at once could not do.
const MAX_BATCH_LENGTH = 20000;
// Batches reviewed before the rest of the files are left alone, so that a very
// large change cannot run up an unbounded number of calls. What is left over
// is counted and reported rather than passed over quietly.
const MAX_BATCHES = 10;

export const PROMPT = `You are checking another model's work. You are given what the user asked for, every path it
changed, and the diffs of the files you are to check. Decide whether the code changes really do what was asked: that
they are correct and complete. The diffs are what you are checking.

The message the model wrote when it finished is only there for context, to say what it meant to do. It is not under
review: do not judge how it is written, and do not report something only because the message says it and the diffs do
not show it. The model may have run tests, read files or written workspace notes, none of which are in the diffs.

A large change is checked a few files at a time, so the diffs you are given may be part of it rather than all of it.
Judge only the diffs in <changes>. Every file the model changed is listed in <files>, whether or not its diff is here:
do not report a file listed there as unchanged, missing or not done, and do not ask for work that one of them may
already hold. Workspace notes are kept outside the project, so they are never in <files> or the diffs: do not report
a note as missing from <changes> or <files>.

Report only real problems in the code: something missing, wrong or broken. Do not comment on style or taste, and do
not suggest improvements nobody asked for.

If you find nothing wrong, reply with the single word PASS. Otherwise reply with the word PROBLEMS on the first line,
then each problem on a line of its own starting with "- ", saying what is wrong and where.`;

// The least capable model that is as capable as the one that wrote the reply
// (a local one if there is a tie, as it is free to run). Where that model is
// not known, or nothing is as capable, the most capable there is.
export function pickModel(models: ModelInfo[], written?: { provider?: string; model?: string }): ModelInfo | undefined {
  const writer = models.find((m) => m.provider === written?.provider && m.id === written?.model);
  const best = [...models].sort(bySophistication)[0];
  if (!writer) return best;
  return [...models].sort(cheapestFirst).find((m) => m.sophistication >= writer.sophistication) ?? best;
}

function clip(text: string, length: number): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length)} [...]` : trimmed;
}

// The verdict in the reviewer's reply: its first line says PASS or PROBLEMS,
// as asked, in whatever Markdown a model dresses that in. null if it says
// neither, or finds problems without naming any.
export function parse(reply: string): { passed: boolean; problems: string } | null {
  const lines = reply.trim().split('\n');
  const verdict = lines[0]
    .replace(/[*_`#]/g, '')
    .replace(/[\s.!:]+$/, '')
    .trim()
    .toUpperCase();
  if (verdict === 'PASS') return { passed: true, problems: '' };
  if (!verdict.startsWith('PROBLEMS')) return null;
  // Said on the same line as the word, if it was
  const first = lines[0].replace(/^[\s*_`#]*problems[\s*_`#]*:?[\s*_`#]*/i, '');
  const problems = [first, ...lines.slice(1)].join('\n').trim();
  return problems ? { passed: false, problems } : null;
}

// The changed files in batches, each batch's diffs no longer than
// MAX_BATCH_LENGTH except where one file's diff is that long by itself: a file
// is never split, so every reviewer sees whole files. Order is kept, so files
// that changed together are usually reviewed together.
export function batch(files: FileChange[], length = MAX_BATCH_LENGTH): FileChange[][] {
  const batches: FileChange[][] = [];
  let current: FileChange[] = [];
  let used = 0;
  for (const file of files) {
    if (current.length > 0 && used + file.diff.length > length) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += file.diff.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// Every path the reply changed, for a reviewer that is holding only some of
// the diffs. Counted in, where there are more files than were listed at all.
function paths({ files, more }: ThreadChanges): string {
  const lines = files.map(({ path: file, status }) => `${file} (${status})`);
  if (more) lines.push(`${more} more changed ${more === 1 ? 'file' : 'files'} not listed.`);
  return lines.join('\n');
}

// What every batch cost, as one. The cached parts are optional and are only
// counted where a provider reported them, so that a total of nothing stays
// nothing rather than becoming a zero the pricing would charge for.
function addUsage(a: Usage, b: Usage): Usage {
  const cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  const cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(a.cacheWrite !== undefined || b.cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(a.cacheRead !== undefined || b.cacheRead !== undefined ? { cacheRead } : {}),
  };
}

// The verdicts over each batch as one: it passed only where every batch did,
// and the problems are every batch's, in the order the files were reviewed.
export function combine(verdicts: { passed: boolean; problems: string }[]): { passed: boolean; problems: string } {
  const problems = verdicts
    .map((verdict) => verdict.problems.trim())
    .filter(Boolean)
    .join('\n');
  return { passed: verdicts.every((verdict) => verdict.passed), problems };
}

export async function verify(request: VerificationRequest): Promise<Verification> {
  const started = performance.now();
  const failed = (error: string, model?: string): never => {
    log.warn('verification', { ok: false, ms: log.since(started), model, error });
    throw new Error(error);
  };

  const found = await changes.list(request.thread);
  if (found.unavailable) return failed(found.unavailable);
  if (found.files.length === 0) return failed('There are no changes to review.');

  const { models } = await llm.listModels();
  const model = pickModel(models, request);
  if (!model) return failed('There is no model to review the changes with.');

  // Everything the reply changed, in the batches it will be reviewed in, and
  // how many files are left over where there are more batches than are run
  const batches = batch(found.files);
  const reviewed = batches.slice(0, MAX_BATCHES);
  const left = batches.slice(MAX_BATCHES).reduce((n, files) => n + files.length, 0) + (found.more ?? 0);
  const changed = paths(found);

  const verdicts: { passed: boolean; problems: string }[] = [];
  const spent: Usage[] = [];
  // One call per batch, in turn rather than at once: a review the user is
  // waiting on should not take a provider's whole rate limit with it, and the
  // batches of a large change would be enough to.
  for (const files of reviewed) {
    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `<request>\n${clip(request.request, MAX_REQUEST_LENGTH)}\n</request>\n\n` +
              `<reply>\n${clip(request.output, MAX_REPLY_LENGTH)}\n</reply>\n\n` +
              `<files>\n${changed}\n</files>\n\n` +
              `<changes>\n${changes.describeChanges({ files })}\n</changes>`,
          },
        ],
        maxTokens: MAX_TOKENS,
        brief: true,
        log: { purpose: 'verification' },
      },
      AbortSignal.timeout(TIMEOUT_MS)
    );
    let reply = '';
    let stopReason: string | undefined;
    for await (const event of events) {
      if (event.type === 'text') reply += event.delta;
      if (event.type === 'done') {
        stopReason = event.stopReason;
        if (event.usage) spent.push(event.usage);
      }
      if (event.type === 'error') return failed(event.message, model.id);
    }
    // A reply cut off for room is not a verdict, whatever can be read of it:
    // the problems it had got to are not all the problems it found, and
    // showing them as the review would say the changes were looked over when
    // they were not. One batch short of a verdict is the whole review short of
    // one, so this gives up rather than reporting the batches that did answer.
    if (stopReason === 'length') return failed('The reviewer ran out of room before it finished.', model.id);
    const verdict = parse(reply);
    if (!verdict) return failed("The reviewer's reply could not be read.", model.id);
    verdicts.push(verdict);
  }

  const verdict = combine(verdicts);
  const usage = spent.length > 0 ? spent.reduce(addUsage) : undefined;
  log.info('verification', {
    ok: true,
    ms: log.since(started),
    model: model.id,
    passed: verdict.passed,
    batches: reviewed.length,
    files: found.files.length,
    unreviewed: left || undefined,
    input: usage?.input,
    output: usage?.output,
  });
  return {
    ...verdict,
    model: model.name,
    unreviewed: left || undefined,
    usage: usage && priced('verification', model.provider, model.id, usage, models),
  };
}
