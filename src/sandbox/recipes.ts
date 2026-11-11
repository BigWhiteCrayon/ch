// How a workspace's app is run in a thread's container, the way its user would see it: what is built first, what has
// to be running beside it, the data it starts from, how it is launched, and what on its screen says it is up. One per
// workspace, kept in the app's data folder beside the notes on it (see ../harness/project.ts), and read by every
// thread started there.
//
// It is here because the way an app is run was being worked out afresh by every reply that wanted to use it, out of
// the rounds that were meant for the change, and what one reply worked out reached the next only as a workspace note,
// in prose. A note can say anything and is never tried again: the note this workspace had on running its app said not
// to run it at all, and to stub it out in a page of its own, which stayed true for every thread that read it long
// after the container could run the app. So a recipe is kept only once it has worked (see save_run_recipe in
// ../tools/sandbox.ts, which runs it before it saves it), is run whole by use_app rather than read and redone by
// hand, and says when it last failed and where, for the next reply to put right.
//
// What goes in it is a launch rather than a project: no knowledge of how the code is laid out, which is the notes'.
//
// Nothing here throws but parse, whose errors are written for the model that gave the recipe, and nothing is kept
// until init() is called, so the tools can be used (and tested) without it.

import fs from 'fs';
import path from 'path';
import * as log from '../log';

export const SAVE_TOOL = 'save_run_recipe';

// Something that has to be running before the app is: a web app's own server, or a stand-in for a service the app
// talks to. Started once in a container and reused for as long as `ready`, an address, answers.
export interface Service {
  command: string;
  ready: string;
}

export interface Recipe {
  // Run in order from the project's folder before each launch: a build, say
  setup?: string[];
  services?: Service[];
  // Set for the setup, the services and the app
  env?: Record<string, string>;
  // A folder of the project copied afresh for each launch, and given to the app as `flag`=<the copy>: an app's saved
  // state to start from, which the app can then change without changing it for the next launch
  data?: { from: string; flag: string };
  // A desktop app is launched by a command, from cwd; a web app is the address of a page its services serve
  app: { command: string; cwd?: string } | { url: string };
  // Seconds the app is given to come up before it is looked at
  wait?: number;
  // A CSS selector that is on the screen once the app is up: until it is, the app has started but is not yet what a
  // user would be looking at
  ready?: string;
  // Steps that take the app from where it opens to where a user would start from, such as a dialog that has to be
  // put away first. Checked as steps are, by the tool (see checkSteps in ../tools/sandbox.ts).
  after?: Record<string, unknown>[];
  // What anybody using the app this way needs to know that the rest does not say: how to put it into the state a
  // check needs, what is standing in for what. Said with the recipe (see prompt).
  notes?: string;
}

export interface Saved extends Recipe {
  // When it last ran all the way through: when it was saved, and each time it has been used since
  checkedAt: string;
  // The thread that saved it
  thread?: string;
  // The last time it was used and did not run through, where that is the latest that has happened to it
  failed?: { at: string; stage: string; why: string };
}

const FILE_NAME = 'recipes.json';
const MAX_SETUP = 8;
const MAX_SERVICES = 4;
const MAX_ENV = 20;
const MAX_AFTER = 20;
const MAX_WAIT = 120;
const MAX_NOTES = 1200;
// Characters of a failure kept, which is the end of what failed
const MAX_WHY = 600;

let file: string | null = null;
// workspace -> its recipe
let saved: Record<string, Saved> = {};

// Starts keeping the recipes in the given folder
export function init(dir: string): void {
  file = path.join(dir, FILE_NAME);
  saved = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object') saved = read;
  } catch {
    // Nothing saved yet, or nothing readable: recipes are saved again as they are worked out
  }
}

function save(): void {
  if (!file) return;
  try {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    log.error('recipe.save', { ok: false, error: (err as Error).message });
  }
}

export const get = (workspace: string | undefined): Saved | undefined => (workspace ? saved[workspace] : undefined);

// Keeps a recipe that has just run all the way through, in place of whatever the workspace had
export function put(workspace: string, recipe: Recipe, thread?: string): void {
  if (!file) return;
  saved[workspace] = { ...recipe, checkedAt: new Date().toISOString(), ...(thread ? { thread } : {}) };
  save();
  log.info('recipe.saved', { workspace, thread });
}

