// The shape a code search answers in, and what it can be asked for.
//
// These live apart from any one search so that both the search that answers
// (embeddings.ts) and the one that stands in for it (ripgrep.ts) speak the
// same shape, and so the tool that cuts a result down to size (see
// ../tools/search.ts) need not know which of them it came from.

// A run of consecutive lines: a match together with its context
export type Block = { line: number; text: string }[];

export interface FileMatch {
  // Relative to the workspace
  path: string;
  // Runs of consecutive lines: matches together with their context
  blocks: Block[];
}

export interface SearchResult {
  files: FileMatch[];
  // How much of the workspace is indexed so far, as a percentage
  indexed: number;
  // Pieces of code that matched and whose lines could not be read, so that a
  // search which found something and could show none of it does not answer as
  // though it found nothing (see ../tools/search.ts). Only the search by
  // meaning has these: it finds a piece and then goes for its lines, while
  // ripgrep only ever matches lines it has in front of it.
  unread?: number;
  // What the limits left out once the result was cut down to them: lines,
  // or files where only the paths were asked for, and how many files they
  // were in. Set by the search tool's trim and nowhere else, since it is the
  // only thing that cuts (see ../tools/search.ts).
  cut?: { items: number; files: number };
}

// What a search may ask for beyond the query itself
export interface SearchOptions {
  // Roughly how many matching lines to return
  limit: number;
  // Lines of the file to show either side of each match
  context: number;
  // Return only the paths of the files that match, and none of their lines
  pathsOnly: boolean;
  // Which files may match, when the search was narrowed to some of them.
  // Given here rather than applied to the result so that the files it rules
  // out are never read at all (see embeddings.rank).
  keep?: (path: string) => boolean;
}

// Joins up runs that overlap or run on from each other, so that no line is
// shown twice. Pieces of a file overlap by a few lines on purpose (see
// chunks.OVERLAP), so two of them matching in the same place gave two runs
// with the same lines in both — repeated in the answer, and counted twice
// against the limits.
//
// The runs keep the order they came in, which is likest first: a run joins the
// one already kept that it touches, rather than being sorted into place.
export function mergeBlocks(blocks: Block[]): Block[] {
  const kept: Block[] = [];
  const touches = (a: Block, b: Block) => a[0].line <= last(b) + 1 && last(a) + 1 >= b[0].line;
  for (const block of blocks) {
    if (block.length === 0) continue;
    const at = kept.findIndex((other) => touches(block, other));
    if (at === -1) {
      kept.push([...block]);
      continue;
    }
    kept[at] = join(kept[at], block);
    // Joining may have closed the gap to a later run, which is taken in too
    for (let other = kept.length - 1; other > at; other--) {
      if (!touches(kept[at], kept[other])) continue;
      kept[at] = join(kept[at], kept[other]);
      kept.splice(other, 1);
    }
  }
  return kept;
}

const last = (block: Block) => block[block.length - 1].line;

// Two runs that touch, as one run: in line order, with each line once
function join(a: Block, b: Block): Block {
  const lines = [...a, ...b].sort((one, two) => one.line - two.line);
  return lines.filter((line, at) => at === 0 || line.line !== lines[at - 1].line);
}
