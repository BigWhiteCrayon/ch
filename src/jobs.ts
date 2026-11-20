import { randomUUID } from 'node:crypto';
import * as log from './log';
import { backoff, wait } from './llm/index';
import { loadJobs, saveJobs } from './store';

// A job is a per-thread, long-running thing the model starts and collects on a
// later turn: the engine keeps it across an app close (its cursor is persisted) and
// re-drives it on open. Provider-agnostic: a kind is a hand-written handler, and the
// two primitives below are the only wait shapes it needs. No network here — a kind
// that reaches out (e.g. a github-merge-wait) is a later phase, registered like any
// other; the core imports neither electron nor octokit, so it is testable under vitest.

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

// What is persisted, one per running-or-just-finished job, as a JSON array in
// jobs.json (see ./store loadJobs/saveJobs). cursor is the resume point: a poll
// resumed after a close continues from it, not from zero.
export type JobRecord = {
  id: string;
  thread: string;
  kind: string;
  inputs: unknown;
  state: JobState;
  result: unknown;
  createdAt: number;
  cursor: unknown;
  lastPoll: number;
};

// Carried into a kind's start/resume: the thread, a cancellable signal for this job,
// emit for lifecycle events, and onCursor so the kind can hand its progress back to
// the engine mid-tick, which is what the engine persists.
export type JobContext = {
  thread: string;
  signal: AbortSignal;
  emit(event: string, data?: unknown): void;
  onCursor?(cursor: unknown): void;
};

// A handle is an async thing a kind's start/resume returns: it resolves to the result
// or rejects to mean failed/cancelled, it can be cancelled, and it reports its cursor
// so a close can resume from it. Mirrors the block-until-abort shape of mailbox.arrived
// (../subagents/mailbox.ts).
export interface JobHandle {
  promise: Promise<unknown>;
  cancel(): void;
  cursor(): unknown;
}

// A job kind, registered the way a tool or a subagent kind is. start runs a fresh job
// from inputs; resume re-drives a job from its persisted record; describe is what the
// model is told the kind is for.
export interface JobKind {
  kind: string;
  describe: string;
  start(inputs: unknown, ctx: JobContext): JobHandle;
  resume(job: JobRecord, ctx: JobContext): JobHandle;
}

// ---- the two reusable primitives -------------------------------------------------

// A job that is cancelled settles with this, so the engine can tell a cancellation
// from a real failure. Thrown when the signal aborts before a poll or an awaited
// event resolves.
class JobCancelled extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelled';
  }
}

// Polls check() on a backoff schedule (backoff for the delay between attempts, wait to
// sleep, cancellable on the signal) until check returns true (resolves true) or the
// signal aborts (rejects JobCancelled). cursor() is the poll count; after each tick
// onCursor is called with it, so the engine can persist a poll mid-way and resume from
// it. Modelled on the block-until-abort loop of mailbox.arrived.
export function pollUntil(
  check: () => boolean | Promise<boolean>,
  options: { intervalMs?: number; signal: AbortSignal; onCursor?: (n: number) => void }
): { promise: Promise<boolean>; cursor(): number } {
  const { signal, onCursor } = options;
  let attempt = 0;
  let count = 0;
  let done = false;
  const promise = new Promise<boolean>((resolve, reject) => {
    const stopped = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', stopped);
      reject(new JobCancelled());
    };
    // Fire-and-forget: the only thing that can throw out of this loop is the
    // wait aborting, which the stopped() listener already turns into a rejection
    // of the main promise. The loop's own promise is nobody's, so that stray
    // rejection is swallowed here, or it would surface as an unhandled rejection
    // the moment a job is cancelled.
    (async () => {
      for (;;) {
        if (signal.aborted) return stopped();
        let ready = false;
        try {
          ready = await check();
        } catch (err) {
          if (done) return;
          done = true;
          return reject(err);
        }
        if (ready) {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', stopped);
          return resolve(true);
        }
        count += 1;
        onCursor?.(count);
        const ms = options.intervalMs ?? backoff(attempt++);
        await wait(ms, signal);
      }
    })().catch(() => undefined);
    if (signal.aborted) return stopped();
    signal.addEventListener('abort', stopped, { once: true });
  });
  return { promise, cursor: () => count };
}

