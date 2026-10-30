// The command tool a step that cannot change anything is allowed to hold.
//
// run_command belongs to the step that changes things, because a command can
// do anything (see ../harness/phases.ts and the tool in ./sandbox.ts). But
// some of what a reader wants is only answerable by running something: how
// many of a thing there are, what a test actually asserts, what is installed.
// Refusing all of that to the finding-out step sends it reading files to work
// out what one call would have told it.
//
// What the history says is not among them, though git reads are on the list
// below: the container holds the project's files and no .git (see filesToCopy
// in ../sandbox/docker.ts), so the repository is only on the user's computer,
// and run_host_command is what reaches it. The description says so, because a
// model that reads "not a git repository" here concludes the project is not
// kept in one.
//
// So this is the same idea bounded the other way round: not "a shell, minus
// the writes we could think of", but "these programs and no others". A command
// is taken apart before it runs, and every part of it has to be something on
// the lists below; anything else is refused with the reason, which is a thing
// the model can act on. The bound is on what may be named rather than on what
// may happen, because the second is not a thing a pattern can decide — a
// shell is a programming language, and `run_command` already carries the only
// honest version of that bargain.
//
// What is deliberately not here: anything that runs code of its own (node,
// python, a package manager's scripts, make), anything that edits in place
// (sed -i, perl -i), anything that takes a program as an argument (xargs, env,
// find -exec), and the shell's own ways of joining commands and redirecting
// them. With those gone, the programs that are left cannot write to the
// project whatever arguments they are given.

import * as docker from '../sandbox/docker';
import type { Tool } from '../types';

// Programs that read and write nothing but their own output. Each is here
// because it has no flag that writes a file: the ones that do (sed -i, find
// -delete, sort -o) are left out of the list entirely rather than having
// their flags policed, since a list of refused flags is a list somebody has
// to keep up with as the programs grow new ones.
export const READING = new Set([
  // Looking at the project
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'tree',
  'basename',
  'dirname',
  'realpath',
  // Matching in it. The search tools are better for finding where a thing is;
  // these are for counting and for the odd question a search cannot phrase.
  'grep',
  'rg',
  // Shaping output in a pipeline, none of which can name a file to write
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'rev',
  'column',
  'diff',
  // What is installed
  'which',
]);

// ...and the one program worth a list of its own. Most of git reads, and the
// part that writes would undo the thread's work in a way nothing else here
// can, so the subcommand is checked rather than the program. They stay on the
// list all the same: a git that finds no repository says so harmlessly, and
// not every workspace is a copy with its .git left behind.
//
// Exported because the tool that runs git where the repository is lets it
// write as well as read, and so has to know which of the two a command is:
// what writes is asked about and what reads is not (see ./hostReading.ts).
export const GIT_READS = new Set([
  'log',
  'show',
  'diff',
  'status',
  'blame',
  'shortlog',
  'describe',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'cat-file',
  'name-rev',
  'whatchanged',
  'grep',
]);

// What git will not be run as, even where it is allowed to write (see the
// `git` option below). Each of these takes a program and runs it, serves
// something, or leaves a program behind for a later git to run — which is the
// one thing the bound here is for: this tool names what may run, and a git
// that runs what it is handed would let anything through it. `config` is here
// for the last of those reasons rather than the first: an alias, a pager or an
// editor set now is a program run by the next command.
const GIT_RUNS_CODE = new Set([
  'filter-branch',
  'bisect',
  'submodule',
  'difftool',
  'mergetool',
  'daemon',
  'instaweb',
  'web--browse',
  'hook',
  'p4',
  'svn',
  'send-email',
  'imap-send',
  'request-pull',
  'gui',
  'citool',
  'credential',
  'config',
  'help',
]);

