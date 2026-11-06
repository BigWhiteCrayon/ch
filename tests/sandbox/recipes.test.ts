import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as recipes from '../../src/sandbox/recipes';
import { unwrapped } from '../helpers';

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recipes-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recipes-workspace-'));
  recipes.init(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const ELECTRON = { setup: ['npm run build'], app: { command: 'npx electron . --no-sandbox' }, ready: '#composer' };

describe('a recipe as a model gives it', () => {
  it('is taken whole where every part of it is as it should be', () => {
    const given = {
      setup: ['npm run build'],
      services: [{ command: 'node fake-llm.js', ready: 'http://localhost:11500/v1/models' }],
      env: { LOCAL_LLM_BASE_URL: 'http://localhost:11500/v1' },
      data: { from: 'test/fixtures/user-data', flag: '--user-data-dir' },
      app: { command: 'npx electron .', cwd: 'app' },
      wait: 8,
      ready: '#composer',
      after: [{ action: 'click', selector: '.finish-later' }],
      notes: 'Copy a scenario to /tmp/ch-scenario.json to change what the model says.',
    };
    expect(recipes.parse(given)).toEqual(given);
  });

  it('leaves out what was given empty, and keeps a page to its address', () => {
    expect(recipes.parse({ app: { url: 'http://localhost:5173' }, setup: [], env: {}, ready: '' })).toEqual({
      app: { url: 'http://localhost:5173' },
    });
  });

  it.each([
    [{}, '"app" must be given'],
    [{ app: { command: 'a', url: 'http://b' } }, 'one of them'],
    [{ app: {} }, 'one of them'],
    [{ app: { command: 'a' }, setup: 'npm run build' }, '"setup" must be a list'],
    [{ app: { command: 'a' }, setup: [''] }, '"setup" entry 1'],
    [{ app: { command: 'a' }, services: [{ command: 'serve', ready: 'localhost:3000' }] }, 'an http address'],
    [{ app: { command: 'a' }, env: { 'NOT A NAME': 'x' } }, 'not a name a variable can have'],
    [{ app: { command: 'a' }, env: { PORT: 3000 } }, 'must be a string'],
    [{ app: { command: 'a' }, data: { from: '../elsewhere', flag: '--user-data-dir' } }, 'inside the project'],
    [{ app: { command: 'a' }, data: { from: '/etc', flag: '--user-data-dir' } }, 'inside the project'],
    [{ app: { command: 'a' }, data: { from: 'data', flag: 'user data' } }, '"data.flag"'],
    [{ app: { url: 'http://a' }, data: { from: 'data', flag: '--user-data-dir' } }, 'not to a page'],
    [{ app: { command: 'a' }, wait: 'long' }, '"wait" must be a number'],
    [{ app: { command: 'a' }, notes: 'x'.repeat(1300) }, '"notes" may be at most'],
  ])('is refused, saying why, for %j', (given, why) => {
    expect(() => recipes.parse(given)).toThrow(why);
  });

  it('keeps the wait within what an app is ever given', () => {
    expect(recipes.parse({ app: { command: 'a' }, wait: 1000 }).wait).toBe(120);
    expect(recipes.parse({ app: { command: 'a' }, wait: -3 }).wait).toBe(0);
  });
});

describe('the recipes kept', () => {
  it('are kept for the workspace, and read back after a restart', () => {
    recipes.put(workspace, ELECTRON, 'thread-1');
    recipes.init(dir);
    expect(recipes.get(workspace)).toMatchObject({ ...ELECTRON, thread: 'thread-1' });
    expect(Date.parse(recipes.get(workspace)!.checkedAt)).not.toBeNaN();
    expect(recipes.get('/elsewhere')).toBeUndefined();
    expect(recipes.get(undefined)).toBeUndefined();
  });

  it('say where one last failed, keep the recipe, and forget the failure once it works again', () => {
    recipes.put(workspace, ELECTRON);
    recipes.failed(workspace, 'setup 1 (npm run build)', 'error TS2304: Cannot find name');
    recipes.init(dir);
    expect(recipes.get(workspace)).toMatchObject({
      ...ELECTRON,
      failed: { stage: 'setup 1 (npm run build)', why: 'error TS2304: Cannot find name' },
    });
    recipes.worked(workspace);
    expect(recipes.get(workspace)!.failed).toBeUndefined();
  });

  it('keep the end of a long failure, which is where the error is', () => {
    recipes.put(workspace, ELECTRON);
    recipes.failed(workspace, 'launch', `${'x'.repeat(2000)}the error`);
    const why = recipes.get(workspace)!.failed!.why;
    expect(why.length).toBeLessThan(700);
    expect(why.endsWith('the error')).toBe(true);
  });

  it('are replaced whole by the next one saved, which starts with no failure', () => {
    recipes.put(workspace, ELECTRON);
    recipes.failed(workspace, 'launch', 'gone');
    recipes.put(workspace, { app: { url: 'http://localhost:3000' } });
    expect(recipes.get(workspace)).not.toHaveProperty('setup');
    expect(recipes.get(workspace)).not.toHaveProperty('failed');
  });
});

describe('a first guess from the project files', () => {
  const pkg = (value: unknown) => fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(value));

  it("launches an Electron project with Electron's own launcher, after its build where it has one", () => {
    pkg({ scripts: { build: 'tsc' }, devDependencies: { electron: '^44.0.0' } });
    expect(recipes.draft(workspace)).toEqual({
      setup: ['npm run build'],
      app: { command: 'npx electron . --no-sandbox --disable-gpu' },
    });
  });

  it('serves a web app with its dev server, at the port its kind always uses', () => {
    pkg({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' } });
    expect(recipes.draft(workspace)).toEqual({
      services: [{ command: 'npm run dev', ready: 'http://localhost:5173' }],
      app: { url: 'http://localhost:5173' },
    });
    pkg({ scripts: { start: 'next start' }, dependencies: { next: '^15.0.0' } });
    expect(recipes.draft(workspace)!.app).toEqual({ url: 'http://localhost:3000' });
  });

  it('is not made where the files do not say', () => {
    expect(recipes.draft(workspace)).toBeNull();
    pkg({ scripts: { test: 'vitest' } });
    expect(recipes.draft(workspace)).toBeNull();
    fs.writeFileSync(path.join(workspace, 'package.json'), '{ not json');
    expect(recipes.draft(workspace)).toBeNull();
    expect(recipes.draft(undefined)).toBeNull();
  });
});

describe('what a model is told about running the app', () => {
  it('is the recipe, with the way to run all of it at once, and when it last worked', () => {
    recipes.put(workspace, ELECTRON);
    const said = unwrapped(recipes.prompt(workspace));
    expect(said).toContain('`npm run build`, then `npx electron . --no-sandbox`, up once #composer is showing');
    expect(said).toContain('recipe: true');
    expect(said).toContain(new Date().toISOString().slice(0, 10));
    expect(said).toContain('save_run_recipe');
    expect(said).not.toContain('failed');
  });

  it('passes on what whoever saved it said about using the app that way', () => {
    recipes.put(workspace, { ...ELECTRON, notes: 'Copy a scenario to /tmp/ch-scenario.json.' });
    expect(unwrapped(recipes.prompt(workspace))).toContain(
      'What whoever saved it says about using the app this way: Copy a scenario to /tmp/ch-scenario.json.'
    );
  });

  it('says where it last failed and what was said, for the next model to put right', () => {
    recipes.put(workspace, ELECTRON);
    recipes.failed(workspace, 'the ready check (#composer)', 'wait_for timed out');
    const said = unwrapped(recipes.prompt(workspace));
    expect(said).toContain('failed at the ready check (#composer)');
    expect(said).toContain('wait_for timed out');
  });

  it('is, where there is none, to save one once the app runs, with the guess to start from', () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ devDependencies: { electron: '1' } }));
    const said = unwrapped(recipes.prompt(workspace));
    expect(said).toContain('no run recipe');
    expect(said).toContain('save_run_recipe');
    expect(said).toContain('not yet tried: {"app":{"command":"npx electron . --no-sandbox --disable-gpu"}}');
  });

  it('is nothing outside a workspace', () => {
    expect(recipes.prompt(undefined)).toBe('');
  });
});