// Awaits an external pushed value or the abort: getter() is polled on a short interval
// until isReady(v) (or a non-null value) or the signal aborts. No meaningful cursor —
// cursor() is undefined, as the block-until-abort awaitEvent has nothing to resume from.
export function awaitEvent(
  getter: () => unknown | Promise<unknown>,
  options: { signal: AbortSignal; isReady?: (v: unknown) => boolean; intervalMs?: number }
): { promise: Promise<unknown>; cancel(): void; cursor(): unknown } {
  const { signal, isReady } = options;
  let done = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const promise = new Promise<unknown>((resolve, reject) => {
    const stopped = () => {
      if (done) return;
      done = true;
      reject(new JobCancelled());
    };
    signal.addEventListener('abort', stopped, { once: true });
    controller.signal.addEventListener('abort', stopped, { once: true });
    // Fire-and-forget, same as pollUntil: an aborted wait is the only thing that
    // can throw out of this loop, and stopped() already rejects the main promise
    // for it, so the loop's own promise is swallowed here.
    (async () => {
      for (;;) {
        if (signal.aborted || controller.signal.aborted) return stopped();
        let v: unknown;
        try {
          v = await getter();
        } catch (err) {
          if (done) return;
          done = true;
          return reject(err);
        }
        if (isReady ? isReady(v) : v != null) {
          if (done) return;
          done = true;
          return resolve(v);
        }
        await wait(options.intervalMs ?? backoff(0), signal);
      }
    })().catch(() => undefined);
    if (signal.aborted || controller.signal.aborted) return stopped();
  });
  return { promise, cancel, cursor: () => undefined };
}

// ---- the kind registry -----------------------------------------------------------

// Every kind a job may be, in the order they are registered (see registerJobKind),
// modelled on the subagent KINDS list. A new kind is one registerJobKind call; the
// engine and the two primitives never change.
export const jobKinds: JobKind[] = [];

export function registerJobKind(kind: JobKind): void {
  jobKinds.push(kind);
}

// The kind of that name, or undefined if there is no such kind.
export function getJobKind(name: string): JobKind | undefined {
  return jobKinds.find((kind) => kind.kind === name);
}

// ---- the built-in 'poll' kind ----------------------------------------------------

// The one kind registered by the core: a job that counts polls up to a target and
// resolves when it reaches it. No network, fully serialisable, so the engine can be
// driven start -> tick -> close -> reopen -> resume -> collect in a test.
const POLL = 'poll';

// Shared by start (from a cursor of zero) and resume (from the persisted count): counts
// up to attempts and resolves { attempts, done } when reached. The count is held in a
// local starting at fromCursor, so resume continues from the persisted cursor rather
// than from zero. Each tick that does not yet reach attempts increments the count and
// hands it back to the engine via onCursor, which persists it; when the count reaches
// attempts the poll resolves. The poll's own signal cancels it, wired off the job's
// signal, so cancelling the job aborts the poll.
function runPoll(attempts: number, fromCursor: number, ctx: JobContext): JobHandle {
  let count = fromCursor;
  const ac = new AbortController();
  ctx.signal.addEventListener('abort', () => ac.abort());
  const handle = pollUntil(
    async () => {
      if (count >= attempts) return true;
      count += 1;
      ctx.onCursor?.(count);
      return false;
    },
    { signal: ac.signal }
  );
  const promise = handle.promise.then(() => ({ attempts, done: attempts }));
  return {
    promise,
    cancel: () => ac.abort(),
    cursor: () => count,
  };
}

