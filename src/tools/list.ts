// Listing what is in the thread's container: the files and folders of its own
// copy of the workspace, so a model can see how the project is laid out before
// it searches or reads anything.
//
// The listing is deliberately shallow and bounded. A project's own files are a
// few hundred paths; what makes a listing enormous is everything around them —
// dependencies, build output, the git objects — so those are pruned rather
// than counted, and what is left is cut to MAX_ENTRIES with a line saying how
// much was cut. A tool that answers a question about the shape of a project
// with a hundred thousand paths has not answered it.
//
// Everything here runs in the container, where the copy lives at
// docker.WORKDIR. Paths in and out are relative to it, which is also how
// search_workspace and read_file speak (see ./search.ts and ./sandbox.ts).

import * as docker from '../sandbox/docker';
import type { Tool } from '../types';

const { quote, WORKDIR } = docker;

// How far down the tree one listing goes. Enough to show how a project is
// organised — its directories and what kind of thing is in each — without
// walking into the corners of it, which is what a path argument is for.
export const MAX_DEPTH = 4;
// ...and how many entries come back at most
export const MAX_ENTRIES = 300;

// Folders that say nothing about how the project is laid out, and would bury
// what does. The same list the first look at a workspace uses (see SKIPPED in
// ../harness/project.ts).
export const SKIPPED = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  'venv',
  '__pycache__',
];

// What the two halves of the output are separated by. The directories are
// listed apart from the files because that is the only portable way to tell
// which is which: `find` prints a name and nothing else, and the trailing
// slash this used to look for is never there. Marking them with -printf would
// be shorter and works only on GNU find, which the container may not have.
const SPLIT = '<<<files>>>';
// ...and what it says instead when there is nothing at the path
const MISSING = '<<<missing>>>';
const NOT_A_DIRECTORY = '<<<file>>>';

// The one command the tool runs: the two listings, or a word about why there
// are none. `find` is given a pruned, depth-limited walk and its output is
// sorted; both halves are cut short here as well as in the formatting, so a
// vast tree is never carried out of the container in the first place.
export function command(target: string, depth = MAX_DEPTH, limit = MAX_ENTRIES): string {
  const where = quote(target);
  const prune = SKIPPED.map((name) => `-name ${quote(name)}`).join(' -o ');
  // One more than the limit, so the formatting can tell "exactly this many"
  // from "more than this many"
  const walk = (type: 'd' | 'f') =>
    `find ${where} -mindepth 1 -maxdepth ${depth} \\( ${prune} \\) -prune -o -type ${type} -print 2>/dev/null` +
    ` | sort | head -n ${limit + 1}`;
  return [
    `if [ ! -e ${where} ]; then echo ${quote(MISSING)}; exit 0; fi`,
    `if [ ! -d ${where} ]; then echo ${quote(NOT_A_DIRECTORY)}; exit 0; fi`,
    walk('d'),
    `echo ${quote(SPLIT)}`,
    walk('f'),
  ].join('\n');
}

// A path as the model gave it, as the container will read it. The listing is
// relative to the working directory, and a path that leans on that being so
// ("./src", "src/") is taken to mean what it says.
export const target = (given: unknown): string => {
  const asked = typeof given === 'string' ? given.trim() : '';
  const clean = asked.replace(/^\.\//, '').replace(/\/+$/, '');
  return clean || '.';
};

// What came back, as the model reads it. Directories first and then files,
// each by its path rather than its name: "[FILE] index.ts" in a listing of
// forty directories says nothing about which one it is in.
export function format(output: string, asked: string, limit = MAX_ENTRIES): string {
  const said = output.trim();
  if (said === MISSING) return `There is no "${asked}" in this thread's container.`;
  if (said === NOT_A_DIRECTORY) return `"${asked}" is a file, not a folder. Use read_file to read it.`;

  const [directories, files] = said.split(SPLIT).map((half) =>
    half
      .split('\n')
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter(Boolean)
  );
  const rows = [
    ...(directories ?? []).map((path) => `[DIR]  ${path}`),
    ...(files ?? []).map((path) => `[FILE] ${path}`),
  ];
  if (rows.length === 0) {
    return asked === '.' ? 'The workspace is empty.' : `"${asked}" is empty.`;
  }
  const shown = rows.slice(0, limit);
  const where = asked === '.' ? `Workspace structure, in ${WORKDIR}` : `Contents of "${asked}"`;
  const lines = [`${where}:`, '', ...shown];
  if (rows.length > shown.length) {
    lines.push(
      '',
      `… and more, not listed: this shows ${shown.length} entries, ${MAX_DEPTH} levels deep at most. Give a path to ` +
        'look inside one of these folders, or use search_workspace to find what you are after.'
    );
  }
  return lines.join('\n');
}

export const tools: Tool[] = [
  {
    name: 'list_workspace',
    needsWorkspace: true,
    description: `List the files and folders in this thread's container, to see how the project is laid out. Folders
are shown as [DIR] and files as [FILE], each with its path relative to ${WORKDIR}, which is where this thread's copy
of the workspace is.

Leave the path out for the top of the workspace, or give one to look inside a folder. It lists ${MAX_DEPTH} levels at
a time and at most ${MAX_ENTRIES} entries, and does not go into dependency or build folders (${SKIPPED.slice(0, 3).join(
      ', '
    )} and the like), so a large project is listed a part at a time rather than all at once.

Use it to get your bearings. To find a particular thing, search_workspace is quicker and reads the files themselves.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `The starting directory, relative to the top of the workspace ("src", "src/search"). Defaults
to the top itself.`,
        },
      },
      required: [],
    },
    async run(input, { signal, threadId, workspace }) {
      if (input.path !== undefined && typeof input.path !== 'string') {
        throw new Error('"path" must be a string: a directory relative to the top of the workspace.');
      }
      if (!workspace) throw new Error('This thread has no workspace to list.');
      const asked = target(input.path);
      // The container's copy, not the workspace on the user's computer: this
      // runs inside the container, where that path does not exist. Giving it
      // one used to leave `find` with nothing to walk, and because its error
      // went to /dev/null and its exit code was swallowed by the pipe, the
      // answer was an empty listing rather than a complaint.
      const { code, output } = await docker.exec(threadId, command(asked), { signal });
      if (code !== 0) return `The workspace could not be listed: ${output.trim() || 'the command failed.'}`;
      return format(output, asked);
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}