// Says the recipe ran all the way through once more, which clears a failure it had
export function worked(workspace: string): void {
  const recipe = saved[workspace];
  if (!recipe) return;
  recipe.checkedAt = new Date().toISOString();
  delete recipe.failed;
  save();
}

// Says where the recipe stopped, for the next reply to be told. The recipe is kept: one step of it going wrong, after
// a change to the project or to the container, leaves the rest of it as good as it was.
export function failed(workspace: string, stage: string, why: string): void {
  const recipe = saved[workspace];
  if (!recipe) return;
  const trimmed = why.trim();
  recipe.failed = {
    at: new Date().toISOString(),
    stage,
    why: trimmed.length > MAX_WHY ? `…${trimmed.slice(-MAX_WHY)}` : trimmed,
  };
  save();
  log.warn('recipe.failed', { workspace, stage });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be a non-empty string.`);
  return value.trim();
}

function list(value: unknown, what: string, most: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${what} must be a list.`);
  if (value.length > most) throw new Error(`${what} may have at most ${most} entries.`);
  return value;
}

// A path inside the project, as the data to copy is: relative, and not climbing out of it
function inProject(value: unknown, what: string): string {
  const given = text(value, what);
  const normal = path.posix.normalize(given);
  if (path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) {
    throw new Error(`${what} must be a folder inside the project, given relative to it.`);
  }
  return normal;
}

