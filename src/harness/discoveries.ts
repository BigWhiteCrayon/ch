// What a model is told about writing down what it finds out, which is not the
// same thing to tell every provider.
//
// A reply that runs long is kept inside its window by condensing the older
// part of it into findings (see compactor.ts). The job that writes those
// findings reads the record, and the record is the calls, what came back from
// them, and what the model itself wrote in its reply (see compactor.record).
// It is not the model's reasoning. That arrives on a channel of its own, apart
// from the reply, and is passed on to be read rather than put in a message
// (see ../types.ReasoningEvent and ./thoughts.ts) — so something worked out in
// thinking and acted on without being written down leaves no trace in the
// record, and a compaction cannot carry forward what it cannot see. What the
// model does then is go looking again for what it already found, which is the
// one failure the compaction prompt is most careful about (see
// compactor.PROMPT). The prompt there can only keep the findings it is shown;
// this is what gets the finding into the record for it to keep.
//
// The thread's context note is the other way through, and the model is told to
// use it (see TOOL_PROMPT in ./index.ts). This is said as well, not instead:
// the note is a tool call that has to be remembered, while the reply is being
// written anyway.
//
// Per provider, because how long a thought lasts depends on what the provider
// does with it, and the two cases are not close enough to tell a model the
// same thing about:
//
// Anthropic returns thinking as signed blocks, which stay on the assistant
// message and are passed back whole at every step of the reply (see
// ../llm/providers/anthropic.ts). A thought there survives the tool loop and
// is lost only when the message carrying it is replaced by findings, so the
// model needs telling about the compaction and little else.
//
// Ollama and the OpenAI-compatible provider keep nothing: they report the
// thinking for the user to read and the message they store is the reply text
// and the tool calls alone — neither sets `raw`. A thought there is gone at
// the next step of the same reply, compaction or no compaction, and the model
// is working from a record that has never held any of its reasoning. That
// wants saying plainly, and it wants saying most to the models least likely to
// do it unasked: a small local model will put the whole of its analysis in
// `thinking` and answer with a line.

// The mechanism, which holds whoever is answering
import type { Phase } from '../types';

const KEPT = `Write down what you find out as you go, in your reply, at the moment you find it. Your reasoning is not
part of your reply and is not kept with it: it is reported to the user on its own. What comes back to you later is
what you wrote in your reply, the tools you called, and what they returned.`;

// What is worth writing down, which is the same list whatever is answering
const WORTH_IT = `- the path and the line numbers of what you found, as the search or the read gave them
- the exact signature, flag, command, version or value — copied, not remembered
- what you tried that did not work, and what it said
- what you have ruled out, and what you have decided to do next`;

// Thinking that lasts the reply and goes at the compaction
// Why a thought that is not written down is lost, which is not the same thing
// in the finding-out step as in a reply that runs on. A reply that runs long
// loses it to the condensing; the finding-out step is never condensed — it
// ends instead (see the loop in ./index.ts) — and what it loses the thought to
// is the end of the step, which comes sooner and takes the tool results with
// it. Telling it about the condensing would be telling it about something that
// does not happen to it.
const CONDENSED = `Your thinking does come back to you at each step of this reply, so what is at risk here is not the
next step but the condensing: once this reply is long enough to need room, its earlier calls and results are replaced
by notes written from that record, and the record does not include your thinking. Whatever you worked out there and
never wrote down goes with them, and you will not be able to tell that it has — you will simply search again for what
you had already found.`;

const STEP_ENDS = `Your thinking does come back to you at each round of this step, so what is at risk is not the next
round but the end of the step: when it ends, your calls and their results are left behind and what you have written
is the whole of what goes on. Whatever you worked out in thinking and never wrote down goes with them, and the step
after this one will never know you knew it.`;

const signed = (phase?: Phase) => `${KEPT}

${phase === 'explore' ? STEP_ENDS : CONDENSED}

So when you establish something the rest of the work rests on, put it in your reply in a line before you call the
next tool:

${WORTH_IT}

Quote code exactly where your change has to match it. A line costs you nothing and is the only copy that survives.`;

// Thinking that is shown and then dropped, which is every provider but
// Anthropic. The default as well: a provider we know nothing about is assumed
// to keep nothing, which is the assumption that costs a line of reply if it is
// wrong and a repeat of the work if the other one is.
const DROPPED = `${KEPT}

Your reasoning is not stored on the message and does not come back to you at the next step of this reply, so anything
worked out there and not written down is gone as soon as you call the next tool.

So when a tool tells you something the rest of the work rests on, write it into your reply in a line before you call
the next one:

${WORTH_IT}

Copy it rather than recalling it, and keep each to a line or two.`;

// The same, told to a small local model: the same facts, spelled out, because
// the model this reaches is the one likeliest to reason at length and reply
// with a sentence — and the one whose window is smallest, so it is condensed
// oftenest (see ../llm/ollama.CONTEXT_LENGTH).
const LOCAL = `${KEPT}

This matters more than it may seem. Your thinking is shown to the user and then dropped: it is not stored on the
message, and it does not come back to you at the next step of this reply, let alone after the conversation has been
condensed to make room. If you work something out in your thinking and go straight on to the next tool call, you have
thrown it away already, and the result it was about will be gone too.

So write it out. Every time a tool tells you something you did not know, say so in your reply before you call the
next one:

${WORTH_IT}

Keep each to a line or two, and name the file or the command it is about. Copy paths, line numbers, signatures and
output exactly as the tool gave them rather than from memory; where your change has to match code, quote the code.

Do not save this for the end of the reply, and do not leave it in your thinking: by the end, your thinking is gone
and so is the result it was about. If you are unsure whether something is worth writing down, write it down.`;

const PROMPTS: Record<string, (phase?: Phase) => string> = {
  anthropic: signed,
  // Ollama's own provider and any other local server share the id (see
  // ../llm/index.ts, where the OpenAI-compatible fallback it is built on is
  // registered as `local`)
  local: () => LOCAL,
  openai: () => DROPPED,
};

// What the model answering is told about keeping what it finds. Said only to a
// model with tools: it is about what a tool returned and what becomes of it,
// and a model that cannot call one has nothing here to act on.
export const prompt = (provider: string, phase?: Phase): string => (PROMPTS[provider] ?? (() => DROPPED))(phase);
