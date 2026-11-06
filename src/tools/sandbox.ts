// The tools that let a model work in its thread's own container: what each one
// is called, what the model is told about it, and what it does. The work
// itself is the sandbox's (see ../sandbox); this is the face it shows a model.

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import * as access from '../harness/access';
import * as docker from '../sandbox/docker';
const { quote } = docker;
import { contextFile } from '../sandbox';
import * as recipes from '../sandbox/recipes';
import type { Tool, ToolImage, ToolReturn } from '../types';
import { withCaptureSlot, withFileLock } from '../sandbox/lock';

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input?.[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`"${key}" must be a non-empty string.`);
  }
  return value;
}

async function writeFile(
  threadId: string | undefined,
  path: string,
  content: string,
  signal: AbortSignal
): Promise<void> {
  const command = `mkdir -p "$(dirname ${quote(path)})" && cat > ${quote(path)}`;
  const { code, output } = await docker.exec(threadId, command, { input: content, signal });
  if (code !== 0) throw new Error(output.trim() || `Could not write ${path}`);
}

// Adds to the end of a file, making it and its directory if they are not there
async function appendFile(
  threadId: string | undefined,
  path: string,
  content: string,
  signal: AbortSignal
): Promise<void> {
  const command = `mkdir -p "$(dirname ${quote(path)})" && cat >> ${quote(path)}`;
  const { code, output } = await docker.exec(threadId, command, { input: content, signal });
  if (code !== 0) throw new Error(output.trim() || `Could not write ${path}`);
}

// Named here because the harness watches for it: writing a note is what lets
// the results it was written from be set aside (see ../harness/index.ts)
export const ADD_TO_CONTEXT = 'add_to_context';

const MAX_DIFF_LINES = 200; // lines of a written file's diff reported
const READ_LINES = 400; // lines of a file read at once unless fewer are asked for
const MAX_READ_LINES = 2000; // the most that can be asked for in one read

// How much of a file one read returns, given the window it has to fit in.
//
// Those two numbers are sized for a model with room to spare, and on one
// without they are the whole problem. Four hundred lines of real source comes
// to about six thousand tokens once each carries its line number: a fifth of a
// 32k window in a single call, so three of them fill it. At the 2000-line
// ceiling one call returns about twenty-seven thousand tokens, which is more
// than such a window holds at all — the model cannot read one long file
// without losing the conversation it was reading it for.
//
// So the page is a share of the window, with the old numbers as the ceiling:
// nothing changes for a model big enough not to care. Reading on from where a
// page ended is how the tool already works and what the model is already told,
// so a smaller page costs it another round rather than the lines themselves —
// and a round it can spend is worth more than a window it cannot.
const TOKENS_PER_LINE = 15; // source with its line number, measured on this project
const PAGE_SHARE = 0.04; // of the window, matching what a round is reckoned to cost (see phases.ts)
const MIN_PAGE_LINES = 40; // below this a read says too little to be worth the round
const MOST_PAGES = 5; // how much more than a page one call may ask for

// What the model is told about reading, given the page it will get
const readDescription = (lines: number) => `Read part of a text file in this thread's container, which holds the
project: ${lines} lines at a time by default, each with its line number. Relative paths are resolved from
${docker.WORKDIR}. For a file on the user's own computer, use read_user_file instead.

The line numbers are there for you to refer to lines by, and are not part of the file: never include them in the text
you give to edit_file. If more of the file follows, the last line says so and gives the start_line to read on from.

Read only the part you need. For a file you know your way around, go straight to the lines that matter with
start_line and line_count rather than reading from the top. If you have already read these lines earlier in this
reply, work from what you have rather than reading them again; read them again when they may have changed since: you
wrote to the file or edited it, a command you ran could have, a subagent working alongside you could have, or your
earlier tool results have been set aside to save room.`;

const readSchema = (lines: number, most: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    path: { type: 'string' },
    start_line: { type: 'number', description: 'The first line to read, counting from 1. Defaults to 1.' },
    line_count: {
      type: 'number',
      description: `How many lines to read, at most ${most}. Defaults to ${lines}.`,
    },
  },
  required: ['path'],
});

// Whether a path names a place in the container: the project, under WORKDIR. Only the text is
// looked at, so this says nothing about whether the file is there.
export const isContainerPath = (given: string): boolean =>
  given === docker.WORKDIR || given.startsWith(`${docker.WORKDIR}/`);

// Whether a path names a place on the user's computer: a ~ path, or an absolute one outside WORKDIR
export const isHostPath = (given: string): boolean =>
  given.startsWith('~') || (given.startsWith('/') && !isContainerPath(given));

// What to say when a thread names the user's original of a file it has a copy of: the thread's work is in the copy, so
// reading the original shows the file without it. Null if the path is not in the thread's workspace, or there is no
// container to hold a copy. The path is a real one (see access.resolve).
export function copyHint(context: { threadId?: string; workspace?: string }, target: string): string | null {
  const inside = context.threadId ? access.relativeToWorkspace(context.workspace, target) : null;
  if (inside === null) return null;
  const copy = inside ? `${docker.WORKDIR}/${inside}` : docker.WORKDIR;
  return (
    `${target} is in the user's workspace, which is not read from here: this thread has its own copy, at ${copy}, ` +
    `and only the copy has this thread's changes. Use read_file, list_workspace or run_reading_command on ${copy}.`
  );
}

// What read_file says after a host path failed: where the copy is if the path is in the thread's workspace, and
// otherwise that the path is on the user's computer
function hostHint(given: string, context: { threadId?: string; workspace?: string }): string {
  try {
    const copy = copyHint(context, access.resolve(given));
    if (copy) return copy;
  } catch {
    // Not a path that can be told from the user's computer; the general hint is all there is
  }
  return "That path is not in this thread's container. For a file on the user's own computer, use read_user_file.";
}

export function pageFor(window?: number): { lines: number; most: number } {
  if (!window) return { lines: READ_LINES, most: MAX_READ_LINES };
  const fits = Math.floor((window * PAGE_SHARE) / TOKENS_PER_LINE);
  const lines = Math.max(MIN_PAGE_LINES, Math.min(READ_LINES, fits));
  return { lines, most: Math.min(MAX_READ_LINES, lines * MOST_PAGES) };
}
// How awk, which reads the lines, says on its last line how long the file is.
// It always comes last, after the lines wanted, so it is simply taken off.
const LENGTH = '@@ch-length:';

// A line number the model gave, or the default if it gave nothing sensible
function lineNumber(value: unknown, fallback: number, max = Infinity): number {
  const asked = Number(value);
  if (!Number.isFinite(asked) || asked < 1) return fallback;
  return Math.min(Math.round(asked), max);
}

// What awk returned, numbered from the line it started at, with a word about
// what is left to read. The numbers are for the model to refer to lines by;
// they are not in the file (see the tool's description).
function numbered(output: string, path: string, from: number): string {
  const lines = output.split('\n');
  // Every line awk printed ends with a newline, so the last piece is empty
  if (lines.at(-1) === '') lines.pop();
  const last = lines.at(-1) ?? '';
  const length = last.startsWith(LENGTH) ? Number(last.slice(LENGTH.length)) : NaN;
  if (Number.isFinite(length)) lines.pop();

  if (lines.length === 0) {
    if (length === 0) return `${path} is empty.`;
    return Number.isFinite(length)
      ? `${path} has ${length} lines, so there is nothing at line ${from}.`
      : `Nothing to read at line ${from} of ${path}.`;
  }
  const shown = lines.map((line, i) => `${from + i}: ${line}`);
  const left = Number.isFinite(length) ? length - (from - 1) - lines.length : 0;
  if (left > 0) shown.push(`… ${left} more lines; read on from start_line ${from + lines.length}`);
  return shown.join('\n');
}

// Where a command may write even though the project is out of bounds: the
// container's own scratch space, and the places that are not files at all.
// The guard is there to stop a shell write and an edit_file racing for the
// same file, which needs them to be the same file — and nothing under these
// is in the workspace (see ../sandbox/docker.ts WORKDIR).
//
// This is worth allowing because of what it was refusing: the commands turned
// away over it in the log were a thread comparing its work against the
// baseline — `git show HEAD:f > /tmp/base.ts` and then `git merge-file` over
// it — which is a thing a verifier has to be able to do, and which cannot
// touch the project at all.
const SCRATCH = String.raw`/tmp/|/var/tmp/|/dev/`;

// Whether a command writes to a file itself, which would bypass the lock that
// write_file and edit_file take (see ../sandbox/lock.ts): a redirection to a
// file (> or >>, but not to scratch space or to another descriptor as in 2>&1,
// see SCRATCH), tee, sed or perl editing in place, truncate, dd writing to a
// file.
//
// This looks at the command's text only. It is there to stop a model doing
// this by habit, not to contain one that is set on it: anything a script or
// another program does when it runs is out of its sight.
export function writesFiles(command: string): boolean {
  // What is quoted is set aside, so that '>' in an awk program or a message
  // is not taken for a redirection; a quoted file name still counts as one
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
  const start = String.raw`(?:^|[;&|(\n])\s*`; // where a command begins
  return [
    // not after - or = (->, =>), nor in a here-string or process substitution
    new RegExp(String.raw`(?:^|[^>&|\\=<-])(?:&|\d*)>>?\|?\s*(?!&|${SCRATCH})[^\s;&|)]`),
    new RegExp(`${start}(?:sudo\\s+)?tee\\b(?!(?:\\s+-[a-zA-Z]+)*\\s+(?:${SCRATCH}))`),
    /\b(?:sed|perl|ruby)\b[^;&|\n]*\s(?:-[a-zA-Z]*i|--in-place)/,
    new RegExp(`${start}(?:sudo\\s+)?truncate\\b`),
    new RegExp(String.raw`\bdd\b[^;&|\n]*\sof=(?!${SCRATCH})`),
  ].some((pattern) => pattern.test(bare));
}

// Whether a command would make or commit to a repository in the thread's copy
// of the project. The copy is made without the project's .git (see filesToCopy
// in ../sandbox/docker.ts), so git there reports no repository: a model asked
// to commit or to squash reads that as a project kept in no version control,
// makes one of its own, and reports work the user never gets — the baseline
// cannot see a .git at the root of its work tree, so nothing of such a
// repository is ever carried back. The refusal is the only place that can say
// so at the moment it is needed, the prompt having already been read.
//
// Text only, like writesFiles, and narrow on purpose: a command that has gone
// elsewhere first (cd, git -C, --git-dir) is left alone, because a scratch
// repository under /tmp is a reasonable thing for a comparison to make.
export function makesRepository(command: string): boolean {
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
  if (/\bcd\s|\bgit\s+(?:-C\b|--git-dir)/.test(bare)) return false;
  // git's own options come before the subcommand, and `-c name=value` takes
  // the setting as a word of its own
  return new RegExp(String.raw`(?:^|[;&|(\n])\s*(?:sudo\s+)?git\s+(?:-\S+\s+|\S+=\S+\s+)*(?:init|commit)\b`).test(bare);
}

