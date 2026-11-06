// Talks to Ollama through its own chat API rather than the OpenAI-compatible
// one, for two things that only its own API offers. The first is saying how
// large a context window the model is loaded with: left to itself Ollama
// gives every model 4,096 tokens, which the system prompt and a tool result
// or two fill up. The second is saying whether a model that can reason should
// (`think`), and being told what it reasoned apart from its reply, so that the
// thinking of a local model can be shown as thoughts rather than guessed at
// from tags in its reply (see ../../harness/thoughts.ts).
//
// The local server may not be Ollama at all (llama.cpp server, LM Studio), so
// this wraps the OpenAI-compatible provider and hands over to it when the
// server doesn't answer as Ollama does.

import type { ChatEvent, ChatMessage, Provider, Usage } from '../../types';
import type { ChatRequest } from '../../types';
import { ensureLoaded, rootURL } from '../ollama';
import { failure, patientFetch } from '../transport';
import { stopped } from './stopped';

export interface OllamaOptions {
  // The server's OpenAI-compatible URL (".../v1"), as in the settings
  baseURL: string;
  apiKey: string;
  // Tokens of context a model is loaded with if it doesn't say what it can take
  contextLength: number;
  // The most context any model is loaded with, whatever it can take
  maxContext?: number;
  // The same, for a model that has only been asked brief things
  briefContextLength: number;
  // Up to what size, in bytes, a model is small enough to serve a brief
  // request alongside the one answering rather than waiting for it
  smallModelBytes: number;
  // How long a model the classifier or the describer asks is kept in memory,
  // in Ollama's own notation, so that it is not loaded again on every message
  briefKeepAlive: string;
  // The same for a model that only answers, which is kept for less
  replyKeepAlive: string;
  // Lists the models, and chats with a server that isn't Ollama
  fallback: Provider;
}

// Converts the app's messages to Ollama's chat format.
export function toMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      if (!m.images?.length) return { role: 'tool', tool_name: m.name, content: m.content };
      return {
        role: 'tool',
        tool_name: m.name,
        content: m.content,
        // One whose bytes fell out of the sidecar's cap (see renderer/threads.ts)
        // is only a name now, and has nothing to send
        images: m.images.filter((i) => i.data).map((i) => i.data),
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.input ?? {} },
        })),
      };
    }
    // A user turn with pictures carries them the way a tool result does; a
    // word-only turn is unchanged. A name with no bytes behind it is left out,
    // as in the tool path above.
    if (m.role === 'user' && m.images?.length) {
      return { role: 'user', content: m.content, images: m.images.filter((i) => i.data).map((i) => i.data) };
    }
    return { role: m.role, content: m.content };
  });
}

// Yields each JSON object of a response that has one per line.
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

// Ollama gives a tool's input as an object; some models still send a string
function toInput(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'string') return (args ?? {}) as Record<string, unknown>;
  try {
    return JSON.parse(args || '{}');
  } catch {
    return null;
  }
}

// What /api/show says of a model, as far as this provider cares
interface ModelFacts {
  able: string[];
  contextLimit?: number;
}

// The most context a model was made for, which Ollama files under the name of
// the model's architecture ("llama.context_length"). Undefined if it doesn't say.
function contextLimitOf(info?: Record<string, unknown> | null): number | undefined {
  const limit = info?.[`${info['general.architecture']}.context_length`];
  return typeof limit === 'number' && limit > 0 ? limit : undefined;
}

