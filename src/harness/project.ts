// What is known about each workspace threads are started in: a short note on
// what the project in it is and how it is laid out. The note is written once,
// when a workspace is first opened, by a model that explores the workspace with
// tools (see explore): it searches the workspace, above all, and lists and reads
// what the searches point to. From then on the note is part of what the model
// is told in every thread started in that workspace.
//
// Because it is read at the start of every message, it is the overview and
// only the overview: what the project is, how it is laid out, how it is built,
// run and tested. Everything more particular than that — how one module fits
// together, what one command really needs, the trap in one corner of the code
// — goes in the many small notes beside it, which are searched when they are
// wanted rather than read every time (see ./notes.ts). A first look writes
// both: the explorers write the detail as they find it, and what comes back to
// the head explorer is the little that belongs here.
//
// Exploring fills a context window quickly, so when the window is nearly full
// the older tool results are compacted into findings (see compactor.ts).
//
// Looking at a workspace is always treated as high-effort work, however slight
// the message that set it off: the note is relied on in every thread in the
// workspace, so it goes to the most capable model there is, with room to reason.
//
// The notes belong to the workspace, not to a thread: they are kept in one file
// in the app's data folder (see init), apart from each thread's own container
// and the context note the model keeps there (../sandbox).
//
// Nothing here throws, and nothing is done until init() is called, so the
// harness can be used (and tested) without it.

import fs from 'fs';
import path from 'path';
import * as llm from '../llm';
import { SOPHISTICATION } from '../llm/sophistication';
import * as log from '../log';
import { HEAD_EXPLORER } from '../subagents/head';
// The leaf, not ../subagents: its index pulls in ./review, which would be a
// circle back through here
import { parse as parseTasks } from '../subagents';
import { findings as runSubagents } from '../subagents/run';
import { tool as subagentsTool } from '../tools/subagents';
import { tools as noteTools } from '../tools/notes';
import { tools as searchTools } from '../tools/search';
import type { HarnessEvent, ModelInfo, Tool, ToolContext } from '../types';
import { route, type Route } from './router';

const FILE_NAME = 'projects.json';
// How long a first look at a workspace may take, all of it: the head explorer,
// every explorer it sends, and the note they leave behind.
const TIMEOUT_MS = 2 * 60 * 60 * 1000;
// What the model may write in one step. Many times the note's own length: a
// model that reasons first spends its reasoning out of the same allowance,
// and is given room to
const MAX_TOKENS = 6000;
// Rounds of tool calls the model gets before it is told to write the note
export const MAX_STEPS = 12;
const MAX_RESULT_LENGTH = 6000; // characters of each tool result kept
const READ_LINES = 200; // lines of a file read at a time
// A workspace whose note couldn't be written is left alone for this long, so
// that not every message in it waits on another attempt
const RETRY_AFTER_MS = 5 * 60 * 1000;

const MAX_DEPTH = 4;
const MAX_ENTRIES = 300; // lines of the listing
const MAX_FILE_LENGTH = 3000; // characters of each telling file
const MAX_FILES_LENGTH = 12000; // characters of them all together
// Workspaces that say nothing about a project: what it depends on and builds
const SKIPPED = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  'venv',
  '__pycache__',
]);
// Files that say the most about a project, in the order they are read
const TELLING = [
  /^readme(\.\w+)?$/i,
  /^(claude|agents)\.md$/i,
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^cargo\.toml$/i,
  /^go\.mod$/,
  /^(pom\.xml|build\.gradle(\.kts)?)$/,
  /^gemfile$/i,
  /^requirements\.txt$/,
  /^makefile$/i,
  /^dockerfile$/i,
  /^tsconfig\.json$/,
];

// What the note has to say, however the workspace was looked at. The overview
// and nothing else: it is read at the start of every message in this workspace,
// so a paragraph on one module costs more over a week than it ever saves (see
// ./notes.ts for where that paragraph belongs).
const NOTE = `Say what the project is and what it does, which languages and tools it uses, how it is laid out (where
the main code, the tests and the configuration are, and the format the files follow), and how it is built, run and
tested if the files show that. Say only what the files show; do not guess. Keep to what is true of the project as a
whole: somebody reading this wants to know the shape of the workspace and how to run and test it, not how any one
part of it works. Write plain prose or a short list, in no more than 200 words, with no preamble.`;

export const PROMPT = `You are getting to know a workspace on the user's computer, so that you and other assistants
can
work in it afterwards. You are shown its top-level files. Before you write anything, explore the workspace with your
tools. Use search_workspace first and most: ask it in plain words where the things you need to know are, such as what
the project does, where it starts, how it is built, run and tested, and what conventions its code follows. Then read
the files the searches point to, and list the workspaces you have not seen into. Everything done in this workspace
later
will lean on what you write, so be thorough about what matters, but do not read everything: around ten tool calls is
enough. When you know enough, stop calling tools and reply with a note for an assistant who has not seen the
workspace,
and nothing else. ${NOTE}`;

