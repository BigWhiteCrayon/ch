import type { ModelTotal, PurposeTotal } from './types.js';
import { element, models, PURPOSES } from './shared.js';
import { state } from './threads.js';
import { addTotal, dayKey, DAY_MS, DAILY_DAYS, tokenCount, money, usageLine } from './usage.js';
import { dropdown } from './tool-calls.js';
import type { Section } from './tool-calls.js';

export const usageDialog = element<HTMLDialogElement>('usage');
export const usageRangeChips = element('usage-range');
export const usageViewChips = element('usage-view');
export const usageBreakdownChips = element('usage-breakdown-view');
export const usageEmpty = element('usage-empty');
export const usageTiles = element('usage-tiles');
export const usageEarlier = element('usage-earlier');
export const usageChart = element('usage-chart');
export const usageLegend = element('usage-legend');
export const usageBreakdown = element('usage-breakdown');
export const usagePurpose = element('usage-purpose');
export const usageDaysEl = element('usage-days');
export const usageTip = element('usage-tip');

// How far back the page looks: a number of days ending today, or every day on
// record
export type UsageRange = number | 'all';
export let usageRange: UsageRange = 7;
// Whether the page is read in money or in tokens. Both are always on it —
// the tables carry the tokens and the cost side by side whichever is chosen —
// so this settles what the chart is a shape of, what the day's average is in,
// and what the biggest spender is biggest in.
export type UsageView = 'cost' | 'tokens';
export let usageView: UsageView = 'cost';
// Which of the two breakdowns is on the page at a time: the models, or what
// they were used for. Default to the model table, as it was on its own.
export type UsageBreakdownView = 'model' | 'purpose';
export let usageBreakdownView: UsageBreakdownView = 'model';
// What the legend has chosen to show. The name on an entry singles one series
// out to its own ("solo"); its colour box puts that one back or takes another
// off. A solo wins over a set of hidden series, so the two never fight, and
// each reading keeps its own choices, so reading the models does not reach in
// and hide a purpose.
const legendHidden: Record<UsageBreakdownView, Set<string>> = { model: new Set(), purpose: new Set() };
const legendSolo: Record<UsageBreakdownView, string | null> = { model: null, purpose: null };
// The series the chart last drew, per reading: the one the colour box is
// checked against, so it will not take the last one off and leave a bar of
// nothing. Filled in as the chart is built.
let chartSeries: Record<UsageBreakdownView, string[]> = { model: [], purpose: [] };
// Whether a series shows on the chart at all: a soloed one is the only thing
// on it, or, with no solo, every one the legend has not been told to hide.
const legendShown = (view: UsageBreakdownView, key: string): boolean => {
  const solo = legendSolo[view];
  return solo !== null ? key === solo : !legendHidden[view].has(key);
};
// Re-draws only the chart and its legend, which are the two the legend acts on.
const redrawChart = (): void => {
  hideUsageTip();
  drawUsageChart(usageSpan());
};
// The colour box on a legend entry: put that series back, or take it off, and
// drop any solo, since the reader is now fine-tuning what is shown. The last
// series on the chart is not taken off: a chart of nothing tells nothing.
const toggleLegendSeries = (view: UsageBreakdownView, key: string): void => {
  const hidden = legendHidden[view];
  if (hidden.has(key)) {
    hidden.delete(key);
  } else {
    const shown = chartSeries[view].filter((k) => !hidden.has(k));
    if (shown.length === 1 && shown[0] === key) return;
    hidden.add(key);
  }
  legendSolo[view] = null;
  redrawChart();
};
// The name on a legend entry: show that series on its own; the same name again
// lets the others back on.
const soloLegendSeries = (view: UsageBreakdownView, key: string): void => {
  legendSolo[view] = legendSolo[view] === key ? null : key;
  redrawChart();
};

// A colour per model: a hue for its provider, nudged by the model's rank among that provider's models.
export const PROVIDER_SLOT: Record<string, number> = { anthropic: 1, openai: 2, local: 3 };
export const providerSlot = (provider: string): number => PROVIDER_SLOT[provider] ?? 4;
export const byProviderThenModel = (a: { provider: string; model: string }, b: { provider: string; model: string }) =>
  providerSlot(a.provider) - providerSlot(b.provider) ||
  a.provider.localeCompare(b.provider) ||
  modelRank(a.provider, a.model) - modelRank(b.provider, b.model);
export const PROVIDER_HUE: Record<string, number> = { anthropic: 220, openai: 140, local: 25 };

// The model's index in the alphabetically sorted list of that provider's models across all dates.
export const modelRank = (provider: string, model: string): number => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const totals of Object.values(state.daily ?? {})) {
    for (const total of Object.values(totals ?? {})) {
      if (total.provider === provider) {
        if (!seen.has(total.model)) {
          seen.add(total.model);
          names.push(total.model);
        }
      }
    }
  }
  names.sort();
  return names.indexOf(model);
};

