// Ollama's own API, used by the settings screen to show which models are
// downloaded and to download more. Chat itself goes through the generic
// OpenAI-compatible provider (see index.ts); this is only model management.

import type { LocalSettings, OllamaStatus, SuggestedModel } from '../types';
import { resolveSophistication } from './sophistication';

// Offered for download when not already present. All of these support tools.
// memoryGB follows Ollama's own guidance for models of each size: 8 GB for
// 7B models, 16 GB for 13B, 32 GB for 33B.
export const SUGGESTED: Omit<SuggestedModel, 'sophistication'>[] = [
  { name: 'llama3.2:3b', memoryGB: 4 },
  { name: 'llama3.1:8b', memoryGB: 8 },
  { name: 'qwen2.5:7b', memoryGB: 8 },
  { name: 'qwen2.5-coder:7b', memoryGB: 8 },
  { name: 'mistral:7b', memoryGB: 8 },
  { name: 'qwen2.5:14b', memoryGB: 16 },
  { name: 'qwen2.5:32b', memoryGB: 32 },
  // The one suggested model that takes images, for screenshots (see harness/router.ts)
  { name: 'qwen3-vl:8b', memoryGB: 8 },
];

// Tokens of context every model is loaded with. Ollama's own default, 4,096,
// is used up by the system prompt and a tool result or two; more than this
// costs memory and time that a laptop doesn't have to spare.
export const CONTEXT_LENGTH = 32768;
// What a model is loaded with when all it is asked is something brief (see
// ChatRequest.brief). Two models seldom fit in memory at the full length, and
// the small one that classifies each message would otherwise push out the
// one that answers it, and be pushed out in turn, on every message.
export const BRIEF_CONTEXT_LENGTH = 4096;

// How long Ollama is asked to keep a model the classifier or the describer
// asks. Its own default is five minutes, which a model that classifies one
// message per conversational turn falls outside of again and again: it was
// found being loaded afresh on most messages, and each load cost more than the
// last as the machine filled up — three seconds, then twenty-seven, then a
// hundred and one, then a hundred and eighty-seven.
//
// Asked for whatever the model's size. It began as the pin for a small model
// held beside the one answering, where it was cheap by inspection: a 3B is
// about 2 GB, and the answering model was the one worth evicting, having a
// reply's worth of time to come back. The classifier now has a floor under it
// and asks a model big enough to answer with (see ../harness/classifier.FLOOR),
// which is the case the five minutes punishes hardest, there being that much
// more to read in again. Size still decides what may run beside the answer
// (see SMALL_MODEL_BYTES); it no longer decides what is held.
//
// Asked for on the load and on every brief request, because Ollama takes each
// request's keep_alive as the new one: a chat without it would put the model
// back on the five-minute clock the load just took it off.
export const BRIEF_KEEP_ALIVE = '30m';

// ...and how long a model that only answers is kept. Shorter, because this is
// the model whose memory a laptop wants back, but longer than Ollama's five
// minutes, which a conversation falls outside of whenever the user takes a few
// minutes over their next message. A model that also classifies is held for
// the longer time instead, that being the request it would be reloaded for.
//
// What is lost with it is not only the load: Ollama keeps the work it did on
// the prompt and reuses it for whatever the next prompt begins with, so a
// thread of fifteen thousand tokens that is evicted pays to have all of them
// read again. Measured on a 5,600-token prompt, the difference between a
// prompt Ollama still had and the same one after an eviction was 24ms against
// 12,091ms (see prompt_eval_cached_count on its replies).
export const REPLY_KEEP_ALIVE = '15m';

// A model this size or smaller, in bytes, is one Ollama can hold in memory
// alongside the model that is answering, so a brief request to it runs
// straight away rather than waiting its turn (see providers/ollama.ts).
// Ollama holds several models at once of its own accord; what it will not do
// is fit a big second one, and loading that would push the answering model
// out, which costs far more than the wait saved. This covers the 3B-class
// models, not the 7B and larger ones that answer.
//
// Only concurrency turns on this. A brief request to a model above the line
// waits its turn and is still held in memory afterwards (BRIEF_KEEP_ALIVE),
// and when that model is the one answering there was never a second copy to
// fit: the wait is for the model to be free, not for memory.
export const SMALL_MODEL_BYTES = 4 * 1024 ** 3;

