// Plain keyword search with ripgrep, for when the search by meaning doesn't
// answer: no Ollama running, or the embedding model not installed (see
// embeddings.ts). Keyword matches are a poor substitute for being asked what
// you mean, but they are better than telling a model its one way of finding
// anything is unavailable.
//
// It also answers the searches that name a regular expression, which the
// embeddings cannot: a vector says what a piece of code is about, and there is
// no vector of `handle(Request|Response)` that matches those two words and not
// everything else about handling. Those searches come here by choice rather
// than as a fallback (see ../tools/search.ts).
//
// Its keywords() is also what picks the line to show from inside a piece the
// embeddings found, so this file earns its place either way.

import { spawn } from 'child_process';
import * as docker from '../sandbox/docker';
import type { SearchOptions, SearchResult } from './results';
import { toolEnv } from './env';

const TIMEOUT_MS = 20000;
const MAX_LINE_LENGTH = 200;
// ripgrep's exit codes: 0 found something, 1 found nothing, and 2 or more is a
// failure — a pattern it won't parse, or a path that isn't there. Telling the
// last from the second is the point of reading the code at all: an empty
// answer and a broken query look exactly alike otherwise, and a model given
// "no matches" for a pattern ripgrep refused will believe it.
const FAILED = 2;
// Exit code of a shell that could not find the command, which inside a
// container means an image built before ripgrep was added to it
const NO_COMMAND = 127;
// Words that say nothing about what is being looked for
const STOP_WORDS = new Set(
  `a an and are as at be by do does for from how in is it of on or that the this
to what when where which who why with`.split(/\s+/)
);

// The words of a query worth looking for
export function keywords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
}

// Whether a pattern is a glob rather than a plain path. A plain path is given
// to ripgrep as the place to search; a glob is given to it as a filter.
const isGlob = (pattern: string) => /[*?[\]{}]/.test(pattern);

// What either search needs beyond the pattern: the limits, where to look, and
// whose copy of the files to look in.
export type Options = SearchOptions & {
  maxPerFile: number;
  // Where to search: one path or glob, or several, any of which may match
  path?: string | string[];
  // Paths or globs to leave out wherever they are
  exclude?: string[];
  // Whether a pattern matches whatever the case. A keyword search always
  // does, and a definition never does (see each of them below).
  ignoreCase?: boolean;
  // The thread whose container holds the copy to search. Left out, the user's
  // own copy of the workspace is searched instead.
  thread?: string;
};

// Where ripgrep is to look, and what it is to keep to there. Plain paths are
// given to it as the places to search, which is quickest and is what a single
// file needs. Once there is a glob among them everything goes in as a filter
// over the whole workspace instead, a plain path as itself and as everything
// under it: ripgrep searches a path it was handed outright whatever the
// filters say, so a mixed list cannot be given both ways at once.
function placesFor(path: Options['path']): { places: string[]; globs: string[] } {
  const paths = (Array.isArray(path) ? path : path ? [path] : []).filter(Boolean);
  if (paths.length === 0) return { places: ['.'], globs: [] };
  if (!paths.some(isGlob)) return { places: paths, globs: [] };
  return { places: ['.'], globs: paths.flatMap((one) => (isGlob(one) ? [one] : [one, `${one}/**`])) };
}

// What ripgrep said, wherever it ran: its matches, or why it refused
interface Ran {
  code: number;
  output: string;
  failed: string;
}

// ripgrep's arguments, which are the same wherever it runs. The pattern goes
// in under --regexp so that one beginning with "-" is still a pattern, and the
// place to search goes last.
//
// --with-filename is not the flourish it looks like. Given one file to search
// rather than a directory, ripgrep leaves the path off its matches the way
// grep does, and every row then fails the prefix that parse() reads them by:
// a search narrowed to one file matched everything and answered "No matches."
// Asking for the path always means the rows look the same however the place
// to search was written.
function argsFor(
  pattern: string,
  { maxPerFile, context, pathsOnly, path, exclude = [] }: Options,
  ignoreCase: boolean
): string[] {
  const { places, globs } = placesFor(path);
  // Only the paths wanted: ripgrep lists the files and reads no further into them
  const args = pathsOnly
    ? ['--files-with-matches']
    : ['--with-filename', '--line-number', '--no-heading', '--max-columns', String(MAX_LINE_LENGTH)];
  if (ignoreCase) args.push('--ignore-case');
  // The project's own .gitignore, which ripgrep reads only from inside a
  // repository: the copy this searches is filled from `git ls-files` and has
  // no .git (see ../sandbox/docker.ts), so without this the walk went through
  // the node_modules the project's install had put in the container and
  // answered with a dependency's declarations.
  args.push('--no-require-git');
  // For a project that keeps no .gitignore, unless pointed there on purpose
  if (!places.concat(globs).some((place) => place.includes('node_modules'))) args.push('--glob', '!node_modules');
  // The caller cuts the results to the limits as well; this saves ripgrep
  // reading on through a file whose matches are already more than are wanted
  if (!pathsOnly) args.push('--max-count', String(maxPerFile));
  if (!pathsOnly && context > 0) args.push('--context', String(context));
  for (const glob of globs) args.push('--glob', glob);
  for (const left of exclude) args.push('--glob', `!${left}`);
  args.push('--regexp', pattern, ...places);
  return args;
}

