// What a thread has changed in its container since its workspace was copied in,
// and writing those changes back to the workspace when the user asks.
//
// The container keeps a record of the files as they were copied (see BASELINE
// in docker.ts). A change is told by comparing against that record, and is
// written back as a three-way merge of each file: what the file was when it
// was copied, what the thread made of it, and what is in the workspace now. So
// the user's own edits since the copy are kept where they don't overlap with
// the thread's, and where they do, nothing at all is written: applying is
// all or nothing.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as log from '../log';
import type { AppliedChanges, FileChange, ThreadChanges } from '../types';
import * as docker from './docker';
import { toolEnv } from './env';
import { withFileLock } from './lock';

const MAX_FILES = 500; // changed files handled at once
const MAX_DIFF_LENGTH = 20000; // characters of any one file's diff shown
const UNAVAILABLE =
  "This thread's changes can't be told: its container was made without a record of the workspace's files. " +
  'Threads started from now on have one.';

const STATUSES: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

// The thread's own corner of the working directory (see AGENT_DIR): its
// context note and whatever else it keeps for itself. It is not part of the
// project, so it is neither shown as a change to look over nor written back.
const isAgentsOwn = (file: string) => file === docker.AGENT_DIR || file.startsWith(`${docker.AGENT_DIR}/`);

// A changed file as Git reports it: what it was and what it is now
interface RawChange {
  path: string;
  status: FileChange['status'];
  // Blob ids and modes; null on the side where the file doesn't exist
  before: { id: string; mode: string } | null;
  after: { id: string; mode: string } | null;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function git(threadId: string, args: string): Promise<{ code: number | null; data: Buffer } | null> {
  return docker.read(threadId, `${docker.BASELINE} ${args}`);
}

// The files changed since the record was made (or since changes were last
// applied). null if the thread has no container; throws if it has no record.
async function changed(threadId: string): Promise<RawChange[] | null> {
  // Everything new is taken note of first, so that added files are seen
  const staged = await git(threadId, 'add -A');
  if (!staged) return null;
  if (staged.code !== 0) throw new Error(UNAVAILABLE);
  const listed = await git(threadId, 'diff --cached --raw -z --no-renames --abbrev=40 HEAD');
  if (!listed || listed.code !== 0) throw new Error(UNAVAILABLE);

  // ":100644 100755 <id> <id> M\0path\0" for each file
  const fields = listed.data.toString('utf8').split('\0').filter(Boolean);
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [beforeMode, afterMode, beforeId, afterId, letter] = fields[i].slice(1).split(' ');
    const status = STATUSES[letter[0]];
    if (!status) continue;
    // Left out here, so that neither what is shown nor what is written back
    // has the thread's own notes in it
    if (isAgentsOwn(fields[i + 1])) continue;
    changes.push({
      path: fields[i + 1],
      status,
      before: /^0+$/.test(beforeId) ? null : { id: beforeId, mode: beforeMode },
      after: /^0+$/.test(afterId) ? null : { id: afterId, mode: afterMode },
    });
  }
  return changes;
}

// Each file's part of a whole diff, by path
function diffs(patch: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+) b\/\1$/m.exec(part);
    if (!header) continue;
    // The lines a reader wants: from the first hunk on, or the note that it is binary
    const at = part.search(/^(@@|Binary files )/m);
    const body = at === -1 ? '' : part.slice(at).trimEnd();
    result.set(header[1], body.length > MAX_DIFF_LENGTH ? `${body.slice(0, MAX_DIFF_LENGTH)}\n[diff cut short]` : body);
  }
  return result;
}

// What the thread has changed, for the user to look over
export async function list(threadId: string): Promise<ThreadChanges> {
  try {
    const raw = await changed(threadId);
    if (!raw || raw.length === 0) return { files: [] };
    const patch = await git(threadId, 'diff --cached --no-renames --no-color HEAD');
    const byPath = diffs(patch?.data.toString('utf8') ?? '');
    return {
      files: raw.slice(0, MAX_FILES).map(({ path: file, status }) => {
        const diff = byPath.get(file) ?? '';
        return { path: file, status, diff, binary: diff.startsWith('Binary files ') };
      }),
      more: Math.max(0, raw.length - MAX_FILES) || undefined,
    };
  } catch (err) {
    return { files: [], unavailable: (err as Error).message };
  }
}

