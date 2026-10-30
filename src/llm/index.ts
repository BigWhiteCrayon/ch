// Provider registry: the single entry point the app uses to talk to models.
// The request, event and provider shapes are defined in ../types.ts; the
// harness chooses which provider and model serve a request (see
// ../harness/router.ts).

import type {
  ChatEvent,
  ChatRequest,
  ErrorEvent,
  ListModelsOptions,
  ModelInfo,
  ModelList,
  Provider,
  ProviderModel,
  Settings,
  ToolCall,
} from '../types';
import * as log from '../log';
import { BRIEF_CONTEXT_LENGTH, BRIEF_KEEP_ALIVE, CONTEXT_LENGTH, REPLY_KEEP_ALIVE, SMALL_MODEL_BYTES } from './ollama';
import * as cachelock from './cachelock';
import { bySophistication, resolveSophistication, setOverrides } from './sophistication';
import { createAnthropicProvider } from './providers/anthropic';
import { createOllamaProvider } from './providers/ollama';
import { createOpenAICompatibleProvider } from './providers/openai-compatible';
import { estimate, sizeOf } from './tokens';
import { recover } from './toolcalls';

const OPENAI_URL = 'https://api.openai.com/v1';
// OpenAI lists every model it hosts; hide the ones that aren't chat models.
const OPENAI_NOT_CHAT = /embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|sora|davinci|babbage/;

const providers = new Map<string, Provider>();
// "provider/model" keys the user has switched off
const disabled = new Set<string>();
// Whether the app is to keep to the user's own computer. A hosted provider is
// then not asked for its models, not offered, and not served: the switch is
// about what leaves the machine, so it has to hold where the requests are
// made and not only where they are chosen (see listModels and answer).
let offline = false;
export const OFFLINE_REASON = 'Offline is switched on, so models on other computers are not used.';
const away = (provider: Provider) => offline && !provider.local;
// Whether the switch is on, for the work that has to ask before it looks for a
// model on another computer rather than after (see ../harness/compactor.ts)
export const isOffline = (): boolean => offline;
// Whether that provider is on this computer; false for one there is no such
// provider for, since nothing unknown is to be taken for local
export const isLocal = (provider: string): boolean => providers.get(provider)?.local === true;
// Whether work is to be served by a hosted model where one is capable enough,
// for the speed of it. Which model that is the router's to settle (see
// harness/router.ts); this only says what the user wants.
let fast = false;
export const isFast = (): boolean => fast;
// Provider id -> when (ms since the epoch) it is to be tried again after it
// said the credit or quota behind it is gone. Asking it again meanwhile would
// only be turned away again, so requests go elsewhere (see stream).
const spent = new Map<string, number>();
const SPEND_COOLDOWN_MS = 30 * 60_000;
// Whether that provider is out of credit, forgetting it once its time is up
function isSpent(provider: string): boolean {
  const until = spent.get(provider);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    spent.delete(provider);
    return false;
  }
  return true;
}
export const SPENT_REASON = 'Its spending limit has been reached, so other models are used for now.';
// The highest sophistication (1-5) that is used without asking the user first
let ceiling = 5;
export const approvalCeiling = (): number => ceiling;
// Provider id -> recent model list, so that routing every message doesn't
// mean asking every provider for its models every time
const modelCache = new Map<string, { at: number; models: ProviderModel[] }>();
const MODEL_CACHE_MS = 60000;

export function register(provider: Provider): void {
  providers.set(provider.id, provider);
  modelCache.delete(provider.id);
}

