// Code search for threads that were started in a workspace: a tool that lets a
// model find the files a task needs, backed by our own embeddings of those
// files (see ../search/embeddings.ts).
//
// A search the embeddings do not answer falls back to plain keyword matches
// for that search only (see ../search/ripgrep.ts). The next one asks the
// embeddings again rather than writing the workspace off for a while: what
// stopped them answering is usually Ollama, and Ollama comes back.
//
// Two things a query says about itself are acted on rather than taken
// literally, because a model that has been searching for a while stops
// writing sentences:
//
// * A query written as a regular expression is matched as one. The flag for
//   that is in the schema below and it is not always reached for: one reply
//   sent `^type Thread = |interface Thread$` to be embedded, as prose, five
//   times over. Nothing answers that query by meaning, and the thing it was
//   looking for was one `regex: true` away.
// * A query that names something is also looked up as a definition, and those
//   lines are listed first (see ../search/ripgrep.ts). "Where is X defined" is
//   what the embeddings are worst at and what a step holding a plan asks most.
//
// Both are additions rather than substitutions: the search by meaning still
// answers underneath, and the answer says which of them it came from. A model
// that asked for one thing and was quietly given another has no way of telling.
//
// The point of the options is that a model should not have to run grep in its
// container to get a usable answer. What sends it there is output it can't
// control: too many matches, too much of each file, matches from everywhere
// when it only cared about one directory. So a search can say how much to
// return (max_results, max_per_file, context_lines), where to look (path,
// exclude), and whether it wants the lines at all (paths_only). Whatever the
// backend, the answer is cut to those limits here, so both behave the same
// way, and the answer says when the limits cut it: grep's answer is all there
// is, and an answer that might not be is one a model checks with grep.
//
// A week of threads ran grep through run_reading_command 277 times for what
// this tool is for, and only 32 of those greps would have come out the same
// if handed here as they were written. The rest wrote "or" as grep does
// (`a\|b`), named several files, named them under /workspace, or wanted every
// line a name is on rather than the lines a search by meaning picks out of
// what it found. Each of those is taken as it was meant below.

import { WORKDIR } from '../sandbox/docker';
import type { Tool } from '../types';
import * as embeddings from '../search/embeddings';
import { mergeBlocks, type SearchResult } from '../search/results';
import { definitionSearch, keywordSearch, keywords, regexSearch } from '../search/ripgrep';

const DEFAULT_RESULTS = 20;
const MAX_RESULTS = 100;
// Matching lines taken from any one file, so that one busy file doesn't crowd
// out the rest of the workspace
const DEFAULT_PER_FILE = 10;
// ...and both of those for a search matched against the text, which is
// asking for the lines a name or a pattern is on and is wanted whole: the
// greps this stands in for asked for forty lines as often as not
const PATTERN_RESULTS = 50;
const PATTERN_PER_FILE = 25;
const DEFAULT_CONTEXT = 1;
const MAX_CONTEXT = 5;
const MAX_OUTPUT = 20000; // characters of results kept
// Lines of definitions listed above a search that was not asked for them.
// Few, because they are an addition to an answer the model did ask for: a
// name is declared once or twice, and anything past that is a pattern
// matching more than it should.
const DECLARATION_LINES = 8;
// The most names one definition search will look up at once, and the least
// lines any one of them gets when the limit is shared out between them
const MOST_NAMES = 6;
const LEAST_PER_NAME = 2;
// Files a search by meaning has nothing to read: selectors, markup and
// configuration, where the words of the query are worth more than their
// meaning (see the search itself, below)
const NO_PROSE = /\.(?:css|scss|sass|less|html?|svg|json|ya?ml|toml|ini|conf|csv|lock)$/i;

interface Limits {
  limit: number;
  maxPerFile: number;
  context: number;
  pathsOnly: boolean;
  // Where to look, any of them, and where not to
  paths?: string[];
  exclude?: string[];
}

// Whether a pattern is a glob rather than a plain path
const isGlob = (pattern: string) => /[*?[\]{}]/.test(pattern);

