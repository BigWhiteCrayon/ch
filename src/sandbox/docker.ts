// One Docker container per thread, so every thread has its own filesystem.
//
// A container is created the first time a thread needs it and is kept (only
// stopped) when the app quits, so its files persist. It is removed when the
// thread is deleted.
//
// A thread started in a workspace gets a copy of that workspace in its container.
// The copy is made once, when the container is created. What the files were
// then is recorded (see BASELINE), so that what the thread has changed since
// can be told and, when the user asks, written back to the workspace (see
// changes.ts). Nothing is written back otherwise.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as log from '../log';
import { toolEnv } from './env';

// What a workspace is worked on in, when the user has not said. A container
// with no toolchain cannot run a project's tests, and which toolchain it wants
// is written on the workspace: the files below say so plainly enough that
// guessing beats asking. The user can still say (see ../settings.ts).
//
// Each is a slim official image. They are pulled on first use, so a guess that
// is wrong for a workspace costs a download, not a broken thread: the user
// overrides it and the next container is built from what they chose.
const TOOLCHAINS: { file: RegExp; image: string }[] = [
  { file: /^package\.json$/, image: 'node:22-bookworm-slim' },
  { file: /^(pyproject\.toml|requirements\.txt|Pipfile|setup\.py)$/, image: 'python:3.12-slim-bookworm' },
  { file: /^go\.mod$/, image: 'golang:1-bookworm' },
  { file: /^Cargo\.toml$/, image: 'rust:1-slim-bookworm' },
  { file: /^(pom\.xml|build\.gradle(\.kts)?)$/, image: 'eclipse-temurin:21-jdk-noble' },
  { file: /^Gemfile$/, image: 'ruby:3-slim-bookworm' },
];
// A workspace none of them matches, and a thread with no workspace at all
export const PLAIN_IMAGE = 'debian:bookworm-slim';

// The image a workspace's threads are built from: what the user chose, or the
// toolchain its files ask for. '' from the settings means "guess".
export function baseImage(workspace: string | undefined, chosen = ''): string {
  if (chosen.trim()) return chosen.trim();
  if (!workspace) return PLAIN_IMAGE;
  let names: string[] = [];
  try {
    names = fs.readdirSync(workspace);
  } catch {
    return PLAIN_IMAGE;
  }
  // In the order above, so a Node project with a stray requirements.txt is
  // still a Node project
  for (const { file, image } of TOOLCHAINS) if (names.some((name) => file.test(name))) return image;
  return PLAIN_IMAGE;
}

// Git goes on top of whatever the base is: it is what records and compares a
// thread's files (see BASELINE), and no official toolchain image is sure to
// have it. The cache directories are made here too, so a container can write
// to them whatever user it runs as.
//
// ripgrep goes on for the searches that look for text rather than for meaning,
// which are answered from this copy of the files so that they see what the
// thread has done to them (see ../search/ripgrep.ts). It is asked for in a
// layer of its own: the layer above installs nothing when the base image
// already carries git, and ripgrep would be skipped along with it.
//
// Chromium goes on, with a font, for the screenshot tool (see ../tools/sandbox.ts),
// which draws a page with it (headless URL shots need no display; steps and command
// shots run under Xvfb). Only on Debian, where the package is a browser: on Ubuntu it
// is a stub that wants snap, and Alpine has no apt. It is the one layer that may fail
// without the image being any the worse (a base with no such package), so the build
// goes on without it, and the tool says so when it is asked for. The same install is
// BROWSER_INSTALL, for a container made before the layer was added (see the screenshot
// tool).
//
// Xvfb, xauth and ImageMagick go on with it, for the screenshot tool's command
// mode: a desktop app (Electron, say) is run on a virtual display and the screen
// is captured with import. xauth is named because nothing recommended comes with it.
//
// A screen and an encoder go on last, for the record tool, which needs a real
// window to film and something to encode it with. They are a great deal more
// than the browser — a couple of hundred packages — and most threads never
// record anything, so putting them here is a trade: every image carries them,
// and no thread pays for them. The other way round, installed into a container
// on first use, the cost came back on every new thread that recorded, since
// what a container installs stays in that container and is never in the image.
// On the same terms as the browser: Debian only, and the build goes on without
// them where that fails.
export const BROWSER_INSTALL =
  '(. /etc/os-release && [ "$ID" = debian ] && apt-get update' +
  ' && apt-get install -y --no-install-recommends chromium fonts-liberation xvfb xauth imagemagick' +
  ' && rm -rf /var/lib/apt/lists/*)';

