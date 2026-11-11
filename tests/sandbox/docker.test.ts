import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for child_process.spawn. Each test supplies `respond`, which
// decides how a command ends; nothing is really run.
type Outcome = { code?: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };

const proc = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; options: any; input: string }[],
  respond: (_command: string, _args: string[]): Outcome | Promise<Outcome> => ({ code: 0 }),
}));

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options: any) => {
    const child: any = new EventEmitter();
    const record = { command, args, options, input: '' };
    proc.calls.push(record);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (input?: string) => {
        record.input = input ?? '';
      },
    });
    child.unref = vi.fn();
    Promise.resolve()
      .then(() => proc.respond(command, args))
      .then((outcome) => {
        if (outcome.error) return child.emit('error', outcome.error);
        if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout));
        if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
        child.emit('close', outcome.code ?? 0);
      });
    return child;
  },
}));

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const NAME = `ch-thread-${THREAD}`;

// The module keeps per-session state, so each test gets a fresh copy
let docker: typeof import('../../src/sandbox/docker');

beforeEach(async () => {
  proc.calls = [];
  proc.respond = () => ({ code: 0 });
  vi.resetModules();
  docker = await import('../../src/sandbox/docker');
});

// What was run, as "docker inspect ..." strings
const ran = () => proc.calls.map((c) => [c.command, ...c.args].join(' '));
// What a build tagged what it built, and the context it was built from,
// whatever else is on its command line
const tagOf = (call: { args: string[] }) => call.args[call.args.indexOf('-t') + 1];
const contextOf = (call: { args: string[] }) => call.args.at(-1) as string;
const ranStartingWith = (prefix: string) => ran().filter((line) => line.startsWith(prefix));

// A Docker that behaves: containers in `existing` map to running (true) or
// stopped (false), and `budgets` holds the pids limit any of them was made
// with, for the containers left over from an older app that were made with a
// smaller one. The rest are as a container made now would be.
function healthyDocker(existing: Record<string, boolean> = {}, budgets: Record<string, number> = {}) {
  proc.respond = (command, args) => {
    if (command !== 'docker') return { code: 1 };
    if (args[0] === 'inspect') {
      const name = args.at(-1) as string;
      if (!(name in existing)) return { code: 1, stderr: 'No such object' };
      return { stdout: `${existing[name]} ${budgets[name] ?? docker.PIDS_LIMIT}\n` };
    }
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1];
      existing[name] = true;
      budgets[name] = Number(args[args.indexOf('--pids-limit') + 1]);
    }
    if (args[0] === 'start') existing[args[1]] = true;
    if (args[0] === 'update') budgets[args.at(-1) as string] = Number(args[args.indexOf('--pids-limit') + 1]);
    if (args[0] === 'exec') return { stdout: 'output\n' };
    return { code: 0 };
  };
  return existing;
}

describe('containerName', () => {
  it('names the container after the thread', () => {
    expect(docker.containerName(THREAD)).toBe(NAME);
  });

  it.each([undefined, '', 'not-a-uuid', `${THREAD}; rm -rf /`])('rejects the thread id %j', (id) => {
    expect(() => docker.containerName(id)).toThrow('This message has no thread.');
  });
});