// Flags git takes before its subcommand that would run a program of its own,
// set a configuration that runs one later, or move git to a repository that is
// not the folder it was pointed at. The arguments are already kept inside that
// folder (see isPathArgument in ./hostReading.ts); these would step around it
// by name. Only refused where git reads them, which is before the subcommand:
// "-c" after one is the subcommand's own flag and means something else
// entirely ("git log -c" is a diff of a merge).
const GIT_GLOBAL_FLAGS = ['-c', '-C', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace'];

// ...and the ones that hand a subcommand a program to run, wherever they are
// written
const GIT_RUNNING_FLAGS = ['--upload-pack', '--receive-pack', '--ext-diff', '--textconv'];

// The first argument of either kind, or undefined where there is none. Written
// either way round: "-c x=y" or "--git-dir=.git".
export function gitUnsafeFlag(argv: string[]): string | undefined {
  const sub = gitSubcommand(argv);
  const at = sub ? argv.indexOf(sub) : argv.length;
  return argv.slice(1).find((arg, i) => {
    const flags = i + 1 < at ? [...GIT_GLOBAL_FLAGS, ...GIT_RUNNING_FLAGS] : GIT_RUNNING_FLAGS;
    return flags.some((flag) => arg === flag || arg.startsWith(flag + '='));
  });
}

// Programs that run code, and so are allowed to say their version and nothing
// else: a reader wants to know what the container has, and that answer is
// worth more than the risk of the same program with other arguments.
const VERSION_ONLY = new Set([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'deno',
  'bun',
  'python',
  'python3',
  'pip',
  'pip3',
  'go',
  'cargo',
  'rustc',
  'java',
  'javac',
  'ruby',
  'php',
  'dotnet',
  'gcc',
  'clang',
  'make',
  'tsc',
  'git',
]);
// What a program can be called: a name, not a path, a pattern or a phrase
const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version']);

// What a command may not contain at all: the shell's own ways of running a
// second thing, writing somewhere, or standing one command in for a word.
// Checked against the masked command (see mask), so the shell's punctuation is
// refused wherever the shell would act on it and nowhere else: a pattern like
// "a\\|b", "=>" or "&&" is an argument, not a second command.
const FORBIDDEN: [RegExp, string][] = [
  [/[>]/, 'a redirection (>), which writes'],
  [/[<]/, 'a redirection (<)'],
  [/[;\n]/, 'more than one command (; or a newline)'],
  [/&/, 'a & — commands joined this way, or put in the background, are not allowed'],
  [/`/, 'a backquote, which runs a command inside another'],
  [/\$\(/, 'a $(…), which runs a command inside another'],
  [/\$\{/, 'a ${…} expansion'],
];

// The command with every character the shell would not act on replaced by a
// placeholder, one for one so that positions still line up with the original.
//
// This is what the checks below read, because a pattern is not punctuation: an
// agent searching for "a\\|b", "=>", "&&" or "<script" is naming one thing to
// look for, and splitting that on its pipe left the half after it standing
// where the program's name should be. What a quote makes inert differs between
// the two kinds, and this follows the shell rather than guessing: inside single
// quotes nothing is special, while inside double quotes the shell still runs
// `…`, $(…) and ${…}, so those are left in to be refused. A backslash outside
// quotes makes the next character literal, so both are masked.
function mask(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') {
      out += i + 1 < command.length ? 'QQ' : 'Q'; // \\x is the literal x
      i += 1;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const to = end < 0 ? command.length - 1 : end; // unclosed: inert to the end
      out += 'Q'.repeat(to - i + 1);
      i = to;
    } else if (ch === '"') {
      out += 'Q';
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) {
          out += 'QQ'; // \\x inside double quotes: the literal x
          j += 1;
        } else if (command[j] === '`') {
          out += '`'; // still runs a command, even in double quotes
        } else if (command[j] === '$' && (command[j + 1] === '(' || command[j + 1] === '{')) {
          out += command[j] + command[j + 1]; // ...as do $(…) and ${…}
          j += 1;
        } else {
          out += 'Q';
        }
      }
      if (j < command.length) out += 'Q'; // the closing quote
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

// Where the command's own pipes are: the positions of every | the shell would
// act on, which is every one the mask left standing.
function pipes(masked: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === '|') at.push(i);
  return at;
}

// The segments a command's pipes divide it into, cut from the original text at
// the positions the mask found them
function segments(command: string, masked: string): string[] {
  const cuts = pipes(masked);
  const out: string[] = [];
  let from = 0;
  for (const at of cuts) {
    out.push(command.slice(from, at));
    from = at + 1;
  }
  out.push(command.slice(from));
  return out;
}

// Splitting a segment into its words, keeping quoted strings whole. Good
// enough to find the program and its arguments, which is all that is asked of
// it: the characters that would make this parsing a security question of its
// own are refused above before it runs.
function words(segment: string): string[] {
  return segment.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
}

