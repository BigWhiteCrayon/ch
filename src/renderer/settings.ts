import type {
  Message,
  ModelInfo,
  OllamaStatus,
  PublicSettings,
  SettingsPatch,
  SuggestedModel,
  Thread,
} from './types.js';
import {
  allModels,
  automatic,
  element,
  getRetainedHostedModels,
  inflight,
  models,
  providers,
  requests,
} from './shared.js';
import { applyTheme, drawOffline, loadModels, modelKey } from './models.js';
import { save, state } from './threads.js';
import { clock } from './usage.js';
import { render } from './thread-view.js';
import { handleEvent } from './events.js';
export const settingsDialog = element<HTMLDialogElement>('settings');
export const settingsStatus = element('settings-status');
export const localUrlInput = element<HTMLInputElement>('local-url');
const localMaxContextInput = element<HTMLInputElement>('local-max-context');
export const sandboxImageInput = element<HTMLInputElement>('sandbox-image');
export const approvalCeilingSelect = element<HTMLSelectElement>('approval-ceiling');
export const autoReviewBox = element<HTMLInputElement>('auto-review');
export const themeInputs = [...document.querySelectorAll<HTMLInputElement>('[data-theme-var]')];
export const themeReset = element('theme-reset');
const offlineWarning = element('settings-offline-warning');
export const keyInputs = {
  anthropic: element<HTMLInputElement>('anthropic-key'),
  openai: element<HTMLInputElement>('openai-key'),
  local: element<HTMLInputElement>('local-key'),
};
export type ProviderId = keyof typeof keyInputs;
export const PROVIDER_IDS = Object.keys(keyInputs) as ProviderId[];
// Providers whose models can be switched off
export const HOSTED = ['anthropic', 'openai'] as const;
export let settings: PublicSettings;
export function setSettings(value: PublicSettings): void {
  settings = value;
}

// The sections of the settings: one per provider, and the container the
// threads are given. The one last looked at is shown again next time.
export type SettingsTab = ProviderId | 'sandbox' | 'general';
export const SETTINGS_TABS: SettingsTab[] = [...PROVIDER_IDS, 'sandbox', 'general'];
export const isSettingsTab = (name: string | undefined): name is SettingsTab =>
  SETTINGS_TABS.includes(name as SettingsTab);
// ...and the one the dialog opens on before it has been anywhere else, which
// is the first of them: that is the tab the markup has selected (see
// index.html), and a default that disagrees with the markup opens the dialog
// on a tab the user never chose, with the keyboard starting from there as
// well (see the arrow keys below).
export let settingsTab: SettingsTab = SETTINGS_TABS[0];

export const settingsTabs = element('settings-tabs');
export const settingsHint = element('settings-hint');
export const tabButtons = () => [...settingsTabs.querySelectorAll<HTMLElement>('[role="tab"]')];

export function showTab(tab: SettingsTab): void {
  settingsTab = tab;
  for (const button of tabButtons()) {
    const on = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(on));
    // Only the selected tab is in the tab order; the arrow keys move between
    // them, as a list of this kind is meant to work
    button.tabIndex = on ? 0 : -1;
  }
  for (const panel of settingsDialog.querySelectorAll<HTMLElement>('[role="tabpanel"]')) {
    panel.hidden = panel.dataset.panel !== tab;
  }
  // What the hint explains — which model answers a message — is what the
  // provider sections are about and has nothing to do with the container
  settingsHint.hidden = tab === 'sandbox';
}

for (const button of tabButtons()) {
  button.addEventListener('click', () => {
    if (isSettingsTab(button.dataset.tab)) showTab(button.dataset.tab);
  });
}