// What the record tool needs on top of the browser: a screen for a real
// window to be drawn on (Xvfb) and something to encode what is on it
// (ffmpeg). See the record tool in ../tools/sandbox.ts.
//
// This is the same install as the layer below, for a container made before
// that layer was added, exactly as BROWSER_INSTALL is for the browser. A
// container is built from the image it was made from and keeps it, so a thread
// older than the layer would otherwise never be able to record.
export const RECORDER_INSTALL =
  '(. /etc/os-release && [ "$ID" = debian ] && apt-get update' +
  ' && apt-get install -y --no-install-recommends xvfb ffmpeg && rm -rf /var/lib/apt/lists/*)';

const dockerfile = (base: string) => `FROM ${base}
RUN (command -v git >/dev/null || (apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*)) && mkdir -p ${CACHE_DIR} && chmod 777 ${CACHE_DIR}
RUN command -v rg >/dev/null || (apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*)
RUN (. /etc/os-release && [ "$ID" = debian ] && ! command -v chromium >/dev/null \
  && apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation xvfb xauth imagemagick \
  && rm -rf /var/lib/apt/lists/*) || true
RUN (. /etc/os-release && [ "$ID" = debian ] \
  && ! (command -v Xvfb >/dev/null && command -v ffmpeg >/dev/null) \
  && apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg \
  && rm -rf /var/lib/apt/lists/*) || true
`;

// Where the workspace's shared package caches are mounted (see cacheVolume)
const CACHE_DIR = '/cache';
// Git as run in a container for the app's own purposes: on a repository of
// its own, kept outside the working directory, that tracks the files there.
// It is apart from any repository in the files themselves, which is the
// model's to use, and it leaves out what the project's .gitignore leaves out.
// Where that repository lives. Outside the working directory, so that what
// the app keeps about a thread is no part of the project, is not the model's
// to edit, and is not taken away by putting the files back (see revert).
export const BASELINE_DIR = '/var/lib/ch-baseline.git';
export const BASELINE = [
  `git --git-dir=${BASELINE_DIR} --work-tree=/workspace`,
  '-c safe.directory=*',
  '-c user.name=ch -c user.email=ch@localhost',
  '-c core.quotepath=off',
].join(' ');
export const WORKDIR = '/workspace';
// A value as a single shell argument, for the commands run inside a container
export const quote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;
// Where a thread keeps what is its own rather than the project's: its context
// note, and anything else it writes for itself. It sits inside the working
// directory so the thread can read and write it with its ordinary tools, but
// it is no part of the project and is never written back to the user's workspace
// (see changes.ts).
export const AGENT_DIR = '.agent';
const MAX_OUTPUT = 30000; // characters of command output kept

// The container's budget of processes and threads, shared by everything running
// in it. The cgroup counts threads, not just processes, and a browser runs to
// well over a hundred tasks on its own: 512 left a screenshot and a test suite
// in one container to fight over the budget, and the loser got EAGAIN out of
// pthread_create, which takes Chromium's zygote down with it. Still a bound on
// a runaway fork, which is what this is for (see CAPTURES_AT_ONCE in ./lock.ts,
// which is what keeps the browsers themselves from filling it).
export const PIDS_LIMIT = 1024;

export function containerName(threadId: string | undefined): string {
  if (!/^[0-9a-f-]{36}$/.test(threadId ?? '')) throw new Error('This message has no thread.');
  return `ch-thread-${threadId}`;
}

// Containers started this session, stopped again on quit
const running = new Set<string>();
// Threads whose container is being prepared right now, and whether that
// attempt is allowed to create one: a caller that needs a container cannot
// take "there isn't one" from an attempt that was told not to make it (see
// ensure)
const preparing = new Map<string, { pending: Promise<boolean>; create: boolean }>();
// threadId -> the workspace to copy into its container when that is created
const workspaces = new Map<string, string>();

