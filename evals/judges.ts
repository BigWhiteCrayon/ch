// Which models the suites are judged with, and the keys needed to reach them.
//
// A prompt is not right or wrong on its own: it is right or wrong for a model.
// The same wording that a small local model follows to the letter can be read
// loosely by a large hosted one, and a rule that rescues the small model can
// be noise to the large one. So a suite is run against one model per level
// rather than against "the model", and the report says which was which.
//
// The keys come from a .env file beside package.json, which git ignores (see
// .env.example). Nothing else in the app reads it: the app itself takes its
// keys from Settings, and a key missing here only means fewer models to judge.

import fs from 'fs';
import path from 'path';
import * as llm from '../src/llm';
import type { ModelInfo } from '../src/types';

// Judged with one model per level, by default. Level 1 is left out because
// most suites are about work a small model is not given; a suite that is
// about such work (the classifier picks the cheapest model there is) is worth
// running with 1 in the list.
export const DEFAULT_LEVELS = [2, 3, 4];

// A line of a .env file: NAME=value, with optional `export`, optional quotes,
// and # starting a comment where it isn't inside them
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function value(raw: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
  if (quoted) return quoted[2];
  // Unquoted: a # begins a comment
  return raw.split('#')[0].trim();
}

// Where .env is looked for when nowhere is named: the directory the command
// was run from, and failing that the package's own, so that the compiled
// runner finds the keys wherever it is started from
const PLACES = [process.cwd(), path.resolve(__dirname, '..', '..')];

function read(dir: string | undefined, file: string): string | null {
  for (const place of dir ? [dir] : PLACES) {
    try {
      return fs.readFileSync(path.join(place, file), 'utf8');
    } catch {
      // Not there; try the next, and report none at the end
    }
  }
  return null;
}

// Reads .env into the environment and returns the names it set. A name that
// is already in the environment is left as it is, so a key given on the
// command line or by the shell beats the file. Never throws: no .env is the
// ordinary case for someone judging local models only.
export function loadEnv(dir?: string, file = '.env'): string[] {
  const text = read(dir, file);
  if (text === null) return [];
  const set: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const found = LINE.exec(line);
    if (!found) continue;
    const [, name, raw] = found;
    const given = value(raw);
    if (!given || process.env[name]) continue;
    process.env[name] = given;
    set.push(name);
  }
  return set;
}

// The levels to judge, from the flag, else the environment, else the default.
// Anything that is not a level from 1 to 5 is left out rather than guessed at.
export function levelsFrom(flag?: string): number[] {
  const given = flag ?? process.env.CH_EVAL_LEVELS;
  if (!given) return DEFAULT_LEVELS;
  const levels = [...new Set(given.split(',').map((part) => Number(part.trim())))]
    .filter((level) => Number.isInteger(level) && level >= 1 && level <= 5)
    .sort((a, b) => a - b);
  return levels.length > 0 ? levels : DEFAULT_LEVELS;
}

// The settings the suites run under: whatever keys the environment has, and
// the usual local server. Suites call this too, so that one of them run on
// its own is configured the same way as all of them together.
export function configure(): void {
  llm.configure({
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? '', disabledModels: [] },
    openai: { apiKey: process.env.OPENAI_API_KEY ?? '', disabledModels: [] },
    local: { baseURL: process.env.CH_LOCAL_URL ?? 'http://127.0.0.1:11434/v1', apiKey: '' },
    sophistication: {},
    // No suite asks for the faster output, which is a thing a user turns on
    fast: false,
    // No suite builds a container: the one about subagents reads the tasks a
    // model hands out rather than running them. So the image is left for the
    // workspace to decide, as it is by default.
    sandbox: { image: '' },
    // Hosted models are the point of having keys here: a suite judged at
    // levels 3 and 4 has nothing to judge without them
    offline: false,
    // No suite is a reply that changed files, so there is nothing for a review
    // to run on
    autoReview: false,
    // Nothing here asks before using a model, and the theme is only for the window
    approvalCeiling: 5,
    theme: {},
    // Nothing here reads the files of the machine it runs on
    readable: { global: [], workspaces: {} },
    // Nor does anything here install anything: the suites are given their
    // models and their keys rather than led through finding them
    setup: { completed: true, version: 0, skipped: [] },
  });
}

// One model stands for its level at its provider. The shortest name wins,
// which is how a provider's plain name ("claude-sonnet-5-5") beats the dated
// snapshots of the same model; the names are compared as text to settle a tie
// so that the same model is chosen every run.
function pick(models: ModelInfo[]): ModelInfo {
  return [...models].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))[0];
}

export interface Judges {
  // The models to judge with, cheapest level first
  chosen: ModelInfo[];
  // Providers that could not be reached, and why
  trouble: string[];
  // Levels that were asked for and had no model at all
  missing: number[];
}

// The models to judge with: one per provider per level asked for. A provider
// with no key offers nothing, which is how judging falls back to whatever
// Ollama is serving.
export async function judges(levels: number[]): Promise<Judges> {
  configure();
  const { models, providers } = await llm.listModels({ fresh: true });
  const chosen: ModelInfo[] = [];
  for (const level of levels) {
    const at = models.filter((model) => model.sophistication === level);
    for (const provider of [...new Set(at.map((model) => model.provider))].sort()) {
      chosen.push(pick(at.filter((model) => model.provider === provider)));
    }
  }
  return {
    chosen,
    trouble: providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`),
    missing: levels.filter((level) => !chosen.some((model) => model.sophistication === level)),
  };
}