// Up and down the list, and to either end of it
settingsTabs.addEventListener('keydown', (event) => {
  const at = SETTINGS_TABS.indexOf(settingsTab);
  const moves: Record<string, SettingsTab | undefined> = {
    ArrowDown: SETTINGS_TABS[(at + 1) % SETTINGS_TABS.length],
    ArrowRight: SETTINGS_TABS[(at + 1) % SETTINGS_TABS.length],
    ArrowUp: SETTINGS_TABS[(at - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length],
    ArrowLeft: SETTINGS_TABS[(at - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length],
    Home: SETTINGS_TABS[0],
    End: SETTINGS_TABS.at(-1),
  };
  const next = moves[event.key];
  if (!next) return;
  event.preventDefault();
  showTab(next);
  tabButtons()
    .find((button) => button.dataset.tab === next)
    ?.focus();
});

// What the levels are called (see llm/sophistication.ts)
export const LEVEL_NAMES = ['Basic', 'Capable', 'Strong', 'Advanced', 'Frontier'];

// The ratings (1-5) that Auto sends to each model, by model key: a message
// goes to the least sophisticated model that meets its rating, a local one
// first on a tie, or failing that to the best there is. Mirrors route() in
// harness/router.ts.
export function autoRatings(): Map<string, number[]> {
  const served = new Map<string, number[]>();
  const cheapestFirst = [...models].sort(
    (a, b) => a.sophistication - b.sophistication || Number(b.local) - Number(a.local)
  );
  for (let rating = 1; rating <= 5; rating++) {
    const model = cheapestFirst.find((m) => m.sophistication >= rating) ?? models[0];
    if (!model) break;
    const key = modelKey(model);
    served.set(key, [...(served.get(key) ?? []), rating]);
  }
  return served;
}

// A model's level, and when Auto uses it: "Advanced · 4/5 · used for ratings 3–4"
export function levelSummary(m: ModelInfo, ratings: Map<string, number[]>): string {
  const level = `${LEVEL_NAMES[m.sophistication - 1] ?? 'Level'} · ${m.sophistication}/5`;
  if (m.disabled) return `${level} · switched off`;
  const served = ratings.get(modelKey(m));
  if (!served) return `${level} · not picked by Auto`;
  const range = served.length === 1 ? `rating ${served[0]}` : `ratings ${served[0]}–${served.at(-1)}`;
  return `${level} · used for ${range}`;
}

// A hosted model shown while Offline Mode is on is greyed out (see the
// '.unavailable' class, which greys its on-switch), but the switch stays on
// and toggleable: the choice is saved to disabledModels and takes effect once
// Offline Mode is off.
export function modelRow(m: ModelInfo, ratings: Map<string, number[]>, away = false): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'row';
  if (away) row.classList.add('unavailable');

  if ((HOSTED as readonly string[]).includes(m.provider)) {
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'toggle';
    enabled.setAttribute('role', 'switch');
    enabled.title = 'Use this model';
    enabled.checked = !m.disabled;
    enabled.dataset.model = m.id;
    row.append(enabled);
  }

  const name = document.createElement('span');
  name.textContent = m.name;

  const summary = document.createElement('small');
  summary.className = 'level';
  summary.textContent = levelSummary(m, ratings);

  const level = document.createElement('select');
  level.title = 'Set the level yourself';
  level.dataset.model = modelKey(m);
  for (const value of ['', '1', '2', '3', '4', '5']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value || 'Auto';
    level.append(option);
  }
  level.value = String(settings.sophistication[modelKey(m)] ?? '');

  row.append(name, summary, level);
  return row;
}

// A variable's current colour as '#rrggbb', which is what a colour input takes
export function cssVarHex(name: string): string {
  const span = document.createElement('span');
  span.style.visibility = 'hidden';
  span.style.color = `var(${name})`;
  document.body.append(span);
  const rgb = getComputedStyle(span).color;
  document.body.removeChild(span);
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return '#000000';
  return (
    '#' +
    match
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  );
}

export const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// The family a hosted model belongs to, for grouping the settings list:
// claude-opus-4-1 -> Opus, gpt-5-mini -> gpt-5, o3-mini -> o3
export function modelFamily(m: ModelInfo): { key: string; label: string } {
  const id = m.id.toLowerCase();
  if (m.provider === 'anthropic') {
    const word = id.match(/opus|sonnet|haiku|fable|mythos/)?.[0];
    if (word) return { key: word, label: capitalise(word) };
    const token = id
      .replace(/^claude-/, '')
      .split('-')
      .find((part) => part && !/^\d+$/.test(part));
    return token ? { key: token, label: capitalise(token) } : { key: 'Other', label: 'Other' };
  }
  const key = id.match(/^(gpt-\d+o?|o\d+)/)?.[0] ?? id.split('-')[0];
  return { key, label: key };
}

// Ollama: which local models are downloaded, and downloading more

export const ollamaStatus = element('ollama-status');
export const ollamaList = document.querySelector('.model-list[data-provider="local"]') as HTMLElement;
export const ollamaOther = element('ollama-other');
export const ollamaModelInput = element<HTMLInputElement>('ollama-model');
export const ollamaDownload = element<HTMLButtonElement>('ollama-download');
export let ollama: OllamaStatus = { reachable: false, url: '', installed: [], suggested: [] };
// Downloads in progress: model name -> progress text
export const downloads = new Map<string, string>();
// Model name -> the element showing its progress
export const progressLabels = new Map<string, HTMLElement>();

export const formatSize = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

// A model that can be downloaded. A suggested one comes with a preview: the
// level it will get and the memory it wants.
export function downloadRow(name: string, suggestion?: SuggestedModel): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row download';

  const label = document.createElement('span');
  label.textContent = name;

  const about = document.createElement('small');
  about.className = 'about';
  if (suggestion) {
    const { sophistication, memoryGB } = suggestion;
    const level = `${LEVEL_NAMES[sophistication - 1] ?? 'Level'} · ${sophistication}/5`;
    about.textContent = `${level} · Recommended ${memoryGB}GB Memory`;
  }

  const progress = document.createElement('small');
  // Empty until a download is under way
  progress.textContent = downloads.get(name) ?? '';
  progressLabels.set(name, progress);

  const button = document.createElement('button');
  button.type = 'button';
  if (downloads.has(name)) {
    button.textContent = 'Cancel';
    button.addEventListener('click', () => window.ollamaApi.cancel(name));
  } else {
    button.textContent = 'Download';
    button.addEventListener('click', () => startDownload(name));
  }

  row.append(label, ...(suggestion ? [about] : []), progress, button);
  return row;
}