// Whether a command writes or runs a script of the model's own to try the code
// out: a program put under /tmp and run, or one given inline to node or python
// that loads something. Not refused, since a scratch script is sometimes the right
// tool, but answered with a word about the other two (see SCRATCH_HINT): a script
// in /tmp checks the code apart from the app it runs in and is gone when the reply
// ends, and the habit of writing one was what the app's own tools were losing to.
//
// Text only, like writesFiles. An inline one-liner that loads nothing (node -e
// "console.log(process.version)") is asking about the container, not the code;
// and a source file put under /tmp other than from a here-document is a copy of
// one, which is what a comparison against the baseline makes (see SCRATCH).
const SCRIPT_FILE = String.raw`/(?:var/)?tmp/\S+\.(?:[cm]?[jt]sx?|py)\b`;
export function scratchScript(command: string): boolean {
  const written = new RegExp(String.raw`(?:>|\btee\s+(?:-a\s+)?)\s*["']?${SCRIPT_FILE}`).test(command);
  if (written && /<<-?\s*['"]?\w+/.test(command)) return true;
  const runner = String.raw`\b(?:node|tsx|ts-node|deno(?:\s+run)?|bun|python3?)\s+(?:-\S+\s+)*["']?`;
  return [
    new RegExp(runner + SCRIPT_FILE),
    /\b(?:node|tsx)\s+(?:-e|-p|--eval|--print)\b[\s\S]*(?:require\(|import\b)/,
    /\bpython3?\s+-c\b[\s\S]*\bimport\b/,
  ].some((pattern) => pattern.test(command));
}

export const SCRATCH_HINT =
  'That was a script of your own, run apart from the app. It is gone when this reply ends and checks the code ' +
  'some other way than the app uses it. To see what the app does, run it and use it with use_app: start it, ' +
  'click and type in it, and read back what it shows, its console and its own output. To check behaviour that ' +
  "should stay checked, add a test beside the project's own and run it with the project's test command.";

// Writes the file and resolves with what the write changed, as a unified
// diff against what was there before ('' if the file is as it was). A file
// that is new is all additions.
async function writeAndDiff(
  threadId: string | undefined,
  path: string,
  content: string,
  signal: AbortSignal
): Promise<string> {
  const file = quote(path);
  // What was there is set aside first, to compare with once the file is
  // written; the comparison's own exit code says only whether they differ
  const command = [
    `before=$(mktemp)`,
    `if [ -f ${file} ]; then cp ${file} "$before"; fi`,
    `mkdir -p "$(dirname ${file})" && cat > ${file} || { rm -f "$before"; exit 1; }`,
    `diff -u --label ${quote(`a/${path}`)} --label ${quote(`b/${path}`)} "$before" ${file}`,
    `rm -f "$before"`,
    `exit 0`,
  ].join('\n');
  const { code, output } = await docker.exec(threadId, command, { input: content, signal });
  if (code !== 0) throw new Error(output.trim() || `Could not write ${path}`);
  const lines = output.trimEnd().split('\n');
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join('\n');
}

const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 800;
const MIN_SHOT_SIDE = 200;
const MAX_SHOT_SIDE = 4000;
// The most an image can be for the providers to take it (Anthropic's limit, the lowest)
const MAX_SHOT_BYTES = 5 * 1024 * 1024;
// How long the page is given to settle, in the browser's own (virtual) time
const SHOT_SETTLE_MS = 3000;
// Under the names Debian and Ubuntu give it; see dockerfile() in ../sandbox/docker.ts
const BROWSERS = ['chromium', 'chromium-browser', 'google-chrome'];
export const NO_BROWSER =
  "This thread's container has no browser (Chromium), so there is nothing to take a screenshot with. It is " +
  'installed in containers built on Debian; this one may be built on another system.';

// A page is an http, https or file address; anything else is a path in the container
function pageUrl(target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (!/^(https?|file):/i.test(target)) throw new Error('"url" must be an http, https or file address, or a path.');
    return target;
  }
  return `file://${encodeURI(posix.resolve(docker.WORKDIR, target))}`;
}

// How long to record for, in whole seconds
function duration(value: unknown): number {
  if (value === undefined || value === null) return FILM_SECONDS;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('"seconds" must be a number.');
  return Math.min(MAX_FILM_SECONDS, Math.max(MIN_FILM_SECONDS, Math.round(value)));
}

function pixels(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('"width" and "height" must be numbers.');
  return Math.min(MAX_SHOT_SIDE, Math.max(MIN_SHOT_SIDE, Math.round(value)));
}

// How long a desktop app is left to come up before the screen is captured, and the most it is given
const APP_WAIT = 5;
const MAX_APP_WAIT = 120;

function seconds(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('"wait" must be a number.');
  return Math.min(MAX_APP_WAIT, Math.max(0, Math.round(value)));
}

// Draws the page to a PNG at `file`. The browser's own output is said only when
// it fails: it is mostly complaints about a message bus that is not there.
function shotCommand(url: string, width: number, height: number, file: string): string {
  return [
    `browser=$(command -v ${BROWSERS.join(' ')} | head -n 1)`,
    `[ -n "$browser" ] || { echo ${quote(NO_BROWSER)}; exit 127; }`,
    `profile=$(mktemp -d /tmp/ch-profile-XXXXXX)`,
    // As root, which a container is, the browser's own sandbox cannot start; the
    // container is the sandbox. /dev/shm is 64 MB in one, too small for a page.
    `log=$(timeout 60 "$browser" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage ` +
      `--hide-scrollbars --user-data-dir="$profile" --window-size=${width},${height} ` +
      `--virtual-time-budget=${SHOT_SETTLE_MS} --screenshot=${quote(file)} ${quote(url)} 2>&1)`,
    `rm -rf "$profile"`,
    `[ -s ${quote(file)} ] || { echo "$log" | grep -v dbus/ | tail -n 20; exit 1; }`,
  ].join('\n');
}

// Picks a display nobody else is on, as $n, for a screen of the script's own: two
// scripts in one container at once would otherwise draw on, and film, each other's
// windows. A lock whose process is alive is somebody's; one whose process is gone
// (an Xvfb killed by a timeout) is taken over. Ten of them is slack rather than a
// limit on how many captures may run — that is CAPTURES_AT_ONCE in
// ../sandbox/lock.ts, and it is a good deal lower — so that an X server left
// behind by a stopped capture costs a display rather than the whole tool. Said as
// NO_DISPLAY when even so there is none to be had.
// Two scripts starting at the same instant could still both see a display free, so it
// is claimed first with flock on fd 9, held until the script exits (what it starts
// inherits it, and the kernel lets go of it then). Without flock there is no claim,
// and the lock check alone decides.
function pickDisplay(): string {
  return [
    `display=''`,
    `for n in $(seq 90 99); do`,
    `  exec 9>/tmp/.ch-display-$n.claim`,
    `  command -v flock >/dev/null 2>&1 && { flock -n 9 || continue; }`,
    `  if [ -e /tmp/.X$n-lock ]; then`,
    `    kill -0 $(cat /tmp/.X$n-lock) 2>/dev/null && continue`,
    `    rm -f /tmp/.X$n-lock`,
    `  fi`,
    `  display=$n; break`,
    `done`,
    `[ -n "$display" ] || { echo ${quote(NO_DISPLAY)}; exit 1; }`,
  ].join('\n');
}

// Runs `command` on a virtual display and draws the screen to a PNG at `file`, for
// a desktop app (Electron, say) that has no page to give a browser. The app gets its
// own process group, so that it and what it started are all stopped once the shot is
// taken. Its output is said only when no shot comes of it.
function appShotCommand(command: string, cwd: string, wait: number, width: number, height: number, file: string) {
  return [
    `command -v Xvfb import >/dev/null 2>&1 || { echo ${quote(NO_BROWSER)}; exit 127; }`,
    pickDisplay(),
    `Xvfb :$n -screen 0 ${width}x${height}x24 >/dev/null 2>&1 &`,
    `xvfb=$!`,
    `sleep 1`,
    `log=$(mktemp /tmp/ch-app-XXXXXX)`,
    // The display is made at ${width}×${height} just above; the window is told to
    // fill it through these two, so the grab of the whole screen shows the app
    // edge to edge, with no black field around it. A run a user starts sets
    // neither, and the window opens at its own default size.
    `(cd ${quote(cwd)} && CH_WINDOW_WIDTH=${width} CH_WINDOW_HEIGHT=${height} ` +
      `DISPLAY=:$n exec setsid bash -c ${quote(command)} ` +
      `>"$log" 2>&1) &`,
    `app=$!`,
    `sleep ${wait}`,
    `DISPLAY=:$n import -window root ${quote(file)} 2>>"$log"`,
    `kill -- -$app 2>/dev/null; kill $app 2>/dev/null; kill $xvfb 2>/dev/null`,
    `[ -s ${quote(file)} ] || { tail -n 20 "$log"; rm -f "$log"; exit 1; }`,
    `rm -f "$log"`,
  ].join('\n');
}

// What a page or an app window can be made to do before the shot is taken, and the
// most of it in one call. text and eval are the two that answer: what they find is
// said back, so a step can read what the app shows rather than only draw it — which
// is what a model reached for a script of its own to do while a picture was all it
// could get back.
const STEP_ACTIONS = ['click', 'type', 'press', 'hover', 'scroll', 'wait', 'wait_for', 'text', 'eval', 'goto'];
const MAX_STEPS = 50;
// What each action cannot be done without
const STEP_NEEDS: Record<string, string> = {
  click: 'selector',
  type: 'selector',
  hover: 'selector',
  wait_for: 'selector',
  press: 'key',
  eval: 'expression',
  goto: 'url',
};

// The steps a model gave, refused before anything is started where one of them
// could not be done: one that fails in the page fails the whole call, and has
// spent a browser's start-up finding that out
function checkSteps(given: unknown): unknown[] {
  if (given !== undefined && given !== null && !Array.isArray(given)) throw new Error('"steps" must be a list.');
  const steps: unknown[] = Array.isArray(given) ? given : [];
  if (steps.length > MAX_STEPS) throw new Error(`Give at most ${MAX_STEPS} steps; ${steps.length} were given.`);
  steps.forEach((step, index) => {
    const fields = (step ?? {}) as Record<string, unknown>;
    const action = fields.action;
    if (typeof action !== 'string' || !STEP_ACTIONS.includes(action)) {
      throw new Error(`Step ${index + 1}: "action" must be one of ${STEP_ACTIONS.join(', ')}.`);
    }
    const needs = STEP_NEEDS[action];
    if (needs && (typeof fields[needs] !== 'string' || !fields[needs])) {
      throw new Error(`Step ${index + 1}: ${action} needs "${needs}".`);
    }
  });
  return steps;
}

const STEPS_SCHEMA = {
  type: 'array',
  description:
    'What to do in the page, or in the window of the app, in order. Each step is one of ' +
    '{action: "click", selector}, {action: "type", selector, text}, {action: "press", key, selector?} (a key ' +
    'such as "Enter", "Escape", "ArrowDown", "a" or "Control+k", sent to selector or to whatever has focus), ' +
    '{action: "hover", selector}, {action: "scroll", selector?, y?} (selector into view, or by y pixels), ' +
    '{action: "wait", ms} (up to 10000), {action: "wait_for", selector, ms?} (until it is there, up to ms, ' +
    'default 5000), {action: "text", selector?} (says back what is shown in it, or in the whole page), ' +
    '{action: "eval", expression} (run in the page; says back what it returns) or {action: "goto", url}. ' +
    `At most ${MAX_STEPS} steps; a step that fails (a selector that matches nothing, say) fails the call, ` +
    'and what the steps before it said back is still given.',
  items: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: STEP_ACTIONS },
      selector: { type: 'string', description: 'CSS selector of the element.' },
      text: { type: 'string', description: 'What to type, for type.' },
      key: { type: 'string', description: 'The key to press, for press, with any modifiers: "Shift+Tab".' },
      expression: { type: 'string', description: 'JavaScript to run in the page, for eval.' },
      url: { type: 'string', description: 'Where to go, for goto.' },
      y: { type: 'number', description: 'Pixels to scroll down by (up, if negative), for scroll.' },
      ms: { type: 'number', description: 'Milliseconds, for wait and wait_for.' },
    },
    required: ['action'],
  },
};
// A page that is driven takes longer than one that is only drawn: the first is what
// the driver is given, the second what the call that waits on it is given, so that
// the driver's own complaint is what comes back rather than a timed-out container.
const DRIVE_SECONDS = 100;
const DRIVE_TIMEOUT_SECONDS = 120;
const DEBUG_PORT_BASE = 9200;
export const NO_NODE = 'needs Node 22 in the sandbox (node missing or too old)';

