import Anthropic from '@anthropic-ai/sdk';
import { retryAfter } from './openai-compatible';
import { stopped } from './stopped';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ErrorEvent,
  Provider,
  ProviderModel,
  ToolImage,
  Usage,
} from '../../types';
import * as log from '../../log';

// The token counts the API reports, as both a finished message and a delta
// carry them: a delta says only what has changed and leaves the rest null
// (see counted, where they are added up)
type ApiUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 64000;

// How a model is asked to report its thinking (see ReasoningEvent). Left to
// itself it streams its thinking blocks empty, and there would be nothing to
// show. 'updates' gives the short progress notes it writes between tool
// calls, which is what this shows as thoughts; it needs a beta flag and not
// every model takes it. 'summarized' gives a summary of the reasoning itself,
// and is what a model that turns 'updates' down is asked for instead.
// Neither is the raw chain of thought, which the API never returns.
const UPDATES = 'thinking-display-updates-2026-08-18';
type Display = 'updates' | 'summarized';

// What to do about a thinking block whose signature no longer matches the
// request it is being sent back in.
//
// A block is signed against the prompt in front of it — the instructions, the
// tools, and the turns before it — and by default a block that does not match
// fails the whole request with a 400. Every step of a reply or a subagent that
// is not simply the step before it with more on the end therefore throws away
// the work of every step that came before: measured, six coders lost on the
// step whose instructions gained a line, and two more on the step that has its
// tools taken away so that it has nothing left to do but write its report (see
// tell in ../../subagents/run.ts). Condensing a conversation rewrites what is
// in front of the blocks it keeps, so it is the same kind of request.
//
// Dropped instead: the blocks that no longer match are taken out, the rest of
// that turn's thinking with them, and the step runs without them. It costs
// that step the reasoning of the step before it, which is worth less than the
// run. What was dropped is reported, so the log says when it happened (see
// dropped below).
const BINDING = 'thinking-binding-controls-2026-08-01';
const KEEP_GOING = { prefix_mismatch_behavior: 'drop_block' as const };

// Says when the API took a thinking block out of the prompt rather than
// refusing the request over it (see KEEP_GOING). Each entry names the block as
// `messages.{i}.content.{j}`; what is worth knowing is the count and which
// request lost them, since the step itself carries on either way. Reported as
// `[]` when there is nothing to report, and absent on a provider or a model
// that says nothing about it.
function dropped(transformations: { type: string; path?: string }[] | null | undefined, req: ChatRequest): void {
  const taken = (transformations ?? []).filter((one) => one.type === 'thinking_dropped');
  if (taken.length === 0) return;
  log.debug('llm.unbound', {
    model: req.model,
    ...req.log,
    blocks: taken.length,
    at: taken.map((one) => one.path).filter(Boolean),
  });
}

const NO_CREDENTIALS = 'No Anthropic API key found. Add one in Settings.';
const BAD_CREDENTIALS = 'Anthropic rejected the API key. Check it in Settings.';

function toErrorEvent(err: unknown): ErrorEvent {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.AuthenticationError) {
    return { type: 'error', code: 'auth', message: BAD_CREDENTIALS };
  }
  // An empty balance comes back as a 400 (BadRequestError), not as a rate limit
  if (/credit balance is too low/i.test(message)) {
    return { type: 'error', code: 'spend_limit', message };
  }
  if (err instanceof Anthropic.RateLimitError) {
    // The SDK keeps the response's headers, where the wait it wants is
    const headers = (err as { headers?: { get?(name: string): string | null } }).headers;
    const asked = headers?.get ? retryAfter(headers as { get(name: string): string | null }) : undefined;
    return { type: 'error', code: 'rate_limit', message, ...(asked !== undefined ? { retryAfterMs: asked } : {}) };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { type: 'error', code: 'unreachable', message };
  }
  return { type: 'error', code: 'other', message };
}

