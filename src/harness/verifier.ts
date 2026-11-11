// Checks a reply's changes, when the user asks: a model at least as capable as
// the one that wrote them is given what was asked for, the diffs of every file
// it changed and, as context only, what the reply said, and says whether the
// changes hold up.
//
// In a thread with a workspace it does that as a person reviewing them would:
// as a subagent in the thread's container, which reads the changes, runs the
// project's checks and uses the app to try them (see test, and the tester in
// ../subagents/tester.ts). Reading the diffs alone could say whether the code
// read as right and nothing about whether it was, so that review is now what is
// done where the tested one cannot be: no workspace, or a reviewer that did not
// come back with a verdict (see readOver).
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
import { findings, TESTER } from '../subagents';
import type {
  FileChange,
  HarnessEvent,
  ModelInfo,
  ThreadChanges,
  Usage,
  Verification,
  VerificationRequest,
} from '../types';
import { cheapestFirst } from './router';

// How long the reviewer has in front of the model, per batch. It does not cover
// the wait for its turn (see clock).
//
// An online model is given ten minutes because a review is slower than it looks:
// the model reasons over every diff before it writes a word of its verdict, which
// was measured at 49 to 242 seconds for changes of 5,000 to 7,000 tokens. At five
// minutes the reviews that finished were clearing the limit by half a minute. This
// is here for a server that has stopped answering, not to hurry a reviewer that is
// working.
//
// A local model is given half an hour instead: it answers one request at a time
// and reasons a word at a time, so a change a server reviews in minutes can take
// an order of magnitude longer on a machine of its own, and a limit that fits a
// server cuts off a local reviewer that is still working.
const ONLINE_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 30 * 60 * 1000;
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
// How long the tested review has, all of it: reading, the project's checks, and
// using the app. Bounded for an app that never comes up or a check that never
// ends; the reviewer's own rounds are what bound it otherwise (see TESTER).
const TEST_TIMEOUT_MS = 20 * 60 * 1000;
// Characters of the diffs put in the tester's task. It reads the rest itself,
// with thread_diff, which a reviewer holding a tool can do where one without
// could only be given less.
const MAX_TASK_DIFFS = 40000;

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
then each problem on a line of its own starting with "- ", saying what is wrong and where. You have no tools here and
cannot read or run anything: everything you are to judge is in this message, so give your verdict now.`;

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

// The verdict in the reviewer's reply: the line that says PASS or PROBLEMS, as
// asked, in whatever Markdown a model dresses that in. null if no line says
// either, or if it finds problems without naming any.
//
// Looked for from the end, because a model that reasons in its reply reasons
// its way to the verdict rather than opening with it. Reading the first line
// alone threw away a review that had read every diff, found a real bug and
// closed with the PROBLEMS block it was asked for, because it began by saying
// what it was about to look at.
export function parse(reply: string): { passed: boolean; problems: string } | null {
  const found = verdictIn(reply);
  return found && { passed: found.passed, problems: found.problems };
}

// The verdict, and what was said before it: a tester says what it checked
// there (see ../subagents/tester.ts). The "Checked:" it is asked to head that
// with is left off, since the note it is shown under says as much.
export function report(reply: string): { passed: boolean; problems: string; checked: string } | null {
  const found = verdictIn(reply);
  if (!found) return null;
  const checked = found.before
    .trim()
    .replace(/^[\s*_#]*checked[\s*_#]*:?[\s*_#]*\n?/i, '')
    .trim();
  return { passed: found.passed, problems: found.problems, checked };
}

function verdictIn(reply: string): { passed: boolean; problems: string; before: string } | null {
  const lines = reply.trim().split('\n');
  const before = (i: number) => lines.slice(0, i).join('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const verdict = lines[i]
      .replace(/[*_`#]/g, '')
      .replace(/[\s.!:]+$/, '')
      .trim()
      .toUpperCase();
    if (verdict === 'PASS') return { passed: true, problems: '', before: before(i) };
    if (!verdict.startsWith('PROBLEMS')) continue;
    // Said on the same line as the word, if it was, and on the lines under it
    const first = lines[i].replace(/^[\s*_`#]*problems[\s*_`#]*:?[\s*_`#]*/i, '');
    const problems = [first, ...lines.slice(i + 1)].join('\n').trim();
    if (problems) return { passed: false, problems, before: before(i) };
    // A line that says PROBLEMS and names none is no verdict, though one
    // further up may still be
  }
  return null;
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

// The limit on one batch, which does not run while the request is waiting its
// turn. A local server answers one request at a time, so a review asked for
// while a reply is being written waits behind it: those waits were measured at
// 135, 147 and 249 seconds, and a limit that covered them was spent before the
// model had read a word. llm.stream says when a wait is over ('waited'), and
// the limit starts again from there.
function clock(ms: number): { signal: AbortSignal; restart(): void; clear(): void } {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    restart() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
    },
    clear: () => clearTimeout(timer),
  };
}

