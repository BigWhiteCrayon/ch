import type { ModelInfo } from './types.js';
import {
  allModels,
  fastSwitch,
  fastToggle,
  models,
  modelSelect,
  offlineSwitch,
  offlineToggle,
  providers,
  setAllModels,
  setModels,
  setProviders,
  setRetainedHostedModels,
} from './shared.js';
import { save, state } from './threads.js';
import { renderSettings, setSettings, settings, settingsDialog } from './settings.js';
import { showNotice } from './notice.js';
import { openSetup } from './setup.js';

export const modelKey = (m: ModelInfo) => `${m.provider}/${m.id}`;

// The picker's "Auto" entry: let the harness choose a model for each message
export const AUTO = 'auto';

// The model the user picked, or undefined when the choice is Auto
export function selectedModel(): ModelInfo | undefined {
  return models.find((m) => modelKey(m) === state.modelChoice);
}

export async function loadModels(): Promise<void> {
  const listed = await window.llm.listModels({ includeDisabled: true });
  setAllModels(listed.models);
  setProviders(listed.providers);
  setModels(allModels.filter((m) => !m.disabled));
  // The store keeps the last hosted (non-local) list seen, so Offline Mode can
  // show them greyed out: the live list omits them when offline, and a listing
  // with none is left as it was. (See the offline switch tests.)
  const hosted = listed.models.filter((m) => !m.local);
  if (hosted.length > 0) setRetainedHostedModels(hosted);
  // Keep a saved pick only while that model still exists
  if (!selectedModel()) {
    state.modelChoice = AUTO;
    save();
  }
  renderModels();
  // Whether Offline Mode has anything to keep to follows from what was listed
  drawOffline();
}

export function renderModels(): void {
  if (models.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No models available';
    modelSelect.replaceChildren(option);
    modelSelect.disabled = true;
    return;
  }
  modelSelect.disabled = false;
  const auto = document.createElement('option');
  auto.value = AUTO;
  auto.textContent = 'Auto · chosen per message';
  modelSelect.replaceChildren(
    auto,
    ...models.map((m) => {
      const option = document.createElement('option');
      option.value = modelKey(m);
      option.textContent = `${m.name} · ${m.providerName} · ${m.sophistication}/5`;
      return option;
    })
  );
  modelSelect.value = state.modelChoice ?? AUTO;
}

// Whether there is a hosted model for Fast Mode to prefer. Read from the keys
// rather than from the model list, because Offline Mode takes the hosted
// models out of that list entirely (see away in llm/index.ts): Fast would
// then read as unavailable whenever Offline was on, which is not the same
// thing as having no hosted model at all.
export const hostedAvailable = () => Boolean(settings?.anthropic.hasKey || settings?.openai.hasKey);

// ...and whether there is a local one for Offline Mode to keep to. The list
// this time, because a local model may be served by something that is not
// Ollama — LM Studio, llama.cpp — which has no keys to go by.
export const localAvailable = () => allModels.some((m) => m.local);

// What a switch with nothing to switch between says when it is clicked. A
// greyed-out switch that only sat there would say the user may not do
// something and never why; the title says it too, for a mouse that waits.
const OFFLINE_UNAVAILABLE =
  'Offline Mode uses only the models on this computer, and there are none. Set Ollama up and download a ' +
  'model, and it will have something to keep to.';
const FAST_UNAVAILABLE =
  'Fast Mode prefers hosted models, because they answer faster than local ones. There are none to prefer: ' +
  'that wants an API key for Anthropic or OpenAI.';

// The switch shows what the settings say, not what was last clicked: a save
// that fails leaves it where it was, with the reason on it.
export function drawOffline(): void {
  const on = settings?.offline ?? false;
  // A switch that is on can always be turned off, whatever is available. It is
  // the way out of an Offline Mode whose last local model has gone, and
  // greying it out there would leave the app with no models and no way back.
  const can = on || localAvailable();
  offlineToggle.checked = on;
  offlineToggle.disabled = !can;
  offlineSwitch.classList.toggle('on', on);
  offlineSwitch.classList.toggle('unavailable', !can);
  offlineSwitch.title = !can
    ? OFFLINE_UNAVAILABLE
    : on
      ? 'Offline Mode is on: non-local (hosted) models are disabled, so only models on this computer are used. ' +
        'Click to use hosted models again.'
      : 'Offline Mode disables non-local (hosted) models, so only models on this computer are used. ' +
        'Click to go offline.';
  // Fast Mode's title says whether Offline leaves it with anything to do
  drawFast();
}

// Fast Mode only prefers: offline there are no hosted models for it to prefer,
// and the title says so rather than the switch being taken away.
export function drawFast(): void {
  const on = settings?.fast ?? false;
  const can = on || hostedAvailable();
  fastToggle.checked = on;
  fastToggle.disabled = !can;
  fastSwitch.classList.toggle('on', on);
  fastSwitch.classList.toggle('unavailable', !can);
  fastSwitch.title = !can
    ? FAST_UNAVAILABLE
    : on
      ? 'Fast Mode is on: hosted models are preferred, because they answer faster. Click to prefer local models again.'
      : 'Fast Mode prefers hosted models, because they answer faster than local ones. Click to turn it on.';
  if (can && settings?.offline) fastSwitch.title += ' It has no effect while Offline Mode is on.';
}

// Settings are otherwise read when the Settings dialog is opened; the switch in
// the bar needs to know before then
export async function loadOffline(): Promise<void> {
  const loaded = await window.settingsApi.get();
  setSettings(loaded);
  applyTheme(loaded.theme);
  drawOffline();
}

export let appliedTheme: string[] = [];

// Overrides the colours in styles.css :root; what an earlier theme set and this one does not is cleared
export function applyTheme(theme: Record<string, string>): void {
  const style = document.documentElement.style;
  for (const name of appliedTheme) style.removeProperty(name);
  for (const [name, value] of Object.entries(theme)) style.setProperty(name, value);
  appliedTheme = Object.keys(theme);
}

// A disabled checkbox is not clicked, but its label still is: that is where
// the explanation comes from (see OFFLINE_UNAVAILABLE)
fastSwitch.addEventListener('click', () => {
  if (!fastToggle.disabled) return;
  showNotice({
    title: 'Fast Mode needs a hosted model',
    text: FAST_UNAVAILABLE,
    action: { label: 'Add a key', run: () => void openSetup('keys') },
  });
});

offlineSwitch.addEventListener('click', () => {
  if (!offlineToggle.disabled) return;
  showNotice({
    title: 'Offline Mode needs a model on this computer',
    text: OFFLINE_UNAVAILABLE,
    action: { label: 'Set up Ollama', run: () => void openSetup('local') },
  });
});

fastToggle.addEventListener('change', async () => {
  try {
    setSettings(await window.settingsApi.save({ fast: fastToggle.checked }));
  } catch (err) {
    drawFast();
    fastSwitch.title = (err as Error).message;
    return;
  }
  drawFast();
});

offlineToggle.addEventListener('change', async () => {
  try {
    setSettings(await window.settingsApi.save({ offline: offlineToggle.checked }));
  } catch (err) {
    drawOffline();
    offlineSwitch.title = (err as Error).message;
    return;
  }
  drawOffline();
  // What is on offer has changed, and a model the user picked may be gone
  await loadModels();
  if (settingsDialog.open) renderSettings();
});

export function noModelsMessage(): string {
  const reasons = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
  return ['No models available.', ...reasons].join('\n');
}