// Runs under `node -e` in the container, given the url, width, height, output file,
// debugging port, the steps as JSON and a file to report to. It drives the browser
// over the DevTools protocol, as a person at the page would, and writes the PNG of
// what is left. A step that fails is said on stderr, with its number, and the exit
// is 1.
//
// The report is what the page said back while it was driven: what the text and
// eval steps found, what it wrote to its console, and the errors it threw. It is
// written on the way out whether the steps finished or not, since what led up to a
// failed step is most of what there is to know about it (see driven).
//
// The url and the file are both optional, which is what lets it drive a desktop
// app as well as a page: an app is already on its own page, so there is nothing to
// navigate to, and the screen it is on is captured outside this script (see
// appDriveShotCommand), so there is nothing here to write.
const CDP_DRIVER = [
  'const [url, width, height, file, port, stepsJson, reportFile] = process.argv.slice(1);',
  'const steps = JSON.parse(stepsJson);',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  'const report = { results: [], console: [], errors: [] };',
  'const clip = (s) => { s = String(s); return s.length > 2000 ? s.slice(0, 2000) + " [...]" : s; };',
  'const note = (list, line) => { if (list.length < 50) list.push(clip(line)); };',
  'const save = () => { if (reportFile) { try { require("fs").writeFileSync(reportFile, JSON.stringify(report)); }',
  '  catch (e) {} } };',
  'const fail = (why) => { save(); console.error(why); process.exit(1); };',
  'const shown = (arg) => arg.value !== undefined',
  '  ? (typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value))',
  '  : arg.preview && arg.preview.properties',
  '    ? (arg.preview.subtype === "array" ? "[" : "{") + arg.preview.properties',
  '      .map((p) => (arg.preview.subtype === "array" ? "" : p.name + ": ") + p.value).join(", ")',
  '      + (arg.preview.overflow ? ", ..." : "") + (arg.preview.subtype === "array" ? "]" : "}")',
  '    : (arg.description || arg.type);',
  // A key as "Enter" or "Control+k": the last part is the key, the rest modifiers
  'const KEYS = { Enter: [13, "\\r"], Tab: [9, ""], Escape: [27, ""], Backspace: [8, ""], Delete: [46, ""],',
  '  ArrowLeft: [37, ""], ArrowUp: [38, ""], ArrowRight: [39, ""], ArrowDown: [40, ""], Home: [36, ""],',
  '  End: [35, ""], PageUp: [33, ""], PageDown: [34, ""], Space: [32, " "] };',
  'const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };',
  'async function main() {',
  '  let target;',
  '  for (let i = 0; i < 40 && !target; i++) {',
  '    try {',
  '      const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();',
  '      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl',
  '        && !String(t.url || "").startsWith("devtools://"));',
  '    } catch (e) {}',
  '    if (!target) await sleep(250);',
  '  }',
  '  if (!target) fail(url ? "no page to drive in the browser after 10s"',
  '    : "the app opened no page to drive after 10s: it may not be a Chromium app, or ' +
    '--remote-debugging-port did not reach it (a launcher that passes its arguments on, such as npm start, ' +
    'swallows the one added for you: give the launcher itself, or name the flag in the command)");',
  '  const ws = new WebSocket(target.webSocketDebuggerUrl);',
  '  await new Promise((resolve, reject) => {',
  '    ws.onopen = resolve;',
  '    ws.onerror = () => reject(new Error("could not connect to the browser"));',
  '  });',
  '  let next = 0;',
  '  let onLoad = () => {};',
  // Turning the console on replays what the page wrote before this connected,
  // which was said to whoever was connected then; only what comes after counts
  '  let listening = false;',
  '  const pending = new Map();',
  '  ws.onmessage = (event) => {',
  '    const message = JSON.parse(event.data);',
  '    const params = message.params || {};',
  '    if (message.method === "Page.loadEventFired") onLoad();',
  '    if (message.method === "Runtime.consoleAPICalled" && listening) {',
  '      note(report.console, "[" + params.type + "] " + (params.args || []).map(shown).join(" "));',
  '    }',
  '    if (message.method === "Runtime.exceptionThrown" && listening) {',
  '      const thrown = params.exceptionDetails || {};',
  '      note(report.errors, (thrown.exception && thrown.exception.description) || thrown.text);',
  '    }',
  // Failed loads and the browser's own complaints, which come here and not to the console
  '    if (message.method === "Log.entryAdded" && listening && params.entry && params.entry.level !== "verbose") {',
  '      const entry = params.entry;',
  '      note(report.console, "[" + entry.level + "] " + entry.text + (entry.url ? " (" + entry.url + ")" : ""));',
  '    }',
  '    const call = pending.get(message.id);',
  '    if (!call) return;',
  '    pending.delete(message.id);',
  '    if (message.error) call.reject(new Error(message.error.message));',
  '    else call.resolve(message.result);',
  '  };',
  '  const send = (method, params = {}) => new Promise((resolve, reject) => {',
  '    const id = ++next;',
  '    pending.set(id, { resolve, reject });',
  '    ws.send(JSON.stringify({ id, method, params }));',
  '  });',
  '  const evaluate = async (expression) => {',
  '    const { result, exceptionDetails } = await send("Runtime.evaluate", {',
  '      expression, awaitPromise: true, returnByValue: true,',
  '    });',
  '    if (exceptionDetails) {',
  '      const thrown = exceptionDetails.exception;',
  '      throw new Error(((thrown && thrown.description) || exceptionDetails.text).split("\\n")[0]);',
  '    }',
  '    return result.value;',
  '  };',
  '  const find = "const el = document.querySelector(";',
  '  const on = (selector, body) => evaluate("(() => { " + find + JSON.stringify(selector) + "); " +',
  '    "if (!el) return false; " + body + " })()");',
  '  const navigate = async (to) => {',
  '    const loaded = new Promise((resolve) => { onLoad = resolve; });',
  '    await send("Page.navigate", { url: to });',
  '    const late = sleep(30000).then(() => { throw new Error("the page did not finish loading in 30s"); });',
  '    await Promise.race([loaded, late]);',
  '  };',
  '  const key = async (given) => {',
  '    const parts = String(given).split("+");',
  '    const name = parts.pop() || "+";',
  '    const modifiers = parts.reduce((bits, part) => bits | (MODIFIERS[part] || 0), 0);',
  '    const known = KEYS[name];',
  '    const code = known ? known[0] : name.toUpperCase().charCodeAt(0);',
  '    const text = modifiers & ~8 ? "" : known ? known[1] : name;',
  '    const base = { key: name === "Space" ? " " : name, windowsVirtualKeyCode: code, modifiers };',
  '    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text });',
  '    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });',
  '  };',
  '  await send("Page.enable");',
  '  await send("Runtime.enable");',
  '  await send("Log.enable");',
  '  listening = true;',
  // An app's window is already the size of the screen it was given, and overriding
  // the metrics would draw the page at some other size than the window captured
  '  if (url) {',
  '    await send("Emulation.setDeviceMetricsOverride", {',
  '      width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false,',
  '    });',
  '    await navigate(url).catch((e) => fail(e.message));',
  '  }',
  '  for (const [index, step] of steps.entries()) {',
  '    const said = (value) => report.results.push({ step: index + 1, action: step.action, value: clip(value) });',
  '    try {',
  '      let found = true;',
  '      if (step.action === "wait") {',
  '        await sleep(Math.min(10000, Math.max(0, Number(step.ms) || 0)));',
  '      } else if (step.action === "wait_for") {',
  '        const until = Date.now() + Math.min(30000, Math.max(0, Number(step.ms) || 5000));',
  '        while (!(await on(step.selector, "return true;"))) {',
  '          if (Date.now() > until) throw new Error("nothing matched " + step.selector + " in time");',
  '          await sleep(100);',
  '        }',
  '      } else if (step.action === "click") {',
  '        found = await on(step.selector, "el.click(); return true;");',
  '      } else if (step.action === "type") {',
  '        found = await on(step.selector, "el.focus(); " +',
  '          "const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), \\"value\\"); " +',
  '          "if (own && own.set) own.set.call(el, " + JSON.stringify(String(step.text)) + "); " +',
  '          "else el.value = " + JSON.stringify(String(step.text)) + "; " +',
  '          "el.dispatchEvent(new Event(\\"input\\", { bubbles: true })); " +',
  '          "el.dispatchEvent(new Event(\\"change\\", { bubbles: true })); return true;");',
  '      } else if (step.action === "press") {',
  '        if (step.selector) found = await on(step.selector, "el.focus(); return true;");',
  '        if (found) await key(step.key);',
  '      } else if (step.action === "hover") {',
  '        const at = await on(step.selector, "el.scrollIntoView({ block: \\"center\\" }); " +',
  '          "const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };");',
  '        found = at !== false;',
  '        if (found) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });',
  '      } else if (step.action === "scroll") {',
  '        const by = Number(step.y);',
  '        if (step.selector) {',
  '          found = await on(step.selector, Number.isFinite(by) ? "el.scrollBy(0, " + by + "); return true;"',
  '            : "el.scrollIntoView({ block: \\"center\\" }); return true;");',
  '        } else {',
  '          await evaluate("window.scrollBy(0, " + (Number.isFinite(by) ? by : "innerHeight * 0.8") + ")");',
  '        }',
  '      } else if (step.action === "text") {',
  '        const value = step.selector ? await on(step.selector, "return el.innerText;")',
  '          : await evaluate("document.body ? document.body.innerText : \\"\\"");',
  '        found = value !== false;',
  '        if (found) said(value);',
  '      } else if (step.action === "eval") {',
  '        const value = await evaluate(step.expression);',
  '        said(value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value));',
  '      } else if (step.action === "goto") {',
  '        await navigate(step.url);',
  '      }',
  '      if (found === false) throw new Error("no element matches " + step.selector);',
  '    } catch (e) {',
  '      fail("step " + (index + 1) + " (" + step.action + "): " + e.message);',
  '    }',
  '    await sleep(300);',
  '  }',
  '  if (file) {',
  '    const { data } = await send("Page.captureScreenshot", { format: "png" });',
  '    require("fs").writeFileSync(file, Buffer.from(data, "base64"));',
  '  }',
  '  save();',
  '  process.exit(0);',
  '}',
  'main().catch((e) => fail(e.message));',
].join('\n');

// How a script that drove a page says what the page said back (see CDP_DRIVER):
// the driver's report, on a line of its own after this, and the end of the app's
// own output after the other, which only a running app has (see use_app). Both
// come after anything else the script says, which is the complaint of a failed
// run.
const REPORT_MARK = '@@ch-report:';
const LOG_MARK = '@@ch-log:';

// The lines that make a report file for the driver, and say it back once it is
// done with; `report` is the variable the driver is given.
const REPORT_FILE = `report=$(mktemp /tmp/ch-report-XXXXXX)`;
const SAY_REPORT = `[ -s "$report" ] && printf '\\n%s%s\\n' ${quote(REPORT_MARK)} "$(cat "$report")"; rm -f "$report"`;

interface Report {
  results?: { step: number; action: string; value: string }[];
  console?: string[];
  errors?: string[];
}

// What a driving script said, taken apart: its complaint, if it had one, the
// page's report and the app's own output
export function driven(output: string): { complaint: string; report: Report | null; log: string } {
  const [head, ...rest] = output.split(`\n${LOG_MARK}\n`);
  const log = rest.join('\n').trim();
  let report: Report | null = null;
  const complaint = head
    .split('\n')
    .filter((line) => {
      if (!line.startsWith(REPORT_MARK)) return true;
      try {
        report = JSON.parse(line.slice(REPORT_MARK.length)) as Report;
      } catch {
        // A report cut short says nothing to go on
      }
      return false;
    })
    .join('\n')
    .trim();
  return { complaint, report, log };
}

// The report as the model reads it: what the steps said back, then what the page
// and the app wrote while they were being driven. '' where there was none of it.
export function sayReport(report: Report | null, log = ''): string {
  const parts: string[] = [];
  if (report?.results?.length) {
    parts.push(
      'What the steps said back:\n' +
        report.results.map(({ step, action, value }) => `step ${step} (${action}): ${value}`).join('\n')
    );
  }
  if (report?.errors?.length) parts.push(`Errors the page threw:\n${report.errors.join('\n')}`);
  if (report?.console?.length) parts.push(`The page's console:\n${report.console.join('\n')}`);
  if (log) parts.push(`What the app itself wrote:\n${log}`);
  return parts.join('\n\n');
}

// Draws the page to a PNG at `file` after the steps have been done in it: Chromium
// is started headed on a virtual display, with a debugging port for CDP_DRIVER to
// drive it by (headless would do for the shot, but not for a page that has to be
// clicked). The driver's complaint is said only when no shot comes of it, with the
// end of the browser's own log.
function driveShotCommand(url: string, width: number, height: number, file: string, steps: unknown[]): string {
  return [
    `browser=$(command -v ${BROWSERS.join(' ')} | head -n 1)`,
    `{ [ -n "$browser" ] && command -v Xvfb >/dev/null 2>&1; } || { echo ${quote(NO_BROWSER)}; exit 127; }`,
    `node -e ${quote('process.exit(typeof WebSocket === "function" ? 0 : 1)')} >/dev/null 2>&1 || ` +
      `{ echo ${quote(NO_NODE)}; exit 1; }`,
    pickDisplay(),
    `port=$((${DEBUG_PORT_BASE} + n))`,
    `Xvfb :$n -screen 0 ${width}x${height}x24 >/dev/null 2>&1 &`,
    `xvfb=$!`,
    `sleep 1`,
    `profile=$(mktemp -d /tmp/ch-profile-XXXXXX)`,
    `log=$(mktemp /tmp/ch-drive-XXXXXX)`,
    // Its own process group, so that the browser and what it started are all stopped
    `(DISPLAY=:$n exec setsid "$browser" --no-sandbox --disable-gpu --disable-dev-shm-usage ` +
      `--user-data-dir="$profile" --remote-debugging-port=$port --window-size=${width},${height} ` +
      `about:blank >"$log" 2>&1) &`,
    `chrome=$!`,
    REPORT_FILE,
    `err=$(timeout ${DRIVE_SECONDS} node -e ${quote(CDP_DRIVER)} ${quote(url)} ${width} ${height} ` +
      `${quote(file)} $port ` +
      `${quote(JSON.stringify(steps))} "$report" 2>&1)`,
    `kill -- -$chrome 2>/dev/null; kill $chrome 2>/dev/null; kill $xvfb 2>/dev/null`,
    `rm -rf "$profile"`,
    `[ -s ${quote(file)} ] || { echo "$err"; grep -v dbus/ "$log" | tail -n 20; rm -f "$log"; ${SAY_REPORT}; exit 1; }`,
    `rm -f "$log"`,
    SAY_REPORT,
  ].join('\n');
}

// The port out of a command that already names one. A launcher that passes its
// arguments on to the app — npm start, a shell wrapper — swallows the flag added
// here, and the app then opens no port to drive; so a command may name its own, and
// this uses that rather than adding a second one the app will never see.
const DEBUG_FLAG = /--remote-debugging-port[= ](\d+)/;

// Runs `command` on a virtual display, does the steps in its window over the
// DevTools protocol, and draws the screen to a PNG at `file`: appShotCommand with
// the driving of driveShotCommand in the middle of it. The screen is captured here
// rather than the page by the driver, because a desktop app's window is part of
// what the user sees of it.
//
// A step that fails fails the call, although there is a screen to capture by then:
// what it would show is the app as it was when the step went wrong, and a shot of
// the wrong state passed off as the right one is worse than no shot at all.
function appDriveShotCommand(
  command: string,
  cwd: string,
  wait: number,
  width: number,
  height: number,
  file: string,
  steps: unknown[]
): string {
  const named = DEBUG_FLAG.exec(command);
  const launch = named ? command : `${command} --remote-debugging-port=$port`;
  return [
    `command -v Xvfb import >/dev/null 2>&1 || { echo ${quote(NO_BROWSER)}; exit 127; }`,
    `node -e ${quote('process.exit(typeof WebSocket === "function" ? 0 : 1)')} >/dev/null 2>&1 || ` +
      `{ echo ${quote(NO_NODE)}; exit 1; }`,
    pickDisplay(),
    named ? `port=${named[1]}` : `port=$((${DEBUG_PORT_BASE} + n))`,
    `Xvfb :$n -screen 0 ${width}x${height}x24 >/dev/null 2>&1 &`,
    `xvfb=$!`,
    `sleep 1`,
    `log=$(mktemp /tmp/ch-app-XXXXXX)`,
    // Its own process group, so that the app and what it started are all stopped. The port goes in with the
    // display: the launch is a shell of its own, which does not see this script's variables, and without it the
    // --remote-debugging-port added above reaches the app empty and the app picks a port nobody is driving.
    // The two sizes are the display's own: the window fills them, so the screen captured below is all app.
    `(cd ${quote(cwd)} && CH_WINDOW_WIDTH=${width} CH_WINDOW_HEIGHT=${height} ` +
      `DISPLAY=:$n port=$port exec setsid bash -c ${quote(launch)} >"$log" 2>&1) &`,
    `app=$!`,
    `sleep ${wait}`,
    REPORT_FILE,
    `err=$(timeout ${DRIVE_SECONDS} node -e ${quote(CDP_DRIVER)} '' ${width} ${height} '' $port ` +
      `${quote(JSON.stringify(steps))} "$report" 2>&1)`,
    // What the steps did has to be drawn before the screen is grabbed
    `sleep 1`,
    `DISPLAY=:$n import -window root ${quote(file)} 2>>"$log"`,
    `kill -- -$app 2>/dev/null; kill $app 2>/dev/null; kill $xvfb 2>/dev/null`,
    `[ -s ${quote(file)} ] || { echo "$err"; tail -n 20 "$log"; rm -f "$log"; ${SAY_REPORT}; exit 1; }`,
    `if [ -n "$err" ]; then echo "$err"; rm -f "$log"; ${SAY_REPORT}; exit 1; fi`,
    `rm -f "$log"`,
    SAY_REPORT,
  ].join('\n');
}

