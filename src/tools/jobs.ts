// The tools a model uses to start a long-running job and to collect or stop it on
// a later turn. A job outlives the turn that started it — the engine keeps it
// across an app close and re-drives it on open (see ../jobs), which is the whole
// difference from a subagent, which is dropped the moment the reply ends. The
// engine itself lives in ../jobs and runs in this process: the harness and every
// tool are driven in the main process, so a call here is a call in, with no ipc
// round-trip (mirroring ../tools/subagents.ts and ../subagents).

import * as jobs from '../jobs';
import type { Tool } from '../types';

// The one job kind that is registered as a built-in: a poll that retries until it
// stops asking to be polled. A kind that reaches out (a github-merge-wait, say) is
// a later phase, registered like any other (see ../jobs).
const POLL_KIND = 'poll';

// A job is started in the doing step, the one step that is the doing of the work:
// a job is a thing the model is doing, so it is offered only where work is being
// done, and no other. A reply not worked through in steps offers everything, so
// the same list reaches it there.
const DOING_PHASES: Tool['phases'] = ['execute'];

// Start a job of a kind and come back at it later. It returns the id the job was
// given, which is the name a later collect or stop reaches it by.
export const startJob: Tool = {
  name: 'start_job',
  phases: DOING_PHASES,
  description: `Start a job of a kind and get its id back at once, then do work that does not depend on it;
collect the result later with ${'wait_for_job'} or stop it with ${'cancel_job'}.

A job is a piece of work that takes longer than this turn — a poll that keeps going
until it is done, for instance. Unlike the subagents you may hand work out, a job outlives the turn that
started it: the engine keeps it, and so it is still there on a later turn and across an app close.

Name the kind the job is. ${POLL_KIND} is the kind that is registered today; it takes an attempts count and an
optional interval, and keeps trying until it has had its say or runs out of attempts. An id comes back in a
sentence, and that is the name you reach it by.`,
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description: `The job kind to start (for example ${POLL_KIND}).`,
      },
      inputs: {
        type: 'object',
        description: 'The structured inputs the kind takes.',
      },
    },
    required: ['kind', 'inputs'],
  },

  async run(input, context) {
    const { kind, inputs } = input as { kind?: unknown; inputs?: unknown };
    // An unknown kind is the engine's to name, and its error is clear enough to
    // surface as is, so the only thing this tool checks is that kind is a string
    // at all: an object or a number there would be passed straight through.
    if (typeof kind !== 'string') {
      throw new Error('"kind" has to be the name of the job to start, such as poll.');
    }
    // The thread the job belongs to, or none: a job started outside a thread is a
    // job with no thread, the way a subagent's thread may be undefined. The engine
    // takes a string, so an empty one is the job with no thread.
    const id = jobs.start(kind, inputs ?? {}, context.threadId ?? '');
    return `Started ${kind} job ${id}.`;
  },
};

// Collect the jobs the model started and did not collect. The one tool, not a mode
// of starting, for the same reason waiting on a subagent is: collecting is not
// starting, and a model that has to fill in a kind and inputs to collect a job
// will fill them in with something.
export const waitForJob: Tool = {
  name: 'wait_for_job',
  phases: DOING_PHASES,
  description: `Wait for the jobs you started with ${'start_job'} and did not collect, and get back where
each one is: running, done, failed, or cancelled, and what it came back with.

Name the jobs you want by the id each started as. Name none and it collects every job still running for this
thread, the way waiting on subagents collects the ones you did not wait for. Call it when you reach work that
needs what a job is doing — or before you answer, so that nothing you started is left running when you are
done.`,
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'The job ids to collect. Leave it out to collect all still running for this thread.',
      },
    },
  },

  async run(input) {
    // The ids, kept only where they are strings: a collect that names no job, or
    // an id that is not a string, is left to the engine, which collects every job
    // still out for the thread when none are named (see ../jobs waitFor).
    const given = (input as { ids?: unknown } | null)?.ids;
    const ids = Array.isArray(given) ? given.filter((id): id is string => typeof id === 'string') : undefined;
    const found = await jobs.waitFor(ids);
    if (found.length === 0) return 'Nothing of yours was still running.';
    // One line per job, the id and its settled state: the model collects to know
    // whether it may go on, and that is the one thing each line gives it.
    return found.map(({ id, state }) => `${id}: ${state}`).join('\n');
  },
};

// Stop a job that is still running. A tool of its own rather than a mode of
// collecting, for the same reason: stopping is not collecting, and it is the one
// of the three that leaves the job in the engine, marked cancelled, rather than
// returning what it held.
export const cancelJob: Tool = {
  name: 'cancel_job',
  phases: DOING_PHASES,
  description: `Stop a job you started with ${'start_job'} that is still running.

Name it by the id it started as. The job's signal is aborted and it is marked
cancelled, so it stops the work it is doing and does not run on. A job that is
already done or cancelled is left as it is.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The job id to cancel.',
      },
    },
    required: ['id'],
  },

  async run(input) {
    const { id } = input as { id?: unknown };
    if (typeof id !== 'string') {
      throw new Error('"id" has to be the job you want to cancel.');
    }
    jobs.cancel(id);
    return `Cancelled job ${id}.`;
  },
};

// Named as the other tool files are, so that ./index reads them all alike
export const tools: Tool[] = [startJob, waitForJob, cancelJob];