describe('the image a workspace is worked on in', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-image-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const put = (name: string) => fs.writeFileSync(path.join(workspace, name), '');

  it.each([
    ['package.json', 'node:22-bookworm-slim'],
    ['pyproject.toml', 'python:3.12-slim-bookworm'],
    ['requirements.txt', 'python:3.12-slim-bookworm'],
    ['go.mod', 'golang:1-bookworm'],
    ['Cargo.toml', 'rust:1-slim-bookworm'],
    ['pom.xml', 'eclipse-temurin:21-jdk-noble'],
    ['Gemfile', 'ruby:3-slim-bookworm'],
  ])('is the one %s asks for', (file, image) => {
    put(file);
    expect(docker.baseImage(workspace)).toBe(image);
  });

  it('is the plain one for a workspace that asks for nothing, and for no workspace at all', () => {
    put('README.md');
    expect(docker.baseImage(workspace)).toBe(docker.PLAIN_IMAGE);
    expect(docker.baseImage(undefined)).toBe(docker.PLAIN_IMAGE);
    // ...and for one that cannot be read
    expect(docker.baseImage('/nowhere-at-all')).toBe(docker.PLAIN_IMAGE);
  });

  it('takes the first match, so a stray requirements.txt does not make a Node project Python', () => {
    put('package.json');
    put('requirements.txt');
    expect(docker.baseImage(workspace)).toBe('node:22-bookworm-slim');
  });

  it('is whatever the user chose, whatever the workspace says', () => {
    put('package.json');
    expect(docker.baseImage(workspace, 'my/own:image')).toBe('my/own:image');
    // Blank means let the workspace decide
    expect(docker.baseImage(workspace, '   ')).toBe('node:22-bookworm-slim');
  });

  it('builds a different image per base, and reuses one it has already built', async () => {
    const existing = healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (command === 'docker' && args[0] === 'image') return { code: 1, stderr: 'No such image' };
      return healthy(command, args);
    };
    put('package.json');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    const forNode = proc.calls.filter((c) => c.args[0] === 'build');
    expect(forNode).toHaveLength(1);
    expect(forNode[0].input).toContain('FROM node:22-bookworm-slim');
    // Git goes on top of it, since the baseline needs it and a toolchain image
    // is not sure to have it
    expect(forNode[0].input).toContain('command -v git');
    // ...and what the screenshot and record tools draw and film with, so that
    // the cost is paid once in the image rather than by every thread that
    // records (see the dockerfile)
    expect(forNode[0].input).toContain('chromium');
    expect(forNode[0].input).toContain('xvfb ffmpeg');

    // Another workspace, another toolchain, another image
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-image-'));
    fs.writeFileSync(path.join(other, 'go.mod'), '');
    const second = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(second, other);
    delete existing[docker.containerName(second)];
    await docker.ensure(second);
    const builds = proc.calls.filter((c) => c.args[0] === 'build');
    expect(builds).toHaveLength(2);
    expect(builds[1].input).toContain('FROM golang:1-bookworm');
    expect(tagOf(builds[0])).not.toBe(tagOf(builds[1]));
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe('the dependencies a workspace is installed with', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-deps-test-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const put = (name: string, text = '{}') => fs.writeFileSync(path.join(workspace, name), text);
  const builds = () => proc.calls.filter((c) => c.args[0] === 'build');
  const created = () => ranStartingWith('docker run').at(-1) as string;

  // Docker with every image missing until it is built, and the builds recorded
  function missingImages(failDependencies = false) {
    const existing = healthyDocker();
    const healthy = proc.respond;
    const built = new Set<string>();
    proc.respond = (command, args) => {
      if (command === 'docker' && args[0] === 'image') {
        return built.has(args[2]) ? { code: 0 } : { code: 1, stderr: 'No such image' };
      }
      if (command === 'docker' && args[0] === 'build') {
        const tag = tagOf({ args });
        if (failDependencies && tag.startsWith('ch-deps:')) return { code: 1, stderr: 'npm ERR!' };
        built.add(tag);
      }
      return healthy(command, args);
    };
    return existing;
  }

  it('are installed once into an image of their own, which the thread starts from', async () => {
    missingImages();
    put('package.json');
    put('package-lock.json');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);

    expect(builds()).toHaveLength(2);
    const [, deps] = builds();
    const tag = tagOf(deps);
    expect(tag).toMatch(/^ch-deps:[0-9a-f]{12}$/);
    // On top of the sandbox image, installed where the project is worked on
    expect(deps.input).toMatch(/^FROM ch-sandbox:[0-9a-f]{12}\n/);
    expect(deps.input).toContain('WORKDIR /workspace');
    expect(deps.input).toContain('COPY package.json package-lock.json /workspace/');
    expect(deps.input).toContain('npm ci');
    // ...without lifecycle scripts, which have no project to run in
    expect(deps.input).toContain('--ignore-scripts');
    // ...but with Electron's binary, which only its postinstall would have fetched
    expect(deps.input).toContain(`--ignore-scripts && ${docker.ELECTRON_INSTALL}`);
    // ...from a context of the manifests alone
    expect(deps.args.join(' ')).toContain('-f -');
    expect(contextOf(deps)).not.toBe(workspace);
    expect(created().split(' ').at(-3)).toBe(tag);
  });

  it('are reused by the next thread, and by the one after a restart', async () => {
    const existing = missingImages();
    put('package.json');
    put('yarn.lock');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    const second = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(second, workspace);
    delete existing[docker.containerName(second)];
    await docker.ensure(second);
    expect(builds()).toHaveLength(2);
    expect(builds()[1].input).toContain('yarn install --frozen-lockfile');
    expect(ranStartingWith('docker run').at(-1)).toBe(created());
  });

  it('are installed again when the lockfile changes', async () => {
    const existing = missingImages();
    put('package.json');
    put('package-lock.json', '{"a":1}');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    put('package-lock.json', '{"a":2}');
    const second = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(second, workspace);
    delete existing[docker.containerName(second)];
    await docker.ensure(second);
    const tags = builds()
      .map(tagOf)
      .filter((tag) => tag.startsWith('ch-deps:'));
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toBe(tags[1]);
  });

  it('are installed for Python from requirements.txt', async () => {
    missingImages();
    put('requirements.txt', 'requests\n');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    expect(builds()[1].input).toContain('pip install --no-cache-dir -r requirements.txt');
  });

  it('are not installed for a Node project without a lockfile, nor where there is nothing to install', async () => {
    missingImages();
    put('package.json');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    expect(builds()).toHaveLength(1);
    expect(created()).toContain('ch-sandbox:');

    const other = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(other, '/projects/demo');
    await docker.ensure(other);
    expect(builds().filter((b) => tagOf(b).startsWith('ch-deps:'))).toHaveLength(0);
  });

  it('leave the thread on the sandbox image when they cannot be installed, nor retried per thread', async () => {
    const existing = missingImages(true);
    put('package.json');
    put('package-lock.json');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    expect(created()).toContain('ch-sandbox:');
    expect(created()).not.toContain('ch-deps:');

    const second = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(second, workspace);
    delete existing[docker.containerName(second)];
    await docker.ensure(second);
    expect(builds().filter((b) => tagOf(b).startsWith('ch-deps:'))).toHaveLength(1);
    expect(ranStartingWith('docker run')).toHaveLength(2);
  });

  it('leave no manifests behind in the temporary directory', async () => {
    missingImages();
    put('package.json');
    put('package-lock.json');
    docker.setWorkspace(THREAD, workspace);
    await docker.ensure(THREAD);
    expect(fs.existsSync(contextOf(builds()[1]))).toBe(false);
  });
});

describe('what the threads of a workspace share', () => {
  it('mounts one cache for the workspace, and tells the package managers to use it', async () => {
    healthyDocker();
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.ensure(THREAD);
    const created = ranStartingWith('docker run').at(-1) as string;
    // One volume per workspace, by a digest of its path
    expect(created).toMatch(/-v ch-cache-[0-9a-f]{12}:\/cache/);
    // Each manager's downloads land in it; what each thread installs from them
    // stays its own, so two threads cannot write over each other's work
    for (const pair of ['NPM_CONFIG_CACHE=/cache/npm', 'PIP_CACHE_DIR=/cache/pip', 'GOMODCACHE=/cache/go/mod']) {
      expect(created).toContain(`-e ${pair}`);
    }
  });

  it('is the same cache for two threads in one workspace, and a different one across workspaces', async () => {
    const existing = healthyDocker();
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.ensure(THREAD);
    const mine = /-v (ch-cache-[0-9a-f]{12}):/.exec(ranStartingWith('docker run').at(-1) as string)![1];

    const second = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(second, '/projects/demo');
    delete existing[docker.containerName(second)];
    await docker.ensure(second);
    expect(ranStartingWith('docker run').at(-1)).toContain(`-v ${mine}:`);

    const third = '2c9f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f22';
    docker.setWorkspace(third, '/projects/other');
    delete existing[docker.containerName(third)];
    await docker.ensure(third);
    expect(ranStartingWith('docker run').at(-1)).not.toContain(`-v ${mine}:`);
  });

  it('mounts nothing for a thread with no workspace: there is nothing to share it with', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    expect(ranStartingWith('docker run').at(-1)).not.toContain('-v ');
  });
});

