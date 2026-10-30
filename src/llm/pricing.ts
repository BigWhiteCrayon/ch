// What the hosted models charge, to turn token counts into a cost.
//
// Prices are US dollars per million tokens, input then output, at each
// provider's standard rate. They were taken from the providers' published
// price lists on 2026-10-05 and go out of date as those change: a model that
// isn't listed here has no known price, and its cost is reported as unknown
// rather than guessed. Models run on a local server cost nothing.
//
// A third figure, where a model has one, is what reading a token back from the
// prompt cache costs. It is there because that price stopped being a fixed
// fraction of the input price: it is a tenth of it on most models, but a
// twentieth on Claude Opus 5.5 and Claude Sonnet 5.5, and a fortieth on Claude
// Fable 5.1 (anthropic's price list, 2026-10-13). Reading is most of what a
// tool loop pays for, so taking the tenth for granted overcharged an Opus 5.5
// thread twofold and a Fable 5.1 thread fourfold. Where the figure is left
// out, the tenth is what the model charges.

import type { ModelUsage, Usage } from '../types';

// Every figure is US dollars per million tokens, as the price lists give them.
// The last two are left out where the model charges what most models charge: a
// tenth of its input price to read a token back from the prompt cache, and a
// quarter more than its input price to write one in. Neither is safe to assume
// — the read is a twentieth on some models and a half on others, and most of
// OpenAI's models have no write price at all, so a written token there is an
// ordinary input token — so where a list says otherwise, it is written out.
type Price = [input: number, output: number, cacheRead?: number, cacheWrite?: number];

// Some models charge by how large the prompt is rather than one price for
// every request: each tier holds the most input a request can carry and still
// pay its prices, smallest first, and the last one covers everything above the
// tier before it. A request's prompt is all of its input tokens, the cached
// ones included, and each is priced on its own — a request over the threshold
// pays the higher prices even where most of its prompt was a cache hit, and
// the requests before it keep what they were billed.
type Tiers = { tiers: { upTo: number; price: Price }[] };

const PRICES: Record<string, Record<string, Price | Tiers>> = {
  anthropic: {
    'claude-fable-5-1': [10, 50, 0.25],
    'claude-mythos-5-1': [10, 50, 0.25],
    'claude-fable-5': [10, 50],
    'claude-mythos-5': [10, 50],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-opus-4-7': [5, 25],
    'claude-opus-4-6': [5, 25],
    'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    // The one model priced by the length of the prompt: five times as much
    // above a hundred thousand input tokens. Neither tier lists a cache rate
    // of its own, so each reads back at a tenth of what its own input costs
    // ($0.01 and $0.05), which is what the price list says.
    'claude-haiku-5-5': {
      tiers: [
        { upTo: 100_000, price: [0.1, 0.5] },
        { upTo: Infinity, price: [0.5, 2.5] },
      ],
    },
    'claude-haiku-4-5': [1, 5],
  },
  // Only the newest families here are charged for writing into the cache (the
  // gpt-6s and the gpt-5.6s, at the usual quarter more); on every model below
  // them a token written to the cache is billed as the ordinary input token it
  // is, which is the fourth figure repeating the first. The read discount is
  // all over the place: a tenth on the gpt-5s and the gpt-6s, a twentieth on
  // gpt-6.1-sol, a quarter or a half on the gpt-4s and the o-series, and
  // nothing at all on the pro models, where a cached token costs what any
  // other does (openai's price list, 2026-10-13).
  openai: {
    'gpt-6-astra': [10, 50],
    'gpt-6.1-sol': [2, 10, 0.1],
    'gpt-6-sol': [2, 10],
    'gpt-6-luna': [0.1, 0.5],
    'gpt-5.6-sol': [4, 20],
    'gpt-5.6-terra': [2, 12],
    'gpt-5.6-luna': [0.2, 1.2],
    'gpt-5.5': [5, 30, 0.5, 5],
    'gpt-5.5-pro': [30, 180, 30, 30],
    'gpt-5.4': [2.5, 15, 0.25, 2.5],
    'gpt-5.4-mini': [0.75, 4.5, 0.075, 0.75],
    'gpt-5.4-nano': [0.2, 1.25, 0.02, 0.2],
    'gpt-5.4-pro': [30, 180, 30, 30],
    'gpt-5.2': [1.75, 14, 0.175, 1.75],
    'gpt-5.2-pro': [21, 168, 21, 21],
    'gpt-5.1': [1.25, 10, 0.125, 1.25],
    'gpt-5': [1.25, 10, 0.125, 1.25],
    'gpt-5-mini': [0.25, 2, 0.025, 0.25],
    'gpt-5-nano': [0.05, 0.4, 0.005, 0.05],
    'gpt-5-pro': [15, 120, 15, 15],
    'gpt-4.1': [2, 8, 0.5, 2],
    'gpt-4.1-mini': [0.4, 1.6, 0.1, 0.4],
    'gpt-4.1-nano': [0.1, 0.4, 0.025, 0.1],
    'gpt-4o': [2.5, 10, 1.25, 2.5],
    'gpt-4o-mini': [0.15, 0.6, 0.075, 0.15],
    o1: [15, 60, 7.5, 15],
    'o1-pro': [150, 600, 150, 150],
    o3: [2, 8, 0.5, 2],
    'o3-pro': [20, 80, 20, 20],
    'o3-mini': [1.1, 4.4, 0.55, 1.1],
    'o4-mini': [1.1, 4.4, 0.275, 1.1],
    'gpt-3.5-turbo': [0.5, 1.5, 0.5, 0.5],
  },
};