// A recording: how long it runs, how smooth it is, and how much of it the
// model is shown as frames.
const FILM_SECONDS = 8;
const MIN_FILM_SECONDS = 2;
// Long enough for any interaction worth watching, and short enough that the
// clip stays inside MAX_FILM_BYTES at a readable bitrate
const MAX_FILM_SECONDS = 20;
const FILM_FPS = 15;
// Frames handed to the model out of the clip, spread evenly across it. No
// provider takes video (see ToolVideo in ../types.ts), so this is the whole of
// what the model gets to see of a recording. Four is enough to tell what
// happened, and at the default size comes to ~5,300 tokens of window — what a
// frame costs is its dimensions, so a frame recorded larger costs more (see
// imageTokens in ../llm/tokens.ts).
const FILM_FRAMES = 4;
// How long the page is given to load and settle before recording starts. A
// real window on a real screen, so there is no virtual clock to skip it (see
// SHOT_SETTLE_MS, which is the headless equivalent).
const FILM_SETTLE_SECONDS = 3;
// What a clip may come to. Nothing sends it to a provider, so the only limits
// are the window it is held in and the thread it is shown in; past this the
// model is told to record less.
const MAX_FILM_BYTES = 10 * 1024 * 1024;
// Said when the screen and the encoder are not installed, which is the usual
// case: they are put on the first time this tool is asked (see
// RECORDER_INSTALL in ../sandbox/docker.ts)
const RECORDER_MISSING = 'ch-recorder-missing';
export const NO_RECORDER =
  "This thread's container cannot record: it has no X server (Xvfb) or no encoder (ffmpeg), and neither could " +
  'be installed. They are installed in containers built on Debian; this one may be built on another system. ' +
  'Use screenshot instead, which needs neither.';

// pickDisplay() reports this from the app screenshot, steps screenshot and
// record scripts. Only a couple of captures run in a container at once (see
// CAPTURES_AT_ONCE in ../sandbox/lock.ts), so ten displays are far more than
// the ones going on now can take up: what this means in practice is X servers
// left behind by earlier ones, whose own captures were stopped or timed out
// before they could take their screen down. Waiting does not clear those, so
// it does not say to.
export const NO_DISPLAY =
  'No virtual display is free for this. Only a couple of screenshots or recordings run in this container at ' +
  'once, so the ten displays are held by X servers that earlier ones left behind rather than by work going on ' +
  'now. Look for them with run_command (pgrep -a Xvfb), stop the ones no screenshot or recording is using, and ' +
  'ask again.';

// VP8 encodes in pairs of pixels, so an odd side is refused
const even = (value: number) => value - (value % 2);

// Records what is shown to a WebM at `file`: a page, drawn in a real browser
// window, or a desktop app, run from its cwd, on a screen of its own, and
// encodes what lands there. The browser's own output is kept only for a
// failure, as with a screenshot: headful Chromium in a container complains at
// length about a message bus and a keyring it has no use for. An app's output
// is kept in a log of its own, whose end is said when no clip comes of it.
function filmCommand(
  target: { url: string } | { command: string; cwd: string },
  width: number,
  height: number,
  clipSeconds: number,
  file: string
): string {
  const size = `${width}x${height}`;
  const app = 'command' in target ? target : undefined;
  return [
    ...(app ? [] : [`browser=$(command -v ${BROWSERS.join(' ')} | head -n 1)`]),
    ...(app ? [] : [`[ -n "$browser" ] || { echo ${quote(NO_BROWSER)}; exit 127; }`]),
    `command -v Xvfb >/dev/null && command -v ffmpeg >/dev/null || ` + `{ echo ${quote(RECORDER_MISSING)}; exit 126; }`,
    pickDisplay(),
    `profile=$(mktemp -d /tmp/ch-profile-XXXXXX)`,
    `log=$(mktemp /tmp/ch-film-log-XXXXXX)`,
    `Xvfb ":$n" -screen 0 ${size}x24 -nolisten tcp >>"$log" 2>&1 &`,
    `xvfb=$!`,
    // The lock file appears when the display is ready to be drawn on
    `for i in $(seq 100); do [ -e "/tmp/.X$n-lock" ] && break; sleep 0.1; done`,
    ...(app
      ? [
          // Its own process group, so that the app and what it started are all stopped. The window is given
          // the display's own size, so the frames grabbed below are all app and no black field around it.
          `app_log=$(mktemp /tmp/ch-film-app-XXXXXX)`,
          `(cd ${quote(app.cwd)} && CH_WINDOW_WIDTH=${width} CH_WINDOW_HEIGHT=${height} ` +
            `DISPLAY=":$n" exec setsid bash -c ${quote(app.command)} >"$app_log" 2>&1) &`,
          `browser_pid=$!`,
        ]
      : [
          // Headful, unlike the screenshot: there has to be a window on the screen
          // for there to be anything to grab. --kiosk is what leaves the page the
          // whole of it, with no tab strip or address bar in the recording.
          `DISPLAY=":$n" "$browser" --no-sandbox --disable-gpu --disable-dev-shm-usage --kiosk ` +
            `--hide-scrollbars --no-first-run --disable-infobars --disable-session-crashed-bubble ` +
            `--autoplay-policy=no-user-gesture-required --force-device-scale-factor=1 ` +
            `--user-data-dir="$profile" --window-position=0,0 --window-size=${width},${height} ` +
            `${quote((target as { url: string }).url)} >>"$log" 2>&1 &`,
          `browser_pid=$!`,
        ]),
    `sleep ${FILM_SETTLE_SECONDS}`,
    // -draw_mouse 0: there is no mouse, and without this the pointer is drawn
    // parked in the middle of every frame
    `ffmpeg -nostdin -loglevel error -f x11grab -draw_mouse 0 -video_size ${size} -framerate ${FILM_FPS} ` +
      `-i ":$n" -t ${clipSeconds} -c:v libvpx -b:v 1M -deadline realtime -cpu-used 5 -an ` +
      `-y ${quote(file)} >>"$log" 2>&1`,
    `code=$?`,
    // The frames the model will be shown, spread over the clip rather than
    // taken off the front of it
    `[ $code -eq 0 ] && ffmpeg -nostdin -loglevel error -i ${quote(file)} ` +
      `-vf fps=${FILM_FRAMES}/${clipSeconds} -frames:v ${FILM_FRAMES} ${quote(`${file}-%02d.png`)} >>"$log" 2>&1`,
    ...(app ? [`kill -- -$browser_pid 2>/dev/null`] : []),
    `kill $browser_pid $xvfb 2>/dev/null`,
    `wait $browser_pid $xvfb 2>/dev/null`,
    // The browser's own children outlive the kill above by a moment, and are
    // still writing to the profile while it is being removed: without the
    // second go this fails, and says so on the error channel, where it ends up
    // mixed into what a failed recording reports back to the model
    `rm -rf "$profile" 2>/dev/null || { sleep 1; rm -rf "$profile" 2>/dev/null; }`,
    ...(app
      ? [
          `[ -s ${quote(file)} ] || { tail -n 20 "$app_log"; ` +
            `grep -v -e dbus -e bus_connection -e keyring "$log" | tail -n 20; rm -f "$app_log" "$log"; exit 1; }`,
          `rm -f "$app_log"`,
        ]
      : []),
    `[ -s ${quote(file)} ] || { grep -v -e dbus -e bus_connection -e keyring "$log" | tail -n 20; exit 1; }`,
    `rm -f "$log"`,
  ].join('\n');
}

// An app kept running between calls, so that it can be used the way a person uses
// it: start it, do something, look at what that did, do the next thing. A
// screenshot starts its app afresh and stops it once the shot is taken, so the
// only way to find out what happens after a click was to do everything up to the
// click again — and a script of the model's own, which keeps its browser open,
// was cheaper than that. This is the browser kept open, as a tool.
//
// What a session is lives in a directory of its own in the container: the
// display and the port it is on, the process to stop, and the app's own output.
// The steps are done by the same driver a screenshot uses (see CDP_DRIVER),
// which connects to the session's port for each call and lets go after it.
const SESSION_DIR = '/tmp/ch-app-';
// Sessions running at once in a container, each a browser or an app on a
// display of its own; and how long one may go unused before the next start puts
// it away, so that a session a reply forgot to stop does not hold a display for
// the rest of the container's life
const MAX_SESSIONS = 3;
const IDLE_MINUTES = 30;
const SESSION_ID = /^[0-9a-f]{8}$/;
export const NO_SESSION = 'ch-no-session';
export const APP_EXITED = 'ch-app-exited';

// Stops the session in "$1" and clears up after it, as a shell function the
// scripts below can call
const STOP_SESSION = [
  'ch_stop() {',
  '  [ -d "$1" ] || return 3',
  '  pid=$(cat "$1/pid" 2>/dev/null); xvfb=$(cat "$1/xvfb" 2>/dev/null)',
  '  [ -n "$pid" ] && { kill -- -$pid 2>/dev/null; kill $pid 2>/dev/null; }',
  '  [ -n "$xvfb" ] && kill $xvfb 2>/dev/null',
  '  sleep 0.5',
  // As with a recording, the browser's children are still writing to the profile
  // for a moment after they are told to stop
  '  rm -rf "$1" 2>/dev/null || { sleep 1; rm -rf "$1" 2>/dev/null; }',
  '  return 0',
  '}',
].join('\n');

// Starts a session: a browser at `url`, or the app `command` launches, on a
// display of its own with a port to drive it by, left running when this returns.
// It is up once the driver can find a page on that port, which is the next call's
// job (see useApp); this only starts it and waits `wait` seconds.
function startSessionCommand(
  id: string,
  target: { url: string } | { command: string; cwd: string },
  width: number,
  height: number,
  wait: number
): string {
  const dir = `${SESSION_DIR}${id}`;
  const app = 'command' in target ? target : undefined;
  const named = app ? DEBUG_FLAG.exec(app.command) : null;
  const launch = app && !named ? `${app.command} --remote-debugging-port=$port` : app?.command;
  return [
    STOP_SESSION,
    `for d in $(find /tmp -maxdepth 1 -type d -name 'ch-app-*' -mmin +${IDLE_MINUTES}); do ch_stop "$d"; done`,
    `[ $(find /tmp -maxdepth 1 -type d -name 'ch-app-*' | wc -l) -lt ${MAX_SESSIONS} ] || ` +
      `{ echo ${quote(`ch-too-many-sessions`)}; exit 1; }`,
    ...(app
      ? [`command -v Xvfb >/dev/null 2>&1 || { echo ${quote(NO_BROWSER)}; exit 127; }`]
      : [
          `browser=$(command -v ${BROWSERS.join(' ')} | head -n 1)`,
          `{ [ -n "$browser" ] && command -v Xvfb >/dev/null 2>&1; } || { echo ${quote(NO_BROWSER)}; exit 127; }`,
        ]),
    `command -v import >/dev/null 2>&1 || { echo ${quote(NO_BROWSER)}; exit 127; }`,
    `node -e ${quote('process.exit(typeof WebSocket === "function" ? 0 : 1)')} >/dev/null 2>&1 || ` +
      `{ echo ${quote(NO_NODE)}; exit 1; }`,
    pickDisplay(),
    named ? `port=${named[1]}` : `port=$((${DEBUG_PORT_BASE} + n))`,
    `mkdir -p ${quote(dir)}`,
    // Everything it starts has its output sent to a file and nothing to read from,
    // so that nothing it leaves running holds this command open
    `Xvfb :$n -screen 0 ${width}x${height}x24 -nolisten tcp >/dev/null 2>&1 </dev/null &`,
    `echo $! > ${quote(`${dir}/xvfb`)}`,
    `for i in $(seq 100); do [ -e "/tmp/.X$n-lock" ] && break; sleep 0.1; done`,
    app
      ? // The port with the display, as for an app shot driven by steps (see appDriveShotCommand). The
        // display's size goes in too, so the window fills the screen the session's own shots and recordings grab.
        `(cd ${quote(app.cwd)} && CH_WINDOW_WIDTH=${width} CH_WINDOW_HEIGHT=${height} ` +
        `DISPLAY=:$n port=$port exec setsid bash -c ${quote(launch!)} ` +
        `>${quote(`${dir}/log`)} 2>&1 </dev/null) &`
      : `(DISPLAY=:$n exec setsid "$browser" --no-sandbox --disable-gpu --disable-dev-shm-usage --kiosk ` +
        `--no-first-run --hide-scrollbars --user-data-dir=${quote(`${dir}/profile`)} ` +
        `--remote-debugging-port=$port --window-position=0,0 --window-size=${width},${height} ` +
        `${quote((target as { url: string }).url)} >${quote(`${dir}/log`)} 2>&1 </dev/null) &`,
    `echo $! > ${quote(`${dir}/pid`)}`,
    `printf 'n=%s\\nport=%s\\nkind=%s\\nwidth=%s\\nheight=%s\\n' "$n" "$port" ${app ? 'app' : 'web'} ` +
      `${width} ${height} > ${quote(`${dir}/env`)}`,
    `sleep ${wait}`,
    `kill -0 $(cat ${quote(`${dir}/pid`)}) 2>/dev/null || ` +
      `{ echo ${quote(APP_EXITED)}; tail -n 20 ${quote(`${dir}/log`)}; ch_stop ${quote(dir)}; exit 1; }`,
  ].join('\n');
}