export function renderOllama(): void {
  const local = allModels.filter((m) => m.provider === 'local');
  const ratings = autoRatings();
  ollamaOther.hidden = !ollama.reachable;
  progressLabels.clear();

  if (!ollama.reachable) {
    // Not Ollama, or not running. Another OpenAI-compatible server may still
    // be serving models at this URL, so show whatever it offers.
    ollamaStatus.textContent =
      `Ollama isn't reachable at ${ollama.url}. Install it from ollama.com and start it ` +
      'to see and download models.';
    ollamaList.replaceChildren(...local.map((m) => modelRow(m, ratings)));
    return;
  }

  const sizes = new Map(ollama.installed.map((m) => [m.name, m.size]));
  const installed = local.map((m) => {
    const row = modelRow(m, ratings);
    const size = sizes.get(m.id);
    const name = row.querySelector('span') as HTMLElement;
    name.textContent += size ? ` · ${formatSize(size)} · Downloaded` : ' · Downloaded';
    return row;
  });
  // Suggestions that aren't downloaded, plus anything else being downloaded
  const suggestions = new Map(ollama.suggested.map((m) => [m.name, m]));
  const pending = [...new Set([...suggestions.keys(), ...downloads.keys()])].filter((name) => !sizes.has(name));

  ollamaStatus.textContent =
    `Connected to Ollama. ${installed.length} downloaded, ` + `${pending.length} available to download.`;
  ollamaList.replaceChildren(...installed, ...pending.map((name) => downloadRow(name, suggestions.get(name))));
}

export function startDownload(name: string): void {
  if (!name || downloads.has(name)) return;
  downloads.set(name, 'Starting…');
  window.ollamaApi.pull(name);
  renderOllama();
}

// A workspace's first note, pushed from the main process the moment it is written
// (see harness/project.ts). Every thread started in that workspace is shown it,
// not only the one whose message set the explorer going: the note is about the
// workspace, and the others are working in it too.
// What the app is reading a workspace for, as the first message of the thread
// it does it in
export const LOOKING_TASK = 'Get to know the project in this workspace.';
export const LOOKING_TITLE = 'Getting to know the project';
// What its reply says until the look has anything to show
export const LOOKING_STATUS = 'Reading the workspace…';