// A path as the workspace has it. A model that has been running commands in
// its container writes /workspace/src/x.ts, and the files here are listed as
// src/x.ts: compared as written, the two never met, and a search by meaning
// narrowed that way answered with nothing at all.
export function relative(path: string): string {
  let clean = path.trim().replace(/^\.\//, '');
  if (clean === WORKDIR || clean === `${WORKDIR}/` || clean === '.') return '';
  if (clean.startsWith(`${WORKDIR}/`)) clean = clean.slice(WORKDIR.length + 1);
  return clean.replace(/^\.\//, '').replace(/\/+$/, '');
}

// The paths an option names: a list, or one string holding one or several,
// as they are written after grep — "src/main.ts src/preload.ts", or with
// commas. A comma inside braces is a glob's own ("*.{ts,css}") and stays.
// Undefined where it names nowhere, which is the whole workspace.
export function pathsIn(value: unknown, option: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const given = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(given) || given.some((one) => typeof one !== 'string')) {
    throw new Error(`"${option}" must be a path, a glob, or a list of them.`);
  }
  const paths = (given as string[])
    .flatMap((one) => one.match(/(?:\{[^{}]*\}|[^\s,{])+/g) ?? [])
    .map(relative)
    .filter(Boolean);
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

// grep's own way of writing a pattern, which is how most of them arrive: the
// greps run in the container wrote "or" as `\|` 219 times out of 277. To
// ripgrep, which answers patterns here, `\|` is a pipe character and nothing
// more, so the pattern matched nothing and the answer said so. In grep's
// dialect `\|`, `\(`, `\)`, `\{`, `\}`, `\+` and `\?` are the operators and
// the same characters bare are themselves, so the translation swaps the two
// over — which matters as much as the `\|` does, since `conversation(\|images`
// is a group ripgrep will not open.
//
// Only a pattern with a `\|` in it is taken for grep's: that is the one thing
// nobody writing ripgrep's dialect has a reason to put there. Bracketed
// classes are left as they are, being the same in both.
const GREP_OPERATORS = '(){}+?|';
export function fromGrep(pattern: string): string | undefined {
  if (!/(?<!\\)(?:\\\\)*\\\|/.test(pattern)) return undefined;
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (inClass) {
      out += ch;
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      out += ch;
      inClass = true;
      // A ] straight after the opening (or after its ^) is part of the class
      if (pattern[i + 1] === '^') out += pattern[++i];
      if (pattern[i + 1] === ']') out += pattern[++i];
    } else if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i];
      out += GREP_OPERATORS.includes(next) ? next : ch + next;
    } else {
      out += GREP_OPERATORS.includes(ch) ? `\\${ch}` : ch;
    }
  }
  return out;
}

// The strings a literal search looks for: the query cut at its |s, written
// either way round, or the query whole
export function literals(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/\\?\|/)
        .map((one) => one.trim())
        .filter(Boolean)
    ),
  ];
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What a regular expression has in it that a question does not. Each of these
// is something nobody writes by accident in a sentence, and a query with none
// of them is read as words however it is punctuated: `main.ts` and "e.g." are
// not patterns, and neither is anything with a bare `*` in it, which is as
// likely to be emphasis.
const PATTERNISH = [
  /\\[a-zA-Z]/, // \s, \w, \b: an escape that stands for something
  /\\[^a-zA-Z0-9\s]/, // \. \( \-: a character held off from being a pattern
  /^\s*\^/, // anchored to the start of a line
  /\$\s*$/, // ...or to the end of one
  /\|/, // either this or that
  /\.[*+?]/, // .* .+ .?
  /\[[^\]]+\]/, // a class of characters
  /\(\?/, // a group that is not a capture
  /[)\]][*+?]/, // a group or class, repeated
  /\{\d+(?:,\d*)?\}/, // {2}, {2,}, {2,5}
];

// Whether a query is a regular expression its author forgot to declare.
export const looksLikePattern = (query: string) => PATTERNISH.some((mark) => mark.test(query));

// The words that say a query is about where something is defined rather than
// about what the code does. "defined" and "declaration" are here as well as
// the keywords themselves: a model asks in both halves of the language.
const DECLARING = new RegExp(
  '\\b(?:interface|type|class|enum|struct|trait|namespace|module|function|func|fn|def|method|const|let|var' +
    '|definition|defined|defines|declaration|declared|declares|implementation|implemented)\\b',
  'i'
);
// Words that are never the name being asked about: the ones above, and the
// handful of English words that hold a question together (the fuller list is
// ripgrep's, which has the other job of choosing words to search for)
const NOT_A_NAME = new Set(
  `a an and are as at be by do does for from how in is it of on or that the this to what when where which who why with
  interface type class enum struct trait namespace module function func fn def method const let var definition defined
  defines declaration declared declares implementation implemented
  export default declare abstract final public private protected static readonly async`.split(/\s+/)
);
// A name that is a name rather than an English word: camelCase, snake_case,
// $-prefixed, SHOUTED, or Capitalised, which is how a type is written
const SHAPED_LIKE_A_NAME = /[a-z0-9].*[A-Z]|_|\$|^[A-Z0-9]+$|^[A-Z][a-z]/;
const NAMES = /[A-Za-z_$][\w$]*/g;
// The least a name can be, which is what keywords() asks of a word as well:
// shorter than this and a search for it would answer with everything
const SHORTEST_NAME = 3;

// The names a query is asking about, where it is asking about more than one.
// They come back in the order they were written, and only the words written
// like code count: that is what keeps a question made of ordinary words
// ("threads archiving sidebar") from being read as three names nobody
// declared.
//
// A model that wants five helpers at once writes them as a row, and the row
// is the question. "const open, const flush, const lastSaved, const changed"
// is one alternation to grep, and was either four searches here or one search
// about whichever of them symbolIn picked — which is the commonest reason a
// reply gave up on this tool and ran grep instead.

