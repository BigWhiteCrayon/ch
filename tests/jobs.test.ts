import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine reaches out through three places: the timing helpers it borrows from
// ../src/llm, the file store it persists through, and the log. None of them is
// under test, so all three are stubbed: a no-op wait keeps a poll that would back
// off for seconds in its place in one microtask, a fake store keeps jobs.json off
// disk, and the log is just a sink.

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../src/log', () => log);

vi.mock('../src/llm/index', () => ({
  // The schedule a poll follows: a zero so a poll does not actually wait.
  backoff: () => 0,
  wait: (_ms: number, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      resolve();
    }),
  deadline: () => ({ signal: new AbortController().signal, clear: () => undefined }),
}));

import * as jobs from '../src/jobs';

// A fake store: the job engine persists through it, and a test points it here
// rather than at a file. One test may seed what `load` returns, so it is held in
// a variable the test sets.
type FakeStore = { text: string | null };
const store = () => (globalThis as { chStore?: FakeStore }).chStore;
function fakeStore(seed: string | null = null): FakeStore {
  const s: FakeStore = { text: seed };
  (globalThis as { chStore?: FakeStore }).chStore = s;
  jobs.setStore({
    load: () => s.text,
    save: (json: string) => {
      s.text = json;
    },
  });
  return s;
}

// Every test starts from no running jobs and its own store, and the log is wiped
// so a test that checks it is not reading another test's call.
beforeEach(() => {
  jobs.reset();
  fakeStore(null);
  log.info.mockReset();
  log.error.mockReset();
});

afterEach(() => {
  delete (globalThis as { chStore?: FakeStore }).chStore;
});

// Reads the last thing the engine persisted, or null when nothing has been.
function saved() {
  const text = store()!.text;
  return text ? JSON.parse(text) : null;
}

describe('the poll kind', () => {
  it('counts up to its target and resolves when it is reached', async () => {
    const id = jobs.start('poll', { attempts: 3 }, 't1');
    const found = await jobs.waitFor([id]);
    expect(found).toEqual([{ id, state: 'done', result: { attempts: 3, done: 3 } }]);
  });

  it('throws when asked for a kind that is not registered', () => {
    expect(() => jobs.start('no-such-kind', {}, 't1')).toThrow(/no-such-kind/);
  });
});

describe('collecting', () => {
  it('brings back what is still running when nothing is named', async () => {
    const a = jobs.start('poll', { attempts: 2 }, 't1');
    const b = jobs.start('poll', { attempts: 2 }, 't1');
    const found = await jobs.waitFor();
    // Both jobs that were running are collected, each done.
    expect(found.map((f) => f.id).sort()).toEqual([a, b].sort());
    expect(found.every((f) => f.state === 'done')).toBe(true);
  });

  it('reports a job that is not running as failed rather than throwing', async () => {
    const found = await jobs.waitFor(['never-existed']);
    expect(found).toEqual([{ id: 'never-existed', state: 'failed', result: 'No job by that id: never-existed' }]);
  });
});

describe('cancelling', () => {
  it('marks a job cancelled and the settle agrees', async () => {
    const id = jobs.start('poll', { attempts: 100 }, 't1');
    jobs.cancel(id);
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('cancelled');
    expect(found[0].id).toBe(id);
  });

  it('does nothing when the id is not a running job', () => {
    expect(() => jobs.cancel('never-existed')).not.toThrow();
  });

  it('persists the record as cancelled, so a later close sees it cancelled', async () => {
    const id = jobs.start('poll', { attempts: 100 }, 't1');
    jobs.cancel(id);
    const cancelled = saved()!;
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).toBe(id);
    expect(cancelled[0].state).toBe('cancelled');
  });
});

describe('lifecycle events', () => {
  it('push started and done to a listener, for the thread and id the job is of', async () => {
    const seen: Array<{ thread: string; id: string; event: string }> = [];
    const off = jobs.onEvent((thread, id, event) => seen.push({ thread, id, event }));
    const id = jobs.start('poll', { attempts: 2 }, 't1');
    await jobs.waitFor([id]);
    off();
    expect(seen.map((e) => e.event)).toContain('started');
    expect(seen.map((e) => e.event)).toContain('done');
    expect(seen.every((e) => e.thread === 't1' && e.id === id)).toBe(true);
  });

  it('stops after unsubscribe', () => {
    let n = 0;
    const off = jobs.onEvent(() => n++);
    off();
    jobs.start('poll', { attempts: 1 }, 't1');
    expect(n).toBe(0);
  });
});