// ripgrep on the user's own copy of the workspace. Throws if it can't be run.
function onHost(workspace: string, args: string[], limit: number, signal: AbortSignal): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, {
      cwd: workspace,
      env: toolEnv(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let failed = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      // Far more than is ever shown
      if (output.length < limit * 2000) output += chunk;
    });
    // Why a pattern was refused, which is the whole of the answer when one is
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (failed.length < 400) failed += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error('ripgrep (rg) is not installed.') : err);
    });
    child.on('close', (code) => resolve({ code: code ?? 0, output, failed }));
  });
}

// ripgrep on the thread's own copy of the workspace, inside its container,
// which is what the thread has actually done: files it has written are there
// and ones it has deleted are gone. This is the copy the embeddings answer
// from as well (see embeddings.fill), so both backends see one set of files.
//
// Resolves with null when there is no container to search, or when the one
// there is predates ripgrep being put in the image: the caller falls back to
// the user's copy rather than failing, since a slightly stale answer beats no
// answer at all.
//
// Matches come back on stdout and complaints on stderr, and the two must not
// be mixed into each other, so only one of them is sent: which it is follows
// from the exit code.
async function inContainer(thread: string, args: string[], limit: number): Promise<Ran | null> {
  const command = [
    'ch_out=$(mktemp) || exit 1',
    'ch_err=$(mktemp) || exit 1',
    `rg ${args.map(docker.quote).join(' ')} >"$ch_out" 2>"$ch_err"`,
    'ch_code=$?',
    `if [ "$ch_code" -ge ${FAILED} ]; then cat "$ch_err"; else cat "$ch_out"; fi`,
    'rm -f "$ch_out" "$ch_err"',
    'exit "$ch_code"',
  ].join('\n');

  const result = await docker.read(thread, command);
  if (!result) return null;
  const code = result.code ?? 0;
  if (code === NO_COMMAND) return null;
  const said = result.data.toString('utf8');
  return code >= FAILED
    ? { code, output: '', failed: said.slice(0, 400) }
    : { code, output: said.slice(0, limit * 2000), failed: '' };
}

