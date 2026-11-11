// A file a reply pointed at, shown the way a diff is (see changes.ts). The model
// writes the point as a fenced block named `file`, its lines each naming a part
// of the code:
//   ```file
//   src/main.ts
//   src/main.ts:442-451
//   ```
// Each line is a reference, and the window shows it as a note that opens to read
// that file in the workspace the reply was written in, by the name the reply
// gave it (see mdCodeBlock, which hands a closed `file` block to here). The file
// is read in the workspace that is on screen when the note is opened, so a
// reference to src/main.ts shows what that file is there right now, not what it
// was when the reply was written.

import { activeThread, sourceOf } from './threads.js';
import { expanded } from './shared.js';
import type { WorkspaceFile } from './types.js';

// One reference the model made in a `file` block: its path, and the lines it
// asked for where it named a range.
export interface Reference {
  path: string;
  from?: number;
  to?: number;
}

// The range a reference asks for, as a :line or :line-line at the end of its
// line. Only a colon and digits at the very end are read as a range, so a path
// that ends in something the model did not mean as a range is left whole.
const RANGE = /:(\d+)(?:-(\d+))?$/;

// One line of a `file` block: its path, and the lines it asked for if it named a
// range. null where the line is blank.
export function parseReference(line: string): Reference | null {
  const text = line.trim();
  if (!text) return null;
  const range = RANGE.exec(text);
  if (range) {
    return {
      path: text.slice(0, range.index),
      from: Number(range[1]),
      to: range[2] !== undefined ? Number(range[2]) : undefined,
    };
  }
  return { path: text };
}

// The key a reference keeps open or closed when the messages are rebuilt, like a
// dropdown's (see dropdown in tool-calls.ts). It is the path and its range, so
// two references to the same part of a file are the one reference.
const keyOf = (ref: Reference) => `file:${ref.path}:${ref.from ?? 0}-${ref.to ?? 0}`;

// The lines the reference asked for, with their numbers, into its note. What
// could not be read is said to the user instead of a blank note.
function rowsOf(body: HTMLElement, result: WorkspaceFile): void {
  if (result.outside) {
    body.textContent = 'That path reaches outside the workspace, so it is not shown.';
    return;
  }
  if (result.notFound) {
    body.textContent = `Not found: ${result.path}.`;
    return;
  }
  if (result.binary) {
    body.textContent = `${result.path} is not a text file, so it is not shown.`;
    return;
  }
  if (result.tooLarge) {
    body.textContent = `${result.path} is too large to show.`;
    return;
  }
  body.replaceChildren();
  const from = result.from ?? 1;
  for (let i = 0; i < (result.lines ?? []).length; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const number = document.createElement('span');
    number.className = 'number';
    number.textContent = String(from + i);
    const code = document.createElement('code');
    code.textContent = result.lines![i];
    row.append(number, code);
    body.append(row);
  }
  if (result.more) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `${result.more} more lines, not shown.`;
    body.append(more);
  }
}

// The note one reference is shown in. It is closed until the user opens it, which
// is when the file is read, and its open or closed state is kept when the
// messages are rebuilt.
export function fileReference(ref: Reference): HTMLDetailsElement {
  const key = keyOf(ref);
  const details = document.createElement('details');
  details.className = 'file-ref';

  // The reference the note is for, said on the line that opens it
  const summary = document.createElement('summary');
  const path = document.createElement('code');
  path.className = 'file-path';
  path.textContent = ref.path;
  summary.append(path);
  if (ref.from !== undefined) {
    const range = document.createElement('span');
    range.className = 'file-range';
    range.textContent = ref.to !== undefined ? `${ref.from}-${ref.to}` : `from ${ref.from}`;
    summary.append(range);
  }

  // Where the lines are read into, when the note is opened
  const body = document.createElement('div');
  body.className = 'file-body';
  details.append(summary, body);

  // Reading the file the reference names, into its note, from the workspace that
  // is on screen then. A read that started on a note the messages have since
  // rebuilt has nothing to write into, so it is left alone.
  const read = async () => {
    const workspace = sourceOf(activeThread());
    if (!workspace) {
      body.textContent = 'There is no workspace here to read that from.';
      return;
    }
    body.textContent = 'Reading…';
    const result = await window.threads.workspaceFile(workspace, ref.path, ref.from, ref.to);
    // The note is filled only while it is still on screen: a rebuild has its own
    // note, and a read that started on the old one must not write into it
    if (!body.isConnected) return;
    rowsOf(body, result);
  };

  details.addEventListener('toggle', () => {
    // A note that has since been rebuilt has nothing to say
    if (!details.isConnected) return;
    if (details.open) {
      expanded.add(key);
      void read();
    } else {
      expanded.delete(key);
    }
  });

  // Rebuilt with the note open: its toggle has already happened, so read it here
  details.open = expanded.has(key);
  if (details.open) void read();
  return details;
}

// The note the lines of a closed `file` block are shown as. A block with no
// reference in it is not a note, so it is shown as code where it came from
// (mdCodeBlock falls back to a code block when this returns null).
export function fileBlock(body: string): HTMLElement | null {
  const refs = body
    .split('\n')
    .map((line) => parseReference(line))
    .filter((ref): ref is Reference => ref !== null);
  if (refs.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'file-refs';
  for (const ref of refs) wrap.append(fileReference(ref));
  return wrap;
}
