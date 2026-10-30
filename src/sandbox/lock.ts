// What work in a thread's container has to wait its turn for: a file two tools
// would otherwise write over each other in, and a browser there is no room in
// the container to start another of.
//
// Both come of the same thing. The tools that change a file read it, change it
// here, and write it back, as separate commands; and a turn's tool calls are
// run at the same time (see ../harness/index.ts), as are subagents working in
// the same container. Two edits to one file would otherwise both start from the
// file as it was, and the second to be written would silently undo the first.

import { posix } from 'node:path';
import { WORKDIR } from './docker';

// The work last queued for each file, settled either way, so the next can follow it
const queues = new Map<string, Promise<void>>();

// Relative paths are resolved from the working directory, as the commands
// that use them are, so that 'a.ts' and '/workspace/a.ts' share one lock
function key(threadId: string | undefined, path: string): string {
  return `${threadId ?? ''}\0${posix.resolve(WORKDIR, path)}`;
}

// Runs the work once every earlier piece of work on the same file has
// finished, whether that succeeded or not, and resolves as the work does.
export async function withFileLock<T>(threadId: string | undefined, path: string, work: () => Promise<T>): Promise<T> {
  const file = key(threadId, path);
  const run = (queues.get(file) ?? Promise.resolve()).then(work);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(file, settled);
  try {
    return await run;
  } finally {
    // Nothing queued behind it: forget the file rather than keep it for ever
    if (queues.get(file) === settled) queues.delete(file);
  }
}

// How many screenshots or recordings may be taken in one container at once.
//
// Every one of them starts a browser, and a browser is a crowd: a headless
// Chromium screenshot peaked at 131 tasks in the container's pid cgroup on the
// image these containers are built from, and an app shot or a recording, which
// add an X server and an encoder to it, more. The cgroup counts threads as well
// as processes, so --pids-limit (see ./docker.ts) is the budget they all share:
// measured on one container, two at once came to 256 of 512, three to 374 and
// four to 486. Five pinned it at the limit, and there the kernel starts
// refusing: pthread_create fails with EAGAIN, Chromium's zygote cannot fork,
// its children abort, crashpad writes out a crash snapshot for each, and no
// shot comes back from any of them.
//
// Nothing stopped five from being asked for: a turn's tool calls all run at
// once (see ../harness/index.ts), as do the subagents sharing the container,
// and a model shown several pages to look at asks for them in one turn. So the
// browsers queue here instead, at a number low enough to leave the thread's own
// work — a dev server, a test suite — the rest of the budget.
const CAPTURES_AT_ONCE = 2;

type Gate = { free: number; waiting: (() => void)[] };

const gates = new Map<string, Gate>();

// Waits for a slot somebody else gives up, oldest waiter first, and resolves
// holding it. A call stopped while it waits takes no slot and leaves the queue.
// Its caller has already turned away a signal that was stopped before this.
function waitForSlot(gate: Gate, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const wake = () => {
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      const at = gate.waiting.indexOf(wake);
      if (at >= 0) gate.waiting.splice(at, 1);
      reject(new Error('This operation was aborted'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    gate.waiting.push(wake);
  });
}

// Runs the work once there is room in the container for another browser, and
// resolves as the work does. A slot is passed straight from one holder to the
// next waiter rather than freed and taken again, so two callers cannot both
// read it as free.
export async function withCaptureSlot<T>(
  threadId: string | undefined,
  signal: AbortSignal | undefined,
  work: () => Promise<T>
): Promise<T> {
  // A call whose turn was stopped before it got this far starts no browser:
  // the slot would be spent on work nobody is waiting for any more
  if (signal?.aborted) throw new Error('This operation was aborted');
  const container = threadId ?? '';
  const gate = gates.get(container) ?? { free: CAPTURES_AT_ONCE, waiting: [] };
  gates.set(container, gate);
  if (gate.free > 0) gate.free -= 1;
  else await waitForSlot(gate, signal);
  try {
    return await work();
  } finally {
    const next = gate.waiting.shift();
    if (next) next();
    else gate.free += 1;
    // Nobody holding a slot and nobody waiting for one: forget the container
    // rather than keep it for ever
    if (gate.free === CAPTURES_AT_ONCE && gate.waiting.length === 0) gates.delete(container);
  }
}
