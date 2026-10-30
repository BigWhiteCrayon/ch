// The flow the window shows on the way in, when something the app needs is
// missing (see ../setup/checks.ts for what it needs and why).
//
// Three steps, always all three, because two of them are alternatives rather
// than a sequence: a local model and a hosted key are each enough on their own
// and the flow insists on one of them, so a user who means to use hosted
// models has to be shown the keys step even while Ollama sits there unused.
// What is already satisfied carries a tick and asks nothing.
//
// Nothing here is finished by this window: installing Docker is a process of
// its own and downloading a model is Ollama's business, so every step works by
// starting something and then asking the main process what came of it. That is
// also why it polls — an Ollama the user has just installed starts itself, and
// the flow notices rather than making them click anything.

import type { Installable, SetupStatus, SuggestedModel } from './types.js';
import { element } from './shared.js';
import { loadModels } from './models.js';
import { downloads, settingsDialog, startDownload } from './settings.js';

export const setupDialog = element<HTMLDialogElement>('setup-dialog');
export const setupTitle = element('setup-title');
export const setupSteps = element<HTMLOListElement>('setup-steps');
export const setupBlurb = element('setup-blurb');
export const setupBody = element('setup-body');
export const setupLog = element('setup-log');
export const setupStatus = element('setup-status');
export const setupLater = element<HTMLButtonElement>('setup-later');
export const setupSkip = element<HTMLButtonElement>('setup-skip');
export const setupBack = element<HTMLButtonElement>('setup-back');
export const setupNext = element<HTMLButtonElement>('setup-next');

// Settings is where the flow is reopened from, and two modal dialogs at once
// leaves the page with nothing to go back to
const settingsDialogToClose = () => settingsDialog.open && settingsDialog.close();

export type StepId = 'local' | 'keys' | 'docker';
export const STEPS: StepId[] = ['local', 'keys', 'docker'];

// What each step is called in the row of steps, and what it is about
const SHORT: Record<StepId, string> = {
  local: 'Models on this computer',
  keys: 'Hosted models',
  docker: 'Containers',
};
const BLURBS: Record<StepId, string> = {
  local:
    'Ollama runs the small model that sizes up every message and decides where it goes, and the embeddings ' +
    'behind searching a workspace by meaning. This one is not optional: nothing else here serves an ' +
    'embedding model, and a search without one is reduced to keyword matching.',
  keys:
    'Anthropic and OpenAI models are reached over the network and cost money. A key here is what lets the ' +
    'router send the harder messages to one. Optional, so long as there is a model on this computer for ' +
    'the routing to land on instead.',
  docker:
    'Every thread started in a workspace gets a container of its own, which is where it runs commands and ' +
    'reads and writes code. Nothing is written back to your own folder until you ask for it. Without Docker ' +
    'you get plain chat and nothing else.',
};

// What the flow will not be finished without, in the order it asks for them,
// and why each one is wanted. Null when there is nothing left to ask for.
//
// Ollama is first and is not negotiable: the embedding model behind
// search_workspace is served by nothing else here (see search/embeddings.ts),
// so an app without it has a search that only pretends to be one.
export function blocking(s: SetupStatus): string | null {
  if (!s.local.reachable) {
    return (
      'Ollama has to be running: the workspace search is built on an embedding model, and nothing else ' +
      'here serves one.'
    );
  }
  if (!s.local.embedding) {
    return (
      `Download ${s.local.embeddingModel}: the workspace search is built on it, and without it searching ` +
      'a workspace falls back to matching keywords.'
    );
  }
  if (!s.canAnswer) return 'Download a model or add an API key: there is nothing here to answer a message with.';
  // What the flow requires is settled in the main process (see ready in
  // ../setup/checks.ts); the reasons above are this window saying which part
  // of it is missing. Should the two ever disagree, the one that keeps asking
  // wins: a flow that let the user out while the app still wanted something
  // would only open itself again next time (see wanted).
  if (!s.ready) return 'Something the app needs is still missing.';
  return null;
}

export let status: SetupStatus | null = null;
export let step: StepId = STEPS[0];
// The installer's own output, while one is running, newest last
export const logLines: string[] = [];
export const MAX_LOG_LINES = 200;
// Whether an install is running, which is the one thing here the window itself
// knows and the status does not
export let installing = false;
// While the dialog is open and waiting on something outside it
let poller: ReturnType<typeof setInterval> | undefined;
export const POLL_MS = 3000;
// Model name -> the element showing how its download is going
const progressLabels = new Map<string, HTMLElement>();

