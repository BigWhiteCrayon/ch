import { monthCost, setTicker, ticker } from './shared.js';
import { state } from './threads.js';
import type { Used, Latency, Waits, Thread, ModelTotal, ModelUsage, PurposeTotal } from './types.js';

export function mergeUsage(entries: Used[]): Used[] {
  const merged = new Map<string, Used>();
  for (const entry of entries) {
    const key = `${entry.purpose}/${entry.provider}/${entry.model}`;
    const to = merged.get(key);
    // A pass's timing is added up with the rest rather than left on the first
    // pass alone, which would have a line say how long one pass took of
    // several (see Used)
    const waits = waitsFrom(entry);
    if (!to) {
      const { latency: _latency, waits: _waits, ...first } = entry;
      merged.set(key, { ...first, ...(waits ? { waits: { ...waits } } : {}) });
      continue;
    }
    to.input += entry.input;
    to.output += entry.output;
    // The cached share of every pass, not just the first: a reply's first pass
    // caches nothing, and a line that took its cached figure from that pass
    // alone said nothing was cached for the whole of a tool loop that was
    // reusing most of its prompt. Left absent rather than set to zero, as a
    // total is (see addTotal): a provider that says nothing about caching is
    // not reporting that it cached nothing.
    if (entry.cacheRead) to.cacheRead = (to.cacheRead ?? 0) + entry.cacheRead;
    if (entry.cacheWrite) to.cacheWrite = (to.cacheWrite ?? 0) + entry.cacheWrite;
    // The same model priced the same way every pass, so a price is known for
    // all of them or for none
    to.cost = to.cost === null || entry.cost === null ? null : to.cost + entry.cost;
    if (waits) addWaits((to.waits ??= { timed: 0, spent: 0, slowest: 0, queued: 0 }), waits);
  }
  return [...merged.values()];
}

// The waiting a usage entry stands for: one call's own timing, or the waiting
// already added up
export function waitsFrom(used: { latency?: Latency; waits?: Waits }): Waits | undefined {
  if (!used.latency) return used.waits;
  return {
    timed: 1,
    spent: used.latency.totalMs,
    slowest: used.latency.totalMs,
    queued: used.latency.queuedMs ?? 0,
  };
}

export function addWaits(into: Waits, waits: Waits): void {
  into.timed += waits.timed;
  into.spent += waits.spent;
  into.slowest = Math.max(into.slowest, waits.slowest);
  into.queued += waits.queued;
}

// Adds some usage into a set of totals, under its own "provider/model". Takes
// either a single request's usage or a total already added up, so the same
// adding serves a thread's running total, a day's, and the usage page summing
// days together.
export function addTotal(
  totals: Record<string, ModelTotal>,
  used: {
    provider: string;
    model: string;
    input: number;
    output: number;
    cost: number | null;
    cacheRead?: number;
    cacheWrite?: number;
    unpriced?: boolean;
  } & {
    // One call's own timing, as a usage event carries it, or the waiting
    // already added up, as a day's total carries it when the days are merged
    // (see usageTotals). Either, neither, never both.
    latency?: Latency;
    waits?: Waits;
  }
): void {
  const { provider, model } = used;
  const total = (totals[`${provider}/${model}`] ??= { provider, model, input: 0, output: 0, cost: 0 });
  total.input += used.input;
  total.output += used.output;
  // Left absent rather than set to zero, so that usage from a provider that
  // says nothing about caching is not reported as having cached nothing
  if (used.cacheRead) total.cacheRead = (total.cacheRead ?? 0) + used.cacheRead;
  if (used.cacheWrite) total.cacheWrite = (total.cacheWrite ?? 0) + used.cacheWrite;
  // A total with any unpriced usage in it is marked, so that what is known is
  // never passed off as the whole (see money)
  if (used.cost === null || used.unpriced) total.unpriced = true;
  if (used.cost !== null) total.cost += used.cost;
  const waits = waitsFrom(used);
  if (!waits) return;
  addWaits((total.waits ??= { timed: 0, spent: 0, slowest: 0, queued: 0 }), waits);
}

// The waiting on several models taken together, or nothing where none of their
// calls was timed
export function waitsOf(totals: { waits?: Waits }[]): Waits | undefined {
  const timed = totals.flatMap(({ waits }) => (waits ? [waits] : []));
  if (timed.length === 0) return undefined;
  return {
    timed: timed.reduce((n, w) => n + w.timed, 0),
    spent: timed.reduce((n, w) => n + w.spent, 0),
    slowest: timed.reduce((n, w) => Math.max(n, w.slowest), 0),
    queued: timed.reduce((n, w) => n + w.queued, 0),
  };
}