// Several of the record's files at once, in the order their ids were given,
// with null where one could not be read. They go to the container in a single
// command: one at a time cost 55ms each, which a thread with a hundred
// changed files paid twice over every time its changes were looked at (see
// docker.readEach).
async function blobs(threadId: string, ids: string[]): Promise<(Buffer | null)[]> {
  const commands = ids.map((id) => `${docker.BASELINE} cat-file blob ${quote(id)}`);
  const results = await docker.readEach(threadId, commands);
  if (!results) return ids.map(() => null);
  return results.map((result) => (result.code === 0 ? result.data : null));
}

const isBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

// What the thread has made of a file it changed: its text, or null where
// there is no text to have (it deleted the file, or the file is not text).
// Read from the record rather than the container, so it is what the thread
// has now even if it is still working.
export interface ChangedFile {
  path: string;
  status: FileChange['status'];
  text: string | null;
}

// Every file the thread has changed since its workspace was copied in, with what
// it made of each. null if the thread has no container; throws if it has no
// record. Used to keep a thread's own search index in step with its work
// (see ../search/embeddings.ts).
export async function changedText(threadId: string): Promise<ChangedFile[] | null> {
  const raw = await changed(threadId);
  if (!raw) return null;
  // A file the thread deleted has nothing to read, and a link or a nested
  // repository has no text worth reading
  const readable = raw.filter((change) => change.after?.mode.startsWith('100'));
  const read = await blobs(
    threadId,
    readable.map((change) => (change.after as { id: string }).id)
  );
  const texts = new Map(readable.map((change, at) => [change, read[at]]));
  return raw.map((change) => {
    const data = texts.get(change) ?? null;
    return {
      path: change.path,
      status: change.status,
      text: data && !isBinary(data) ? data.toString('utf8') : null,
    };
  });
}

// Several files as the thread has them now, read from its container in one
// command. A file maps to null where there is no such file or it is not text.
// One command rather than one each: a read of a container costs some 55ms
// before it reads anything (see docker.readEach).
//
// Null, rather than a map of nulls, where the thread has no container at all.
// The two are not the same answer and the caller has to tell them apart: a
// file that is not there is not there, while a thread with no container has
// changed nothing yet, so the workspace's own copy of every one of these
// files is what it would have read (see ../search/embeddings.fill, which
// could read none of the lines it had found and reported no matches).
export async function filesText(threadId: string, files: string[]): Promise<Map<string, string | null> | null> {
  const read = await docker.readEach(
    threadId,
    files.map((file) => `cat ${quote(file)}`)
  );
  if (!read) return null;
  return new Map(
    files.map((file, at) => {
      const result = read[at];
      const text = result && result.code === 0 && !isBinary(result.data) ? result.data.toString('utf8') : null;
      return [file, text];
    })
  );
}

