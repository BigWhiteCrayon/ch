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
// return (max_results, max_per_file, context_lines), where to look (path),
// and whether it wants the lines at all (paths_only). Whatever the backend,
// the answer is cut to those limits here, so both behave the same way.

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
const DEFAULT_CONTEXT = 1;
const MAX_CONTEXT = 5;
const MAX_OUTPUT = 20000; // characters of results kept
// Lines of definitions listed above a search that was not asked for them.
// Few, because they are an addition to an answer the model did ask for: a
// name is declared once or twice, and anything past that is a pattern
// matching more than it should.
const DECLARATION_LINES = 8;

interface Limits {
  limit: number;
  maxPerFile: number;
  context: number;
  pathsOnly: boolean;
  path?: string;
}

// Whether a pattern is a glob rather than a plain path
const isGlob = (pattern: string) => /[*?[\]{}]/.test(pattern);

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
  defines declaration declared declares implementation implemented`.split(/\s+/)
);
// A name that is a name rather than an English word: camelCase, snake_case,
// $-prefixed, SHOUTED, or Capitalised, which is how a type is written
const SHAPED_LIKE_A_NAME = /[a-z0-9].*[A-Z]|_|\$|^[A-Z0-9]+$|^[A-Z][a-z]/;
const NAMES = /[A-Za-z_$][\w$]*/g;
// The least a name can be, which is what keywords() asks of a word as well:
// shorter than this and a search for it would answer with everything
const SHORTEST_NAME = 3;

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
  // Beside a declaring word, after it first: "type Thread" is the way round
  // the code itself is written
  for (let at = 0; at < words.length; at++) {
    if (!DECLARING.test(words[at])) continue;
    const beside = [words[at + 1], words[at - 1]].find((word) => word && names.includes(word));
    if (beside) return beside;
  }
  return nameFor(query);
}

// The name to look up when a definition was asked for outright and the query
// is not simply the name: the one word in it shaped like a name, or the one
// word in it at all. Where there is a choice, nothing — the note that goes
// back instead says which name to pass, and a wrong guess costs the same
// round as the note while also answering about the wrong thing.
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
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
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
const NOTHING_DECLARED = (name: string) =>
  `Note: nothing in the files declares \`${name}\`: no type, interface, class, function, method or variable of that ` +
  'name begins a line. It may be spelled differently, or be a name that is only ever assigned to, which this ' +
  'cannot see. These are matches by meaning instead.';
const NO_NAME = (query: string) =>
  `Note: a definition was asked for, but "${query}" does not name one thing to look for — give the name on its own ` +
  '("Thread", "renderThreadList"). These are matches by meaning instead.';

// Cuts a result down to what was asked for. Both backends go through this, so
// a limit means the same thing whichever answered.
export function trim(result: SearchResult, { limit, maxPerFile, path, pathsOnly }: Limits): SearchResult {
  const wanted = path ? pathFilter(path) : () => true;
  let files = result.files.filter((file) => wanted(file.path));
  if (pathsOnly) return { ...result, files: files.slice(0, limit) };

  const kept: typeof files = [];
  let taken = 0;
  for (const file of files) {
    if (taken >= limit) break;
    const blocks: (typeof file.blocks)[number][] = [];
    let fromFile = 0;
    // Overlapping runs are joined before anything is counted, so that lines
    // shown twice do not use up the limits twice over
    for (const block of mergeBlocks(file.blocks)) {
      if (fromFile >= maxPerFile || taken >= limit) break;
      const room = Math.min(maxPerFile - fromFile, limit - taken);
      const lines = block.slice(0, room);
      if (lines.length === 0) break;
      blocks.push(lines);
      fromFile += lines.length;
      taken += lines.length;
    }
    if (blocks.length > 0) kept.push({ ...file, blocks });
  }
  return { ...result, files: kept };
}

function format({ files, indexed, unread = 0 }: SearchResult, pathsOnly: boolean): string {
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
    description: `Search the workspace this thread was started in. Use it to find which files matter for a task before
reading them. Prefer it to running grep, rg or find yourself: it searches by meaning as well as by text, so a query
can describe what you are looking for ("where are API keys stored") as well as name it, and the options below keep the
answer to the size you want.

Returns the matching lines with their line numbers, grouped by file. Paths are relative to the workspace, and the same
files are in ${WORKDIR} in this thread's container. The search covers the workspace as this thread has it, so files
you
have written or changed in the container are included, and ones you have deleted are gone.

To find where something is defined rather than where it is used, give its name as the query and set definition: it
matches the lines that declare it, which is what "where does this type live" is asking and the one thing a search by
meaning cannot tell you.

Start wide with paths_only to see which files are involved, then search again inside the one you care about with
path, or read it. If a search returns more than you can use, say so with max_results or max_per_file rather than
reading past it.`,
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
"TODO|FIXME"); leave it off when you are describing what you are looking for. Case-sensitive, and the syntax is
ripgrep's: no backreferences and no lookaround.

