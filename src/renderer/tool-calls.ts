import type { Message } from './types.js';
import { TOOL_LABELS, LABEL_INPUT, runningCalls, expanded } from './shared.js';
import { shorten } from './events.js';

export function toolOf(m: Message): string {
  return m.tool ?? /^Used (\S+)/.exec(m.text)?.[1] ?? 'tool';
}

// What a call was given under one name, such as its "path", read back from
// what the note keeps of the input: the summary's "path: src/main.ts" line,
// or the JSON kept for a call that failed
export function inputOf(m: Message, key: string): string {
  const line = m.inputSummary?.split('\n').find((l) => l.startsWith(`${key}: `));
  if (line) return line.slice(key.length + 2);
  try {
    const value = (JSON.parse(m.input ?? '{}') as Record<string, unknown>)[key];
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

// What a call is called: "Reading src/main.ts…", "Searched "entry point""
export function callLabel(m: Message, running: boolean): string {
  const name = toolOf(m);
  const label = TOOL_LABELS[name];
  if (!label) return running ? `Running ${name}…` : `Used ${name}`;
  const keys = label.input === undefined ? [] : [label.input].flat();
  const key = keys.find((k) => inputOf(m, k) !== '') ?? keys[0];
  const given = key ? shorten(inputOf(m, key), LABEL_INPUT) : '';
  const what = given ? (label.quoted ? `"${given}"` : given) : label.thing;
  return `${running ? label.doing : label.done} ${what}${running ? '…' : ''}`;
}

// Calls to one tool, one after another, shown as a single note: what is
// being done, or what was done first and how many more there were. It opens
// to show each call, with what was asked and, once the tool is done, in
// brief what came back, or in full what went wrong.
export function callDetails(calls: Message[]): HTMLDetailsElement {
  const failed = calls.filter((m) => m.failure !== undefined).length;
  // Until its result arrives, the note says what the tool is at work on
  const waiting = calls.findIndex((m) => runningCalls.has(m.callId ?? ''));
  const unfinished = calls.some((m) => m.failure === undefined && m.output === undefined);

  let text: string;
  if (waiting !== -1) {
    text = callLabel(calls[waiting], true);
    if (calls.length > 1) text += ` (${waiting + 1} of ${calls.length})`;
  } else {
    text = callLabel(calls[0], false);
    if (calls.length > 1) text += ` +${calls.length - 1} more`;
  }
  if (failed > 0) text += calls.length > 1 ? ` (${failed} failed)` : ' (failed)';

  const sections = calls.flatMap((m, i): Section[] => {
    // Several calls are numbered, so each one's parts can be told apart
    const n = calls.length > 1 ? `${i + 1}. ` : '';
    return m.failure !== undefined
      ? [
          [`${n}Error`, m.failure || 'The tool gave no details.'],
          ['Input', m.input],
        ]
      : [
          // What a file was given is in its diff, which says more; only its name is repeated
          [
            `${n}Input`,
            m.diff
              ? m.inputSummary
                  ?.split('\n')
                  .filter((line) => line.startsWith('path: '))
                  .join('\n')
              : m.inputSummary,
          ],
          ['Output', m.output],
          ['Changes', m.diff, 'diff'],
        ];
  });
  const details = dropdown(calls[0].callId ?? '', text, sections);
  details.className = failed > 0 ? 'failed' : unfinished ? 'running' : 'succeeded';
  // Whatever images the calls came back with, under their text
  for (const image of calls.flatMap((m) => m.images ?? [])) {
    // One whose bytes fell out of the sidecar's cap (see renderer/threads.ts)
    // is only a name now, and draws nothing
    if (!image.data) continue;
    const img = document.createElement('img');
    img.className = 'tool-image';
    img.src = `data:${image.mediaType};base64,${image.data}`;
    img.alt = 'Screenshot';
    details.append(img);
  }
  return details;
}

// How long the waiting dots take to go round once, in ms (as in styles.css)
export const WAVE_MS = 1200;

// Three dots that rise and swell in turn, a wave passing along them, shown in
// a reply's bubble until its first words arrive
export function waitingDots(): HTMLElement {
  const dots = document.createElement('span');
  dots.className = 'waiting';
  dots.setAttribute('role', 'status');
  dots.setAttribute('aria-label', 'Working');
  // Rendering rebuilds the bubble; starting part-way through keeps the wave
  // where it was instead of setting it back to the beginning
  dots.style.setProperty('--phase', `-${Math.round(performance.now() % WAVE_MS)}ms`);
  for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
  return dots;
}

// A note that opens to show labelled details. `key` identifies it, so that it
// stays open or closed when the messages are rebuilt.
// A part of a dropdown: its label, its text, and 'diff' if the text is a
// diff, whose added and removed lines are then marked as such
export type Section = [label: string, text: string | undefined, kind?: 'diff'];

export function dropdown(key: string, text: string, sections: Section[]): HTMLDetailsElement {
  const details = document.createElement('details');
  details.open = expanded.has(key);
  details.addEventListener('toggle', () => {
    // A dropdown that has since been rebuilt has nothing to say
    if (!details.isConnected) return;
    if (details.open) expanded.add(key);
    else expanded.delete(key);
  });

  const summary = document.createElement('summary');
  summary.textContent = text;
  details.append(summary);

  fill(details, sections);
  return details;
}

// Puts each section into an element, as a heading and a block of text. Used by
// the dropdowns in a thread and by the dialogs that show a workspace's notes.
export function fill(into: HTMLElement, sections: Section[]): void {
  for (const [label, text, kind] of sections) {
    if (!text) continue;
    // A section with no label is just its text
    if (label) {
      const heading = document.createElement('div');
      heading.className = 'label';
      heading.textContent = label;
      into.append(heading);
    }
    const body = document.createElement('pre');
    if (kind === 'diff') {
      body.className = 'diff';
      for (const line of text.split('\n')) {
        const row = document.createElement('span');
        // The two lines naming the file are neither added nor removed
        if (/^\+(?!\+\+ )/.test(line)) row.className = 'add';
        else if (/^-(?!-- )/.test(line)) row.className = 'del';
        row.textContent = `${line}\n`;
        body.append(row);
      }
    } else {
      body.textContent = text;
    }
    into.append(body);
  }
}

// What one text did to another, a line at a time: the smallest set of added
// and removed lines that turns the first into the second. For showing what a
// thread has made of its workspace's note, which it starts from a copy of.
//
// Not exported, and nothing here is: this file is loaded as a plain script, so
// a single export makes the compiler emit a module and the page dies on
// `exports is not defined` before anything is wired up.
export function lineDiff(before: string, after: string): string {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  // The longest run of lines the two have in common, worked out from the end
  // back, so that what is left over is the smallest diff there is
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (out.push(` ${a[i++]}`), j++);
    else if (common[i + 1][j] >= common[i][j + 1]) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join('\n');
}

// Searching the threads.
//
// What is searched is what was said: each request and the replies to it, held
// as embeddings by the main process (see ../search/threads.ts). The window's
// part is to cut the threads up (see searchPieces), to ask, and to put the user
// back where the answer came from — which is the point of the whole thing. A
// search that only told you which thread it was in would leave you scrolling.

// Long enough to mean something. One or two letters match everything, and a
// search by meaning has nothing to go on in them.
