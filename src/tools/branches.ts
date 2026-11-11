// The two tools a reply or a subagent puts its thread on a branch of its own with: one makes the branch, the other
// moves the thread onto it. They are the branch counterpart of the workspace pair next door (./workspaces.ts), and are
// split for the same reason: making one is a thing a model can do and then think better of, or do twice because the
// name was taken, while moving on is the step that changes where the thread's work ends up.
//
// The user can choose a branch for a thread when starting it, in the new-thread dialog; these are for when it is found
// only part way through — by the reply, or by a subagent it sent — that the work wants a branch of its own rather
// than whatever the user has checked out.
//
// What the move does and does not change is the whole of the design. It does not touch the container: the files stay
// as they are, and so does the baseline the thread's changes are measured against (see sandbox/docker.ts). It does not
// change the thread's instructions or its tools, as a workspace move does, because the thread already had a workspace.
// The one thing it changes is the host folder the thread's changes are written back to, which from then on is the
// branch's worktree. That is sound because the branch starts at the commit the thread's folder has checked out, so
// what reads as a change against the old folder reads as the same change against the new one.
//
// The reply and several subagents may work at once, and the thread has one place to live, so the first one to move
// wins and the rest are told so rather than each moving the thread somewhere else.

import { existsSync } from 'fs';
import { join } from 'path';
import * as docker from '../sandbox/docker';
import { contextFile } from '../sandbox';
import { withFileLock } from '../sandbox/lock';
import * as worktree from '../sandbox/worktree';
import type { Tool } from '../types';

export const CREATE_TOOL = 'create_branch';
export const ENTER_TOOL = 'enter_branch';

// Where worktrees are kept, which is the app's data directory. Set at startup from main.ts, as the other modules
// that write under it are (see harness/project.ts and search/index.ts).
let root: string | undefined;

export function init(dir: string): void {
  root = dir;
}

// threadId -> the branches made for it, by name. Kept for the life of the process, so that a branch made in one
// message can still be moved onto in a later one.
const made = new Map<string, Map<string, Branch>>();

// threadId -> the branch it was last moved onto. The reply that moved it carries on with the folder it began with
// (see the top of this file), so the thread's folder catching up with this is how a move that has taken effect is
// told from one made moments ago in the reply still running.
const moved = new Map<string, Branch>();