// For a model that can't call tools, which is shown the workspace in one go instead
export const PLAIN_PROMPT = `You are given a look at a workspace on the user's computer: a listing of its files and
the
contents of the files that say most about it. Write a short note for an assistant who is about to work in this
workspace
and has not seen it. Everything the assistant does here will lean on this note, so work through what you are shown
carefully before you write. ${NOTE}`;

let file: string | null = null;
// workspace -> its note
let notes: Record<string, { text: string; writtenAt: string }> = {};
// workspace -> the note being written for it right now
const writing = new Map<string, Promise<string>>();
// workspace -> when writing its note last failed
const failedAt = new Map<string, number>();
// workspace -> the work done so far on the note being written for it, and who
// is to be told when there is more (see watch)
// What a look says as it happens. The whole of what the harness says about a
// reply, not a shorter vocabulary of its own: a look is work of the same kind,
// shown in a thread of its own (see automaticThread in ../renderer.ts), and
// the window already knows how to draw all of it.
const feeds = new Map<string, { events: HarnessEvent[]; listeners: Set<() => void> }>();

function emit(workspace: string, event: HarnessEvent): void {
  const feed = feeds.get(workspace);
  if (!feed) return;
  feed.events.push(event);
  for (const listener of feed.listeners) listener();
}

// Starts keeping the notes in projects.json in the given workspace.
export function init(dir: string): void {
  file = path.join(dir, FILE_NAME);
  notes = {};
  writing.clear();
  failedAt.clear();
  resistant.clear();
  feeds.clear();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') notes = saved;
  } catch {
    // Nothing saved yet, or nothing readable: the notes are written again
  }
}

