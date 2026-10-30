// How a reply ended, in the one set of words the rest of the app uses.
//
// Every provider has its own name for the same few endings: a reply that ran
// to its end is 'end_turn' to Anthropic, 'stop' to OpenAI and to Ollama; one
// that wants tools run is 'tool_use', 'tool_calls' or 'stop' with calls in it;
// one cut off for room is 'max_tokens', 'model_context_window_exceeded' or
// 'length'. The app tests the reason by name in a dozen places (see
// ../../harness/index.ts and ../../renderer.ts), so each provider says it in
// the app's words here rather than passing its own on.
//
// What it cost to not do this: the reason reached the harness as whatever the
// server said, and the three things that only happen on a clean end — carrying
// a coding change from one step to the next, collecting subagents still
// running, bringing notes level with the workspace — all test for 'end_turn'.
// A local model says 'stop', so none of them ever ran on one. The user asked
// for a change, the finding-out step ended as it should, and the reply stopped
// there and handed them the write-up in place of the plan and the change.
//
// So this maps every ending the three providers have, and an ending it does
// not know becomes 'end_turn': a word the app does not know disables the
// behaviour above silently, which is the bug this file exists to stop, while
// an unknown ending read as a clean one costs at most one retry of a cut-off
// reply. Cancellation is the app's own (see ../index.ts) and never a server's.
const STOPPED: Record<string, string> = {
  // The reply ran to its end
  end_turn: 'end_turn',
  stop: 'end_turn',
  stop_sequence: 'end_turn',
  // Anthropic pauses a turn it means to go on with; this app runs its own
  // tools and asks again itself, so there is nothing here to go on with
  pause_turn: 'end_turn',
  // It wants its tools run before it says anything more
  tool_use: 'tool_use',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  // It was cut off mid-answer, for its own limit or the window's. The harness
  // makes room and asks again on this one, so it has to arrive under one name
  length: 'length',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  // It declined, which the window says in as many words
  refusal: 'refusal',
  content_filter: 'refusal',
  // Ollama's answer when nothing was generated at all, the model having only
  // been loaded or dropped. Nothing was written, which is what the app shows
  load: 'end_turn',
  unload: 'end_turn',
};

// The app's word for what the server called the ending. A server that said
// nothing ended cleanly, that being what every provider's stream means by
// running out without a reason in it.
export function stopped(said: string | null | undefined): string {
  if (!said) return 'end_turn';
  return STOPPED[said] ?? 'end_turn';
}