// The name a query is asking about, if it is asking about one.
//
// Three shapes count. A query that is one name is that name — "Thread", or
// "renderThreadList". A query with a declaring word in it gives the name
// beside it, which is how both "interface Thread" and "Thread interface" are
// written and how a model that has given up on sentences writes them: "Thread
// type definition interface class" was a real query, and `Thread` is what it
// wanted. Failing that, a query with a declaring word in it and exactly one
// word shaped like a name gives that one.
//
// Everything else gives nothing, which is the common case: "where are API
// keys stored" and "thread list sidebar display" are questions about what the
// code does, and the search by meaning is what they are for.
export function symbolIn(query: string): string | undefined {
  const words = query.match(NAMES) ?? [];
  const names = words.filter((word) => !NOT_A_NAME.has(word.toLowerCase()) && word.length >= SHORTEST_NAME);
  if (names.length === 0) return undefined;
  if (words.length === 1) return names[0];
  if (!DECLARING.test(query)) return undefined;
  // Every name beside a declaring word, each side of it, earliest written
  // first: a query names its subject before it says what kind of thing it is
  // looking for, however the two are ordered around the keyword.
  const beside: number[] = [];
  for (let at = 0; at < words.length; at++) {
    if (!DECLARING.test(words[at])) continue;
    for (const side of [at - 1, at + 1]) {
      if (words[side] && names.includes(words[side]) && !beside.includes(side)) beside.push(side);
    }
  }
  beside.sort((one, two) => one - two);
  // The one written like a name wins, whichever side of the declaring word it
  // was on. Position was the only test here and it is the wrong one: a model
  // writes "State interface" as often as "interface State", and the word on
  // the other side of the guess is usually a common English one. "State
  // interface threads activeId" looked up `threads`, "Message type role text"
  // looked up `role`, and both were then answered out of node_modules, where
  // a word like that is declared and the project's own name is not.
  const shaped = beside.map((at) => words[at]).filter((word) => SHAPED_LIKE_A_NAME.test(word));
  if (shaped.length > 0) return shaped[0];
  // Nothing beside a declaring word is written like a name. The query may
  // still be about one thing — "where is renderThreadList defined" has only
  // the one word it could mean — but a plain word picked off a position is a
  // guess, and a wrong guess answers confidently about something else.
  return nameFor(query);
}

// The name to look up when a definition was asked for outright and the query
// is not simply the name: the one word in it shaped like a name, or the one
// word in it at all. Where there is a choice, nothing — the note that goes
// back instead says which name to pass, and a wrong guess costs the same
// round as the note while also answering about the wrong thing.
export function namesIn(query: string, most = MOST_NAMES): string[] {
  const words = query.match(NAMES) ?? [];
  const couldBe = (word?: string) => !!word && !NOT_A_NAME.has(word.toLowerCase()) && word.length >= SHORTEST_NAME;
  // The words a declaring word beside them claims as names
  const claimed = new Set<number>();
  for (let at = 0; at < words.length; at++) {
    if (!DECLARING.test(words[at])) continue;
    for (const side of [at - 1, at + 1]) if (couldBe(words[side])) claimed.add(side);
  }
  // A word written like code is a name wherever it sits. A plain one is a name
  // only where a declaring word beside it says so, and that is the whole of
  // the difference between "const open, const flush, const changed", which is
  // three names, and "threads archiving sidebar", which is none.
  const names = words.filter((word, at) => couldBe(word) && (SHAPED_LIKE_A_NAME.test(word) || claimed.has(at)));
  return [...new Set(names)].slice(0, most);
}

// The likeliest single name in a query, as above.
export function nameFor(query: string): string | undefined {
  const names = (query.match(NAMES) ?? []).filter(
    (word) => !NOT_A_NAME.has(word.toLowerCase()) && word.length >= SHORTEST_NAME
  );
  const shaped = names.filter((word) => SHAPED_LIKE_A_NAME.test(word));
  if (shaped.length === 1) return shaped[0];
  return names.length === 1 ? names[0] : undefined;
}