// The thread a look in this workspace writes into, started if there is none.
// It is written into the way a reply is written into a thread: the request it
// is doing the writing under is registered here too, so that everything the
// window knows how to draw — thoughts, tool calls, the subagents the head
// explorer sends and the tabs they open in, what it all cost — works without
// knowing a look from a reply (see handleEvent).
//
// A look that has finished leaves its thread behind as it is, so the next one
// starts its own rather than writing under an answer.
export function automaticThread(workspace: string, task?: string): Thread {
  const going = automatic.get(workspace);
  const found = state.threads.find((thread) => thread.id === going);
  if (found) return found;
  const asked: Message = { role: 'user', text: task ?? LOOKING_TASK, fromApp: true };
  const message: Message = { role: 'assistant', text: '', streaming: true, status: LOOKING_STATUS };
  const thread: Thread = {
    id: crypto.randomUUID(),
    title: LOOKING_TITLE,
    workspace,
    automatic: true,
    lastActive: Date.now(),
    messages: [asked, message],
  };
  state.threads.unshift(thread);
  const requestId = crypto.randomUUID();
  automatic.set(workspace, thread.id);
  inflight.set(thread.id, requestId);
  requests.set(requestId, {
    startedAt: Date.now(),
    thread,
    message,
    asked,
    usage: [],
    thoughts: [],
    calls: [],
    subagents: new Map(),
    live: new Map(),
  });
  clock(Date.now());
  return thread;
}

// The request a look is writing under, while it is
export function lookRequest(workspace: string): string | undefined {
  const thread = automatic.get(workspace);
  return thread ? inflight.get(thread) : undefined;
}

// A look starting or ending, pushed from the main process.
window.threads.onLooking((workspace, going, task) => {
  if (going) {
    automaticThread(workspace, task);
    save();
    render();
    return;
  }
  // Ended: closed off the way a reply is, which drops the bubble nothing was
  // written into, notes what it cost and lets the thread be used again
  const requestId = lookRequest(workspace);
  automatic.delete(workspace);
  if (requestId)
    handleEvent(requestId, { type: 'done', stopReason: 'end_turn', usage: { input: 0, output: 0 }, steps: 0 });
  else {
    save();
    render();
  }
});

// What the look says while it works, put through the same handler a reply's
// events go through
window.threads.onLookEvent((workspace, event) => {
  const requestId = lookRequest(workspace);
  if (requestId) handleEvent(requestId, event);
});

// Whatever was already going on before this window opened. Asked for by start,
// once every part of the window is in place: the answer draws the sidebar.
export function pickUpLooks(): void {
  void window.threads
    .looking()
    .then((workspaces) => {
      for (const workspace of workspaces) automaticThread(workspace);
      if (workspaces.length > 0) {
        save();
        render();
      }
    })
    .catch(() => {});
}

window.threads.onSurveyed((workspace, note) => {
  if (!note.trim()) return;
  let shown = false;
  for (const thread of state.threads) {
    if (thread.workspace !== workspace) continue;
    // In the thread that did the looking, the note is the answer: it is what
    // the work came to, and the thread reads like any other with it there
    if (thread.automatic) {
      if (thread.messages.some((m) => m.role === 'assistant' && m.text === note)) continue;
      // Into the bubble the look is still writing into, where there is one, so
      // that it reads as the answer rather than as something added afterwards
      const writing = requests.get(inflight.get(thread.id) ?? '');
      if (writing && !writing.message.text) {
        writing.message.text = note;
        delete writing.message.status;
      } else {
        thread.messages.push({ role: 'assistant', text: note });
      }
    } else {
      // Once per thread, however many times it is pushed
      if (thread.messages.some((m) => m.role === 'note' && m.blurb === note)) continue;
      thread.messages.push({
        role: 'note',
        text: 'Gathered context on this workspace',
        blurb: note,
        thoughtId: crypto.randomUUID(),
      });
    }
    shown = true;
    if (thread.id === state.activeId) render();
  }
  if (shown) save();
});

window.ollamaApi.onProgress(async ({ name, status, percent, done, error }) => {
  if (!done) {
    const text = percent == null ? (status ?? '') : `${percent}%`;
    downloads.set(name, text);
    const label = progressLabels.get(name);
    if (label) label.textContent = text;
    return;
  }
  downloads.delete(name);
  await loadModels();
  ollama = await window.ollamaApi.status();
  renderOllama();
  if (error) ollamaStatus.textContent = `Could not download ${name}: ${error}`;
});

ollamaDownload.addEventListener('click', () => {
  startDownload(ollamaModelInput.value.trim());
  ollamaModelInput.value = '';
});