export interface VerifyOptions {
  // Whether nothing has started on the thread since the review did. The thread's
  // files are put back after the tester only while this holds: a reply begun in
  // the meantime has changes of its own in them, which putting the files back
  // would throw away (see 'llm:verify' in ../main.ts). Unset, it is taken to hold.
  untouched?: () => boolean;
}

export async function verify(request: VerificationRequest, options: VerifyOptions = {}): Promise<Verification> {
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

  if (request.workspace) {
    const tested = await test(request, found, model, models, options);
    if (tested) {
      log.info('verification', {
        ok: true,
        ms: log.since(started),
        model: model.id,
        passed: tested.passed,
        tested: true,
        files: found.files.length,
        input: tested.usage?.input,
        output: tested.usage?.output,
      });
      return tested;
    }
  }
  return readOver(request, found, model, models, started, failed);
}

// What the tester is given: what was asked for, what the reply said (as context
// only, as for the reviewer without tools), every path that changed, and as
// much of the diffs as is worth putting in front of it before it has looked at
// anything. It reads the rest with thread_diff.
export function testTask(request: VerificationRequest, found: ThreadChanges): string {
  let diffs = changes.describeChanges(found);
  const cut = diffs.length > MAX_TASK_DIFFS;
  if (cut) diffs = diffs.slice(0, MAX_TASK_DIFFS);
  return (
    `<request>\n${clip(request.request, MAX_REQUEST_LENGTH)}\n</request>\n\n` +
    `<reply>\n${clip(request.output, MAX_REPLY_LENGTH)}\n</reply>\n\n` +
    `<files>\n${paths(found)}\n</files>\n\n` +
    `<changes>\n${diffs}\n</changes>\n\n` +
    (cut ? 'The diffs are cut short there; read the rest with thread_diff.\n\n' : '') +
    'The reply above is only what the model said it did, for context: what you are reviewing is the change ' +
    'itself, and whether it does what the user asked for. Review it now.'
  );
}