describe('ensure', () => {
  it('creates a container for a thread that has none', async () => {
    healthyDocker();
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
    expect(ran()).toEqual([
      'docker info',
      `docker inspect -f {{.State.Running}} {{.HostConfig.PidsLimit}} ${NAME}`,
      expect.stringMatching(/^docker image inspect ch-sandbox:[0-9a-f]{12}$/),
      expect.stringMatching(
        new RegExp(
          `^docker run -d --init --name ${NAME} -w /workspace --label ch\\.sandbox=1` +
            ` --pids-limit ${docker.PIDS_LIMIT} .* sleep infinity$`
        )
      ),
    ]);
  });

  // What happens at the start of a thread: its first read and its first
  // command arrive together, and the read may not make a container
  it('makes one for a caller that needs it, where the one under way may not', async () => {
    healthyDocker();
    const [looked, needed] = await Promise.all([docker.ensure(THREAD, { create: false }), docker.ensure(THREAD)]);
    expect(looked).toBeNull();
    expect(needed).toBe(NAME);
    expect(ranStartingWith('docker run')).toHaveLength(1);
  });

  it('waits for the one under way rather than making a second beside it', async () => {
    healthyDocker();
    const [first, second] = await Promise.all([docker.ensure(THREAD), docker.ensure(THREAD)]);
    expect([first, second]).toEqual([NAME, NAME]);
    expect(ranStartingWith('docker run')).toHaveLength(1);
  });

  it('takes the answer of the one under way where that one may do as much', async () => {
    healthyDocker({ [NAME]: true });
    const both = await Promise.all([docker.ensure(THREAD), docker.ensure(THREAD, { create: false })]);
    expect(both).toEqual([NAME, NAME]);
    expect(ranStartingWith('docker inspect')).toHaveLength(1);
  });

  it('asks Docker about a container once, and takes it on trust after that', async () => {
    healthyDocker({ [NAME]: true });
    await docker.ensure(THREAD);
    await docker.ensure(THREAD);
    await docker.ensure(THREAD);
    // Asking again costs as much as a third of the command it precedes
    expect(ranStartingWith('docker inspect')).toHaveLength(1);
  });

  describe('the image a container is made from', () => {
    // A Docker that has no image with Git yet, and builds one or fails to
    const withoutImage = (buildCode: number) => {
      healthyDocker();
      const healthy = proc.respond;
      proc.respond = (command, args) => {
        if (args[0] === 'image') return { code: 1, stderr: 'No such image' };
        if (args[0] === 'build') return { code: buildCode, stderr: buildCode ? 'network unreachable' : '' };
        return healthy(command, args);
      };
    };
    const built = () => proc.calls.filter((c) => c.args[0] === 'build');

    it('is built with Git the first time it is needed, and only then', async () => {
      withoutImage(0);
      await docker.ensure(THREAD);
      expect(built().map((c) => c.args.join(' '))).toEqual([
        expect.stringMatching(/^build --label ch\.sandbox=1 -t ch-sandbox:[0-9a-f]{12} -$/),
      ]);
      expect(built()[0].input).toContain('FROM debian:bookworm-slim');
      expect(built()[0].input).toContain('install -y --no-install-recommends git');
      expect(ranStartingWith('docker run').at(-1)).toMatch(/ ch-sandbox:[0-9a-f]{12} sleep infinity$/);

      await docker.ensure('7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11');
      expect(built()).toHaveLength(1);
    });

    it('is the plain one when that cannot be built, and the build is tried again for the next container', async () => {
      withoutImage(1);
      await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
      expect(ranStartingWith('docker run').at(-1)).toContain(' debian:bookworm-slim sleep infinity');

      await docker.ensure('7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11');
      expect(built()).toHaveLength(2);
    });
  });

  it('starts a container that exists but is stopped', async () => {
    healthyDocker({ [NAME]: false });
    await docker.ensure(THREAD);
    expect(ran().at(-1)).toBe(`docker start ${NAME}`);
    expect(ranStartingWith('docker run')).toEqual([]);
  });

  it('leaves a running container alone', async () => {
    healthyDocker({ [NAME]: true });
    await docker.ensure(THREAD);
    expect(ran()).toEqual(['docker info', `docker inspect -f {{.State.Running}} {{.HostConfig.PidsLimit}} ${NAME}`]);
  });

  // Docker keeps the budget a container was created with, and `start` does not
  // take it again: a container from an older app would otherwise go on
  // starving the browsers in it for as long as it exists
  it.each([
    ['stopped', false],
    ['running', true],
  ])('raises the pids limit of a %s container made with a smaller one', async (_what, isRunning) => {
    const budgets = { [NAME]: 512 };
    healthyDocker({ [NAME]: isRunning }, budgets);
    await docker.ensure(THREAD);
    expect(ranStartingWith('docker update')).toEqual([`docker update --pids-limit ${docker.PIDS_LIMIT} ${NAME}`]);
    expect(budgets[NAME]).toBe(docker.PIDS_LIMIT);
  });

  it('raises it before the container starts, so it holds from the first moment', async () => {
    healthyDocker({ [NAME]: false }, { [NAME]: 512 });
    await docker.ensure(THREAD);
    expect(ran().filter((line) => line.includes('update') || line.includes('start'))).toEqual([
      `docker update --pids-limit ${docker.PIDS_LIMIT} ${NAME}`,
      `docker start ${NAME}`,
    ]);
  });

  it.each([
    ['one already at the limit', (docker0) => docker0.PIDS_LIMIT],
    ['one above it, which a later app may have raised', (docker0) => docker0.PIDS_LIMIT * 2],
    ['no limit at all', () => 0],
    ['no limit, as Docker also writes it', () => -1],
  ])('leaves the pids limit of a container with %s alone', async (_what, budget) => {
    healthyDocker({ [NAME]: true }, { [NAME]: budget(docker) });
    await docker.ensure(THREAD);
    expect(ranStartingWith('docker update')).toEqual([]);
  });

  // The container still works with the budget it has, so a raise that fails
  // must not stop the thread using it
  it('carries on with a container whose pids limit could not be raised', async () => {
    healthyDocker({ [NAME]: false }, { [NAME]: 512 });
    const behaving = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'update' ? { code: 1, stderr: 'no cgroup' } : behaving(command, args);
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
    expect(ran().at(-1)).toBe(`docker start ${NAME}`);
  });

  it('only looks, without creating or starting Docker, when create is false', async () => {
    healthyDocker();
    await expect(docker.ensure(THREAD, { create: false })).resolves.toBeNull();
    expect(ran()).toEqual([`docker inspect -f {{.State.Running}} {{.HostConfig.PidsLimit}} ${NAME}`]);
  });

  it('creates one container when several callers ask at the same time', async () => {
    healthyDocker();
    const names = await Promise.all([docker.ensure(THREAD), docker.ensure(THREAD), docker.ensure(THREAD)]);
    expect(names).toEqual([NAME, NAME, NAME]);
    expect(ranStartingWith('docker run')).toHaveLength(1);
  });

  it('checks the daemon only once per session', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    await docker.ensure(THREAD);
    expect(ranStartingWith('docker info')).toHaveLength(1);
  });

  it('starts Colima when the Docker daemon is not running', async () => {
    const existing = healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (command === 'docker' && args[0] === 'info') return { code: 1 };
      if (command === 'colima') return { code: 0 };
      return healthy(command, args);
    };
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
    expect(ran().slice(0, 2)).toEqual(['docker info', 'colima start']);
    expect(existing[NAME]).toBe(true);
  });

  it('explains when Docker is not running and Colima cannot start it, then tries again next time', async () => {
    proc.respond = (command, args) => {
      if (command === 'docker' && args[0] === 'info') return { code: 1 };
      if (command === 'colima') return { error: Object.assign(new Error('spawn colima ENOENT'), { code: 'ENOENT' }) };
      if (command === 'open') return { code: 1 };
      return { code: 0 };
    };
    await expect(docker.ensure(THREAD)).rejects.toThrow('Docker is installed but not running');

    healthyDocker();
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
  });

  describe('with Docker Desktop on macOS', () => {
    const noColima = { error: Object.assign(new Error('spawn colima ENOENT'), { code: 'ENOENT' }) };

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('opens it when there is no Colima, and waits for the daemon', async () => {
      const existing = healthyDocker();
      const healthy = proc.respond;
      let opened = false;
      let asked = 0;
      proc.respond = (command, args) => {
        if (command === 'colima') return noColima;
        if (command === 'open') {
          opened = true;
          return { code: 0 };
        }
        // The first answer is from before it was opened, the second from before it was up
        if (command === 'docker' && args[0] === 'info' && (!opened || ++asked < 2)) return { code: 1 };
        return healthy(command, args);
      };
      vi.useFakeTimers();
      const ensured = docker.ensure(THREAD);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(ensured).resolves.toBe(NAME);
      expect(ranStartingWith('open')).toEqual(['open -a Docker']);
      expect(ranStartingWith('docker info')).toHaveLength(3);
      expect(existing[NAME]).toBe(true);
    });

    it('does not open it when Colima starts', async () => {
      healthyDocker();
      const healthy = proc.respond;
      proc.respond = (command, args) => {
        if (command === 'docker' && args[0] === 'info') return { code: 1 };
        if (command === 'colima') return { code: 0 };
        return healthy(command, args);
      };
      await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
      expect(ranStartingWith('open')).toEqual([]);
    });

    it('gives up when the daemon never comes up', async () => {
      proc.respond = (command, args) => {
        if (command === 'docker' && args[0] === 'info') return { code: 1 };
        if (command === 'colima') return noColima;
        return { code: 0 };
      };
      vi.useFakeTimers();
      const ensured = expect(docker.ensure(THREAD)).rejects.toThrow('Docker is installed but not running');
      await vi.advanceTimersByTimeAsync(120000);
      await ensured;
    });
  });

  it('does not try to open Docker Desktop away from macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    proc.respond = (command, args) => {
      if (command === 'docker' && args[0] === 'info') return { code: 1 };
      if (command === 'colima') return { code: 1 };
      return { code: 0 };
    };
    await expect(docker.ensure(THREAD)).rejects.toThrow('Docker is installed but not running');
    expect(ranStartingWith('open')).toEqual([]);
    vi.restoreAllMocks();
  });

  it('explains when Docker is not installed', async () => {
    proc.respond = () => ({ error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) });
    await expect(docker.ensure(THREAD)).rejects.toThrow(
      'Docker is not installed. Settings has a setup flow that installs it; try again after that.'
    );
  });

  it('reports why a container could not be created', async () => {
    healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'run' ? { code: 125, stderr: 'pull access denied\n' } : healthy(command, args);
    await expect(docker.ensure(THREAD)).rejects.toThrow("Could not create the thread's container: pull access denied");
  });

  describe('copying the workspace in', () => {
    let workspace: string;
    // What Git says the workspace holds
    let tracked = '';

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-copy-'));
      healthyDocker();
      const healthy = proc.respond;
      proc.respond = (command, args) => {
        if (command === 'git') return { code: 0, stdout: tracked };
        if (command === 'sh') return { code: 0 };
        return healthy(command, args);
      };
      docker.setWorkspace(THREAD, workspace);
    });

    afterEach(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    const put = (name: string) => {
      fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
      fs.writeFileSync(path.join(workspace, name), '');
    };
    const streamed = () => proc.calls.find((c) => c.command === 'sh');

    it("copies the files Git would track, so the workspace's own build output is left behind", async () => {
      put('src/a.ts');
      put('package.json');
      tracked = 'src/a.ts\0package.json\0';
      await docker.ensure(THREAD);

      const listed = proc.calls.find((c) => c.command === 'git')!;
      expect(listed.args).toEqual(['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      // Streamed in as an archive of those files: `docker cp` cannot leave
      // anything out, and what it would bring is mostly node_modules
      expect(streamed()!.args.join(' ')).toContain('tar -cf - -C "$1" -T - | docker exec -i "$2" tar -xf - -C "$3"');
      expect(streamed()!.args.slice(-3)).toEqual([workspace, NAME, '/workspace']);
      expect(streamed()!.input).toBe('src/a.ts\npackage.json\n');
      expect(ran()).not.toContain(`docker cp ${workspace}/. ${NAME}:/workspace`);
    });

    it('leaves out a file Git still has but the workspace does not', async () => {
      // A file deleted but whose deletion is not committed is in the index.
      // tar fails on it and gives up on the whole archive, which would send
      // the copy back to bringing everything.
      put('src/a.ts');
      tracked = 'src/a.ts\0src/gone.ts\0';
      await docker.ensure(THREAD);
      expect(streamed()!.input).toBe('src/a.ts\n');
      expect(ran()).not.toContain(`docker cp ${workspace}/. ${NAME}:/workspace`);
    });

    it('copies everything when Git names nothing that is there', async () => {
      tracked = 'src/gone.ts\0';
      await docker.ensure(THREAD);
      expect(streamed()!.input).toBe('\n');
    });
  });

  it('copies everything for a workspace that is not a repository', async () => {
    healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      command === 'git' ? { code: 128, stderr: 'not a git repository' } : healthy(command, args);
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.ensure(THREAD);
    expect(ran()).toContain(`docker cp /projects/demo/. ${NAME}:/workspace`);
  });

  it('falls back to copying everything when the archive could not be streamed', async () => {
    healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (command === 'git') return { code: 0, stdout: 'src/a.ts\0' };
      // No tar in the container, or no pipe: a thread with its files beats one
      // without them
      if (command === 'sh') return { code: 2, stderr: 'tar: not found' };
      return healthy(command, args);
    };
    docker.setWorkspace(THREAD, '/projects/demo');
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
    expect(ran()).toContain(`docker cp /projects/demo/. ${NAME}:/workspace`);
  });

  it('records the files as they were copied, in a repository of its own outside the working directory', async () => {
    healthyDocker();
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.ensure(THREAD);
    const recorded = ran().at(-1) as string;
    expect(
      recorded.startsWith(
        `docker exec -w /workspace ${NAME} bash -lc git --git-dir=/var/lib/ch-baseline.git --work-tree=/workspace`
      )
    ).toBe(true);
    expect(recorded).toMatch(/ init -q && .* add -A && .* commit -q --allow-empty -m baseline$/);
    expect(docker.BASELINE).not.toContain('/workspace/.git');
  });

  it('records nothing for a thread without a workspace, and still makes the container if recording fails', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    expect(ran().join('\n')).not.toContain('ch-baseline');

    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'exec' ? { code: 127, stderr: 'git: command not found' } : healthy(command, args);
    const other = '7c1f0c7e-5a0b-4d8f-9a53-0f4f8a6f2f11';
    docker.setWorkspace(other, '/projects/demo');
    await expect(docker.ensure(other)).resolves.toBe(`ch-thread-${other}`);
  });

  it('does not copy the workspace again into a container that already exists', async () => {
    healthyDocker({ [NAME]: false });
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.ensure(THREAD);
    expect(ranStartingWith('docker cp')).toEqual([]);
  });

  it('removes the container when the workspace cannot be copied, so the next attempt starts over', async () => {
    const existing = healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (args[0] === 'cp') return { code: 1, stderr: 'no such directory\n' };
      if (args[0] === 'rm') delete existing[args.at(-1) as string];
      return healthy(command, args);
    };
    docker.setWorkspace(THREAD, '/projects/gone');
    await expect(docker.ensure(THREAD)).rejects.toThrow(
      "Could not copy /projects/gone into the thread's container: no such directory"
    );
    expect(ran().at(-1)).toBe(`docker rm -f ${NAME}`);

    proc.respond = healthy;
    await expect(docker.ensure(THREAD)).resolves.toBe(NAME);
    expect(ranStartingWith('docker cp')).toHaveLength(2);
  });

  it('looks in the Homebrew directories for docker', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    expect(proc.calls[0].options.env.PATH).toContain('/opt/homebrew/bin');
  });
});