// Merges the thread's version of a file into the workspace's, given what both
// started from. Resolves with the merged file, or null if the two changed the
// same lines.
async function merge(ours: Buffer, base: Buffer, theirs: Buffer): Promise<Buffer | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ch-merge-'));
  try {
    const files = { ours, base, theirs };
    for (const [name, data] of Object.entries(files)) await fs.promises.writeFile(path.join(dir, name), data);
    return await new Promise((resolve, reject) => {
      const child = spawn('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], {
        cwd: dir,
        env: toolEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      // The exit code is the number of conflicts, or an error
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : code && code > 0 && code < 128
            ? resolve(null)
            : reject(new Error('git merge-file failed.'))
      );
    });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// What applying one file's change comes to
type Step =
  | { path: string; write: Buffer; mode?: number }
  | { path: string; remove: true }
  | { path: string; nothing: true }
  | { path: string; conflict: string }
  | { path: string; skipped: string };

// Everything the steps will need out of the record, read in one command
// rather than two for each changed file
async function contents(threadId: string, raw: RawChange[]): Promise<Map<string, Buffer>> {
  const ids = [...new Set(raw.flatMap((c) => [c.before?.id, c.after?.id].filter((id) => id) as string[]))];
  const read = await blobs(threadId, ids);
  const held = new Map<string, Buffer>();
  ids.forEach((id, at) => {
    const data = read[at];
    if (data) held.set(id, data);
  });
  return held;
}

async function plan(workspace: string, change: RawChange, held: Map<string, Buffer>): Promise<Step> {
  const file = change.path;
  const special = [change.before, change.after].find((side) => side && !side.mode.startsWith('100'));
  if (special) return { path: file, skipped: 'Links and nested repositories are not written back.' };

  const target = path.resolve(workspace, file);
  if (!target.startsWith(path.resolve(workspace) + path.sep))
    return { path: file, skipped: 'It is outside the workspace.' };
  const ours = await fs.promises.readFile(target).catch(() => null);
  // A side of the change whose file could not be read is an error, not an
  // absence: taking it for one would have the thread's work written over
  // the workspace's as though nothing had been there
  const side = (of: { id: string } | null) => {
    if (!of) return null;
    const data = held.get(of.id);
    if (!data) throw new Error('Could not read a file from the thread.');
    return data;
  };
  const base = side(change.before);
  const theirs = side(change.after);
  const mode = change.after?.mode === '100755' ? 0o755 : undefined;

  if (!theirs) {
    // Deleted by the thread
    if (!ours) return { path: file, nothing: true };
    return base && ours.equals(base)
      ? { path: file, remove: true }
      : { path: file, conflict: 'The thread deleted it, but it has changed in the workspace since.' };
  }
  if (ours?.equals(theirs)) return { path: file, nothing: true };
  if (!base) {
    // Added by the thread
    return ours
      ? { path: file, conflict: 'The thread added it, but the workspace now has a different file by that name.' }
      : { path: file, write: theirs, mode };
  }
  if (!ours) return { path: file, conflict: 'The thread changed it, but it has been deleted from the workspace.' };
  if (ours.equals(base)) return { path: file, write: theirs, mode };
  if ([ours, base, theirs].some(isBinary)) {
    return { path: file, conflict: 'It is not a text file, and it has changed in the workspace too.' };
  }
  const merged = await merge(ours, base, theirs);
  return merged
    ? { path: file, write: merged, mode }
    : { path: file, conflict: 'The same lines were changed in the workspace and by the thread.' };
}

// Bringing the thread level with its workspace, before anyone is told the work
// is done.
//
// A thread works on a copy taken when its container was made. While it works,
// the workspace can move on: the user edits a file, another thread writes its
// changes back, a branch is checked out. Nothing says so until the changes are
// applied, which is the worst moment to find out — the work is finished, the
// user is waiting, and the file that clashes is one the thread stopped thinking
// about several steps ago.
//
// So this does the finding out early. Where the workspace has moved on and the
// thread has not touched the file, the new version is brought in and the record
// moves with it: the thread is simply working on current code from then on.
// Where both sides changed a file, the two sets of changes are tried against
// each other, and the ones that cannot be reconciled are handed back with the
// workspace's version put where the thread can read it (see WORKSPACE_COPIES),
// for the thread to settle before it says it is done (see ../harness/index.ts).

// Where the workspace's version of a clashing file is left for the thread to
// read. Under the thread's own corner of the working directory, which is not
// part of the project and so is never written back or shown as a change.
// Going back to the files as they were.
//
// A reply that fails partway has still done whatever its tools did before it
// failed: files written, files deleted, a half-finished edit. Asked for again,
// the model would be working on top of that rather than on the project — so
// the files are put back first (see the retry in ../renderer.ts and
// 'thread:revert' in ../main.ts).
//
// The record the container keeps is a Git repository, so a snapshot is a tree
// in it: one command, nothing copied, and Git itself holds on to what the
// tree refers to.

// The thread's files as they stand now. null when the thread has no container
// or the record can't be read, which `revert` takes as "however the container
// started out": a turn that began before there was a container to snapshot
// wrote everything that is in one now.
export async function snapshot(threadId: string): Promise<string | null> {
  try {
    const staged = await git(threadId, 'add -A');
    if (!staged || staged.code !== 0) return null;
    const written = await git(threadId, 'write-tree');
    if (!written || written.code !== 0) return null;
    return written.data.toString('utf8').trim() || null;
  } catch (err) {
    log.warn('changes.snapshot', { thread: threadId, ok: false, error: (err as Error).message });
    return null;
  }
}

// The files as the container was made, or as they were when changes were last
// written back (see apply): where a turn that began before there was a
// container to snapshot has to go back to.
async function headTree(threadId: string): Promise<string | null> {
  const read = await git(threadId, `rev-parse ${quote('HEAD^{tree}')}`);
  if (!read || read.code !== 0) return null;
  return read.data.toString('utf8').trim() || null;
}

// Puts the thread's files back to a snapshot, and removes whatever has been
// made since. Files the project's .gitignore leaves out are left where they
// are: a build's output and its installed dependencies are not what anybody
// means by going back, and throwing them away would cost the next attempt
// minutes it has no reason to spend.
//
// `tree` as null means the state the container was made in. Returns whether
// anything was in fact put back, which is false when the thread has no
// container or its files are already as they were.
export async function revert(threadId: string, tree: string | null): Promise<boolean> {
  const started = performance.now();
  try {
    const now = await snapshot(threadId);
    // No container, so nothing was written and there is nothing to put back
    if (now === null) return false;
    const target = tree ?? (await headTree(threadId));
    if (!target || now === target) return false;
    const back = await git(threadId, `read-tree -u --reset ${quote(target)}`);
    if (!back || back.code !== 0) throw new Error('The files could not be put back as they were.');
    // read-tree leaves alone what it never knew about, so what was made since goes now
    await git(threadId, 'clean -fdq');
    log.info('changes.revert', { thread: threadId, ok: true, ms: log.since(started) });
    return true;
  } catch (err) {
    log.warn('changes.revert', { thread: threadId, ok: false, error: (err as Error).message });
    return false;
  }
}

export const WORKSPACE_COPIES = `${docker.AGENT_DIR}/workspace`;

export interface Synced {
  // The workspace moved on in these and the thread had not touched them: they
  // are now in the container, as current as the workspace
  pulled: string[];
  // Both sides changed these, and the changes have been put together: the
  // thread's copy holds both now, and goes back as it stands
  merged: string[];
  // ...and these, which would not go together. `copy` is where the
  // workspace's version is to be read, or '' where the workspace has none (it
  // was deleted there).
  clashes: { path: string; reason: string; copy: string }[];
  // How many files that had moved were more than could be dealt with at once,
  // and are left for the next call
  cut?: number;
  // Why none of it could be done
  error?: string;
}

// What Git would call a file's content, so that the workspace's files can be
// compared with the record without reading the record's
function blobId(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

// A file as the record holds it: what it was, and how
interface Recorded {
  id: string;
  mode: string;
}

// The record's files, by path
async function recorded(threadId: string): Promise<Map<string, Recorded>> {
  const listed = await git(threadId, 'ls-tree -r -z HEAD');
  if (!listed || listed.code !== 0) throw new Error(UNAVAILABLE);
  const tree = new Map<string, Recorded>();
  for (const entry of listed.data.toString('utf8').split('\0').filter(Boolean)) {
    // "<mode> <type> <id>\t<path>"
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode, , id] = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), { id, mode });
  }
  return tree;
}

