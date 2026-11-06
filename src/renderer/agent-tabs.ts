import type { AgentEvent, Message, Thread } from './types.js';
import type { Watched } from './workspace-dialog.js';
import { onTab, tabs, tabsEl, tabsOf } from './shared.js';
import { activate, save } from './threads.js';
import { render } from './thread-view.js';
import { subagentKey } from './thread-dialog.js';
import { CONDENSED, WAITING, waitingTurn } from './reply.js';
import { clip, summarizeInput, summarizeOutput } from './events.js';
import { toolOf } from './tool-calls.js';
import { about, usedLine } from './usage.js';

export function shownAgent(thread: Thread): Message | undefined {
  const key = onTab.get(thread.id);
  if (!key) return undefined;
  return thread.messages.find((m) => m.role === 'subagent' && subagentKey(m) === key);
}

// Opens a subagent in a tab of its thread, and shows it
export function openAgentTab(thread: Thread, subagent: Message): void {
  const key = subagentKey(subagent);
  const open = tabsOf(thread);
  if (!open.includes(key)) tabs.set(thread.id, [...open, key]);
  onTab.set(thread.id, key);
  activate(thread);
  save();
  render();
}

export function closeAgentTab(thread: Thread, key: string): void {
  tabs.set(
    thread.id,
    tabsOf(thread).filter((one) => one !== key)
  );
  if (onTab.get(thread.id) === key) onTab.delete(thread.id);
  render();
}

// The circumference of the circle the ring is drawn with, which its dashes are
// measured in. A stroke as wide as the radius fills the disc from the middle
// out, so the ring reads as a pie rather than as a hoop — legible at the size
// a tab has room for, where a hoop is not.
export const RING = 2 * Math.PI * 4.5;

// How a subagent is doing, as the dot on its tab. Four states, and they are
// four different things: working with no word on how far along it is, working
// and part way through, finished, and finished with something worth knowing —
// it failed, or its report was cut off for length (see the 'subagent_done'
// event).
export function subagentStatus(subagent: Message): SVGElement | HTMLElement {
  const working = subagent.finding === undefined;
  if (working && subagent.progress !== undefined) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'status ring');
    svg.setAttribute('viewBox', '0 0 20 20');
    const circle = (r: string, cls: string) => {
      const one = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      one.setAttribute('cx', '10');
      one.setAttribute('cy', '10');
      one.setAttribute('r', r);
      one.setAttribute('class', cls);
      return one;
    };
    const filled = circle('4.5', 'done');
    // Set as attributes rather than as a style, which the page's policy
    // refuses (see the CSP in index.html)
    filled.setAttribute('stroke-dasharray', `${(RING * subagent.progress) / 100} ${RING}`);
    filled.setAttribute('transform', 'rotate(-90 10 10)');
    svg.append(circle('9', 'track'), filled);
    svg.setAttribute('aria-label', `${Math.round(subagent.progress)}% done`);
    return svg;
  }
  const status = document.createElement('span');
  status.className = `status ${working ? 'working' : subagent.failed ? 'failed' : subagent.cut ? 'cut' : 'done'}`;
  status.title = working
    ? 'Still working'
    : subagent.failed
      ? 'Did not finish'
      : subagent.cut
        ? 'Finished, but its report was too long and was cut'
        : 'Finished';
  return status;
}

// The tab bar: the thread, then its subagents, each closable
export function drawTabs(thread: Thread): void {
  const open = tabsOf(thread);
  tabsEl.hidden = open.length === 0;
  if (open.length === 0) {
    onTab.delete(thread.id);
    tabsEl.replaceChildren();
    return;
  }
  const showing = onTab.get(thread.id);
  const tab = (key: string | undefined, label: string, subagent?: Message) => {
    const el = document.createElement('button');
    el.className = 'tab';
    el.classList.toggle('active', showing === key);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(showing === key));

    if (subagent) el.append(subagentStatus(subagent));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    el.append(name);
    el.addEventListener('click', () => {
      if (key) onTab.set(thread.id, key);
      else onTab.delete(thread.id);
      render();
    });

    if (key) {
      const shut = document.createElement('span');
      shut.className = 'shut';
      shut.textContent = '×';
      shut.title = 'Close this tab';
      shut.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAgentTab(thread, key);
      });
      el.append(shut);
    }
    return el;
  };

  tabsEl.replaceChildren(
    tab(undefined, 'Thread'),
    ...open.map((key) => {
      const subagent = thread.messages.find((m) => m.role === 'subagent' && subagentKey(m) === key);
      return tab(key, subagent?.text ?? 'Subagent', subagent);
    })
  );
}