// Does the steps in a running session and, where `file` is given, draws it there
// once they are done. What the app wrote since the last call is said after the
// driver's report, so that a server's log or an Electron app's main process is in
// front of the model as it uses the app, not only the page.
function driveSessionCommand(id: string, steps: unknown[], file?: string): string {
  const dir = `${SESSION_DIR}${id}`;
  const log = quote(`${dir}/log`);
  const seen = quote(`${dir}/seen`);
  return [
    `[ -f ${quote(`${dir}/env`)} ] || { echo ${quote(NO_SESSION)}; exit 3; }`,
    `. ${quote(`${dir}/env`)}`,
    // Used now, so not idle: see the clearing up in startSessionCommand
    `touch ${quote(dir)}`,
    `kill -0 $(cat ${quote(`${dir}/pid`)}) 2>/dev/null || { echo ${quote(APP_EXITED)}; tail -n 20 ${log}; exit 4; }`,
    REPORT_FILE,
    // A page is drawn by the driver; an app's window, frame and all, from the screen
    `shot=''; [ "$kind" = web ] && shot=${quote(file ?? '')}`,
    `err=$(timeout ${DRIVE_SECONDS} node -e ${quote(CDP_DRIVER)} '' "$width" "$height" "$shot" "$port" ` +
      `${quote(JSON.stringify(steps))} "$report" 2>&1)`,
    `code=$?`,
    ...(file
      ? [`[ $code -eq 0 ] && [ "$kind" = app ] && { sleep 1; DISPLAY=:$n import -window root ${quote(file)}; }`]
      : []),
    `[ $code -eq 0 ] || echo "$err"`,
    SAY_REPORT,
    `size=$(wc -c < ${log}); was=$(cat ${seen} 2>/dev/null || echo 0)`,
    `if [ "$size" -gt "$was" ]; then printf '\\n%s\\n' ${quote(LOG_MARK)}; tail -c +$((was + 1)) ${log} | ` +
      `grep -v -e dbus -e bus_connection -e keyring | tail -n 40; fi`,
    `echo "$size" > ${seen}`,
    `exit $code`,
  ].join('\n');
}

// Records the screen of a running session for `clipSeconds`, doing the steps
// while it does: the clicking and typing are what there is to watch. The size is
// the session's own, which was made even when it started (see VP8 above).
function filmSessionCommand(id: string, clipSeconds: number, file: string, steps: unknown[]): string {
  const dir = `${SESSION_DIR}${id}`;
  return [
    `[ -f ${quote(`${dir}/env`)} ] || { echo ${quote(NO_SESSION)}; exit 3; }`,
    `. ${quote(`${dir}/env`)}`,
    `touch ${quote(dir)}`,
    `command -v ffmpeg >/dev/null || { echo ${quote(RECORDER_MISSING)}; exit 126; }`,
    `log=$(mktemp /tmp/ch-film-log-XXXXXX)`,
    `ffmpeg -nostdin -loglevel error -f x11grab -draw_mouse 0 -video_size "\${width}x\${height}" ` +
      `-framerate ${FILM_FPS} -i ":$n" -t ${clipSeconds} -c:v libvpx -b:v 1M -deadline realtime -cpu-used 5 -an ` +
      `-y ${quote(file)} >>"$log" 2>&1 &`,
    `ff=$!`,
    REPORT_FILE,
    ...(steps.length > 0
      ? [
          `sleep 0.5`,
          `timeout ${DRIVE_SECONDS} node -e ${quote(CDP_DRIVER)} '' "$width" "$height" '' "$port" ` +
            `${quote(JSON.stringify(steps))} "$report" >>"$log" 2>&1`,
        ]
      : []),
    `wait $ff`,
    `code=$?`,
    `[ $code -eq 0 ] && ffmpeg -nostdin -loglevel error -i ${quote(file)} ` +
      `-vf fps=${FILM_FRAMES}/${clipSeconds} -frames:v ${FILM_FRAMES} ${quote(`${file}-%02d.png`)} >>"$log" 2>&1`,
    SAY_REPORT,
    `[ -s ${quote(file)} ] || { tail -n 20 "$log"; rm -f "$log"; exit 1; }`,
    `rm -f "$log"`,
  ].join('\n');
}

// What a session's start or a call into it says when it cannot go on, in words
// the model can act on
function sessionTrouble(said: string, id: string): string | null {
  if (said.includes(NO_SESSION)) {
    return (
      `There is no session ${id}: it was stopped, or put away after ${IDLE_MINUTES} minutes unused. ` + 'Start another.'
    );
  }
  if (said.includes(APP_EXITED)) {
    const end = said.split(APP_EXITED).pop()!.trim();
    return `The app in session ${id} has exited.${end ? ` The end of what it wrote:\n${end}` : ''}`;
  }
  if (said.includes('ch-too-many-sessions')) {
    return (
      `${MAX_SESSIONS} sessions are running in this container already. Stop one you are done with ` +
      '(action "stop") before starting another.'
    );
  }
  return null;
}

// Fetches Electron's binary into the project that `cwd` is in, before an app is
// launched from there, where the package is installed and its binary is not
// (see docker.ELECTRON_INSTALL). A container made from an image older than the
// fetch keeps that image, so its Electron has no binary to run, and an app
// launched without one fails in ways that do not all say so: a screenshot of it
// is a screen with nothing on it, taken all the same. Where the binary is there
// already this is two file tests. Whatever it says is let go: a fetch that fails
// leaves the app to fail as it would have, in its own words.
async function ensureElectron(threadId: string | undefined, cwd: string, signal: AbortSignal): Promise<void> {
  await docker
    .exec(threadId, `cd ${quote(cwd)} && ${docker.ELECTRON_INSTALL}`, { signal, timeoutSeconds: 300 })
    .catch(() => undefined);
}

// Does the steps in session `id`, draws it if asked to, and says what came of it
async function inSession(
  threadId: string | undefined,
  signal: AbortSignal,
  id: string,
  steps: unknown[],
  draw: boolean
): Promise<{ said: string; images: ToolImage[] }> {
  const file = draw ? `/tmp/ch-shot-${randomUUID()}.png` : undefined;
  try {
    const { code, output } = await docker.exec(threadId, driveSessionCommand(id, steps, file), {
      signal,
      timeoutSeconds: DRIVE_TIMEOUT_SECONDS,
    });
    const trouble = sessionTrouble(output, id);
    if (trouble) throw new Error(trouble);
    const { complaint, report, log } = driven(output);
    const said = sayReport(report, log);
    if (code !== 0) throw new Error([complaint || 'The steps could not be done.', said].filter(Boolean).join('\n\n'));
    if (!file) return { said, images: [] };
    const read = await docker.read(threadId, `cat ${quote(file)}`);
    if (!read || read.code !== 0 || read.data.length === 0) throw new Error('The screenshot could not be read.');
    if (read.data.length > MAX_SHOT_BYTES) {
      throw new Error('The screenshot is too large to send. Start the session at a smaller width and height.');
    }
    return { said, images: [{ mediaType: 'image/png', data: read.data.toString('base64') }] };
  } finally {
    if (file) await docker.exec(threadId, `rm -f ${quote(file)}`).catch(() => undefined);
  }
}

const newSessionId = () => randomUUID().replace(/-/g, '').slice(0, 8);

// Starts session `id` on `target` and resolves once it is running, or throws with what went wrong
async function startSession(
  threadId: string | undefined,
  signal: AbortSignal,
  id: string,
  target: { url: string } | { command: string; cwd: string },
  width: number,
  height: number,
  wait: number
): Promise<void> {
  if ('command' in target) await ensureElectron(threadId, target.cwd, signal);
  const start = () =>
    docker.exec(threadId, startSessionCommand(id, target, width, height, wait), {
      signal,
      timeoutSeconds: wait + 30,
    });
  let started = await start();
  if (started.code === 127 && started.output.trim() === NO_BROWSER) {
    // As with a screenshot, a container made before the image had a browser
    await docker.exec(threadId, docker.BROWSER_INSTALL, { signal, timeoutSeconds: 600 });
    started = await start();
  }
  if (started.output.includes(NO_DISPLAY)) throw new Error(NO_DISPLAY);
  if (started.code !== 0) {
    throw new Error(sessionTrouble(started.output, id) ?? (started.output.trim() || 'The app could not be started.'));
  }
}

const stopSession = (threadId: string | undefined, id: string) =>
  docker.exec(threadId, `${STOP_SESSION}\nch_stop ${quote(`${SESSION_DIR}${id}`)}`).catch(() => undefined);

// A run recipe (see ../sandbox/recipes.ts), run.
//
// Everything before the launch is one script, run from the project's folder: the setup in order, then each service
// that is not already answering, started detached and waited for, then a fresh copy of the data. It stops at the first
// that fails and says which, after RECIPE_FAILED, with the end of what that wrote. Then the app is started as a
// session, as use_app starts one, and the ready check and the steps after it are done in it.
//
// The setup runs under a lock of the container's: the coders of one reply share it and each may start the app, and
// two builds at once write over each other's output. A service is only started where its address does not answer
// already, so the second coder to start the app finds the first one's server up and uses it.
const RECIPE_FAILED = '@@ch-recipe-failed:';
const RECIPE_LOCK = '/tmp/.ch-recipe';
// What the setup and the services are given, all together: a build of a large project is minutes
const RECIPE_SECONDS = 600;
// How long a service is waited for, in half seconds
const SERVICE_TRIES = 120;
// How long the app is waited for to show the recipe's ready selector
const READY_MS = 30000;

// A failure of the recipe rather than of what was asked of the app afterwards: which part of it, and what was said
class RecipeFailure extends Error {
  constructor(
    readonly stage: string,
    message: string,
    // Whether the app's session was started, and is left running
    readonly running = false
  ) {
    super(message);
  }
}

const exported = (env: Record<string, string> | undefined) =>
  Object.entries(env ?? {}).map(([name, value]) => `export ${name}=${quote(value)}`);

function prepareCommand(recipe: recipes.Recipe, data: string | undefined): string {
  const failed = (stage: string) => quote(`${RECIPE_FAILED}${stage}`);
  return [
    `cd ${quote(docker.WORKDIR)}`,
    ...exported(recipe.env),
    // Any answer at all is up: a server that says 404 to its root is still serving
    `answers() { node -e ${quote(
      'fetch(process.argv[1]).then(() => process.exit(0), () => process.exit(1))'
    )} "$1" >/dev/null 2>&1; }`,
    ...(recipe.setup ?? []).flatMap((command, n) => [
      `log=$(mktemp /tmp/ch-recipe-XXXXXX)`,
      `bash -c ${quote(command)} >"$log" 2>&1 </dev/null || ` +
        `{ echo ${failed(`setup ${n + 1} (${command})`)}; tail -n 30 "$log"; rm -f "$log"; exit 1; }`,
      `rm -f "$log"`,
    ]),
    ...(recipe.services ?? []).flatMap(({ command, ready }, n) => {
      const log = quote(`/tmp/ch-service-${n + 1}.log`);
      return [
        `if ! answers ${quote(ready)}; then`,
        `  (setsid nohup bash -c ${quote(command)} >${log} 2>&1 </dev/null &)`,
        `  for i in $(seq ${SERVICE_TRIES}); do answers ${quote(ready)} && break; sleep 0.5; done`,
        `  answers ${quote(ready)} || { echo ${failed(`service ${n + 1} (${command})`)}; tail -n 30 ${log}; exit 1; }`,
        `fi`,
      ];
    }),
    ...(recipe.data && data
      ? [
          `rm -rf ${quote(data)} && mkdir -p ${quote(data)} && ` +
            `cp -a ${quote(`${recipe.data.from}/.`)} ${quote(data)} ` +
            `|| { echo ${failed(`data (${recipe.data.from})`)}; exit 1; }`,
        ]
      : []),
  ].join('\n');
}

// Runs `recipe` up to the app as a user first sees it, in session `id`, and says what came of it. A failure is a
// RecipeFailure naming the part of the recipe that failed; one after the launch leaves the session running, for the
// caller to look at or stop.
async function runRecipe(
  threadId: string | undefined,
  signal: AbortSignal,
  recipe: recipes.Recipe,
  id: string,
  { width, height, draw }: { width: number; height: number; draw: boolean }
): Promise<{ what: string; said: string; images: ToolImage[] }> {
  const data = recipe.data ? `/tmp/ch-data-${id}` : undefined;
  const prepared = await withFileLock(threadId, RECIPE_LOCK, () =>
    docker.exec(threadId, prepareCommand(recipe, data), { signal, timeoutSeconds: RECIPE_SECONDS })
  );
  if (prepared.code !== 0) {
    const [before, after = ''] = prepared.output.split(RECIPE_FAILED);
    const [stage, ...rest] = after.split('\n');
    const said = rest.join('\n').trim() || before.trim();
    throw new RecipeFailure(stage.trim() || 'setup', said || `It stopped with exit code ${prepared.code}.`);
  }
  const app = recipe.app;
  const target =
    'command' in app
      ? {
          command: [...exported(recipe.env), `${app.command}${data ? ` ${recipe.data!.flag}=${data}` : ''}`].join('; '),
          cwd: app.cwd ? posix.resolve(docker.WORKDIR, app.cwd) : docker.WORKDIR,
        }
      : { url: pageUrl(app.url) };
  try {
    await startSession(threadId, signal, id, target, width, height, recipe.wait ?? ('command' in app ? APP_WAIT : 2));
  } catch (error) {
    throw new RecipeFailure('launch', (error as Error).message);
  }
  const what = 'command' in app ? `the app run by ${app.command}` : app.url;
  const ready = recipe.ready ? [{ action: 'wait_for', selector: recipe.ready, ms: READY_MS }] : [];
  const after = recipe.after ?? [];
  const said: string[] = [];
  let images: ToolImage[] = [];
  // Each by itself, so that a failure says which it was; drawn by whichever comes last
  for (const [stage, steps] of [
    [`the ready check (${recipe.ready})`, ready],
    ['the steps after it', after],
  ] as const) {
    if (steps.length === 0) continue;
    const last = stage === 'the steps after it' || after.length === 0;
    try {
      const done = await inSession(threadId, signal, id, steps, draw && last);
      said.push(done.said);
      images = done.images;
    } catch (error) {
      throw new RecipeFailure(stage, (error as Error).message, true);
    }
  }
  if (draw && images.length === 0) images = (await inSession(threadId, signal, id, [], true)).images;
  return { what, said: said.filter(Boolean).join('\n\n'), images };
}