// A model's price: its own entry, or the entry it is a dated snapshot of
// ("claude-haiku-4-5-20251001", "gpt-4o-2024-08-06")
function priceOf(provider: string, model: string): Price | Tiers | undefined {
  const prices = PRICES[provider];
  if (!prices) return undefined;
  if (prices[model]) return prices[model];
  const base = Object.keys(prices)
    .filter((id) => model.startsWith(`${id}-`) && /^[\d-]+$/.test(model.slice(id.length + 1)))
    .sort((a, b) => b.length - a.length)[0];
  return base ? prices[base] : undefined;
}

// One model's part in a request, priced. models: as returned by listModels(),
// to tell whether the provider is a local one.
export function priced(
  purpose: ModelUsage['purpose'],
  provider: string,
  model: string,
  usage: Usage,
  models: { provider: string; local: boolean }[]
): ModelUsage {
  const local = models.some((m) => m.provider === provider && m.local);
  return { purpose, provider, model, ...usage, cost: cost(provider, model, usage, local) };
}

// What writing a token into the prompt cache costs, where the model's price
// list doesn't say: a quarter more than sending it uncached. True of every
// anthropic model — of the five-minute cache, which is the only one this app
// asks for (see providers/anthropic.ts, where the breakpoints are set); the
// hour-long cache is twice the input price instead — and of the openai models
// that charge for writes at all.
const CACHE_WRITE = 1.25;
// ...and what reading one back costs, where the model's own price list doesn't
// say. See the note above PRICES: this is the common case rather than the rule.
const CACHE_READ = 0.1;

// Which prices a request pays, where the model has more than one set: the
// first tier its prompt fits in, and the last tier for a prompt larger than
// any of them (see Tiers). A model with one set of prices pays it whatever the
// prompt came to.
function tierFor(entry: Price | Tiers, input: number): Price {
  if (Array.isArray(entry)) return entry;
  const { tiers } = entry;
  return (tiers.find(({ upTo }) => input <= upTo) ?? tiers[tiers.length - 1]).price;
}

// The cost in US dollars of a request that used these tokens, or null when
// the model's price isn't known. `local` is whether the provider runs on the
// user's own machine.
export function cost(provider: string, model: string, usage: Usage, local: boolean): number | null {
  if (local) return 0;
  const entry = priceOf(provider, model);
  if (!entry) return null;
  const [fullPrice, outPrice, readPrice = fullPrice * CACHE_READ, writePrice = fullPrice * CACHE_WRITE] = tierFor(
    entry,
    usage.input
  );
  // Cached tokens are part of usage.input, at their own rate rather than the
  // full one; what is left of it was sent uncached
  const write = usage.cacheWrite ?? 0;
  const read = usage.cacheRead ?? 0;
  const fresh = Math.max(0, usage.input - write - read);
  const input = fresh * fullPrice + write * writePrice + read * readPrice;
  return (input + usage.output * outPrice) / 1_000_000;
}
