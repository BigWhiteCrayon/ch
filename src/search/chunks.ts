// Splitting a file into the pieces that get embedded (see embeddings.ts).
//
// A whole file embeds to one vector, which is the average of everything in
// it: a query about one function is diluted by the rest. Pieces are embedded
// one at a time instead, so each vector is about one thing, and each piece
// knows which lines it came from — which is what lets a result say where in
// the file the answer is.
//
// Where to cut is guessed from the shape of the text rather than parsed. A
// line that starts at column 0 and is not a closing brace is where a function,
// class or top-level declaration begins in most languages, so those are the
// places a piece is allowed to end. A piece runs to TARGET characters and then
// to the next such line; one that finds none by the time it reaches LIMIT is
// cut where it stands, which is what happens to minified files and big data
// literals.

const TARGET = 1500; // characters a piece aims for
const LIMIT = 3000; // characters it may not pass, boundary or no boundary
const OVERLAP = 3; // lines repeated at the start of the next piece

export interface Chunk {
  // The file's own lines, 1-based and inclusive
  start: number;
  end: number;
  // The lines themselves, as they are in the file
  text: string;
}

// Whether a line is somewhere a piece may end: the start of something, rather
// than the middle or the end of it
export function isBoundary(line: string): boolean {
  if (!line.trim()) return false;
  // Indented: inside something, so not where the next thing starts
  if (/^\s/.test(line)) return false;
  // The tail of a block, not the head of one
  return !/^[)}\]]/.test(line.trim());
}

// The file in pieces, in order. An empty or blank file gives none.
export function split(text: string): Chunk[] {
  const lines = text.split('\n');
  // A trailing newline leaves an empty last line, which is nothing to embed
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || !text.trim()) return [];

  const chunks: Chunk[] = [];
  let from = 0; // index of the first line of the piece being built
  let size = 0;

  const close = (to: number) => {
    // to is the index after the last line of the piece
    const body = lines.slice(from, to);
    if (body.join('').trim()) chunks.push({ start: from + 1, end: to, text: body.join('\n') });
    // The next piece repeats the last few lines, so a match that straddles
    // the join is not lost from both sides of it
    from = Math.max(from + 1, to - OVERLAP);
    size = lines.slice(from, to).reduce((n, line) => n + line.length + 1, 0);
  };

  for (let at = 0; at < lines.length; at++) {
    size += lines[at].length + 1;
    const past = size >= TARGET;
    // Big enough, and the next line starts something new: end it here
    if (past && at + 1 < lines.length && isBoundary(lines[at + 1])) {
      close(at + 1);
      continue;
    }
    // Too big to carry on looking for somewhere better
    if (size >= LIMIT) close(at + 1);
  }
  if (from < lines.length) close(lines.length);
  return chunks;
}

// What a piece is embedded as. The path goes in front of the lines, so that a
// query naming a file or a directory has something to match on: much of what
// is asked of a code search is "where is the thing that does X", and the
// answer is often in the name of the file it is in.
export function embeddable(path: string, chunk: Chunk): string {
  return `${path}\n\n${chunk.text}`;
}