// ripgrep's output as a result: the matching lines grouped by the file they
// are in, in the order it reported them.
function parse(output: string, pathsOnly: boolean): SearchResult {
  const rows = output.split('\n').filter(Boolean);
  if (pathsOnly) {
    const paths = [...new Set(rows.map((row) => row.replace(/^\.\//, '')))];
    return { files: paths.map((path) => ({ path, blocks: [] })), indexed: 100 };
  }
  // With context lines, ripgrep separates a match from the lines around it
  // with "-" instead of ":", and separates runs of lines with "--"
  const files = new Map<string, { line: number; text: string }[][]>();
  let last: { path: string; line: number } | undefined;
  for (const row of rows) {
    const match = /^(?:\.\/)?(.+?)[:-](\d+)[:-](.*)$/.exec(row);
    if (!match) continue;
    const [, file, at, text] = match;
    const line = Number(at);
    const blocks = files.get(file) ?? [];
    // A line that carries on from the one before belongs to the same run
    if (last && last.path === file && line === last.line + 1) blocks.at(-1)?.push({ line, text: text.trim() });
    else blocks.push([{ line, text: text.trim() }]);
    files.set(file, blocks);
    last = { path: file, line };
  }
  return { files: [...files].map(([path, blocks]) => ({ path, blocks })), indexed: 100 };
}

// One search, in whichever copy of the files the options name. Throws if
// ripgrep can't be run, or if it refused the pattern.
async function run(
  workspace: string,
  pattern: string,
  options: Options,
  signal: AbortSignal,
  ignoreCase: boolean
): Promise<SearchResult> {
  const args = argsFor(pattern, options, ignoreCase);
  const { limit, pathsOnly, thread } = options;
  const ran = (thread && (await inContainer(thread, args, limit))) || (await onHost(workspace, args, limit, signal));
  if (ran.code >= FAILED) {
    const why = ran.failed.trim().replace(/\s+/g, ' ');
    throw new Error(why ? `ripgrep could not run the search: ${why}` : 'ripgrep could not run the search.');
  }
  return parse(ran.output, pathsOnly);
}

// Lines of the workspace's files that hold any of the query's keywords, by
// file. Files Git ignores are left out, which takes the project's own
// .gitignore and --no-require-git to arrange (see argsFor). `path`, when given, is a glob or a
// path under the workspace, and only what it covers is searched.
export function keywordSearch(
  workspace: string,
  query: string,
  options: Options,
  signal: AbortSignal
): Promise<SearchResult> {
  const words = keywords(query);
  if (words.length === 0) return Promise.resolve({ files: [], indexed: 100 });
  // Any of them, not all: a question's words are a guess at what the file says
  // and insisting on every one of them answers nothing
  return run(workspace, words.join('|'), options, signal, true);
}

// Lines of the workspace's files that match a regular expression, by file.
// The pattern goes to ripgrep as it was written: no keywords are taken out of
// it, and the search is case-sensitive unless ignoreCase says otherwise,
// because someone who writes "[A-Z]\w+Error" means the capital letters.
//
// The pattern is ripgrep's own, which is Rust's regex crate: it matches in
// time linear in the subject, so no pattern can hang the search, and in
// exchange it has no backreferences and no lookaround. One that uses them is
// refused, and the reason is passed back as it was given.
export function regexSearch(
  workspace: string,
  pattern: string,
  options: Options,
  signal: AbortSignal
): Promise<SearchResult> {
  return run(workspace, pattern, options, signal, options.ignoreCase === true);
}

// Where a name is defined, rather than everywhere it is used.
//
// This is the question the search by meaning is worst at, and it is one of the
// commonest a model asks: a vector says a piece is about `Thread` and cannot
// tell the line that declares it from the forty that use it. A plan names a
// symbol, the coders are sent to the file it is in, and the step that has to
// find it has nothing better than a guess at the words around it. One reply
// spent twenty-three rounds looking for `interface Thread`, which was in a
// file it had read twice.
//
// It is a pattern rather than a parse, so it is only as good as the way the
// code is written — but the way a definition is written is the one thing
// nearly every language agrees on: the kind of thing, then its name, at the
// start of a line. What that misses is a name that is only ever assigned to,
// and the search by meaning is still there for those (see ../tools/search.ts,
// which shows these above its results rather than instead of them).
const DECLARING = 'interface|type|class|enum|struct|trait|impl|namespace|module|function|func|fn|def|const|let|var|val';
// Words that may stand between the start of the line and the kind of thing
const BEFORE = '(?:export|default|declare|abstract|final|public|private|protected|static|readonly|async)\\s+';

export function definitionPattern(name: string): string {
  const named = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name has to end where it ends, so that `go` does not match `gone`.
  // Only where it ends in a word character, though: `$` is a letter to
  // JavaScript and not to a word boundary, so `go$\b` would match nothing at
  // all — which is worse than the longer name it was meant to rule out.
  const ends = /\w$/.test(name) ? '\\b' : '';
  return [
    // interface Thread, export async function run, pub const MAX
    `^\\s*(?:${BEFORE})*(?:${DECLARING})\\s+${named}${ends}`,
    // A method of a class or an object literal: `async run(input, ctx) {`.
    // The body has to open on the same line, which is what tells a definition
    // from a call: `run();` and `run({ a: 1 })` are not definitions of run,
    // and a pattern that took the name and a bracket for one would answer
    // "where is this defined" with the places it is used. The cost is a
    // signature too long for one line, which the keyword forms above catch
    // wherever it has a keyword.
    `^\\s*(?:(?:public|private|protected|static|async|get|set|override)\\s+)*${named}\\s*(?:<[^>]*>)?\\([^;]*\\{\\s*$`,
    // Given a function rather than declared as one: run = () =>, run: function
    `^\\s*${named}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|<)`,
    // Go's methods, whose receiver comes between the keyword and the name
    `^\\s*func\\s+\\([^)]*\\)\\s*${named}${ends}`,
  ].join('|');
}

// The lines that define the given name, by file. The name is matched as it
// was written: `thread` and `Thread` are two different things, and a search
// that ignored the difference would answer the wrong one.
export function definitionSearch(
  workspace: string,
  name: string,
  options: Options,
  signal: AbortSignal
): Promise<SearchResult> {
  return run(workspace, definitionPattern(name), options, signal, false);
}