describe('adopt', () => {
  const execs = () => proc.calls.filter((c) => c.command === 'docker' && c.args[0] === 'exec');

  it('records an empty baseline in a container that exists, without copying anything in', async () => {
    healthyDocker({ [NAME]: true });
    await docker.adopt(THREAD, '/projects/demo');
    expect(execs()).toHaveLength(1);
    const { args } = execs()[0];
    expect(args.slice(0, 6)).toEqual(['exec', '-w', '/workspace', NAME, 'bash', '-lc']);
    const command = args[6];
    expect(command).toContain('git --git-dir=/var/lib/ch-baseline.git');
    expect(command).toContain('init -q');
    expect(command).toContain('commit -q --allow-empty');
    // What is in the container is the thread's own, so all of it is a change
    expect(command).not.toContain('add -A');
    expect(ranStartingWith('docker run')).toEqual([]);
    expect(ranStartingWith('docker cp')).toEqual([]);
  });

  it('remembers the workspace for a thread with no container, which is made with it later', async () => {
    healthyDocker();
    await expect(docker.adopt(THREAD, '/projects/demo')).resolves.toBeUndefined();
    expect(execs()).toEqual([]);
    expect(ranStartingWith('docker run')).toEqual([]);

    await docker.ensure(THREAD);
    expect(ranStartingWith('docker run').at(-1)).toMatch(/-v ch-cache-[0-9a-f]{12}:\/cache/);
    // Copied in and recorded in the ordinary way
    expect(ran()).toContain(`docker cp /projects/demo/. ${NAME}:/workspace`);
    expect(ran().at(-1)).toMatch(/ init -q && .* add -A && .* commit -q --allow-empty -m baseline$/);
  });

  it('says so when the baseline cannot be recorded, and forgets the workspace', async () => {
    const existing = healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'exec' ? { code: 127, stderr: 'git: command not found' } : healthy(command, args);
    await expect(docker.adopt(THREAD, '/projects/demo')).rejects.toThrow(/^Could not set up the thread/);

    // A container made afterwards has no workspace to share a cache for. The
    // container is gone, and the first exec is the one that finds out.
    delete existing[NAME];
    let seen = 0;
    proc.respond = (command, args) => {
      if (args[0] === 'exec' && seen++ === 0) return { code: 1, stderr: 'Error: No such container: ch-thread' };
      return healthy(command, args);
    };
    await docker.exec(THREAD, 'ls');
    expect(ranStartingWith('docker run')).toHaveLength(1);
    expect(ranStartingWith('docker run').at(-1)).not.toContain('-v ');
  });
});