// The base image the user asked for, '' to let the workspace decide
let chosenImage = '';

export function configure(image = ''): void {
  chosenImage = image;
}

export function setWorkspace(threadId: string, workspace: string): void {
  workspaces.set(threadId, workspace);
}

// Moves a thread that was started without a workspace into a new, empty one. A container made after this is made in
// the ordinary way, with the workspace copied in and recorded. One that already exists has files the thread made
// itself, and no record of what the workspace held: the record made here is of a workspace with nothing in it, so
// everything the thread has written shows as a change and goes to the workspace when the user applies them.
export async function adopt(threadId: string, workspace: string): Promise<void> {
  setWorkspace(threadId, workspace);
  const name = await ensure(threadId, { create: false });
  if (!name) return;
  const recorded = await docker(
    [
      'exec',
      '-w',
      WORKDIR,
      name,
      'bash',
      '-lc',
      `${BASELINE} init -q && ${BASELINE} commit -q --allow-empty -m baseline`,
    ],
    { timeout: 300000 }
  );
  if (recorded.code !== 0) {
    workspaces.delete(threadId);
    throw new Error(`Could not set up the thread's changes: ${recorded.output.trim().slice(-500)}`);
  }
}

export interface RunResult {
  code: number | null;
  output: string;
}

interface RunOptions {
  // Bytes where what is being written is a file, which may not be text
  input?: string | Buffer;
  signal?: AbortSignal;
  timeout?: number;
}