const unquote = (word: string) =>
  (word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"'))
    ? word.slice(1, -1)
    : word;

// A command's stages, each as its program and then its arguments: the command
// cut at the pipes the shell would act on, and every piece split into words.
// Exported because run_host_command runs the stages itself, one process per
// stage with no shell anywhere (see ./hostReading.ts), and the two tools
// taking a command apart the same way is the point.
export function stages(command: string): string[][] {
  const given = command.trim();
  return segments(given, mask(given)).map((segment) => words(segment).map(unquote));
}

// Which git subcommand a command names, or undefined where it names none:
// the first word that is not a flag, git's own flags coming before it.
// Exported because what a git command is allowed to do depends on which one it
// is, and two tools ask that of it (see ./hostReading.ts).
export const gitSubcommand = (argv: string[]): string | undefined =>
  argv.slice(1).find((part) => !part.startsWith('-'));

// What a tool allows beyond the lists above. Nothing, in the container: the
// step that holds run_reading_command is a step that changes nothing. On the
// user's own computer git may write, because the repository is only there and
// the work of a branch — committing, merging, pushing — has nowhere else to
// happen (see ./hostReading.ts, which asks the user before the ones that could
// lose work).
export interface Allows {
  git?: 'reads' | 'writes';
}

// Why this command is not one this tool will run, or null if it will. The
// reason is written for the model: it says what was wrong and what to use
// instead, since a refusal it cannot act on costs it the round and teaches it
// nothing.
export function refuse(command: string, allows: Allows = {}): string | null {
  const given = command.trim();
  if (!given) return 'The command is empty.';
  const masked = mask(given);
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(masked)) {
      return (
        `That command contains ${what}. This tool runs one reading program at a time, optionally piped into ` +
        'another; use run_command in the doing step for anything else.'
      );
    }
  }
  for (const parts of stages(given)) {
    const program = parts[0];
    if (!program) return 'There is an empty command between two pipes.';
    if (program.includes('/')) {
      return (
        `"${program}" names a program by its path. Give the name alone, and only one of the programs this tool ` +
        'runs.'
      );
    }
    if (program === 'git') {
      const sub = gitSubcommand(parts);
      const writes = allows.git === 'writes';
      const unsafe = gitUnsafeFlag(parts);
      if (unsafe) {
        return (
          `"${unsafe}" would have git run a program of its own, or work in a repository other than the folder it ` +
          'was given, so it is not allowed here. Name the subcommand and its own arguments and nothing else.'
        );
      }
      // `git --version` is the one form with no subcommand to check
      if (!sub) {
        if (parts.slice(1).some((part) => VERSION_FLAGS.has(part))) continue;
        return writes
          ? 'Say which git subcommand to run.'
          : 'Say which git subcommand to run, and one that reads: ' + [...GIT_READS].sort().join(', ') + '.';
      }
      if (writes) {
        if (!GIT_RUNS_CODE.has(sub)) continue;
        return (
          `"git ${sub}" runs a program of its own, or leaves one behind for a later command to run, which is the ` +
          'one thing this tool will not do whatever it is pointed at. Run the git that does the work itself: ' +
          `${[...GIT_READS].sort().join(', ')}, and the subcommands that change the repository.`
        );
      }
      if (!GIT_READS.has(sub)) {
        return (
          `"git ${sub}" is not one of the git subcommands that only read. Those are: ` +
          `${[...GIT_READS].sort().join(', ')}. Anything that changes the repository belongs in the doing step, ` +
          'through run_command.'
        );
      }
      continue;
    }
    if (READING.has(program)) continue;
    if (VERSION_ONLY.has(program)) {
      const rest = parts.slice(1);
      if (rest.length === 1 && VERSION_FLAGS.has(rest[0])) continue;
      return (
        `"${program}" runs code of its own, so this tool will only ask it its version ("${program} --version"). ` +
        'Running it for real belongs in the doing step, through run_command.'
      );
    }
    // What the model actually did four times in one reply: gave the thing it
    // wanted to search for in place of the program that would search for it
    // ("llm:cancel", "llm\\.onEvent"). The list below says what it may run and
    // it kept guessing from the list; this says what it looks like it meant.
    if (!PROGRAM_NAME.test(program)) {
      return (
        `"${program}" does not name a program; it looks like something to search for. To find it, use ` +
        `search_workspace, or run a search: grep -rn ${JSON.stringify(program)} .`
      );
    }
    return (
      `"${program}" is not one of the programs this tool runs. Those are: ` +
      `${[...READING, 'git'].sort().join(', ')}, and "--version" from a language or package manager. For searching ` +
      'and reading files use search_workspace, list_workspace and read_file; for anything that builds, installs or ' +
      'changes something, run_command in the doing step.'
    );
  }
  return null;
}

export const tool: Tool = {
  name: 'run_reading_command',
  // No phases of its own: it reads, so it is offered wherever there are tools
  // at all, the finding-out step included (see ../harness/phases.ts)
  description: `Run one command that only reads, in this thread's container (the project copy), and get its output. For
the questions about the project that are quickest answered by running something: how many of a thing there are
(wc, grep -c), what is installed (node --version), what a command prints.

It runs these programs and no others: ${[...READING].sort().join(', ')}, git with a subcommand that reads, and
"--version" from a language or package manager. Two of them may be joined with a pipe. Redirections, several
commands at once, backquotes and $(…) are refused, as is anything that runs code of its own — so this cannot change
the project, and the step that holds it is a step that changes nothing.

The copy holds the project's files and no .git, so git run here reports no repository, whatever the project itself is
kept in. For what the history says — git log, git show, git blame — use run_host_command in the project's folder on
the user's computer, which is where the repository is.

To read one file, or search the project, search_workspace, list_workspace and read_file do that better, and are not
bounded like this. To search, count or run git in a folder on the user's own computer, use run_host_command: this
tool cannot see that folder. For building, installing, running tests or anything that writes, use run_command, which
belongs to the step that makes the change.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The command to run: one of the reading programs, with its arguments, optionally piped into a second one.',
      },
    },
    required: ['command'],
  },
  async run(input, { signal, threadId }) {
    const given = (input as { command?: unknown } | null)?.command;
    if (typeof given !== 'string' || !given.trim()) {
      throw new Error('"command" must be a non-empty string.');
    }
    const why = refuse(given);
    if (why) throw new Error(why);
    const { code, output } = await docker.exec(threadId, given, { signal });
    return `exit code ${code}\n${output}`;
  },
};

export const tools: Tool[] = [tool];