function save(): void {
  if (!file) return;
  try {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(notes, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    log.error('project.save', { ok: false, error: (err as Error).message });
  }
}

// The workspace's note, or '' if it has none
// A thread's own note is kept apart from the workspace's, under a key that does
// not depend on the workspace, so it can be found again knowing only the thread
const threadKey = (thread: string) => `thread:${thread}`;

// Gives a thread its own note, once, by copying the workspace's. Called when the
// thread is first opened, so that it starts out knowing what the workspace knows
// and writes what it learns to its own copy from then on (see update). Does
// nothing if it has one already, or if the workspace has nothing to copy yet.
export function adopt(workspace: string, thread: string): void {
  if (!file) return;
  const mine = threadKey(thread);
  if (notes[mine] || !notes[workspace]) return;
  notes[mine] = { ...notes[workspace] };
  save();
  log.info('project.adopt', { workspace, thread });
}

// Writes a thread's note back over the workspace's, for when the thread's work
// is written back to the workspace: what it learned about the project belongs to
// the project, not to the thread that found it out.
export function promote(workspace: string, thread: string): boolean {
  const mine = notes[threadKey(thread)];
  if (!file || !mine || mine.text === notes[workspace]?.text) return false;
  notes[workspace] = { ...mine };
  save();
  log.info('project.promote', { workspace, thread, chars: mine.text.length });
  return true;
}

// Forgets a thread's own note, which goes when the thread does. The workspace's
// is left for the threads that share it.
export function forgetThread(thread: string): void {
  if (!notes[threadKey(thread)]) return;
  delete notes[threadKey(thread)];
  save();
}

// The note a thread works from: its own, where it has one, and the workspace's
// otherwise. Everything a thread is told about the project comes from here.
export function get(workspace: string, thread?: string): string {
  if (thread && notes[threadKey(thread)]) return notes[threadKey(thread)].text;
  return notes[workspace]?.text ?? '';
}

// Throws the workspace's note away and has it written again from nothing: an
// explorer goes back through the workspace as if nobody had ever looked (see
// explore). For a note that has gone stale, or wrong, or that the user simply
// wants taken again.
//
// The old note is kept until the new one is written, and put back if the look
// comes to nothing: a note that is out of date is still better than no note,
// and the user asked for a fresh one, not for the loss of the one they had.
//
// A thread that has its own copy keeps it. That copy is the thread's own work,
// and goes back to the workspace with its files; throwing it away here would
// be taking something this button did not offer to take.
export async function relook(workspace: string, thread?: string): Promise<string> {
  // One already going is the one the user is asking for
  const going = writing.get(workspace);
  if (going) return going;
  const had = notes[workspace];
  delete notes[workspace];
  failedAt.delete(workspace);
  save();
  log.info('project.relook', { workspace, had: had?.text.length });
  const note = await survey(workspace, thread);
  if (!note && had && !notes[workspace]) {
    notes[workspace] = had;
    save();
    log.warn('project.relook', { workspace, ok: false, error: 'Nothing was written, so the note it had was kept.' });
  }
  return note;
}

// When the note shown for a workspace was last written, or null if there is
// none. For telling the user how old what they are reading is.
export function writtenAt(workspace: string, thread?: string): string | null {
  if (thread && notes[threadKey(thread)]) return notes[threadKey(thread)].writtenAt;
  return notes[workspace]?.writtenAt ?? null;
}

// Whether a workspace has nothing in it but its repository, as one a thread has just made for itself does (see
// ../tools/workspaces.ts). A folder that cannot be read is not taken for empty.
function bare(workspace: string): boolean {
  try {
    return fs.readdirSync(workspace).every((name) => name === '.git');
  } catch {
    return false;
  }
}

// Whether the workspace's note is still to be written (or is being written now). Not for a workspace with nothing
// in it yet: an explorer sent through it would spend the most capable model there is on writing down that it is empty,
// and would hold the other threads off the local models while it did. It is due once there is something to look at.
export function due(workspace: string): boolean {
  if (!file || notes[workspace] || bare(workspace)) return false;
  return Date.now() - (failedAt.get(workspace) ?? -Infinity) >= RETRY_AFTER_MS;
}

// What a model is shown of a workspace: its files, a few levels deep, and the
// contents of the ones that say most about it. '' for a workspace with nothing
// in it, or one that can't be read.
// depth: how many levels of workspaces are listed. files: whether the telling
// files' contents are included.
export async function gather(workspace: string, { depth: maxDepth = MAX_DEPTH, files = true } = {}): Promise<string> {
  const lines: string[] = [];
  let cut = false;
  async function list(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Hidden workspaces are tooling, not the project; hidden files may be its configuration
      if (entry.isDirectory() && (entry.name.startsWith('.') || SKIPPED.has(entry.name))) continue;
      if (lines.length >= MAX_ENTRIES) {
        cut = true;
        return;
      }
      const indent = '  '.repeat(depth);
      if (!entry.isDirectory()) {
        lines.push(`${indent}${entry.name}`);
      } else if (depth + 1 >= maxDepth) {
        lines.push(`${indent}${entry.name}/ …`);
      } else {
        lines.push(`${indent}${entry.name}/`);
        await list(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await list(workspace, 0);
  if (lines.length === 0) return '';
  if (cut) lines.push('… and more');

  const sections = [`<files>\n${lines.join('\n')}\n</files>`];
  if (!files) return sections[0];
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(workspace);
  } catch {}
  let room = MAX_FILES_LENGTH;
  for (const pattern of TELLING) {
    for (const name of names.filter((n) => pattern.test(n))) {
      if (room <= 0) break;
      try {
        const text = (await fs.promises.readFile(path.join(workspace, name), 'utf8')).trim();
        if (!text) continue;
        const limit = Math.min(MAX_FILE_LENGTH, room);
        const shown = text.length > limit ? `${text.slice(0, limit)}\n[...]` : text;
        room -= shown.length;
        sections.push(`<file name="${name}">\n${shown}\n</file>`);
      } catch {
        // A workspace by that name, or a file that can't be read as text
      }
    }
  }
  return sections.join('\n\n');
}

// Where a path the model gave leads, if that is inside the workspace
async function inside(workspace: string, given: unknown): Promise<string> {
  const root = await fs.promises.realpath(workspace);
  const target = path.resolve(root, typeof given === 'string' && given ? given : '.');
  // Followed through links, so that none leads out of the workspace
  const real = await fs.promises.realpath(target).catch(() => {
    throw new Error(`There is no ${given} in the workspace.`);
  });
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('That path is outside the workspace.');
  return real;
}

// The tools the model explores a workspace with. They read the workspace itself, on
// the user's computer, and change nothing.
export function explorerTools(workspace: string, threadId: string | undefined): Tool[] {
  const search = searchTools.find((tool) => tool.name === 'search_workspace');
  const tools: Tool[] = [
    {
      name: 'list_files',
      description: `List the files and folders directly inside a folder of the project. Folders end in "/". Paths
are relative to the top of the project; leave the path out for the top itself.`,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async run(input) {
        const entries = await fs.promises.readdir(await inside(workspace, input?.path), { withFileTypes: true });
        const names = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        const shown = names.slice(0, MAX_ENTRIES);
        if (names.length > shown.length) shown.push(`… and ${names.length - shown.length} more`);
        return shown.join('\n') || 'The workspace is empty.';
      },
    },
    {
      name: 'read_file',
      description: `Read a text file of the project, ${READ_LINES} lines at a time, with line numbers. The path is
relative to the top of the project. Give start_line to read further into a long file. Nothing here changes while you
look, so a file you have already read is still in front of you: do not read it again except to see further into it.`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'number' } },
        required: ['path'],
      },
      async run(input) {
        if (typeof input?.path !== 'string' || !input.path) throw new Error('"path" must be a non-empty string.');
        const lines = (await fs.promises.readFile(await inside(workspace, input.path), 'utf8')).split('\n');
        const asked = Number(input.start_line);
        const first = Number.isFinite(asked) && asked > 1 ? Math.floor(asked) : 1;
        const shown = lines.slice(first - 1, first - 1 + READ_LINES).map((line, i) => `${first + i}: ${line}`);
        const left = lines.length - (first - 1 + shown.length);
        if (left > 0) shown.push(`… ${left} more lines; read on from start_line ${first + shown.length}`);
        return shown.join('\n') || 'Nothing there.';
      },
    },
  ];
  if (search) {
    tools.unshift({
      name: search.name,
      description: `Search the project. The query can describe what you are looking for in plain words ("where does
the program
start", "how are the tests run"), or use keywords or a regular expression. Returns the matching lines with their line
numbers, grouped by file, with paths relative to the top of the project. This is the quickest way to find what
matters: use it before reading files, and in preference to running grep or rg yourself. You have only a few tool calls
here, so spend them widely: paths_only gives you the files that match and none of their lines, which is the cheapest
way to see how the project is laid out, and path narrows a later search to one directory or glob.`,
      inputSchema: search.inputSchema,
      // The search belongs to a thread; a workspace looked at with no thread open borrows a name
      run: (input, context) => search.run(input, { ...context, threadId: threadId ?? 'survey', workspace }),
    });
  }
  return tools;
}

