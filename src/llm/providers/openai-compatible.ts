// Talks to any server exposing the OpenAI chat-completions API: OpenAI itself
// and local servers (Ollama, llama.cpp server, LM Studio). Local servers load
// a model on first use, so there is no separate load/unload step here.
//
// Caching needs nothing asked for here, unlike anthropic's, where the places
// the cache may keep what it has seen are marked in the request (see
// anthropic.ts): this API caches a prompt's prefix of its own accord and
// reports what it reused. What it will not do is cache a short prompt — a
// thousand-odd tokens is the least that is kept — so the small errands this
// app sends, classifying a message at a hundred-odd tokens among them, report
// nothing cached however often they are sent, and nothing is wrong when they
// don't.

import type { ChatEvent, ChatMessage, ErrorCode, Provider, ToolImage, Usage } from '../../types';
import { failure, patientFetch } from '../transport';
import { stopped } from './stopped';

// How long the server asked to be left alone for, in ms. Retry-After is
// seconds or a date; anything else is no answer at all.
export function retryAfter(headers: { get(name: string): string | null }): number | undefined {
  const said = headers.get('retry-after');
  if (!said) return undefined;
  const seconds = Number(said.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(said);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function errorCode(status: number, detail: string): ErrorCode {
  if (/insufficient_quota|exceeded your current quota/i.test(detail)) return 'spend_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  return 'other';
}

// Yields the JSON payload of each server-sent event in a fetch response.
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
}

// Converts the app's messages to the chat-completions format.
export function toMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Images from the run of tool messages being read, sent after the run ends
  let images: ToolImage[] = [];
  const flush = () => {
    if (!images.length) return;
    out.push({
      role: 'user',
      content: images
        // One whose bytes fell out of the sidecar's cap (see renderer/threads.ts)
        // is only a name now, and has nothing to send
        .filter((image) => image.data)
        .map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        })),
    });
    images = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      images.push(...(m.images ?? []));
      continue;
    }
    flush();
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
      continue;
    }
    out.push({
      role: m.role,
      content: m.role === 'user' && m.images?.length ? userContent(m) : m.content,
    });
  }
  flush();
  return out;
}

// A user turn as a content array: the words first, then an image_url each
function userContent(m: Extract<ChatMessage, { role: 'user' }>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const image of m.images ?? []) {
    // A name with no bytes behind it has nothing to send
    if (!image.data) continue;
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  return parts;
}

function parseInput(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return null;
  }
}

// Models that are not for text at all. This API says nothing about what a
// model can do beyond its name, so the name is all there is to go on: an
// Ollama server is asked outright instead (see providers/ollama.ts). An
// embedding model asked to hold a conversation returns a vector or an error,
// and would otherwise be offered to the router like any other model.
export const NOT_TEXT = /embed|rerank/i;

export interface OpenAICompatibleOptions {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  local: boolean;
  // Fail early with a clear message when no API key is set
  requiresKey?: boolean;
  // Hides models that can't chat
  modelFilter?: (modelId: string) => boolean;
}

