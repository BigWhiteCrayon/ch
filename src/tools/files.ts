// The tool a model reads files on the user's own computer with, outside the
// container its thread works in. Nothing is read until the user has said it
// may be, and what they have allowed for good is remembered per workspace (see
// ../harness/access.ts, which does the asking and the remembering).

import fs from 'fs';
import path from 'path';
import * as access from '../harness/access';
import type { Tool } from '../types';
import { copyHint, isContainerPath, pageFor } from './sandbox';

// A file bigger than this is not read at all: it is held in memory to be paged
const MAX_BYTES = 5_000_000;
// How many entries of a folder are listed
const MAX_ENTRIES = 200;

const lineNumber = (value: unknown, fallback: number, max = Infinity): number => {
  const asked = Number(value);
  return Number.isFinite(asked) && asked >= 1 ? Math.min(Math.round(asked), max) : fallback;
};

// Said after a path is not found, when the path is one that belongs to the other place
function hint(given: string): string | null {
  if (isContainerPath(given)) {
    return (
      `${given} is a path in this thread's container, not on the user's computer. ` +
      'read_file and list_workspace read the project.'
    );
  }
  if (!given.startsWith('/') && !given.startsWith('~')) {
    return 'Give the whole path, starting from / or from ~. Files in the project are read with read_file.';
  }
  return null;
}

function listing(folder: string): string {
  const entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) return `${folder} is empty.`;
  const shown = entries
    .slice(0, MAX_ENTRIES)
    .map((e) => `[${e.isDirectory() ? 'DIR' : 'FILE'}] ${path.join(folder, e.name)}`);
  const left = entries.length - shown.length;
  return [`Contents of ${folder}:`, '', ...shown, ...(left > 0 ? ['', `… ${left} more entries, not listed`] : [])].join(
    '\n'
  );
}

// Said about a file that is too large to page: what to search or sample it with instead. run_host_command takes
// the folder as its path and the file relative to it, and splits its command on spaces, so a name with a space in
// it gets no example
function largeHint(file: string): string {
  const name = path.basename(file);
  const how = /\s/.test(name)
    ? ''
    : ` with path ${path.dirname(file)}, for example "rg -n PATTERN ./${name}", "head -n 100 ./${name}" or ` +
      `"tail -n 100 ./${name}"`;
  return `Search or sample it with run_host_command instead${how}.`;
}

function page(file: string, from: number, count: number): string {
  const { size } = fs.statSync(file);
  if (size > MAX_BYTES) throw new Error(`${file} is ${size} bytes, which is too large to read. ${largeHint(file)}`);
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${file} is not a text file.`);
  const lines = buffer.toString('utf8').split('\n');
  // A file that ends with a newline does not have a last, empty line
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return `${file} is empty.`;
  if (from > lines.length) return `${file} has ${lines.length} lines, so there is nothing at line ${from}.`;
  const shown = lines.slice(from - 1, from - 1 + count).map((line, i) => `${from + i}: ${line}`);
  const left = lines.length - (from - 1) - shown.length;
  if (left > 0) shown.push(`… ${left} more lines; read on from start_line ${from + shown.length}`);
  return shown.join('\n');
}

export const tool: Tool = {
  name: 'read_user_file',
  // No phases of its own: it only reads, so it is offered wherever there are
  // tools at all, the finding-out step included (see ../harness/phases.ts)
  description: `Read one file, or list one folder, on the user's own computer. This is the tool for looking at a file
there, such as a config file, a log or another project the user has pointed you to. To search, count or run git in a
folder there, use run_host_command. For the project, use read_file and list_workspace instead.

The user is asked before anything is read, and may refuse: nothing is read until they say yes, and a refusal comes
back as an error you should accept, not work around. Files and folders they have allowed before are read without
asking. Ask for what you need and no more; the user reads the path in the question.

Give the whole path, starting from / or from ~. A file is read a page of lines at a time, each with its line number
(not part of the file), and the last line says where to read on from; a folder gives the names in it. A file too large
to read is searched or sampled with run_host_command instead (rg, grep, head, tail, wc).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path of a file or folder, or one starting from ~.' },
      start_line: { type: 'number', description: 'The first line to read, counting from 1. Defaults to 1.' },
      line_count: { type: 'number', description: 'How many lines to read. Defaults to a page.' },
    },
    required: ['path'],
  },
  async run(input, context) {
    if (typeof input?.path !== 'string' || !input.path.trim()) throw new Error('"path" must be a non-empty string.');
    const target = access.resolve(input.path.trim());
    // The thread's own workspace is read from its copy, which the user is not asked about
    const copy = copyHint(context, target);
    if (copy) throw new Error(copy);
    // Nothing here may say whether the path is there until the user has said yes
    let isFolder = false;
    try {
      isFolder = fs.statSync(target).isDirectory();
    } catch {
      // Reported after the question, if it is still a problem then
    }
    if (!(await access.permitted(target, isFolder, context))) {
      throw new Error(`The user did not allow reading ${target}.`);
    }
    try {
      fs.statSync(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      const why = `Could not find ${input.path.trim()}: ${code}`;
      const said = hint(input.path.trim());
      throw new Error(said ? `${why}\n${said}` : why);
    }
    if (isFolder) return listing(target);
    const { lines, most } = pageFor(context.window);
    return page(target, lineNumber(input.start_line, 1), lineNumber(input.line_count, lines, most));
  },
};

export const tools: Tool[] = [tool];