// Whether a step has what it wants. Not whether it can be left: the keys step
// is satisfied by a local model as much as by a key, which is the whole point
// of the pair (see NEEDED).
export function satisfied(id: StepId, s: SetupStatus): boolean {
  if (id === 'local') return s.local.reachable && s.local.embedding && s.local.models > 0;
  if (id === 'keys') return s.keys.anthropic || s.keys.openai;
  return s.canRunCode;
}

const isEmbedding = (name: string, s: SetupStatus) =>
  name === s.local.embeddingModel || name.startsWith(`${s.local.embeddingModel}:`);

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (primary) el.className = 'primary';
  el.addEventListener('click', onClick);
  return el;
}

// One requirement: what it is, how it stands, and what can be done about it
function row({
  name,
  about,
  state,
  ok = false,
  buttons = [],
  extra,
}: {
  name: string;
  about: string;
  state: string;
  ok?: boolean;
  buttons?: HTMLElement[];
  // An element in place of the state, for a row that holds a control
  extra?: HTMLElement;
}): HTMLDivElement {
  const el = document.createElement('div');
  el.className = ok ? 'setup-item ok' : 'setup-item';

  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = name;

  const detail = document.createElement('small');
  detail.className = 'about';
  detail.textContent = about;

  const shown = document.createElement('small');
  shown.className = 'state';
  shown.textContent = state;

  el.append(title, detail, ...(extra ? [extra] : []), shown, ...buttons);
  return el;
}

// A model that can be downloaded, with what it will be worth and what it wants
function modelRow(m: SuggestedModel, s: SetupStatus, recommended: boolean): HTMLDivElement {
  const going = downloads.get(m.name);
  const progress = document.createElement('small');
  progress.className = 'state';
  progress.textContent = going ?? '';
  progressLabels.set(m.name, progress);
  const action = going
    ? button('Cancel', () => window.ollamaApi.cancel(m.name))
    : button(
        'Download',
        () => {
          startDownload(m.name);
          render();
        },
        recommended
      );
  const el = row({
    name: m.name,
    about:
      `Level ${m.sophistication}/5 · wants ${m.memoryGB}GB of memory, and this computer has ` +
      `${s.local.memoryGB}GB${recommended ? ' · the best of these it can hold' : ''}`,
    state: '',
    buttons: [action],
  });
  // The state slot holds the download's progress rather than a word
  (el.querySelector('.state') as HTMLElement).replaceWith(progress);
  return el;
}

function localBody(s: SetupStatus): HTMLElement[] {
  const rows = [
    row({
      name: 'Ollama',
      about: s.local.reachable
        ? `Answering at ${s.local.url}.`
        : `Nothing is answering at ${s.local.url}. Install it and it starts itself; this notices when it does.`,
      state: s.local.reachable ? 'Running' : 'Not found',
      ok: s.local.reachable,
      buttons: s.local.reachable ? [] : [button('Download Ollama', () => download('ollama'), true)],
    }),
  ];
  // Everything below is downloading models, which wants an Ollama to download
  // them from. Another OpenAI-compatible server at that URL serves models it
  // was started with and has nothing to add here either.
  if (!s.local.reachable) return rows;

  // Named from what Ollama has downloaded, but counted from what the app can
  // actually reach: a model served by something that is not Ollama is one the
  // app can answer with and one Ollama has never heard of (see localStatus).
  const own = s.local.installed.filter((m) => !isEmbedding(m.name, s));
  const named = own.map((m) => m.name).join(', ');
  const small = ' — all of them small. Routing trusts models of 5B and up, so it will keep reaching for a hosted one.';
  rows.push(
    row({
      name: 'A model to answer with',
      about:
        s.local.models === 0
          ? 'Nothing downloaded yet.'
          : (named || `${s.local.models} served at that URL.`) + (s.local.routable ? '' : small),
      state: s.local.models === 0 ? 'Missing' : s.local.routable ? 'Ready' : 'Small',
      ok: s.local.routable,
    }),
    row({
      name: s.local.embeddingModel,
      about:
        'Required: searching a workspace by meaning is built on this one model, and nothing else here ' +
        'serves one. A few hundred megabytes.',
      state: s.local.embedding ? 'Downloaded' : 'Missing',
      ok: s.local.embedding,
      buttons: s.local.embedding
        ? []
        : [
            downloads.has(s.local.embeddingModel)
              ? button('Cancel', () => window.ollamaApi.cancel(s.local.embeddingModel))
              : button('Download', () => {
                  startDownload(s.local.embeddingModel);
                  render();
                }),
          ],
    })
  );
  for (const [index, m] of s.local.recommended.slice(0, 3).entries()) {
    rows.push(modelRow(m, s, index === 0 && !s.local.routable));
  }
  return rows;
}