describe('exec', () => {
  it('runs the command through bash in /workspace, under a timeout inside the container', async () => {
    healthyDocker({ [NAME]: true });
    const result = await docker.exec(THREAD, 'ls -la');
    expect(result).toEqual({ code: 0, output: 'output\n' });
    expect(ran().at(-1)).toBe(`docker exec -w /workspace ${NAME} timeout -k 5 120 bash -lc ls -la`);
  });

  it('keeps the command as a single argument, so it cannot break out of bash -lc', async () => {
    healthyDocker({ [NAME]: true });
    await docker.exec(THREAD, `echo "a b"; rm -rf /`);
    expect(proc.calls.at(-1)?.args.at(-1)).toBe(`echo "a b"; rm -rf /`);
  });

  it('feeds input to the command and asks docker to keep stdin open', async () => {
    healthyDocker({ [NAME]: true });
    await docker.exec(THREAD, 'cat > file', { input: 'contents' });
    const last = proc.calls.at(-1);
    expect(last?.args.slice(0, 4)).toEqual(['exec', '-w', '/workspace', '-i']);
    expect(last?.input).toBe('contents');
  });

  it('creates the container first if the thread has none', async () => {
    healthyDocker();
    await docker.exec(THREAD, 'ls');
    expect(ranStartingWith('docker run')).toHaveLength(1);
  });

  it('interleaves stdout and stderr and reports a failing exit code', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'exec' ? { code: 2, stdout: 'partial\n', stderr: 'ls: no such file\n' } : healthy(command, args);
    await expect(docker.exec(THREAD, 'ls nope')).resolves.toEqual({
      code: 2,
      output: 'partial\nls: no such file\n',
    });
  });

  it('notes when the command timed out, using the chosen limit', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) => (args[0] === 'exec' ? { code: 124 } : healthy(command, args));
    const result = await docker.exec(THREAD, 'sleep 999', { timeoutSeconds: 5 });
    expect(result.output).toBe('\n[timed out after 5s]');
    expect(ran().at(-1)).toContain('timeout -k 5 5 bash');
  });

  it('truncates very long output', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) => (args[0] === 'exec' ? { stdout: 'x'.repeat(40_000) } : healthy(command, args));
    const { output } = await docker.exec(THREAD, 'yes');
    expect(output).toBe(`${'x'.repeat(30_000)}\n[output truncated]`);
  });

  it('passes the abort signal to the process', async () => {
    healthyDocker({ [NAME]: true });
    const controller = new AbortController();
    await docker.exec(THREAD, 'ls', { signal: controller.signal });
    expect(proc.calls.at(-1)?.options.signal).toBe(controller.signal);
  });
});

