// Tool calls a model wrote into its message instead of making.
//
// A model that can call tools is supposed to return them in a field of its
// own, and every provider here reads them from there (see the providers'
// tool_calls handling). Some local models, Qwen's among them, instead write
// the call into the message as text, in the shape their chat template taught
// them:
//
//   <tool_call>
//   {"name": "edit_file", "arguments": {"path": "src/a.ts", ...}}
//   </tool_call>
//
// or the same thing spelled out in tags. When that happens the provider sees
// no tool calls at all, the turn ends as an ordinary answer, and the markup
// is shown to the user as the reply — with whatever the model meant to do
// left undone. It is a template mismatch rather than anything the prompt can
// fix, so it is picked up here: the text is read for calls the model clearly
// meant to make, and they are turned back into the real thing.
//
// Two rules keep this from inventing work:
//   - Only names the model was actually offered are recovered. A model
//     explaining how tool calls work, or quoting one of ours, writes the same
//     markup and must not set anything running.
//   - Only when the provider reported no calls of its own. A model that did
//     both is a model whose intent is already known, and running the text as
//     well would do the same thing twice.
//
// Anything not recovered is passed through as the text it is, so nothing the
// model wrote ever disappears.

import crypto from 'crypto';
import * as log from '../log';
import type { ChatEvent, ToolCall } from '../types';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

// Closing markup with nothing it closes. The same models sometimes end a
// perfectly good answer with the tail of a call template — the reply that set
// this off ended:
//
//   const hits = await rank(...)
//   </parameter>
//   </function>
//   </tool_call>
//
// with no opening tag anywhere and the work already done by calls the
// provider did see. There is nothing to recover from it; it is litter, and it
// was being shown to the user as the end of the answer.
//
// Only ever stripped from the very end of a message, which is the shape it
// comes in. One in the middle is left alone: an assistant that talks about
// this markup — explaining it, or working on code that produces it — writes
// the same tags and means them.
// The run at the end of what has been said that may be litter: one closing
// tag or more, with whatever whitespace lies between and after them. It
// begins at a tag, never at the whitespace before one, so that holding it
// back can never reorder the model's own words around it — the line break
// before the first tag is the model's and goes out when it arrives.
const DANGLING = /(?:<\/(?:tool_call|function|parameter)>\s*)+$/;

// Every marker a buffer might end part-way through
const MARKERS = [OPEN, CLOSE, '</function>', '</parameter>'];

// <function=name> ... </function>, the tag form of the call inside a block
const FUNCTION = /<function\s*=\s*([^>\s]+)\s*>/;
// <parameter=name>value</parameter>, one per argument. The value is taken raw:
// it is usually a file's contents, and anything clever done to it here is a
// change to somebody's code.
const PARAMETER = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;

// What a parameter written as text means. The tag form has no types in it, so
// "true" and "7" arrive as strings where the tool is expecting a boolean or a
// number, and a tool that takes `replace_all` would never see one (see
// ../tools/sandbox.ts, where these are read with === true and Number()).
export function value(raw: string): unknown {
  // One line break either side belongs to the markup rather than the value;
  // any other whitespace is the value's own
  const text = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all: it is a string that begins with a bracket
    }
  }
  return text;
}