// A key, saved from here rather than from Settings so that the flow is the
// whole of the way in
function keyRow(provider: 'anthropic' | 'openai', name: string, saved: boolean): HTMLDivElement {
  if (saved) {
    return row({
      name,
      about: 'A key is saved. It is kept encrypted by this computer, never in a file you could paste.',
      state: 'Saved',
      ok: true,
      buttons: [button('Remove', () => saveKey(provider, null))],
    });
  }
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.placeholder = `${name} API key`;
  input.setAttribute('aria-label', `${name} API key`);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveKey(provider, input.value.trim());
  });
  return row({
    name,
    about: '',
    state: 'Not set',
    extra: input,
    buttons: [button('Save', () => saveKey(provider, input.value.trim()))],
  });
}

async function saveKey(provider: 'anthropic' | 'openai', key: string | null): Promise<void> {
  if (key === '') return;
  setupStatus.textContent = key === null ? 'Removing…' : 'Saving…';
  try {
    await window.settingsApi.save({ [provider]: { apiKey: key } });
  } catch (err) {
    setupStatus.textContent = (err as Error).message;
    return;
  }
  setupStatus.textContent = '';
  // A key is a provider the app can now ask for models
  await loadModels();
  await refresh();
}

function dockerBody(s: SetupStatus): HTMLElement[] {
  const { installed, running, automatic } = s.docker;
  const about = !installed
    ? automatic
      ? 'Not installed. The app can install it for you; on macOS that is Colima and the docker command ' +
        'through Homebrew, which needs no GUI and no administrator rights.'
      : 'Not installed, and this computer has nothing to install it with. Download Docker Desktop, then come back.'
    : running
      ? 'Installed and running. Threads can use their containers.'
      : 'Installed but not running. Starting it can take a minute the first time.';

  const buttons: HTMLElement[] = [];
  if (installing) {
    buttons.push(button('Stop', () => window.setupApi.cancel()));
  } else if (!installed && !automatic) {
    buttons.push(button('Download Docker Desktop', () => download('docker'), true));
  } else if (!installed || !running) {
    buttons.push(button(installed ? 'Start Docker' : 'Install Docker', () => install(), true));
  }

  return [
    row({
      name: 'Docker',
      about,
      state: installing ? 'Working…' : !installed ? 'Not found' : running ? 'Running' : 'Stopped',
      ok: installed && running,
      buttons,
    }),
  ];
}

export function renderSteps(s: SetupStatus): void {
  setupSteps.replaceChildren(
    ...STEPS.map((id) => {
      const li = document.createElement('li');
      li.textContent = SHORT[id];
      if (satisfied(id, s)) li.className = 'done';
      if (id === step) li.setAttribute('aria-current', 'step');
      return li;
    })
  );
}

export function render(): void {
  const s = status;
  if (!s) return;
  progressLabels.clear();
  setupTitle.textContent = satisfied(step, s) ? SHORT[step] : `Set up: ${SHORT[step].toLowerCase()}`;
  setupBlurb.textContent = BLURBS[step];
  renderSteps(s);
  const body = step === 'local' ? localBody(s) : step === 'keys' ? keysBody(s) : dockerBody(s);
  setupBody.replaceChildren(...body);

  setupLog.hidden = logLines.length === 0;
  setupLog.textContent = logLines.join('\n');
  if (!setupLog.hidden) setupLog.scrollTop = setupLog.scrollHeight;

  const at = STEPS.indexOf(step);
  const last = at === STEPS.length - 1;
  const left = blocking(s);
  setupBack.hidden = at === 0;
  // Nothing to skip on a step that is already satisfied, and nothing to skip
  // on the one step that is required however little the user wants it
  setupSkip.hidden = step === 'local' || satisfied(step, s) || installing;
  setupNext.textContent = last ? 'Finish' : 'Next';
  // An install that is running is left to finish: its output is the step
  setupNext.disabled = installing || (last && left !== null);
  if (last && left) setupStatus.textContent = left;
  else if (!installing) setupStatus.textContent = '';
}

function keysBody(s: SetupStatus): HTMLElement[] {
  return [keyRow('anthropic', 'Anthropic', s.keys.anthropic), keyRow('openai', 'OpenAI', s.keys.openai)];
}