// The day some usage is counted against, as "2026-10-09" in the user's own
// time: a day that ends at local midnight is the one that matches what
// somebody looking at the page remembers doing when.
export function dayKey(at: number = Date.now()): string {
  const on = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${on.getFullYear()}-${pad(on.getMonth() + 1)}-${pad(on.getDate())}`;
}

// What the last 30 days came to, as the title bar says it: the same 30 days the
// usage page's "30 days" chip covers, today and the 29 before it. Cut off at the
// cent rather than rounded, so it never says more than has been spent; "free"
// only where nothing has. Self-contained function declaration: the first render
// draws it, before the constants above and below are set.
export function drawMonthCost(): void {
  const from = new Date();
  from.setDate(from.getDate() - 29);
  const first = dayKey(from.getTime());
  const totals = Object.entries(state.daily ?? {}).flatMap(([day, models]) =>
    day >= first ? Object.values(models) : []
  );
  const cost = totals.reduce((n, t) => n + (t.cost ?? 0), 0);
  const unpriced = totals.some((t) => t.unpriced);
  // A sliver over a cent boundary in floating point (0.29 * 100 is 28.999...) must not lose a cent
  const amount = `$${(Math.floor(cost * 100 + 1e-6) / 100).toFixed(2)}`;
  const said = cost === 0 ? (unpriced ? 'cost unknown' : 'free') : unpriced ? `${amount} + unknown` : amount;
  monthCost.textContent = `Last 30 days: ${said}`;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// How many days of spending are kept. The whole state is written out again on
// every save, so the record is not left to grow without end; a year is more
// than the page shows and enough to look back over.
export const DAILY_DAYS = 365;

// Adds some usage into a set of totals, under the key given: a purpose, or a
// purpose and the kind of subagent that spent it. Adds up as addTotal does.
export function addPurposeTotal(into: Record<string, PurposeTotal>, key: string, usage: ModelUsage): void {
  const total = (into[key] ??= { input: 0, output: 0, cost: 0 });
  total.input += usage.input;
  total.output += usage.output;
  if (usage.cacheRead) total.cacheRead = (total.cacheRead ?? 0) + usage.cacheRead;
  if (usage.cacheWrite) total.cacheWrite = (total.cacheWrite ?? 0) + usage.cacheWrite;
  if (usage.cost !== null) total.cost += usage.cost;
}

export function recordUsage(thread: Thread, usage: ModelUsage, kind?: string): void {
  addTotal((thread.usage ??= {}), usage);
  const daily = (state.daily ??= {});
  addTotal((daily[dayKey()] ??= {}), usage);
  const today = ((state.dailyPurpose ??= {})[dayKey()] ??= {});
  addPurposeTotal(today, usage.purpose, usage);
  if (kind) addPurposeTotal(today, `${usage.purpose}/${kind}`, usage);
  // Dates sort as strings in this form, so the old ones are the first ones
  const keep = dayKey(Date.now() - (DAILY_DAYS - 1) * DAY_MS);
  for (const day of Object.keys(daily)) if (day < keep) delete daily[day];
  for (const day of Object.keys(state.dailyPurpose)) if (day < keep) delete state.dailyPurpose[day];
  drawMonthCost();
}

// Function declarations here, since the first render runs before this line
export function count(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

// A number of tokens, in full below a thousand and abbreviated from there on, to
// two significant figures: "950", "1.2K", "12K", "120K", "3.5M", "1.2B". A figure
// that rounds up to the next thousand is said in the next unit, "1M" and not
// "1000K". A function declaration, like count, since the first render uses it.
export function tokenCount(tokens: number): string {
  const units = ['', 'K', 'M', 'B', 'T'];
  if (Math.abs(tokens) < 1000) return count(Math.round(tokens));
  let unit = 0;
  let scaled = tokens;
  while (Math.abs(scaled) >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  let said = Number(scaled.toPrecision(2));
  if (Math.abs(said) >= 1000 && unit < units.length - 1) {
    said /= 1000;
    unit++;
  }
  return `${said}${units[unit]}`;
}

// A cost in dollars, to four places below a dollar since most requests cost
// a fraction of a cent. unpriced: part of the usage had no known price.
export function money(cost: number, unpriced = false): string {
  if (unpriced && cost === 0) return 'cost unknown';
  const amount = cost === 0 ? 'free' : cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
  return unpriced ? `${amount} + unknown` : amount;
}

// A figure with some estimate in it, said as one: "~12,600 tokens". Only
// where it reads as a number — "free" is free whether it was counted or
// reckoned, and "cost unknown" is no more known for being marked.
export function about(said: string, estimated: boolean): string {
  return estimated && /\d/.test(said) ? `~${said}` : said;
}

// A length of time as the pill reads it. Tenths below ten seconds, where the
// difference between 1.2s and 1.9s is the difference between a model that
// feels quick and one that does not; whole seconds above that, tenths being
// noise by then; and minutes once there are any, a wait that long having
// stopped being measured in seconds by whoever is sitting through it.
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

// How long work has been going, as a clock reads: "7s", "1m 05s". Whole
// seconds, since it is redrawn every second and tenths would only flicker.
// Declared, not assigned, like typical: the first render may draw one.
export function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// A running clock for work that began at `since`. The usage beside it only
// changes when a model call finishes, so on its own it looks stalled for as
// long as one takes; this is the part that moves in between. It is redrawn by
// tick rather than by render, which would rebuild the whole thread each second.
export function clock(since: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'clock';
  span.dataset.since = String(since);
  span.textContent = `${elapsed(since)} elapsed`;
  // Drawn, so something has to keep it going; it stops once none are left
  setTicker(ticker ?? setInterval(tick, 1000));
  return span;
}

// What is left of a wait that ends at `until`, in whole seconds: "58s". Never
// below zero — a wait that is over is over, and a negative number on a card
// reads as a fault rather than as something that has already happened.
export function left(until: number): string {
  return `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`;
}

// A clock running the other way, for a question that is only asked for so long
// (see approvals.ts). Kept going by the same tick as the clocks above, so the
// card is not rebuilt every second; the words beside it are the caller's.
export function countdown(until: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'countdown';
  span.dataset.until = String(until);
  span.textContent = left(until);
  setTicker(ticker ?? setInterval(tick, 1000));
  return span;
}

export function tick(): void {
  const clocks = document.querySelectorAll<HTMLElement>('[data-since]');
  const counts = document.querySelectorAll<HTMLElement>('[data-until]');
  // Whatever was running has finished and the next render took its clock away
  if (clocks.length === 0 && counts.length === 0) {
    clearInterval(ticker);
    setTicker(undefined);
    return;
  }
  for (const one of clocks) one.textContent = `${elapsed(Number(one.dataset.since))} elapsed`;
  for (const one of counts) one.textContent = left(Number(one.dataset.until));
}

// How long the models were at it: the time their calls took, added up, as
// "12.4s". The whole of each call and not the wait before it began to answer,
// which is in the log (see Latency) — a reply the user sat through for two
// minutes is a two-minute reply whatever it did in the first half-second of
// it. A total rather than the mean, the pill being a running total of the
// thread like the tokens and the cost beside it; the slowest single call is
// said in the panel (see waitLine), since a total alone does not say whether
// it was one long call or twenty quick ones.
//
// Declared, not assigned: the first render happens before this line is
// reached, and a thread opened with its timings already saved draws it then.
export function took(waits: Waits): string {
  return duration(waits.spent);
}

// The same timing in full, for the panel the pill opens to: "12.4s in all ·
// 4.3s slowest · over 12 calls", and what was spent queued where any was.
export function waitLine(waits: Waits): string {
  const parts =
    // One call is its own total, and there is no slowest among one
    waits.timed === 1
      ? [duration(waits.spent)]
      : [`${took(waits)} in all`, `${duration(waits.slowest)} slowest`, `over ${count(waits.timed)} calls`];
  // On top of the time above rather than part of it, so it is said as its
  // own thing: a local model answering one request at a time is the app
  // serialising its work, not the model being slow (see Latency).
  if (waits.queued > 0) parts.push(`${duration(waits.queued)} more spent waiting its turn`);
  return parts.join(' · ');
}

// The foot of that panel: how long the models in this thread have been at it,
// taken together
export function waitRow(waits: Waits): HTMLElement {
  const row = document.createElement('div');
  row.className = 'waits';
  const label = document.createElement('span');
  label.textContent = 'Time the models took';
  const said = document.createElement('small');
  said.textContent = waitLine(waits);
  row.append(label, said);
  return row;
}

// "304 in (900 cached) · 356 out · $0.0119" for some usage taken together.
// In is what was not cached and the two together are what went in, as the
// usage page's tiles and tables have it (see drawUsageTiles): most of what a
// tool loop sends is the same prompt again, so a single "1,204 in" says
// something quite different depending on whether 900 of them were read back
// from the cache at a twentieth of the price. The cached share is left off
// where there is none, since a provider that says nothing about caching is
// not reporting that it cached nothing, and In is then the whole prompt.
export function usageLine(
  entries: { input: number; output: number; cost: number | null; cacheRead?: number; unpriced?: boolean }[]
): string {
  const sum = (pick: (e: (typeof entries)[number]) => number | undefined) =>
    entries.reduce((n, e) => n + (pick(e) ?? 0), 0);
  const unpriced = entries.some((e) => e.cost === null || e.unpriced);
  const cached = sum((e) => e.cacheRead);
  return `${tokenCount(sum((e) => e.input) - cached)} in${
    cached ? ` (${tokenCount(cached)} cached)` : ''
  } · ${tokenCount(sum((e) => e.output))} out · ${money(
    sum((e) => e.cost ?? 0),
    unpriced
  )}`;
}

// ...and how long the models took over it, where any call was timed, as the
// thread's pill gives them side by side
export function usedLine(entries: Used[]): string {
  const waits = waitsOf(entries.map((e) => ({ waits: waitsFrom(e) })));
  return [usageLine(entries), waits && took(waits)].filter(Boolean).join(' · ');
}

// The token usage page: every thread's token use, day by day, in tokens and
// in what it cost. The thread header carries one thread's running total (see
// render); this answers the other question — what the app is getting through
// — which no single thread can. It is drawn from state.daily, which
// recordUsage fills as each request reports in.
