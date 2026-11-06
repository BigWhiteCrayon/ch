import * as child_process from 'child_process';
import fs from 'fs';
import * as access from '../harness/access';
import * as log from '../log';
import * as seatbelt from '../sandbox/seatbelt';
import type { Tool } from '../types';
import { GIT_READS, gitSubcommand, READING, refuse, stages } from './reading';
import { copyHint } from './sandbox';

// How long a host command may run, and how much of its output is kept. A git
// that changes the repository gets longer: a fetch, a push or a merge of any
// size is work a reading command never does, and one killed half way through
// is worse than one that took a while.
const TIMEOUT_MS = 30 * 1000;
const WRITING_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

// What git is run with, so that nothing here waits on somebody at the
// keyboard: no editor to fill in a commit message, no sequence editor for a
// rebase, no pager to page the output and no prompt for a password. Each of
// them would otherwise hold the command until the timeout killed it, and a
// failure that says what was wanted is worth more than a wait.
const GIT_ENV = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

// Shell operators, and anything else that could start a second command or a redirection. A pipe is not among them:
// the stages are run as processes wired together here, so one is the only piece of the shell's punctuation this tool
// can honour without a shell (see runHost).
const SHELL_OPERATORS = /[;&$`><()\n]/;

// What a stage after the first may be: reading programs that take their input from the one before them and write
// nothing but their own output. The first stage may be any program this tool runs, because it is the one with a
// folder to read; a later stage is there to shape what the first one said, and the programs that answer questions
// about the folder instead are worth a command of their own.
const FILTERS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'rev',
  'column',
  'grep',
  'rg',
]);

// An argument may not name a path outside the folder the command runs in
function isPathArgument(arg: string): boolean {
  return arg.startsWith('/') || arg.startsWith('~') || arg.split('/').includes('..');
}

// Flags that make a read-only program write a file, run another program, or change directory. Not asked of git,
// which is here to write: its own flags of that kind are refused where it is taken apart (see isGitUnsafeFlag in
// ./reading.ts), and the rest of what it writes is the repository it was pointed at.
function isWritingFlag(argv: string[]): boolean {
  if (argv[0] === 'git') return false;
  return argv.slice(1).some((arg) => {
    if (['-o', '--output', '-R', '--pre', '--ext-diff', '--textconv'].includes(arg)) return true;
    if (arg.startsWith('--output=') || arg.startsWith('--pre=')) return true;
    if (argv[0] === 'file' && arg === '-C') return true;
    return false;
  });
}

// Whether a git command changes the repository rather than reading it: anything that is not one of the subcommands
// that only read (see GIT_READS in ./reading.ts). "git --version" writes nothing and names no subcommand.
function writesRepository(argv: string[]): boolean {
  if (argv[0] !== 'git') return false;
  const sub = gitSubcommand(argv);
  return Boolean(sub) && !GIT_READS.has(sub!);
}

// The arguments a check would be wrong about: the text after -m is a message, and a message is the one free-text
// argument git takes — what is in it names nothing, so neither a path check nor the look for a force flag below
// should read it. Everything else git is given names something in the repository.
const takesMessage = (arg: string) => arg === '--message' || /^-[A-Za-z]*m$/.test(arg);

// A git command's arguments with its message left out
function named(argv: string[]): string[] {
  if (argv[0] !== 'git') return argv.slice(1);
  const args: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (takesMessage(argv[i])) {
      i += 1; // the message itself
      continue;
    }
    if (argv[i].startsWith('--message=')) continue;
    args.push(argv[i]);
  }
  return args;
}

// A force flag, written either way round: --force, --force-with-lease, --force-if-includes
const FORCING = /^--force($|[-=])/;
// ...and a short one, which may be in a cluster: clean -fd, branch -D, push -f
const SHORT_FORCING = /^-[A-Za-z]*[fD]/;

// Flags that drop something, or that override a check git makes to keep work from being lost. --amend is here
// because the commit it rewrites is gone from the branch afterwards, which is the same loss by another name.
const OVERRIDING = new Set(['--hard', '--amend', '--prune', '--delete', '--delete-all', '-d', '-D']);

// Subcommands that can throw away work, or that reach a repository that is not on this computer, whatever arguments
// they are given. Each of them is asked about by name: "git reset" with no --hard only unstages, but the one that
// loses a day's work is the same word away, and the user is the one to say which they meant.
const SENSITIVE = new Set([
  'push',
  'reset',
  'clean',
  'rm',
  'restore',
  'rebase',
  'stash',
  'prune',
  'gc',
  'reflog',
  'update-ref',
  'worktree',
  'replace',
]);

// Words that make an otherwise ordinary subcommand remove something: "git remote remove", "git notes prune"
const REMOVING = new Set(['remove', 'rm', 'drop', 'clear', 'expire', 'deinit', 'set-url']);

// Whether an argument of a checkout is a path rather than a branch, as far as that can be told from the word: a
// checkout given a path writes the committed version over what is in the folder now, and a checkout given a branch
// refuses rather than lose anything.
const looksLikePath = (arg: string) => arg === '.' || arg.includes('/') || arg.includes('.');

// Why this git command is one the user has to allow by name before it runs, or null where it is not. A command that
// only reads is never one of them.
//
// The bound the tool keeps on its own is on what may be named: a program from the lists, arguments that stay in the
// folder. That bound says nothing about losing work, because the commands that lose it are spelled the same as the
// ones that do the work — so this is where the user is asked instead, and the answer is for the one command (see
// access.confirmed).
export function sensitive(argv: string[]): string | null {
  if (!writesRepository(argv)) return null;
  const sub = gitSubcommand(argv)!;
  const args = named(argv);
  const forced = args.find((arg) => FORCING.test(arg) || SHORT_FORCING.test(arg) || OVERRIDING.has(arg));
  if (forced) {
    return `"${forced}" overrides a check git makes, or drops something it is holding`;
  }
  if (SENSITIVE.has(sub)) {
    return `"git ${sub}" can throw away work that is not committed, or change a repository elsewhere`;
  }
  const removing = args.find((arg) => REMOVING.has(arg));
  if (removing) return `"git ${sub} ${removing}" removes something`;
  if (sub === 'checkout' && args.slice(args.indexOf(sub) + 1).some((arg) => arg === '--' || looksLikePath(arg))) {
    return '"git checkout" with a path writes the committed version of it over what is in the folder now';
  }
  return null;
}

// The environment a stage runs in. Nothing here can answer an editor or a password prompt (see GIT_ENV), and a git
// that only reads is told not to take the locks it would take to tidy the index as it goes: that is a write, which
// the sandbox refuses a reading command (see confinement), and one that would hold up the user's own git meanwhile.
function envFor(argv: string[]): NodeJS.ProcessEnv {
  if (argv[0] !== 'git') return process.env;
  return { ...process.env, ...GIT_ENV, ...(writesRepository(argv) ? {} : { GIT_OPTIONAL_LOCKS: '0' }) };
}

// The folders a git that changes the repository at cwd may write in: the working tree and the repository itself,
// which a linked worktree keeps somewhere else, and cwd, for the git that makes one there (init, clone). Asked of
// git, confined to reading, so that the answer is git's own rather than a guess at where .git is.
async function repositoryFolders(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const ask = async (flag: string) => {
    const argv = ['git', 'rev-parse', '--path-format=absolute', flag];
    const { code, output } = await runHost([argv], cwd, {
      signal,
      timeoutMs: TIMEOUT_MS,
      wrap: (a) => seatbelt.confine(a),
    });
    return code === 0 ? output.trim().split('\n')[0] : null;
  };
  const found = await Promise.all([ask('--show-toplevel'), ask('--git-common-dir')]);
  return [cwd, ...found.filter((folder): folder is string => Boolean(folder))];
}

// How each stage of a command is confined on this computer, where it can be (see ../sandbox/seatbelt.ts): a git
// that changes the repository may write in that repository, and every other stage writes nothing at all. Where it
// cannot be, the stages run as they are, and that is said once in the log, being a bound this computer does not have.
let unconfinedSaid = false;
async function confinement(
  pipeline: string[][],
  cwd: string,
  signal?: AbortSignal
): Promise<((argv: string[], at: number) => string[]) | undefined> {
  if (!seatbelt.available()) {
    if (!unconfinedSaid) log.warn('host.unconfined', { platform: process.platform });
    unconfinedSaid = true;
    return undefined;
  }
  const writable = writesRepository(pipeline[0]) ? await repositoryFolders(cwd, signal) : null;
  return (argv, at) => seatbelt.confine(argv, at === 0 ? writable : null);
}

// Runs a pipeline of stages directly (no shell) in cwd, with a timeout, each stage a process of its own with its
// output wired into the next, and returns the last stage's output, cut at MAX_OUTPUT. Every stage's errors are kept
// too: a pipeline that said nothing because its first stage could not run has to say which stage that was.
//
// A shell is what would ordinarily do this wiring, and giving one the command is what this tool will not do: the
// command is parsed well enough to find a program and its arguments, which is a fair bargain for a container (see
// ./reading.ts) and a poor one for the user's own filesystem. Doing the wiring here keeps the stages as argv — each
// one a program this tool allows, run with its arguments and nothing expanded, interpolated or re-split.
//
// Each stage is given to wrap before it is run, which is how it is confined (see confinement): what is decided about
// a stage — git's environment, which is the first — is decided from the stage as it was given.
function runHost(
  pipeline: string[][],
  cwd: string,
  {
    signal,
    timeoutMs,
    wrap = (argv) => argv,
  }: { signal?: AbortSignal; timeoutMs: number; wrap?: (argv: string[], at: number) => string[] }
): Promise<{ code: number | null; output: string; cut: boolean }> {
  return new Promise((resolve) => {
    let output = '';
    let cut = false;
    const collect = (chunk: Buffer) => {
      if (cut) return;
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        cut = true;
      }
    };
    const children = pipeline.map((argv, i) => {
      const [program, ...args] = wrap(argv, i);
      return child_process.spawn(program, args, {
        cwd,
        shell: false,
        signal,
        env: envFor(argv),
        // Nobody is at the keyboard, so the first stage is given no input at all: one that would have read standard
        // input ends at once instead of waiting out the timeout for input that was never coming.
        stdio: [i === 0 ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    });
    const last = children[children.length - 1];
    children.forEach((child, i) => {
      // A stage that stops reading early — head, mostly — leaves the one before it writing to a pipe with no other
      // end, which is how such a pipeline is meant to finish and not a failure to report
      child.stdout?.on('error', () => {});
      child.stdin?.on('error', () => {});
      if (child === last) child.stdout?.on('data', collect);
      else child.stdout?.pipe(children[i + 1].stdin!);
      child.stderr?.on('data', collect);
    });
    let code: number | null = null;
    let failed = false;
    const timer = setTimeout(() => children.forEach((child) => child.kill()), timeoutMs);
    const left = new Set(children);
    const finish = (child: child_process.ChildProcess) => {
      // A stage that could not be spawned at all reports both an error and a close
      if (!left.delete(child) || left.size > 0) return;
      clearTimeout(timer);
      resolve({ code: failed ? null : code, output, cut });
    };
    for (const child of children) {
      child.on('error', (err) => {
        failed = true;
        collect(Buffer.from(err.message));
        finish(child);
      });
      // The shell's own answer to what a pipeline exited with: its last stage did
      child.on('close', (status) => {
        if (child === last) code = status;
        finish(child);
      });
    }
  });
}

const PROGRAMS = [...READING].sort().join(', ');

export const tool: Tool = {
  name: 'run_host_command',
  description: `Run one command on the user's own computer, in the folder given as path, once the user has allowed
that folder. Everything but git only reads. Use it to search, count or run git in a folder there. To read one file,
or list one folder, use read_user_file. For the project's files, use run_reading_command or read_file — but for
anything about the project's repository this is the tool: give the workspace as path, because what you work in is a
copy made without the project's .git, and the repository is in the user's own checkout. Git in the workspace needs
no allowing — but what it shows is that checkout as it stands, which is the user's own work and not yours: for your
own changes use thread_diff.

Git may change the repository here, not only read it: commit, branch, merge, pull, tag, push. A command that could
throw work away or reach a repository elsewhere — anything forcing (-f, --force, -D), reset, clean, rm, restore,
rebase, stash, gc, reflog, push — is put to the user first, in their own words, and does not run until they say yes;
so run one of those only when that is what was asked for, and say why in the same reply. Nothing else of git is
asked about. Git is run with no editor and no password prompt, so give a commit its message with -m and expect a
push that needs typing to fail rather than wait.

It runs these programs and no others: ${PROGRAMS}, git, and "--version" from a language or package manager. Git that
runs a program of its own is refused: no config, submodule, bisect, filter-branch, difftool, mergetool, hook, help,
and no -c, -C, --git-dir or --work-tree. It may be piped into ${[...FILTERS].sort().join(', ')} — "git log --oneline
| head -20" rather than the whole log cut off at ${MAX_OUTPUT / 1024} KB. path must be a folder, not a file: give it
as an absolute path, or one starting from ~. Arguments may not be absolute paths, start with ~, or contain .. as a
path segment, so what a command touches stays in the folder; a commit message is the one argument this is not asked
of. Every shell operator is refused — redirections, several commands at once, backquotes, $(…): there is no shell
here, each program is run directly and the pipes are wired up for them.

On macOS every command runs in a sandbox as well: anything but a git that changes the repository can write nothing
and reach no network, and that git may write only in its own repository (its hooks too). "Operation not permitted"
from a command means it tried to do something else.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          "The absolute path of a folder on the user's computer, or one starting from ~ for the home folder.",
      },
      command: {
        type: 'string',
        description:
          'The command to run: the program name, then its arguments, separated by spaces, optionally piped into ' +
          'one of the filtering programs.',
      },
    },
    required: ['path', 'command'],
  },
  // No phases of its own: everything it runs but git only reads, like
  // read_user_file next door, so it is offered wherever there are tools at
  // all. The finding-out step needs it most of any: the project's history is
  // reachable through this tool and no other, the container's copy having been
  // made without the .git (see filesToCopy in ../sandbox/docker.ts). What git
  // writes is bounded by the user rather than by the step — the ones that
  // could lose work are asked about one at a time (see sensitive above).
  async run(input, context) {
    const given = input as { path?: unknown; command?: unknown } | null;
    if (typeof given?.path !== 'string' || !given.path.trim()) {
      throw new Error('"path" must be a non-empty string.');
    }
    if (typeof given?.command !== 'string' || !given.command.trim()) {
      throw new Error('"command" must be a non-empty string.');
    }
    const command = given.command.trim();
    if (SHELL_OPERATORS.test(command)) throw new Error('Shell operators are not allowed in a host command.');
    // Git may write here, the repository being on this computer and nowhere else; everything else on the lists
    // only reads (see Allows in ./reading.ts)
    const why = refuse(command, { git: 'writes' });
    if (why) throw new Error(why);
    // refuse has already had every stage's program off the lists; what is left is what this tool asks of them on
    // top of that, which is the same of each stage as it ever was of the one command
    const pipeline = stages(command);
    for (const [at, argv] of pipeline.entries()) {
      if (at > 0 && !FILTERS.has(argv[0])) {
        throw new Error(
          `"${argv[0]}" is not one of the programs that may take their input from a pipe here. Those are: ` +
            `${[...FILTERS].sort().join(', ')}. Run anything else as a command of its own.`
        );
      }
      if (named(argv).some(isPathArgument)) {
        throw new Error(
          'Arguments may not be absolute paths, start with ~, or contain ".." as a path segment. ' +
            'Give each one relative to path, or use read_user_file for a single file.'
        );
      }
      if (isWritingFlag(argv)) {
        throw new Error(
          'That flag would write a file, run another program or change directory, so it is not allowed here.'
        );
      }
    }
    const target = access.resolve(given.path.trim());
    // Git in the thread's own workspace is the one thing here that belongs to the thread rather than to the user's
    // computer at large. The copy holds the project's files and not its .git (see filesToCopy in
    // ../sandbox/docker.ts), so the repository is only in the workspace itself: a git sent to the copy instead finds
    // none and reads that as a project kept in none. The thread already works on this folder and is shown its
    // files — so git here is neither sent to the copy nor asked about as a folder. What it may do there is bounded
    // by what it is: the commands that could lose work are put to the user by name below, in this folder as in any
    // other. Anything else, and anywhere else, goes the ordinary way.
    const ownWorkspace =
      pipeline[0][0] === 'git' &&
      Boolean(context.threadId) &&
      access.relativeToWorkspace(context.workspace, target) !== null;
    if (!ownWorkspace) {
      const copy = copyHint(context, target);
      if (copy) throw new Error(copy);
    }
    // Nothing here may say whether the path is there until the user has said yes
    let isFolder = false;
    try {
      isFolder = fs.statSync(target).isDirectory();
    } catch {
      // Reported after the question, if it is still a problem then
    }
    // A git command that could throw work away is put to the user as itself: the command, the folder and what is
    // risky about it, answered for this once and remembered for nothing (see access.confirmed). It is asked in place
    // of the question about the folder rather than after it — it says everything that one does and more, and a yes
    // to a folder is a yes that can be kept, which is not a thing to keep about "push --force".
    const risk = sensitive(pipeline[0]);
    if (risk) {
      if (!(await access.confirmed(command, target, risk, context))) {
        throw new Error(`The user did not allow "${command}" in ${target}.`);
      }
    } else if (!ownWorkspace && !(await access.permitted(target, isFolder, context))) {
      throw new Error(`The user did not allow running commands in ${target}.`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      throw new Error(
        `Could not find ${given.path.trim()}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`
      );
    }
    if (!stat.isDirectory()) throw new Error(`${target} is not a folder. To read a single file, use read_user_file.`);
    const { code, output, cut } = await runHost(pipeline, target, {
      signal: context.signal,
      timeoutMs: writesRepository(pipeline[0]) ? WRITING_TIMEOUT_MS : TIMEOUT_MS,
      wrap: await confinement(pipeline, target, context.signal),
    });
    return `exit code ${code}\n${output}${cut ? `\n(output cut at ${MAX_OUTPUT} bytes)` : ''}`;
  },
};

export const tools: Tool[] = [tool];