// Matches a path against a glob: `*` within a path segment, `**` across them,
// `?` a single character, `{a,b}` either. A pattern with no glob characters is
// a path prefix, so "src/search" covers everything under it. One with no "/"
// matches at any depth, as the same pattern does in ripgrep.
export function pathFilter(pattern: string): (path: string) => boolean {
  const clean = relative(pattern);
  if (!clean) return () => true;
  if (!isGlob(clean)) return (path) => path === clean || path.startsWith(`${clean}/`);
  const source = clean
    .split(/(\*\*\/|\*\*|\*|\?|\{[^{}]*\})/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      if (part.startsWith('{')) {
        return `(?:${part
          .slice(1, -1)
          .split(',')
          .map((option) => option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})`;
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const anchored = new RegExp(clean.includes('/') ? `^${source}$` : `(?:^|/)${source}$`);
  return (path) => anchored.test(path);
}

// Whether a file is one a search was narrowed to: under any of the paths,
// where there are any, and under none of the ones left out
export function covers(paths: string[] = [], exclude: string[] = []): (path: string) => boolean {
  const wanted = paths.map(pathFilter);
  const unwanted = exclude.map(pathFilter);
  return (path) => (wanted.length === 0 || wanted.some((test) => test(path))) && !unwanted.some((test) => test(path));
}

// What the answer says about itself. A search that ran a different search
// than the words asked for has to say so in the answer: the model cannot see
// which of them ran, and one that is not told takes what it got for what it
// asked for — an empty answer for "nothing is there" rather than "that was
// read as a pattern".
const DECLARES = (name: string, pathsOnly: boolean) =>
  pathsOnly ? `Defined in — the files that declare \`${name}\`:` : `Defined here — the lines that declare \`${name}\`:`;
const BY_MEANING = 'Everywhere it comes up, by meaning:';
const AS_PATTERN = (ordered: boolean) =>
  'Note: that query reads as a regular expression, so it was matched against the text of the files rather than ' +
  'searched for by meaning.' +
  (ordered ? ' The files are in the order the words in it mean, likest first.' : '') +
  ' Pass regex: false to search by meaning instead.';
const PATTERN_MISSED =
  'Note: that query reads as a regular expression, and nothing in the files matches it as one, so these are ' +
  'matches by meaning for the words in it. Pass regex: true to see that for yourself, or ask in plain words.';
// A pattern with no words in it: `\d+|\s{2,}` says nothing to a search by
// meaning, and embedding the syntax itself answers with whatever that
// punctuation happens to sit near. Better to stop and say so.
const NO_WORDS = (query: string) =>
  `There are no words in "${query}" to search for by meaning either — it is syntax and nothing else — so there is ` +
  'nothing further to show. Name what you are looking for, or try the pattern another way.';
const PATTERN_REFUSED = (err: Error) =>
  `Note: that query reads as a regular expression, and it could not be run as one (${err.message}), so these are ` +
  'matches by meaning instead.';
// A pattern that was asked for outright and matched nothing. "No matches." is
// the one answer that cannot be told apart from "that is not in this
// project", and it is what regex: true gives back most often: the flag reads
// as "match the words rather than their meaning", so what arrives is a row of
// words, which is a valid pattern that matches only itself, spaces and all.
const PATTERN_EMPTY =
  'Note: nothing in the files matches that query as a regular expression, which is what regex: true asked for — a ' +
  'row of words is a pattern matching those words in that order, with the spaces. These are matches by meaning for ' +
  'the words in it instead. Leave regex off to search by meaning, which is what a query written in words wants.';
// Where the words of the query answered for a file with no prose in it
const BY_WORD = (path: string) =>
  `Note: ${path} holds no prose for a search by meaning to read, so these are its lines holding the words of the ` +
  'query.';
const NOTHING_DECLARED = (name: string) =>
  `Note: nothing in the files declares \`${name}\`: no type, interface, class, function, method or variable of that ` +
  'name begins a line. It may be spelled differently, or be a name that is only ever assigned to, which this ' +
  'cannot see. These are matches by meaning instead.';
const quoted = (names: string[]) => names.map((name) => `\`${name}\``).join(' or ');
// Several names were asked about and some of them are declared nowhere. They
// are named rather than left out: an answer one heading short otherwise reads
// as a name this missed rather than a name that is not there.
const NOT_DECLARED = (names: string[]) =>
  `Nothing in the files declares ${quoted(names)}, so ${names.length === 1 ? 'it has' : 'they have'} no lines above.`;
const NONE_DECLARED = (names: string[]) =>
  `Note: nothing in the files declares ${quoted(names)}: no type, interface, class, function, method or variable of ` +
  'those names begins a line. They may be spelled differently, or be names that are only ever assigned to, which ' +
  'this cannot see. These are matches by meaning instead.';
const FROM_GREP = (pattern: string) =>
  `Note: that pattern is written the way grep writes one, with \`\\|\` for "or", so it was matched as ripgrep ` +
  `writes it: \`${pattern}\`.`;
// A single string with a space in it is more likely several names written as
// a row than one phrase, so the answer says how several are given
const ONE_STRING = ' (one string: give several separated by |)';
const NOT_CONTAINED = (strings: string[], paths?: string[]) => {
  const where = paths ? paths.join(', ') : 'the files';
  const what = strings.map((one) => JSON.stringify(one)).join(' or ');
  const hint = strings.length === 1 && /\s/.test(strings[0]) ? ONE_STRING : '';
  return `No line in ${where} contains ${what}, as written${hint}.`;
};
// What the limits left out. "At least", because ripgrep is told to stop one
// line past max_per_file in each file: enough to know there is more, which is
// all the model needs to decide whether to ask for it.
const CUT = ({ items, files }: { items: number; files: number }, { limit, maxPerFile, pathsOnly }: Limits) =>
  pathsOnly
    ? `Note: more files matched than are listed — at least ${items} further, left out by max_results (${limit}). ` +
      'Raise it, or narrow the search with path, to see the rest.'
    : `Note: more matched than is shown — at least ${items} further ${items === 1 ? 'line' : 'lines'} in ${files} ` +
      `${files === 1 ? 'file was' : 'files were'} left out by max_results (${limit}) and max_per_file ` +
      `(${maxPerFile}). Raise them, or narrow the search with path, to see the rest.`;
const NO_NAME = (query: string) =>
  `Note: a definition was asked for, but "${query}" does not name one thing to look for — give the name on its own ` +
  '("Thread", "renderThreadList"). These are matches by meaning instead.';

// Cuts a result down to what was asked for. Both backends go through this, so
// a limit means the same thing whichever answered.
export function trim(result: SearchResult, { limit, maxPerFile, paths, exclude, pathsOnly }: Limits): SearchResult {
  const wanted = covers(paths, exclude);
  const files = result.files.filter((file) => wanted(file.path));
  if (pathsOnly) {
    const left = files.length - limit;
    return { ...result, files: files.slice(0, limit), ...(left > 0 && { cut: { items: left, files: left } }) };
  }

  const kept: typeof files = [];
  let taken = 0;
  // What is left out is counted rather than only dropped, so that the answer
  // can say it is not the whole of what matched
  let cutLines = 0;
  let cutFiles = 0;
  for (const file of files) {
    const blocks: (typeof file.blocks)[number][] = [];
    let fromFile = 0;
    // Overlapping runs are joined before anything is counted, so that lines
    // shown twice do not use up the limits twice over
    const merged = mergeBlocks(file.blocks);
    const all = merged.reduce((sum, block) => sum + block.length, 0);
    for (const block of merged) {
      if (fromFile >= maxPerFile || taken >= limit) break;
      const room = Math.min(maxPerFile - fromFile, limit - taken);
      const lines = block.slice(0, room);
      if (lines.length === 0) break;
      blocks.push(lines);
      fromFile += lines.length;
      taken += lines.length;
    }
    if (fromFile < all) {
      cutLines += all - fromFile;
      cutFiles++;
    }
    if (blocks.length > 0) kept.push({ ...file, blocks });
  }
  return { ...result, files: kept, ...(cutLines > 0 && { cut: { items: cutLines, files: cutFiles } }) };
}

function format({ files, indexed, unread = 0, cut }: SearchResult, limits: Limits): string {
  const { pathsOnly } = limits;
  // Pieces were found and their lines could not be read. "No matches." would
  // be a lie that costs the model the rest of its search: it goes looking
  // somewhere else for what this found and could not show. Say what happened,
  // so that it reads the files itself or asks again.
  if (files.length === 0 && unread > 0) {
    return `${unread} ${unread === 1 ? 'piece' : 'pieces'} of code matched, but ${
      unread === 1 ? 'its lines' : 'their lines'
    } could not be read from this thread's copy of the files, so there is nothing to show here. The files may have
changed since they were indexed. Read the files you expected this to be in, or search again.`;
  }
  if (files.length === 0 && indexed >= 100) return 'No matches.';
  // Only the paths were asked for, so that is all that is listed
  const sections = pathsOnly
    ? files.map(({ path }) => path)
    : files.map(({ path, blocks }) => {
        const runs = blocks.map((lines) => lines.map(({ line, text }) => `  ${line}: ${text}`).join('\n'));
        return [path, runs.join('\n  …\n')].join('\n');
      });
  let output = sections.join(pathsOnly ? '\n' : '\n\n') || 'No matches yet.';
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[results truncated]`;
  if (cut) output += `\n\n${CUT(cut, limits)}`;
  if (indexed < 100) {
    output += `\n\nNote: the workspace is still being indexed (about ${Math.round(indexed)}% done), so results may be
incomplete. Searching again later will find more.`;
  }
  // Some of what matched is shown and the rest could not be read: said so
  // that what is missing is known to be missing rather than taken for all
  // there was
  if (unread > 0) {
    output += `\n\nNote: ${unread} further ${unread === 1 ? 'piece' : 'pieces'} of code matched, but could not be
read from this thread's copy of the files and so are not shown.`;
  }
  return output;
}

// A number the model gave, within the bounds this tool allows. Anything that
// isn't a number, or is below the least this option can be, falls back to the
// default rather than being rounded up to it: a nonsense limit is more likely
// a mistake than a request for the smallest possible answer.
function bounded(value: unknown, fallback: number, max: number, min = 1): number {
  const asked = Number(value);
  if (!Number.isFinite(asked) || asked < min) return fallback;
  return Math.min(Math.round(asked), max);
}

export const tools: Tool[] = [
  {
    name: 'search_workspace',
    needsWorkspace: true,
    description: `Search the workspace this thread was started in. Use it instead of running grep, rg or find
yourself: it does what they do, and more.

It answers three kinds of question:
- What the code does, by meaning: describe it in plain words ("where are API keys stored"). This finds the pieces of
code likest the query and shows the line of each that the query's words fit best. It is not a list of every line a
word is on.
- Every line a name or a string is on, as grep does: set literal and give the text, or several separated by |
("turnOf|request.asked|'done'"). Every occurrence comes back, which is the answer to "where is this used" and the
search to make before renaming or removing something.
- Where something is defined: set definition and give its name.
A regular expression is matched with regex, and one written as grep writes it (\`a\\|b\`) is read as grep means it.

Returns the matching lines with their line numbers, grouped by file. Paths are relative to the workspace, and the same
files are in ${WORKDIR} in this thread's container (a path written under ${WORKDIR} is understood too). The search
covers the workspace as this thread has it, so files you have written or changed in the container are included, and
ones you have deleted are gone.

Start wide with paths_only to see which files are involved, then search again inside the ones you care about with
path, or read them. When the limits leave matches out, the answer says how many: raise max_results or max_per_file
to see them, rather than searching again some other way.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `What to look for: a description of it in plain words, keywords, or a regular expression when
regex is true.`,
        },
        regex: {
          type: 'boolean',
          description: `Treat the query as a regular expression and match it against the text of the files, instead of
searching by meaning. Use it when you know how the code is written and want exactly that ("await\\s+fetch\\(",
"TODO|FIXME"); leave it off when you are describing what you are looking for. Case-sensitive unless ignore_case is
set, and the syntax is ripgrep's: | for "or", no backreferences and no lookaround. A pattern in grep's own syntax, with
\\| for "or", is translated, and the answer says so.

This is not the flag for searching for names or words: a row of words is a pattern that matches those words in that
order, spaces and all, and matches nothing. For every line a name is on, use literal. Where a pattern matches nothing,
the words in it are searched for by meaning and the answer says so, so nothing is lost by a query that was not a
pattern after all.

A query that is plainly a pattern is matched as one whether or not this is set, and the answer says so. Set it to
false to insist on searching by meaning.`,
        },
        definition: {
          type: 'boolean',
          description: `Look for where the query's name is defined rather than everywhere it appears: the lines that
declare it as a type, interface, class, function, method, constant or variable. Give the name on its own
("Thread", "renderThreadList"). Use it as the first search whenever you need the place a thing lives — it is one
call where searching for the words around it is many, and a search by meaning cannot tell a declaration from a use.

Several names at once is one call too: give them as the query ("open flush lastSaved changed") and each comes back
under its own heading, with the ones that are declared nowhere named as such. That is the call to make instead of a
grep for a row of names.

Definitions are listed above the other matches when the query names something, so you have them without asking;
setting this asks for them alone.`,
        },
        literal: {
          type: 'boolean',
          description: `List every line that contains the query exactly as written — no pattern, no meaning — as grep -F
does. Give several strings separated by | ("hasTools|readByUser") to find any of them in one call. Use it for "where
is this used", for checking every caller before a change, and for anything you would otherwise grep for. Where
nothing contains it, the answer says so plainly.`,
        },
        ignore_case: {
          type: 'boolean',
          description: 'Match whatever the case, as grep -i does. For literal and regex searches.',
        },
        max_results: {
          type: 'number',
          description: `Roughly how many matching lines to return, at most ${MAX_RESULTS}. Defaults to
${DEFAULT_RESULTS} for a search by meaning and ${PATTERN_RESULTS} for a literal or regex one.`,
        },
        max_per_file: {
          type: 'number',
          description: `How many matching lines to return from any one file, so a single busy file cannot fill the
answer. Defaults to ${DEFAULT_PER_FILE} for a search by meaning and ${PATTERN_PER_FILE} for a literal or regex one.`,
        },
        context_lines: {
          type: 'number',
          description: `How many lines to show either side of each match, up to ${MAX_CONTEXT}. Defaults to
${DEFAULT_CONTEXT}; use 0 for the matching lines alone, which is the smallest answer that still shows the code.`,
        },
        paths_only: {
          type: 'boolean',
          description: `Return only the paths of the files that match, with none of their lines. Much the smallest
answer; use
it to find where to look before asking for lines.`,
        },
        // Strings in the schema, which every provider takes, and lists as well
        // when they arrive (see pathsIn)
        path: {
          type: 'string',
          description: `Only search here: a directory ("src/search"), a file, or a glob ("*.ts", "src/**/*.test.ts"),
or several of them separated by spaces ("src/main.ts src/preload.ts"). A pattern with no "/" matches at any depth.`,
        },
        exclude: {
          type: 'string',
          description: `Leave these out: directories, files or globs written as path takes them ("src/llm/providers",
"**/*.test.ts"). What grep -v on a path would do after a search.`,
        },
      },
      required: ['query'],
    },
    async run(input, { signal, threadId, workspace }) {
      const query = input?.query;
      if (typeof query !== 'string' || !query.trim()) {
        throw new Error('"query" must be a non-empty string.');
      }
      if (!threadId || !workspace) throw new Error('This thread has no workspace to search.');
      const paths = pathsIn(input.path, 'path');
      const exclude = pathsIn(input.exclude, 'exclude');
      const pathsOnly = input.paths_only === true;
      const literal = input.literal === true;
      const askedForPattern = !literal && input.regex === true;
      // Whether the text of the files is what answers, which wants more of
      // it by default than a search by meaning does
      const byText = literal || askedForPattern || (input.regex !== false && looksLikePattern(query));
      const limits: Limits = {
        limit: bounded(input.max_results, byText ? PATTERN_RESULTS : DEFAULT_RESULTS, MAX_RESULTS),
        maxPerFile: bounded(input.max_per_file, byText ? PATTERN_PER_FILE : DEFAULT_PER_FILE, MAX_RESULTS),
        context: pathsOnly ? 0 : bounded(input.context_lines, DEFAULT_CONTEXT, MAX_CONTEXT, 0),
        pathsOnly,
        paths,
        exclude,
      };
      // The embeddings narrow by path themselves, given the same test that
      // trims the result (see embeddings.rank). They used to be asked for
      // five times the pieces instead, and to read every one of them from the
      // container before the path threw most of them away.
      //
      // The thread is given so that whatever answers reads the thread's own
      // copy of the files: the embeddings already do (see embeddings.fill),
      // and ripgrep is run inside the container for the same reason.
      //
      // ripgrep is asked for one line more from each file than will be shown,
      // so that a file cut short by max_per_file is known to have been (see
      // trim). The paths go to it as the place to search and the embeddings
      // as a test, as `path` and `keep`.
      const asked = {
        limit: limits.limit,
        maxPerFile: limits.maxPerFile + 1,
        context: limits.context,
        pathsOnly,
        path: paths,
        exclude,
        ignoreCase: input.ignore_case === true,
        thread: threadId,
        keep: paths || exclude ? covers(paths, exclude) : undefined,
      };

      const shownAs = (result: SearchResult, over: Partial<Limits> = {}) =>
        format(trim(result, { ...limits, ...over }), { ...limits, ...over });
      const shown = (result: SearchResult) => shownAs(result);

      // Every line holding the text as written, and nothing else: no
      // definitions above it, since they are among the lines it lists, and
      // no search by meaning under an empty one, since "nothing contains it"
      // is the answer to what was asked
      if (literal) {
        const strings = literals(query);
        const found = await regexSearch(workspace, strings.map(escaped).join('|'), asked, signal);
        return found.files.length > 0 ? shown(found) : NOT_CONTAINED(strings, paths);
      }

      // What goes above the answer: the definitions of the name the query is
      // about, and a note wherever this search was not the one asked for
      const sections: string[] = [];
      const notes: string[] = [];
      const wants = input.definition === true;

      // The names a definition was asked for, where the query asks about
      // several. Each is looked up and each gets its own heading: one search
      // answers what was four, or what was one search about whichever of them
      // this picked (see namesIn).
      const several = wants ? namesIn(query) : [];
      if (several.length > 1) {
        // The limit is shared out, so that asking about six names cannot
        // return six times what asking about one does
        const each = Math.max(LEAST_PER_NAME, Math.floor(limits.limit / several.length));
        const over = { limit: each, maxPerFile: Math.min(limits.maxPerFile, each) };
        const looked = await Promise.all(
          several.map(async (name) => ({
            name,
            // A pattern that would not run is not this search's failure, and
            // the search by meaning below is still an answer
            found: await definitionSearch(workspace, name, { ...asked, ...over }, signal).catch(() => undefined),
          }))
        );
        const declared = looked.filter((one) => one.found && one.found.files.length > 0);
        const missing = looked.filter((one) => !declared.includes(one)).map((one) => one.name);
        if (declared.length > 0) {
          // Asked for and found: that is the answer, and nothing else was
          // wanted. The names that are declared nowhere are said to be, so
          // that an answer short of a heading is not read as a name missed.
          for (const { name, found } of declared) {
            sections.push(`${DECLARES(name, pathsOnly)}\n\n${shownAs(found!, over)}`);
          }
          if (missing.length > 0) sections.push(NOT_DECLARED(missing));
          return sections.join('\n\n');
        }
        notes.push(NONE_DECLARED(missing));
      } else {
        // The name the query is about, read off the query itself (see
        // symbolIn), or, where a definition was asked for outright, the
        // likeliest name in it
        const wanted = symbolIn(query) ?? (wants ? nameFor(query) : undefined);
        if (wanted) {
          // Only what was asked for when it was asked for; otherwise a few
          // lines in front of an answer to a different question
          const room = wants ? asked : { ...asked, limit: DECLARATION_LINES, maxPerFile: DECLARATION_LINES };
          // A pattern that would not run is not this search's failure, and the
          // search by meaning below is still an answer
          const declared = await definitionSearch(workspace, wanted, room, signal).catch(() => undefined);
          if (declared && declared.files.length > 0) {
            // Asked for and found: that is the answer, and nothing else was wanted
            if (wants) return `${DECLARES(wanted, pathsOnly)}\n\n${shown(declared)}`;
            sections.push(`${DECLARES(wanted, pathsOnly)}\n\n${shown(declared)}`);
          } else if (wants) notes.push(NOTHING_DECLARED(wanted));
        } else if (wants) notes.push(NO_NAME(query));
      }

      // What the search by meaning is asked. A pattern is given to it as the
      // words in it and not as itself: `^type Thread = |interface Thread$`
      // embeds as the punctuation it is made of, which is how a query that
      // was nearly right came back with nothing to do with Thread. Its
      // keywords are `type thread interface`, which is what it was asking
      // (see ../search/ripgrep.ts, where the same words pick the line to show).
      let meaning = query;

      // The matching files in the order the query means, likest first.
      // ripgrep returns them in the order it walked the directory, so a
      // pattern that matches more than the limit is otherwise cut down by
      // where the files sit on disk. Only the order comes from the meaning:
      // the lines are the pattern's own.
      const ranked = async (found: SearchResult, by: string) => {
        const matched = found.files.map(({ path }) => path);
        if (!by || matched.length < 2) return { files: found.files, ordered: false };
        const order = await embeddings
          .order({ workspace, thread: threadId }, by, matched, signal)
          .catch((err: unknown) => {
            if (signal.aborted) throw err;
            return undefined; // No Ollama: the pattern's own order is still an answer
          });
        if (!order) return { files: found.files, ordered: false };
        const at = new Map(order.map((path, place) => [path, place]));
        const files = [...found.files].sort((a, b) => (at.get(a.path) ?? 0) - (at.get(b.path) ?? 0));
        return { files, ordered: true };
      };

      // A query written as a pattern is matched as one, whether or not the
      // flag was set: what nobody writes in a question by accident, nothing
      // answers by meaning either. The answer says which question it is
      // answering, both ways round — a note is the only way the model can
      // tell, and one that cannot tell will trust what it gets.
      //
      // Asked for outright and worked out from the query share this one path
      // on purpose. They were two, and the one a model actually takes —
      // regex: true, set in the call — was the one with no way back: it
      // returned ripgrep's answer whatever it was, so a query that matched
      // nothing came back "No matches.", which reads as "that is not in this
      // project". The flag reads as "match the words rather than their
      // meaning", so a row of words is what it is given, and a row of words
      // is a pattern that matches only itself. The path that guessed had the
      // fallback all along; the path that was asked had none.
      if (byText) {
        const words = keywords(query);
        // A pattern in grep's dialect is put into ripgrep's, and the answer
        // says so whichever way it goes, so that the model sees the form
        // that works (see fromGrep)
        const translated = fromGrep(query);
        if (translated) notes.push(FROM_GREP(translated));
        const tried = await regexSearch(workspace, translated ?? query, asked, signal).catch((err: unknown) => {
          if (signal.aborted) throw err;
          // A pattern this model wrote and asked for is its own to fix, and
          // the reason is the answer: it goes back as a failure rather than
          // under matches for something else. One this tool decided was a
          // pattern is not the model's mistake, and is noted instead (see
          // PATTERN_REFUSED).
          if (askedForPattern) throw err;
          return err as Error;
        });
        if (!(tried instanceof Error) && tried.files.length > 0) {
          // Asked for outright, so it is answered as asked: the pattern's own
          // matches in the pattern's own order, with nothing said about how
          // the query was read beyond its translation, if it had one
          if (askedForPattern) return [...sections, ...notes, shown(tried)].join('\n\n');
          const { files, ordered } = await ranked(tried, words.join(' '));
          return [...sections, ...notes, AS_PATTERN(ordered), shown({ ...tried, files })].join('\n\n');
        }
        notes.push(tried instanceof Error ? PATTERN_REFUSED(tried) : askedForPattern ? PATTERN_EMPTY : PATTERN_MISSED);
        // Nothing matched it and there is nothing in it to search for
        if (words.length === 0) return [...sections, ...notes, NO_WORDS(query)].join('\n\n');
        meaning = words.join(' ');
      }

      // The answer the query asked for, with whatever was found above it. The
      // heading is only wanted where nothing else has already said what these
      // matches are: every note ends by saying it.
      const under = (found: SearchResult, said: string[] = []) => {
        const saidAlready = notes.length > 0 || said.length > 0;
        const label = sections.length > 0 && !saidAlready ? [BY_MEANING] : [];
        return [...sections, ...notes, ...said, ...label, shown(found)].join('\n\n');
      };
      // A file with nothing in it to read by meaning is answered by the words
      // of the query instead. styles.css is 61 KB of selectors cut into
      // pieces at its braces, and every piece means much the same thing —
      // some selector, some properties — so a query naming the selectors it
      // wanted came back with the end of the file. index.html went the same
      // way twice over: asked for `id="composer"`, `id="input"` and
      // `id="send"`, which are three consecutive lines of it, it answered
      // with `</body></html>`. Those same words as words land on the markup.
      //
      // The search by meaning still answers underneath, so a query that
      // describes what it wants rather than naming it is no worse off here
      // than it was.
      if (paths && paths.every((one) => NO_PROSE.test(one))) {
        const byWord = await keywordSearch(workspace, meaning, asked, signal).catch(() => undefined);
        if (byWord && byWord.files.length > 0) return under(byWord, [BY_WORD(paths.join(', '))]);
      }

      // A pattern that fell through to here was given a pattern's limits,
      // which is more pieces than a search by meaning is worth reading unless
      // they were asked for
      const forMeaning = byText && input.max_results === undefined ? { ...asked, limit: DEFAULT_RESULTS } : asked;
      try {
        // The thread's own copy of the workspace's embeddings, brought in step
        // with what it has done in its container before the query is asked
        return under(await embeddings.search({ workspace, thread: threadId }, meaning, forMeaning, signal));
      } catch (err) {
        if (signal.aborted) throw err;
        // The embeddings didn't answer — no Ollama, or no embedding model.
        // Plain keyword matches are better than nothing, for this search
        // alone; the next one asks the embeddings again. If keyword matches
        // can't be had either, it is the first failure that is reported,
        // since that is the one worth fixing.
        const found = await keywordSearch(workspace, meaning, asked, signal).catch(() => {
          throw err;
        });
        return under(found, [
          `Note: the search by meaning did not answer (${(err as Error).message}), so these are plain keyword matches
for: ${keywords(meaning).join(', ') || 'nothing'}.`,
        ]);
      }
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}