// One thing an agent did, as a message of the thread it is doing it in. The
// same shapes a reply leaves behind, so that what an agent did reads the way a
// reply reads (see drawMessages).
export function appendEvent(out: Message[], event: AgentEvent): void {
  if (event.type === 'thought') {
    out.push({ role: 'thought', text: event.text, thoughtId: `${out.length}` });
  } else if (event.type === 'queued') {
    // One of several subagents, waiting for the model the others are using:
    // without this it reads as one that was handed work and did nothing with
    // it (see llm/cachelock.ts)
    out.push({ role: 'note', text: event.model ? waitingTurn(event.model) : WAITING });
  } else if (event.type === 'waited') {
    // Its turn came, so the notice goes: what it waited is reported with the
    // tokens its step used, as a thread's own wait is
    const at = out.findLastIndex((one) => one.role === 'note' && one.text.startsWith('Waiting'));
    if (at >= 0) out.splice(at, 1);
  } else if (event.type === 'condensing') {
    out.push({ role: 'note', text: 'Condensing what it has found' });
  } else if (event.type === 'condensed') {
    // Over: the notice that it was happening becomes a record that it did,
    // which stays in the work as a tool call does, or goes if nothing came of it
    const at = out.findLastIndex((one) => one.role === 'note' && one.text === 'Condensing what it has found');
    if (at < 0) return;
    if (event.changed) out[at].text = CONDENSED;
    else out.splice(at, 1);
  } else if (event.type === 'shortening') {
    // Said rather than passed over: the report below it is the second one it
    // wrote, and a reader comparing it with the work above should know why
    out.push({ role: 'note', text: 'Its report was too long; shortening it' });
  } else if (event.type === 'rate_limited') {
    const seconds = Math.max(1, Math.round(event.after / 1000));
    out.push({
      role: 'note',
      text:
        `${event.unreachable ? 'Could not reach the provider' : 'Rate limited'}; ` +
        `trying again in ${seconds}s (attempt ${event.attempt + 1} of ${event.of})`,
    });
  } else if (event.type === 'fell_back') {
    out.push({ role: 'note', text: `Out of credit on ${event.from}; continuing on ${event.to}.` });
  } else if (event.type === 'progress') {
    // How far along it says it is, which is drawn on its tab rather than
    // written into its work (see drawTabs)
    return;
  } else if (event.type === 'tool_call') {
    out.push({
      role: 'tool',
      text: `Used ${event.name}`,
      tool: event.name,
      callId: event.id,
      input: clip(event.input === null ? 'The input was not valid JSON.' : JSON.stringify(event.input, null, 2)),
      inputSummary: summarizeInput(event.input),
    });
  } else {
    // What the call came back with, onto the call it answers
    const call = out.find((one) => one.callId === event.id);
    if (!call) return;
    if (event.isError) {
      call.text += ' (failed)';
      call.failure = clip(event.output);
      delete call.inputSummary;
    } else {
      const [first, ...rest] = event.output.split('\n\n');
      const diff = ['write_file', 'edit_file'].includes(toolOf(call)) ? rest.join('\n\n') : '';
      call.output = summarizeOutput(diff ? first : event.output);
      if (diff) call.diff = clip(diff);
      if (event.images?.length) call.images = event.images;
      delete call.input;
    }
  }
}

// What a subagent did, as the messages a thread is made of. Its task is what
// it was asked, its thoughts and tool calls are its work, and its report is
// its reply — so the same drawing reads it the same way (see drawMessages).
export function agentMessages(watched: Watched): Message[] {
  const out: Message[] = [];
  if (watched.task) out.push({ role: 'user', text: watched.task, fromApp: true, label: watched.goal });
  // Above the work, where a thread has the note about how its message was
  // rated and which model took it
  if (watched.rating) out.push({ role: 'note', text: watched.rating });
  // ...and what it has used so far, as the thread's own note says it, with a
  // clock running beside it while it works. The call it is on counts towards
  // this as it is written (see Live), so it climbs rather than standing still
  // between calls; before anything has arrived, the clock is all there is.
  const since = watched.working ? watched.since : undefined;
  if (watched.usage?.length) {
    const text = `${watched.counting ? 'Tokens so far' : 'Tokens'}: ${about(
      usedLine(watched.usage),
      watched.usage.some((one) => one.estimated)
    )}`;
    out.push({ role: 'note', text, since });
  } else if (since !== undefined) out.push({ role: 'note', text: 'Working', since });
  for (const event of watched.events ?? []) {
    appendEvent(out, event);
  }
  if (watched.result) out.push({ role: watched.failed ? 'error' : 'assistant', text: watched.result });
  else if (watched.working) out.push({ role: 'assistant', text: '', streaming: true });
  return out;
}