interface Branch {
  name: string;
  base: string;
  worktree: string;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty string.`);
  return value.trim();
}

// What goes in the thread's context note, which is what is left of this message to the next one
const recorded = (branch: Branch) =>
  `Moved this thread onto the branch ${branch.name}, made from ${branch.base}. The files in ${docker.WORKDIR} are ` +
  `unchanged; what has been written in them is a change to ${branch.name}, waiting to be applied.`;

// The repository a branch is made in: the folder the thread works from, resolved to the user's own checkout, so that
// a thread already on a branch makes its next one in the same place a thread on the main checkout would.
async function repoOf(workspace: string): Promise<string> {
  const main = await worktree.mainWorktree(workspace);
  if (!main) throw new Error(`${workspace} is not a Git repository, so it has no branches to work on.`);
  return main;
}

export const tools: Tool[] = [
  {
    name: CREATE_TOOL,
    // Both change something outside the thread, so they belong to the step that changes things and to no other
    // (see ../harness/phases.ts)
    phases: ['execute'],
    needsWorkspace: true,
    description: `Make a new branch in this workspace's repository, starting from what this thread is working on,
ready for the thread to move onto. Use it when the work you have been given belongs on a branch of its own rather than
on what the user has checked out. Nothing moves yet, and no files change: it returns the branch and the folder made for
it, and ${ENTER_TOOL} is what puts this thread on it. A name already in use is refused, so you can try another.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The branch name, a few words with dashes, e.g. "fix-upload-retry".',
        },
      },
      required: ['name'],
    },
    async run(input, { workspace, threadId }) {
      if (!threadId) throw new Error('This message has no thread to make a branch for.');
      if (!workspace) throw new Error('This thread has no workspace, so there is no repository to branch in.');
      if (!root) throw new Error('Branches are not set up in this session.');
      const name = requireString(input, 'name');
      const repo = await repoOf(workspace);
      // What the thread's own folder has checked out, which is what its files were copied from: a branch made from
      // anything else would not match them, and the thread's changes would read as a change to the wrong thing.
      const { current } = await worktree.branches(workspace);
      if (!current) throw new Error(`${workspace} has no branch checked out, so there is nothing to branch from.`);
      const folder = await worktree.ensureWorktree(repo, root, name, current, true);
      const branch: Branch = { name, base: current, worktree: folder };
      made.set(threadId, (made.get(threadId) ?? new Map()).set(name, branch));
      return (
        `Made the branch ${name} from ${current}, with its own folder at ${folder}. ` +
        `Call ${ENTER_TOOL} with the name ${name} to put this thread on it.`
      );
    },
  },
  {
    name: ENTER_TOOL,
    phases: ['execute'],
    needsWorkspace: true,
    description: `Put this thread on a branch made with ${CREATE_TOOL}. The files in your working directory do not
change: what has been written in them becomes a change to that branch, and that is where the thread's work is written
back to from now on. The thread is listed under the branch in the user's sidebar. Only one branch per thread: if
a subagent or reply working alongside you has already moved it, you will be told so.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `The name of the branch ${CREATE_TOOL} made.` },
      },
      required: ['name'],
    },
    async run(input, { signal, threadId, workspace, emit }) {
      if (!threadId) throw new Error('This message has no thread to move.');
      if (!workspace) throw new Error('This thread has no workspace, so there is no branch to move it onto.');
      // Without somebody to tell, the folder would be changed here and the thread left where it was
      if (!emit) throw new Error('This thread cannot be moved from here.');
      const name = requireString(input, 'name');

      // A move the thread has not caught up with yet is one made in the reply still running: the thread works from
      // the folder it began the message with, and is on the branch from the user's next message. One it has caught up
      // with is done and behind us, and the thread may be moved on again.
      const last = moved.get(threadId);
      if (last && last.worktree !== workspace) {
        if (last.name === name) return `This thread is already being moved onto ${name}.`;
        throw new Error(
          `This thread has already been moved onto the branch ${last.name} while answering this message, ` +
            `so it cannot also be moved onto ${name}. Carry on with the work you were given.`
        );
      }

      // Only the branches ${CREATE_TOOL} made for this thread: any other branch has a worktree with its own files in
      // it, made from some other commit, and the thread's changes would be written back over work it never saw.
      const branch = made.get(threadId)?.get(name);
      if (!branch) {
        throw new Error(`No branch named ${name} has been made in this thread. Make one with ${CREATE_TOOL} first.`);
      }
      if (!existsSync(join(branch.worktree, '.git'))) {
        throw new Error(`The folder for ${name} is gone. Make a branch with ${CREATE_TOOL} and move onto that.`);
      }

      // The container is left as it is: its files, and the baseline its changes are measured against, go on standing
      // (see the top of this file). All that changes here is where a container made later would be copied from.
      docker.setWorkspace(threadId, branch.worktree);
      moved.set(threadId, branch);
      // Best effort: the move has happened whether or not the note says so
      await withFileLock(threadId, contextFile(), () =>
        docker.exec(threadId, `mkdir -p ${docker.AGENT_DIR} && cat >> ${docker.quote(contextFile())}`, {
          input: `${recorded(branch)}\n`,
          signal,
        })
      ).catch(() => undefined);
      emit({ type: 'branch', branch });
      return (
        `This thread is now on the branch ${name}, made from ${branch.base}. The files in ${docker.WORKDIR} are ` +
        `unchanged and what has been written in them is a change to ${name}. Carry on with the work you were given.`
      );
    },
  },
];