// A command that is only to read is kept from writing by the kernel rather
// than by what it says (see READER_UIDS in the module)
describe('exec as a reader', () => {
  const execs = () => proc.calls.filter((c) => c.args[0] === 'exec').map((c) => c.args);

  it('takes away what all may write, runs the command as a user owning nothing, then cleans up after it', async () => {
    healthyDocker({ [NAME]: true });
    await expect(docker.exec(THREAD, 'grep -rn x src', { reader: true })).resolves.toEqual({
      code: 0,
      output: 'output\n',
    });
    const [sweep, command, cleanup] = execs();
    expect(sweep.slice(0, 3)).toEqual(['exec', '--user', '0']);
    expect(sweep.at(-1)).toContain('chmod o-w');
    expect(sweep.at(-1)).toContain('/workspace /cache');
    const user = command[command.indexOf('--user') + 1];
    expect(user).toMatch(/^(\d+):\1$/);
    expect(Number(user.split(':')[0])).toBeGreaterThan(0);
    expect(command.slice(-3)).toEqual(['bash', '-lc', 'grep -rn x src']);
    expect(cleanup.slice(0, 3)).toEqual(['exec', '--user', user]);
    expect(cleanup.at(-1)).toContain('kill -9 -1');
    expect(cleanup.at(-1)).toContain(`-user ${user.split(':')[0]} -delete`);
  });

  it('gives commands side by side users of their own, so one cleanup cannot kill the other', async () => {
    healthyDocker({ [NAME]: true });
    await Promise.all([docker.exec(THREAD, 'ls', { reader: true }), docker.exec(THREAD, 'ls', { reader: true })]);
    const users = execs()
      .filter((args) => args.includes('bash'))
      .map((args) => args[args.indexOf('--user') + 1]);
    expect(new Set(users).size).toBe(2);
  });

  it('cleans up after a command that failed, or was stopped', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args.includes('bash') ? { code: 137, stderr: 'killed\n' } : healthy(command, args);
    const controller = new AbortController();
    const result = await docker.exec(THREAD, 'sleep 999', { reader: true, signal: controller.signal });
    expect(result.code).toBe(137);
    expect(execs().at(-1)?.at(-1)).toContain('kill -9 -1');
    // The signal stops the command, and not the cleanup that has to follow it
    expect(proc.calls.find((c) => c.args.includes('bash'))?.options.signal).toBe(controller.signal);
    expect(proc.calls.at(-1)?.options.signal).toBeUndefined();
  });

  it('runs nothing when the sweep did not run', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'exec' && args[2] === '0'
        ? { code: 126, stderr: 'OCI runtime exec failed\n' }
        : healthy(command, args);
    const result = await docker.exec(THREAD, 'ls', { reader: true });
    expect(result.code).toBe(126);
    expect(execs().some((args) => args.includes('bash'))).toBe(false);
  });
});

describe('a container that goes away under us', () => {
  it('looks again and runs the command once more, for exec', async () => {
    const existing = healthyDocker({ [NAME]: true });
    await docker.ensure(THREAD);
    // Removed by something else; the first exec is the one that finds out
    delete existing[NAME];
    let seen = 0;
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (args[0] === 'exec' && seen++ === 0) {
        return { code: 1, stderr: 'Error: No such container: ch-thread' };
      }
      return healthy(command, args);
    };

    const result = await docker.exec(THREAD, 'ls');
    expect(result.code).toBe(0);
    // Looked at again rather than trusted, and the container made afresh
    expect(ranStartingWith('docker inspect').length).toBeGreaterThan(1);
    expect(ranStartingWith(`docker run`)).toHaveLength(1);
  });

  it('gives up after one more try rather than going round for ever', async () => {
    healthyDocker({ [NAME]: true });
    await docker.ensure(THREAD);
    proc.respond = (command, args) => {
      if (args[0] === 'inspect') return { stdout: 'true\n' };
      return { code: 1, stderr: 'Error: No such container: ch-thread' };
    };
    await docker.exec(THREAD, 'ls');
    expect(ranStartingWith('docker exec')).toHaveLength(2);
  });
});

describe('read', () => {
  it('gives exactly what a command wrote, without creating a container to run it in', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) => (args[0] === 'exec' ? { stdout: 'raw\0bytes', code: 3 } : healthy(command, args));
    const result = await docker.read(THREAD, 'git cat-file blob abc');
    expect(result).toEqual({ code: 3, data: Buffer.from('raw\0bytes') });
    expect(ran().at(-1)).toBe(`docker exec -w /workspace ${NAME} bash -lc git cat-file blob abc`);
  });

  it('is null for a thread that has no container', async () => {
    healthyDocker();
    await expect(docker.read(THREAD, 'ls')).resolves.toBeNull();
    expect(ranStartingWith('docker run')).toEqual([]);
  });
});

describe('readEach', () => {
  // The container's side of the protocol: each command's exit code and the
  // length of what it wrote, then exactly that many bytes
  const framed = (...parts: [number, string][]) =>
    parts.map(([code, body]) => `${code} ${Buffer.byteLength(body)}\n${body}`).join('');

  const answering = (reply: string) => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) => (args[0] === 'exec' ? { stdout: reply } : healthy(command, args));
  };

  it('runs every command in a single exec and gives back what each one wrote', async () => {
    answering(framed([0, 'first'], [0, 'second'], [0, 'third']));
    const result = await docker.readEach(THREAD, ['cat a', 'cat b', 'cat c']);
    expect(result?.map((r) => r.data.toString())).toEqual(['first', 'second', 'third']);
    // One exec for the three of them, which is the whole point
    expect(ranStartingWith('docker exec')).toHaveLength(1);
  });

  it('keeps each command apart however its output is made up', async () => {
    // Newlines, NULs and something that looks like a header of its own: with
    // a delimiter rather than a length, any of these would run the replies
    // together
    answering(framed([0, 'two\nlines'], [0, 'a\0b'], [0, '0 99\nnot a header'], [1, '']));
    const result = await docker.readEach(THREAD, ['a', 'b', 'c', 'd']);
    expect(result?.map((r) => [r.code, r.data.toString()])).toEqual([
      [0, 'two\nlines'],
      [0, 'a\0b'],
      [0, '0 99\nnot a header'],
      [1, ''],
    ]);
  });

  it("reports each command's own exit code, so a file that could not be read is told apart", async () => {
    answering(framed([0, 'here'], [1, ''], [128, '']));
    const result = await docker.readEach(THREAD, ['cat a', 'cat gone', 'cat bad']);
    expect(result?.map((r) => r.code)).toEqual([0, 1, 128]);
  });

  it('leaves the rest unread rather than misaligned when the reply is cut short', async () => {
    answering(framed([0, 'first']) + '0 500\nnot that long');
    const result = await docker.readEach(THREAD, ['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(result?.[0].data.toString()).toBe('first');
    expect(result?.[2]).toEqual({ code: null, data: Buffer.alloc(0) });
  });

  it('asks the container nothing when there is nothing to read', async () => {
    healthyDocker({ [NAME]: true });
    await expect(docker.readEach(THREAD, [])).resolves.toEqual([]);
    expect(ran()).toEqual([]);
  });

  it('is null for a thread that has no container', async () => {
    healthyDocker();
    await expect(docker.readEach(THREAD, ['ls'])).resolves.toBeNull();
    expect(ranStartingWith('docker run')).toEqual([]);
  });
});