ollamaModelInput.addEventListener('keydown', (e) => {
  // Enter would otherwise submit the whole settings form
  if (e.key !== 'Enter') return;
  e.preventDefault();
  ollamaDownload.click();
});

// A model family as a collapsed dropdown with a master switch for its versions
export function familyDetails(
  key: string,
  family: { label: string; rows: HTMLLabelElement[]; on: boolean },
  away = false
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'family';
  // A family that can't be reached shows its master switch greyed too, not just
  // its models: a collapsed family shows only the switch, which would otherwise
  // read as fully on while its models are greyed out (see .unavailable below).
  if (away) details.classList.add('unavailable');

  const head = document.createElement('summary');
  head.className = 'family-head';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'family-toggle';
  toggle.setAttribute('role', 'switch');
  toggle.title = 'Use this model family';
  toggle.checked = family.on;
  toggle.dataset.family = key;

  const name = document.createElement('span');
  name.textContent = family.label;

  const count = document.createElement('small');
  count.textContent = `${family.rows.length} models`;

  head.append(toggle, name, count);

  const body = document.createElement('div');
  body.className = 'family-models';
  body.append(...family.rows);

  const boxes = () => body.querySelectorAll<HTMLInputElement>('input[data-model]');
  if (!family.on) for (const box of boxes()) box.disabled = true;
  toggle.addEventListener('change', () => {
    for (const box of boxes()) {
      box.checked = toggle.checked;
      box.disabled = !toggle.checked;
    }
  });

  details.append(head, body);
  return details;
}

export function renderSettings(): void {
  for (const provider of PROVIDER_IDS) {
    const keyInput = keyInputs[provider];
    const hasKey = settings[provider].hasKey;
    keyInput.value = '';
    keyInput.placeholder = hasKey ? 'Saved — leave blank to keep' : 'Not set';
    const remove = document.querySelector(`.remove-key[data-provider="${provider}"]`) as HTMLElement;
    remove.hidden = !hasKey;
  }
  localUrlInput.value = settings.local.baseURL;
  localMaxContextInput.value = settings.local.maxContext?.toString() ?? '';
  sandboxImageInput.value = settings.sandbox.image;
  approvalCeilingSelect.value = String(settings.approvalCeiling);
  autoReviewBox.checked = settings.autoReview;

  for (const input of themeInputs) {
    const name = input.dataset.themeVar ?? '';
    input.value = settings.theme[name] ?? cssVarHex(name);
  }

  showTab(settingsTab);
  const offline = settings.offline;
  if (offline) {
    offlineWarning.textContent =
      'Offline Mode is on — hosted models are shown for reference and can be switched, ' +
      'but are not used until Offline Mode is off.';
    offlineWarning.hidden = false;
  } else {
    offlineWarning.hidden = true;
  }
  renderOllama();
  const ratings = autoRatings();
  for (const list of document.querySelectorAll<HTMLElement>('.model-list')) {
    const provider = list.dataset.provider;
    if (provider === 'local') continue;
    const source = offline ? getRetainedHostedModels() : allModels;
    const models = source.filter((m) => m.provider === provider);
    const rows = models.map((m) => modelRow(m, ratings, offline));
    if (rows.length > 0) {
      // One collapsed dropdown per family, in the order each family first appears
      const families = new Map<string, { label: string; rows: HTMLLabelElement[]; on: boolean }>();
      models.forEach((m, i) => {
        const { key, label } = modelFamily(m);
        const family = families.get(key) ?? { label, rows: [], on: false };
        family.rows.push(rows[i]);
        family.on ||= !m.disabled;
        families.set(key, family);
      });
      // Saving a change draws the list again, so the families that were open stay open
      const open = new Set(
        [...list.querySelectorAll<HTMLElement>('details.family[open] .family-toggle')].map((t) => t.dataset.family)
      );
      list.replaceChildren(
        ...[...families].map(([key, family]) => {
          const details = familyDetails(key, family, offline);
          details.open = open.has(key);
          return details;
        })
      );
    } else {
      const status = providers.find((p) => p.id === provider);
      list.textContent = status?.error ?? 'No models found.';
    }
  }
}