// The steps of a recipe's commands that run_command would refuse, refused here too: a recipe's setup runs as
// run_command's commands do, without anybody looking at it first
function refuseWrites(recipe: recipes.Recipe): void {
  for (const command of [...(recipe.setup ?? []), ...(recipe.services ?? []).map((service) => service.command)]) {
    if (writesFiles(command)) {
      throw new Error(
        `"${command}" writes to a file in the project with a redirection, tee or sed -i, which a recipe may not ` +
          'do any more than run_command may. A build writing its own output is fine.'
      );
    }
    if (makesRepository(command))
      throw new Error(`"${command}" makes a repository or a commit, which a recipe may not.`);
  }
}

const NO_RECIPE =
  `This workspace has no run recipe saved. Start the app with url or command, and once it is up and showing what a ` +
  `user would see, save how you did it with ${recipes.SAVE_TOOL}.`;

// Which tool to use for what. Models reach for run_command out of habit —
// grep, find, cat, sed, a Python script to rewrite a file — when a tool made
// for the job is right there: those give results the app can show and set
// aside, and edits that come back as diffs. Only the tools the model has are
// named, since one told to use a tool it lacks spends a round finding out.
// workspace: the thread's, whose run recipe is said along with use_app.
export function toolsPrompt(names: Iterable<string>, workspace?: string): string {
  const has = new Set(names);
  if (!has.has('run_command')) return '';
  const uses = [
    has.has('search_workspace') && '- To find files or text in them, use search_workspace.',
    has.has('list_workspace') && '- To see what files and folders there are, use list_workspace.',
    has.has('read_file') && '- To read a file in the project, use read_file.',
    has.has('read_user_file') && "- To read a file, or list a folder, on the user's own computer, use read_user_file.",
    has.has('run_host_command') &&
      "- To search, count or run git in a folder on the user's computer, use run_host_command. The project's own " +
        'history is one of those: what you work in is a copy without a .git, so git log and the like have to be run ' +
        "there, in the user's checkout.",
    has.has('edit_file') && '- To change a file, use edit_file; to create one or replace all of it, use write_file.',
    has.has('use_app') &&
      '- To find out what the app does — reproduce a bug, try a change, check a feature works — run it and use it ' +
        'with use_app rather than a script of your own: start it once, then click, type and read back what it ' +
        'shows, its console and its own output, over as many calls as it takes. Give it data to show through its ' +
        'own fixtures or a data directory under /tmp rather than by editing its code.',
    has.has('screenshot') &&
      '- To see how a page or an app looks, or to show the user how it looks, use screenshot rather than a ' +
        'browser run from run_command, and never write a one-off screenshot script: for a web app start the ' +
        'server and pass url; for a desktop app pass command. To click, type or set state in the page or in the ' +
        "app's window before the shot, pass steps instead of writing a script. Where the demo needs a change to " +
        'the code itself, make it in a copy of the project at /tmp/demo (without node_modules, with ' +
        'node_modules symlinked in), and shoot from there.',
    has.has('record') &&
      '- To show the user something that moves, rather than how it looks at one moment, use record: pass url for ' +
        'a web app, or command for a desktop app.',
  ].filter(Boolean);
  if (uses.length === 0) return '';
  // How this workspace's app is run, where the model can run it (see ../sandbox/recipes.ts)
  const recipe = has.has('use_app') ? recipes.prompt(workspace) : '';
  return `Use the tool made for each job rather than doing it through run_command:
${uses.join('\n')}

Do not use run_command for any of those: no grep, rg, find, ls, cat, head, tail, sed or awk, and no Python, node or
shell scripts written to search, read or edit files, or to try the code out apart from the app. run_command is for
what no other tool does: building, running the project's tests, starting the app, installing dependencies, and the
like. Not version control: your copy of the project was made
without its .git, and a repository or a commit made in the copy is no part of the user's and never reaches them.${
    recipe ? `\n\n${recipe}` : ''
  }`;
}