// Paints a series-coloured element via custom properties. No longer uses series-N classes.
export const paintSeries = (el: HTMLElement, provider: string, model: string): void => {
  const rank = modelRank(provider, model);
  const hue = PROVIDER_HUE[provider] ?? 290;
  el.style.setProperty('--series-hue', String(hue + ((rank % 5) - 2) * 10));
  el.style.setProperty('--series-shift', String(((rank % 3) - 1) * 9));
};

// A colour per purpose: one hue a purpose keeps from one render to the next,
// so its place in a bar is as stable as a model's. The top-level purpose's
// name is what it turns on; "subagent" sits at the top like a provider, with
// its kinds rolled up under it, and an "Earlier (purpose not recorded)" bucket
// its own neutral grey.
export const PURPOSE_HUE: Record<string, number> = {
  classification: 285,
  planning: 55,
  reply: 210,
  summary: 165,
  description: 330,
  compaction: 95,
  subagent: 30,
  verification: 120,
};
const EARLIER_HUE = 270;
export const purposeHue = (key: string): number =>
  key === 'earlier' ? EARLIER_HUE : (PURPOSE_HUE[key] ?? ((Object.keys(PURPOSES).indexOf(key) + 1) * 47) % 360);
// Paints a purpose's colour onto an element, the way paintSeries does for a model.
export const paintPurpose = (el: HTMLElement, key: string): void => {
  const rank = key === 'earlier' ? 3 : Object.keys(PURPOSES).indexOf(key);
  el.style.setProperty('--series-hue', String(purposeHue(key)));
  el.style.setProperty('--series-shift', String(((rank % 3) - 1) * 9));
};
// A purpose swatch with its name beside it, as swatched does for a model.
export function purposeSwatched(label: string, key: string, tag: 'span' | 'div'): HTMLElement {
  const wrapper = document.createElement(tag);
  const swatch = document.createElement('i');
  paintPurpose(swatch, key);
  wrapper.append(swatch, document.createTextNode(label));
  return wrapper;
}

// A purpose's name on the page, the fixed labels first and then the key itself,
// as drawUsagePurposes reads it (PURPOSES has a fixed shape, not an index).
export const purposeName = (key: string): string =>
  key === 'earlier' ? 'Earlier (purpose not recorded)' : ((PURPOSES as Record<string, string>)[key] ?? key);
// What a provider is called. The fixed names come first: a provider whose key
// has since been removed is no longer among the listed models, but may well
// still be in the record.
export const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', local: 'Local' };
export function providerLabel(provider: string): string {
  return PROVIDER_NAMES[provider] ?? models.find((m) => m.provider === provider)?.providerName ?? provider;
}

// The least a day's column is given, so that a long range scrolls rather than
// thinning out to nothing (see drawUsageChart)
export const COLUMN_WIDTH = 5;

export const tokensOf = (total: { input: number; output: number }) => total.input + total.output;
export const measureOf = (total: ModelTotal) => (usageView === 'cost' ? total.cost : tokensOf(total));
export const totalOf = (totals: ModelTotal[], of: 'input' | 'output' | 'cost' | 'cacheRead') =>
  totals.reduce((n, t) => n + (t[of] ?? 0), 0);
// Biggest first in whichever of the two the page is being read in, with the
// other to settle a tie
export const biggest = (a: ModelTotal, b: ModelTotal) => measureOf(b) - measureOf(a) || tokensOf(b) - tokensOf(a);

// Every day the page covers, oldest first, the ones nothing was spent on
// included: a gap left out of a chart over time bends what its shape says.
export function usageSpan(): string[] {
  const recorded = Object.keys(state.daily ?? {}).sort();
  if (recorded.length === 0) return [];
  const today = dayKey();
  // Up to today, or to the last day on record if a clock has been put back
  const last = recorded[recorded.length - 1];
  const to = last > today ? last : today;
  // A range of days is that many days, whether or not the app was used on all
  // of them: the days with nothing on them are part of what seven days of use
  // looks like. Stretching the few days there are across the whole chart
  // would make a week of quiet work look like a busy one. "All" is the one
  // that follows the record, since all there is is where it starts.
  const from = usageRange === 'all' ? recorded[0] : dayKey(Date.now() - (usageRange - 1) * DAY_MS);
  return from > to ? [] : daysFromTo(from, to);
}