// Every file in a workspace that is not a Git repository, which is what was
// copied into the container for one (see docker.copyWorkspace). Directories
// that are links are not followed.
async function everyFile(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await everyFile(path.join(dir, entry.name), `${name}/`)));
    else if (entry.isFile()) found.push(name);
  }
  return found;
}

// The project's files the workspace and the record do not agree about: each
// with the workspace's version, or null where the workspace no longer has it.
//
// Only the ones that differ are kept. Every file has to be read to be told
// against the record, but a project of any size would be held in memory whole
// if they were all kept, where what is wanted is the handful that moved.
//
// Nothing is left out for being too much to read: a file that was not looked
// at is indistinguishable here from one the user deleted, and would be taken
// out of the thread's container (see sync). Which files are dealt with is
// decided afterwards, where it can be said rather than silently done.
async function movedInWorkspace(workspace: string, tree: Map<string, Recorded>): Promise<Map<string, Buffer | null>> {
  const listed = await docker.filesToCopy(workspace);
  const names = listed ?? (await everyFile(workspace));
  // Nothing found where there is no Git to ask is the shape of a workspace
  // that could not be read rather than one the user emptied, and taking it at
  // its word would empty the container to match. A repository that lists no
  // files has answered, and is believed.
  if (!listed && names.length === 0 && tree.size > 0) throw new Error("The workspace's files could not be read.");

  const moved = new Map<string, Buffer | null>();
  const held = new Set<string>();
  for (const file of names) {
    if (isAgentsOwn(file)) continue;
    held.add(file);
    const data = await fs.promises.readFile(path.resolve(workspace, file)).catch(() => null);
    // A file that is there but cannot be read is not a file that is gone
    if (!data) continue;
    if (tree.get(file)?.id !== blobId(data)) moved.set(file, data);
  }
  for (const file of tree.keys()) {
    if (!held.has(file) && !isAgentsOwn(file)) moved.set(file, null);
  }
  return moved;
}