// What the model wrote, as the note
const clean = (text: string) => text.trim();

// The tools the first look has that it does not share with the registry: they
// write to the workspace itself rather than to a thread's copy of it, because
// what the first look finds is true of the project and every thread started
// here should have it. The registry's own versions of these write to whichever
// thread called them (see ../tools/context.ts and ../tools/notes.ts).
function addToNote(workspace: string): Tool {
  return {
    name: 'add_to_workspace_context',
    description: `Add a line to the note on this project. The note is what every assistant working in this workspace
is shown at the start of every message, so it is the overview and nothing else: what the project is and does, which
languages and tools it uses, how it is laid out, how it is built, run and tested, and what has to be installed for
any of that to work.

Anything more particular than that — how one module fits together, what one command needs, the convention one
directory follows, a trap in one corner of the code — is not for this note. Write it down with add_workspace_note,
where it can be found by whoever needs it without costing everybody else the room.

Use it as you go rather than at the end, once per thing you have established. Say only what the files show; do not
guess. Each line is read on its own by someone who has not seen your work, so say what it is about, and name files,
commands and identifiers exactly as they are spelled.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What you found out, in a sentence or a short paragraph.' },
      },
      required: ['content'],
    },
    run(input) {
      if (typeof input?.content !== 'string') throw new Error('"content" must be a non-empty string.');
      append(workspace, input.content);
      return 'Added to the note.';
    },
  };
}

// The detailed notes, written and searched as the workspace's own. The same
// two tools a thread gets (see ../tools/notes.ts), with the thread taken off
// the context they run in: a thread's note is only that thread's until its
// changes are written back (see ./notes.ts), and a first look is not a thread's
// work but the workspace's.
//
// This is where most of what a first look finds ends up. The explorers it
// sends write a note per thing they establish and report back the shape of it;
// only the shape reaches the note every message carries.
function notesTools(workspace: string): Tool[] {
  return noteTools.map((tool) => ({
    ...tool,
    run: (input: Record<string, unknown>, context: ToolContext) =>
      tool.run(input, { ...context, workspace, threadId: undefined }),
  }));
}

// What the explorer is sent after. It is given the workspace's top level to
// start from, since the alternative is spending its first round finding out
// what it is looking at.
// What it is sent after, apart from the listing: the window shows this as the
// explorer's task, the same as a thread's subagent shows the task it was given
export const LOOKING_FOR = `Get to know the project in this workspace, so that you and other assistants can work in it
afterwards. Nobody has looked at it before, so there is no note on it yet and everything that goes into it is new.

Look it over, work out which parts of it want exploring, and send an explorer to each of them. Then write the note
from what they bring back and what you saw yourself.`;

const task = (seen: string) => `${LOOKING_FOR}

This is the workspace's top level:

${seen}`;

// Has an explorer subagent go through the workspace and write the note, adding
// to it as it goes (see ../subagents/explorer.ts). Resolves with what the note
// says afterwards ('' if it wrote nothing), and with where that came from: the
// findings it wrote down one at a time, which want making into one note, or
// its closing report, which is already one piece of prose.
//
// It is the explorer kind, with the tools that read the workspace itself rather
// than a thread's copy of it in a container: the note is about the project as
// the user has it, and the first look happens before any thread has done
// anything to change that.
// What an explorer is sent out with. The same tool a model in a thread hands
// work out with, except that what it hands out reads the workspace itself
// rather than a thread's copy of it in a container.
function handOut(workspace: string, sections: Tool[]): Tool {
  return {
    ...subagentsTool,
    // The explorers it sends are subagents of the thread the look runs in, and
    // say so in the events the window draws them from. A tool is otherwise run
    // with nothing to report through (see run.ts), which would leave them
    // working in silence.
    run: (input, context) =>
      runSubagents(parseTasks(input), { ...context, emit: (event) => emit(workspace, event) }, sections),
  };
}

async function explore(
  workspace: string,
  threadId: string | undefined,
  model: Route,
  signal: AbortSignal
): Promise<{ text: string; from: 'findings' | 'report' }> {
  // What an explorer is given, including the means to send explorers of its
  // own: the list holds the tool that hands work out *of that same list*, so
  // an area that turns out to be several can be split again. How far that can
  // go is settled by depth rather than by what is offered here (see
  // MAX_HANDOUT_DEPTH in ../subagents/kind.ts).
  const sections: Tool[] = [...explorerTools(workspace, threadId), ...notesTools(workspace), addToNote(workspace)];
  sections.push(handOut(workspace, sections));
  const offer = sections;
  const seen = await gather(workspace, { depth: 2, files: false });
  const [found] = await runSubagents(
    [{ name: 'the workspace', task: task(seen), kind: HEAD_EXPLORER, steps: MAX_STEPS }],
    {
      signal,
      threadId,
      workspace,
      model: { provider: model.provider, model: model.id },
      // The head explorer is the thread, so what it does is the thread's own
      // work: its updates are unwrapped into the events they are made of,
      // rather than passed on as one subagent's doings. That it started and
      // finished is not news — the look starting and ending says that.
      emit: (event) => {
        if (event.type === 'subagent_update') emit(workspace, event.event);
        else if (event.type === 'usage') emit(workspace, event);
      },
    },
    offer
  );
  // What it wrote into the note is the note. An explorer that found things but
  // never wrote them down still has them in its report, so that is taken
  // rather than thrown away; one that failed outright has nothing to take.
  const written = clean(get(workspace));
  if (written) return { text: written, from: 'findings' };
  return { text: found?.isError ? '' : clean(found?.text ?? ''), from: 'report' };
}

// For a model that can't call tools: shown the workspace's files and its telling
// files in one go, it writes the note from that
async function describeAtOnce(workspace: string, model: Route, signal: AbortSignal): Promise<string> {
  const events = llm.stream(
    {
      provider: model.provider,
      model: model.id,
      system: PLAIN_PROMPT,
      messages: [{ role: 'user', content: `${await gather(workspace)}\n\nWrite the note.` }],
      maxTokens: MAX_TOKENS,
      log: { purpose: 'project', workspace },
    },
    signal
  );
  let text = '';
  for await (const event of events) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'error') throw new Error(event.message);
  }
  return clean(text);
}

async function write(workspace: string, threadId: string | undefined): Promise<string> {
  const started = performance.now();
  let modelId: string | undefined;
  let wrote: 'findings' | 'report' | 'at once' | undefined;
  const failed = (error: string) => {
    failedAt.set(workspace, Date.now());
    log.warn('project.survey', { ok: false, workspace, ms: log.since(started), model: modelId, wrote, error });
    return '';
  };
  try {
    if (!(await gather(workspace, { depth: 1, files: false })))
      return failed('The workspace is empty or could not be read.');
    const { models } = await llm.listModels();
    // High-effort work whatever set it off, so the most capable model — but
    // on this computer if this computer has one worth it. The look runs for
    // as long as the project is big and nobody is waiting on it, so it gives
    // up a level of sophistication to stay out of the way of the messages
    // that are being waited on (see Prefer in ./router.ts).
    const model = route(models, { sophistication: SOPHISTICATION.FRONTIER }, {}, 'local');
    if (!model) return failed('No models available.');
    modelId = model.id;

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    // The explorer writes the note itself, as it goes, so what it wrote is
    // what the note says afterwards
    const explored = await explore(workspace, threadId, model, signal);
    let text = explored.text;
    if (text) wrote = explored.from;
    // Nothing written: either the model cannot call tools at all, which many
    // small local ones cannot, or the explorer found nothing it could say.
    // Either way the workspace is still worth describing in one go.
    if (!text) {
      text = await describeAtOnce(workspace, model, signal);
      wrote = 'at once';
    }
    if (!text) return failed('The model wrote nothing.');

    notes[workspace] = { text, writtenAt: new Date().toISOString() };
    save();
    const found = text.length;
    // The explorer wrote its findings down one at a time, in the order it
    // happened to find them. Now they are made into the note itself, which is
    // what every thread in this workspace is shown from here on. Waited for,
    // unlike the job that trims a note that has grown: what goes out to the
    // threads should be the note that reads properly, not the working notes.
    if (wrote === 'findings') {
      emit(workspace, { type: 'condensing' });
      const composed = await condense(workspace, 'written');
      text = composed ?? text;
      // Said when it is over, so the notice does not stay up: a note that
      // could not be put in order is left as it was, and nothing came of it
      emit(workspace, { type: 'condensed', changed: composed !== undefined });
    }
    log.info('project.survey', {
      ok: true,
      workspace,
      ms: log.since(started),
      model: model.id,
      wrote,
      found,
      chars: text.length,
    });
    // Pushed to whoever is listening rather than left for the next thread to
    // ask for: every thread in this workspace is waiting on it (see ../main.ts)
    tell(workspace, text);
    return text;
  } catch (err) {
    return failed((err as Error).message);
  }
}

// Has the workspace looked at and its note written and saved, unless it has one.
// Resolves with the note, or '' if none could be written. Asking again while
// one is being written waits for that one.
// threadId: the thread the workspace is open in, whose search index is used
export function survey(workspace: string, threadId?: string): Promise<string> {
  if (!file) return Promise.resolve('');
  if (notes[workspace]) return Promise.resolve(notes[workspace].text);
  let pending = writing.get(workspace);
  if (!pending) {
    feeds.set(workspace, { events: [], listeners: new Set() });
    pending = write(workspace, threadId).finally(() => {
      writing.delete(workspace);
      feeds.delete(workspace);
      look(workspace, false);
    });
    writing.set(workspace, pending);
    // The window shows a look going on under the workspace it is of, so it is
    // told when one starts and when it is over (see ../main.ts)
    look(workspace, true);
  }
  return pending;
}

// The workspaces being looked at right now, for a window that has just opened
// and missed the news
export function looking(): string[] {
  return [...writing.keys()];
}

// As survey, but shows the work: yields what the model says it is doing, the
// tools it calls and what comes back, as that happens, and returns the note.
// Watching a workspace whose look has already begun starts from the beginning.
export async function* watch(workspace: string, threadId?: string): AsyncGenerator<HarnessEvent, string> {
  const pending = survey(workspace, threadId);
  const feed = feeds.get(workspace);
  if (!feed) return pending;

  let finished = false;
  let wake = () => {};
  const listener = () => wake();
  feed.listeners.add(listener);
  pending.finally(() => {
    finished = true;
    wake();
  });
  try {
    for (let seen = 0; ;) {
      while (seen < feed.events.length) yield feed.events[seen++];
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    feed.listeners.delete(listener);
  }
  return pending;
}

// Whether a first look at this workspace is going on right now. Not the same as
// due(): the explorer adds to the note as it goes, so the workspace has a note
// of sorts long before the look is over, and what waits on it has to wait for
// the look rather than for the note to exist (see ../harness/index.ts).
export function surveying(workspace: string): boolean {
  return writing.has(workspace);
}

// Told when a workspace's first note has been written, with the note. Whoever is
// listening pushes it on to every thread in that workspace (see ../main.ts),
// rather than each thread finding out when it next has something to say.
const told = new Set<(workspace: string, note: string) => void>();

// ...and who is told that a look has begun or ended. Separate from the note
// itself: a look that writes nothing still starts and stops, and the window
// shows it going on either way.
const watching = new Set<(workspace: string, going: boolean, task?: string) => void>();

export function onLook(listener: (workspace: string, going: boolean, task?: string) => void): () => void {
  watching.add(listener);
  return () => watching.delete(listener);
}

function look(workspace: string, going: boolean): void {
  for (const listener of watching) {
    try {
      listener(workspace, going, going ? LOOKING_FOR : undefined);
    } catch (err) {
      log.warn('project.look', { workspace, error: (err as Error).message });
    }
  }
}

export function onSurveyed(listener: (workspace: string, note: string) => void): () => void {
  told.add(listener);
  return () => told.delete(listener);
}

function tell(workspace: string, note: string): void {
  for (const listener of told) {
    try {
      listener(workspace, note);
    } catch (err) {
      log.warn('project.tell', { workspace, error: (err as Error).message });
    }
  }
}

// The note is read at the start of every message in the workspace, so its size
// is a standing cost. A note the model saves above MAX_NOTE_LENGTH is refused;
// one above CONDENSE_ABOVE is kept, and a job is set going to boil it back
// down to about CONDENSE_TO, so that the model can go on writing things down
// without having to prune as it goes.
export const MAX_NOTE_LENGTH = 2500;
const CONDENSE_ABOVE = 1600;
const CONDENSE_TO = 1200;
// Enough for the condensed note and no more
const CONDENSE_TOKENS = 1200;
const CONDENSE_TIMEOUT_MS = 5 * 60 * 1000;

export const CONDENSE_PROMPT = `You are given the standing note on a software project, written up over time by the
assistants that have worked in it. It has grown too long for something read at the start of every message, and your
job is to make it shorter without making it worse.

The note is the overview of the project and nothing more. Keep what a reader needs before they know anything: what it
is, how it is laid out, the commands that build, run and test it, the versions and tools it needs, and the
conventions its code follows throughout. Keep file paths, directory names, command lines, flags, version numbers and
identifiers exactly as they are written — they are the part of the note that has to be right, and a path you reword
is a path that no longer works.

Take out what has stopped being worth its room: the same thing said twice, scaffolding and preamble, anything about
one past task rather than the project, and anything a reader would learn in seconds from the files themselves. Take
out what is true of one part of the project rather than of the project — one module's workings, one command's
particulars, one file's history. The project keeps a searchable note for each of those, so this one does not have to.

Write the note itself and nothing else: no preamble, no explanation of what you changed. Aim for about
${CONDENSE_TO} characters.`;

// ...and what the same job is told after a first look, where the trouble is
// not that the note has grown but that it was written a finding at a time, in
// the order the explorer happened to find them (see explore). Shortening it
// is not the point here; making it read as one note is.
export const COMPOSE_PROMPT = `You are given the notes an assistant made while going through a software project for
the first time. They were written one at a time, as each thing was found out, so they repeat themselves, they are in
no particular order, and they read as a list of discoveries rather than as a description of the project. Your job is
to make them into the note that every assistant working in this project will be shown at the start of every message.

Keep every fact that is in them. Keep file paths, directory names, command lines, flags, version numbers and
identifiers exactly as they are written — they are the part of the note that has to be right, and a path you reword
is a path that no longer works. Do not add anything of your own: if something is not in the notes, it is not known.

Put them in an order someone meeting the project would want: what it is and does, how it is laid out, how it is
built, run and tested, the conventions its code follows, and the traps worth knowing. Say each thing once. Leave out
anything about the looking itself rather than about the project.

Keep it to what is true of the project as a whole. The detail of any one part of it is written down elsewhere, in
notes that are searched when they are wanted (that is what the assistants were doing while they wrote these), so a
paragraph here on one module or one command's flags is a paragraph every message in this project pays for and few
need. Leave those out and say what the part is and where it is instead.

Write the note itself and nothing else: no preamble, no explanation of what you changed. Up to about
${CONDENSE_TO} characters, and shorter if the notes do not fill it.`;

// Workspaces whose note is being condensed, so that one job runs at a time
const condensing = new Set<string>();
// The length a note was at when condensing it last came back no shorter. A
// note that is already as short as the model will make it is not condensed
// again until it has grown past that, because nothing about asking again
// changes the answer: in the log the same note was condensed to exactly its
// own length twice over, 2,292 characters against 2,292, and once to 2,580
// against 2,476 — thirty-five seconds and a job's tokens each time, on every
// save, for a note that was already at its floor.
const resistant = new Map<string, number>();

// Boils a note down to one a model can be given at the start of every message.
// Never throws, and never replaces a note with something worse than it was.
//
// 'grown' is a note that has got too long, condensed in the background:
// whoever saved it is not kept waiting, and the long note stands until the
// shorter one is ready. 'written' is the note a first look just made, which is
// waited for, because the note that goes out to the threads should be the one
// that reads properly (see write).
async function condense(key: string, how: 'grown' | 'written' = 'grown'): Promise<string | undefined> {
  const before = notes[key]?.text;
  if (!before || condensing.has(key)) return undefined;
  // A note that would not come down last time is left alone until it has grown
  // past where it stuck (see resistant). A note just written is composed rather
  // than shortened, and is a different job with a different prompt, so it is
  // always done.
  const stuck = resistant.get(key);
  if (how === 'grown' && stuck !== undefined && before.length <= stuck) return undefined;
  condensing.add(key);
  const started = performance.now();
  try {
    const { models } = await llm.listModels();
    const model = route(models, { sophistication: SOPHISTICATION.CAPABLE }, {});
    if (!model) throw new Error('No models available.');
    let text = '';
    const events = llm.stream(
      {
        provider: model.provider,
        model: model.id,
        system: how === 'written' ? COMPOSE_PROMPT : CONDENSE_PROMPT,
        messages: [{ role: 'user', content: before }],
        maxTokens: CONDENSE_TOKENS,
        // A bounded job: a model that reasoned would spend the whole ceiling
        // on it and come back with nothing (see compactor.ts)
        think: false,
        log: { purpose: 'project.condense', note: key, how },
      },
      AbortSignal.timeout(CONDENSE_TIMEOUT_MS)
    );
    for await (const event of events) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'error') throw new Error(event.message);
    }
    const shorter = clean(text);
    // Nothing worth having: the note is left as it was, which is untidy but
    // true, and the next save will set this going again.
    //
    // An overgrown note has to come out shorter or there was no point. One
    // just written has only to be no longer than it was, or short enough not
    // to need condensing at all: putting a list of findings in order is worth
    // doing whether or not it saves a character.
    const room = how === 'written' ? Math.max(before.length, CONDENSE_TO) : before.length - 1;
    if (shorter && shorter.length > room) {
      // The model wrote a note and it was no shorter, which is the note saying
      // it is already as short as this model makes it. Taken down, so the next
      // save does not buy the same answer again (see resistant). A job that
      // came back with nothing is not this: that is a failure to write, and
      // another save is welcome to try it again.
      if (how === 'grown') resistant.set(key, before.length);
      throw new Error(
        `The condensed note was ${shorter.length} characters against ${before.length}, so it is left as it was ` +
          'until it grows further.'
      );
    }
    if (!shorter) throw new Error('The condensed note came back empty.');
    // Only if nobody has written the note in the meantime
    if (notes[key]?.text !== before) throw new Error('The note changed while it was being condensed.');
    notes[key] = { text: shorter, writtenAt: new Date().toISOString() };
    // It came down, so whatever it stuck at before no longer holds
    resistant.delete(key);
    save();
    log.info('project.condense', {
      ok: true,
      workspace: key,
      how,
      model: model.id,
      ms: log.since(started),
      from: before.length,
      to: shorter.length,
    });
    return shorter;
  } catch (err) {
    log.warn('project.condense', {
      ok: false,
      workspace: key,
      how,
      ms: log.since(started),
      error: (err as Error).message,
    });
    return undefined;
  } finally {
    condensing.delete(key);
  }
}

// Replaces the workspace's note with one the model has written. Throws, with
// something the model can act on, if the note can't be taken.
export function update(workspace: string, text: string, thread?: string): void {
  if (!file) throw new Error('Notes on workspaces are not being kept, so this one was not saved.');
  const note = text.trim();
  if (!note) throw new Error('"content" must be a non-empty string.');
  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `The note is ${note.length} characters long. Keep it under ${MAX_NOTE_LENGTH}: it is read at the start of
every message in this workspace.`
    );
  }
  // A thread writes to its own note, not to the one every other thread in the
  // workspace reads: what it has found is true of the project as this thread has
  // made it, which is not yet the project. It reaches the workspace when the
  // thread's work does (see promote).
  const key = thread ? threadKey(thread) : workspace;
  notes[key] = { text: note, writtenAt: new Date().toISOString() };
  // The model's own note means the workspace need not be looked at again
  failedAt.delete(workspace);
  save();
  log.info('project.update', { workspace, thread, chars: note.length });
  // Grown long enough to be worth shortening: done in the background, so
  // whoever saved it carries on and reads the note it wrote until then
  if (note.length > CONDENSE_ABOVE) void condense(key);
}

// Adds to the workspace's note without touching what is already in it.
//
// This is what a subagent gets instead of update(), and the difference is the
// point: several of them run at once (see ../subagents), and a wholesale write
// from one is the findings of another thrown away. Appending cannot do that.
// It is a plain synchronous read-modify-write, so two appends in the same tick
// cannot interleave and lose one another.
//
// A note that would grow past the limit is not refused, as a replacement would
// be — an explorer cannot write less than it found out, and refusing would
// only lose the finding. It is let through and shortened in the background,
// which is what CONDENSE_ABOVE is for.
export function append(workspace: string, text: string, thread?: string): void {
  if (!file) throw new Error('Notes on workspaces are not being kept, so this one was not saved.');
  const addition = text.trim();
  if (!addition) throw new Error('"content" must be a non-empty string.');
  const key = thread ? threadKey(thread) : workspace;
  const current = notes[key]?.text ?? notes[workspace]?.text ?? '';
  // A thread's first addition starts from the workspace's note, as its own copy,
  // the same way the rest of the thread's note does (see adopt)
  const note = current ? `${current}\n\n${addition}` : addition;
  notes[key] = { text: note, writtenAt: new Date().toISOString() };
  failedAt.delete(workspace);
  save();
  log.info('project.append', { workspace, thread, added: addition.length, chars: note.length });
  // A first look writes the note a finding at a time and has the findings made
  // into one note when it is done (see write), so it is left alone until then:
  // a job running now would be working on half of them, and would be in the
  // way of the one that matters
  const duringFirstLook = key === workspace && writing.has(workspace);
  if (note.length > CONDENSE_ABOVE && !duringFirstLook) void condense(key);
}

// What the model is told about the workspace's project, given its note.
//
// canUpdate: whether it has the tool to write the note. Its caller used to
// pass "the model has tools at all", which is not the same thing: in the
// finding-out step of a coding change there are tools but not this one (see
// ../tools/context.ts, where it belongs to the doing step), so the step was
// being told at some length to keep the note true with a tool it had not been
// given — and being told to use a tool it lacks costs it a round to find out.
//
// What belongs in the note, and the moment to write it, is in that tool's own
// description. Said here as well it was said twice to the one step that could
// act on it, so this says only what the description cannot: that the copy is
// this thread's own, and who the note is kept true for.
export const prompt = (note: string) =>
  `This is the note on the project in this workspace, as last written: the overview of it, and only the overview —
what is particular to one part of the project is written down apart from this, where it can be searched for (see
below). It may be out of date, so trust the files over it
where they differ:\n\n${note}`;

// ...and what is said as well to the step that can write the note back, which
// is not every step (see ../tools/context.ts, where the tool belongs to the
// doing step).
//
// Said in a block of its own rather than inside the note's, so that the note
// reads the same however the step that has it is equipped. That is worth a
// paragraph on its own account: a prompt cache matches on a prefix, so a
// sentence that appears in one step and not the next throws away every
// identical byte after it, and this one used to sit above two thousand
// characters of note that no step ever disagreed about (see systemPrompt,
// where the settled parts of the prompt are kept ahead of the step's own).
export const OWN_COPY = `In this thread the note above is yours: it began as the workspace's and is now your own
copy, so adding to it costs no one else anything, and it goes back to the workspace when your work does.

Keeping it true is part of the work, not an afterthought. Put it right with update_workspace_context in the same
reply — rather than at the end of the task, or by working around it — the moment you work out something it does not
say, or find it wrong, out of date or vaguer than what you now know, or change the project so that it no longer
describes it. Judge it by whether the next assistant in this workspace, who sees this note and nothing else of your
work, would be misled or would have to find out again what you already know.`;