// Adds what the user says to the conversation, folding it into the turn before
// it where that turn is the user's too. The API takes one turn from each side
// in turn, and two of the user's in a row is what the harness's nudges make:
// they go in without an assistant turn, there having been nothing in that turn
// to keep and an empty one being what some providers refuse (see NO_ANSWER in
// ../../harness/index.ts). Folded in, a nudge after a round of tool calls is a
// turn of results with a line of text after them, which is the shape the API
// wants.
function addUser(out: Anthropic.Beta.BetaMessageParam[], text: string, images?: ToolImage[]): void {
  const last = out.at(-1);
  if (last?.role !== 'user') {
    // A turn with pictures and no words sends the pictures alone; with words,
    // the words and the pictures in one block array
    if (images?.length) out.push(userBlock(text, images));
    else out.push({ role: 'user', content: text });
    return;
  }
  // Fold into the turn before it. An image-only nudge after a round of results
  // joins the results rather than becoming an empty turn of its own.
  if (!text && !images?.length) return;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] =
    typeof last.content === 'string' ? (last.content ? [{ type: 'text', text: last.content }] : []) : [...last.content];
  if (text) blocks.push({ type: 'text', text });
  for (const image of images ?? []) {
    // A name with no bytes behind it has nothing to send (see the tool path above)
    if (!image.data) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  out[out.length - 1] = { role: 'user', content: blocks };
}