export function createOpenAICompatibleProvider({
  id,
  name,
  baseURL,
  apiKey,
  local,
  requiresKey = false,
  modelFilter = () => true,
}: OpenAICompatibleOptions): Provider {
  const missingKey = requiresKey && !apiKey;
  const noKeyMessage = `No ${name} API key found. Add one in Settings.`;
  const url = (path: string) => `${baseURL.replace(/\/$/, '')}${path}`;
  // A server on this computer is waited on without undici's five-minute
  // limits, which a model loading or a long prompt goes past (see
  // ../transport.ts). One across the network keeps them.
  const ask = local ? patientFetch : fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return {
    id,
    name,
    local,

    async status() {
      try {
        const res = await ask(url('/models'), { headers });
        return res.ok ? 'ready' : 'unreachable';
      } catch {
        return 'unreachable';
      }
    },

    async listModels() {
      if (missingKey) throw new Error(noKeyMessage);
      let res: Response;
      try {
        res = await ask(url('/models'), { headers });
      } catch {
        throw new Error(`No server reachable at ${baseURL}`);
      }
      if (!res.ok) throw new Error(`${baseURL} responded with HTTP ${res.status}`);
      // Ollama answers with "data": null when it has no models
      const { data } = (await res.json()) as { data?: { id: string }[] | null };
      return (
        (data ?? [])
          // Not for text, so not for anything this app does with a model
          .filter((m) => !NOT_TEXT.test(m.id))
          .filter((m) => modelFilter(m.id))
          .map((m) => ({ id: m.id, name: m.id, contextWindow: null, default: false }))
      );
    },

    async *stream(req, signal): AsyncGenerator<ChatEvent> {
      if (missingKey) {
        yield { type: 'error', code: 'auth', message: noKeyMessage };
        return;
      }
      // Left out of the models offered, but a thread that saved one before
      // now would still ask for it
      if (NOT_TEXT.test(req.model)) {
        yield {
          type: 'error',
          code: 'other',
          message: `${req.model} is not a text model: it cannot hold a conversation. Choose another model.`,
        };
        return;
      }
      const messages = toMessages(req.messages);
      if (req.system) messages.unshift({ role: 'system', content: req.system });
      const body: Record<string, unknown> = {
        model: req.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      // What the thread's requests have in common, so that the server can keep
      // their shared prefix together: caching here is automatic and needs
      // nothing asked for, but on the older models this key is what steers a
      // request to the machine that already holds its prefix, and on the newer
      // ones it keeps the accounting separate. A thread is the right unit —
      // its tool loop is a run of requests with one prefix between them.
      //
      // Only sent where the server is somebody else's: a local one has no
      // routing to steer and need not be handed a field it never asked for.
      if (req.cacheKey && !local) body.prompt_cache_key = req.cacheKey;
      if (req.tools?.length) {
        body.tools = req.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }));
      }

      try {
        let res: Response;
        try {
          res = await ask(url('/chat/completions'), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          yield { type: 'error', ...failure(err, baseURL) };
          return;
        }
        if (!res.ok || !res.body) {
          const detail = await res.text();
          yield {
            type: 'error',
            code: errorCode(res.status, detail),
            status: res.status,
            ...(retryAfter(res.headers) !== undefined ? { retryAfterMs: retryAfter(res.headers) } : {}),
            message: `HTTP ${res.status}: ${detail.slice(0, 300)}`,
          };
          return;
        }

        let stopReason = 'end_turn';
        let usage: Usage | undefined;
        // Tool calls arrive in fragments, keyed by index
        const calls: { id: string; name: string; json: string }[] = [];
        for await (const event of readEvents(res.body)) {
          const choice = event.choices?.[0];
          if (choice?.delta?.content) yield { type: 'text', delta: choice.delta.content };
          for (const part of choice?.delta?.tool_calls ?? []) {
            const call = (calls[part.index ?? 0] ??= { id: '', name: '', json: '' });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.json += part.function.arguments;
          }
          if (choice?.finish_reason) stopReason = stopped(choice.finish_reason);
          if (event.usage) {
            // What of the prompt came from the cache, and what went into it.
            // Both are parts of prompt_tokens rather than additions to it,
            // which is what Usage means by input, so they are passed on as
            // they come. A server that says nothing about caching — every
            // local one, and the models with no cache to speak of — leaves
            // them out rather than reporting nothing cached (see Usage).
            const details = event.usage.prompt_tokens_details;
            usage = {
              input: event.usage.prompt_tokens,
              output: event.usage.completion_tokens,
              ...(details?.cached_tokens ? { cacheRead: details.cached_tokens } : {}),
              ...(details?.cache_write_tokens ? { cacheWrite: details.cache_write_tokens } : {}),
            };
            // Passed on as it arrives, for a server that counts as it streams
            // (see TokensEvent). Most send this once, in a chunk of their own
            // after the reply: that one is a count of the finished call and is
            // reported again as the call's usage a moment later, which costs
            // nothing — each of these replaces the last.
            yield { type: 'tokens', usage };
          }
        }
        for (const call of calls.filter(Boolean)) {
          yield { type: 'tool_call', id: call.id, name: call.name, input: parseInput(call.json) };
        }
        yield { type: 'done', stopReason, usage };
      } catch (err) {
        if (signal.aborted) yield { type: 'done', stopReason: 'cancelled' };
        else yield { type: 'error', code: 'other', message: (err as Error).message };
      }
    },
  };
}