export async function saveSettings(patch: SettingsPatch): Promise<void> {
  try {
    settings = await window.settingsApi.save(patch);
    applyTheme(settings.theme);
  } catch (err) {
    settingsStatus.textContent = (err as Error).message;
    return;
  }
  await loadModels();
  ollama = await window.ollamaApi.status();
  renderSettings();
  settingsStatus.textContent = 'Saved.';
}

// The Offline switch is in the app's own menu, beside Quit (see ../menu.ts).
// Thrown there, it changes which models exist as far as this window is
// concerned, so what is on offer is asked for again and a model the user had
// picked may be dropped (see loadModels).
window.settingsApi.onChanged(async (updated) => {
  settings = updated;
  applyTheme(settings.theme);
  drawOffline();
  await loadModels();
  if (settingsDialog.open) renderSettings();
});

element('open-settings').addEventListener('click', async () => {
  settings = await window.settingsApi.get();
  ollama = await window.ollamaApi.status();
  settingsStatus.textContent = '';
  renderSettings();
  settingsDialog.showModal();
});

element('settings-close').addEventListener('click', () => settingsDialog.close());

// Applies at once, like the Offline switch
approvalCeilingSelect.addEventListener('change', () => {
  saveSettings({ approvalCeiling: Number(approvalCeilingSelect.value) });
});

autoReviewBox.addEventListener('change', () => {
  saveSettings({ autoReview: autoReviewBox.checked });
});

// The colour pickers apply at once too. The patch replaces the whole theme, so an empty one resets it
for (const input of themeInputs) {
  const name = input.dataset.themeVar ?? '';
  input.addEventListener('change', () => {
    saveSettings({ theme: { ...settings.theme, [name]: input.value } });
  });
}
themeReset.addEventListener('click', () => {
  saveSettings({ theme: {} });
});

// Asking the user before a model rated above their approval level is used (see
// the 'approval' event). The harness waits for the answer. The question is put
// in the thread itself (see approvalCard), and the thread says so in the
// sidebar, so a thread that is waiting is noticed whichever one is showing.
for (const button of document.querySelectorAll<HTMLElement>('.remove-key')) {
  button.addEventListener('click', () => {
    saveSettings({ [button.dataset.provider as ProviderId]: { apiKey: null } });
  });
}

// Everything in the form saves as it is changed, so there is no Save button. Enter must not reload the page
element('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
});

// A model's level, a hosted model's switch or a family's switch
settingsDialog.addEventListener('change', (e) => {
  if (!(e.target as HTMLElement).matches('.model-list select, .model-list input[type="checkbox"]')) return;

  // Start from what's saved so models that aren't listed right now keep their settings
  const sophistication = { ...settings.sophistication };
  for (const level of settingsDialog.querySelectorAll<HTMLSelectElement>('.model-list select')) {
    const model = level.dataset.model as string;
    if (level.value) sophistication[model] = Number(level.value);
    else delete sophistication[model];
  }

  const hosted = (provider: (typeof HOSTED)[number]) => {
    const disabled = new Set(settings[provider].disabledModels);
    const boxes = settingsDialog.querySelectorAll<HTMLInputElement>(
      `.model-list[data-provider="${provider}"] input[type="checkbox"][data-model]`
    );
    for (const box of boxes) {
      const model = box.dataset.model as string;
      if (box.checked) disabled.delete(model);
      else disabled.add(model);
    }
    return { disabledModels: [...disabled] };
  };

  saveSettings({ anthropic: hosted('anthropic'), openai: hosted('openai'), sophistication });
});

localUrlInput.addEventListener('change', () => {
  saveSettings({ local: { baseURL: localUrlInput.value } });
});

localMaxContextInput.addEventListener('change', () => {
  const tokens = localMaxContextInput.valueAsNumber;
  void saveSettings({ local: { maxContext: Number.isFinite(tokens) ? tokens : null } }).then(() => {
    // Too small a limit is raised to the least that works
    localMaxContextInput.value = settings.local.maxContext?.toString() ?? '';
  });
});

sandboxImageInput.addEventListener('change', () => {
  saveSettings({ sandbox: { image: sandboxImageInput.value } });
});

for (const provider of PROVIDER_IDS) {
  keyInputs[provider].addEventListener('change', () => {
    // A blank key field means "keep the saved key" (the Remove button deletes it)
    const apiKey = keyInputs[provider].value;
    if (apiKey.trim()) saveSettings({ [provider]: { apiKey } });
  });
}