// (Re)builds the providers from the user's settings (see ../settings.ts).
export function configure(settings: Settings): void {
  providers.clear();
  modelCache.clear();
  // New keys may well have credit behind them
  spent.clear();
  // The models themselves are being rebuilt, and whatever one of them was
  // holding a prompt for went with the provider that spoke to it
  cachelock.forget();
  register(createAnthropicProvider({ apiKey: settings.anthropic.apiKey }));
  register(
    createOpenAICompatibleProvider({
      id: 'openai',
      name: 'OpenAI',
      baseURL: OPENAI_URL,
      apiKey: settings.openai.apiKey,
      local: false,
      requiresKey: true,
      modelFilter: (modelId) => !OPENAI_NOT_CHAT.test(modelId),
    })
  );
  // Ollama is spoken to in its own way, which lets it be given a wider
  // context window; any other local server gets the OpenAI-compatible one
  const local = createOllamaProvider({
    ...settings.local,
    contextLength: CONTEXT_LENGTH,
    briefContextLength: BRIEF_CONTEXT_LENGTH,
    smallModelBytes: SMALL_MODEL_BYTES,
    briefKeepAlive: BRIEF_KEEP_ALIVE,
    replyKeepAlive: REPLY_KEEP_ALIVE,
    fallback: createOpenAICompatibleProvider({
      id: 'local',
      name: 'Local',
      baseURL: settings.local.baseURL,
      apiKey: settings.local.apiKey,
      local: true,
    }),
  });
  register(local);
  setOverrides(settings.sophistication);
  offline = settings.offline;
  fast = settings.fast;
  ceiling = settings.approvalCeiling ?? 5;

  disabled.clear();
  for (const providerId of ['anthropic', 'openai'] as const) {
    for (const modelId of settings[providerId].disabledModels) {
      disabled.add(`${providerId}/${modelId}`);
    }
  }
}