// Runs a command. Resolves with { code, output } where output is stdout and
// stderr interleaved; rejects only if the command itself can't be run.
function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, signal, timeout } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, timeout, env: toolEnv() });
    let output = '';
    const collect = (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT) output += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') err.message = `The "${command}" command was not found.`;
      reject(err);
    });
    child.on('close', (code) => {
      if (output.length >= MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[output truncated]`;
      resolve({ code, output });
    });
    child.stdin.on('error', () => {}); // the process may exit before reading its input
    child.stdin.end(input);
  });
}

async function docker(args: string[], options?: RunOptions): Promise<RunResult> {
  try {
    return await run('docker', args, options);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Said to the user, in a thread whose tool call has just failed, so it
      // points at the flow that installs it rather than at a command they
      // would have to find a terminal for (see setup/install.ts)
      throw new Error('Docker is not installed. Settings has a setup flow that installs it; try again after that.');
    }
    throw err;
  }
}

// Starts the Docker daemon if it isn't running. The setup flow sets up Colima
// on macOS (see scripts/install-docker.ts), which doesn't start by itself
// after a reboot — which is why the flow asks to be opened again when it
// finds a Docker that is installed and down (see wanted in setup/checks.ts).
async function startDaemon(): Promise<void> {
  if ((await docker(['info'])).code === 0) return;
  const started = await run('colima', ['start'], { timeout: 300000 }).catch(() => null);
  if (started?.code !== 0) {
    throw new Error('Docker is installed but not running. Start it, or use the setup flow in Settings, and try again.');
  }
}

// Checked once per session, and again after a failure
let daemon: Promise<void> | null = null;

function ensureDaemon(): Promise<void> {
  daemon ??= startDaemon().catch((err) => {
    daemon = null;
    throw err;
  });
  return daemon;
}

// The image a new container is made from: the chosen base with Git on top if
// it exists or can be built, else the base alone, in which case the thread's
// changes can't be told (and so can't be written back).
//
// One per base image, since a workspace's toolchain decides its base: the tag
// carries a digest of the Dockerfile, so changing the base or the layer builds
// a new image rather than using a stale one of the same name.
const images = new Map<string, Promise<string>>();

const tagFor = (file: string) => `ch-sandbox:${crypto.createHash('sha256').update(file).digest('hex').slice(0, 12)}`;

function ensureImage(base: string): Promise<string> {
  const file = dockerfile(base);
  const tag = tagFor(file);
  let building = images.get(tag);
  if (!building) {
    building = (async () => {
      if ((await docker(['image', 'inspect', tag])).code === 0) return tag;
      const started = performance.now();
      // Downloads the base image and Git's packages, which can take a while
      const built = await docker(['build', '-t', tag, '-'], { input: file, timeout: 600000 }).catch((err: Error) => ({
        code: 1,
        output: err.message,
      }));
      if (built.code === 0) {
        log.info('sandbox.image', { ok: true, base, tag, ms: log.since(started) });
        return tag;
      }
      log.warn('sandbox.image', { ok: false, base, ms: log.since(started), error: built.output.trim().slice(-500) });
      // Tried again for the next container
      images.delete(tag);
      return base;
    })();
    images.set(tag, building);
  }
  return building;
}

// How a workspace's dependencies are installed, from the files that say what
// they are. Every file named has to be there, and a Node project needs its
// lockfile: without one the install is not the same twice, and a digest of
// package.json alone would not notice that it had changed. A project none of
// these fits is left to install its own, as before. In the order tried, so
// the first that fits is the one used.
const INSTALLS: { files: string[]; command: string }[] = [
  { files: ['package.json', 'package-lock.json'], command: 'npm ci --no-audit --no-fund --ignore-scripts' },
  { files: ['package.json', 'npm-shrinkwrap.json'], command: 'npm ci --no-audit --no-fund --ignore-scripts' },
  { files: ['package.json', 'yarn.lock'], command: 'yarn install --frozen-lockfile' },
  { files: ['package.json', 'pnpm-lock.yaml'], command: 'corepack enable && pnpm install --frozen-lockfile' },
  { files: ['requirements.txt'], command: 'pip install --no-cache-dir -r requirements.txt' },
];

// The image with a workspace's dependencies already installed in /workspace,
// on top of the sandbox image. copyWorkspace unpacks the project's files over
// them without touching what .gitignore leaves out, so a new thread starts
// with its dependencies where the project expects them instead of installing
// them itself.
//
// The Dockerfile's context holds only the manifests, and the tag carries a
// digest of them and of the image under it, so a changed lockfile builds a
// new image and an unchanged one is reused by every thread, in this session
// and the next. The first thread to need one waits for the install.
//
// The context holds only the manifests, so npm runs with --ignore-scripts: a
// project's postinstall (one that runs tsc, say) fails there with nothing to
// build. The tradeoff is that packages needing a postinstall step (native
// builds, binary downloads) are not prepared in the image. yarn and pnpm are
// unchanged and may fail the same way if a project has a postinstall.
//
// Dependencies that cannot be installed this way (a private registry, a
// manifest that wants other files of the project) leave the image as it was.
// That is remembered for the session, since trying again for every thread
// would cost an install each time for the same answer; a changed manifest is
// a new tag and is tried.
const dependencyImages = new Map<string, Promise<string>>();

function ensureDependencies(image: string, workspace: string | undefined): Promise<string> {
  const install = workspace && INSTALLS.find(({ files }) => files.every((f) => fs.existsSync(path.join(workspace, f))));
  if (!workspace || !install) return Promise.resolve(image);
  let contents: Buffer[];
  try {
    contents = install.files.map((file) => fs.readFileSync(path.join(workspace, file)));
  } catch {
    return Promise.resolve(image);
  }
  // The package managers' downloads go where the layer does not keep them
  const file = `FROM ${image}
WORKDIR ${WORKDIR}
COPY ${install.files.join(' ')} ${WORKDIR}/
RUN export NPM_CONFIG_CACHE=/tmp/dl YARN_CACHE_FOLDER=/tmp/dl PIP_CACHE_DIR=/tmp/dl \
  && ${install.command} && rm -rf /tmp/dl
`;
  const digest = crypto.createHash('sha256').update(file);
  for (const data of contents) digest.update(data);
  const tag = `ch-deps:${digest.digest('hex').slice(0, 12)}`;
  let building = dependencyImages.get(tag);
  if (!building) {
    building = (async () => {
      if ((await docker(['image', 'inspect', tag])).code === 0) return tag;
      const started = performance.now();
      const context = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-deps-'));
      try {
        install.files.forEach((name, i) => fs.writeFileSync(path.join(context, name), contents[i]));
        const built = await docker(['build', '-t', tag, '-f', '-', context], { input: file, timeout: 1800000 }).catch(
          (err: Error) => ({ code: 1, output: err.message })
        );
        if (built.code === 0) {
          log.info('sandbox.dependencies', { ok: true, tag, command: install.command, ms: log.since(started) });
          return tag;
        }
        log.warn('sandbox.dependencies', {
          ok: false,
          command: install.command,
          ms: log.since(started),
          error: built.output.trim().slice(-500),
        });
        return image;
      } finally {
        fs.rmSync(context, { recursive: true, force: true });
      }
    })();
    dependencyImages.set(tag, building);
  }
  return building;
}

// Records the files as they are now, to compare against later
async function recordBaseline(name: string): Promise<void> {
  const command = `${BASELINE} init -q && ${BASELINE} add -A && ${BASELINE} commit -q --allow-empty -m baseline`;
  const recorded = await docker(['exec', '-w', WORKDIR, name, 'bash', '-lc', command], { timeout: 300000 }).catch(
    (err: Error) => ({ code: 1, output: err.message })
  );
  if (recorded.code !== 0)
    log.warn('sandbox.baseline', { ok: false, container: name, error: recorded.output.trim().slice(-500) });
}

interface Container {
  state: 'missing' | 'running' | 'stopped';
  // The budget the container was made with; 0 or less is no limit at all, and
  // 0 when there is no container to ask about
  pidsLimit: number;
}

async function state(name: string): Promise<Container> {
  // Both answers come out of the one inspect: asking Docker a second time
  // costs as much as a third of the command that follows (see prepare)
  const { code, output } = await docker(['inspect', '-f', '{{.State.Running}} {{.HostConfig.PidsLimit}}', name]);
  if (code !== 0) return { state: 'missing', pidsLimit: 0 };
  const [isRunning, limit] = output.trim().split(/\s+/);
  return { state: isRunning === 'true' ? 'running' : 'stopped', pidsLimit: Number(limit) || 0 };
}

// Brings a container made before PIDS_LIMIT was last raised up to it. Docker
// keeps the budget a container was created with: `start` does not take it
// again, so a container left over from an earlier run of the app would carry
// its old one for as long as it exists, and the browsers in it would go on
// running out of tasks. No limit at all is left as it is, and a raise that
// fails is only logged: the container still works, with less room in it than
// it should have.
async function raisePidsLimit(name: string, current: number): Promise<void> {
  if (current <= 0 || current >= PIDS_LIMIT) return;
  const { code, output } = await docker(['update', '--pids-limit', String(PIDS_LIMIT), name]);
  const raised = code === 0;
  log[raised ? 'info' : 'warn']('sandbox.pids', {
    container: name,
    from: current,
    to: PIDS_LIMIT,
    ok: raised,
    ...(raised ? {} : { error: output.trim().slice(-500) }),
  });
}

// Copies the workspace's contents into the new container's working directory.
// A container that didn't get its files is removed, so the next attempt
// starts over instead of carrying on without them.
// The cache every thread in a workspace shares: one Docker volume, mounted at
// CACHE_DIR, holding what the package managers download. Each thread keeps its
// own installed dependencies — those are its files, and two threads must not
// write each other's — but the downloads behind them are the same every time
// and are fetched once for the workspace rather than once per thread.
//
// Threads do not wait on one another for it: a package manager's cache is
// made to be read and written by several at a time, and the second thread's
// install simply finds what the first one fetched.
const cacheVolume = (workspace: string) =>
  `ch-cache-${crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`;

// Where each package manager is told to put its downloads, so they all land in
// the shared volume. Harmless for a toolchain that is not there.
const CACHE_ENV = [
  `NPM_CONFIG_CACHE=${CACHE_DIR}/npm`,
  `YARN_CACHE_FOLDER=${CACHE_DIR}/yarn`,
  `PIP_CACHE_DIR=${CACHE_DIR}/pip`,
  `UV_CACHE_DIR=${CACHE_DIR}/uv`,
  `GOMODCACHE=${CACHE_DIR}/go/mod`,
  `GOCACHE=${CACHE_DIR}/go/build`,
  `CARGO_HOME=${CACHE_DIR}/cargo`,
  `GRADLE_USER_HOME=${CACHE_DIR}/gradle`,
  `BUNDLE_PATH=${CACHE_DIR}/bundle`,
];

// The files a workspace's copy is made of: what Git would track or report as
// untracked, so what .gitignore leaves out is left out. That is node_modules,
// build output and caches — the bulk of a workspace, none of it the project,
// and all of it built for the machine the user is on rather than for a Linux
// container. A workspace that is not a repository has every file copied.
export async function filesToCopy(workspace: string): Promise<string[] | null> {
  const listed = await run('git', ['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) return null;
  const named = [...new Set(listed.output.split('\0').filter(Boolean))];
  // Git lists what the index holds, which includes a file deleted from the
  // working tree but not yet committed as deleted. tar fails on one of those
  // and gives up on the whole archive, so they are dropped here. A name with
  // a newline in it cannot be given to tar this way either; there is never one
  // in practice.
  return named.filter((file) => !file.includes('\n') && fs.existsSync(path.join(workspace, file)));
}

// Everything in the workspace, which is what there is to do for one that is
// not a Git repository
const copyAll = (name: string, workspace: string) =>
  docker(['cp', `${workspace}${path.sep}.`, `${name}:${WORKDIR}`], { timeout: 300000 }).catch((err: Error) => ({
    code: 1,
    output: err.message,
  }));

// Only the files named, as a tar streamed into the container. `docker cp`
// cannot leave anything out, so the archive is made on this side and unpacked
// on the other.
const copyListed = (name: string, workspace: string, files: string[]) =>
  run('sh', ['-c', 'tar -cf - -C "$1" -T - | docker exec -i "$2" tar -xf - -C "$3"', 'sh', workspace, name, WORKDIR], {
    input: `${files.join('\n')}\n`,
    timeout: 300000,
  }).catch((err: Error) => ({ code: 1, output: err.message }));

async function copyWorkspace(name: string, workspace: string): Promise<void> {
  const started = performance.now();
  const listed = await filesToCopy(workspace);
  let copied = listed ? await copyListed(name, workspace, listed) : await copyAll(name, workspace);
  const streamed = Boolean(listed) && copied.code === 0;
  // The pipeline needs tar in the container, which every image used here has,
  // but a thread with its files beats a thread without them
  if (listed && copied.code !== 0) copied = await copyAll(name, workspace);
  log.info('sandbox.copy', {
    workspace,
    ms: log.since(started),
    files: listed?.length,
    how: streamed ? 'tracked' : 'everything',
    ok: copied.code === 0,
  });
  if (copied.code === 0) return;
  await docker(['rm', '-f', name]).catch(() => {});
  throw new Error(`Could not copy ${workspace} into the thread's container: ${copied.output.trim()}`);
}

async function prepare(name: string, create: boolean, workspace?: string): Promise<boolean> {
  // A container this session started is already known to be running, and
  // asking Docker again costs as much as a third of the command that follows.
  // The answer is only trusted while it holds: a container that goes away
  // under us is noticed by the command that fails and looked at again then
  // (see gone and withContainer).
  if (running.has(name)) return true;
  // Only bring Docker up when a container is really needed, not just to look
  if (create) await ensureDaemon();
  const current = await state(name);
  if (current.state === 'missing') {
    if (!create) return false;
    // The first run also downloads the image, which can take a while
    const { code, output } = await docker(
      [
        'run',
        '-d',
        '--init',
        '--name',
        name,
        '-w',
        WORKDIR,
        '--pids-limit',
        String(PIDS_LIMIT),
        // Every thread in a workspace shares what its package managers
        // download, and keeps its own installed dependencies
        ...(workspace ? ['-v', `${cacheVolume(workspace)}:${CACHE_DIR}`] : []),
        ...CACHE_ENV.flatMap((pair) => ['-e', pair]),
        await ensureDependencies(await ensureImage(baseImage(workspace, chosenImage)), workspace),
        'sleep',
        'infinity',
      ],
      { timeout: 300000 }
    );
    if (code !== 0) throw new Error(`Could not create the thread's container: ${output.trim()}`);
    if (workspace) {
      await copyWorkspace(name, workspace);
      await recordBaseline(name);
    }
  } else {
    // The container is from an earlier run of the app, and may have been made
    // with a smaller budget than the browsers in it now expect. Raised before
    // it starts, so it is right from the container's first moment.
    await raisePidsLimit(name, current.pidsLimit);
    if (current.state === 'stopped') {
      const { code, output } = await docker(['start', name]);
      if (code !== 0) throw new Error(`Could not start the thread's container: ${output.trim()}`);
    }
  }
  running.add(name);
  return true;
}

// Whether a command failed because the container is not there any more: it
// was removed, or Docker was restarted, since this session started it.
// Whether what Docker said means the container is not there any more: it was
// removed, or Docker was restarted, since this session started it
const VANISHED = /no such container|is not running|cannot be found/i;

// What a command run in a container says when there is no container to run it
// in and one could not be made
export const NO_CONTAINER =
  "This thread's container is not available, so nothing could be run in it. Docker may not be running.";

// Runs something against the thread's container, and once more if the
// container turns out to have gone away since it was started: what prepare()
// took on trust is given up and worked out again. Resolves with null when
// there is no container and none is to be made.
async function withContainer<T>(
  threadId: string | undefined,
  create: boolean,
  attempt: (name: string) => Promise<T>,
  vanished: (result: T) => boolean
): Promise<T | null> {
  for (const again of [false, true]) {
    const name = await ensure(threadId, { create });
    if (!name) return null;
    const result = await attempt(name);
    if (again || !vanished(result)) return result;
    // Worked out from scratch next time round, and the command tried again
    running.delete(name);
    log.debug('sandbox.vanished', { thread: threadId });
  }
  return null;
}

// Makes sure the thread's container is running and returns its name, or null
// if it doesn't exist and create is false.
export async function ensure(
  threadId: string | undefined,
  { create = true }: { create?: boolean } = {}
): Promise<string | null> {
  const name = containerName(threadId);
  const already = preparing.get(name);
  // One attempt at a time per container, and the one under way is waited for
  // rather than a second started beside it. It answers for this caller as
  // long as it was allowed to do at least as much: a caller that may not
  // create one is answered by any attempt, and one that needs a container is
  // answered by an attempt that was allowed to make it.
  //
  // Where it was not — a thread's first read arriving a moment before its
  // first command, say — the "no container" it ends with is not an answer to
  // this caller, and taking it as one left read_file reading from a container
  // nobody had made yet. So that attempt is waited for all the same, and
  // another follows it to create what it found missing.
  let pending = already && (already.create || !create) ? already.pending : undefined;
  if (!pending) {
    const started = performance.now();
    const after = already?.pending.catch(() => false) ?? Promise.resolve(false);
    pending = after
      .then((exists) => exists || prepare(name, create, workspaces.get(threadId ?? '')))
      .finally(() => {
        if (preparing.get(name)?.pending === pending) preparing.delete(name);
      });
    preparing.set(name, { pending, create });
    // Creating a container (and, the first time, downloading its image) is
    // what makes a thread's first tool call slow
    const logged = { thread: threadId, create };
    pending.then(
      (exists) => log.debug('sandbox.prepare', { ...logged, ok: true, exists, ms: log.since(started) }),
      (err) =>
        log.warn('sandbox.prepare', { ...logged, ok: false, ms: log.since(started), error: (err as Error).message })
    );
  }
  return (await pending) ? name : null;
}

export interface ExecOptions {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutSeconds?: number;
}

// Runs a shell command in the thread's container, in /workspace.
export async function exec(
  threadId: string | undefined,
  command: string,
  { input, signal, timeoutSeconds = 120 }: ExecOptions = {}
): Promise<RunResult> {
  const result = await withContainer(
    threadId,
    true,
    (name) => {
      const args = ['exec', '-w', WORKDIR];
      if (input !== undefined) args.push('-i');
      // `timeout` runs inside the container so the command itself gets killed
      args.push(name, 'timeout', '-k', '5', String(timeoutSeconds), 'bash', '-lc', command);
      return docker(args, { input, signal });
    },
    (attempt) => attempt.code !== 0 && VANISHED.test(attempt.output)
  );
  // No container, though this asked for one to be made. Nothing reaches this
  // now — ensure answers with nothing only where it was told not to create
  // one, and prepare makes one or throws — and it is here because the null
  // used to be cast away as though a command had run: it reached the model as
  // "Cannot read properties of null (reading 'code')" from a read_file that
  // had joined a look rather than a creation (see ensure). Said as a command
  // that failed, which is what every caller here already handles.
  if (!result) return { code: null, output: NO_CONTAINER };
  if (result.code === 124) result.output += `\n[timed out after ${timeoutSeconds}s]`;
  return result;
}

// Runs a shell command in the thread's container and resolves with exactly
// what it wrote to stdout, however long and whether or not it is text.
// Resolves with null if the thread has no container; never creates one.
export async function read(
  threadId: string | undefined,
  command: string
): Promise<{ code: number | null; data: Buffer } | null> {
  const result = await withContainer(
    threadId,
    false,
    (name) =>
      new Promise<{ code: number | null; data: Buffer; failed: string }>((resolve, reject) => {
        const child = spawn('docker', ['exec', '-w', WORKDIR, name, 'bash', '-lc', command], {
          env: toolEnv(),
          timeout: 120000,
          // Docker's own complaints come on stderr, and are kept only to tell
          // a container that has gone away from a command that merely failed
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let failed = '';
        child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => {
          if (failed.length < 400) failed += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, data: Buffer.concat(chunks), failed }));
      }),
    (attempt) => attempt.code !== 0 && VANISHED.test(attempt.failed)
  );
  return result && { code: result.code, data: result.data };
}

// Runs several read-only commands in the thread's container in one go, and
// resolves with what each of them wrote, in the order they were given.
// Resolves with null if the thread has no container; never creates one.
//
// One `docker exec` costs around 40ms on top of whatever it runs, and asking
// Docker whether the container is up costs another 15, so reading a hundred
// files one command at a time spent some five seconds doing nothing else (see
// the loops in changes.ts and ../search/embeddings.ts, which this is for).
// Here they go in a single exec and cost that once.
//
// Each command's output is written to a file in the container first and then
// sent with its length in front, so that output of any length, text or not,
// comes back whole and cannot be confused with the next command's: there is
// no delimiter for a file's contents to be mistaken for.
export async function readEach(
  threadId: string | undefined,
  commands: string[]
): Promise<{ code: number | null; data: Buffer }[] | null> {
  if (commands.length === 0) return [];
  const script = [
    'ch_d=$(mktemp -d) || exit 1',
    'ch_i=0',
    `for ch_c in ${commands.map(quote).join(' ')}; do`,
    '  ch_i=$((ch_i+1))',
    '  eval "$ch_c" > "$ch_d/$ch_i" 2>/dev/null',
    '  ch_code=$?',
    `  printf '%s %s\n' "$ch_code" "$(wc -c < "$ch_d/$ch_i")"`,
    '  cat "$ch_d/$ch_i"',
    'done',
    'rm -rf "$ch_d"',
  ].join('\n');

  const result = await read(threadId, script);
  if (!result) return null;
  const out: { code: number | null; data: Buffer }[] = [];
  let at = 0;
  for (let n = 0; n < commands.length; n++) {
    const header = result.data.indexOf(0x0a, at);
    if (header === -1) break;
    const [code, size] = result.data.subarray(at, header).toString('utf8').trim().split(/\s+/);
    const length = Number(size);
    if (!Number.isInteger(length) || length < 0) break;
    at = header + 1;
    out.push({ code: Number(code), data: result.data.subarray(at, at + length) });
    at += length;
  }
  // A reply that was cut short leaves the rest unread rather than misaligned
  while (out.length < commands.length) out.push({ code: null, data: Buffer.alloc(0) });
  return out;
}

export async function remove(threadId: string): Promise<void> {
  const name = containerName(threadId);
  running.delete(name);
  workspaces.delete(threadId);
  await docker(['rm', '-f', name]).catch(() => {});
}

// Stops this session's containers without waiting; their files are kept.
export function stopAll(): void {
  if (running.size === 0) return;
  const child = spawn('docker', ['stop', '-t', '0', ...running], {
    detached: true,
    stdio: 'ignore',
    env: toolEnv(),
  });
  child.on('error', () => {});
  child.unref();
  running.clear();
}