// The days from one to another inclusive, as "2026-10-09" keys
export function daysFromTo(from: string, to: string): string[] {
  const days: string[] = [];
  // Stepped from midday, so that a clock going forward or back an hour for
  // daylight saving neither skips a day nor repeats one
  const on = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (on <= end && days.length <= DAILY_DAYS + 1) {
    days.push(dayKey(on.getTime()));
    on.setDate(on.getDate() + 1);
  }
  return days;
}

// What these days came to, one total per "provider/model", biggest first
export function usageTotals(days: string[]): ModelTotal[] {
  const merged: Record<string, ModelTotal> = {};
  for (const day of days) {
    for (const total of Object.values(state.daily?.[day] ?? {})) addTotal(merged, total);
  }
  return Object.values(merged).sort(biggest);
}

// "Oct 9", or "Fri, Oct 9" where there is room for it
export function dayLabel(day: string, long = false): string {
  const format: Intl.DateTimeFormatOptions = long
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' };
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', format);
}

// A round number at or above the tallest day, so the axis reads in steps
// somebody can hold in their head
export function axisTop(peak: number): number {
  if (!(peak > 0)) return usageView === 'cost' ? 0.01 : 1000;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 2.5, 5]) if (peak <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

// An axis tick: money as money, and tokens short enough to sit beside the bars
export function axisTick(value: number): string {
  if (usageView === 'cost') {
    if (value === 0) return '$0';
    // Enough places to tell one tick from the next, with none left trailing:
    // "$0.02", not "$0.020"
    return `$${Number(value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2))}`;
  }
  return tokenCount(value);
}

// The small buttons above the page that choose what it shows. Built once and
// then only re-marked: rebuilding them would take the focus off the one just
// pressed.
export function chips<T>(
  into: HTMLElement,
  options: [label: string, value: T][],
  chosen: () => T,
  choose: (value: T) => void
) {
  const marks: (() => void)[] = [];
  for (const [label, value] of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      choose(value);
      drawUsage();
    });
    marks.push(() => chip.setAttribute('aria-pressed', String(value === chosen())));
    into.append(chip);
  }
  return () => marks.forEach((mark) => mark());
}

export const markRange = chips<UsageRange>(
  usageRangeChips,
  [
    ['7 days', 7],
    ['30 days', 30],
    ['90 days', 90],
    ['All', 'all'],
  ],
  () => usageRange,
  (range) => (usageRange = range)
);
export const markView = chips<UsageView>(
  usageViewChips,
  [
    ['Cost', 'cost'],
    ['Tokens', 'tokens'],
  ],
  () => usageView,
  (measure) => (usageView = measure)
);
export const markBreakdown = chips<'model' | 'purpose'>(
  usageBreakdownChips,
  [
    ['Model', 'model'],
    ['Purpose', 'purpose'],
  ],
  () => usageBreakdownView,
  (view) => (usageBreakdownView = view)
);

// The numbers that should need no reading off a chart: what the range cost,
// and the tokens that went into and came out of it
export function drawUsageTiles(days: string[], totals: ModelTotal[]): void {
  const unpriced = totals.some((t) => t.unpriced);
  const spent = totalOf(totals, 'cost');
  const over = days.length === 1 ? 'on this day' : `over ${days.length} days`;
  const tokens = totalOf(totals, 'input') + totalOf(totals, 'output');
  // Whichever way the page is being read, the other measure stays on it: a
  // page that answers only one of "how much" and "how many" sends somebody
  // to the toggle to read the other half of the same thing.
  // What was billed for came back from a prompt cache (and its own tile appears when there were any).
  const uncached = totalOf(totals, 'input') - totalOf(totals, 'cacheRead');
  const cached = totalOf(totals, 'cacheRead');
  const share = cached && totalOf(totals, 'input') ? Math.round((cached / totalOf(totals, 'input')) * 100) : 0;
  const cachedTile: [string, string, string] = ['Cached', tokenCount(cached), `${share}% of what went in`];
  const tiles: [label: string, figure: string, about: string][] =
    usageView === 'cost'
      ? [
          ['Spent', money(spent, unpriced), over],
          ['A day', money(spent / days.length, unpriced), 'on average'],
          ['Tokens in', tokenCount(totalOf(totals, 'input') - cached), 'sent to the models'],
          ...(cached ? [cachedTile] : []),
          ['Tokens out', tokenCount(totalOf(totals, 'output')), 'written back'],
        ]
      : [
          ['Tokens', tokenCount(tokens), over],
          ['A day', tokenCount(Math.round(tokens / days.length)), 'on average'],
          ['Tokens in', tokenCount(totalOf(totals, 'input') - cached), 'sent to the models'],
          ...(cached ? [cachedTile] : []),
          ['Tokens out', tokenCount(totalOf(totals, 'output')), 'written back'],
          ['Spent', money(spent, unpriced), 'on those tokens'],
        ];
  usageTiles.replaceChildren(
    ...tiles.map(([label, figure, about]) => {
      const tile = document.createElement('div');
      tile.className = 'usage-tile';
      const name = document.createElement('div');
      name.className = 'label';
      name.textContent = label;
      const value = document.createElement('div');
      value.className = 'figure';
      value.textContent = figure;
      const note = document.createElement('small');
      note.textContent = about;
      tile.append(name, value, note);
      return tile;
    })
  );
}

