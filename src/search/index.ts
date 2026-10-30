// Code search for threads that were started in a workspace: a search by meaning
// over embeddings from a local Ollama model (see embeddings.ts), with plain
// keyword matches as the fallback (see ripgrep.ts). The tool a model calls is
// defined in ../tools/search.ts.
//
// This is only the lifecycle: where the vectors are kept, which Ollama makes
// them, and giving each thread its own copy of its workspace's index to search.

import fs from 'fs';
import path from 'path';
import * as log from '../log';
import type { LocalSettings } from '../types';
import * as embeddings from './embeddings';
import * as threads from './threads';

export * as embeddings from './embeddings';
export * as threads from './threads';

export function init(dir: string): void {
  embeddings.configure({ dir });
  // The threads' own index lives beside the code's (see threads.ts)
  threads.configure({ dir });
  // The search this replaced kept a clone of every workspace it searched, under
  // `search`. Those are dead weight now, and a clone of a repository is not
  // small, so the first run after the change clears them out.
  try {
    fs.rmSync(path.join(dir, 'search'), { recursive: true, force: true });
  } catch (err) {
    log.warn('search.init', { error: (err as Error).message });
  }
}

// The local server the embeddings are asked for, which the user may change
export function configure(local: LocalSettings): void {
  embeddings.configure({ local });
}

// A thread with a workspace is on screen: gives the thread its own copy of the
// workspace's embeddings to search and to keep in step with its own work, and
// gets the workspace indexed in the background if it hasn't been yet, so the
// first search isn't the thing that waits for it.
export function open(threadId: string, workspace: string): void {
  embeddings.adopt({ workspace, thread: threadId });
  embeddings.start(workspace);
}

// The thread is gone: its own copy of the embeddings goes with it, while the
// workspace's is left for the threads that share it.
export function close(threadId: string): void {
  embeddings.forgetThread(threadId);
}

// ...and so does what was said in it, which is searchable until it is deleted
export function forget(threadId: string): void {
  embeddings.forgetThread(threadId);
  threads.forgetThread(threadId);
}
