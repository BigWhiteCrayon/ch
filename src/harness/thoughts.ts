// Turns a model's own reasoning into the thoughts the user reads.
//
// A model that reasons has its reasoning reported apart from its reply (see
// ReasoningEvent): the providers ask for it where they can (Ollama's `think`,
// Anthropic's thinking display) and pass it on as it is written. It arrives in
// fragments, and `reason` gathers those into one thought at a time.
//
// Nothing is asked of the model in words. There used to be: it was told to
// wrap each thought in <thought> tags and its reply was split on them, from
// when no local model reported its reasoning. Models do that themselves now,
// and better than an instruction could — so a model that reasons shows its
// thoughts, and one that does not simply answers.

import type { ThoughtEvent } from '../types';

// A model's own reasoning is not written to any instruction of ours, so it is
// broken up here instead: a paragraph at a time, and a paragraph longer than
// this many characters at the last sentence that ends within them.
const REASONING_LENGTH = 600;

export interface Reasoner {
  // Takes the next piece of the model's own reasoning; returns the thoughts
  // it completes, which may be none until more of it arrives
  reason(delta: string): ThoughtEvent[];
  // The reasoning is over: returns whatever was being held back
  end(): ThoughtEvent[];
}

// Gathers the fragments of a model's own reasoning (see ReasoningEvent) into
// a thought at a time. A thought is passed on once it is whole, so that the
// user reads the reasoning as the model writes it rather than all at the end.
export function reasoner(): Reasoner {
  let buffer = '';

  // A thought made of reasoning, which the model wrote to no limit of ours
  function thought(raw: string): ThoughtEvent[] {
    const line = raw.replace(/\s+/g, ' ').trim();
    return line ? [{ type: 'thought', text: line }] : [];
  }

  function take(at: number): string {
    const chunk = buffer.slice(0, at);
    buffer = buffer.slice(at).trimStart();
    return chunk;
  }

  // Takes the next whole thought out of what has been gathered: a paragraph,
  // or as much of a long one as ends a sentence within the limit. Null when
  // what is left may still be added to.
  function next(): string | null {
    const paragraph = buffer.search(/\n\s*\n/);
    if (paragraph !== -1 && paragraph <= REASONING_LENGTH) return take(paragraph);
    if (buffer.length <= REASONING_LENGTH) return null;
    const head = buffer.slice(0, REASONING_LENGTH);
    // Break where a sentence ends; failing that where a word does; failing
    // that wherever the limit falls
    const sentence = Math.max(...['. ', '! ', '? ', '.\n', '!\n', '?\n'].map((mark) => head.lastIndexOf(mark)));
    const at = sentence !== -1 ? sentence + 1 : head.lastIndexOf(' ');
    return take(at > 0 ? at : REASONING_LENGTH);
  }

  function drain(final: boolean): ThoughtEvent[] {
    const parts: ThoughtEvent[] = [];
    for (let chunk = next(); chunk !== null; chunk = next()) parts.push(...thought(chunk));
    if (final) {
      parts.push(...thought(buffer));
      buffer = '';
    }
    return parts;
  }

  return {
    reason(delta) {
      buffer += delta;
      return drain(false);
    },
    end: () => drain(true),
  };
}
