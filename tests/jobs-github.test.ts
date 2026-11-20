import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The github-merge-wait kind reaches out through three places the core never
// does: the GitHub API (octokit), the settings that hold the token, and the
// timing helpers it borrows from ../src/llm. All three are stubbed, so a poll
// that would back off for minutes over a real API runs in a test in its place
// in one microtask, the token is held in a variable a test sets, and a job that
// would wait for a merge is driven to its end by a test rather than by GitHub.
//
// The kind registers itself when its module loads (see ../src/jobs/github), so
// importing it here is what puts 'github-merge-wait' in the engine's registry.

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../src/log', () => log);

// The schedule a poll follows: a zero so a poll does not actually wait, and a
// wait that resolves at once (or rejects when its signal aborts) so a job that
// is cancelled stops spinning rather than running on through a settled promise.
vi.mock('../src/llm/index', () => ({
  backoff: () => 0,
  wait: (_ms: number, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      resolve();
    }),
  deadline: () => ({ signal: new AbortController().signal, clear: () => undefined }),
}));

// The token the kind reads from the settings, held in a variable a test sets: a
// job that has a token can poll, and one that has none settles failed.
const settings = vi.hoisted(() => {
  let token = 'ghp_a_token';
  return {
    get: vi.fn(() => ({ github: { apiKey: token } })),
    setToken: (value: string) => {
      token = value;
    },
  };
});
vi.mock('../src/settings', () => settings);

// A stand-in for @octokit/rest: the kind reaches the API through
// octokit.request, so the fake's request is what answers it. A handler a test
// sets decides what each request returns or throws, and every request is
// recorded so a test can read back the route and the headers it sent.
const octokit = vi.hoisted(() => {
  const requests: Array<{ route: string; params: { headers?: Record<string, string> } }> = [];
  let handler: (route: string, params: unknown) => unknown = () => {
    throw new Error('no octokit handler set');
  };
  return {
    requests,
    setHandler(next: (route: string, params: unknown) => unknown) {
      handler = next;
    },
    reset() {
      requests.length = 0;
      handler = () => {
        throw new Error('no octokit handler set');
      };
    },
    Octokit: vi.fn(function fakeOctokit() {
      return {
        request: async (route: string, params: unknown) => {
          requests.push({ route, params: params as { headers?: Record<string, string> } });
          return handler(route, params);
        },
      };
    }),
  };
});
vi.mock('@octokit/rest', () => ({ Octokit: octokit.Octokit }));

import * as jobs from '../src/jobs';
import '../src/jobs/github';

// A fake store: the engine persists a job's cursor through it, and a test points
// it here rather than at a file, the way ../tests/jobs.test.ts drives the
// built-in poll kind.
type FakeStore = { text: string | null };
const store = () => (globalThis as { chStore?: FakeStore }).chStore;
function fakeStore(seed: string | null = null): FakeStore {
  const s: FakeStore = { text: seed };
  (globalThis as { chStore?: FakeStore }).chStore = s;
  jobs.setStore({ load: () => s.text, save: (json: string) => void (s.text = json) });
  return s;
}

// Every test starts from no running jobs, its own store, a fresh token, and no
// queued requests, and the log is wiped so a test that checks it is not reading
// another test's call.
beforeEach(() => {
  jobs.reset();
  fakeStore(null);
  octokit.reset();
  settings.setToken('ghp_a_token');
  log.info.mockReset();
  log.error.mockReset();
});

afterEach(() => {
  delete (globalThis as { chStore?: FakeStore }).chStore;
});

// A 200 off the GitHub API as the kind reads it: the pull request off the data
// object, with the status and headers it needs to tell a 200 from a 304.
type PullOver = Partial<Record<'number' | 'title' | 'merged' | 'merged_at' | 'merge_commit_sha' | 'state', unknown>>;
const pull = (over: PullOver = {}) => ({
  status: 200,
  headers: {},
  data: {
    number: 42,
    title: 'A pull request',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    state: 'open',
    ...over,
  },
});