// The call one block holds, or null if it holds nothing we can act on: text
// that only looks like a call, a name the model was not offered, or arguments
// that cannot be read. Null is always the safe answer — the block is shown to
// the user as the text it is.
export function parse(
  block: string,
  offered: (name: string) => boolean
): { name: string; input: Record<string, unknown> } | null {
  const inner = block.trim();

  const tagged = FUNCTION.exec(inner);
  if (tagged) {
    const name = tagged[1];
    if (!offered(name)) return null;
    const input: Record<string, unknown> = {};
    PARAMETER.lastIndex = 0;
    for (let found = PARAMETER.exec(inner); found; found = PARAMETER.exec(inner)) {
      input[found[1]] = value(found[2]);
    }
    return { name, input };
  }

  // The JSON form, which may have anything around it
  const from = inner.indexOf('{');
  const to = inner.lastIndexOf('}');
  if (from === -1 || to <= from) return null;
  let read: unknown;
  try {
    read = JSON.parse(inner.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!read || typeof read !== 'object') return null;
  const { name, arguments: args, parameters } = read as Record<string, unknown>;
  if (typeof name !== 'string' || !offered(name)) return null;
  const given = args ?? parameters;
  if (typeof given === 'string') {
    try {
      const parsed = JSON.parse(given);
      return { name, input: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
    } catch {
      return null;
    }
  }
  return { name, input: given && typeof given === 'object' ? (given as Record<string, unknown>) : {} };
}

// How much of the end of a buffer might be the start of an opening tag, and so
// has to be held back rather than shown as text: "the reply is don<tool_c" is
// not something to put on screen.
function unsure(text: string): number {
  const longest = Math.max(...MARKERS.map((marker) => marker.length));
  const most = Math.min(longest - 1, text.length);
  for (let length = most; length > 0; length--) {
    const tail = text.slice(text.length - length);
    if (MARKERS.some((marker) => marker.startsWith(tail))) return length;
  }
  return 0;
}

// The model's events, with calls it wrote as text turned back into calls.
//
// Text is held back only as far as it must be: up to an opening tag, and from
// there until the block closes. Everything else streams on as it arrives, so
// a model that never does this pays nothing for the check.
export async function* recover(
  events: AsyncGenerator<ChatEvent>,
  offered: (name: string) => boolean
): AsyncGenerator<ChatEvent> {
  // Text seen but not yet passed on, because it may yet turn out to be a call
  let held = '';
  // Closing markup at the end of what has been said so far. Held because
  // whether it is litter or something the model meant depends on whether
  // anything follows it (see DANGLING).
  let dangling = '';
  // Blocks that parsed, with the text they came from, in the order written
  const found: { call: ToolCall; block: string }[] = [];
  // Calls the provider reported itself, which this never second-guesses
  let native = 0;

  // Text whose closing markup closes something: a block that was found whole
  // but is not a call we can act on, so it goes out exactly as written. What
  // was held back before it was followed by this, so it was meant too.
  function* plain(delta: string): Generator<ChatEvent> {
    const whole = dangling + delta;
    dangling = '';
    if (whole) yield { type: 'text', delta: whole };
  }

  // Text on its way to the user, with any trailing closing markup kept back
  // until something follows it to prove it was meant
  function* say(delta: string): Generator<ChatEvent> {
    const whole = dangling + delta;
    dangling = DANGLING.exec(whole)?.[0] ?? '';
    const text = whole.slice(0, whole.length - dangling.length);
    if (text) yield { type: 'text', delta: text };
  }

  // Nothing more is coming, so what was held back closes nothing: it is
  // dropped rather than shown as the end of the answer.
  function drop(): void {
    if (!dangling) return;
    log.debug('llm.dangling_markup', { chars: dangling.length });
    dangling = '';
  }

  // Everything in `held` that is settled: text up to an opening tag, and whole
  // blocks. Stops at an opening tag whose block has not finished arriving.
  function* settled(): Generator<ChatEvent> {
    for (;;) {
      const opens = held.indexOf(OPEN);
      if (opens === -1) {
        const keep = unsure(held);
        const text = held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
        if (text) yield* say(text);
        return;
      }
      if (opens > 0) {
        yield* say(held.slice(0, opens));
        held = held.slice(opens);
      }
      const closes = held.indexOf(CLOSE);
      // Still arriving: the rest of it waits for the next delta
      if (closes === -1) return;
      const block = held.slice(OPEN.length, closes);
      const rest = held.slice(closes + CLOSE.length);
      const call = parse(block, offered);
      if (call) {
        found.push({ call: { id: crypto.randomUUID(), ...call }, block: held.slice(0, closes + CLOSE.length) });
      } else {
        // Not a call we can act on, so it is what the model wrote: text, with
        // the tags it balances
        yield* plain(held.slice(0, closes + CLOSE.length));
      }
      held = rest;
    }
  }

  for await (const event of events) {
    if (event.type === 'text') {
      held += event.delta;
      yield* settled();
      continue;
    }
    if (event.type === 'tool_call') native++;
    if (event.type !== 'done') {
      yield event;
      continue;
    }

    // The end: whatever is still held is text, since nothing more is coming
    // to close it
    if (held) {
      yield* say(held);
      held = '';
    }
    drop();
    // The model made calls of its own, so what it also wrote as text was
    // writing, not calling. It is shown as written — at the end of the
    // message rather than where it stood, which is the one thing not kept
    // about a block that turns out to be prose after all.
    if (native > 0) {
      for (const { block } of found) yield { type: 'text', delta: block };
      yield event;
      return;
    }
    for (const { call } of found) yield { type: 'tool_call', ...call };
    // ...and the turn is one that wants its tools run, whatever the provider
    // made of it
    yield found.length > 0 ? { ...event, stopReason: 'tool_use' } : event;
    return;
  }

  // The stream ended without a 'done' (an error, or the caller stopping).
  // Nothing is recovered from a reply that never finished — there is no turn
  // left to run tools for — so everything held is given back as the text the
  // model wrote, blocks and all.
  for (const { block } of found) yield { type: 'text', delta: block };
  if (held) yield* say(held);
  drop();
}