// The recipe a model gave, as the tool that saves it was called with it, or an error saying what is wrong with it
export function parse(input: unknown): Recipe {
  if (!isObject(input)) throw new Error('The recipe must be an object.');
  const app = input.app;
  if (!isObject(app))
    throw new Error('"app" must be given: {command, cwd?} for a desktop app, or {url} for a web app.');
  const hasCommand = app.command !== undefined && app.command !== '';
  const hasUrl = app.url !== undefined && app.url !== '';
  if (hasCommand === hasUrl) throw new Error('"app" takes command or url, one of them.');
  const recipe: Recipe = {
    app: hasCommand
      ? {
          command: text(app.command, '"app.command"'),
          ...(app.cwd !== undefined && app.cwd !== '' ? { cwd: text(app.cwd, '"app.cwd"') } : {}),
        }
      : { url: text(app.url, '"app.url"') },
  };
  const setup = list(input.setup, '"setup"', MAX_SETUP).map((command, n) => text(command, `"setup" entry ${n + 1}`));
  if (setup.length) recipe.setup = setup;
  const services = list(input.services, '"services"', MAX_SERVICES).map((service, n) => {
    if (!isObject(service)) throw new Error(`"services" entry ${n + 1} must be {command, ready}.`);
    const ready = text(service.ready, `"services" entry ${n + 1}'s ready`);
    if (!/^https?:\/\//i.test(ready)) {
      throw new Error(`"services" entry ${n + 1}'s ready must be an http address that answers once it is up.`);
    }
    return { command: text(service.command, `"services" entry ${n + 1}'s command`), ready };
  });
  if (services.length) recipe.services = services;
  if (input.env !== undefined && input.env !== null) {
    if (!isObject(input.env)) throw new Error('"env" must be an object of names and values.');
    const entries = Object.entries(input.env);
    if (entries.length > MAX_ENV) throw new Error(`"env" may have at most ${MAX_ENV} entries.`);
    for (const [name, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a name a variable can have.`);
      if (typeof value !== 'string') throw new Error(`The value of "${name}" in "env" must be a string.`);
    }
    if (entries.length) recipe.env = Object.fromEntries(entries) as Record<string, string>;
  }
  if (input.data !== undefined && input.data !== null) {
    if (!isObject(input.data)) throw new Error('"data" must be {from, flag}.');
    const flag = text(input.data.flag, '"data.flag"');
    if (!/^--?[A-Za-z0-9][\w-]*$/.test(flag)) {
      throw new Error('"data.flag" must be the flag the folder is given to the app with, such as --user-data-dir.');
    }
    if (!('command' in recipe.app)) throw new Error('"data" is given to an app launched by command, not to a page.');
    recipe.data = { from: inProject(input.data.from, '"data.from"'), flag };
  }
  if (input.wait !== undefined && input.wait !== null) {
    if (typeof input.wait !== 'number' || !Number.isFinite(input.wait)) throw new Error('"wait" must be a number.');
    recipe.wait = Math.min(MAX_WAIT, Math.max(0, Math.round(input.wait)));
  }
  if (input.ready !== undefined && input.ready !== null && input.ready !== '') {
    recipe.ready = text(input.ready, '"ready"');
  }
  const after = list(input.after, '"after"', MAX_AFTER) as Record<string, unknown>[];
  if (after.length) recipe.after = after;
  if (input.notes !== undefined && input.notes !== null && input.notes !== '') {
    const notes = text(input.notes, '"notes"');
    if (notes.length > MAX_NOTES) throw new Error(`"notes" may be at most ${MAX_NOTES} characters.`);
    recipe.notes = notes;
  }
  return recipe;
}

// A first guess at a workspace's recipe from its package.json, for a workspace that has none yet: Electron's own
// launcher where the project depends on Electron, and the dev server where it is a web app with a port that is the
// same in every project of its kind. Never kept, since nobody has tried it: it is only put to the model as where to
// start (see prompt). null where the files do not say.
export function draft(workspace: string | undefined): Recipe | null {
  if (!workspace) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(pkg)) return null;
  const deps = {
    ...(isObject(pkg.dependencies) ? pkg.dependencies : {}),
    ...(isObject(pkg.devDependencies) ? pkg.devDependencies : {}),
  };
  const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
  if ('electron' in deps) {
    return {
      ...(scripts.build ? { setup: ['npm run build'] } : {}),
      app: { command: 'npx electron . --no-sandbox --disable-gpu' },
    };
  }
  const port = 'vite' in deps ? 5173 : 'next' in deps || 'react-scripts' in deps ? 3000 : null;
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!port || !script) return null;
  const url = `http://localhost:${port}`;
  return { services: [{ command: `npm run ${script}`, ready: url }], app: { url } };
}

// The recipe in a line: what is run, in order, and what says it is up
export function summary(recipe: Recipe): string {
  const parts = [
    ...(recipe.setup ?? []).map((command) => `\`${command}\``),
    ...(recipe.services ?? []).map((service) => `\`${service.command}\` in the background`),
    'command' in recipe.app ? `then \`${recipe.app.command}\`` : `then ${recipe.app.url} in a browser`,
  ];
  const ready = recipe.ready ? `, up once ${recipe.ready} is showing` : '';
  const after = recipe.after?.length ? `, then ${recipe.after.length} step${recipe.after.length === 1 ? '' : 's'}` : '';
  return `${parts.join(', ')}${ready}${after}`;
}

// What a model that can use the app is told about running this workspace's: the recipe it has, and where it last went
// wrong; or, where there is none, that it is to save one once it has the app running, with the guess to start from
export function prompt(workspace: string | undefined): string {
  if (!workspace) return '';
  const recipe = saved[workspace];
  if (!recipe) {
    const guess = draft(workspace);
    return (
      `Nobody has got this workspace's app running in a container yet, so it has no run recipe. Once you have — ` +
      `started with use_app and showing what a user would see — save how you did it with ${SAVE_TOOL}, which ` +
      'runs it once more and keeps it only if it works, so that nobody working here has to work it out again.' +
      (guess ? ` A guess from the project's files, not yet tried: ${JSON.stringify(guess)}` : '')
    );
  }
  const said =
    `This workspace has a run recipe, last run all the way through on ${recipe.checkedAt.slice(0, 10)}: ` +
    `${summary(recipe)}. use_app with action "start" and recipe: true does all of it in one call and gives you the ` +
    'app as a user first sees it, so start the app that way rather than putting it together yourself.' +
    (recipe.notes ? `\nWhat whoever saved it says about using the app this way: ${recipe.notes}` : '');
  if (!recipe.failed)
    return `${said} If the project has changed how it is run, put the recipe right with ${SAVE_TOOL}.`;
  return (
    `${said} The last time it was used it failed at ${recipe.failed.stage}:\n${recipe.failed.why}\n` +
    `Find out why, and once the app runs again save the recipe that ran it with ${SAVE_TOOL}.`
  );
}