const POLL_KIND: JobKind = {
  kind: POLL,
  describe:
    'Counts polls up to a target and resolves when reached. inputs: { attempts, intervalMs? }. Fully ' +
    'serialisable; resumes from its cursor.',
  start(inputs, ctx) {
    const attempts = Number((inputs as { attempts?: number })?.attempts ?? 0);
    return runPoll(attempts, 0, ctx);
  },
  resume(job, ctx) {
    const attempts = Number((job.inputs as { attempts?: number })?.attempts ?? 0);
    return runPoll(attempts, Number(job.cursor ?? 0), ctx);
  },
};

registerJobKind(POLL_KIND);

// ---- the engine ------------------------------------------------------------------

// Injected for tests: the engine persists through this so a test can point it at a
// fake store and never touch app userData. The core itself imports neither electron nor
// octokit, so the default below is the real store and tests swap in a fake.
let store = { load: loadJobs, save: saveJobs };
export function setStore(next: { load: () => string | null; save: (json: string) => void }): void {
  store = next;
}

// One live job: its record, its handle, the controller that cancels it, and the promise
// that settles its final state. Mirrors the per-thread running Map of subagent run.ts.
type Entry = {
  job: JobRecord;
  handle: JobHandle;
  controller: AbortController;
  done: Promise<{ id: string; state: JobState; result: unknown }>;
};

const byId = new Map<string, Entry>();
const listeners = new Set<(thread: string, id: string, event: string, data?: unknown) => void>();

function allRecords(): JobRecord[] {
  return [...byId.values()].map((entry) => entry.job);
}

function persist(): void {
  try {
    store.save(JSON.stringify(allRecords(), null, 2));
  } catch (err) {
    log.error('jobs.persist', { ok: false, error: (err as Error).message });
  }
}

// Persists an explicit set of records, the way init writes back what it read:
// the re-driven jobs are held by the engine, but the ones it did not resume —
// those whose kind is gone, marked failed — are not, so they are written back by
// name or they would be lost and a later close would never see they were failed.
function persistAll(records: JobRecord[]): void {
  try {
    store.save(JSON.stringify(records, null, 2));
  } catch (err) {
    log.error('jobs.persist', { ok: false, error: (err as Error).message });
  }
}

// Pushes a lifecycle event to every listener (main wires these to a push to all
// windows, the same way it pushes subagent events).
function emitEvent(thread: string, id: string, event: string, data?: unknown): void {
  for (const listener of listeners) listener(thread, id, event, data);
}

// Builds the settling done-promise for an entry, the same way start and resume need it:
// awaits the handle, on resolve sets the record done with its result, on rejection sets
// it cancelled (if the controller aborted) or failed, persists, and emits. The handler
// is caught so an aborted job never becomes an unhandled rejection.
function settle(entry: Entry): void {
  entry.done = entry.handle.promise.then(
    (result) => {
      entry.job.state = 'done';
      entry.job.result = result;
      emitEvent(entry.job.thread, entry.job.id, 'done', { result });
      persist();
      return { id: entry.job.id, state: 'done' as JobState, result };
    },
    (err) => {
      entry.job.state = entry.controller.signal.aborted ? 'cancelled' : 'failed';
      entry.job.result = err instanceof Error ? err.message : String(err);
      emitEvent(entry.job.thread, entry.job.id, entry.job.state, { error: entry.job.result });
      persist();
      return { id: entry.job.id, state: entry.job.state, result: entry.job.result };
    }
  );
  entry.done.catch(() => undefined);
}

