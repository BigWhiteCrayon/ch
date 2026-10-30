import { describe, expect, it } from 'vitest';
import { stopped } from '../../../src/llm/providers/stopped';

// The words the app itself tests for (see ../../../src/harness/index.ts and
// ../../../src/renderer.ts). 'cancelled' and 'max_steps' are the app's own and
// never a server's, so nothing here may map to them.
const APP_WORDS = ['end_turn', 'tool_use', 'length', 'refusal'];

describe('how a reply ended', () => {
  it("says a clean ending in the app's words, whichever provider said it", () => {
    expect(stopped('end_turn')).toBe('end_turn'); // Anthropic
    expect(stopped('stop')).toBe('end_turn'); // OpenAI and Ollama
    expect(stopped('stop_sequence')).toBe('end_turn');
  });

  it('says a round of tool calls in one word', () => {
    expect(stopped('tool_use')).toBe('tool_use');
    expect(stopped('tool_calls')).toBe('tool_use');
    expect(stopped('function_call')).toBe('tool_use');
  });

  // The harness makes room and asks again on this one, so a reply cut off for
  // room has to arrive under the same name from all three
  it('says being cut off in one word', () => {
    expect(stopped('length')).toBe('length');
    expect(stopped('max_tokens')).toBe('length');
    expect(stopped('model_context_window_exceeded')).toBe('length');
  });

  it('says a refusal in one word', () => {
    expect(stopped('refusal')).toBe('refusal');
    expect(stopped('content_filter')).toBe('refusal');
  });

  // An ending the app does not know silently costs it the three things that
  // only happen on a clean end — carrying a coding change to its next step,
  // collecting subagents still running, bringing notes level — so there is no
  // such ending: an unknown word, and a stream that ended without one, are
  // both read as a reply that ran to its end
  it('reads an ending it does not know as a clean one', () => {
    expect(stopped('something_new')).toBe('end_turn');
    expect(stopped('')).toBe('end_turn');
    expect(stopped(null)).toBe('end_turn');
    expect(stopped(undefined)).toBe('end_turn');
  });

  it('never answers in a word the app does not test for', () => {
    const said = [
      'end_turn',
      'stop',
      'stop_sequence',
      'pause_turn',
      'tool_use',
      'tool_calls',
      'function_call',
      'length',
      'max_tokens',
      'model_context_window_exceeded',
      'refusal',
      'content_filter',
      'load',
      'unload',
      'anything else',
    ];
    for (const reason of said) expect(APP_WORDS).toContain(stopped(reason));
  });
});