// The review a person would make: by a tester in the thread's container (see
// ../subagents/tester.ts). Null where it came back without a verdict — it
// failed, ran out of time, or did not say one — and the review is then made by
// reading the diffs instead, so that asking for one never comes to nothing for
// want of a reviewer that could use tools.
async function test(
  request: VerificationRequest,
  found: ThreadChanges,
  model: ModelInfo,
  models: ModelInfo[],
  { untouched }: VerifyOptions
): Promise<Verification | null> {
  const started = performance.now();
  const before = await changes.snapshot(request.thread);
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), TEST_TIMEOUT_MS);
  const spent: Usage[] = [];
  // Only what each of its calls used: the rest of what it says as it works is
  // for a window, and nobody is watching a review go
  const emit = (event: HarnessEvent) => {
    if (event.type === 'usage') spent.push(event);
  };
  try {
    const [finding] = await findings([{ name: 'review', task: testTask(request, found), kind: TESTER }], {
      signal: limit.signal,
      threadId: request.thread,
      workspace: request.workspace,
      model: { provider: model.provider, model: model.id },
      sophistication: model.sophistication,
      emit,
    });
    const verdict = finding && !finding.isError ? report(finding.text) : null;
    if (!verdict) {
      log.warn('verification.tested', {
        ok: false,
        ms: log.since(started),
        model: model.id,
        error: finding?.isError ? finding.text.slice(0, 300) : 'The tester did not say PASS or PROBLEMS.',
      });
      return null;
    }
    const usage = spent.length > 0 ? spent.reduce(addUsage) : undefined;
    return {
      ...verdict,
      tested: true,
      model: model.name,
      usage: usage && priced('verification', model.provider, model.id, usage, models),
    };
  } catch (err) {
    log.warn('verification.tested', { ok: false, ms: log.since(started), error: (err as Error).message });
    return null;
  } finally {
    clearTimeout(timer);
    // What the tester's commands wrote, put back. Not where there was no
    // snapshot to go back to — reverting to nothing would be reverting to the
    // container as it was made, the reply's changes and all — and not where a
    // reply has started on the thread since, whose changes are in there too.
    if (before && (untouched?.() ?? true)) await changes.revert(request.thread, before);
  }
}

// The review made by reading the diffs: a model with no tools, a batch of files
// at a time
async function readOver(
  request: VerificationRequest,
  found: ThreadChanges,
  model: ModelInfo,
  models: ModelInfo[],
  started: number,
  failed: (error: string, model?: string) => never
): Promise<Verification> {
  // Everything the reply changed, in the batches it will be reviewed in, and
  // how many files are left over where there are more batches than are run
  const batches = batch(found.files);
  const reviewed = batches.slice(0, MAX_BATCHES);
  const left = batches.slice(MAX_BATCHES).reduce((n, files) => n + files.length, 0) + (found.more ?? 0);
  const changed = paths(found);

  const verdicts: { passed: boolean; problems: string }[] = [];
  const spent: Usage[] = [];
  // A local model is given twice the time a server is, for the reason the
  // constants above give. It is the reviewer's own clock, and the figure the
  // "out of time" message below reports, so it is named here once.
  const timeoutMs = model.local ? LOCAL_TIMEOUT_MS : ONLINE_TIMEOUT_MS;
  // One call per batch, in turn rather than at once: a review the user is
  // waiting on should not take a provider's whole rate limit with it, and the
  // batches of a large change would be enough to.
  for (const files of reviewed) {
    const limit = clock(timeoutMs);
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
        // A local model told not to reason does its checking out loud: it says
        // what it will look at next and calls tools it was never offered,
        // which is no verdict. This does nothing on a hosted model, where a
        // brief request doesn't reason whatever it is told.
        think: true,
        log: { purpose: 'verification' },
      },
      limit.signal
    );
    let reply = '';
    let stopReason: string | undefined;
    try {
      for await (const event of events) {
        // Its turn came: what it has spent of the limit so far went on waiting
        // rather than on reviewing (see clock)
        if (event.type === 'waited') limit.restart();
        if (event.type === 'text') reply += event.delta;
        if (event.type === 'done') {
          stopReason = event.stopReason;
          if (event.usage) spent.push(event.usage);
        }
        if (event.type === 'error') return failed(event.message, model.id);
      }
    } catch (err) {
      // The limit reaches the request through its signal, which a provider
      // reports as a cancelled ending where the request had got far enough to
      // have one and raises where it had not (see ../llm/providers/ollama.ts)
      if (!limit.signal.aborted) throw err;
    } finally {
      limit.clear();
    }
    // Out of time, with however little of a verdict it had written. The model
    // was still working: one cut off this way had already decided and was
    // double-checking a PASS it never got to write. Said as itself rather than
    // as a reply that could not be read, which is what this used to report and
    // which pointed at the parser instead of at the clock.
    if (limit.signal.aborted || stopReason === 'cancelled') {
      return failed(`The reviewer did not reach a verdict within ${Math.round(timeoutMs / 60000)} minutes.`, model.id);
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