export function createOllamaProvider({
  baseURL,
  apiKey,
  contextLength,
  maxContext,
  briefContextLength,
  smallModelBytes,
  briefKeepAlive,
  replyKeepAlive,
  fallback,
}: OllamaOptions): Provider {
  const root = rootURL(baseURL);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Asked once; a server that couldn't be reached is asked again next time
  let ollama: Promise<boolean> | null = null;
  function isOllama(): Promise<boolean> {
    ollama ??= patientFetch(`${root}/api/version`, { headers, signal: AbortSignal.timeout(3000) }).then(
      (res) => res.ok,
      () => {
        ollama = null;
        return false;
      }
    );
    return ollama;
  }

  // What each model can do, as Ollama reports it: "completion" for the models
  // that answer messages, "thinking", "tools", "embedding" and so on, and the
  // most context it can take. Asked about once per model; a model that
  // couldn't be asked about is asked about again next time, and comes back as
  // nothing known in the meantime.
  const abilities = new Map<string, Promise<ModelFacts>>();
  function factsAbout(model: string, signal?: AbortSignal): Promise<ModelFacts> {
    let asking = abilities.get(model);
    if (!asking) {
      asking = patientFetch(`${root}/api/show`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model }),
        signal,
      }).then(
        async (res) => {
          if (!res.ok) return { able: [] };
          // An Ollama too old to list a model's capabilities says nothing here
          const body = (await res.json().catch(() => ({}))) as {
            capabilities?: string[] | null;
            model_info?: Record<string, unknown> | null;
          };
          return { able: body.capabilities ?? [], contextLimit: contextLimitOf(body.model_info) };
        },
        () => {
          abilities.delete(model);
          return { able: [] };
        }
      );
      abilities.set(model, asking);
    }
    return asking;
  }
  const capabilities = async (model: string, signal?: AbortSignal) => (await factsAbout(model, signal)).able;

  // A model that answers messages at all. An embedding model does not: it
  // turns text into a vector and has no reply in it, so offering one to the
  // router or the classifier would put a model that cannot answer in front of
  // a message that needs answering. A model that says nothing about what it
  // can do is taken at face value and kept, since an older Ollama reports
  // nothing for any of them.
  const completes = async (model: string) => {
    const able = await capabilities(model);
    return able.length === 0 || able.includes('completion');
  };

  const canReason = async (model: string, signal?: AbortSignal) =>
    (await capabilities(model, signal)).includes('thinking');

  // What Ollama says each model takes up, learned when the models are listed.
  // A model whose size isn't known is treated as too big to hold alongside
  // another, which is the safe way round.
  const sizes = new Map<string, number>();
  async function readSizes(): Promise<void> {
    try {
      const res = await patientFetch(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const { models } = (await res.json()) as { models?: { name: string; size: number }[] | null };
      sizes.clear();
      for (const m of models ?? []) sizes.set(m.name, m.size);
    } catch {
      // Left as it was: the sizes only decide what may skip the queue
    }
  }
  // Ollama lists "llama3.2" as "llama3.2:latest"
  const sizeOf = (model: string) => sizes.get(model) ?? sizes.get(`${model}:latest`);

  // What is in flight per model, and how much of it is not brief. Both decide
  // whether another request may be served alongside it rather than waiting its
  // turn: what a brief request must not reach is the same model being answered
  // from, which asks for the full context length (see contextFor) and which
  // Ollama would load again in the middle of both.
  const running = new Map<string, { count: number; full: number }>();
  function began(model: string, brief: boolean): () => void {
    const held = running.get(model) ?? { count: 0, full: 0 };
    held.count += 1;
    if (!brief) held.full += 1;
    running.set(model, held);
    return () => {
      const left = running.get(model);
      if (!left) return;
      if (!brief) left.full -= 1;
      if (left.count > 1) left.count -= 1;
      else running.delete(model);
    };
  }

  // Whether this is a brief request to a model small enough to sit in memory
  // beside the one that answers. Only skipping the queue is decided by it:
  // that is about whether a second model fits, and a big one does not. How
  // long a model is held is a separate question, decided below.
  const briefAndSmall = (req: Pick<ChatRequest, 'model' | 'brief'>) =>
    !!req.brief && (sizeOf(req.model) ?? Infinity) <= smallModelBytes;

  // The models the classifier and the describer ask. They are held for longer
  // than the model that answers, whatever their size: a model asked for once
  // per message is the one that falls outside Ollama's five minutes again and
  // again, and a model too big to sit beside the answering model is also the
  // most expensive to load afresh. Keeping either also keeps the work it has
  // done on the prompt, which is most of what a long conversation costs (see
  // ../ollama.REPLY_KEEP_ALIVE).
  //
  // Remembered per model rather than read off each request, because Ollama
  // takes every request's keep_alive as the new one. One model may serve both
  // kinds of request - which is what the classifier's size floor makes of it,
  // the cheapest model worth asking now being one that can also answer (see
  // ../../harness/classifier.FLOOR) - and classifying a message is followed
  // directly by replying to it, so a per-request clock would be set to the
  // longer one and then back to the shorter one on every single message.
  const pinned = new Set<string>();
  function keepAliveFor(req: Pick<ChatRequest, 'model' | 'brief'>): string {
    if (req.brief) pinned.add(req.model);
    return pinned.has(req.model) ? briefKeepAlive : replyKeepAlive;
  }

  // Models that have been given the full context length. Changing a model's
  // context length makes Ollama load it again, so once a model has had the
  // full length it keeps it, even for brief requests. Neither is more than the
  // model can take: Ollama would load it with less than it was asked for, and a
  // length that never matches what is loaded means loading it every time.
  const fullLength = (contextLimit?: number) => Math.min(contextLimit ?? contextLength, maxContext ?? Infinity);
  const wide = new Set<string>();
  async function contextFor(req: Pick<ChatRequest, 'model' | 'brief'>, signal?: AbortSignal): Promise<number> {
    const brief = req.brief && !wide.has(req.model);
    if (!brief) wide.add(req.model);
    const full = fullLength((await factsAbout(req.model, signal)).contextLimit);
    return brief ? Math.min(briefContextLength, full) : full;
  }

  return {
    ...fallback,

    // A brief request (classifying a message, describing a thread) goes to a
    // small model with a small context window, which Ollama can keep in
    // memory beside the model that is answering. So it need not wait for the
    // answer to finish; a reply cannot start until classification is done, so
    // that wait is the whole of it. Nothing else skips the queue: a reply is
    // given the full context window whatever model serves it.
    //
    // What it may not join is the same model being answered from, which holds
    // it at the full context length. Another brief request to it is no such
    // bar: two threads classifying at once are one small model answering twice
    // at the one context length, and making the second wait puts it in the
    // provider's queue behind whatever long reply is running - a wait that is
    // not held against its time limit, and so has no end to it. That was
    // measured at 89 seconds behind a subagent, for work of three tokens.
    concurrent: (req) => briefAndSmall(req) && (running.get(req.model)?.full ?? 0) === 0,

    // Ollama loads each model with the context length it is asked for here,
    // all it can take unless the settings say less, and says which of them can
    // reason. The
    // models that cannot answer a message at all are left out (see completes).
    async listModels() {
      const models = await fallback.listModels();
      if (!(await isOllama())) return models;
      await readSizes();
      const described = await Promise.all(models.map(async (m) => ({ model: m, ...(await factsAbout(m.id)) })));
      return described
        .filter(({ able }) => able.length === 0 || able.includes('completion'))
        .map(({ model, able, contextLimit }) => ({
          ...model,
          contextWindow: fullLength(contextLimit),
          reasons: able.includes('thinking'),
          vision: able.includes('vision'),
        }));
      // Leaving them out of the list is most of it; stream() turns one away
      // outright, for a model picked before this and saved with a thread
    },

    // A local model has to be loaded into memory before it can answer
    ensureUp: async (model, signal, req) =>
      ensureLoaded(
        { baseURL, apiKey },
        model,
        signal,
        await contextFor(req ?? { model }, signal),
        keepAliveFor(req ?? { model })
      ),

    async *stream(req, signal): AsyncGenerator<ChatEvent> {
      const ended = began(req.model, Boolean(req.brief));
      try {
        yield* answer(req, signal);
      } finally {
        ended();
      }
    },
  };

  async function* answer(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    if (!(await isOllama())) {
      yield* fallback.stream(req, signal);
      return;
    }
    // A model with no reply in it, asked for one: it is left out of the list
    // of models, but a thread that saved one before now would still ask
    if (!(await completes(req.model))) {
      yield {
        type: 'error',
        code: 'other',
        message:
          `${req.model} cannot answer messages: it turns text into vectors and has no reply in it. ` +
          'Choose another model.',
      };
      return;
    }
    const messages = toMessages(req.messages);
    if (req.system) messages.unshift({ role: 'system', content: req.system });
    const options: Record<string, unknown> = { num_ctx: await contextFor(req, signal) };
    if (req.maxTokens) options.num_predict = req.maxTokens;
    const body: Record<string, unknown> = { model: req.model, messages, stream: true, options };
    // Ollama puts a model back on its default five-minute clock on every
    // request that does not say otherwise, so the pin is renewed here as well
    // as on the load (see ../ollama.BRIEF_KEEP_ALIVE)
    body.keep_alive = keepAliveFor(req);
    // A model that can reason does so unless it is told not to, so a model
    // that can is told either way: to reason on a request that is worth the
    // tokens and the wait, and not to on a brief one, whose short context
    // window (see ../ollama.ts) its reasoning would fill before it answered.
    // A request that says outright whether it wants reasoning is obeyed.
    if (await canReason(req.model, signal)) body.think = req.think ?? !req.brief;
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }

    try {
      let res: Response;
      try {
        // What the request is for goes with it, as the log has it: Ollama takes no notice, and the stand-in the
        // app is tested against answers by it (see ../../scripts/fake-ollama.ts)
        const purpose = req.log?.purpose;
        res = await patientFetch(`${root}/api/chat`, {
          method: 'POST',
          headers: typeof purpose === 'string' ? { ...headers, 'X-Ch-Purpose': purpose } : headers,
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
          code: res.status === 401 || res.status === 403 ? 'auth' : 'other',
          status: res.status,
          message: `HTTP ${res.status}: ${detail.slice(0, 300)}`,
        };
        return;
      }

      let stopReason = 'end_turn';
      let usage: Usage | undefined;
      let called = false;
      for await (const part of readLines(res.body)) {
        if (part.error) {
          yield { type: 'error', code: 'other', message: String(part.error) };
          return;
        }
        // The model's own reasoning, which Ollama reports apart from the
        // reply and which is never part of it
        if (part.message?.thinking) yield { type: 'reasoning', delta: part.message.thinking };
        if (part.message?.content) yield { type: 'text', delta: part.message.content };
        for (const call of part.message?.tool_calls ?? []) {
          called = true;
          yield {
            type: 'tool_call',
            // Ollama doesn't always number its calls, and the app tells them apart by id
            id: call.id || crypto.randomUUID(),
            name: call.function?.name ?? '',
            input: toInput(call.function?.arguments),
          };
        }
        if (part.done) {
          if (part.done_reason) stopReason = stopped(part.done_reason);
          if (part.prompt_eval_count !== undefined || part.eval_count !== undefined) {
            usage = {
              input: part.prompt_eval_count ?? 0,
              output: part.eval_count ?? 0,
              // What of the prompt the server had in hand from the request
              // before and did not work through again. It costs nothing here
              // — a local model is the user's own electricity — but it is the
              // difference between a step that answers at once and one that
              // reads the whole conversation again first, which is most of
              // what a tool loop spends its time on. prompt_eval_count counts
              // the whole prompt either way, so this is a part of it rather
              // than something beside it, as it is on the hosted providers
              // (see Usage).
              ...(part.prompt_eval_cached_count ? { cacheRead: part.prompt_eval_cached_count } : {}),
            };
          }
        }
      }
      // Ollama reports a round of tool calls as an ordinary ending, so the
      // calls themselves are what says the model is not finished
      yield { type: 'done', stopReason: called && stopReason === 'end_turn' ? 'tool_use' : stopReason, usage };
    } catch (err) {
      if (signal.aborted) yield { type: 'done', stopReason: 'cancelled' };
      else yield { type: 'error', code: 'other', message: (err as Error).message };
    }
  }
}