// Starts a job of a kind, driving it to a settled state and persisting it. Returns its id.
export function start(kind: string, inputs: unknown, thread: string): string {
  const k = getJobKind(kind);
  if (!k) throw new Error(`Unknown job kind: ${kind}`);
  const id = randomUUID();
  const job: JobRecord = {
    id,
    thread,
    kind,
    inputs,
    state: 'running',
    result: undefined,
    createdAt: Date.now(),
    cursor: 0,
    lastPoll: 0,
  };
  const controller = new AbortController();
  const ctx: JobContext = {
    thread,
    signal: controller.signal,
    emit: (event, data) => emitEvent(thread, id, event, data),
    onCursor: (cursor) => {
      job.cursor = cursor;
      job.lastPoll = Date.now();
      persist();
      emitEvent(thread, id, 'tick', { cursor });
    },
  };
  const handle = k.start(inputs, ctx);
  const entry: Entry = { job, handle, controller, done: Promise.resolve({ id, state: 'running', result: undefined }) };
  byId.set(id, entry);
  settle(entry);
  emitEvent(thread, id, 'started', { kind });
  persist();
  log.info('jobs.start', { thread, id, kind });
  return id;
}

// Collects jobs the model started but did not wait for: the ones named, or every job
// still out if none are named, the way subagent waitFor collects subagents. Collecting
// one releases it from the running map.
export async function waitFor(ids?: string[]): Promise<Array<{ id: string; state: JobState; result: unknown }>> {
  const wanted = ids?.length ? ids : [...byId.keys()];
  const found: Array<{ id: string; state: JobState; result: unknown }> = [];
  for (const id of wanted) {
    const entry = byId.get(id);
    if (!entry) {
      found.push({ id, state: 'failed', result: `No job by that id: ${id}` });
      continue;
    }
    byId.delete(id);
    found.push(await entry.done);
  }
  return found;
}

// Cancels a job: aborts its signal, marks it cancelled, and persists.
export function cancel(id: string): void {
  const entry = byId.get(id);
  if (!entry) return;
  entry.controller.abort();
  entry.job.state = 'cancelled';
  emitEvent(entry.job.thread, id, 'cancelled');
  persist();
  log.info('jobs.cancel', { id });
}

// On open: load jobs.json and re-drive every running job through its kind's resume, from
// its persisted cursor, so a job survives an app close. init takes no dir arg — the
// engine persists through `store`, which a test can point at a fake.
export function init(): void {
  const text = store.load();
  if (!text) return;
  let records: JobRecord[];
  try {
    records = JSON.parse(text);
  } catch (err) {
    log.error('jobs.init', { ok: false, error: (err as Error).message });
    return;
  }
  for (const record of records) {
    if (record.state !== 'running') continue;
    const k = getJobKind(record.kind);
    if (!k) {
      record.state = 'failed';
      record.result = `Unknown job kind: ${record.kind}`;
      continue;
    }
    const controller = new AbortController();
    const ctx: JobContext = {
      thread: record.thread,
      signal: controller.signal,
      emit: (event, data) => emitEvent(record.thread, record.id, event, data),
      onCursor: (cursor) => {
        record.cursor = cursor;
        record.lastPoll = Date.now();
        persist();
        emitEvent(record.thread, record.id, 'tick', { cursor });
      },
    };
    const handle = k.resume(record, ctx);
    const entry: Entry = {
      job: record,
      handle,
      controller,
      done: Promise.resolve({ id: record.id, state: 'running', result: undefined }),
    };
    byId.set(record.id, entry);
    settle(entry);
    emitEvent(record.thread, record.id, 'resumed', { kind: record.kind, cursor: record.cursor });
    log.info('jobs.resume', { thread: record.thread, id: record.id, kind: record.kind });
  }
  // Write back the whole set that was read, not only the re-driven ones: the jobs
  // whose kind was gone were marked failed but not resumed, so they are not in the
  // engine's running map, and persist() alone would drop them (see persistAll).
  persistAll(records);
}

// On close: persist the current records.
export function flush(): void {
  persist();
}

// Adds a lifecycle listener and returns an unsubscribe (mirrors onLook/onSurveyed in
// ../harness/project.ts). Main wires this to a push to all windows.
export function onEvent(listener: (thread: string, id: string, event: string, data?: unknown) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Test hook: clears the running jobs and listeners without touching the store.
export function reset(): void {
  byId.clear();
  listeners.clear();
}
