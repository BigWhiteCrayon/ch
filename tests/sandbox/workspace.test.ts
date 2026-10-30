import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create, folderName, isManaged, root } from '../../src/sandbox/workspace';

// Real folders and a real git, under a temp directory that is removed afterwards. HOME and the global git config
// point into it as well, so that nothing of the user's decides whether an identity is set.
let tmp: string;
const saved = { dir: process.env.CH_WORKSPACES_DIR, home: process.env.HOME, config: process.env.GIT_CONFIG_GLOBAL };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-workspace-')));
  process.env.HOME = tmp;
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
  delete process.env.CH_WORKSPACES_DIR;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('CH_WORKSPACES_DIR', saved.dir);
  restore('HOME', saved.home);
  restore('GIT_CONFIG_GLOBAL', saved.config);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('root', () => {
  it('is ch-workspaces in the home directory by default', () => {
    expect(root()).toBe(path.join(os.homedir(), 'ch-workspaces'));
  });

  it('can be moved with CH_WORKSPACES_DIR', () => {
    process.env.CH_WORKSPACES_DIR = '/somewhere/else';
    expect(root()).toBe('/somewhere/else');
  });

  it('ignores a blank CH_WORKSPACES_DIR', () => {
    process.env.CH_WORKSPACES_DIR = '   ';
    expect(root()).toBe(path.join(os.homedir(), 'ch-workspaces'));
  });
});

describe('folderName', () => {
  it('keeps a plain name', () => {
    expect(folderName('my-project_1.0')).toBe('my-project_1.0');
  });

  it('turns runs of unsafe characters into one dash', () => {
    expect(folderName('  My  new/project!! ')).toBe('My-new-project');
  });

  it('strips leading and trailing dots and dashes', () => {
    expect(folderName('..-hidden-.')).toBe('hidden');
  });

  it('cuts to 60 characters', () => {
    expect(folderName('a'.repeat(100))).toHaveLength(60);
  });

  it('refuses a name with nothing usable in it', () => {
    expect(() => folderName('   ')).toThrow('A workspace needs a name.');
    expect(() => folderName('/// ...')).toThrow('A workspace needs a name.');
  });
});

describe('create', () => {
  it('makes a repository on main with an initial commit', async () => {
    const parent = path.join(tmp, 'parent', 'deeper');
    const folder = await create('Demo', parent);
    expect(folder).toBe(path.join(parent, 'Demo'));
    expect(git(folder, 'branch', '--show-current')).toBe('main');
    expect(git(folder, 'log', '--format=%s')).toBe('Initial commit');
    expect(git(folder, 'status', '--porcelain')).toBe('');
  });

  it('numbers a name that is taken', async () => {
    const parent = path.join(tmp, 'parent');
    const first = await create('Demo', parent);
    const second = await create('Demo', parent);
    const third = await create('Demo', parent);
    expect([first, second, third]).toEqual(['Demo', 'Demo-2', 'Demo-3'].map((n) => path.join(parent, n)));
  });

  it('gives two creations at the same moment two folders', async () => {
    const parent = path.join(tmp, 'parent');
    const folders = await Promise.all([create('Same', parent), create('Same', parent)]);
    expect(new Set(folders).size).toBe(2);
  });

  it('sets an identity locally when the user has none', async () => {
    const folder = await create('Demo', path.join(tmp, 'parent'));
    expect(git(folder, 'config', '--local', 'user.email')).toBe('ch@localhost');
    expect(git(folder, 'config', '--local', 'user.name')).toBe('ch');
  });

  it('leaves the identity the user has alone', async () => {
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '[user]\n\temail = me@example.com\n\tname = Me\n');
    const folder = await create('Demo', path.join(tmp, 'parent'));
    expect(git(folder, 'config', 'user.email')).toBe('me@example.com');
    expect(git(folder, 'log', '--format=%an <%ae>')).toBe('Me <me@example.com>');
    expect(() => git(folder, 'config', '--local', 'user.email')).toThrow();
  });

  it('uses the default root when no parent is given', async () => {
    process.env.CH_WORKSPACES_DIR = path.join(tmp, 'configured');
    const folder = await create('Demo');
    expect(folder).toBe(path.join(tmp, 'configured', 'Demo'));
  });

  it('refuses a name with nothing usable in it and makes nothing', async () => {
    const parent = path.join(tmp, 'parent');
    await expect(create('///', parent)).rejects.toThrow('A workspace needs a name.');
    expect(fs.existsSync(parent)).toBe(false);
  });

  it('removes the folder when setting it up fails', async () => {
    const parent = path.join(tmp, 'parent');
    // A global config that git cannot read makes every git command fail
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '[user\n');
    await expect(create('Demo', parent)).rejects.toThrow(/config|fatal/i);
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});

describe('isManaged', () => {
  it('is true for a workspace that create made', async () => {
    const parent = path.join(tmp, 'parent');
    expect(await isManaged(await create('Demo', parent), parent)).toBe(true);
  });

  it('is false for a folder that is not a repository', async () => {
    const parent = path.join(tmp, 'parent');
    fs.mkdirSync(path.join(parent, 'plain'), { recursive: true });
    expect(await isManaged(path.join(parent, 'plain'), parent)).toBe(false);
  });

  it('is false for a repository with no commit', async () => {
    const parent = path.join(tmp, 'parent');
    const folder = path.join(parent, 'empty');
    fs.mkdirSync(folder, { recursive: true });
    git(folder, 'init');
    expect(await isManaged(folder, parent)).toBe(false);
  });

  it('is false for a folder deeper down or outside the parent', async () => {
    const parent = path.join(tmp, 'parent');
    const inner = await create('Demo', path.join(parent, 'group'));
    expect(await isManaged(inner, parent)).toBe(false);
    expect(await isManaged(await create('Demo', path.join(tmp, 'other')), parent)).toBe(false);
    expect(await isManaged(parent, parent)).toBe(false);
  });

  it('is false for a file, and for a path that is not there', async () => {
    const parent = path.join(tmp, 'parent');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'file'), '');
    expect(await isManaged(path.join(parent, 'file'), parent)).toBe(false);
    expect(await isManaged(path.join(parent, 'missing'), parent)).toBe(false);
    expect(await isManaged(path.join(parent, 'missing'), path.join(tmp, 'nowhere'))).toBe(false);
  });

  it('follows a link to the real folder, so a link in the parent to a folder elsewhere is not managed', async () => {
    const parent = path.join(tmp, 'parent');
    const elsewhere = await create('Demo', path.join(tmp, 'other'));
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(parent, 'link'));
    expect(await isManaged(path.join(parent, 'link'), parent)).toBe(false);
  });

  it('defaults the parent to the root', async () => {
    process.env.CH_WORKSPACES_DIR = path.join(tmp, 'configured');
    expect(await isManaged(await create('Demo'))).toBe(true);
  });
});