// The clashes the thread was handed last time, kept in the record's own
// directory: the thread cannot edit it, and putting its files back as they
// were does not take it (see revert).
const CLASHES = `${docker.BASELINE_DIR}/ch-clashes.json`;

// One of them: the two versions that would not go together, as blob ids, so
// that a file the thread has worked on since can be told from one it has left
// alone. null on a side that had no file.
interface Clashed {
  workspace: string | null;
  thread: string | null;
}

async function clashesHandedOver(threadId: string): Promise<Record<string, Clashed>> {
  const read = await docker.read(threadId, `cat ${quote(CLASHES)}`);
  if (!read || read.code !== 0) return {};
  try {
    const held = JSON.parse(read.data.toString('utf8')) as Record<string, Clashed>;
    return held && typeof held === 'object' ? held : {};
  } catch {
    return {};
  }
}

async function handOver(threadId: string, clashes: Record<string, Clashed>): Promise<void> {
  await docker.exec(threadId, `cat > ${quote(CLASHES)}`, { input: Buffer.from(JSON.stringify(clashes)) });
}

// Moves what one file's change is measured from on to the workspace's version
// of it, leaving the file itself alone.
//
// Without this a clash cannot be settled at all. The three-way merge is made
// against the file as it was when the container was copied, so a file the
// thread has made hold both sets of changes still differs from that on the
// very lines the workspace changed, and the merge says so again, and again:
// the only version that ever stops clashing is the workspace's own, which is
// the thread giving up its work. Once the workspace's version is what the
// change is measured against, the thread's file goes back as it stands.
//
// The working tree is not touched, so nothing races with the thread's own
// writing. `ours` as null records the file as gone from the workspace.
async function settle(threadId: string, file: string, ours: Buffer | null, mode: string): Promise<boolean> {
  const base = docker.BASELINE;
  // The mode recorded here is only what the next comparison starts from; what
  // a file is written back as comes from the thread's side (see plan)
  const update = ours
    ? `${base} update-index --add --cacheinfo ${mode},$ch_blob,${quote(file)}`
    : `${base} update-index --force-remove ${quote(file)}`;
  const command = [
    ...(ours ? [`ch_blob=$(${base} hash-object -w --stdin)`] : []),
    `${base} read-tree HEAD`,
    update,
    `ch_tree=$(${base} write-tree)`,
    `ch_commit=$(${base} commit-tree $ch_tree -p HEAD -m settled)`,
    `${base} update-ref HEAD $ch_commit`,
  ].join(' && ');
  const { code } = await docker.exec(threadId, command, ours ? { input: ours } : {});
  return code === 0;
}

// Writes a file into the thread's container, making its folder first.
//
// Behind the lock the thread's own writing takes, since a sync runs beside
// the tool calls of the turn that asked for it: a file written here while an
// edit of it was in flight would be silently undone by the edit (see lock.ts).
async function put(threadId: string, file: string, content: Buffer): Promise<boolean> {
  const command = `mkdir -p "$(dirname ${quote(file)})" && cat > ${quote(file)}`;
  const written = await withFileLock(threadId, file, () => docker.exec(threadId, command, { input: content }));
  return written.code === 0;
}