// The parts of one day's column when the chart is read by purpose: one part per
// top-level purpose, its subagent kinds rolled up under a single "Subagent"
// total, and whatever the purposes leave out as an "Earlier" bucket, as the
// "By purpose" table has it (see drawUsagePurposes).
const purposePartsForDay = (
  day: string
): {
  key: string;
  label: string;
  title: string;
  value: number;
  paint: (el: HTMLElement) => void;
}[] => {
  const measure = (total: PurposeTotal) => (usageView === 'cost' ? total.cost : tokensOf(total));
  const totals: Record<string, PurposeTotal> = {};
  for (const [key, total] of Object.entries(state.dailyPurpose?.[day] ?? {})) {
    const into = (totals[key] ??= { input: 0, output: 0, cost: 0 });
    into.input += total.input;
    into.output += total.output;
    into.cost += total.cost;
    if (total.cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + total.cacheRead;
    if (total.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + total.cacheWrite;
  }
  // A "subagent/kind" key rolls up into its "subagent" total, the way the table
  // nests its kinds under the row, so the bar shows one Subagent part.
  for (const key of Object.keys(totals)) {
    if (!key.startsWith('subagent/')) continue;
    const into = (totals['subagent'] ??= { input: 0, output: 0, cost: 0 });
    into.input += totals[key].input;
    into.output += totals[key].output;
    into.cost += totals[key].cost;
    if (totals[key].cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + totals[key].cacheRead;
    if (totals[key].cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + totals[key].cacheWrite;
    delete totals[key];
  }
  const top = Object.keys(totals).filter((key) => !key.includes('/'));
  const parts = top.map((key) => ({
    key,
    label: purposeName(key),
    title: purposeName(key),
    value: measure(totals[key]),
    paint: (el: HTMLElement) => paintPurpose(el, key),
  }));
  // Whatever the purposes leave out of the day's total: usage from before they
  // were recorded, the same bucket the "By purpose" table owns up to.
  const recorded = top.reduce((n, key) => n + measure(totals[key]), 0);
  const dayTotal = Object.values(state.daily?.[day] ?? {});
  const measureDay =
    usageView === 'cost' ? totalOf(dayTotal, 'cost') : totalOf(dayTotal, 'input') + totalOf(dayTotal, 'output');
  const earlier = measureDay - recorded;
  if (measureDay > 0 && earlier > 1e-9) {
    parts.push({
      key: 'earlier',
      label: 'Earlier (purpose not recorded)',
      title: 'Earlier (purpose not recorded)',
      value: earlier,
      paint: (el: HTMLElement) => paintPurpose(el, 'earlier'),
    });
  }
  return parts.sort((a, b) => b.value - a.value);
};

// The chart: a column per day, stacked by model under its provider, so that a day's height is
// what the day came to and the colours say where it went
export function drawUsageChart(days: string[]): void {
  const byPurpose = usageBreakdownView === 'purpose';
  const view: UsageBreakdownView = byPurpose ? 'purpose' : 'model';
  // Each day is a column; the parts that stack up its height, each carrying the
  // colour it keeps from day to day. Read by model the parts are provider/model
  // pairs; read by purpose they are one part per purpose (see purposePartsForDay).
  // The legend's entries are the parts themselves, gathered here as the days are
  // built, so the two readings each spell out their own colours.
  const series = new Map<
    string,
    { key: string; label: string; title: string; paint: (el: HTMLElement) => void; provider?: string; model?: string }
  >();
  const perDay = days.map((day) => {
    let parts: {
      key: string;
      label: string;
      title: string;
      value: number;
      paint: (el: HTMLElement) => void;
      provider?: string;
      model?: string;
    }[];
    if (!byPurpose) {
      // Keyed "provider/model", summing measureOf(total)
      const byModel = new Map<string, { provider: string; model: string; value: number }>();
      for (const total of Object.values(state.daily?.[day] ?? {})) {
        const key = `${total.provider}/${total.model}`;
        byModel.set(key, {
          provider: total.provider,
          model: total.model,
          value: (byModel.get(key)?.value ?? 0) + measureOf(total),
        });
      }
      parts = [...byModel.values()]
        .filter((part) => part.value > 0)
        .sort(byProviderThenModel)
        .map(({ provider, model, value }) => ({
          key: `${provider}/${model}`,
          label: model,
          title: providerLabel(provider),
          value,
          provider,
          model,
          paint: (el: HTMLElement) => paintSeries(el, provider, model),
        }));
    } else {
      parts = purposePartsForDay(day);
    }
    for (const part of parts) {
      series.set(part.key, { ...part });
    }
    // The parts the legend has left in, and what the column comes to with them.
    const shown = parts.filter((part) => legendShown(view, part.key));
    return { day, shown, sum: shown.reduce((n, p) => n + p.value, 0) };
  });
  // A series the reader singled out, but that is no longer on this range, is
  // let go so the chart is not waiting on a bar that is no longer there.
  if (legendSolo[view] !== null && ![...series.keys()].includes(legendSolo[view]!)) {
    legendSolo[view] = null;
  }
  chartSeries[view] = [...series.keys()];
  const top = axisTop(Math.max(0, ...perDay.map((d) => d.sum)));

  // The scale down the left, and the hairlines it is read against
  const ticks = document.createElement('div');
  ticks.className = 'chart-y';
  const grid = document.createElement('div');
  grid.className = 'chart-grid';
  for (const value of [top, top / 2, 0]) {
    const label = document.createElement('small');
    label.textContent = axisTick(value);
    ticks.append(label);
    grid.append(document.createElement('div'));
  }

  const columns = document.createElement('div');
  columns.className = 'chart-cols';
  for (const { day, shown } of perDay) {
    const column = document.createElement('div');
    column.className = 'chart-col';
    // The whole height of the column takes the pointer, not just the part
    // with bars in it: a quiet day is otherwise a few pixels to aim at
    column.addEventListener('mouseenter', (e) => showUsageTip(e, day));
    column.addEventListener('mousemove', placeUsageTip);
    column.addEventListener('mouseleave', hideUsageTip);
    const stack = document.createElement('div');
    stack.className = 'chart-stack';
    for (const { label, value, paint } of shown) {
      const segment = document.createElement('div');
      segment.className = 'seg';
      paint(segment);
      segment.style.height = `${(value / top) * 100}%`;
      segment.title = `${dayLabel(day, true)} · ${label}: ${axisTick(value)}`;
      stack.append(segment);
    }
    column.append(stack);
    columns.append(column);
  }

  const area = document.createElement('div');
  area.className = 'chart-area';
  area.append(grid, columns);

  // About six dates along the bottom however many days are showing, counted
  // back from the last so that today is always one of them
  const axis = document.createElement('div');
  axis.className = 'chart-x';
  const every = Math.max(1, Math.ceil(days.length / 6));
  days.forEach((day, i) => {
    if ((days.length - 1 - i) % every !== 0) return;
    const label = document.createElement('small');
    label.textContent = dayLabel(day);
    // Centred over its own column, except at either end, where that would
    // hang it half outside the chart
    if (i === 0) label.style.left = '0';
    else if (i === days.length - 1) label.style.right = '0';
    else {
      label.style.left = `${((i + 0.5) / days.length) * 100}%`;
      label.style.transform = 'translateX(-50%)';
    }
    axis.append(label);
  });

  // The columns keep a width they can be aimed at and told apart, and the
  // chart scrolls sideways rather than squeezing a long range into slivers.
  // The dates go inside what scrolls, so they stay over their own columns.
  const plot = document.createElement('div');
  plot.className = 'chart-plot';
  plot.style.minWidth = `max(100%, ${days.length * COLUMN_WIDTH}px)`;
  plot.append(area, axis);
  const scroll = document.createElement('div');
  scroll.className = 'chart-scroll';
  scroll.append(plot);
  scroll.addEventListener('scroll', hideUsageTip, { passive: true });
  usageChart.replaceChildren(ticks, scroll);
  // The legend is padded to line up with the plot, which starts past the scale and the gap beside it
  const offset = scroll.getBoundingClientRect().left - usageChart.getBoundingClientRect().left;
  if (offset > 0) usageLegend.style.setProperty('--usage-axis-w', `${offset}px`);

  // One entry per series on the range, in the order the segments stack, each
  // painted the colour its bar keeps. Read by model the series are the models;
  // read by purpose they are the purposes. Every series stays in the legend so
  // one taken off its colour box can be put back, and one read of the models
  // never reaches in and changes a choice made reading the purposes.
  const legend = byPurpose
    ? [...series.values()].sort((a, b) => a.key.localeCompare(b.key))
    : [...series.values()].sort((a, b) =>
        byProviderThenModel({ provider: a.provider!, model: a.model! }, { provider: b.provider!, model: b.model! })
      );
  usageLegend.hidden = legend.length < 2;
  usageLegend.replaceChildren(...legend.map((s) => legendEntry(view, s)));
}

// A colour box beside a name, each the way to change what the chart shows: the
// box takes its series off or puts it back, the name singles that series out to
// its own. A series left off is dimmed and struck through; the one singled out
// is the only one on the bars, its name stood out from the rest.
function legendEntry(
  view: UsageBreakdownView,
  s: { key: string; label: string; title: string; paint: (el: HTMLElement) => void }
): HTMLElement {
  const entry = document.createElement('span');
  entry.className = 'legend-item';
  const shown = legendShown(view, s.key);
  const soloed = legendSolo[view] === s.key;
  if (!shown) entry.classList.add('is-off');
  if (soloed) entry.classList.add('is-solo');

  // The colour box: its series' colour, and the way to take it off or put it back.
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'legend-swatch';
  swatch.title = `${s.title} · ${shown ? 'take off the chart' : 'show on the chart'}`;
  const dot = document.createElement('i');
  s.paint(dot);
  swatch.append(dot);
  swatch.setAttribute('aria-pressed', String(shown));
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLegendSeries(view, s.key);
  });

  // The name: show this series on its own, or, if it already is, let the rest back.
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'legend-name';
  name.textContent = s.label;
  name.title = s.title;
  name.setAttribute('aria-pressed', String(soloed));
  name.addEventListener('click', (e) => {
    e.stopPropagation();
    soloLegendSeries(view, s.key);
  });

  entry.append(swatch, name);
  return entry;
}

// A piece of text with its model's colour beside it
export function swatched(text: string, provider: string, model: string, tag: 'span' | 'div'): HTMLElement {
  const wrapper = document.createElement(tag);
  const swatch = document.createElement('i');
  paintSeries(swatch, provider, model);
  wrapper.append(swatch, document.createTextNode(text));
  return wrapper;
}

// What the range went on: a row per model, under the provider it belongs to
export function drawUsageBreakdown(totals: ModelTotal[]): void {
  const byProvider = new Map<string, ModelTotal[]>();
  for (const total of totals) byProvider.set(total.provider, [...(byProvider.get(total.provider) ?? []), total]);
  const providers = [...byProvider].sort(
    (a, b) => b[1].reduce((n, t) => n + measureOf(t), 0) - a[1].reduce((n, t) => n + measureOf(t), 0)
  );

  const table = document.createElement('table');
  const head = document.createElement('thead');
  // Cached sits beside In rather than inside it, as in the tiles: Usage counts
  // the cached part within input, so it comes off In and the two columns add up
  // to what went to the models. Which of them it was is what the cost turns on
  head.append(usageRow(['Model', 'In', 'Cached', 'Out', 'Cost'], 'th'));
  const body = document.createElement('tbody');
  // A dash rather than a zero where nothing is known about caching, so that a
  // provider that doesn't report it is not read as having cached nothing
  const cachedCell = (total: number, any: boolean) => (any ? tokenCount(total) : '—');
  const reports = (list: ModelTotal[]) => list.some((t) => t.cacheRead !== undefined);
  for (const [provider, list] of providers) {
    const heading = usageRow(
      [
        providerLabel(provider),
        tokenCount(totalOf(list, 'input') - totalOf(list, 'cacheRead')),
        cachedCell(totalOf(list, 'cacheRead'), reports(list)),
        tokenCount(totalOf(list, 'output')),
        money(
          totalOf(list, 'cost'),
          list.some((t) => t.unpriced)
        ),
      ],
      'td'
    );
    heading.className = 'provider';
    body.append(heading);
    for (const t of list) {
      const row = usageRow(
        [
          t.model,
          tokenCount(t.input - (t.cacheRead ?? 0)),
          cachedCell(t.cacheRead ?? 0, t.cacheRead !== undefined),
          tokenCount(t.output),
          money(t.cost, t.unpriced),
        ],
        'td'
      );
      // The model's colour goes in front of its name
      row.firstElementChild!.prepend(swatched('', t.provider, t.model, 'span'));
      body.append(row);
    }
  }
  table.append(head, body);
  usageBreakdown.replaceChildren(table);
}

// What these days came to, one total per purpose, with "subagent/<kind>" keys
// alongside the "subagent" total they are part of
export function usagePurposeTotals(days: string[]): Record<string, PurposeTotal> {
  const merged: Record<string, PurposeTotal> = {};
  for (const day of days) {
    for (const [key, total] of Object.entries(state.dailyPurpose?.[day] ?? {})) {
      const into = (merged[key] ??= { input: 0, output: 0, cost: 0 });
      into.input += total.input;
      into.output += total.output;
      into.cost += total.cost;
      if (total.cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + total.cacheRead;
      if (total.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + total.cacheWrite;
    }
  }
  return merged;
}

// What the range went on, by what each model was asked to do. The subagent
// kinds sit under the Subagent row; whatever the purposes do not account for
// is old data from before they were recorded, said so the totals reconcile.
export function drawUsagePurposes(days: string[]): void {
  const purposes = usagePurposeTotals(days);
  const measure = (total: PurposeTotal) => (usageView === 'cost' ? total.cost : tokensOf(total));
  const biggestPurpose = (a: [string, PurposeTotal], b: [string, PurposeTotal]) =>
    measure(b[1]) - measure(a[1]) || tokensOf(b[1]) - tokensOf(a[1]);
  const names: Record<string, string> = PURPOSES;
  const entries = Object.entries(purposes);
  const top = entries.filter(([key]) => !key.includes('/')).sort(biggestPurpose);

  const table = document.createElement('table');
  const head = document.createElement('thead');
  head.append(usageRow(['Purpose', 'In', 'Cached', 'Out', 'Cost'], 'th'));
  const body = document.createElement('tbody');
  // A dash rather than a zero where caching was not reported, as in the model table
  const cachedCell = (total: PurposeTotal) => (total.cacheRead !== undefined ? tokenCount(total.cacheRead) : '—');
  const addRow = (label: string, total: PurposeTotal) =>
    body.append(
      usageRow(
        [
          label,
          tokenCount(total.input - (total.cacheRead ?? 0)),
          cachedCell(total),
          tokenCount(total.output),
          money(total.cost, false),
        ],
        'td'
      )
    );
  for (const [key, total] of top) {
    addRow(names[key] ?? key, total);
    if (key !== 'subagent') continue;
    for (const [kind, part] of entries.filter(([k]) => k.startsWith('subagent/')).sort(biggestPurpose)) {
      addRow(`↳ ${kind.slice('subagent/'.length)}`, part);
    }
  }

  // Whatever the purposes leave out of the range's total
  const all = usageTotals(days);
  const earlier: PurposeTotal = {
    input: totalOf(all, 'input') - top.reduce((n, [, t]) => n + t.input, 0),
    output: totalOf(all, 'output') - top.reduce((n, [, t]) => n + t.output, 0),
    cost: totalOf(all, 'cost') - top.reduce((n, [, t]) => n + t.cost, 0),
  };
  // Sums of the same costs in a different order can differ by a hair
  if (measure(earlier) > 1e-9) {
    const cacheRead = totalOf(all, 'cacheRead') - top.reduce((n, [, t]) => n + (t.cacheRead ?? 0), 0);
    if (all.some((t) => t.cacheRead !== undefined)) earlier.cacheRead = Math.max(cacheRead, 0);
    addRow('Earlier (purpose not recorded)', earlier);
  }
  table.append(head, body);
  usagePurpose.replaceChildren(table);
}

// A table row, its first cell left and its figures right
export function usageRow(cells: string[], tag: 'th' | 'td'): HTMLTableRowElement {
  const row = document.createElement('tr');
  cells.forEach((text, column) => {
    const cell = document.createElement(tag);
    cell.textContent = text;
    if (column > 0) cell.className = 'figure';
    row.append(cell);
  });
  return row;
}

// A line per day, opening to the models the day went to. Newest first: the
// days somebody is asking about are the recent ones.
export function drawUsageDays(days: string[]): void {
  const used = [...days].reverse().filter((day) => Object.keys(state.daily?.[day] ?? {}).length > 0);
  if (used.length === 0) {
    const none = document.createElement('p');
    none.className = 'hint';
    none.textContent = 'No models were used on these days.';
    usageDaysEl.replaceChildren(none);
    return;
  }
  usageDaysEl.replaceChildren(
    ...used.map((day) => {
      const totals = Object.values(state.daily![day]).sort(biggest);
      const details = dropdown(
        `usage/${day}`,
        `${dayLabel(day, true)} · ${usageLine(totals)}`,
        totals.map((total): Section => [`${providerLabel(total.provider)} · ${total.model}`, usageLine([total])])
      );
      details.className = 'usage-day';
      return details;
    })
  );
}

// What the threads have used that the day-by-day record does not hold: usage
// from before the app kept one, or from further back than it keeps. Said
// plainly, so that a total smaller than somebody remembers is explained
// rather than simply wrong.
export function drawUsageEarlier(): void {
  const threads: Record<string, ModelTotal> = {};
  for (const thread of state.threads) for (const total of Object.values(thread.usage ?? {})) addTotal(threads, total);
  const kept = usageTotals(Object.keys(state.daily ?? {}));
  const tokens =
    Object.values(threads).reduce((n, t) => n + tokensOf(t), 0) - kept.reduce((n, t) => n + tokensOf(t), 0);
  const over = totalOf(Object.values(threads), 'cost') - totalOf(kept, 'cost');
  // Adding the same costs up in a different order can leave a hair's
  // difference between the two sums, so the tokens are what settle whether
  // there is anything to say
  usageEarlier.hidden = tokens < 1;
  usageEarlier.textContent = `The threads also hold ${tokenCount(tokens)} tokens${
    over > 0 ? ` and ${money(over)}` : ''
  } from before the day-by-day record began. Those are in each thread's own total, not on this page.`;
}

export function drawUsage(): void {
  markRange();
  markView();
  markBreakdown();
  hideUsageTip();
  drawUsageEarlier();

  element('usage-chart-label').textContent = usageView === 'cost' ? 'Each day, in cost' : 'Each day, in tokens';

  const days = usageSpan();
  const totals = usageTotals(days);
  // Nothing used yet, or nothing in this range: a page of zeroes beside an
  // empty chart says less than one sentence does
  const empty = totals.length === 0;
  usageEmpty.hidden = !empty;
  usageTiles.hidden = empty;
  element('usage-chart-section').hidden = empty;
  element('usage-breakdown-section').hidden = empty || usageBreakdownView === 'purpose';
  element('usage-purpose-section').hidden = empty || usageBreakdownView === 'model';
  element('usage-days-section').hidden = empty;
  if (empty) {
    // Hidden is not enough: the last range's chart and tables would still be
    // in the page, to be found again by anything that looks
    for (const part of [usageTiles, usageChart, usageLegend, usageBreakdown, usagePurpose, usageDaysEl])
      part.replaceChildren();
    return;
  }

  drawUsageTiles(days, totals);
  drawUsageChart(days);
  drawUsageBreakdown(totals);
  drawUsagePurposes(days);
  drawUsageDays(days);
  showLatestDays();
}

// What one day's column stands for, in full, following the pointer
export function showUsageTip(at: MouseEvent, day: string): void {
  const head = document.createElement('div');
  head.className = 'label';
  let rows: HTMLElement[];
  if (usageBreakdownView === 'purpose') {
    // Read by purpose: one line per purpose, its subagent kinds rolled up under
    // one line, as the chart and the "By purpose" table have it. Each part is
    // read in the measure the chart is, so a purpose's figure matches its bar.
    const dayTotal = Object.values(state.daily?.[day] ?? {});
    const parts = purposePartsForDay(day);
    head.textContent = `${dayLabel(day, true)} · ${parts.length ? usageLine(dayTotal) : 'nothing used'}`;
    rows = parts.map(({ key, label, value }) => {
      const row = purposeSwatched(label, key, 'div');
      const used = document.createElement('small');
      used.textContent = axisTick(value);
      row.append(used);
      return row;
    });
  } else {
    const totals = Object.values(state.daily?.[day] ?? {}).sort(biggest);
    head.textContent = `${dayLabel(day, true)} · ${totals.length ? usageLine(totals) : 'nothing used'}`;
    rows = totals.map((total) => {
      const row = swatched(total.model, total.provider, total.model, 'div');
      const used = document.createElement('small');
      used.textContent = usageLine([total]);
      row.append(used);
      return row;
    });
  }
  usageTip.replaceChildren(head, ...rows);
  usageTip.hidden = false;
  placeUsageTip(at);
}

export function placeUsageTip(at: MouseEvent): void {
  if (usageTip.hidden) return;
  // Back at the origin first, so a position left from last time does not shrink what is measured
  usageTip.style.left = '0px';
  usageTip.style.top = '0px';
  const { width, height } = usageTip.getBoundingClientRect();
  usageTip.style.left = `${Math.max(4, Math.min(at.clientX + 14, window.innerWidth - width - 4))}px`;
  usageTip.style.top = `${Math.max(4, Math.min(at.clientY + 14, window.innerHeight - height - 4))}px`;
}

export function hideUsageTip(): void {
  usageTip.hidden = true;
}

// The latest days are the ones somebody opened the page for, so a range too
// long to fit starts at its right-hand end. Only once the dialog is up: a
// dialog that is not showing has no width to scroll within.
export function showLatestDays(): void {
  const scroll = usageChart.querySelector('.chart-scroll');
  if (scroll) scroll.scrollLeft = scroll.scrollWidth;
}

element('open-usage').addEventListener('click', () => {
  drawUsage();
  usageDialog.showModal();
  // Again now the dialog is up, since it had no width to scroll within before
  showLatestDays();
});
element('usage-close').addEventListener('click', () => usageDialog.close());
// Esc closes the dialog without the button being pressed, and a tooltip left
// over would sit on top of the page behind it
usageDialog.addEventListener('close', hideUsageTip);

// One line per call made to a model, numbered in the order they were made:
// "3. Reply · claude-opus-5-5: 14,210 tokens"
