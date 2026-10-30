// Whether the finding-out step actually opened the files it says things about.
//
// The write-up that step produces is the whole of what the planning step is
// given. That step has no tools, so a path in those words is not something it
// can check: a path that is wrong goes into the plan as though it had been
// found, the plan is cut into pieces, and each piece is handed to a coder and
// sent to the file the plan names. One invented location is therefore paid for
// three times over, and the doing step spends its rounds working out where the
// thing really lives — which is the run this was written for. A write-up put
// the threads' `save()` and `load()` in harness/index.ts; they are in store.ts.
// The plan repeated it, three coders were sent to functions that do not exist,
// and the doing step spent ninety-odd rounds reading before the reply ran out
// of room.
//
// What makes that catchable without a model is that the step's own calls say
// which files it opened. A claim about a file it never opened is a claim from
// memory — and the path is usually real, because it came off a search hit or a
// note, while what the step says is inside it came from the model. So the
// question here is not whether the path exists. It is whether this step read
// it.
//
// A search hit does not ground a claim, and neither does a note. Both say that
// a path exists; neither says what the file does, which is the whole of what a
// write-up is for. In the run above harness/index.ts was in front of the step
// eleven times, every one of them a note or a search result, and its functions
// were wrong all the same. Notes carry their own warning for the same reason
// (see ../tools/notes.ts, where a stale one is marked): a note is an account of
// a file rather than the file.
//
// What does ground a claim is a read — and a read an explorer did in a window
// of its own and reported back, since handing the wide reading out is what this
// step is told to do (see PROMPTS.explore in ./phases.ts) and a step that did
// as it was told must not be told it was working from memory. A reading command
// that prints lines out of a file grounds them too: grep -n read the file.
//
// The check is cheap and it is not clever. It catches the step that wrote about
// a file it never opened, which is the failure that reaches the plan intact.
// It does not catch a wrong claim about a file the step did read — the same run
// had the Thread type in types.ts, having read types.ts four times, and nothing
// here would know. That wants a different check, against the file's contents
// rather than against the call log.

// Extensions this project's files actually have. A path is only worth checking
// if it looks like one of ours: a write-up says `thread.archived` and
// `state.threads`, and a rule that took every dotted word for a file would
// flag the lot of them.
const EXTENSIONS = ['ts', 'mts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'html', 'css', 'md', 'yml', 'yaml'];

// A path has to have a directory in it to be matched, which is what keeps
// `package.json` out of this as well as `thread.archived`. A root file named on
// its own is missed; it is also the one place in this project where there is
// nothing to be wrong about.
const PATH = new RegExp(`(?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]+\\.(?:${EXTENSIONS.join('|')})\\b`, 'g');

// Built, installed and copied files. A claim about one of these is not a claim
// about this project's source, and `dist/` is a copy of what `src/` already
// said.
const IGNORED = /^(?:node_modules|dist|dist-evals|\.git)\//;

// Paths inside a URL are somebody else's files
const URLS = /\b[a-z][\w+.-]*:\/\/\S+/gi;

// The same file written the way a model writes it and the way a tool call
// does: the container's working directory is /workspace, and a model naming a
// file it read there may name it from the root or from where it is standing.
export function normalize(path: string): string {
  return path
    .replace(/^\/workspace\//, '')
    .replace(/^\.{0,2}\//, '')
    .replace(/[.,;:)\]}]+$/, '');
}

// Every path a piece of writing names, first mention first.
export function named(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(URLS, ' ').matchAll(PATH)) {
    const path = normalize(match[0]);
    if (!IGNORED.test(path)) found.add(path);
  }
  return [...found];
}

// The paths a write-up makes claims about that this step never had open.
// grounded: what it read itself, what an explorer read for it, and what a
// reading command printed (see the loop in ./index.ts, which collects them).
//
// A step that opened nothing at all is left alone, and deliberately. What this
// is for is the step that read some files and wrote about others — the run
// above opened types.ts and renderer.ts and then said what was inside
// harness/index.ts, and the gap between the two is the signal. A step that
// opened nothing has no gap to measure: there is no evidence either way, and
// what is wrong with it is the whole write-up rather than one path in it, which
// is the budget prompts' business and NOTHING_CARRIED's (see ./phases.ts). One
// path picked out of it would be noise, and the finding-out step whose own job
// is reading does not reach the end having read nothing except in that
// pathological case.
export function ungrounded(said: string, grounded: Iterable<string>): string[] {
  const read = new Set([...grounded].map(normalize));
  if (read.size === 0) return [];
  return named(said).filter((path) => !read.has(path));
}

const list = (paths: string[]) => paths.map((path) => `\`${path}\``).join(', ');
const them = (paths: string[]) => (paths.length > 1 ? 'them' : 'it');

// Asked once, while the step still has rounds to spend, naming the paths it has
// written about without opening. Naming them is the point: a step told only
// that something is unchecked re-reads what it already had.
export const CHECK = (paths: string[]) =>
  `Hold on before this step ends. Your write-up says what is inside ${list(paths)}, and you did not open
${paths.length > 1 ? 'any of them' : 'it'} in this step. What you have for ${them(paths)} came off a search hit, a
workspace note or your own recollection — and a note is an account of a file rather than the file, which is how a
step like this one came to name three functions in a file that has none of them.

So read ${them(paths)} now and put the write-up right: keep what the file confirms, correct what it contradicts, and
strike what turns out not to be there. The step that plans the change has no tools and cannot check any of this, and
the coders are sent to the files your words name — so what you hand on is acted on as found.

Where a path is one an explorer read for you and reported back, say that and keep it. Where you cannot open one, drop
the claim rather than passing it on as a finding.`;

// ...and what is added to the write-up instead when there are no rounds left to
// check with. The planning step cannot go and look, but it can write a plan
// that does not rest on this, and the user reads the plan — so an unchecked
// location named here is one they can correct in a sentence, which is the whole
// reason the plan is shown to them before anything happens.
export const CAVEAT = (paths: string[]) =>
  `\n\nNot checked against the files: this step said what is inside ${list(paths)} without opening
${paths.length > 1 ? 'any of them' : 'it'}, so ${
    paths.length > 1 ? 'those locations are' : 'that location is'
  } recollection rather than a finding. Do not give ${them(paths)} in the plan as the
place a change goes without saying that where it belongs has to be confirmed first.`;