async function providerModels(provider: Provider, fresh: boolean): Promise<ProviderModel[]> {
  const cached = modelCache.get(provider.id);
  if (!fresh && cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  const models = await provider.listModels();
  modelCache.set(provider.id, { at: Date.now(), models });
  return models;
}

// Lists the models of every provider, most sophisticated first. A provider
// that fails (no API key, server not running) is reported, not thrown.
// Models the user switched off are left out unless includeDisabled is set.
// Lists are cached for a minute; fresh asks the providers again.
export async function listModels({
  includeDisabled = false,
  fresh = false,
}: ListModelsOptions = {}): Promise<ModelList> {
  const results = await Promise.all(
    [...providers.values()].map(async (provider) => {
      // Not even asked what it has: asking is a request to it
      if (away(provider)) {
        return { status: { id: provider.id, name: provider.name, ok: false, error: OFFLINE_REASON }, models: [] };
      }
      // Nor is it asked while it is known to be turning requests away
      if (isSpent(provider.id)) {
        return { status: { id: provider.id, name: provider.name, ok: false, error: SPENT_REASON }, models: [] };
      }
      try {
        const models = await providerModels(provider, fresh);
        return {
          status: { id: provider.id, name: provider.name, ok: true },
          models: models.map((m) => ({
            ...m,
            provider: provider.id,
            providerName: provider.name,
            local: provider.local,
            sophistication: resolveSophistication(provider.id, m.id),
            disabled: disabled.has(`${provider.id}/${m.id}`),
          })),
        };
      } catch (err) {
        return {
          status: {
            id: provider.id,
            name: provider.name,
            ok: false,
            error: (err as Error).message,
          },
          models: [],
        };
      }
    })
  );
  return {
    models: results
      .flatMap((r) => r.models)
      .filter((m) => includeDisabled || !m.disabled)
      .sort(bySophistication),
    providers: results.map((r) => r.status),
  };
}

// Local models usually can't serve requests in parallel, so requests to a
// local provider wait their turn. A priority request (classification, which
// is quick and holds up a whole reply) goes ahead of the others that are
// waiting. It does not interrupt the request already running.
//
// A provider may say a request needn't wait at all (Provider.concurrent): a
// small model can be held in memory beside the one answering, so a brief
// request to it skips the queue instead of holding up a reply (see
// providers/ollama.ts).
//
// ...and a request that a local model is not holding its prompt for waits for
// the conversation it is holding one for, which is a wait of its own: the
// request before it has finished, and what it is waiting on is the gap between
// two steps of somebody else's reply (see cachelock.ts).
interface Waiter {
  priority: boolean;
  // The model this is for, as the holds are keyed (see cachelock.modelKey)
  model: string;
  // Whose prompt it is, where it is anyone's (see ChatRequest.cacheKey)
  key?: string;
  start: () => void;
}

interface Queue {
  busy: boolean;
  waiting: Waiter[];
  // Set while something is waiting on a hold and nothing else can start it:
  // the hold running out is not an event, so the queue comes back to it
  timer?: ReturnType<typeof setTimeout>;
}

const queues = new Map<string, Queue>();

function queueFor(providerId: string): Queue {
  let queue = queues.get(providerId);
  if (!queue) {
    queue = { busy: false, waiting: [] };
    queues.set(providerId, queue);
  }
  return queue;
}

// Starts the next request that may go now, if any may and nothing is running.
//
// Which that is, in order: a priority request, which holds up a whole reply and
// has no prompt of its own to keep; then the conversation the model is already
// holding its prompt for, whose next step is most of what the holding is for;
// then the longest-waiting request that no hold is against. Where every request
// waiting is behind a hold, the queue waits with them and comes back when the
// first of those holds runs out.
function pump(queue: Queue): void {
  if (queue.timer !== undefined) {
    clearTimeout(queue.timer);
    delete queue.timer;
  }
  if (queue.busy) return;
  const now = Date.now();
  let soonest = Infinity;
  const next =
    queue.waiting.find((w) => w.priority) ??
    queue.waiting.find((w) => w.key !== undefined && cachelock.holder(w.model, now) === w.key) ??
    queue.waiting.find((w) => {
      const left = cachelock.waitFor(w.model, w.key, now);
      if (left > 0) soonest = Math.min(soonest, left);
      return left === 0;
    });
  if (!next) {
    if (soonest < Infinity) {
      queue.timer = setTimeout(() => pump(queue), soonest);
      queue.timer.unref?.();
    }
    return;
  }
  queue.waiting.splice(queue.waiting.indexOf(next), 1);
  queue.busy = true;
  // What the model holds from here is this request's prompt
  cachelock.held(next.model, next.key, now);
  next.start();
}

// Whether a request would have to wait, which is what whoever asked is told
// before it does (see the 'queued' event). A priority request waits for the
// one running and for nothing else.
function willWait(providerId: string, request: ChatRequest): boolean {
  if (queues.get(providerId)?.busy) return true;
  if (request.priority) return false;
  return cachelock.waitFor(cachelock.modelKey(request.provider, request.model), request.cacheKey) > 0;
}

// Resolves, once it is this request's turn, with the function that ends it
function acquire(providerId: string, request: ChatRequest, signal: AbortSignal): Promise<() => void> {
  // A request given up before its turn never takes one
  if (signal.aborted) return Promise.resolve(() => {});
  const queue = queueFor(providerId);
  const model = cachelock.modelKey(request.provider, request.model);
  const release = () => {
    // The model is still holding this request's prompt, and keeps holding it
    // for a while yet: the next step of this reply is worth more to it than
    // the longest-waiting request is (see cachelock.HOLD_MS)
    cachelock.held(model, request.cacheKey);
    queue.busy = false;
    pump(queue);
  };
  return new Promise((resolve) => {
    const waiter: Waiter = {
      priority: Boolean(request.priority),
      model,
      key: request.cacheKey,
      start: () => {
        signal.removeEventListener('abort', onAbort);
        resolve(release);
      },
    };
    // A request given up while it waits leaves the queue, and holds up nobody
    const onAbort = () => {
      const at = queue.waiting.indexOf(waiter);
      if (at !== -1) queue.waiting.splice(at, 1);
      resolve(() => {});
      pump(queue);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    queue.waiting.push(waiter);
    pump(queue);
  });
}

// A hold given up is a model somebody waiting may now have (see
// cachelock.broke, which is where a conversation says its prompt is gone)
cachelock.whenFreed(() => {
  for (const queue of queues.values()) pump(queue);
});

// How long a local model may take to load before a request that asked for it
// to be brought up gives in
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;

// Whether a request's time limit covers bringing the model up as well as
// answering, rather than only the answer.
//
// A reply is worth waiting for, so it is given the long load budget and then
// its own limit to answer in. A request that something else is waiting on is
// not: a classification holds up the whole reply, so a model still coming up
// when the limit is gone has already failed it, whatever it writes afterwards.
// Those get one budget for the two together, and are turned down while there
// is still time to do something else instead. Waiting for a turn is outside
// both: a brief request skips the queue (see providers/ollama.concurrent).
const wholeBudget = (request: ChatRequest) => Boolean(request.brief || request.priority);

// A length of time as the model's user would say it: "30 seconds", "5 minutes"
const howLong = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`;

// A signal that aborts after `ms`, unless that is called off first
function deadline(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// Never throws: failures arrive as an 'error' event. Everything the model is
// sent, and everything it writes back, is logged.
// What a request does when the provider says it is being asked for too much.
// Waiting and asking again is what a rate limit is for: the alternative is
// handing the user a failure for something that would have worked a moment
// later. Several subagents turned away at the same moment would otherwise all
// come back at the same moment, so each wait is given a little randomness.
const RATE_LIMIT_TRIES = 4;
const BACKOFF_MS = 2000;
const BACKOFF_CEILING_MS = 60000;
const BACKOFF_JITTER = 0.25;

// How long to wait before trying again: what the provider asked for if it
// said, else a doubling wait with a little randomness in it.
export function backoff(attempt: number, asked?: number, random = Math.random): number {
  if (asked !== undefined && asked > 0) return Math.min(asked, BACKOFF_CEILING_MS);
  const doubled = Math.min(BACKOFF_MS * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
  return Math.round(doubled * (1 + (random() * 2 - 1) * BACKOFF_JITTER));
}

// How often a request that has to estimate its own token count says so, while
// the reply is being written. Often enough to look live, seldom enough that
// the window is not redrawn for a figure that has not visibly changed; the
// text arriving redraws it far more often than this anyway.
const ESTIMATE_EVERY_MS = 250;

// Waits, unless whoever asked has given up first
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

// Where a request goes when the provider it was for has run out of credit: a
// model on another hosted provider if there is one, the most sophisticated
// first; failing that one on this computer, which costs nothing. A level-0
// model is as good as none for a reply (see route in ../harness/router.ts),
// but is better than the error here. Providers that are spent, or failing, or
// away are not in the list (see listModels).
async function replacement(): Promise<ModelInfo | undefined> {
  const { models } = await listModels();
  const others = models.filter((m) => !isSpent(m.provider));
  return others.find((m) => !m.local) ?? others.find((m) => m.local);
}

export async function* stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  // Pairs the output's log line with the input's
  const where = { ...request.log, call: crypto.randomUUID(), provider: request.provider, model: request.model };
  log.content('llm.input', {
    ...where,
    system: request.system,
    messages: request.messages,
    // The tools are described in the code; their names say which were offered
    tools: request.tools?.map((tool) => tool.name),
    maxTokens: request.maxTokens,
  });

  const started = performance.now();
  let text = '';
  // How long this request waited its turn, which is none of the model's doing
  let queuedMs = 0;
  // Whether the provider counts as it streams. The ones that do are left to
  // it; for the rest — Ollama counts only in its last line, and most
  // OpenAI-compatible servers in a chunk after the reply — the count is
  // estimated from what has arrived so that the window has something to show
  // while a pass runs (see TokensEvent). The provider's own count replaces it
  // either way, and an estimate is never recorded.
  let counting = false;
  // Before any time at all, so the first thing the model writes is counted
  // whatever the clock reads: a test with the clock held still, or a process
  // only just up, would otherwise have to wait out the interval below for a
  // count it should have had at once.
  let estimatedAt = -Infinity;
  // What the prompt comes to, which does not change while the reply is written
  const promptTokens = sizeOf(request.messages, request.system);
  // What the model reasoned, for a provider that reports it (see ReasoningEvent)
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  // How the reply ended; stays as it is if the model just stopped, or whoever
  // asked stopped listening
  let ending: log.Fields = { ok: false, error: 'The reply stopped before it finished.' };
  // Attempts made, for the log: a request answered first time says nothing
  let attempts = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      attempts = attempt;
      // Whether anything of an answer has arrived in this attempt. A reply
      // part written is not one to start again: what the caller has had of it
      // would be said twice.
      let answering = false;
      let limited: ErrorEvent | undefined;
      let broke: ErrorEvent | undefined;
      for await (const event of asked(request, signal)) {
        if (event.type === 'error' && event.code === 'spend_limit' && !answering) {
          broke = event;
          break;
        }
        if (event.type === 'error' && event.code === 'rate_limit' && !answering && attempt < RATE_LIMIT_TRIES) {
          limited = event;
          break;
        }
        if (event.type === 'text') {
          text += event.delta;
          answering = true;
        } else if (event.type === 'tokens') counting = true;
        else if (event.type === 'waited') queuedMs = event.ms;
        else if (event.type === 'reasoning') {
          thinking += event.delta;
          answering = true;
        } else if (event.type === 'tool_call') {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          answering = true;
        } else if (event.type === 'done') ending = { ok: true, stopReason: event.stopReason, usage: event.usage };
        else if (event.type === 'error')
          ending = { ok: false, code: event.code, status: event.status, error: event.message };
        yield event;
        // ...and, where the provider itself says nothing until the end, what
        // the reply has come to so far. After the event rather than before it,
        // so the count is of what the caller has already been given.
        if (!counting && (event.type === 'text' || event.type === 'reasoning')) {
          const now = performance.now();
          if (now - estimatedAt >= ESTIMATE_EVERY_MS) {
            estimatedAt = now;
            yield {
              type: 'tokens',
              estimated: true,
              usage: { input: promptTokens, output: estimate(text + thinking) },
            };
          }
        }
      }
      if (broke) {
        if (!isSpent(request.provider)) spent.set(request.provider, Date.now() + SPEND_COOLDOWN_MS);
        log.warn('llm.spend_limit', { ...where, error: broke.message });
        const instead = await replacement();
        if (instead && !signal.aborted) {
          ending = { ok: false, code: broke.code, error: broke.message };
          yield {
            type: 'fell_back',
            from: `${request.provider}/${request.model}`,
            to: `${instead.provider}/${instead.id}`,
          };
          yield* stream({ ...request, provider: instead.provider, model: instead.id }, signal);
          return;
        }
        ending = { ok: false, code: broke.code, status: broke.status, error: broke.message };
        yield broke;
        break;
      }
      if (!limited) break;
      const after = backoff(attempt, limited.retryAfterMs);
      log.warn('llm.rate_limited', { ...where, attempt, of: RATE_LIMIT_TRIES, after, error: limited.message });
      yield { type: 'rate_limited', attempt, of: RATE_LIMIT_TRIES, after, message: limited.message };
      await wait(after, signal);
      // Given up on while it waited: the error it was turned away with stands
      if (signal.aborted) {
        ending = { ok: false, code: limited.code, status: limited.status, error: limited.message };
        yield limited;
        break;
      }
    }
  } finally {
    log.content('llm.output', {
      ...where,
      ms: log.since(started),
      ...(queuedMs ? { queuedMs } : {}),
      ...(attempts > 1 ? { attempts } : {}),
      ...ending,
      thinking,
      text,
      toolCalls,
    });
  }
}

// The provider's reply, with any tool calls the model wrote into the message
// as text turned back into calls (see ./toolcalls.ts). Only where tools were
// offered at all: without them there is nothing a block of markup could be,
// and text that looks like one is text.
function asked(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const events = answer(request, signal);
  if (!request.tools?.length) return events;
  const offered = new Set(request.tools.map(({ name }) => name));
  return recover(events, (name) => offered.has(name));
}

async function* answer(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const provider = providers.get(request.provider);
  if (!provider) {
    yield { type: 'error', code: 'other', message: `Unknown provider "${request.provider}"` };
    return;
  }
  if (disabled.has(`${request.provider}/${request.model}`)) {
    yield { type: 'error', code: 'other', message: `${request.model} is switched off in Settings.` };
    return;
  }
  // Whoever asked for this chose a model before the switch was thrown, or
  // kept one that is no longer on offer
  if (away(provider)) {
    yield { type: 'error', code: 'other', message: OFFLINE_REASON };
    return;
  }
  if (isSpent(request.provider)) {
    yield { type: 'error', code: 'spend_limit', message: `${provider.name}: ${SPENT_REASON}` };
    return;
  }

  // A request the provider will serve alongside others never waits
  const waits = provider.local && !provider.concurrent?.(request);
  // Whoever asked is told when there is a wait, so they can say so
  const waiting = Boolean(waits && willWait(provider.id, request));
  if (waiting) yield { type: 'queued' };
  const queued = performance.now();
  const release = waits ? await acquire(provider.id, request, signal) : null;
  const where = { provider: request.provider, model: request.model };
  const waited = log.since(queued);
  // Time spent behind other requests isn't the model being slow, so how long
  // the wait came to is reported on its own, to be taken off the model's own
  // timings (see WaitedEvent). It answers the 'queued' above, and so is sent
  // whenever that was, rather than only when the wait came to a whole
  // millisecond: a metric that appears and disappears is worse than a zero.
  if (waiting) yield { type: 'waited', ms: waited };
  if (waited > 0) log.debug('llm.queued', { ...where, ms: waited });
  try {
    if (signal.aborted) {
      yield { type: 'done', stopReason: 'cancelled' };
      return;
    }
    if (!request.timeoutMs) {
      yield* provider.stream(request, signal);
      return;
    }

    // A request with a time limit: the model is brought up first, so that the
    // limit is spent on the answer and not on waiting for the model to load.
    // For a request whose limit covers both, the load comes out of it, and
    // what is left is what there is to answer in (see wholeBudget).
    const whole = wholeBudget(request);
    const loadBudget = whole ? request.timeoutMs : LOAD_TIMEOUT_MS;
    const loading = deadline(loadBudget);
    const loadStarted = performance.now();
    try {
      await provider.ensureUp?.(request.model, AbortSignal.any([signal, loading.signal]), request);
      if (provider.ensureUp) log.debug('llm.load', { ...where, ok: true, ms: log.since(loadStarted) });
    } catch (err) {
      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      const reason = loading.signal.aborted ? `it did not load within ${howLong(loadBudget)}` : (err as Error).message;
      log.warn('llm.load', { ...where, ok: false, ms: log.since(loadStarted), error: reason });
      yield { type: 'error', code: 'other', message: `${request.model} could not be started: ${reason}` };
      return;
    } finally {
      loading.clear();
    }

    // What the load left of a shared budget. Nothing left is still a request
    // of its own: it is turned down at once rather than sent to a model whose
    // answer is already too late to be used.
    const toAnswerIn = whole ? Math.max(0, request.timeoutMs - log.since(loadStarted)) : request.timeoutMs;
    const answering = deadline(toAnswerIn);
    const timedOut = () => answering.signal.aborted && !signal.aborted;
    try {
      const events = provider.stream(request, AbortSignal.any([signal, answering.signal]));
      for await (const event of events) {
        // What a provider says once it has been cut off is not its answer
        if (timedOut()) break;
        yield event;
      }
    } finally {
      answering.clear();
    }
    if (timedOut()) {
      // toAnswerIn says how much of the limit the load had already spent,
      // which is what tells a model that is slow to answer from one that was
      // never given the time to
      log.warn('llm.timeout', {
        ...where,
        timeoutMs: request.timeoutMs,
        ...(toAnswerIn === request.timeoutMs ? {} : { toAnswerIn }),
      });
      yield {
        type: 'error',
        code: 'other',
        message: `${request.model} did not answer within ${request.timeoutMs / 1000} seconds.`,
      };
    }
  } catch (err) {
    log.error('llm.threw', { ...where, error: err });
    yield { type: 'error', code: 'other', message: (err as Error).message };
  } finally {
    release?.();
  }
}