describe('the two wait primitives', () => {
  it('pollUntil resolves true after the check stops returning true-false', async () => {
    let calls = 0;
    const controller = new AbortController();
    const { promise, cursor } = jobs.pollUntil(async () => ++calls >= 3, {
      signal: controller.signal,
      intervalMs: 0,
    });
    await expect(promise).resolves.toBe(true);
    expect(calls).toBe(3);
    expect(cursor()).toBe(2); // the two that did not yet return true
  });

  it('pollUntil rejects when its signal aborts before the check turns true', async () => {
    const controller = new AbortController();
    const { promise } = jobs.pollUntil(() => false, { signal: controller.signal, intervalMs: 0 });
    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
  });

  it('awaitEvent resolves with the value that first is ready', async () => {
    // The getter keeps returning null (not ready) and then a value: the await
    // polls on its own schedule rather than being driven from outside, which a
    // setTimeout cannot be, the loop only yielding its own microtasks.
    let calls = 0;
    const controller = new AbortController();
    const { promise, cancel } = jobs.awaitEvent(() => (++calls >= 2 ? { merged: true } : null), {
      signal: controller.signal,
      intervalMs: 0,
    });
    await expect(promise).resolves.toEqual({ merged: true });
    void cancel;
  });

  it('awaitEvent rejects when aborted before anything is ready', async () => {
    const controller = new AbortController();
    const { promise } = jobs.awaitEvent(() => null, { signal: controller.signal, intervalMs: 0 });
    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
  });
});

describe('the registry', () => {
  it('finds a kind by name and registers a new one that the engine then runs', () => {
    expect(jobs.getJobKind('poll')).toBeDefined();
    expect(jobs.getJobKind('absent')).toBeUndefined();
    jobs.registerJobKind({
      kind: 'instant',
      describe: 'a kind a test registers',
      start: (_i, ctx) => ({
        promise: Promise.resolve('from-start'),
        cancel: () => ctx.signal.abort(),
        cursor: () => undefined,
      }),
      resume: (job, ctx) => ({
        promise: Promise.resolve('from-resume'),
        cancel: () => ctx.signal.abort(),
        cursor: () => undefined,
      }),
    });
    expect(jobs.getJobKind('instant')?.describe).toBe('a kind a test registers');
  });
});

// A kind a test registers: start runs from zero, resume runs from the persisted
// cursor and puts it in its result, so a resume can be told from a fresh start by
// the number it brings back.
function registerCursorKind(): void {
  jobs.registerJobKind({
    kind: 'cursor-recorder',
    describe: 'a test kind that records where it started from',
    start: (_inputs, ctx) => ({
      promise: Promise.resolve({ from: 0 }),
      cancel: () => ctx.signal.abort(),
      cursor: () => 0,
    }),
    resume: (job, ctx) => ({
      promise: Promise.resolve({ from: Number(job.cursor ?? 0) }),
      cancel: () => ctx.signal.abort(),
      cursor: () => job.cursor,
    }),
  });
}

describe('surviving an app close', () => {
  it('re-drives a running job from its persisted cursor on init', async () => {
    registerCursorKind();
    const record = {
      id: 'job-1',
      thread: 't1',
      kind: 'cursor-recorder',
      inputs: {},
      state: 'running' as const,
      result: undefined,
      createdAt: 0,
      cursor: 5,
      lastPoll: 0,
    };
    // The store holds one job that an earlier session left mid-way at cursor 5.
    fakeStore(JSON.stringify([record]));

    const seen: string[] = [];
    jobs.onEvent((t, i, event) => seen.push(`${t}/${i}/${event}`));

    jobs.init();
    const found = await jobs.waitFor(['job-1']);
    expect(found[0].id).toBe('job-1');
    expect(found[0].state).toBe('done');
    // It resumed from 5, not from zero: the result carries the cursor it started at.
    expect(found[0].result).toEqual({ from: 5 });
    expect(seen).toContain('t1/job-1/resumed');
  });

  it('does nothing when the store has no jobs', () => {
    // init on an empty store returns before it persists, so the store is left as
    // it was; flush never throws on an engine with nothing running.
    expect(() => jobs.init()).not.toThrow();
    expect(saved()).toBeNull();
    expect(() => jobs.flush()).not.toThrow();
  });

  it('fails a persisted job whose kind is no longer registered', async () => {
    const record = {
      id: 'job-old',
      thread: 't1',
      kind: 'a-kind-that-is-gone',
      inputs: {},
      state: 'running' as const,
      result: undefined,
      createdAt: 0,
      cursor: 0,
      lastPoll: 0,
    };
    fakeStore(JSON.stringify([record]));
    jobs.init();
    // It is written back as failed, so a later close does not try to resume it.
    const saved = JSON.parse(store()!.text);
    expect(saved[0].state).toBe('failed');
    expect(saved[0].result).toMatch(/a-kind-that-is-gone/);
  });
});