// The local provider's URL points at Ollama's OpenAI-compatible endpoint
// (".../v1"); the native API lives at the server root.
export const rootURL = (baseURL: string) => baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');

function headers(apiKey: string): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
}

export async function status({ baseURL, apiKey }: LocalSettings): Promise<OllamaStatus> {
  const url = rootURL(baseURL);
  try {
    const res = await fetch(`${url}/api/tags`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models } = (await res.json()) as { models?: { name: string; size: number }[] | null };
    const installed = (models ?? []).map((m) => ({ name: m.name, size: m.size }));
    const names = new Set(installed.map((m) => m.name));
    const suggested = SUGGESTED.filter((m) => !names.has(m.name)).map((m) => ({
      ...m,
      // The level it would be routed by, including one the user has set
      sophistication: resolveSophistication('local', m.name),
    }));
    return { reachable: true, url, installed, suggested };
  } catch {
    return { reachable: false, url, installed: [], suggested: [] };
  }
}

// Makes sure a model is loaded into memory with the given context length,
// which Ollama otherwise does on the first request to it and which can take a
// while for a big model. A model loaded with another context length is loaded
// again, as the first request would otherwise make it. Resolves
// once it is loaded, or straight away if the server isn't Ollama (there is
// then no way to tell). Throws if Ollama could not load it.
export async function ensureLoaded(
  { baseURL, apiKey }: LocalSettings,
  model: string,
  signal: AbortSignal,
  contextLength = CONTEXT_LENGTH,
  // How long to keep it in memory afterwards, in Ollama's own notation
  // ("30m", "-1" for indefinitely). Left out, Ollama's default stands.
  keepAlive?: string
): Promise<void> {
  const url = rootURL(baseURL);
  let running: { name: string; context_length?: number }[];
  try {
    const res = await fetch(`${url}/api/ps`, { headers: headers(apiKey), signal });
    if (!res.ok) return;
    running = ((await res.json()) as { models?: typeof running | null }).models ?? [];
  } catch (err) {
    if (signal.aborted) throw err;
    return;
  }
  // Ollama lists "llama3.2" as "llama3.2:latest"
  const loaded = running.find((m) => m.name === model || m.name === `${model}:latest`);
  // An Ollama too old to say what it loaded the model with is taken at its word
  if (loaded && (loaded.context_length ?? contextLength) === contextLength) return;

  // A request with no prompt loads the model and answers once it is ready
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: contextLength },
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
    }),
    signal,
  });
  const body = await res.text();
  if (res.ok) return;
  // Ollama explains itself as {"error": "..."}
  let reason = body.slice(0, 300);
  try {
    reason = (JSON.parse(body) as { error?: string }).error ?? reason;
  } catch {}
  throw new Error(reason || `HTTP ${res.status}`);
}

// Downloads a model, reporting progress as { status, percent } (percent is
// null when Ollama gives no size). Throws if the download fails.
export async function pull(
  { baseURL, apiKey }: LocalSettings,
  name: string,
  onProgress: (progress: { status: string; percent: number | null }) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`${rootURL(baseURL)}/api/pull`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model: name, name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error((await res.text()).slice(0, 300) || `HTTP ${res.status}`);
  }

  // The response is one JSON object per line
  const decoder = new TextDecoder();
  let buffer = '';
  let last = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const update = JSON.parse(line);
      if (update.error) throw new Error(update.error);
      const percent = update.total ? Math.round((100 * (update.completed ?? 0)) / update.total) : null;
      // Ollama reports far more often than the progress visibly changes
      const key = `${update.status}/${percent}`;
      if (key !== last) onProgress({ status: update.status, percent });
      last = key;
    }
  }
}