A query that is plainly a pattern is matched as one whether or not this is set, and the answer says so. Set it to
false to insist on searching by meaning.`,
        },
        definition: {
          type: 'boolean',
          description: `Look for where the query's name is defined rather than everywhere it appears: the lines that
declare it as a type, interface, class, function, method, constant or variable. Give the name on its own
("Thread", "renderThreadList"). Use it as the first search whenever you need the place a thing lives — it is one
call where searching for the words around it is many, and a search by meaning cannot tell a declaration from a use.

Definitions are listed above the other matches when the query names something, so you have them without asking;
setting this asks for them alone.`,
        },
        max_results: {
          type: 'number',
          description: `Roughly how many matching lines to return, at most ${MAX_RESULTS}. Defaults to
${DEFAULT_RESULTS}.`,
        },
        max_per_file: {
          type: 'number',
          description: `How many matching lines to return from any one file, so a single busy file cannot fill the
answer. Defaults to ${DEFAULT_PER_FILE}.`,
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
        path: {
          type: 'string',
          description: `Only search here: a directory ("src/search"), a file, or a glob ("*.ts", "src/**/*.test.ts").
A pattern
with no "/" matches at any depth.`,
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
      if (input.path !== undefined && typeof input.path !== 'string') {
        throw new Error('"path" must be a string.');
      }
      const pathsOnly = input.paths_only === true;
      const limits: Limits = {
        limit: bounded(input.max_results, DEFAULT_RESULTS, MAX_RESULTS),
        maxPerFile: bounded(input.max_per_file, DEFAULT_PER_FILE, MAX_RESULTS),
        context: pathsOnly ? 0 : bounded(input.context_lines, DEFAULT_CONTEXT, MAX_CONTEXT, 0),
        pathsOnly,
        path: input.path?.trim() || undefined,
      };
      // The embeddings narrow by path themselves, given the same test that
      // trims the result (see embeddings.rank). They used to be asked for
      // five times the pieces instead, and to read every one of them from the
      // container before the path threw most of them away.
      //
      // The thread is given so that whatever answers reads the thread's own
      // copy of the files: the embeddings already do (see embeddings.fill),
      // and ripgrep is run inside the container for the same reason.
      const asked = { ...limits, thread: threadId, keep: limits.path ? pathFilter(limits.path) : undefined };

      const shown = (result: SearchResult) => format(trim(result, limits), pathsOnly);
      // A regular expression is matched against the text of the files, which
      // the embeddings cannot do: no vector of a pattern matches what the
      // pattern matches (see ../search/ripgrep.ts). It is asked for, so a
      // failure is reported rather than quietly answered by meaning instead:
      // a model that asked for a pattern and got something else back has no
      // way of telling, and will trust the answer.
      if (input.regex === true) return shown(await regexSearch(workspace, query, asked, signal));

      // What goes above the answer: the definitions of the name the query is
      // about, and a note wherever this search was not the one asked for
      const sections: string[] = [];
      const notes: string[] = [];
      const wants = input.definition === true;

      // The name the query is about, read off the query itself (see symbolIn),
      // or, where a definition was asked for outright, the likeliest name in it
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
        const paths = found.files.map(({ path }) => path);
        if (!by || paths.length < 2) return { files: found.files, ordered: false };
        const order = await embeddings
          .order({ workspace, thread: threadId }, by, paths, signal)
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
      if (input.regex !== false && looksLikePattern(query)) {
        const words = keywords(query);
        const tried = await regexSearch(workspace, query, asked, signal).catch((err: unknown) => {
          if (signal.aborted) throw err;
          return err as Error;
        });
        if (!(tried instanceof Error) && tried.files.length > 0) {
          const { files, ordered } = await ranked(tried, words.join(' '));
          return [...sections, ...notes, AS_PATTERN(ordered), shown({ ...tried, files })].join('\n\n');
        }
        notes.push(tried instanceof Error ? PATTERN_REFUSED(tried) : PATTERN_MISSED);
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
      try {
        // The thread's own copy of the workspace's embeddings, brought in step
        // with what it has done in its container before the query is asked
        return under(await embeddings.search({ workspace, thread: threadId }, meaning, asked, signal));
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
