// A file in a workspace, read by the name a reply gave it. A reply the user
// reads may point at a part of the code with a reference (see the `file:`
// reference in ../renderer/file-ref.ts), and the window shows what it pointed
// at by reading the file here, on the user's own computer, when the user opens
// the reference. Nothing is asked about it: it is the user's own workspace, and
// the read is the user's own click, so the only thing guarded is that the path
// does not reach out of the workspace.

import fs from 'fs';
import path from 'path';
import type { WorkspaceFile } from '../types';

// A file bigger than this is not read at all: it would be held in memory to be
// paged (see ../tools/files.ts, which reads the same way)
const MAX_BYTES = 5_000_000;
// How many lines of a file are shown when a reply names the file and no range:
// the room a reference is for is a part of a file, and a whole one is a screen
// the user did not ask for
const MAX_LINES = 200;
// ...and the most a range a reply named is shown at once, so a reference that
// asks for the whole file as a range is not a screenful either
const RANGE_LINES = 500;

// The line a range began on, brought into the file: 1 where nothing was said or
// the ask ran past the file, and never before the first line
const clamp = (asked: number | undefined, lo: number, hi: number): number =>
  asked === undefined || !Number.isFinite(asked) || asked < lo ? lo : Math.round(asked) > hi ? hi : Math.round(asked);

// The path a relative name resolves to inside `workspace`, or null where it
// climbs out of it. An absolute name, or one that climbs past the top by `..`,
// is a path on the user's computer rather than in the workspace, so it is not a
// name a reference in the workspace may carry
export function resolveInWorkspace(workspace: string, rel: string): string | null {
  const base = path.resolve(workspace);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

// Reads a file of the workspace by the name a reply gave it, from `from` to
// `to` (or the first MAX_LINES of it, or the range the reply named, up to
// RANGE_LINES). It never throws: what went wrong comes back as one of the
// fields of a WorkspaceFile, which the thing that showed it says to the user.
export function readFileInWorkspace(workspace: string, rel: string, from?: number, to?: number): WorkspaceFile {
  const target = resolveInWorkspace(workspace, rel);
  if (target === null) return { path: rel, outside: true };

  // Whether the name is a file, checked after the path is resolved rather than
  // before: a reference that is not there says not found, not that the path is
  // wrong
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { path: rel, notFound: true };
  }
  if (!stat.isFile()) return { path: rel, notFound: true };

  // A link that points out of the workspace is refused rather than followed, so
  // a reference can never read a file the workspace does not have
  const real = (() => {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  })();
  const baseReal = (() => {
    try {
      return fs.realpathSync(workspace);
    } catch {
      return path.resolve(workspace);
    }
  })();
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) return { path: rel, outside: true };

  // Too large to page at all, or not text: neither is shown, and both are said
  if (stat.size > MAX_BYTES) return { path: rel, tooLarge: true };
  const buffer = fs.readFileSync(target);
  if (buffer.subarray(0, 8000).includes(0)) return { path: rel, binary: true };

  const all = buffer.toString('utf8').split('\n');
  // A file that ends with a newline does not have a last, empty line
  if (all.at(-1) === '') all.pop();
  const total = all.length;
  if (total === 0) return { path: rel, lines: [], from: 1, total: 0 };

  const start = clamp(from, 1, total);
  // A range the reply named is honoured up to the cap; a file named whole is
  // shown from the top up to the cap
  const cap = to !== undefined ? RANGE_LINES : MAX_LINES;
  // A range that was not named runs to the cap, so a file named whole is read
  const end = to === undefined ? Math.min(total, start + cap - 1) : clamp(to, start, Math.min(total, start + cap - 1));
  const shown = all.slice(start - 1, end);
  const more = total - end;
  return { path: rel, lines: shown, from: start, total, ...(more > 0 ? { more } : {}) };
}