describe('remove and stopAll', () => {
  it('force-removes the thread container, bringing Docker up for it', async () => {
    healthyDocker({ [NAME]: true });
    await docker.remove(THREAD);
    // Docker is asked to come up first: the thread is on its way out of the
    // store, so a removal not made now is only made by a later sweep
    expect(ran()).toEqual(['docker info', `docker rm -f ${NAME}`]);
  });

  it("removes the workspace's shared cache with the last container that used it", async () => {
    healthyDocker({ [NAME]: true });
    docker.setWorkspace(THREAD, '/projects/demo');
    await docker.remove(THREAD);
    // Docker refuses while another thread's container still uses it, which is
    // the answer wanted
    expect(ranStartingWith('docker volume rm')).toHaveLength(1);
    expect(ran().at(-1)).toMatch(/^docker volume rm ch-cache-[0-9a-f]{12}$/);
  });

  it('writes down a container it could not remove, and removes it at the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-pending-'));
    docker.init(dir);
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'rm' ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : healthy(command, args);
    await docker.remove(THREAD);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-pending.json'), 'utf8'))).toEqual({
      containers: [NAME],
    });

    // The next session takes the list back up and makes the removal, though
    // the container is no longer in anything it can list
    vi.resetModules();
    const next = await import('../../src/sandbox/docker');
    next.init(dir);
    proc.calls = [];
    proc.respond = () => ({ code: 0 });
    await next.sweep([]);
    expect(ranStartingWith('docker rm -f')).toEqual([`docker rm -f ${NAME}`]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-pending.json'), 'utf8'))).toEqual({ containers: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps nothing and still resolves when there is nowhere to keep it', async () => {
    healthyDocker({ [NAME]: true });
    const healthy = proc.respond;
    proc.respond = (command, args) => (args[0] === 'rm' ? { code: 1, stderr: 'daemon' } : healthy(command, args));
    await expect(docker.remove(THREAD)).resolves.toBeUndefined();
  });

  it('does not fail when Docker is not installed', async () => {
    proc.respond = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    await expect(docker.remove(THREAD)).resolves.toBeUndefined();
  });

  it('stops the containers used this session, detached, and only once', async () => {
    healthyDocker();
    const other = '11111111-2222-3333-4444-555555555555';
    await docker.ensure(THREAD);
    await docker.ensure(other);
    proc.calls = [];

    docker.stopAll();
    expect(ran()).toEqual([`docker stop -t 0 ${NAME} ch-thread-${other}`]);
    expect(proc.calls[0].options).toMatchObject({ detached: true, stdio: 'ignore' });

    docker.stopAll();
    expect(proc.calls).toHaveLength(1);
  });

  it('does nothing on quit when no container was used', () => {
    docker.stopAll();
    expect(proc.calls).toEqual([]);
  });

  it('does not stop a container whose thread was deleted', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    await docker.remove(THREAD);
    proc.calls = [];
    docker.stopAll();
    expect(proc.calls).toEqual([]);
  });
});

