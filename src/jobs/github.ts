// A job kind that waits on a GitHub pull request to merge, registered like any
// other kind (see ./jobs). The core engine in ./jobs is octokit-free so it can
// be driven under a test; the one kind that reaches out to a network lives here,
// off to the side, and shares runMergeWait between its start and resume the way
// the built-in 'poll' kind shares runPoll.
//
// The cursor is an object { polls, etag? } rather than the poll kind's numeric
// count: a 304 from the GitHub API carries an ETag forward so a re-open does not
// re-fetch an unchanged PR, and the poll count survives a close so a long wait
// does not restart from zero.
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import * as settings from '../settings';
import { backoff, wait } from '../llm/index';
import { registerJobKind } from '../jobs';
import type { JobContext, JobHandle, JobKind } from '../jobs';

// What a merge wait is handed: the repository and the pull request it waits on.
type Inputs = { owner: string; repo: string; pull_number: number };

// The resume point: how many polls have happened, and the ETag the last 304
// carried, so a re-open can ask GitHub not to re-send an unchanged PR.
type Cursor = { polls: number; etag?: string };

// What the job resolves to when the PR has merged: the merge commit, when it
// merged, and the pull request it was waiting on.
type MergeResult = {
  merged: true;
  merged_at: string | null;
  merge_commit_sha: string | null;
  pr_number: number;
  title: string;
};

// The GitHub API type of pulls.get: the data object the method resolves to, and
// the full response whose status is read to tell a 304 from a 200. The method
// types only the 200, so the response is read off a looser shape that also
// carries a 304's status and headers.
type Pull = RestEndpointMethodTypes['pulls']['get']['response']['data'];
type PullsGetResponse = { status: number; data: Pull; headers: Record<string, string> };

// The kind of that name. start runs from a fresh cursor of { polls: 0 }; resume
// re-drives from the persisted cursor, read defensively so a record whose cursor
// is missing or the wrong shape starts over from zero rather than throwing.
const GITHUB_MERGE_WAIT = 'github-merge-wait';

// Reads a persisted cursor into a { polls, etag? } one: anything that is not an
// object, or has a non-numeric polls, is treated as no cursor at all.
function readCursor(cursor: unknown): Cursor {
  const out: Cursor = { polls: 0 };
  if (cursor && typeof cursor === 'object') {
    const c = cursor as Record<string, unknown>;
    if (typeof c.polls === 'number' && Number.isFinite(c.polls)) out.polls = c.polls;
    if (typeof c.etag === 'string') out.etag = c.etag;
  }
  return out;
}

// Shared by start and resume. Polls the GitHub API on a backoff schedule,
// cancellable on ctx.signal, until the pull request has merged, at which point
// it resolves the merge result. A 304 carries its ETag forward into the cursor;
// each tick hands the cursor back to the engine via onCursor so a close can
// resume from it. Modelled on runPoll in ./jobs.
function runMergeWait(inputs: Inputs, fromCursor: Cursor, ctx: JobContext): JobHandle {
  let polls = fromCursor.polls;
  let etag = fromCursor.etag;
  let attempt = 0;
  let done = false;
  const ac = new AbortController();
  ctx.signal.addEventListener('abort', () => ac.abort());

  // A no token: the job cannot poll, so it settles failed the way the engine's
  // settle turns a rejected promise into a failed job.
  const token = settings.get().github.apiKey;
  if (!token) {
    return {
      promise: Promise.reject(new Error('No GitHub token set — add one in Settings → GitHub.')),
      cancel: () => ac.abort(),
      cursor: () => ({ polls, etag }),
    };
  }

  const octokit = new Octokit({ auth: token });

  const promise = new Promise<MergeResult>((resolve, reject) => {
    const stopped = () => {
      if (done) return;
      done = true;
      ac.signal.removeEventListener('abort', stopped);
      reject(new Error('job cancelled'));
    };
    // Fire-and-forget, as runPoll does: the only thing that can throw out of
    // this loop is the wait aborting, which stopped() already turns into a
    // rejection of the main promise, so the loop's own promise is swallowed here
    // or it would surface as an unhandled rejection when the job is cancelled.
    (async () => {
      for (;;) {
        if (ac.signal.aborted) return stopped();
        let res: PullsGetResponse;
        try {
          // octokit.pulls.get unwraps to the data object and takes no headers arg,
          // so the same endpoint is reached through octokit.request, which carries
          // the ifNoneMatch header and returns the full response to read a 304.
          res = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: inputs.owner,
            repo: inputs.repo,
            pull_number: inputs.pull_number,
            signal: ac.signal,
            headers: etag ? { ifNoneMatch: etag } : undefined,
          })) as unknown as PullsGetResponse;
        } catch (err) {
          if (ac.signal.aborted || done) return;
          done = true;
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        // A 304 means the PR has not changed since the last poll: take the ETag
        // the response carries and keep it for the next tick.
        if (res.status === 304) {
          etag = res.headers['etag'];
          polls += 1;
          ctx.onCursor?.({ polls, etag });
          ctx.emit('progress', { polls, unchanged: true });
          const ms = backoff(attempt++, undefined, Math.random);
          await wait(ms, ac.signal);
          continue;
        }
        // A 200 (or any changed body): read the PR off the data object and
        // advance the cursor before deciding whether the wait is over.
        const pr: Pull = (res.data ?? {}) as Pull;
        polls += 1;
        ctx.onCursor?.({ polls, etag });
        ctx.emit('progress', { polls, state: pr.state });
        if (pr.merged) {
          if (done) return;
          done = true;
          ac.signal.removeEventListener('abort', stopped);
          const result: MergeResult = {
            merged: true,
            merged_at: pr.merged_at ?? null,
            merge_commit_sha: pr.merge_commit_sha ?? null,
            pr_number: pr.number,
            title: pr.title,
          };
          ctx.emit('done', result);
          return resolve(result);
        }
        if (pr.state === 'closed' && !pr.merged) {
          if (done) return;
          done = true;
          ac.signal.removeEventListener('abort', stopped);
          return reject(new Error(`PR ${inputs.owner}/${inputs.repo}#${pr.number} closed without merging.`));
        }
        const ms = backoff(attempt++, undefined, Math.random);
        await wait(ms, ac.signal);
      }
    })().catch(() => undefined);
    if (ac.signal.aborted) return stopped();
    ac.signal.addEventListener('abort', stopped, { once: true });
  });

  return {
    promise,
    cancel: () => ac.abort(),
    cursor: () => ({ polls, etag }),
  };
}

function inputsFrom(raw: unknown): Inputs {
  const i = (raw ?? {}) as Partial<Inputs>;
  if (typeof i.owner !== 'string' || typeof i.repo !== 'string' || typeof i.pull_number !== 'number') {
    throw new Error('github-merge-wait needs inputs { owner: string, repo: string, pull_number: number }');
  }
  return i as Inputs;
}

const GITHUB_MERGE_WAIT_KIND: JobKind = {
  kind: GITHUB_MERGE_WAIT,
  describe:
    'Wait until a GitHub pull request is merged (polls the GitHub API; resumes from its last poll if the app closed).',
  start(inputs, ctx) {
    return runMergeWait(inputsFrom(inputs), { polls: 0 }, ctx);
  },
  resume(job, ctx) {
    return runMergeWait(inputsFrom(job.inputs), readCursor(job.cursor), ctx);
  },
};

registerJobKind(GITHUB_MERGE_WAIT_KIND);