export async function sync(threadId: string, workspace: string): Promise<Synced> {
  const started = performance.now();
  const nothing = { pulled: [], merged: [], clashes: [] };
  try {
    const raw = await changed(threadId);
    if (!raw) return nothing;
    const tree = await recorded(threadId);
    const theirs = new Map(raw.map((change) => [change.path, change]));
    const handed = await clashesHandedOver(threadId);

    const moved = await movedInWorkspace(workspace, tree);
    const files = [...moved.keys()].sort();
    const cut = Math.max(0, files.length - MAX_FILES) || undefined;

    const held = raw.length > 0 ? await contents(threadId, raw) : new Map<string, Buffer>();
    const pulled: string[] = [];
    const merged: string[] = [];
    const clashes: Synced['clashes'] = [];
    const outstanding: Record<string, Clashed> = {};
    for (const file of files.slice(0, MAX_FILES)) {
      const ours = moved.get(file) ?? null;
      const change = theirs.get(file);
      // The thread has not touched it, so there is nothing to reconcile: it
      // takes the workspace's version and the record moves with it
      if (!change) {
        const done = ours ? await put(threadId, file, ours) : await removeFrom(threadId, file);
        if (done) pulled.push(file);
        continue;
      }

      const ourId = ours ? blobId(ours) : null;
      const theirId = change.after?.id ?? null;
      // A clash it was handed last time, with the same version of the
      // workspace's file in front of it, which it has worked on since: it has
      // settled it, so the workspace's version becomes what its change is
      // measured from and its file goes back as it stands. Nothing else can
      // ever clear a clash (see settle).
      const was = handed[file];
      if (was && was.workspace === ourId && was.thread !== theirId) {
        if (await settle(threadId, file, ours, tree.get(file)?.mode ?? '100644')) {
          await removeFrom(threadId, `${WORKSPACE_COPIES}/${file}`);
          merged.push(file);
          continue;
        }
      }

      const step = await plan(workspace, change, held);
      if ('conflict' in step) {
        const copy =
          ours && (await put(threadId, `${WORKSPACE_COPIES}/${file}`, ours)) ? `${WORKSPACE_COPIES}/${file}` : '';
        clashes.push({ path: file, reason: step.conflict, copy });
        outstanding[file] = { workspace: ourId, thread: theirId };
        continue;
      }
      // Links and nested repositories are nobody's to reconcile, and are left
      // exactly as they are (see plan)
      if ('skipped' in step) continue;
      // The two go together. The thread's copy takes the result, so that what
      // it reads from here on holds the workspace's change as well as its
      // own, and what the change is measured from moves on with it. Saying
      // the two fit and leaving the thread on its own version would have it
      // working from a file that is already out of date.
      const result = 'write' in step ? step.write : null;
      if (result && !(await put(threadId, file, result))) continue;
      if (await settle(threadId, file, ours, tree.get(file)?.mode ?? '100644')) {
        merged.push(file);
        continue;
      }
      // The record would not move, so the thread is put back on its own
      // version rather than left holding a merge nothing has a record of:
      // measured against the old baseline that file would clash for ever
      const mine = change.after ? held.get(change.after.id) : null;
      if (result && mine) await put(threadId, file, mine);
      clashes.push({ path: file, reason: 'The merge of it could not be recorded.', copy: '' });
    }

    // The pulled files are the record's now, so they are nobody's change
    if (pulled.length > 0) {
      await git(threadId, `add -- ${pulled.map(quote).join(' ')}`);
      await git(threadId, `commit -q -m pulled -- ${pulled.map(quote).join(' ')}`);
    }
    if (Object.keys(outstanding).length > 0 || Object.keys(handed).length > 0) await handOver(threadId, outstanding);
    log.info('changes.sync', {
      thread: threadId,
      ms: log.since(started),
      pulled: pulled.length,
      merged: merged.length,
      clashes: clashes.length,
      cut,
    });
    return { pulled, merged, clashes, cut };
  } catch (err) {
    log.warn('changes.sync', { thread: threadId, ok: false, error: (err as Error).message });
    return { ...nothing, error: (err as Error).message };
  }
}

// A file the workspace no longer has, taken out of the container too
async function removeFrom(threadId: string, file: string): Promise<boolean> {
  const { code } = await withFileLock(threadId, file, () => docker.exec(threadId, `rm -f ${quote(file)}`, {}));
  return code === 0;
}

