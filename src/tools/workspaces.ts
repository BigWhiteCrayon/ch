// The two tools a general chat gets a workspace of its own with: one makes the folder, the other moves the thread
// into it. They are separate because making one is a thing the model can do and then think better of, or do twice
// (a name is taken, the user wants a different one), while moving in is the step that changes what the thread is.
//
// A move changes what the thread is told and what it can call: a workspace thread has the workspace's tools and its
// own paragraph in the instructions (see ../harness/index.ts). Models do not take a change to those in the middle of a
// reply well — hosted ones sign their reasoning against the prompt it was written under (see
// ../llm/providers/anthropic.ts) and a local server reads the whole prompt again — so the reply that moves in
// carries on exactly as it began, and the thread is a workspace thread from the user's next message. What the model is
// told when it moves in says so, so that it does not reach for tools it has not been given yet.

import { isAbsolute } from 'path';
import * as docker from '../sandbox/docker';
import { contextFile } from '../sandbox';
import { withFileLock } from '../sandbox/lock';
import * as workspaces from '../sandbox/workspace';
import type { Tool } from '../types';

export const CREATE_TOOL = 'create_workspace';
export const ENTER_TOOL = 'enter_workspace';

// threadId -> the workspace it has moved into. The reply that moved it still runs without one (see the top of this
// file), so a second call in it has to be told what the first did rather than be moved again.
const moved = new Map<string, string>();

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty string.`);
  return value.trim();
}

// What goes in the thread's context note, which is what is left of this thread to the next message: the workspace
// prompt says a copy of the workspace was made when the container was, which for a thread that moved in is not so
const recorded = (workspace: string) =>
  `Moved into the workspace ${workspace}, which was made new for this thread and is a git repository with nothing ` +
  `in it. Everything written in ${docker.WORKDIR} before the move is a change to it, waiting to be applied.`;

export const tools: Tool[] = [
  {
    name: CREATE_TOOL,
    // Both change something outside the thread, so no step that only reads is offered them (a general chat is not
    // worked through in steps at all, which is why they are here only for the sake of what the steps are checked for)
    phases: ['execute'],
    generalOnly: true,
    description: `Make a new workspace: a folder of its own, set up as a git repository, ready for this chat to move
into. Use it when what the user wants is a project of its own — code, a site, a set of files they will keep and work
on — and not for a question or a snippet that is only an answer. Nothing moves yet: it returns the folder's path, and
${ENTER_TOOL} is what brings this chat into it.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'What the project is called, a few words. It becomes the folder name, e.g. "bird-tracker".',
        },
      },
      required: ['name'],
    },
    async run(input) {
      const path = await workspaces.create(requireString(input, 'name'));
      return (
        `Made the workspace ${path}, a git repository with nothing in it. ` +
        `Call ${ENTER_TOOL} with this path to move this chat into it.`
      );
    },
  },
  {
    name: ENTER_TOOL,
    phases: ['execute'],
    generalOnly: true,
    description: `Move this chat into a workspace made with ${CREATE_TOOL}. The files you have already written in your
working directory become changes to it, and the chat is listed under the workspace from then on. Your instructions and
tools do not change while you are answering this message: the workspace's own tools, such as search and notes, are
there from the user's next message.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `The path ${CREATE_TOOL} returned.` },
      },
      required: ['path'],
    },
    async run(input, { signal, threadId, workspace, emit }) {
      if (!threadId) throw new Error('This message has no thread to move.');
      if (workspace) throw new Error('This thread is already in a workspace.');
      // Without somebody to tell, the container would be moved and the thread left where it was
      if (!emit) throw new Error('This thread cannot be moved from here.');
      const path = requireString(input, 'path');
      if (!isAbsolute(path)) throw new Error(`"path" must be the whole path ${CREATE_TOOL} returned.`);

      const already = moved.get(threadId);
      if (already) {
        if (already !== path) throw new Error(`This thread has already moved into ${already}.`);
        return `This thread is already in ${already}.`;
      }
      // Only the folders ${CREATE_TOOL} made: a path of the model's choosing would put files from anywhere on the
      // user's computer into the container, and take what is in the container to anywhere on it
      if (!(await workspaces.isManaged(path))) {
        throw new Error(`${path} is not a workspace made with ${CREATE_TOOL}. Make one and use the path it returns.`);
      }
      // A folder with files in it would have them copied over what the thread has written
      if (((await docker.filesToCopy(path)) ?? ['?']).length > 0) {
        throw new Error(`${path} already has files in it. Make a new workspace for this chat instead.`);
      }

      await docker.adopt(threadId, path);
      moved.set(threadId, path);
      // Best effort: the move has happened whether or not the note says so
      await withFileLock(threadId, contextFile(), () =>
        docker.exec(threadId, `mkdir -p ${docker.AGENT_DIR} && cat >> ${docker.quote(contextFile())}`, {
          input: `${recorded(path)}\n`,
          signal,
        })
      ).catch(() => undefined);
      emit({ type: 'workspace', workspace: path });
      return (
        `This chat is now in the workspace ${path}. What you have written in ${docker.WORKDIR} is a change to it. ` +
        `Nothing about this message has changed — keep going as you ` +
        `were; the workspace's own tools are there from the user's next message.`
      );
    },
  },
];