// A user turn as a block array: the words first (an empty block is refused, so
// it is left out where there are none), then a picture each
function userBlock(text: string, images: ToolImage[]): Anthropic.Beta.BetaMessageParam {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (text) content.push({ type: 'text', text });
  for (const image of images) {
    // A name with no bytes behind it has nothing to send (see the tool path above)
    if (!image.data) continue;
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  return { role: 'user', content };
}

// Converts the app's messages to the Messages API format.
export function toMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  // All results for one assistant turn must go back in a single user message
  let results: Anthropic.Beta.BetaToolResultBlockParam[] | null = null;
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!results) {
        results = [];
        out.push({ role: 'user', content: results });
      }
      const block: Anthropic.Beta.BetaToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      // With images, the content is a block array: the text first (an empty text
      // block is refused, so it is left out when there is none), then one image each
      if (m.images?.length) {
        const content: Exclude<Anthropic.Beta.BetaToolResultBlockParam['content'], string | undefined> = m.content
          ? [{ type: 'text', text: m.content }]
          : [];
        for (const img of m.images) {
          // A name with no bytes behind it (a screenshot whose bytes fell out of
          // the sidecar's cap, see threads.ts) has nothing to send
          if (!img.data) continue;
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        }
        block.content = content;
      }
      if (m.isError) block.is_error = true;
      results.push(block);
      continue;
    }
    results = null;
    if (m.role === 'assistant' && m.raw?.provider === 'anthropic') {
      // Our own earlier reply, passed back unchanged (keeps thinking blocks intact)
      out.push({ role: 'assistant', content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Anthropic.Beta.BetaContentBlockParam[] = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const call of m.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content });
    } else if (m.role === 'user') {
      addUser(out, m.content, m.images);
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

// Where the prompt cache is told it may keep what it has seen. Everything
// before a breakpoint is written to the cache on the first request and read
// back from it on the next, at a tenth of the price (see ../pricing.ts), which
// is most of what a tool loop costs: every step resends the system prompt, the
// tool definitions and every tool result so far.
//
// Two breakpoints, which is the useful pattern within the four the API allows:
// one after the system prompt, covering it and the tools, since neither
// changes within a request; and one at the end of the conversation, so each
// step reads back the step before it. Below the model's minimum (1024 tokens,
// 2048 for Haiku) a breakpoint is ignored rather than refused, so a short
// request is no worse off for having asked.
const CACHE: Anthropic.Beta.BetaCacheControlEphemeral = { type: 'ephemeral' };

// The kinds of block that take a cache_control, which is all of the kinds we
// ever send; the rest belong to tools the API runs for itself
type Cacheable = Extract<Anthropic.Beta.BetaContentBlockParam, { cache_control?: unknown }>;

// A block a breakpoint may not go on: the model's own thinking, which it signs
// and we pass back as it was given to us
const signed = (type: string) => type === 'thinking' || type === 'redacted_thinking';

// The conversation with a breakpoint on its last block. A string content
// becomes a one-block array, which is the same thing to the API. Anything that
// cannot carry a breakpoint is left exactly as it was: the one on the system
// prompt is the one that matters, and this is only ever an improvement on it.
function cached(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const last = messages.at(-1);
  if (!last) return messages;
  // An empty string is no content to send and none to cache
  if (typeof last.content === 'string' && !last.content) return messages;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  const block = blocks.at(-1) as Cacheable | undefined;
  if (!block || signed(block.type)) return messages;
  blocks[blocks.length - 1] = { ...block, cache_control: CACHE };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

export function createAnthropicProvider({ apiKey }: { apiKey: string }): Provider {
  let client: Anthropic | undefined;
  // Without a saved key the SDK falls back to the environment (ANTHROPIC_API_KEY, ...)
  const getClient = () => (client ??= new Anthropic(apiKey ? { apiKey } : undefined));
  const outputLimits = new Map<string, number>();
  // Models that can be asked for adaptive thinking, as the Models API reports
  // it. A model that takes only a fixed thinking budget is not asked, and goes
  // on writing its thoughts in tags instead (see ../../harness/thoughts.ts).
  const adaptive = new Set<string>();
  // Models that turned 'updates' down, asked for a summary from then on
  const summarize = new Set<string>();

  // What the model is asked to report of its thinking, or nothing for a model
  // that isn't asked at all. Progress notes come between tool calls, so a
  // reply with no tools to call would get none and asks for a summary.
  // A brief request is answered in a few words and nobody is shown its
  // thoughts, so it is asked for none: the model still thinks, as it does by
  // default, but a summary would only be output tokens and delay on the path
  // a reply waits behind (see ../../harness/classifier.ts).
  // A request that asks for no reasoning is asked for no account of it either.
  function displayFor(req: ChatRequest): Display | undefined {
    if (req.think === false || req.brief || !adaptive.has(req.model)) return undefined;
    return req.tools?.length && !summarize.has(req.model) ? 'updates' : 'summarized';
  }

  // The SDK fails before sending anything when it finds no credentials at all
  const missingCredentials = (err: unknown) =>
    !apiKey &&
    (err as { status?: number }).status === undefined &&
    !(err instanceof Anthropic.APIConnectionError) &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.ANTHROPIC_AUTH_TOKEN;

  return {
    id: 'anthropic',
    name: 'Anthropic',
    local: false,

    async listModels() {
      const models: ProviderModel[] = [];
      try {
        for await (const m of getClient().models.list()) {
          if (m.max_tokens) outputLimits.set(m.id, m.max_tokens);
          const thinking = m.capabilities?.thinking;
          if (thinking?.supported && thinking.types.adaptive.supported) adaptive.add(m.id);
          models.push({
            id: m.id,
            name: m.display_name,
            contextWindow: m.max_input_tokens ?? null,
            default: m.id === DEFAULT_MODEL,
            reasons: adaptive.has(m.id),
            vision: Boolean(m.capabilities?.image_input?.supported),
          });
        }
      } catch (err) {
        if (missingCredentials(err)) throw new Error(NO_CREDENTIALS);
        if (err instanceof Anthropic.AuthenticationError) throw new Error(BAD_CREDENTIALS);
        throw err;
      }
      return models;
    },

    async *stream(req, signal): AsyncGenerator<ChatEvent> {
      const limit = outputLimits.get(req.model) ?? MAX_TOKENS;
      const tools = (req.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));

      // A model that turns down the way it was asked to report its thinking is
      // asked again for less, which is only safe while none of the reply has
      // been passed on. The thinking is asked for through the beta endpoint,
      // the only one that takes the 'updates' display.
      for (;;) {
        const display = displayFor(req);
        let passedOn = false;
        // What the call has used, as the stream says so. The API reports the
        // prompt as the reply begins and the output as it is written, so the
        // window has something climbing from the first event rather than
        // nothing until the pass is over (see TokensEvent). Each report is
        // cumulative but partial — a delta says only what has changed, and
        // leaves the rest null — so they are merged into one running count
        // rather than passed on as they come.
        //
        // Inside the retry loop: a call made again after the model turned down
        // the way it was asked to think starts its counting again with it.
        const sofar: Usage = { input: 0, output: 0 };
        const counted = (usage: Partial<ApiUsage> | null | undefined): Usage => {
          if (usage) {
            // The API counts cached tokens apart from input_tokens; this
            // counts them in, so a total is every token the request paid for
            const cacheWrite = usage.cache_creation_input_tokens ?? undefined;
            const cacheRead = usage.cache_read_input_tokens ?? undefined;
            if (cacheWrite !== undefined) sofar.cacheWrite = cacheWrite;
            if (cacheRead !== undefined) sofar.cacheRead = cacheRead;
            if (usage.input_tokens != null) {
              sofar.input = usage.input_tokens + (sofar.cacheWrite ?? 0) + (sofar.cacheRead ?? 0);
            }
            if (usage.output_tokens != null) sofar.output = usage.output_tokens;
          }
          return { ...sofar };
        };
        try {
          const stream = getClient().beta.messages.stream(
            {
              model: req.model,
              max_tokens: Math.min(req.maxTokens ?? MAX_TOKENS, limit),
              messages: cached(toMessages(req.messages)),
              ...(req.system ? { system: [{ type: 'text' as const, text: req.system, cache_control: CACHE }] } : {}),
              ...(tools.length ? { tools } : {}),
              ...(display
                ? {
                    thinking: { type: 'adaptive' as const, display, block_binding: KEEP_GOING },
                    betas: [BINDING, ...(display === 'updates' ? [UPDATES] : [])],
                  }
                : {}),
            },
            { signal }
          );
          for await (const event of stream) {
            // The prompt, counted before a word of the reply has arrived, and
            // then the output as the API revises it. Read as they come rather
            // than as the types promise, the way the other providers' streams
            // are read (see providers/ollama.ts): a gateway that leaves a
            // field out should cost the reply nothing. Nothing is said where
            // an event carried no counts at all.
            if (event.type === 'message_start' || event.type === 'message_delta') {
              if (event.type === 'message_start') dropped(event.message?.input_transformations, req);
              const usage = counted(event.type === 'message_start' ? event.message?.usage : event.usage);
              if (usage.input || usage.output) yield { type: 'tokens', usage };
              continue;
            }
            if (event.type !== 'content_block_delta') continue;
            if (event.delta.type === 'text_delta') {
              passedOn = true;
              yield { type: 'text', delta: event.delta.text };
            } else if (event.delta.type === 'thinking_delta') {
              // The model's own reasoning, which is never part of its reply
              passedOn = true;
              yield { type: 'reasoning', delta: event.delta.thinking };
            }
          }
          const final = await stream.finalMessage();
          for (const block of final.content) {
            if (block.type === 'tool_use') {
              yield {
                type: 'tool_call',
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              };
            }
          }
          yield {
            type: 'done',
            stopReason: stopped(final.stop_reason),
            // The finished message's own counts, through the same adding up as
            // the reports that came before it (see counted): what the call is
            // charged for, and the last word on it either way
            usage: { cacheWrite: 0, cacheRead: 0, ...counted(final.usage) },
            raw: { provider: 'anthropic', content: final.content },
          };
          return;
        } catch (err) {
          // Every thinking model summarizes, so that is what one that would
          // not write progress notes is asked for from now on
          if (display === 'updates' && !passedOn && err instanceof Anthropic.BadRequestError) {
            summarize.add(req.model);
            continue;
          }
          if (signal.aborted) yield { type: 'done', stopReason: 'cancelled' };
          else if (missingCredentials(err)) yield { type: 'error', code: 'auth', message: NO_CREDENTIALS };
          else yield toErrorEvent(err);
          return;
        }
      }
    },
  };
}
