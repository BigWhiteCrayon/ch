import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as local from '../../src/sandbox/local';

const WORKDIR = '/workspace';
const BASELINE_DIR = '/var/lib/ch-baseline.git';

describe('whether threads get folders', () => {
  it('is only where it is asked for and the app is in a container, which is the sandbox then', () => {
    expect(local.active({ CH_SANDBOX: 'local' }, true)).toBe(true);
    expect(local.active({ CH_SANDBOX: 'local' }, false)).toBe(false);
    expect(local.active({}, true)).toBe(false);
    expect(local.active({ CH_SANDBOX: 'docker' }, true)).toBe(false);
  });
});

describe('the paths in a command', () => {
  const own = local.folders('t1', '/tmp/ch-sandbox');

  it("are made the thread's own where they stand as the container's paths", () => {
    expect(
      local.inward(
        `cd /workspace && cat '/workspace/a.ts' /workspace; git --git-dir=${BASELINE_DIR} --work-tree=/workspace st`,
        own,
        WORKDIR,
        BASELINE_DIR
      )
    ).toBe(
      "cd /tmp/ch-sandbox/t1/workspace && cat '/tmp/ch-sandbox/t1/workspace/a.ts' /tmp/ch-sandbox/t1/workspace; " +
        'git --git-dir=/tmp/ch-sandbox/t1/baseline.git --work-tree=/tmp/ch-sandbox/t1/workspace st'
    );
  });

  it('are left alone where they only begin a longer name', () => {
    expect(local.inward('ls /workspaces /workspace.bak /workspace-2', own, WORKDIR, BASELINE_DIR)).toBe(
      'ls /workspaces /workspace.bak /workspace-2'
    );
  });

  it("come back as the container's in what the command says", () => {
    const said = '/tmp/ch-sandbox/t1/workspace/src/a.ts:3: error\nin /tmp/ch-sandbox/t1/baseline.git';
    expect(local.outward(said, own, WORKDIR, BASELINE_DIR)).toBe(`/workspace/src/a.ts:3: error\nin ${BASELINE_DIR}`);
  });
});

describe('what a command is given to run with', () => {
  it("is the app's tool environment without the app's own switches", () => {
    const env = local.environment({ PATH: '/bin', HOME: '/root', CH_TEST_MODE: '1', ELECTRON_RUN_AS_NODE: '1' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/root' });
  });
});

describe('a thread folder', () => {
  let root: string;
  let own: local.Folders;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-'));
    own = local.folders('t1', root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is made with the files of the workspace it is given, or all of them where none are named', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-workspace-'));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src/a.ts'), 'a');
    fs.writeFileSync(path.join(workspace, 'left-out.log'), 'x');
    await local.make(own, workspace, ['src/a.ts']);
    expect(fs.readFileSync(path.join(own.workspace, 'src/a.ts'), 'utf8')).toBe('a');
    expect(fs.existsSync(path.join(own.workspace, 'left-out.log'))).toBe(false);
    const other = local.folders('t2', root);
    await local.make(other, workspace, null);
    expect(fs.existsSync(path.join(other.workspace, 'left-out.log'))).toBe(true);
    expect(local.exists(own)).toBe(true);
    local.remove(own);
    expect(local.exists(own)).toBe(false);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('runs a command from itself, with what it is given on its input, and says its exit code', async () => {
    await local.make(own);
    const ran = await local.run(own, 'pwd; cat; exit 3', { input: 'given' });
    expect(ran.code).toBe(3);
    expect(ran.output).toBe(`${fs.realpathSync(own.workspace)}\ngiven`);
  });

  it('stops a command that runs too long, and what it started, as timeout would', async () => {
    await local.make(own);
    const started = Date.now();
    const ran = await local.run(own, 'sleep 30 & sleep 30; echo never', { timeoutSeconds: 1 });
    expect(ran.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('gives back the bytes a read writes, untouched', async () => {
    await local.make(own);
    fs.writeFileSync(path.join(own.workspace, 'b.bin'), Buffer.from([0, 255, 10, 1]));
    expect((await local.read(own, 'cat b.bin')).data).toEqual(Buffer.from([0, 255, 10, 1]));
  });
});

// The sandbox used through ./docker.ts, as everything else uses it, with threads given folders: what a thread is
// told and what it changes are as they are in a container
describe('a sandbox that is a folder, used as a container is', () => {
  const thread = randomUUID();
  let workspace: string;
  let docker: typeof import('../../src/sandbox/docker');
  let changes: typeof import('../../src/sandbox/changes');

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../src/sandbox/local', async (actual) => ({
      ...(await actual<typeof import('../../src/sandbox/local')>()),
      active: () => true,
    }));
    docker = await import('../../src/sandbox/docker');
    changes = await import('../../src/sandbox/changes');
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(workspace, 'ignored.txt'), 'x\n');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    docker.setWorkspace(thread, workspace);
  });

  afterEach(async () => {
    await docker.remove(thread);
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.doUnmock('../../src/sandbox/local');
  });

  it('is made from the workspace, says /workspace, and tells what the thread changed against it', async () => {
    const ran = await docker.exec(thread, 'pwd; ls -a /workspace; echo two >> a.txt; echo new > /workspace/b.txt');
    expect(ran.code).toBe(0);
    expect(ran.output).toContain('/workspace\n');
    expect(ran.output).toContain('a.txt');
    expect(ran.output).not.toContain('ignored.txt');
    expect(fs.readFileSync(path.join(local.folders(thread).workspace, 'b.txt'), 'utf8')).toBe('new\n');
    const found = await changes.list(thread);
    expect(found.files.map((file) => `${file.path} ${file.status}`).sort()).toEqual(['a.txt modified', 'b.txt added']);
    expect(found.files.find((file) => file.path === 'a.txt')!.diff).toContain('+two');
  });

  it('is not made by a look that may not make one', async () => {
    expect(await docker.ensure(thread, { create: false })).toBeNull();
    expect(local.exists(local.folders(thread))).toBe(false);
  });
});