// Asks the main process how things stand and draws that. Everything in the
// flow ends here: it is the one place that decides what is true.
export async function refresh(): Promise<void> {
  status = await window.setupApi.status();
  render();
}

function download(what: Installable): void {
  window.setupApi.download(what);
  setupStatus.textContent =
    what === 'ollama'
      ? 'Install Ollama, then come back to this window — it checks every few seconds.'
      : 'Install Docker Desktop and start it, then come back to this window.';
}

function install(): void {
  installing = true;
  logLines.length = 0;
  window.setupApi.installDocker();
  render();
}

// Which requirements the user has said they will go without, so the flow does
// not open itself for them again (see wanted in ../setup/checks.ts)
async function remember(skipped: string): Promise<void> {
  const already = status?.setup.skipped ?? [];
  if (already.includes(skipped)) return;
  await window.settingsApi.save({ setup: { skipped: [...already, skipped] } });
}

async function finish(): Promise<void> {
  const now = status;
  const left = now ? blocking(now) : 'Nothing is known about what is set up yet.';
  if (!now || left) {
    setupStatus.textContent = left;
    return;
  }
  await window.settingsApi.save({ setup: { completed: true, version: now.version } });
  setupDialog.close();
}

function go(to: StepId): void {
  step = to;
  render();
  startPolling();
}

// While the dialog waits on something that happens outside it — an Ollama
// being installed, a Docker being started — it asks again rather than leaving
// the user to find the button that tells it to. Not on the keys step, where
// there is nothing to wait for and redrawing would take away what is being
// typed.
function startPolling(): void {
  stopPolling();
  if (!setupDialog.open || step === 'keys') return;
  poller = setInterval(() => {
    if (!installing) void refresh();
  }, POLL_MS);
}

function stopPolling(): void {
  if (poller) clearInterval(poller);
  poller = undefined;
}

// Opens the flow at the step asked for, or at the first one that wants
// something, or at the beginning when everything is already in place (which
// is how Settings reopens it).
export async function openSetup(at?: StepId): Promise<void> {
  status = await window.setupApi.status();
  step = at ?? STEPS.find((id) => !satisfied(id, status as SetupStatus)) ?? STEPS[0];
  logLines.length = 0;
  render();
  if (!setupDialog.open) setupDialog.showModal();
  startPolling();
}

// On the way in: shown only when something is missing that the user has not
// already said they would go without (see wanted in ../setup/checks.ts).
export async function openSetupIfWanted(): Promise<void> {
  const current = await window.setupApi.status();
  if (!current.wanted) {
    status = current;
    return;
  }
  await openSetup();
}

setupDialog.addEventListener('close', stopPolling);

// A window that is going does not need to keep asking
window.addEventListener('beforeunload', stopPolling);

// The way back in, from Settings (see index.html). Registered here rather than
// in settings.ts so that nothing but this module knows how the flow starts.
element('open-setup').addEventListener('click', () => {
  settingsDialogToClose();
  void openSetup();
});

setupLater.addEventListener('click', () => setupDialog.close());

setupBack.addEventListener('click', () => {
  const at = STEPS.indexOf(step);
  if (at > 0) go(STEPS[at - 1]);
});

setupNext.addEventListener('click', async () => {
  const at = STEPS.indexOf(step);
  if (at === STEPS.length - 1) await finish();
  else go(STEPS[at + 1]);
});

setupSkip.addEventListener('click', async () => {
  await remember(step);
  const at = STEPS.indexOf(step);
  if (at === STEPS.length - 1) await finish();
  else go(STEPS[at + 1]);
});

// The Docker installer, saying how it is going
window.setupApi.onProgress(({ line, done, error }) => {
  if (line !== undefined) {
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    if (setupDialog.open) {
      setupLog.hidden = false;
      setupLog.textContent = logLines.join('\n');
      setupLog.scrollTop = setupLog.scrollHeight;
    }
    return;
  }
  if (!done) return;
  installing = false;
  // What the installer exited with says little — it reports its own troubles
  // and exits cleanly regardless — so what came of it is the status's to say
  if (error) setupStatus.textContent = error;
  if (setupDialog.open) void refresh();
});

// A model being downloaded, which is Ollama's own progress (see settings.ts,
// which keeps the downloads and is where the same models are listed)
window.ollamaApi.onProgress(({ name, status: text, percent, done }) => {
  if (!setupDialog.open) return;
  if (!done) {
    const label = progressLabels.get(name);
    if (label) label.textContent = percent == null ? (text ?? '') : `${percent}%`;
    return;
  }
  void refresh();
});