describe('the github-merge-wait kind', () => {
  it('is registered as a job kind the engine runs', () => {
    const kind = jobs.getJobKind('github-merge-wait');
    expect(kind).toBeDefined();
    expect(kind!.kind).toBe('github-merge-wait');
  });

  it('throws when the inputs are not a pull request', () => {
    expect(() => jobs.start('github-merge-wait', { owner: 'me' }, 't1')).toThrow(/github-merge-wait needs inputs/);
    expect(() => jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: '42' }, 't1')).toThrow(
      /github-merge-wait needs inputs/
    );
  });

  it('fails when no token is set, before it ever polls', async () => {
    settings.setToken('');
    const id = jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: 42 }, 't1');
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('failed');
    expect(found[0].result).toMatch(/No GitHub token/);
    // It did not reach the API: a job with no token never polls.
    expect(octokit.requests).toHaveLength(0);
  });

  it('resolves with the merge when the pull request has merged', async () => {
    octokit.setHandler(() =>
      pull({
        merged: true,
        merged_at: '2020-01-01T00:00:00Z',
        merge_commit_sha: 'abc123',
        state: 'closed',
      })
    );
    const id = jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: 42 }, 't1');
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('done');
    expect(found[0].result).toEqual({
      merged: true,
      merged_at: '2020-01-01T00:00:00Z',
      merge_commit_sha: 'abc123',
      pr_number: 42,
      title: 'A pull request',
    });
    // It polled the pull's own endpoint, with the repository and number it was given.
    expect(octokit.requests[0].route).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}');
    expect(octokit.requests[0].params).toMatchObject({ owner: 'me', repo: 'x', pull_number: 42 });
    // A first poll carries no ETag to compare against.
    expect(octokit.requests[0].params.headers).toBeUndefined();
  });

  it('carries a 304 ETag forward and keeps polling until it merges', async () => {
    // Two 304s, each carrying an ETag the next poll must send, then a merge.
    let calls = 0;
    octokit.setHandler(() => {
      calls += 1;
      if (calls <= 2) return { status: 304, headers: { etag: `"E${calls}"` } };
      return pull({ merged: true, merged_at: 'm', merge_commit_sha: 's', state: 'closed' });
    });
    const id = jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: 42 }, 't1');
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('done');
    expect(calls).toBe(3);
    // Each poll after the first sends the ETag the one before it carried.
    expect(octokit.requests[0].params.headers).toBeUndefined();
    expect(octokit.requests[1].params.headers?.ifNoneMatch).toBe('"E1"');
    expect(octokit.requests[2].params.headers?.ifNoneMatch).toBe('"E2"');
  });

  it('fails when the pull request is closed without merging', async () => {
    octokit.setHandler(() => pull({ merged: false, state: 'closed' }));
    const id = jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: 42 }, 't1');
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('failed');
    expect(found[0].result).toMatch(/closed without merging/);
    expect(found[0].result).toContain('me/x#42');
  });

  it('can be cancelled while it is still polling', async () => {
    // A 304 forever, so the job would run on until it is stopped.
    octokit.setHandler(() => ({ status: 304, headers: { etag: '"E1"' } }));
    const id = jobs.start('github-merge-wait', { owner: 'me', repo: 'x', pull_number: 42 }, 't1');
    jobs.cancel(id);
    const found = await jobs.waitFor([id]);
    expect(found[0].state).toBe('cancelled');
  });
});

describe('surviving an app close', () => {
  it('re-drives a running wait from its persisted ETag on init', async () => {
    // One poll, which merges on the first request — the only thing a test can
    // read back is the ETag the record carried in, sent as the ifNoneMatch.
    octokit.setHandler(() =>
      pull({ number: 7, title: 'The one that resumed', merged: true, merged_at: 'm', state: 'closed' })
    );
    const record = {
      id: 'gh-1',
      thread: 't1',
      kind: 'github-merge-wait',
      inputs: { owner: 'me', repo: 'x', pull_number: 7 },
      state: 'running' as const,
      result: undefined,
      createdAt: 0,
      cursor: { polls: 3, etag: '"E3"' },
      lastPoll: 0,
    };
    fakeStore(JSON.stringify([record]));

    const seen: string[] = [];
    jobs.onEvent((_t, i, event) => seen.push(`${i}/${event}`));

    jobs.init();
    const found = await jobs.waitFor(['gh-1']);
    expect(found[0].state).toBe('done');
    expect(found[0].result).toMatchObject({ pr_number: 7, title: 'The one that resumed' });
    // It asked GitHub not to re-send an unchanged PR: the ETag the record held.
    expect(octokit.requests[0].params.headers?.ifNoneMatch).toBe('"E3"');
    expect(seen).toContain('gh-1/resumed');
  });
});