// What came of it, as the model reads it. Written to be read on its own: it is
// the answer to a tool call, and the one thing the model has to go on.
export function report({ pulled, merged, clashes, cut, error }: Synced): string {
  if (error) return `The workspace could not be checked against: ${error}`;
  const lines: string[] = [];
  const rest = cut
    ? [
        `${cut} more ${cut === 1 ? 'file has' : 'files have'} moved than can be dealt with in one go. Call this ` +
          'tool again when you have settled what is below, and the rest will be taken then.',
      ]
    : [];
  if (pulled.length > 0) {
    lines.push(
      `Brought in from the workspace, which had moved on while you worked (you had not touched ${
        pulled.length === 1 ? 'it' : 'them'
      }):`,
      ...pulled.map((file) => `- ${file}`),
      'Anything you read from those files before now is out of date.'
    );
  }
  if (merged.length > 0) {
    lines.push(
      'Changed in the workspace as well as by you, and the two went together. Your copy holds both now, so there ' +
        'is nothing to do beyond reading them again before you rely on what you had of them:',
      ...merged.map((file) => `- ${file}`)
    );
  }
  if (clashes.length === 0) {
    lines.push(
      pulled.length + merged.length === 0
        ? 'The workspace has not moved on since you started. Your changes will go back as they are.'
        : 'Nothing clashes. Your changes will go back as they are.'
    );
    return [...lines, ...rest].join('\n');
  }

  lines.push(
    `${clashes.length === 1 ? 'This file was' : 'These files were'} changed both in the workspace and by you, in ` +
      'ways that cannot be put together. Your changes will not go back until this is settled:'
  );
  for (const { path, reason, copy } of clashes) {
    lines.push(`- ${path}: ${reason}`);
    lines.push(
      copy
        ? `  The workspace's version is at ${copy}. Read it, work out what it is for, and make ${path} hold both ` +
            `its changes and yours. Then delete ${copy}.`
        : `  There is no version in the workspace to read.`
    );
  }
  lines.push(
    'Deal with each of them, then call this tool again: a file you have worked on since being handed it here is ' +
      'taken as settled, and your version of it goes back as it stands. Do not give up your work or the ' +
      'workspace’s: the point is a file that has both.'
  );
  return [...lines, ...rest].join('\n');
}

// What the thread has changed, as the model reads it: each file with its
// status and diff. Written to be read on its own, like `report`.
export function describeChanges({ files, more, unavailable }: ThreadChanges): string {
  if (unavailable) return `Your changes could not be told: ${unavailable}`;
  if (files.length === 0) return 'You have not changed anything since the last sync.';
  const lines = files.map(({ path: file, status, diff, binary }) =>
    [`## ${file} (${status})`, binary ? 'Binary file.' : diff || '(no textual change)'].join('\n')
  );
  if (more) lines.push(`${more} more changed ${more === 1 ? 'file is' : 'files are'} not shown.`);
  return lines.join('\n\n');
}

// Writes the thread's changes back to its workspace. If any file conflicts with
// what is in the workspace now, nothing is written and the conflicts are named.
export async function apply(threadId: string, workspace: string): Promise<AppliedChanges> {
  const started = performance.now();
  try {
    const raw = await changed(threadId);
    if (!raw || raw.length === 0) return { applied: [], conflicts: [], skipped: [] };
    if (raw.length > MAX_FILES) {
      throw new Error(`The thread has changed ${raw.length} files, which is more than can be written back at once.`);
    }

    const held = await contents(threadId, raw);
    const steps: Step[] = [];
    for (const change of raw) steps.push(await plan(workspace, change, held));
    const conflicts = steps.flatMap((s) => ('conflict' in s ? [{ path: s.path, reason: s.conflict }] : []));
    const skipped = steps.flatMap((s) => ('skipped' in s ? [{ path: s.path, reason: s.skipped }] : []));
    if (conflicts.length > 0) {
      log.info('changes.apply', { thread: threadId, ok: false, files: raw.length, conflicts: conflicts.length });
      return { applied: [], conflicts, skipped };
    }

    const applied: string[] = [];
    for (const step of steps) {
      const target = path.resolve(workspace, step.path);
      if ('write' in step) {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, step.write);
        if (step.mode) await fs.promises.chmod(target, step.mode);
        applied.push(step.path);
      } else if ('remove' in step) {
        await fs.promises.rm(target, { force: true });
        applied.push(step.path);
      }
    }
    // What was applied is where the next changes are told from
    await git(threadId, 'commit -q --allow-empty -m applied');
    log.info('changes.apply', {
      thread: threadId,
      ok: true,
      ms: log.since(started),
      applied: applied.length,
      skipped: skipped.length,
    });
    return { applied, conflicts: [], skipped };
  } catch (err) {
    log.warn('changes.apply', { thread: threadId, ok: false, error: (err as Error).message });
    return { applied: [], conflicts: [], skipped: [], error: (err as Error).message };
  }
}