describe('sweep', () => {
  const GONE = 'ch-thread-99999999-8888-7777-6666-555555555555';
  const WEEK = 8 * 24 * 3600 * 1000;

  // A Docker holding the given containers (name -> whether it is running),
  // volumes (name -> whether anything refers to it) and images (tag -> when it
  // was built), which records what is removed.
  function dockerWith({
    containers = {} as Record<string, boolean>,
    volumes = {} as Record<string, boolean>,
    images = {} as Record<string, number>,
    // tag -> the image it was built on, as its label says (see ensureDependencies)
    bases = {} as Record<string, string>,
    imageUsers = [] as string[],
  }) {
    const removed = { containers: [] as string[], volumes: [] as string[], images: [] as string[] };
    proc.respond = (command, args) => {
      if (command !== 'docker') return { code: 1 };
      const [one, two] = args;
      if (one === 'ps') {
        // The images every container was made from, for the image sweep
        if (args.includes('{{.Image}}')) return { stdout: `${imageUsers.join('\n')}\n` };
        const names = Object.keys(containers).filter((name) => args.includes('-a') || containers[name]);
        return { stdout: `${names.join('\n')}\n` };
      }
      if (one === 'rm') {
        const name = args.at(-1) as string;
        if (!(name in containers)) return { code: 1, stderr: 'No such container' };
        delete containers[name];
        removed.containers.push(name);
        return { code: 0 };
      }
      if (one === 'stop') {
        containers[args.at(-1) as string] = false;
        return { code: 0 };
      }
      if (one === 'volume' && two === 'ls')
        return {
          stdout: `${Object.keys(volumes)
            .filter((v) => !volumes[v])
            .join('\n')}\n`,
        };
      if (one === 'volume' && two === 'rm') {
        const name = args.at(-1) as string;
        if (volumes[name]) return { code: 1, stderr: 'volume is in use' };
        delete volumes[name];
        removed.volumes.push(name);
        return { code: 0 };
      }
      if (one === 'images') {
        const listed = [...Object.keys(images), 'node:22-bookworm-slim'].join('\n');
        return { stdout: `${listed}\n` };
      }
      if (one === 'image' && two === 'inspect') {
        const tag = args.at(-1) as string;
        if (!(tag in images)) return { code: 1, stderr: 'No such image' };
        // As Docker prints it: the fields the format asked for, in order, with
        // nothing for a label the image does not carry
        return { stdout: `${new Date(images[tag]).toISOString()} ${bases[tag] ?? ''}\n` };
      }
      if (one === 'image' && two === 'rm') {
        const tag = args.at(-1) as string;
        delete images[tag];
        removed.images.push(tag);
        return { code: 0 };
      }
      return { code: 0 };
    };
    return removed;
  }

  it('removes the containers of threads that are gone, and leaves the rest', async () => {
    const removed = dockerWith({ containers: { [NAME]: false, [GONE]: false } });
    const swept = await docker.sweep([THREAD]);
    expect(swept.removed).toEqual([GONE]);
    expect(removed.containers).toEqual([GONE]);
  });

  it('removes nothing for being unknown when the threads cannot be told', async () => {
    const removed = dockerWith({ containers: { [NAME]: false, [GONE]: true } });
    const swept = await docker.sweep();
    expect(swept.removed).toEqual([]);
    expect(removed.containers).toEqual([]);
    // What is left running is still stopped: that one does not go by which
    // threads there are, only by which containers this session started
    expect(swept.stopped).toEqual([GONE]);
  });

  it('stops the containers an earlier session left running', async () => {
    dockerWith({ containers: { [NAME]: true, [GONE]: true } });
    const swept = await docker.sweep([THREAD, GONE.replace('ch-thread-', '')]);
    expect(swept.stopped).toEqual([NAME, GONE]);
    expect(ranStartingWith('docker stop')).toEqual([`docker stop -t 0 ${NAME}`, `docker stop -t 0 ${GONE}`]);
  });

  it('leaves alone a container this session is using', async () => {
    healthyDocker();
    await docker.ensure(THREAD);
    const removed = dockerWith({ containers: { [NAME]: true } });
    // Its thread is not in the list — a thread made moments ago may not be
    // saved yet — and the container is still not touched
    const swept = await docker.sweep([]);
    expect(swept).toMatchObject({ removed: [], stopped: [] });
    expect(removed.containers).toEqual([]);
  });

  it('removes the workspace caches nothing refers to any more', async () => {
    const removed = dockerWith({ volumes: { 'ch-cache-aaaaaaaaaaaa': false, 'ch-cache-bbbbbbbbbbbb': true } });
    const swept = await docker.sweep([]);
    expect(swept.volumes).toEqual(['ch-cache-aaaaaaaaaaaa']);
    expect(removed.volumes).toEqual(['ch-cache-aaaaaaaaaaaa']);
  });

  it('removes the images it built that nothing has used for a week', async () => {
    const old = Date.now() - WEEK;
    const removed = dockerWith({
      images: {
        'ch-deps:aaaaaaaaaaaa': old,
        'ch-deps:bbbbbbbbbbbb': old,
        'ch-sandbox:cccccccccccc': old,
        'ch-deps:dddddddddddd': Date.now(),
      },
      // The ones that are staying stand on another base, so this one is
      // wanted by nothing (see the test below for when that cannot be told)
      bases: {
        'ch-deps:aaaaaaaaaaaa': 'ch-sandbox:cccccccccccc',
        'ch-deps:bbbbbbbbbbbb': 'ch-sandbox:eeeeeeeeeeee',
        'ch-deps:dddddddddddd': 'ch-sandbox:eeeeeeeeeeee',
      },
      imageUsers: ['ch-deps:bbbbbbbbbbbb'],
    });
    const swept = await docker.sweep([]);
    // The one a container was made from stays, as does the one built this
    // week; the user's own images are never looked at
    expect(swept.images).toEqual(['ch-deps:aaaaaaaaaaaa', 'ch-sandbox:cccccccccccc']);
    expect(removed.images).toEqual(['ch-deps:aaaaaaaaaaaa', 'ch-sandbox:cccccccccccc']);
  });

  it('keeps the base an image it is keeping was built on, which nothing runs', async () => {
    const old = Date.now() - WEEK;
    // Every container runs the dependencies image; the base under it has
    // nothing of its own, and is what the next lockfile change builds on
    const removed = dockerWith({
      images: { 'ch-sandbox:cccccccccccc': old, 'ch-deps:bbbbbbbbbbbb': old, 'ch-deps:aaaaaaaaaaaa': old },
      bases: { 'ch-deps:bbbbbbbbbbbb': 'ch-sandbox:cccccccccccc', 'ch-deps:aaaaaaaaaaaa': 'ch-sandbox:cccccccccccc' },
      imageUsers: ['ch-deps:bbbbbbbbbbbb'],
    });
    const swept = await docker.sweep([]);
    expect(swept.images).toEqual(['ch-deps:aaaaaaaaaaaa']);
    expect(removed.images).toEqual(['ch-deps:aaaaaaaaaaaa']);
  });

  it('removes a base once nothing built on it is left either', async () => {
    const old = Date.now() - WEEK;
    const removed = dockerWith({
      images: { 'ch-sandbox:cccccccccccc': old, 'ch-deps:aaaaaaaaaaaa': old },
      bases: { 'ch-deps:aaaaaaaaaaaa': 'ch-sandbox:cccccccccccc' },
    });
    const swept = await docker.sweep([]);
    expect(swept.images.sort()).toEqual(['ch-deps:aaaaaaaaaaaa', 'ch-sandbox:cccccccccccc']);
    expect(removed.images.sort()).toEqual(['ch-deps:aaaaaaaaaaaa', 'ch-sandbox:cccccccccccc']);
  });

  it('keeps every base while an image that cannot say what it stands on is kept', async () => {
    const old = Date.now() - WEEK;
    // The dependencies image is in use and was built before the label existed:
    // which base it needs cannot be told, so none of them is taken away
    const removed = dockerWith({
      images: { 'ch-sandbox:cccccccccccc': old, 'ch-sandbox:dddddddddddd': old, 'ch-deps:bbbbbbbbbbbb': old },
      imageUsers: ['ch-deps:bbbbbbbbbbbb'],
    });
    expect((await docker.sweep([])).images).toEqual([]);
    expect(removed.images).toEqual([]);
  });

  it('removes no image when it cannot tell which are in use', async () => {
    dockerWith({ images: { 'ch-deps:aaaaaaaaaaaa': Date.now() - WEEK } });
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'ps' && args.includes('{{.Image}}') ? { code: 1, stderr: 'daemon' } : healthy(command, args);
    expect((await docker.sweep([])).images).toEqual([]);
  });

  it('keeps the image it has just built, whatever its age says', async () => {
    healthyDocker();
    const built = (await docker.ensure(THREAD)) && (ranStartingWith('docker run').at(-1) as string).split(' ').at(-3);
    const removed = dockerWith({ images: { [built as string]: Date.now() - WEEK } });
    await docker.sweep([THREAD]);
    expect(removed.images).toEqual([]);
  });

  it('does nothing, and does not start Docker, when the daemon is down', async () => {
    proc.respond = () => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' });
    const swept = await docker.sweep([]);
    expect(swept).toEqual({ removed: [], stopped: [], volumes: [], images: [] });
    expect(ran()).toEqual([`docker ps -a --filter name=ch-thread- --format {{.Names}}`]);
  });

  it('does nothing when Docker is not installed', async () => {
    proc.respond = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    await expect(docker.sweep([])).resolves.toEqual({ removed: [], stopped: [], volumes: [], images: [] });
  });
});

describe('the build cache', () => {
  it('is pruned after an image is built, in the background and only to what is unused', async () => {
    const existing = healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) =>
      args[0] === 'image' ? { code: 1, stderr: 'No such image' } : healthy(command, args);
    delete existing[NAME];
    await docker.ensure(THREAD);
    // Waited for here only because nothing else does: the build does not
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ranStartingWith('docker builder prune')).toEqual(['docker builder prune -f --filter until=168h']);
  });

  it('is left alone when the build failed', async () => {
    const existing = healthyDocker();
    const healthy = proc.respond;
    proc.respond = (command, args) => {
      if (args[0] === 'image') return { code: 1, stderr: 'No such image' };
      if (args[0] === 'build') return { code: 1, stderr: 'network unreachable' };
      return healthy(command, args);
    };
    delete existing[NAME];
    await docker.ensure(THREAD);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ranStartingWith('docker builder prune')).toEqual([]);
  });
});