export const tools: Tool[] = [
  {
    name: 'run_command',
    // Offered while finding out, so that a step can run the app or a test to
    // see what a thing does. It refuses shell writes to the project's files,
    // so the step cannot change the project by it; writes under /tmp/ are
    // still allowed, which is where a demo goes (see phases.ts). Offered in the
    // suggest step too, which makes a demo copy to show a change and then has it
    // reverted (see phases.SUGGESTION).
    phases: ['explore', 'execute', 'suggest'],
    description: `Run a bash command in this thread's container and get its output and exit code. The working
directory is ${docker.WORKDIR}. Each command runs in a fresh shell, so directory changes and variables do not carry
over. Commands are stopped after 120 seconds.

Not for searching, listing, reading or editing files — no grep, find, cat, sed, or Python or other scripts for that:
use the tools made for those jobs (search_workspace, list_workspace, read_file, edit_file, write_file) where you have
them. This is for building, running the project's tests, starting the app or its server, installing dependencies and
the like. Not for scripts of your own written to try out the code: to see what the code does, run the app and use it
(use_app), and a check worth writing is worth keeping, as a test beside the project's own.

${docker.WORKDIR} is a copy of the project's files, made without its .git: git run here will usually report no
repository, and that says nothing about how the project itself is kept. So do not make a repository or a commit here —
one made here is no part of the user's and never reaches them — and do not tell them the project has no version
control. What carries your work back is the app: the files you change go to the user's own checkout as changes for
them to apply.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The bash command to run. One that writes a file in the project (a > or >> redirection, tee, ' +
            'sed -i) is refused: change files with write_file and edit_file. Writing under /tmp is ' +
            "allowed, for a demo copy of the project, an app's data, or a baseline to compare against.",
        },
      },
      required: ['command'],
    },
    async run(input, { signal, threadId }) {
      const command = requireString(input, 'command');
      // Refuse commands that write files; do it via a sandbox tool instead
      if (writesFiles(command)) {
        throw new Error(
          'This command writes to a file (a > or >> redirection, tee, sed -i and the like), which run_command ' +
            'does not allow, as it could write over an edit being made at the same time. Use write_file or ' +
            'edit_file to change a file. Writing under /tmp or /var/tmp is fine, as is redirecting to ' +
            '/dev/null or to another descriptor (2>&1) — so a copy to compare against, or data for the app, goes ' +
            'there.'
        );
      }
      if (makesRepository(command)) {
        throw new Error(
          'Your copy of the project was made without its .git, so a repository or a commit made here is no part of ' +
            "the user's and is never carried back to them: it would be lost, and saying the work was committed " +
            "would be wrong. The project itself may well be kept in Git on the user's computer — read its history " +
            'with run_host_command, giving the workspace as path. What does carry your work back is the app: the ' +
            'files you change go to the user as changes for them to apply. If the user asked for a commit, tell ' +
            'them this is what you can do instead.'
        );
      }
      const { code, output } = await docker.exec(threadId, command, { signal });
      return `exit code ${code}\n${output}${scratchScript(command) ? `\n\n${SCRATCH_HINT}` : ''}`;
    },
  },
  {
    name: 'read_file',
    description: readDescription(READ_LINES),
    // The page is sized to this model's window, so the numbers it is told are
    // the ones it will get rather than the ones the largest model gets
    describe: (_phase, window) => readDescription(pageFor(window).lines),
    inputSchema: readSchema(READ_LINES, MAX_READ_LINES),
    schemaFor: (_phase, window) => {
      const { lines, most } = pageFor(window);
      return readSchema(lines, most);
    },
    async run(input, { signal, threadId, window, workspace }) {
      const path = requireString(input, 'path');
      const from = lineNumber(input.start_line, 1);
      const { lines, most } = pageFor(window);
      const count = lineNumber(input.line_count, lines, most);
      // One command for the lines wanted and for how long the file is, so
      // that what is left can be said without reading it as well
      const program = `NR>=s && NR<s+n { print } END { print "${LENGTH}" NR }`;
      const read = `awk -v s=${from} -v n=${count} '${program}' ${quote(path)}`;
      const { code, output } = await docker.exec(threadId, read, { signal });
      if (code !== 0) {
        const why = output.trim() || `Could not read ${path}`;
        throw new Error(isHostPath(path) ? `${why}\n${hostHint(path, { threadId, workspace })}` : why);
      }
      return numbered(output, path, from);
    },
  },
  {
    name: 'screenshot',
    description: `Take a screenshot of a web page, of an HTML file, or of a desktop app running in this thread's
container, and see it. Use it to check how a change looks (layout, colours, text that is cut off or missing), and to
see what a page or an app looks like now rather than working it out from the code. Never write a one-off screenshot
script for this.
For a web app: a page served from the container needs its server running first: start one with run_command, detached
so that the command can return (setsid nohup <server> >/tmp/server.log 2>&1 &), and give its address as url, such as
http://localhost:3000. The page is drawn by headless Chromium without a GPU, and what it shows is the page once it
has settled, at the size asked for.
For a desktop app (Electron, say): give command, the shell command that launches it, such as
npx electron . --no-sandbox --disable-gpu. It is run on a virtual display of the size asked for, from cwd, left for
wait seconds to come up, then the screen is captured and the app stopped. Give url or path, or command, not both.
To click, type or set state before the shot — in a page or in an app's window — pass steps, and never write a script
for it. The text and eval steps say back what they find, and what the page wrote to its console and the errors it
threw come back with the shot, so a step can check what the app does as well as how it looks. An app is driven over
the DevTools protocol, so --remote-debugging-port is added to command for you; a launcher that passes its arguments
on, such as npm start, swallows it, so with one of those name the flag and a port yourself. Steps reach what the app
draws, not its native menus or its title bar.
This starts the app afresh every time and stops it after the shot. To use the app over several calls — try
something, look at what it did, try the next thing — start it once with use_app instead.
What steps cannot do is make up the data the app is showing. To show a state, give the app the data first, and let
it draw that itself: the project's own fixtures or seed command where it has them, or else the file or the data
directory it loads at start-up, written with the state you want. An Electron app keeps that state where
--user-data-dir says, so a data directory under /tmp written with that state, and given to the app as that flag,
is a way to show a state the app cannot be clicked into. Editing the app's code to fake a state is the last resort.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: `An http, https or file address, or the path of an HTML file (relative to ${docker.WORKDIR}).`,
        },
        command: {
          type: 'string',
          description:
            'Instead of url: the shell command that launches a desktop app, such as ' +
            '`npx electron . --no-sandbox --disable-gpu`. Not to be given with url.',
        },
        cwd: { type: 'string', description: `Where command is run from. Defaults to ${docker.WORKDIR}.` },
        wait: { type: 'number', description: `Seconds to leave the app to come up. Defaults to ${APP_WAIT}.` },
        width: { type: 'number', description: `Width of the page in pixels. Defaults to ${SHOT_WIDTH}.` },
        height: { type: 'number', description: `Height of the page in pixels. Defaults to ${SHOT_HEIGHT}.` },
        steps: { ...STEPS_SCHEMA, description: `${STEPS_SCHEMA.description} Done before the shot is taken.` },
      },
      required: [],
    },
    async run(input, { signal, threadId }): Promise<ToolReturn> {
      const given = (key: string) => input[key] !== undefined && input[key] !== null && input[key] !== '';
      if (given('command') && given('url')) throw new Error('Give "url" or "command", not both.');
      if (!given('command') && !given('url')) throw new Error('"url" or "command" must be a non-empty string.');
      const steps = checkSteps(given('steps') ? input.steps : undefined);
      const width = pixels(input.width, SHOT_WIDTH);
      const height = pixels(input.height, SHOT_HEIGHT);
      const file = `/tmp/ch-shot-${randomUUID()}.png`;
      let script: string;
      let what: string;
      let timeoutSeconds: number | undefined;
      if (given('command')) {
        const command = requireString(input, 'command');
        const cwd = given('cwd') ? posix.resolve(docker.WORKDIR, requireString(input, 'cwd')) : docker.WORKDIR;
        const wait = seconds(input.wait, APP_WAIT);
        await ensureElectron(threadId, cwd, signal);
        if (steps.length > 0) {
          script = appDriveShotCommand(command, cwd, wait, width, height, file, steps);
          // The app's own start-up as well, which the driver waits through before
          // it has a window to drive
          timeoutSeconds = wait + DRIVE_TIMEOUT_SECONDS;
        } else {
          script = appShotCommand(command, cwd, wait, width, height, file);
          timeoutSeconds = wait + 30;
        }
        what = `the app run by ${command}`;
      } else {
        const url = pageUrl(requireString(input, 'url'));
        if (steps.length > 0) {
          script = driveShotCommand(url, width, height, file, steps);
          timeoutSeconds = DRIVE_TIMEOUT_SECONDS;
        } else {
          script = shotCommand(url, width, height, file);
        }
        what = url;
      }
      const shot = () => docker.exec(threadId, script, { signal, ...(timeoutSeconds ? { timeoutSeconds } : {}) });
      try {
        // Behind any other browser already running in this container, of which
        // there is only room for so many (see withCaptureSlot). The timeout is
        // the command's, and starts once this call has a browser to run.
        const { code, output } = await withCaptureSlot(threadId, signal, async () => {
          let taken = await shot();
          if (taken.code === 127 && taken.output.trim() === NO_BROWSER) {
            // A container made before the image had a browser keeps that image, so the
            // browser is added to it now, and the shot is taken once more
            await docker.exec(threadId, docker.BROWSER_INSTALL, { signal, timeoutSeconds: 600 });
            taken = await shot();
          }
          return taken;
        });
        if (output.includes(NO_DISPLAY)) throw new Error(NO_DISPLAY);
        const { complaint, report } = driven(output);
        const said = sayReport(report);
        if (code !== 0) {
          throw new Error([complaint || 'The screenshot could not be taken.', said].filter(Boolean).join('\n\n'));
        }
        const read = await docker.read(threadId, `cat ${quote(file)}`);
        if (!read || read.code !== 0 || read.data.length === 0) throw new Error('The screenshot could not be read.');
        if (read.data.length > MAX_SHOT_BYTES) {
          throw new Error('The screenshot is too large to send. Ask for a smaller width and height.');
        }
        return {
          text: [`Screenshot of ${what} at ${width}x${height}.`, said].filter(Boolean).join('\n\n'),
          images: [{ mediaType: 'image/png', data: read.data.toString('base64') }],
        };
      } finally {
        // Left to the container's /tmp it would only pile up; not tied to the
        // signal, so that a call that was stopped still cleans up after itself
        await docker.exec(threadId, `rm -f ${quote(file)}`).catch(() => undefined);
      }
    },
  },
  {
    name: 'record',
    description: `Record a short clip of a web page, of an HTML file, or of a desktop app running in this thread's
container, as it runs. The clip is shown to the user under your reply, and you are shown ${FILM_FRAMES} frames out of
it. The first call installs the screen and the encoder, so it may be slow.

For motion, where screenshot is for a moment: an animation or transition, a loading sequence, something that moves
on its own, a flow going past. A still page recorded for ${FILM_SECONDS} seconds is ${FILM_SECONDS} seconds of
nothing, and a screenshot tells you and the user more about it — so use screenshot unless there is movement worth
watching.
To record a flow — clicking through something, typing into it — start the app with use_app, bring it to where the
flow begins, and give its session here with the steps to do while it records: they are done on camera. Given url or
command instead, nothing drives the app, and what gets recorded is whatever it does by itself. Either way, to show a
particular state give the app the data for it first (its fixtures, or a data directory written under /tmp), and
never write a one-off script for it.
For a web app: a page served from the container needs its server running first, detached so the command can return
(setsid nohup <server> >/tmp/server.log 2>&1 &). The page is drawn in a real browser window on a screen of its own,
without a GPU.
For a desktop app (Electron, say): give command, the shell command that launches it, such as
npx electron . --no-sandbox --disable-gpu. It is run from cwd on a screen of its own.
Either way recording starts ${FILM_SETTLE_SECONDS} seconds in, once it has loaded and settled. Give one of url or
path, command, or session.`,
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Instead of url or command: the id of a running use_app session, recorded as it stands.',
        },
        steps: {
          ...STEPS_SCHEMA,
          description: `With session only: ${STEPS_SCHEMA.description} Done while it records.`,
        },
        url: {
          type: 'string',
          description: `An http, https or file address, or the path of an HTML file (relative to ${docker.WORKDIR}).`,
        },
        command: {
          type: 'string',
          description:
            'Instead of url: the shell command that launches a desktop app, such as ' +
            '`npx electron . --no-sandbox --disable-gpu`. Not to be given with url.',
        },
        cwd: { type: 'string', description: `Where command is run from. Defaults to ${docker.WORKDIR}.` },
        seconds: {
          type: 'number',
          description:
            `How long to record, from ${MIN_FILM_SECONDS} to ${MAX_FILM_SECONDS}. Defaults to ${FILM_SECONDS}. ` +
            'Long enough to show the movement through once, not longer.',
        },
        width: { type: 'number', description: `Width of the page in pixels. Defaults to ${SHOT_WIDTH}.` },
        height: { type: 'number', description: `Height of the page in pixels. Defaults to ${SHOT_HEIGHT}.` },
      },
      required: [],
    },
    async run(input, { signal, threadId }): Promise<ToolReturn> {
      const given = (key: string) => input[key] !== undefined && input[key] !== null && input[key] !== '';
      const chosen = ['url', 'command', 'session'].filter(given);
      if (chosen.length > 1) {
        throw new Error(`Give "url" or "command" or "session", only one of them, not ${chosen.join(' and ')}.`);
      }
      if (chosen.length === 0) throw new Error('"url" or "command" must be a non-empty string.');
      if (given('steps') && !given('session')) {
        throw new Error('Steps are done in a session: start the app with use_app, and give its session here.');
      }
      let target: { url: string } | { command: string; cwd: string } | { session: string; steps: unknown[] };
      let what: string;
      if (given('session')) {
        const session = requireString(input, 'session');
        if (!SESSION_ID.test(session)) throw new Error(`"${session}" is not a session id; use_app start gives one.`);
        target = { session, steps: checkSteps(input.steps) };
        what = `session ${session}`;
      } else if (given('command')) {
        const command = requireString(input, 'command');
        const cwd = given('cwd') ? posix.resolve(docker.WORKDIR, requireString(input, 'cwd')) : docker.WORKDIR;
        await ensureElectron(threadId, cwd, signal);
        target = { command, cwd };
        what = `the app run by ${command}`;
      } else {
        const url = pageUrl(requireString(input, 'url'));
        target = { url };
        what = url;
      }
      const width = even(pixels(input.width, SHOT_WIDTH));
      const height = even(pixels(input.height, SHOT_HEIGHT));
      const clipSeconds = duration(input.seconds);
      const file = `/tmp/ch-film-${randomUUID()}.webm`;
      const film = () =>
        docker.exec(
          threadId,
          'session' in target
            ? filmSessionCommand(target.session, clipSeconds, file, target.steps)
            : filmCommand(target, width, height, clipSeconds, file),
          {
            signal,
            // The settle and the recording itself, and then the encode, which on
            // a container with no GPU is the slowest part of it; and, in a
            // session, the steps, which may outlast the clip
            timeoutSeconds: clipSeconds + 120 + ('session' in target ? DRIVE_SECONDS : 0),
          }
        );
      try {
        // As with a screenshot, behind the other browsers in this container
        // (see withCaptureSlot); a recording is the heavier of the two.
        const { code, output } = await withCaptureSlot(threadId, signal, async () => {
          let filmed = await film();
          // The browser, the screen and the encoder are each put on the first
          // time something asks for them, and a container may be missing any of
          // them: one round to install, one to find the next one missing
          for (let tries = 0; tries < 2 && (filmed.code === 126 || filmed.code === 127); tries++) {
            const install = filmed.code === 127 ? docker.BROWSER_INSTALL : docker.RECORDER_INSTALL;
            await docker.exec(threadId, install, { signal, timeoutSeconds: 900 });
            filmed = await film();
          }
          return filmed;
        });
        if (code === 127) throw new Error(NO_BROWSER);
        if (code === 126) throw new Error(NO_RECORDER);
        const trouble = 'session' in target ? sessionTrouble(output, target.session) : null;
        if (trouble) throw new Error(trouble);
        const { complaint, report } = driven(output);
        const said = sayReport(report);
        if (code !== 0) {
          throw new Error([complaint || 'The recording could not be made.', said].filter(Boolean).join('\n\n'));
        }
        // The clip and its frames in one read: five files out of the container,
        // and a round trip each would be four more than it needs
        const names = Array.from({ length: FILM_FRAMES }, (_, n) => `${file}-${String(n + 1).padStart(2, '0')}.png`);
        const read = await docker.readEach(
          threadId,
          [file, ...names].map((name) => `cat ${quote(name)}`)
        );
        const clip = read?.[0];
        if (!clip || clip.code !== 0 || clip.data.length === 0) throw new Error('The recording could not be read.');
        if (clip.data.length > MAX_FILM_BYTES) {
          throw new Error(
            'The recording is too large to keep. Record for fewer seconds, or ask for a smaller width and height.'
          );
        }
        // A frame that is not there is one the clip was too short to reach;
        // what came out is what the model is shown
        const images: ToolImage[] = read
          .slice(1)
          .filter((frame) => frame.code === 0 && frame.data.length > 0)
          .map((frame) => ({ mediaType: 'image/png', data: frame.data.toString('base64') }));
        const frames = images.length
          ? `The ${images.length} ${images.length === 1 ? 'frame' : 'frames'} below are taken from it, evenly spaced.`
          : 'No frames could be taken from it, so you cannot see it yourself.';
        return {
          text:
            `Recorded ${clipSeconds}s of ${what}${'session' in target ? '' : ` at ${width}x${height}`}. ${frames} ` +
            'The clip itself is shown to the user under your reply, so point them to it and say what it shows.' +
            (said ? `\n\n${said}` : ''),
          images,
          videos: [{ mediaType: 'video/webm', data: clip.data.toString('base64') }],
        };
      } finally {
        // The clip and its frames, as with a screenshot: not tied to the
        // signal, so a call that was stopped still clears up after itself
        await docker.exec(threadId, `rm -f ${quote(file)} ${quote(`${file}-`)}*.png`).catch(() => undefined);
      }
    },
  },
  {
    name: 'use_app',
    description: `Use the real application, running in this thread's container, the way a person would: start it
once, then click, type and read what it shows over as many calls as you need, and stop it when you are done. This is
how to find out what the app does — reproduce a bug, try a change, check that a feature works — rather than a
script written to /tmp: it runs the app itself, with its own data, and tells you what it said.

action "start" starts a session and says its id. Give url for a web app (start its server with run_command first,
detached: setsid nohup <server> >/tmp/server.log 2>&1 &) or the path of an HTML file; or command for a desktop app
(Electron, say: npx electron . --no-sandbox --disable-gpu), run from cwd, with --remote-debugging-port added for you
unless command names one (a launcher such as npm start swallows the one added, so with one of those name it). For
an app that needs data to show, give it the data before you start it: the project's fixtures or seed command where
it has them, or a data directory under /tmp written with the state you want (for Electron, given as
--user-data-dir). Steps can be given with start as well.
Where the workspace has a run recipe — how its app is built, what runs beside it, its data and how it is launched,
saved by whoever first got it running — start with recipe: true instead of url or command: it does all of that and
waits until the app is showing what a user would see, in one call.
action "do" does steps in a running session. text and eval say back what they find; what the page wrote to its
console, the errors it threw, and what the app or its server wrote to its own output since the last call all come
back too. Pass screenshot: true to see it as well; without it you get only the words, which is often all a check
needs.
action "stop" stops a session. Stop each one you start once you are done with it; at most ${MAX_SESSIONS} run at once,
and one left unused for ${IDLE_MINUTES} minutes is stopped by the next start.

The session keeps its state between calls — what you typed, where you navigated, what the app saved — so there is no
need to do everything again for each look. Steps reach what the app draws, not its native menus or its title bar.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'do', 'stop'] },
        session: { type: 'string', description: 'The id start gave, for do and stop.' },
        recipe: {
          type: 'boolean',
          description: "For start, instead of url and command: run the app by this workspace's run recipe.",
        },
        url: {
          type: 'string',
          description:
            'For start: an http, https or file address, or the path of an HTML file ' +
            `(relative to ${docker.WORKDIR}).`,
        },
        command: {
          type: 'string',
          description: 'For start, instead of url: the shell command that launches a desktop app.',
        },
        cwd: { type: 'string', description: `Where command is run from. Defaults to ${docker.WORKDIR}.` },
        wait: {
          type: 'number',
          description: `For start: seconds to leave it to come up. Defaults to ${APP_WAIT} for an app, 2 for a page.`,
        },
        width: { type: 'number', description: `For start: width of the screen in pixels. Defaults to ${SHOT_WIDTH}.` },
        height: { type: 'number', description: `For start: height of the screen. Defaults to ${SHOT_HEIGHT}.` },
        steps: STEPS_SCHEMA,
        screenshot: {
          type: 'boolean',
          description: 'Take a screenshot once the steps are done, for start and do. Defaults to false.',
        },
      },
      required: ['action'],
    },
    async run(input, { signal, threadId, workspace }): Promise<ToolReturn> {
      const given = (key: string) => input[key] !== undefined && input[key] !== null && input[key] !== '';
      const action = input.action;
      const draw = input.screenshot === true;
      if (action === 'start') {
        const steps = checkSteps(given('steps') ? input.steps : undefined);
        const width = even(pixels(input.width, SHOT_WIDTH));
        const height = even(pixels(input.height, SHOT_HEIGHT));
        const id = newSessionId();
        let what: string;
        let ready = '';
        if (input.recipe === true) {
          if (given('command') || given('url')) throw new Error('Give recipe: true, or url or command, not both.');
          const recipe = recipes.get(workspace);
          if (!recipe) throw new Error(NO_RECIPE);
          try {
            const ran = await runRecipe(threadId, signal, recipe, id, { width, height, draw: false });
            what = `${ran.what}, from this workspace's run recipe`;
            ready = ran.said;
          } catch (error) {
            if (!(error instanceof RecipeFailure)) throw error;
            recipes.failed(workspace!, error.stage, error.message);
            const running = error.running ? ` Session ${id} is still running, for you to look at (do) or stop.` : '';
            throw new Error(
              `This workspace's run recipe failed at ${error.stage}.${running}\n${error.message}\n\n` +
                `If the recipe is what is wrong, start the app by hand with url or command, and once it is up save ` +
                `the recipe that works with ${recipes.SAVE_TOOL}.`
            );
          }
          recipes.worked(workspace!);
        } else {
          if (given('command') && given('url')) throw new Error('Give "url" or "command", not both.');
          if (!given('command') && !given('url')) throw new Error('"url" or "command" must be a non-empty string.');
          const app = given('command');
          const target = app
            ? {
                command: requireString(input, 'command'),
                cwd: given('cwd') ? posix.resolve(docker.WORKDIR, requireString(input, 'cwd')) : docker.WORKDIR,
              }
            : { url: pageUrl(requireString(input, 'url')) };
          await startSession(threadId, signal, id, target, width, height, seconds(input.wait, app ? APP_WAIT : 2));
          what = 'command' in target ? `the app run by ${target.command}` : target.url;
        }
        try {
          const { said, images } = await inSession(threadId, signal, id, steps, draw);
          const text = `Started session ${id}: ${what}, at ${width}x${height}. Give session "${id}" to do and stop.`;
          return { text: [text, ready, said].filter(Boolean).join('\n\n'), images };
        } catch (error) {
          // A session whose first call failed is still running, and still the model's to use or stop
          throw new Error(
            `Started session ${id}: ${what}, and it is still running (stop it, or try again with "do"). ` +
              (error as Error).message
          );
        }
      }
      if (action === 'do' || action === 'stop') {
        const id = requireString(input, 'session');
        if (!SESSION_ID.test(id)) throw new Error(`"${id}" is not a session id; start gives one.`);
        if (action === 'stop') {
          const { code } = await docker.exec(threadId, `${STOP_SESSION}\nch_stop ${quote(`${SESSION_DIR}${id}`)}`, {
            signal,
          });
          if (code === 3) throw new Error(sessionTrouble(NO_SESSION, id)!);
          return { text: `Stopped session ${id}.`, images: [] };
        }
        const steps = checkSteps(given('steps') ? input.steps : undefined);
        if (steps.length === 0 && !draw) throw new Error('Give steps to do, or screenshot: true, or both.');
        const { said, images } = await inSession(threadId, signal, id, steps, draw);
        const did = steps.length ? `Did ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : 'Drew it';
        return { text: [`${did} in session ${id}.`, said].filter(Boolean).join('\n\n'), images };
      }
      throw new Error('"action" must be start, do or stop.');
    },
  },
  {
    name: recipes.SAVE_TOOL,
    // A recipe belongs to the workspace, not to the thread (see ../sandbox/recipes.ts)
    needsWorkspace: true,
    description: `Save how this workspace's app is run, as its run recipe, so that anybody working here can start it
with use_app (action "start", recipe: true) in one call rather than working it out again. Use it once you have the app
running in this container and showing what a user would see, giving what you did to get it there: the build, what
had to be running beside it, the data it starts from, the launch, and what on the screen says it is up.

The recipe is run once more before it is kept, from nothing — the setup, the services, a fresh copy of the data, the
launch, the ready check and the steps after it — and it is kept only if all of it works; you are shown the app as it
leaves it. It replaces the recipe the workspace had. Keep it to running the app: a fix to the project is a change
like any other, not a step of the recipe.`,
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'object',
          description: `How the app is launched: {command, cwd?} for a desktop app (Electron, say: npx electron .
--no-sandbox --disable-gpu, with --remote-debugging-port added for you), or {url} for a page that the services
serve.`,
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: `Relative to ${docker.WORKDIR}. Defaults to it.` },
            url: { type: 'string' },
          },
        },
        setup: {
          type: 'array',
          items: { type: 'string' },
          description:
            `Commands run in order from ${docker.WORKDIR} before each launch, such as npm run build. Their output ` +
            "should go where the project's .gitignore keeps it out of the changes.",
        },
        services: {
          type: 'array',
          description:
            "What has to be running before the app: a web app's server, or a stand-in for something it talks to. " +
            'Each is started in the background, unless ready already answers, and waited for until it does.',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              ready: { type: 'string', description: 'An http address that answers once it is up.' },
            },
            required: ['command', 'ready'],
          },
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Variables set for the setup, the services and the app.',
        },
        data: {
          type: 'object',
          description:
            'A folder of the project that the app starts from, copied afresh for each launch and given to the app ' +
            'as flag=<the copy>: {from: "test/fixtures/user-data", flag: "--user-data-dir"}. For an app launched by ' +
            'command.',
          properties: { from: { type: 'string' }, flag: { type: 'string' } },
          required: ['from', 'flag'],
        },
        wait: { type: 'number', description: `Seconds to leave the app to come up. Defaults to ${APP_WAIT}.` },
        ready: {
          type: 'string',
          description:
            'CSS selector of something on the screen once the app is up, such as its main input: without it, the ' +
            'app counts as up as soon as it has not exited.',
        },
        after: {
          ...STEPS_SCHEMA,
          description:
            'Steps from where the app opens to where a user would start, such as putting a first-run dialog away. ' +
            STEPS_SCHEMA.description,
        },
        notes: {
          type: 'string',
          description:
            'What anybody using the app this way needs to know that the rest does not say, in a few sentences: how ' +
            'to put it into the state a check needs, what stands in for what. Told with the recipe.',
        },
      },
      required: ['app'],
    },
    async run(input, { signal, threadId, workspace }): Promise<ToolReturn> {
      if (!workspace) throw new Error('Only a thread started in a workspace has a run recipe to save.');
      const recipe = recipes.parse(input);
      checkSteps(recipe.after);
      refuseWrites(recipe);
      const id = newSessionId();
      let ran: Awaited<ReturnType<typeof runRecipe>>;
      try {
        ran = await runRecipe(threadId, signal, recipe, id, { width: SHOT_WIDTH, height: SHOT_HEIGHT, draw: true });
      } catch (error) {
        if (!(error instanceof RecipeFailure)) throw error;
        throw new Error(
          `The recipe was not saved: run from nothing, it failed at ${error.stage}.\n${error.message}\n\n` +
            'Put that right and save it again. What the app needs to start may be something you did by hand before.'
        );
      } finally {
        await stopSession(threadId, id);
      }
      recipes.put(workspace, recipe, threadId);
      return {
        text: [
          `Saved this workspace's run recipe, having run it from nothing: ${recipes.summary(recipe)}. ` +
            'Start the app with use_app, action "start" and recipe: true. Below is the app as the recipe leaves it.',
          ran.said,
        ]
          .filter(Boolean)
          .join('\n\n'),
        images: ran.images,
      };
    },
  },
  {
    name: 'write_file',
    // No step of a coding reply offers this: the change is made by the coder
    // subagents the doing step hands it to, one piece each (see
    // ../subagents/coder.ts and PROMPTS.execute in ../harness/phases.ts). The
    // suggest step is the one that holds it, which makes the change it
    // suggests in a demo copy and has the copy reverted rather than keeping it
    // (see phases.SUGGESTION). Still offered to those coders, whose tools are
    // their kind's rather than a step's (see specsFor in ../subagents/run.ts),
    // and to a reply that is not worked through in steps at all, which can
    // change a file as it always could (see toolsFor in ../harness/index.ts).
    phases: ['suggest'],
    description: `Create or overwrite a text file in this thread's container, creating parent directories as needed.
Relative paths are resolved from ${docker.WORKDIR}. Returns what the write changed, as a diff against the file as it
was. To change part of a file that is already there, use edit_file instead: it needs only the part that changes.`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run(input, { signal, threadId }) {
      const path = requireString(input, 'path');
      const content = input.content;
      if (typeof content !== 'string') throw new Error('"content" must be a string.');
      // Waits for any other write to this file, so that this one is the last, not a lost one
      const diff = await withFileLock(threadId, path, () => writeAndDiff(threadId, path, content, signal));
      // The diff is shown to the user under the call, as well as to the model
      return diff ? `Wrote ${path}\n\n${diff}` : `Wrote ${path} (no changes)`;
    },
  },
  {
    name: 'edit_file',
    // No step of a coding reply offers this: the change is made by the coder
    // subagents the doing step hands it to, one piece each (see
    // ../subagents/coder.ts and PROMPTS.execute in ../harness/phases.ts). The
    // suggest step is the one that holds it, which makes the change it
    // suggests in a demo copy and has the copy reverted rather than keeping it
    // (see phases.SUGGESTION). Still offered to those coders, whose tools are
    // their kind's rather than a step's (see specsFor in ../subagents/run.ts),
    // and to a reply that is not worked through in steps at all, which can
    // change a file as it always could (see toolsFor in ../harness/index.ts).
    phases: ['suggest'],
    description: `Change part of a text file in this thread's container, leaving the rest of it as it is. Give the
text to replace, exactly as it is in the file (indentation and line breaks included, and without the line numbers
read_file puts in front of each line), and what to put in its place. The text must be found in the file just once, so
include enough of the lines around the change to make it the only match; or set replace_all to change every place it
is found. Use this rather than write_file for any change to a file that is already there. Relative paths are resolved
from ${docker.WORKDIR}. Returns what the edit changed, as a diff.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: {
          type: 'string',
          description: 'The text to replace, exactly as it is in the file, without the line numbers read_file shows.',
        },
        new_text: { type: 'string', description: 'What to put in its place. Empty to take the text out.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every place the text is found, not just one. Defaults to false.',
        },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    async run(input, { signal, threadId }) {
      const path = requireString(input, 'path');
      // Said in full rather than as "must be a non-empty string": a model that
      // left it empty was trying to put text into a file with nothing to put
      // it beside, and asked four times over in one reply without the message
      // telling it what would work instead.
      if (input.old_text === '')
        throw new Error(
          '"old_text" is the text this replaces, so it cannot be empty. To add something to a file, give a line ' +
            "or two that is already there, exactly as they are without read_file's line numbers, and write them " +
            'back with your addition in "new_text". To make a new file, use write_file.'
        );
      const oldText = requireString(input, 'old_text');
      const newText = input.new_text;
      if (typeof newText !== 'string') throw new Error('"new_text" must be a string.');
      if (oldText === newText)
        throw new Error('"old_text" and "new_text" are the same, so there is nothing to change.');

      // The read, the change and the write are all done holding the file's lock:
      // an edit that read the file before another was written would write it back
      // without that one
      return withFileLock(threadId, path, async () => {
        // A read never makes the thread's container, and an edit may be the first thing a thread does in one: made
        // here, as a write would make it, rather than the file being reported missing from a container not yet made
        await docker.ensure(threadId);
        // Read whole and exact, so that what is written back differs only by the edit
        const read = await docker.read(threadId, `cat ${quote(path)}`);
        if (!read || read.code !== 0) throw new Error(`Could not read ${path}. To make a new file, use write_file.`);
        if (read.data.includes(0)) throw new Error(`${path} is not a text file.`);
        const content = read.data.toString('utf8');

        const found = content.split(oldText).length - 1;
        if (found === 0) {
          throw new Error(
            `"old_text" was not found in ${path}. It must match the file exactly, indentation and line breaks
included; read the file again and copy the text from it.`
          );
        }
        if (found > 1 && input.replace_all !== true) {
          throw new Error(
            `"old_text" is found ${found} times in ${path}. Include more of the lines around the change so that it
matches only once, or set replace_all to change them all.`
          );
        }
        // Split and joined, so that nothing in the new text is read as a pattern
        const edited =
          input.replace_all === true ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
        const diff = await writeAndDiff(threadId, path, edited, signal);
        const places = found > 1 ? ` in ${found} places` : '';
        return `Edited ${path}${places}\n\n${diff}`;
      });
    },
  },
  {
    name: ADD_TO_CONTEXT,
    description: `Add what you have found out to your context note, leaving the rest of it as it is. Call this after
every tool call. It is also what gives you room: once you have written about a result, that result is set aside and the
room it was taking is yours again, while the note stays in front of you.

Write what is worth keeping from what you have just read: what is really causing a bug, where a kind of thing lives,
the command that works and its flags, what you tried that does not work, what is done and what is left. A line or two
is enough, and nothing is rewritten, so it costs you almost nothing.

Write each line so that it still means something with the result gone: name the files, commands and identifiers
exactly as they are spelled, rather than "the file above". This note is also all the next message sees of this work.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What you found out, in a line or two, naming what it is about.' },
      },
      required: ['content'],
    },
    async run(input, { signal, threadId, agent }) {
      const line = requireString(input, 'content').trim();
      // Protect append with a per-path lock to prevent race conditions during read-modify-write
      await withFileLock(threadId, contextFile(agent), async () => {
        await appendFile(threadId, contextFile(agent), `${line}\n`, signal);
      });
      return 'Added to your context note.';
    },
  },
  {
    name: 'save_context',
    description: `Replace your whole context note with this one. Use it to tidy the note up or put it in order once it
has grown — to add something while you work, use add_to_context, which rewrites nothing and cannot lose anything.

This overwrites the note, so write the whole of it: keep everything still relevant from the current one, which is
shown to you at the start of every message.

The note is yours alone. Others working in this container at the same time have their own, and nothing you write
here reaches theirs.`,
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The full, updated note.' } },
      required: ['content'],
    },
    async run(input, { signal, threadId, agent }) {
      const path = contextFile(agent);
      // Protect whole-file writes with a per-path lock to prevent race conditions
      await withFileLock(threadId, path, async () => {
        await writeFile(threadId, path, requireString(input, 'content'), signal);
      });
      return 'Context saved.';
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}

// Re-export the lock utilities for tests and other modules that need them
export { withCaptureSlot, withFileLock } from '../sandbox/lock';
