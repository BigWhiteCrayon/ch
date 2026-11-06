import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';
import type { Tool } from '../../src/types';

const docker = vi.hoisted(() => ({
  WORKDIR: '/workspace',
  AGENT_DIR: '.agent',
  BASELINE: 'GIT',
  BASELINE_DIR: '/var/lib/ch-baseline.git',
  quote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
  configure: vi.fn(),
  ensure: vi.fn(),
  exec: vi.fn(),
  read: vi.fn(),
  readEach: vi.fn(),
  BROWSER_INSTALL: 'install-browser',
  RECORDER_INSTALL: 'install-recorder',
  ELECTRON_INSTALL: 'install-electron',
  setWorkspace: vi.fn(),
  remove: vi.fn(),
  stopAll: vi.fn(),
  init: vi.fn(),
  sweep: vi.fn(),
}));
vi.mock('../../src/sandbox/docker', () => docker);

import {
  CONTEXT_FILE,
  PROMPT,
  contextFile,
  keepFindings,
  restoreContext,
  workspacePrompt,
  readContext,
  recipes,
} from '../../src/sandbox';
import {
  NO_BROWSER,
  NO_DISPLAY,
  NO_NODE,
  NO_RECORDER,
  pageFor,
  registerTools,
  tools,
  withCaptureSlot,
  withFileLock,
} from '../../src/tools/sandbox';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
const signal = new AbortController().signal;
const context = { signal, threadId: THREAD };
const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
const lastExec = () => docker.exec.mock.calls.at(-1) as [string, string, Record<string, unknown>];

beforeEach(() => {
  docker.ensure.mockReset();
  docker.exec.mockReset();
  docker.exec.mockResolvedValue({ code: 0, output: '' });
  docker.read.mockReset();
  docker.readEach.mockReset();
});

describe('the workspace prompt', () => {
  it('names the workspace and directs the model to work from its files', () => {
    const prompt = unwrapped(workspacePrompt('/projects/demo', 'itself'));
    expect(prompt).toContain('the workspace /projects/demo');
    expect(prompt).toContain('your working directory holds a copy of it');
    expect(prompt).toContain('Treat what the user asks as being about those files');
    expect(prompt).toContain('find what you need in them');
    // The path is named for the user's sake: a model that took it for somewhere to read read the original, which
    // does not have the thread's changes
    expect(prompt).toContain("is the user's original, which is not read from here");
    expect(prompt).toContain('Say which files you changed');
    // What it could not check is said rather than left to be taken as checked.
    // The paragraph that used to stand here, telling every step to read again
    // every line it was about to name, is gone: it reached the doing step too,
    // whose own instructions are that reading is not how it starts, and the
    // reading won. The finding-out step's claims are checked against the files
    // it opened instead (see ../../src/harness/grounding.ts).
    expect(prompt).toContain('Where you could not check something, say so');
    expect(prompt).not.toContain('read the lines you are about to quote');
    expect(prompt).not.toContain('rather than trusting what you remember');
    // How the changes reach the workspace is not the reply's business, and neither is a request being read-only
    expect(prompt).not.toContain('Changes button');
    expect(prompt).not.toContain('waiting to be applied');
    expect(prompt).toContain('Do not say that it was read-only');
    expect(prompt).toContain('rather than pasting code for the user to copy');
  });

  // The doing step of a coding change holds no tool that writes a file: the
  // change is made by the coders it hands the plan to (see
  // ../../src/harness/phases.ts). So it is told to say what was changed,
  // which reaches the user through the account it writes, and not to make one —
  // the instruction it could not act on is what had it reading the project
  // over again instead of handing the plan out.
  it('tells the step that hands the change out to say what changed, and not to make it', () => {
    const prompt = unwrapped(workspacePrompt('/projects/demo', 'coders'));
    expect(prompt).toContain('the workspace /projects/demo');
    // What changed is said, the same as for a step that makes it itself
    expect(prompt).not.toContain('Changes button');
    expect(prompt).toContain('Say which files you changed');
    // ...and the change is the coders', not its own
    expect(prompt).toContain('by the coders you hand it to, not by you');
    expect(prompt).toContain('Nothing here is yours to edit');
    // Nothing that tells it to make the change itself, which is the one thing
    // it has no tool for
    expect(prompt).not.toContain('make it in the files in your working directory');
    expect(prompt).not.toContain('So change the files rather than pasting code');
  });

  // A step that cannot change a file is not told how to make the change or how
  // the user gets it: it is the finding-out step of a coding change, whose own
  // instructions say it changes nothing (see ../../src/harness/phases.ts), and
  // an instruction it cannot act on both contradicts those and is paid for on
  // every round of the step.
  it('leaves out how to make a change where there is nothing to make it with', () => {
    const prompt = unwrapped(workspacePrompt('/projects/demo'));
    // What is true of any step: the files are the subject, and what it could
    // not check is said
    expect(prompt).toContain('the workspace /projects/demo');
    expect(prompt).toContain('Treat what the user asks as being about those files');
    expect(prompt).toContain('Where you could not check something, say so');
    for (const said of [
      'When they ask for a change',
      'Say which files you changed',
      'rather than pasting code for the user to copy',
    ]) {
      expect(prompt).not.toContain(said);
    }
    expect(prompt.length).toBeLessThan(unwrapped(workspacePrompt('/projects/demo', 'itself')).length);
  });
});

describe('the tool set', () => {
  it('offers the ten sandbox tools, each with a schema naming its required input', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'run_command',
      'read_file',
      'screenshot',
      'record',
      'use_app',
      'save_run_recipe',
      'write_file',
      'edit_file',
      'add_to_context',
      'save_context',
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: 'object', required: expect.any(Array) });
    }
  });

  it('registers every tool with the registry it is given', () => {
    const registry = { register: vi.fn() };
    registerTools(registry);
    expect(registry.register.mock.calls.map(([t]) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('tells the model about the workspace and to keep a context note unprompted', () => {
    expect(unwrapped(PROMPT)).toContain('/workspace');
    expect(unwrapped(PROMPT)).toContain('save_context');
    expect(unwrapped(PROMPT)).toContain('without being asked');
  });
});

describe('screenshot', () => {
  const PNG = Buffer.from('png');
  beforeEach(() => docker.read.mockResolvedValue({ code: 0, data: PNG }));

  // Both halves of showing a state: the clicking it takes to get there, and the
  // data it stands on, which no amount of clicking can invent
  it('offers steps for an app as well as a page, and sends a state that needs data to the app own files', () => {
    const said = unwrapped(tool('screenshot').description);
    expect(said).toContain("in a page or in an app's window");
    expect(said).toContain('--remote-debugging-port is added to command for you');
    expect(said).toContain('npm start');
    expect(said).toContain('steps cannot do is make up the data');
    expect(said).toContain('--user-data-dir');
  });

  it('takes the shot in one go when the container has a browser', async () => {
    const result = await tool('screenshot').run({ url: 'http://localhost:3000' }, context);
    expect(result.images[0].data).toBe(PNG.toString('base64'));
    expect(docker.exec.mock.calls.map(([, command]) => command)).not.toContain('install-browser');
  });

  it('adds the browser to a container made without one, then takes the shot', async () => {
    docker.exec
      .mockResolvedValueOnce({ code: 127, output: `${NO_BROWSER}\n` })
      .mockResolvedValueOnce({ code: 0, output: '' })
      .mockResolvedValueOnce({ code: 0, output: '' });
    const result = await tool('screenshot').run({ url: 'http://localhost:3000' }, context);
    expect(result.images).toHaveLength(1);
    expect(docker.exec.mock.calls[1]).toEqual([THREAD, 'install-browser', { signal, timeoutSeconds: 600 }]);
  });

  it('says there is no browser when installing one does not help', async () => {
    docker.exec.mockResolvedValue({ code: 127, output: `${NO_BROWSER}\n` });
    await expect(tool('screenshot').run({ url: 'http://localhost:3000' }, context)).rejects.toThrow(NO_BROWSER);
    expect(docker.read).not.toHaveBeenCalled();
  });

  describe('with steps', () => {
    const url = 'http://localhost:3000';
    const steps = [
      { action: 'click', selector: '#open' },
      { action: 'type', selector: 'input[name=q]', text: "it's here" },
      { action: 'wait', ms: 500 },
    ];

    it('drives headed Chromium on a virtual display in one exec, with the steps as JSON', async () => {
      const result = await tool('screenshot').run({ url, steps }, context);
      expect(result.images[0].data).toBe(PNG.toString('base64'));
      const shots = docker.exec.mock.calls.filter(([, script]) => String(script).includes('Xvfb :$n'));
      expect(shots).toHaveLength(1);
      const [, script, options] = shots[0];
      expect(script).toContain('seq 90 99');
      expect(script).toContain('flock -n 9');
      expect(script).toContain('.ch-display-');
      expect(script).toContain('--remote-debugging-port');
      expect(script).toContain('--remote-debugging-port=$port');
      expect(script).toContain('port=$((9200 + n))');
      expect(script).toContain(`'${url}'`);
      expect(script).toContain(docker.quote(JSON.stringify(steps)));
      expect(script).not.toContain('--headless');
      // The driver is given less time than the exec, so that its own complaint is what comes back
      expect(script).toContain('timeout 100');
      expect(options).toEqual({ signal, timeoutSeconds: 120 });
    });

    it('turns a path given as the page into a file address', async () => {
      await tool('screenshot').run({ url: 'demo/index.html', steps }, context);
      const shots = docker.exec.mock.calls.filter(([, script]) => String(script).includes('Xvfb :$n'));
      expect(shots).toHaveLength(1);
      expect(shots[0][1]).toContain("'file:///workspace/demo/index.html'");
    });

    it('says Node is needed when it is missing or too old, and does not try to install a browser', async () => {
      docker.exec.mockResolvedValue({ code: 1, output: `${NO_NODE}\n` });
      const run = tool('screenshot').run({ url, steps }, context);
      await expect(run).rejects.toThrow(NO_NODE);
      await expect(run).rejects.toThrow(/Node/);
      expect(docker.exec.mock.calls.map(([, command]) => command)).not.toContain('install-browser');
      expect(docker.read).not.toHaveBeenCalled();
    });

    it('rejects an action it does not know, naming the step', async () => {
      const bad = [
        { action: 'click', selector: '#a' },
        { action: 'drag', selector: '#b' },
      ];
      await expect(tool('screenshot').run({ url, steps: bad }, context)).rejects.toThrow('Step 2');
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('rejects a step missing what its action needs, before starting anything', async () => {
      const bad = [{ action: 'press' }];
      await expect(tool('screenshot').run({ url, steps: bad }, context)).rejects.toThrow('Step 1: press needs "key"');
      expect(docker.exec).not.toHaveBeenCalled();
    });

    // A picture was all a driven page gave back, so finding out what a click did
    // meant a script of the model's own; what the steps read is said back now
    it('says back what the steps read, and what the page wrote to its console', async () => {
      const report = {
        results: [{ step: 2, action: 'text', value: '3 threads' }],
        console: ['[error] Failed to load resource (http://localhost:3000/api)'],
        errors: ['TypeError: x is undefined'],
      };
      docker.exec.mockResolvedValue({ code: 0, output: `\n@@ch-report:${JSON.stringify(report)}\n` });
      const result = await tool('screenshot').run({ url, steps }, context);
      expect(result.text).toContain('step 2 (text): 3 threads');
      expect(result.text).toContain('TypeError: x is undefined');
      expect(result.text).toContain('Failed to load resource');
      expect(result.text).not.toContain('@@ch-report');
    });

    it('says what the steps before a failed one read, along with the failure', async () => {
      const report = { results: [{ step: 1, action: 'eval', value: '"draft"' }] };
      docker.exec.mockResolvedValue({
        code: 1,
        output: `step 2 (click): no element matches #open\n@@ch-report:${JSON.stringify(report)}\n`,
      });
      const run = tool('screenshot').run({ url, steps }, context);
      await expect(run).rejects.toThrow('no element matches #open');
      await expect(run).rejects.toThrow('step 1 (eval): "draft"');
    });

    it('rejects more than 50 steps', async () => {
      const many = Array.from({ length: 51 }, () => ({ action: 'wait', ms: 1 }));
      await expect(tool('screenshot').run({ url, steps: many }, context)).rejects.toThrow('at most 50 steps');
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('installs what is missing when the script exits 127, then runs it once more', async () => {
      docker.exec
        .mockResolvedValueOnce({ code: 127, output: `${NO_BROWSER}\n` })
        .mockResolvedValueOnce({ code: 0, output: '' })
        .mockResolvedValueOnce({ code: 0, output: '' });
      const result = await tool('screenshot').run({ url, steps }, context);
      expect(result.images).toHaveLength(1);
      expect(docker.exec.mock.calls[1]).toEqual([THREAD, 'install-browser', { signal, timeoutSeconds: 600 }]);
      expect(String(docker.exec.mock.calls[2][1])).toContain('Xvfb :$n');
      expect(docker.exec.mock.calls[2][2]).toEqual({ signal, timeoutSeconds: 120 });
    });

    it('gives the driver complaint to the agent when the shot fails', async () => {
      docker.exec.mockResolvedValue({ code: 1, output: 'step 1 (click): no element matches #open\n' });
      await expect(tool('screenshot').run({ url, steps }, context)).rejects.toThrow(
        'step 1 (click): no element matches #open'
      );
      expect(docker.read).not.toHaveBeenCalled();
    });

    it('still uses the plain shot when there are no steps', async () => {
      await tool('screenshot').run({ url, steps: [] }, context);
      const script = docker.exec.mock.calls[0][1] as string;
      expect(script).toContain('--headless=new');
      expect(script).not.toContain('Xvfb');
      expect(docker.exec.mock.calls[0][2]).toEqual({ signal });
    });
  });

  describe('of a desktop app', () => {
    const command = 'npx electron . --no-sandbox --disable-gpu';

    it('runs the app on a virtual display in one exec and returns the image', async () => {
      const result = await tool('screenshot').run({ command, wait: 2 }, context);
      expect(result.images[0].data).toBe(PNG.toString('base64'));
      const shots = docker.exec.mock.calls.filter(([, script]) => String(script).includes('Xvfb'));
      expect(shots).toHaveLength(1);
      const [, script, options] = shots[0];
      expect(script).toContain('DISPLAY=:$n');
      expect(script).toContain('import -window root');
      expect(script).toContain('seq 90 99');
      expect(script).toContain('flock -n 9');
      expect(script).toContain('.ch-display-');
      expect(script).toContain('Xvfb :$n -screen 0 1280x800x24');
      expect(script).not.toContain(':99');
      expect(script).toContain('sleep 2');
      expect(script).toContain(command);
      expect(options).toEqual({ signal, timeoutSeconds: 32 });
    });

    it('is run from cwd, at the size asked for', async () => {
      await tool('screenshot').run({ command, cwd: 'app', width: 640, height: 480 }, context);
      const script = docker.exec.mock.calls[1][1] as string;
      expect(script).toContain("cd '/workspace/app'");
      expect(script).toContain('640x480x24');
      expect(script).toContain('sleep 5');
      expect(docker.exec.mock.calls[1][2]).toEqual({ signal, timeoutSeconds: 35 });
    });

    it.each([{ command, url: 'http://localhost:3000' }, {}])('rejects the input %j', async (input) => {
      await expect(tool('screenshot').run(input, context)).rejects.toThrow('"command"');
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('installs what is missing when the script exits 127, then runs it once more', async () => {
      docker.exec
        .mockResolvedValueOnce({ code: 0, output: '' })
        .mockResolvedValueOnce({ code: 127, output: `${NO_BROWSER}\n` })
        .mockResolvedValueOnce({ code: 0, output: '' })
        .mockResolvedValueOnce({ code: 0, output: '' });
      const result = await tool('screenshot').run({ command }, context);
      expect(result.images).toHaveLength(1);
      expect(docker.exec.mock.calls[2]).toEqual([THREAD, 'install-browser', { signal, timeoutSeconds: 600 }]);
      expect(String(docker.exec.mock.calls[3][1])).toContain('Xvfb');
    });

    it('says there is no browser when installing does not help', async () => {
      docker.exec.mockResolvedValue({ code: 127, output: `${NO_BROWSER}\n` });
      await expect(tool('screenshot').run({ command }, context)).rejects.toThrow(NO_BROWSER);
      expect(docker.read).not.toHaveBeenCalled();
    });

    it('says there is no free display when every one is taken', async () => {
      docker.exec.mockResolvedValue({ code: 1, output: `${NO_DISPLAY}\n` });
      await expect(tool('screenshot').run({ command }, context)).rejects.toThrow(NO_DISPLAY);
      expect(docker.read).not.toHaveBeenCalled();
    });

    // A thread asked to show a change to the sidebar could only ever draw the app
    // as it opens, steps being refused with a command: what the change was about
    // took two clicks to reach, and the shot never showed it
    describe('driven by steps first', () => {
      const steps = [
        { action: 'click', selector: '.thread-agents' },
        { action: 'wait', ms: 300 },
      ];

      it('starts the app with a port to drive it by, drives it, then captures the screen', async () => {
        const result = await tool('screenshot').run({ command, steps, wait: 4 }, context);
        expect(result.images[0].data).toBe(PNG.toString('base64'));
        const shots = docker.exec.mock.calls.filter(([, script]) => String(script).includes('Xvfb'));
        expect(shots).toHaveLength(1);
        const [, script, options] = shots[0];
        expect(script).toContain('port=$((9200 + n))');
        expect(script).toContain(`${command} --remote-debugging-port=$port`);
        // ...which the app's own shell is given, not having this script's variables: without it the flag
        // reached the app empty, and it listened on a port of its own choosing that nothing was driving
        expect(script).toContain('DISPLAY=:$n port=$port exec setsid bash -c');
        expect(script).toContain(docker.quote(JSON.stringify(steps)));
        // The window frame is part of the app, so the screen is what is captured —
        // not the page the driver could capture for itself
        expect(script).toContain('import -window root');
        expect(script).toContain('sleep 4');
        // The app and what it started are both stopped afterwards
        expect(script).toContain('kill -- -$app');
        // Long enough for the app to come up and then be driven
        expect(options).toEqual({ signal, timeoutSeconds: 124 });
      });

      // The app has a page of its own open: navigating it would blank what is being
      // shot, and sizing the page would size it away from the window captured
      it('gives the driver no page to go to and no file to write', async () => {
        await tool('screenshot').run({ command, steps }, context);
        const script = String(docker.exec.mock.calls[1][1]);
        expect(script).toMatch(/node -e '.*' '' 1280 800 '' \$port /s);
        expect(script).toContain('if (url) {');
        expect(script).toContain('if (file) {');
      });

      it('leaves the port alone where the command names its own, a launcher having swallowed one added', async () => {
        await tool('screenshot').run({ command: 'npm start -- --remote-debugging-port=9311', steps }, context);
        const script = String(docker.exec.mock.calls[1][1]);
        expect(script).toContain('port=9311');
        expect(script).not.toContain('--remote-debugging-port=$port');
      });

      // The screen can be captured whatever the steps did, so a failed step would
      // otherwise come back as a shot of the state it was left in, reported as the
      // state that was asked for
      it('fails the call when a step failed, although there was a screen to capture', async () => {
        docker.exec.mockResolvedValue({ code: 1, output: 'step 1 (click): no element matches .thread-agents' });
        const run = tool('screenshot').run({ command, steps }, context);
        await expect(run).rejects.toThrow('no element matches');
        expect(docker.read).not.toHaveBeenCalled();
      });
    });
  });
});

describe('record', () => {
  const WEBM = Buffer.from('webm');
  const FRAME = Buffer.from('png');
  // The clip first, then a frame for each of the four the tool asks for
  const recorded = (clip = WEBM, frames = 4) =>
    docker.readEach.mockResolvedValue([
      { code: 0, data: clip },
      ...Array.from({ length: frames }, () => ({ code: 0, data: FRAME })),
    ]);
  // The exec that did the recording, which is not the last one: clearing the
  // clip out of the container follows it
  const filmExec = () =>
    docker.exec.mock.calls.find(([, command]) => String(command).includes('x11grab')) as [
      string,
      string,
      Record<string, unknown>,
    ];
  const film = (input: Record<string, unknown> = {}) =>
    tool('record').run({ url: '/tmp/demo.html', ...input }, context);

  it('returns the clip for the user and frames out of it for the model', async () => {
    recorded();
    const result = await film();
    // The clip goes back as a video and not as an image: nothing the app talks
    // to takes video, so this is the one that must never reach a provider
    expect(result.videos).toEqual([{ mediaType: 'video/webm', data: WEBM.toString('base64') }]);
    expect(result.images).toHaveLength(4);
    expect(result.images[0]).toEqual({ mediaType: 'image/png', data: FRAME.toString('base64') });
    expect(result.text).toContain('4 frames below');
    expect(result.text).toContain('shown to the user');
  });

  it('draws the page on a screen of its own and encodes what lands there', async () => {
    recorded();
    await film({ seconds: 5, width: 800, height: 600 });
    const [, command, options] = filmExec();
    expect(command).toContain('Xvfb');
    expect(command).toContain('800x600x24');
    expect(command).toContain('--kiosk');
    expect(command).toContain('-f x11grab');
    expect(command).toContain('-t 5');
    // Long enough for the settle, the recording and the encode after it
    expect(options.timeoutSeconds).toBeGreaterThan(5);
  });

  it('picks a display whose lock is not held by a live process', async () => {
    recorded();
    await film();
    const [, command] = filmExec();
    expect(command).toContain('seq 90 99');
    expect(command).toContain('flock -n 9');
    expect(command).toContain('.ch-display-');
    expect(command).toContain('kill -0 $(cat /tmp/.X$n-lock)');
    expect(command).toContain('Xvfb ":$n"');
  });

  describe('of a desktop app', () => {
    const command = 'npx electron . --no-sandbox --disable-gpu';
    const app = (input: Record<string, unknown> = {}) => tool('record').run({ command, ...input }, context);

    it('runs the command from cwd on the screen of its own, not a browser', async () => {
      recorded();
      const result = await app({ cwd: '/tmp/demo' });
      const script = filmExec()[1];
      expect(script).toContain("cd '/tmp/demo'");
      expect(script).toContain(command);
      expect(script).toContain('DISPLAY=":$n"');
      expect(script).toContain('x11grab');
      expect(script).toContain('sleep 3');
      expect(script).toContain('tail -n 20 "$app_log"');
      expect(script).toContain('grep -v -e dbus -e bus_connection -e keyring "$log" | tail -n 20');
      expect(script).not.toContain('--kiosk');
      expect(script).not.toContain('"$browser"');
      expect(result.text).toContain(`the app run by ${command}`);
      expect(result.videos).toHaveLength(1);
    });

    it('is run from the workspace unless told otherwise', async () => {
      recorded();
      await app();
      expect(filmExec()[1]).toContain("cd '/workspace'");
    });

    it.each([{ command: 'npx electron .', url: 'http://localhost:3000' }, { url: undefined }])(
      'rejects the input %j',
      async (input) => {
        await expect(tool('record').run(input, context)).rejects.toThrow('"url" or "command"');
        expect(docker.exec).not.toHaveBeenCalled();
      }
    );
  });

  it('keeps the recording inside the length it allows', async () => {
    recorded();
    await film({ seconds: 500 });
    expect(filmExec()[1]).toContain('-t 20');
    docker.exec.mockClear();
    recorded();
    await film({ seconds: 0 });
    expect(filmExec()[1]).toContain('-t 2');
  });

  // VP8 will not encode an odd side
  it('rounds the size to even pixels', async () => {
    recorded();
    await film({ width: 801, height: 601 });
    expect(filmExec()[1]).toContain('800x600x24');
  });

  it('installs the screen and the encoder the first time, then records', async () => {
    docker.exec
      .mockResolvedValueOnce({ code: 126, output: 'ch-recorder-missing\n' })
      .mockResolvedValueOnce({ code: 0, output: '' })
      .mockResolvedValue({ code: 0, output: '' });
    recorded();
    const result = await film();
    expect(docker.exec.mock.calls[1]).toEqual([THREAD, 'install-recorder', { signal, timeoutSeconds: 900 }]);
    expect(result.videos).toHaveLength(1);
  });

  // A container with neither: the browser is found missing first, and the
  // screen and encoder only once there is a browser to want them
  it('installs the browser as well when that is missing too', async () => {
    docker.exec
      .mockResolvedValueOnce({ code: 127, output: `${NO_BROWSER}\n` })
      .mockResolvedValueOnce({ code: 0, output: '' })
      .mockResolvedValueOnce({ code: 126, output: 'ch-recorder-missing\n' })
      .mockResolvedValueOnce({ code: 0, output: '' })
      .mockResolvedValue({ code: 0, output: '' });
    recorded();
    await film();
    expect(docker.exec.mock.calls[1][1]).toBe('install-browser');
    expect(docker.exec.mock.calls[3][1]).toBe('install-recorder');
  });

  it('says it cannot record when installing does not help', async () => {
    docker.exec.mockResolvedValue({ code: 126, output: 'ch-recorder-missing\n' });
    await expect(film()).rejects.toThrow(NO_RECORDER);
    expect(docker.readEach).not.toHaveBeenCalled();
  });

  it('reports what went wrong when the recording failed', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'x11grab: no such display\n' });
    await expect(film()).rejects.toThrow('x11grab: no such display');
  });

  it('turns away a clip too big to keep, saying how to make a smaller one', async () => {
    recorded(Buffer.alloc(11 * 1024 * 1024));
    await expect(film()).rejects.toThrow(/too large.*fewer seconds/s);
  });

  it('sends what frames there are when the clip was too short for all of them', async () => {
    docker.readEach.mockResolvedValue([
      { code: 0, data: WEBM },
      { code: 0, data: FRAME },
      { code: 1, data: Buffer.alloc(0) },
      { code: 1, data: Buffer.alloc(0) },
      { code: 1, data: Buffer.alloc(0) },
    ]);
    const result = await film();
    expect(result.images).toHaveLength(1);
    expect(result.text).toContain('1 frame below');
  });

  it('says so when the clip cannot be read back', async () => {
    docker.readEach.mockResolvedValue([{ code: 1, data: Buffer.alloc(0) }]);
    await expect(film()).rejects.toThrow('The recording could not be read.');
  });

  it('clears the clip and its frames out of the container afterwards', async () => {
    recorded();
    await film();
    expect(lastExec()[1]).toMatch(/^rm -f .*\.webm' .*\.webm-'\*\.png$/);
  });
});

describe('run_command', () => {
  it("runs the command in the thread's container and reports exit code and output", async () => {
    docker.exec.mockResolvedValue({ code: 3, output: 'boom\n' });
    await expect(tool('run_command').run({ command: 'make test' }, context)).resolves.toBe('exit code 3\nboom\n');
    expect(lastExec()).toEqual([THREAD, 'make test', { signal }]);
  });

  it.each([{}, { command: '' }, { command: 42 }])('rejects the input %j', async (input) => {
    await expect(tool('run_command').run(input, context)).rejects.toThrow('"command" must be a non-empty string.');
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it.each([
    'echo hi > out.txt',
    'echo hi >> out.txt',
    'echo hi>out.txt',
    'cat a.txt b.txt >merged.txt',
    'ls 2> errors.log',
    'make &> build.log',
    'echo hi >| out.txt',
    'echo hi > "my file.txt"',
    "cat <<'EOF' > script.sh\necho hi\nEOF",
    'echo hi | tee out.txt',
    'tee out.txt < in.txt',
    'ls && sudo tee /etc/x',
    "sed -i 's/a/b/' file.ts",
    "sed -n -i.bak 's/a/b/p' file.ts",
    "sed --in-place 's/a/b/' file.ts",
    "perl -pi -e 's/a/b/' file.ts",
    'truncate -s 0 file.log',
    'dd if=/dev/zero of=file.bin count=1',
  ])('refuses %j, which writes to a file, without running it', async (command) => {
    await expect(tool('run_command').run({ command }, context)).rejects.toThrow(/writes to a file.*write_file/);
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it.each([
    'ls > /dev/null',
    'make 2>&1',
    'make >/dev/null 2>&1',
    'cmd 2>/dev/null',
    'echo oops >&2',
    'echo hi | cat',
    'cat < in.txt',
    "awk '$1 > 3 { print }' data.txt",
    'grep -n "a > b" src/a.ts',
    'echo "x => y"',
    "sed -n '1,5p' file.ts",
    "sed -E 's/a/b/' file.ts",
    "sed --expression='s/a/b/' file.ts",
    'git log --oneline | head -5',
    'dd if=a.bin of=/dev/null',
    'cat <<EOF\nhello\nEOF',
    'if [ 3 -gt 2 ]; then echo yes; fi',
  ])('still runs %j, which does not write to a file', async (command) => {
    await tool('run_command').run({ command }, context);
    expect(lastExec()[1]).toBe(command);
  });
});

describe('read_file', () => {
  // What the read command returns: the lines asked for, then how long the file is
  const file = (lines: string[], length = lines.length) =>
    docker.exec.mockResolvedValue({ code: 0, output: `${lines.map((l) => `${l}\n`).join('')}@@ch-length:${length}\n` });
  const read = (input: Record<string, unknown>) => tool('read_file').run(input, context) as Promise<string>;

  it('numbers the lines it returns, so they can be referred to', async () => {
    file(['const a = 1;', 'const b = 2;']);
    await expect(read({ path: 'notes/plan.txt' })).resolves.toBe('1: const a = 1;\n2: const b = 2;');
  });

  it('reads only the part asked for, and says what is left', async () => {
    file(['const b = 2;'], 10);
    await expect(read({ path: 'a.ts', start_line: 2, line_count: 1 })).resolves.toBe(
      '2: const b = 2;\n… 8 more lines; read on from start_line 3'
    );
    const command = lastExec()[1] as string;
    expect(command).toContain('-v s=2');
    expect(command).toContain('-v n=1');
    expect(command).toContain(`'a.ts'`);
  });

  it('says nothing is left when the part asked for reaches the end', async () => {
    file(['const b = 2;'], 2);
    await expect(read({ path: 'a.ts', start_line: 2 })).resolves.toBe('2: const b = 2;');
  });

  it('defaults to the first 400 lines', async () => {
    file(['a']);
    await read({ path: 'a.ts' });
    expect(lastExec()[1]).toContain('-v s=1');
    expect(lastExec()[1]).toContain('-v n=400');
  });

  it.each([
    [{ start_line: 0 }, '-v s=1'],
    [{ start_line: -5 }, '-v s=1'],
    [{ start_line: 'top' }, '-v s=1'],
    [{ start_line: 12.6 }, '-v s=13'],
    [{ line_count: 9000 }, '-v n=2000'],
    [{ line_count: 0 }, '-v n=400'],
  ])('reads sensibly when asked for %j', async (input, expected) => {
    file(['a']);
    await read({ path: 'a.ts', ...input });
    expect(lastExec()[1]).toContain(expected);
  });

  it('says so when the file is empty, or when there is nothing that far in', async () => {
    file([], 0);
    await expect(read({ path: 'a.ts' })).resolves.toBe('a.ts is empty.');
    file([], 12);
    await expect(read({ path: 'a.ts', start_line: 90 })).resolves.toBe(
      'a.ts has 12 lines, so there is nothing at line 90.'
    );
  });

  it('fails with the shell error when the file cannot be read', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'awk: cannot open nope\n' });
    await expect(read({ path: 'nope' })).rejects.toThrow('awk: cannot open nope');
  });

  it('quotes the path so it cannot run other commands', async () => {
    file(['a']);
    await read({ path: `x'; rm -rf / #` });
    expect(lastExec()[1]).toContain(`'x'\\''; rm -rf / #'`);
  });
});

describe('write_file', () => {
  const diff = '--- a/a/b.txt\n+++ b/a/b.txt\n@@ -1 +1 @@\n-old\n+new\n';

  it('sends the content on stdin, not through the shell, and reports what the write changed', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: diff });
    const content = `it's "quoted" $HOME\n`;
    await expect(tool('write_file').run({ path: 'a/b.txt', content }, context)).resolves.toBe(
      `Wrote a/b.txt\n\n${diff.trimEnd()}`
    );
    const [thread, command, options] = lastExec();
    expect(thread).toBe(THREAD);
    expect(options).toEqual({ input: content, signal });
    // What was there is set aside, the file is written, and the two are compared
    expect(command).toContain(`cp 'a/b.txt' "$before"`);
    expect(command).toContain(`mkdir -p "$(dirname 'a/b.txt')" && cat > 'a/b.txt'`);
    expect(command).toContain(`diff -u --label 'a/a/b.txt' --label 'b/a/b.txt' "$before" 'a/b.txt'`);
    expect(command.indexOf('cp ')).toBeLessThan(command.indexOf('cat > '));
    expect(command.indexOf('cat > ')).toBeLessThan(command.indexOf('diff -u'));
    expect(command).not.toContain('$HOME');
  });

  it('keeps a path with a quote in it from breaking out of the command', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: '' });
    await tool('write_file').run({ path: "it's.txt", content: 'x' }, context);
    expect(lastExec()[1]).toContain(`cat > 'it'\\''s.txt'`);
  });

  it('says so when the file is as it was, and allows an empty file', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: '' });
    await expect(tool('write_file').run({ path: 'empty', content: '' }, context)).resolves.toBe(
      'Wrote empty (no changes)'
    );
  });

  it('cuts a very long diff short, saying how much more there was', async () => {
    docker.exec.mockResolvedValue({
      code: 0,
      output: Array.from({ length: 450 }, (_, i) => `+line ${i + 1}`).join('\n'),
    });
    const output = (await tool('write_file').run({ path: 'big', content: 'x' }, context)) as string;
    const lines = output.split('\n');
    expect(lines).toHaveLength(2 + 200 + 1);
    expect(lines.at(-1)).toBe('… 250 more lines');
  });

  it('rejects content that is not a string, and a missing path', async () => {
    await expect(tool('write_file').run({ path: 'a', content: 1 }, context)).rejects.toThrow(
      '"content" must be a string.'
    );
    await expect(tool('write_file').run({ content: 'x' }, context)).rejects.toThrow(
      '"path" must be a non-empty string.'
    );
  });

  it('fails when the write fails', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'Read-only file system\n' });
    await expect(tool('write_file').run({ path: '/proc/x', content: 'y' }, context)).rejects.toThrow(
      'Read-only file system'
    );
  });

  it('does not start a second write to a file until the first has finished', async () => {
    const log: string[] = [];
    docker.exec.mockImplementation(async (_thread: string, _command: string, options: { input: string }) => {
      log.push(`start ${options.input}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push(`end ${options.input}`);
      return { code: 0, output: '' };
    });
    const write = (content: string) => tool('write_file').run({ path: 'a/b.txt', content }, context);

    await Promise.all([write('first'), write('second')]);

    expect(log).toEqual(['start first', 'end first', 'start second', 'end second']);
  });
});

describe('withFileLock', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Runs the work, noting when it starts and ends, so that overlaps show
  const job =
    (log: string[], name: string, ms = 5) =>
    async () => {
      log.push(`start ${name}`);
      await pause(ms);
      log.push(`end ${name}`);
      return name;
    };

  it('runs work on one file one piece at a time, in the order it was asked for', async () => {
    const log: string[] = [];
    const results = await Promise.all([
      withFileLock(THREAD, 'a.ts', job(log, '1', 20)),
      withFileLock(THREAD, 'a.ts', job(log, '2', 1)),
      withFileLock(THREAD, 'a.ts', job(log, '3')),
    ]);
    expect(results).toEqual(['1', '2', '3']);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('treats a relative path and the same path under the working directory as one file', async () => {
    const log: string[] = [];
    await Promise.all([
      withFileLock(THREAD, 'src/a.ts', job(log, '1')),
      withFileLock(THREAD, '/workspace/src/../src/a.ts', job(log, '2')),
    ]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('lets work on different files, or in different threads, go on at the same time', async () => {
    const log: string[] = [];
    await Promise.all([
      withFileLock(THREAD, 'a.ts', job(log, '1')),
      withFileLock(THREAD, 'b.ts', job(log, '2')),
      withFileLock('another-thread', 'a.ts', job(log, '3')),
    ]);
    expect(log.slice(0, 3)).toEqual(['start 1', 'start 2', 'start 3']);
  });

  it('goes on to the next piece of work when one fails, and passes the failure on to its caller', async () => {
    const failing = withFileLock(THREAD, 'a.ts', async () => {
      throw new Error('nope');
    });
    const next = withFileLock(THREAD, 'a.ts', async () => 'ok');
    await expect(failing).rejects.toThrow('nope');
    await expect(next).resolves.toBe('ok');
  });
});

// A browser is over a hundred tasks in the container's pid cgroup, and five at
// once filled it: pthread_create then fails, Chromium's children abort and
// crashpad dumps a crash snapshot for each, so no shot comes back at all. The
// browsers wait for each other instead (see CAPTURES_AT_ONCE in
// ../../src/sandbox/lock.ts).
describe('withCaptureSlot', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Runs the work, counting how many pieces of it were running at the peak
  const busy =
    (state: { now: number; most: number }, ms = 5) =>
    async () => {
      state.now += 1;
      state.most = Math.max(state.most, state.now);
      await pause(ms);
      state.now -= 1;
    };

  it('lets only so many browsers run in one container at once, and runs them all', async () => {
    const state = { now: 0, most: 0 };
    const taken = Array.from({ length: 5 }, () => withCaptureSlot(THREAD, signal, busy(state)));
    await Promise.all(taken);
    expect(state.most).toBe(2);
    expect(state.now).toBe(0);
  });

  it('counts each container on its own: two threads do not wait for each other', async () => {
    const state = { now: 0, most: 0 };
    await Promise.all([
      withCaptureSlot(THREAD, signal, busy(state)),
      withCaptureSlot(THREAD, signal, busy(state)),
      withCaptureSlot('another-thread', signal, busy(state)),
      withCaptureSlot('another-thread', signal, busy(state)),
    ]);
    expect(state.most).toBe(4);
  });

  it('hands the slot on when a capture fails, and passes the failure to its caller', async () => {
    const failing = Array.from({ length: 2 }, () =>
      withCaptureSlot(THREAD, signal, async () => {
        throw new Error('no shot');
      })
    );
    const next = withCaptureSlot(THREAD, signal, async () => 'ok');
    for (const one of failing) await expect(one).rejects.toThrow('no shot');
    await expect(next).resolves.toBe('ok');
  });

  it('gives the slots to the waiting captures in the order they were asked for', async () => {
    const order: string[] = [];
    const slot = (name: string) =>
      withCaptureSlot(THREAD, signal, async () => {
        order.push(name);
        await pause(5);
      });
    await Promise.all(['1', '2', '3', '4', '5'].map(slot));
    expect(order).toEqual(['1', '2', '3', '4', '5']);
  });

  it('takes no slot for a call stopped while it waits, and leaves the queue to the rest', async () => {
    const stopping = new AbortController();
    const state = { now: 0, most: 0 };
    const held = Array.from({ length: 2 }, () => withCaptureSlot(THREAD, signal, busy(state, 20)));
    const stopped = withCaptureSlot(THREAD, stopping.signal, busy(state));
    const behind = withCaptureSlot(THREAD, signal, busy(state));
    stopping.abort();
    await expect(stopped).rejects.toThrow('aborted');
    await Promise.all([...held, behind]);
    expect(state.most).toBe(2);
    expect(state.now).toBe(0);
  });

  it('refuses a call that was already stopped before it asked', async () => {
    const stopped = AbortSignal.abort();
    let ran = false;
    await expect(
      withCaptureSlot(THREAD, stopped, async () => {
        ran = true;
      })
    ).rejects.toThrow('aborted');
    expect(ran).toBe(false);
  });
});

describe('edit_file', () => {
  const file = (content: string) => docker.read.mockResolvedValue({ code: 0, data: Buffer.from(content) });
  const written = () => (lastExec()[2] as { input: string }).input;
  const edit = (input: Record<string, unknown>) => tool('edit_file').run({ path: 'src/a.ts', ...input }, context);

  beforeEach(() => {
    docker.exec.mockResolvedValue({ code: 0, output: '@@ -1 +1 @@\n-old\n+new\n' });
  });

  // A read never makes the container, so a thread whose first act was an edit was told its file was not there: there
  // was no container yet to hold it
  it("makes the thread's container before it reads the file, as a write would", async () => {
    file('old\n');
    await edit({ old_text: 'old', new_text: 'new' });
    expect(docker.ensure).toHaveBeenCalledWith(THREAD);
    expect(docker.ensure.mock.invocationCallOrder[0]).toBeLessThan(docker.read.mock.invocationCallOrder[0]);
  });

  it('replaces just the text it is given, leaves the rest of the file as it was, and reports the diff', async () => {
    file('line 1\n  const x = 1;\nline 3\n');
    await expect(edit({ old_text: '  const x = 1;', new_text: '  const x = 2;' })).resolves.toBe(
      'Edited src/a.ts\n\n@@ -1 +1 @@\n-old\n+new'
    );
    expect(docker.read).toHaveBeenCalledWith(THREAD, "cat 'src/a.ts'");
    expect(written()).toBe('line 1\n  const x = 2;\nline 3\n');
    expect(lastExec()[1]).toContain("cat > 'src/a.ts'");
  });

  it('keeps both of two edits to one file made at the same time', async () => {
    // A file that takes a moment to read and to write, as one in a container does
    let disk = 'one\ntwo\n';
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    docker.read.mockImplementation(async () => {
      const data = Buffer.from(disk);
      await pause();
      return { code: 0, data };
    });
    docker.exec.mockImplementation(async (_thread: string, _command: string, options: { input: string }) => {
      await pause();
      disk = options.input;
      return { code: 0, output: '' };
    });

    await Promise.all([edit({ old_text: 'one', new_text: '1' }), edit({ old_text: 'two', new_text: '2' })]);

    expect(disk).toBe('1\n2\n');
  });

  it('lets a later edit see what an earlier one wrote, and fail if that took its text away', async () => {
    let disk = 'one\n';
    docker.read.mockImplementation(async () => ({ code: 0, data: Buffer.from(disk) }));
    docker.exec.mockImplementation(async (_thread: string, _command: string, options: { input: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      disk = options.input;
      return { code: 0, output: '' };
    });

    const results = await Promise.allSettled([
      edit({ old_text: 'one', new_text: 'two' }),
      edit({ old_text: 'one', new_text: 'three' }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(disk).toBe('two\n');
  });

  it('can span several lines, take text out, and puts the new text in as it is', async () => {
    file('a\nb\nc\nd\n');
    await edit({ old_text: 'b\nc\n', new_text: '' });
    expect(written()).toBe('a\nd\n');

    file('price: 1\n');
    await edit({ old_text: '1', new_text: "$& $1 $' cost" });
    expect(written()).toBe("price: $& $1 $' cost\n");
  });

  it('refuses text that is not in the file, and says to copy it from the file', async () => {
    file('const x = 1;\n');
    await expect(edit({ old_text: 'const  x = 1;', new_text: 'y' })).rejects.toThrow(
      '"old_text" was not found in src/a.ts. It must match the file exactly'
    );
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('refuses text found more than once, unless told to replace it everywhere', async () => {
    file('foo();\nbar();\nfoo();\n');
    await expect(edit({ old_text: 'foo()', new_text: 'baz()' })).rejects.toThrow(
      '"old_text" is found 2 times in src/a.ts. Include more of the lines around the change'
    );
    expect(docker.exec).not.toHaveBeenCalled();

    await expect(edit({ old_text: 'foo()', new_text: 'baz()', replace_all: true })).resolves.toMatch(
      /^Edited src\/a\.ts in 2 places\n\n/
    );
    expect(written()).toBe('baz();\nbar();\nbaz();\n');
  });

  it('points to write_file for a file that is not there, and refuses a file that is not text', async () => {
    docker.read.mockResolvedValue({ code: 1, data: Buffer.from('') });
    await expect(edit({ old_text: 'a', new_text: 'b' })).rejects.toThrow(
      'Could not read src/a.ts. To make a new file, use write_file.'
    );
    docker.read.mockResolvedValue(null);
    await expect(edit({ old_text: 'a', new_text: 'b' })).rejects.toThrow('Could not read src/a.ts');

    docker.read.mockResolvedValue({ code: 0, data: Buffer.from([97, 0, 98]) });
    await expect(edit({ old_text: 'a', new_text: 'b' })).rejects.toThrow('src/a.ts is not a text file.');
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['no path', { path: '', old_text: 'a', new_text: 'b' }, '"path" must be a non-empty string.'],
    // Said at length, since what a model that leaves it empty needs is the way
    // to add text rather than the shape of the field (see edit_file)
    ['no text to replace', { old_text: '', new_text: 'b' }, 'give a line or two that is already there'],
    ['no text to replace at all', { new_text: 'b' }, '"old_text" must be a non-empty string.'],
    ['new text that is not text', { old_text: 'a', new_text: 7 }, '"new_text" must be a string.'],
    ['new text the same as the old', { old_text: 'a', new_text: 'a' }, 'are the same, so there is nothing to change'],
  ])('rejects %s', async (_name, input, message) => {
    file('a\n');
    await expect(edit(input)).rejects.toThrow(message);
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('is what the model is pointed to for changing a file that is already there', () => {
    expect(tool('write_file').description).toContain('use edit_file instead');
    expect(tool('edit_file').description).toContain('Use this rather than write_file');
    expect(tool('edit_file').inputSchema).toMatchObject({ required: ['path', 'old_text', 'new_text'] });
  });
});

// The one a model reaches for while it works: nothing is rewritten, so a note
// costs it almost nothing and cannot lose what the note already said
// The compactor's findings are the only writing-up of a reply's tool results
// there is, and the message they go into dies with the reply
describe('keepFindings', () => {
  beforeEach(() => {
    docker.ensure.mockResolvedValue('ch-thread-x');
  });

  const noteIs = (text: string) => docker.exec.mockResolvedValue({ code: 0, output: text });
  const written = () => (lastExec()[2] as { input?: string } | undefined)?.input ?? '';

  it("puts the findings in the thread's note, under a heading of their own", async () => {
    noteIs('The cause is the guard on line 622.\n');
    await expect(keepFindings(THREAD, 'Read embeddings.ts; pick() returns [] for empty text.')).resolves.toBe(true);
    expect(lastExec()[1]).toContain(`cat > '${CONTEXT_FILE}'`);
    // What the model wrote itself comes first and is kept whole
    expect(written()).toContain('The cause is the guard on line 622.');
    expect(written()).toContain('pick() returns [] for empty text.');
    expect(written().indexOf('The cause')).toBeLessThan(written().indexOf('pick()'));
  });

  it('replaces the findings of an earlier compaction rather than keeping both', async () => {
    noteIs(
      ['My own note.', '', '## What this work has found so far (condensed from the record)', '', 'Older.'].join('\n')
    );
    await keepFindings(THREAD, 'Newer.');
    expect(written()).toContain('My own note.');
    expect(written()).toContain('Newer.');
    // Each compaction reads the one before it, so two side by side would say
    // the same things twice
    expect(written()).not.toContain('Older.');
    expect(written().match(/## What this work has found/g)).toHaveLength(1);
  });

  it('writes nothing for findings that are empty, and says so', async () => {
    await expect(keepFindings(THREAD, '   ')).resolves.toBe(false);
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('does not create a container to write into, nor fail when there is none', async () => {
    docker.ensure.mockResolvedValue(undefined);
    await expect(keepFindings(THREAD, 'Something found.')).resolves.toBe(false);
    expect(docker.ensure).toHaveBeenCalledWith(THREAD, { create: false });
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('never throws: a note that cannot be written must not bring down the reply', async () => {
    docker.exec.mockRejectedValue(new Error('container is gone'));
    await expect(keepFindings(THREAD, 'Something found.')).resolves.toBe(false);
  });
});

// What an attempt the user threw away wrote in the note goes with its messages
describe('restoreContext', () => {
  beforeEach(() => {
    docker.ensure.mockResolvedValue('ch-thread-x');
    docker.exec.mockResolvedValue({ code: 0, output: '' });
  });

  it('writes the note back as it stood before the attempt', async () => {
    await expect(restoreContext(THREAD, 'Goal: build the parser.')).resolves.toBe(true);
    expect(lastExec()[1]).toContain(`cat > '${CONTEXT_FILE}'`);
    expect(lastExec()[2]).toMatchObject({ input: 'Goal: build the parser.\n' });
  });

  // An empty note is not the same as a note saying nothing: the file goes, so
  // the thread is as it was before it had one
  it('takes the note away when there was none before the attempt', async () => {
    await expect(restoreContext(THREAD, '   ')).resolves.toBe(true);
    expect(lastExec()[1]).toBe(`rm -f '${CONTEXT_FILE}'`);
  });

  it("puts a subagent's own note back, not the thread's", async () => {
    await restoreContext(THREAD, 'What it had found.', 'read the tests');
    expect(lastExec()[1]).toContain('.agent/agents/read-the-tests.md');
  });

  it('does not create a container to write into, nor fail when there is none', async () => {
    docker.ensure.mockResolvedValue(undefined);
    await expect(restoreContext(THREAD, 'Goal: build the parser.')).resolves.toBe(false);
    expect(docker.ensure).toHaveBeenCalledWith(THREAD, { create: false });
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('never throws: a note that cannot be put back must not stop the next attempt', async () => {
    docker.exec.mockRejectedValue(new Error('container is gone'));
    await expect(restoreContext(THREAD, 'Goal: build the parser.')).resolves.toBe(false);
  });

  it('says so when the write failed, rather than reporting the note put back', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'no space left on device' });
    await expect(restoreContext(THREAD, 'Goal: build the parser.')).resolves.toBe(false);
  });
});

describe('add_to_context', () => {
  it("adds a line to the thread's note without reading or rewriting it", async () => {
    await expect(tool('add_to_context').run({ content: 'The cause is the guard on line 622.' }, context)).resolves.toBe(
      'Added to your context note.'
    );
    expect(lastExec()[1]).toContain(`cat >> '${CONTEXT_FILE}'`);
    expect(lastExec()[1]).not.toContain(`cat > '${CONTEXT_FILE}'`);
    expect(lastExec()[2]).toMatchObject({ input: 'The cause is the guard on line 622.\n' });
  });

  it('ends every line, so two notes do not run into one', async () => {
    await tool('add_to_context').run({ content: 'First thing.  ' }, context);
    expect(lastExec()[2]).toMatchObject({ input: 'First thing.\n' });
  });

  it("writes to a subagent's own note, as the replacing one does", async () => {
    await tool('add_to_context').run({ content: 'What it found.' }, { ...context, agent: 'read the tests' });
    expect(lastExec()[1]).toContain('.agent/agents/read-the-tests.md');
  });

  it.each([{}, { content: '' }, { content: 42 }])('rejects the input %j', async (input) => {
    await expect(tool('add_to_context').run(input, context)).rejects.toThrow('"content" must be a non-empty string.');
  });

  it('says a write that failed failed, rather than letting the model believe it saved', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'no space left on device' });
    await expect(tool('add_to_context').run({ content: 'x' }, context)).rejects.toThrow('no space left on device');
  });
});

describe('save_context and readContext', () => {
  it('saves the note to the context file in the thread container', async () => {
    await expect(tool('save_context').run({ content: 'Goal: build X' }, context)).resolves.toBe('Context saved.');
    expect(lastExec()[1]).toContain(`cat > '${CONTEXT_FILE}'`);
    expect(lastExec()[2]).toMatchObject({ input: 'Goal: build X' });
  });

  it('gives each subagent a note of its own, so none writes over another', async () => {
    const asAgent = (agent: string) => ({ ...context, agent });
    await tool('save_context').run({ content: 'What the thread is doing.' }, context);
    const threads = lastExec()[1];
    await tool('save_context').run({ content: 'What the tests subagent found.' }, asAgent('read the tests'));
    const one = lastExec()[1];
    await tool('save_context').run({ content: 'What the build subagent found.' }, asAgent('read the build'));
    const other = lastExec()[1];

    // Three agents, three files, none of them the same
    expect(new Set([threads, one, other]).size).toBe(3);
    expect(one).toContain('.agent/agents/read-the-tests.md');
    expect(other).toContain('.agent/agents/read-the-build.md');
    // ...and none of them the thread's own
    for (const written of [one, other]) expect(written).not.toContain(`'${CONTEXT_FILE}'`);
  });

  it.each([
    ['tests', '.agent/agents/tests.md'],
    ['Read The Tests', '.agent/agents/read-the-tests.md'],
    ['../../etc/passwd', '.agent/agents/etc-passwd.md'],
    ['!!!', '.agent/agents/agent.md'],
    ['x'.repeat(80), `.agent/agents/${'x'.repeat(40)}.md`],
  ])('names the file after the subagent, safely: %j', (agent, file) => {
    expect(contextFile(agent)).toBe(file);
  });

  it("is the thread's own file when nobody in particular is asking", () => {
    expect(contextFile()).toBe(CONTEXT_FILE);
  });

  it("reads back a subagent's own note, not the thread's", async () => {
    docker.ensure.mockResolvedValue('ch-thread-x');
    docker.exec.mockResolvedValue({ code: 0, output: 'What it found.\n' });
    await expect(readContext(THREAD, 'read the tests')).resolves.toBe('What it found.');
    expect(lastExec()[1]).toBe("cat '.agent/agents/read-the-tests.md'");
  });

  it('rejects an empty note', async () => {
    await expect(tool('save_context').run({ content: '' }, context)).rejects.toThrow('"content"');
  });

  it('reads the saved note back, trimmed', async () => {
    docker.ensure.mockResolvedValue('ch-thread-x');
    docker.exec.mockResolvedValue({ code: 0, output: 'Goal: build X\n\n' });
    await expect(readContext(THREAD)).resolves.toBe('Goal: build X');
    expect(lastExec()[1]).toBe(`cat '${CONTEXT_FILE}'`);
  });

  it('never creates a container just to look for a note', async () => {
    docker.ensure.mockResolvedValue(null);
    await expect(readContext(THREAD)).resolves.toBe('');
    expect(docker.ensure).toHaveBeenCalledWith(THREAD, { create: false });
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('is empty when there is no note yet', async () => {
    docker.ensure.mockResolvedValue('ch-thread-x');
    docker.exec.mockResolvedValue({ code: 1, output: 'cat: No such file or directory' });
    await expect(readContext(THREAD)).resolves.toBe('');
  });

  it('is empty, not an error, when Docker is unavailable', async () => {
    docker.ensure.mockRejectedValue(new Error('Docker is not installed.'));
    await expect(readContext(THREAD)).resolves.toBe('');
  });
});

// How much of a file one read returns, which has to be the same number the
// model was told it would get: the finding-out step's round budget is worked
// out from it (see ../../src/harness/phases.ts), so a page larger than the
// window makes that budget fiction. Four hundred lines of real source is about
// six thousand tokens with its line numbers — a fifth of a 32k window in one
// call, and the 2000-line ceiling is more than such a window holds at all.
describe('reading a file in a window that cannot hold it', () => {
  const read = tool('read_file');
  const asked = () => Number(lastExec()[1].match(/-v n=(\d+)/)![1]);
  const page = (window?: number) => pageFor(window);

  beforeEach(() => {
    docker.exec.mockResolvedValue({ code: 0, output: 'a line\n@@ch-length:1\n' });
  });

  it('reads a page sized to the window when no count is asked for', async () => {
    await read.run({ path: 'src/a.ts' }, { signal, threadId: THREAD, window: 32_000 });
    expect(asked()).toBe(page(32_000).lines);
    await read.run({ path: 'src/a.ts' }, { signal, threadId: THREAD, window: 200_000 });
    expect(asked()).toBe(400);
    // ...and the old page for a model that does not say what it has
    await read.run({ path: 'src/a.ts' }, context);
    expect(asked()).toBe(400);
  });

  it('holds a count asked for down to what the window can take', async () => {
    await read.run({ path: 'src/a.ts', line_count: 2000 }, { signal, threadId: THREAD, window: 32_000 });
    expect(asked()).toBe(page(32_000).most);
    // What used to come back was more tokens than the window holds, which
    // costs the conversation the file was being read for
    expect(asked() * 15).toBeLessThan(32_000 * 0.8);
    expect(2000 * 15).toBeGreaterThan(32_000 * 0.8);
    // Unchanged where there is room for it
    await read.run({ path: 'src/a.ts', line_count: 2000 }, { signal, threadId: THREAD, window: 200_000 });
    expect(asked()).toBe(2000);
  });

  it('leaves a count smaller than the page alone, that being the model asking for less', async () => {
    await read.run({ path: 'src/a.ts', line_count: 20 }, { signal, threadId: THREAD, window: 32_000 });
    expect(asked()).toBe(20);
  });

  // Reading on from where a page ended is how the tool already works and what
  // the model is already told, so a page cut short costs a round, not the lines
  it('says how to read on, so the lines a smaller page left out are still reachable', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: 'one\ntwo\n@@ch-length:500\n' });
    const said = await read.run({ path: 'src/a.ts' }, { signal, threadId: THREAD, window: 32_000 });
    expect(said).toContain('read on from start_line 3');
  });
});

// The app kept running between calls, so that it can be used a move at a time
// rather than started afresh for every look (see use_app in src/tools/sandbox.ts)
describe('use_app', () => {
  const PNG = Buffer.from('png');
  const started = () => {
    const call = docker.exec.mock.calls.find(([, script]) => String(script).includes('ch_stop'));
    return String(call?.[1]);
  };
  const idOf = (text: string) => /session ([0-9a-f]{8})/.exec(text)![1];

  it('starts a page on a display of its own, leaves it running, and says the id to use it by', async () => {
    const result = await tool('use_app').run({ action: 'start', url: 'http://localhost:3000' }, context);
    const id = idOf(result.text);
    const script = started();
    expect(script).toContain(`/tmp/ch-app-${id}`);
    expect(script).toContain('--remote-debugging-port=$port');
    expect(script).toContain("'http://localhost:3000'");
    // Nothing it starts holds the command open
    expect(script).toContain('</dev/null) &');
    // Not stopped at the end, unlike a screenshot's browser
    expect(script).not.toMatch(/kill -- -\$chrome/);
    expect(result.text).toContain(`Give session "${id}"`);
    expect(result.images).toEqual([]);
  });

  it('adds the debugging port to an app command, or keeps the one it names', async () => {
    await tool('use_app').run({ action: 'start', command: 'npx electron . --no-sandbox' }, context);
    expect(started()).toContain('npx electron . --no-sandbox --remote-debugging-port=$port');
    expect(started()).toContain('DISPLAY=:$n port=$port exec setsid bash -c');
    docker.exec.mockClear();
    await tool('use_app').run({ action: 'start', command: 'npm start -- --remote-debugging-port=9311' }, context);
    expect(started()).toContain('port=9311');
    expect(started()).not.toContain('--remote-debugging-port=$port');
  });

  it('does steps in a running session and says back what they read and what the app wrote', async () => {
    const report = { results: [{ step: 1, action: 'text', value: 'Saved' }] };
    docker.exec.mockResolvedValue({
      code: 0,
      output: `\n@@ch-report:${JSON.stringify(report)}\n\n@@ch-log:\nPOST /api/save 200\n`,
    });
    const steps = [{ action: 'text', selector: '.status' }];
    const result = await tool('use_app').run({ action: 'do', session: 'abcd1234', steps }, context);
    expect(result.text).toContain('step 1 (text): Saved');
    expect(result.text).toContain('What the app itself wrote:\nPOST /api/save 200');
    expect(result.images).toEqual([]);
    const script = String(lastExec()[1]);
    expect(script).toContain('/tmp/ch-app-abcd1234/env');
    expect(script).toContain(docker.quote(JSON.stringify(steps)));
    expect(docker.read).not.toHaveBeenCalled();
  });

  it('draws the session when asked to', async () => {
    docker.read.mockResolvedValue({ code: 0, data: PNG });
    const result = await tool('use_app').run({ action: 'do', session: 'abcd1234', screenshot: true }, context);
    expect(result.images[0].data).toBe(PNG.toString('base64'));
  });

  it('says plainly when the session is gone or its app has exited', async () => {
    docker.exec.mockResolvedValue({ code: 3, output: 'ch-no-session\n' });
    await expect(
      tool('use_app').run({ action: 'do', session: 'abcd1234', steps: [{ action: 'wait', ms: 1 }] }, context)
    ).rejects.toThrow('There is no session abcd1234');
    docker.exec.mockResolvedValue({ code: 4, output: 'ch-app-exited\nError: port in use\n' });
    await expect(
      tool('use_app').run({ action: 'do', session: 'abcd1234', steps: [{ action: 'wait', ms: 1 }] }, context)
    ).rejects.toThrow('has exited. The end of what it wrote:\nError: port in use');
  });

  it('stops a session, and refuses an id that is not one', async () => {
    const result = await tool('use_app').run({ action: 'stop', session: 'abcd1234' }, context);
    expect(result.text).toBe('Stopped session abcd1234.');
    expect(String(lastExec()[1])).toContain("ch_stop '/tmp/ch-app-abcd1234'");
    await expect(tool('use_app').run({ action: 'stop', session: '../etc' }, context)).rejects.toThrow(
      'not a session id'
    );
  });

  it('asks for something to do', async () => {
    await expect(tool('use_app').run({ action: 'do', session: 'abcd1234' }, context)).rejects.toThrow('Give steps');
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('records a session while doing the steps, and refuses steps without one', async () => {
    docker.readEach.mockResolvedValue([{ code: 0, data: Buffer.from('webm') }]);
    const steps = [{ action: 'click', selector: '#send' }];
    await tool('record').run({ session: 'abcd1234', steps }, context);
    const script = String(docker.exec.mock.calls.find(([, s]) => String(s).includes('x11grab'))![1]);
    expect(script).toContain('/tmp/ch-app-abcd1234/env');
    expect(script).toContain(docker.quote(JSON.stringify(steps)));
    await expect(tool('record').run({ url: 'http://localhost:3000', steps }, context)).rejects.toThrow(
      'Steps are done in a session'
    );
  });
});

// A container older than the dependencies' image fetching Electron (see
// ELECTRON_INSTALL in ../../src/sandbox/docker.ts) has the package and no binary,
// so a desktop app launched there had nothing to run, and a screenshot of it was
// a blank screen taken all the same
describe("Electron's binary, before a desktop app is launched", () => {
  const command = 'npx electron . --no-sandbox --disable-gpu';
  const fetched = () => docker.exec.mock.calls.filter(([, script]) => String(script).includes('install-electron'));

  beforeEach(() => docker.read.mockResolvedValue({ code: 0, data: Buffer.from('png') }));

  it.each([
    ['screenshot', { command, cwd: 'app' }],
    ['screenshot', { command, cwd: 'app', steps: [{ action: 'wait', ms: 10 }] }],
    ['record', { command, cwd: 'app' }],
    ['use_app', { action: 'start', command, cwd: 'app' }],
  ])('is fetched from cwd by %s %j, ahead of the launch', async (name, input) => {
    docker.readEach.mockResolvedValue([{ code: 0, data: Buffer.from('webm') }]);
    await tool(name).run(input, context);
    expect(docker.exec.mock.calls[0]).toEqual([
      THREAD,
      "cd '/workspace/app' && install-electron",
      { signal, timeoutSeconds: 300 },
    ]);
    expect(fetched()).toHaveLength(1);
  });

  it.each([
    ['screenshot', { url: 'http://localhost:3000' }],
    ['use_app', { action: 'start', url: 'http://localhost:3000' }],
  ])('is not fetched for a page, by %s', async (name, input) => {
    await tool(name).run(input, context);
    expect(fetched()).toHaveLength(0);
  });

  it('leaves the app to fail in its own words when the fetch could not be run', async () => {
    docker.exec.mockRejectedValueOnce(new Error('timed out'));
    const result = await tool('screenshot').run({ command }, context);
    expect(result.images).toHaveLength(1);
  });
});

describe('run_command and a scratch script', () => {
  it('runs it all the same, and says what to do instead', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: 'ok\n' });
    const said = await tool('run_command').run({ command: 'npx tsx /tmp/check.ts' }, context);
    expect(said).toContain('exit code 0\nok');
    expect(said).toContain('use_app');
    expect(said).toContain("add a test beside the project's own");
  });

  it('says nothing more for a command that is not one', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: 'ok\n' });
    expect(await tool('run_command').run({ command: 'npx vitest run' }, context)).toBe('exit code 0\nok\n');
  });
});

// A workspace's run recipe (see ../../src/sandbox/recipes.ts): run whole by use_app, and saved only once it has run
describe("a workspace's run recipe", () => {
  const WORKSPACE = '/projects/demo';
  const inWorkspace = { ...context, workspace: WORKSPACE };
  const RECIPE = {
    setup: ['npm run build'],
    services: [{ command: 'node fake-llm.js', ready: 'http://localhost:11500/v1/models' }],
    env: { LOCAL_LLM_BASE_URL: 'http://localhost:11500/v1' },
    data: { from: 'test/fixtures/user-data', flag: '--user-data-dir' },
    app: { command: 'npx electron . --no-sandbox' },
    ready: '#composer',
    after: [{ action: 'click', selector: '.finish-later' }],
  };
  const scripts = () => docker.exec.mock.calls.map(([, script]) => String(script));
  const launched = () => scripts().find((script) => script.includes('Xvfb :$n') && script.includes('setsid bash -c'));
  const drove = (selector: string) => scripts().some((script) => script.includes(`"selector":"${selector}"`));
  const idOf = (text: string) => /session ([0-9a-f]{8})/.exec(text)![1];
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-recipes-'));
    recipes.init(dir);
    docker.read.mockResolvedValue({ code: 0, data: Buffer.from('png') });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('started by use_app with recipe: true', () => {
    it('builds, starts what runs beside the app, copies its data, launches it, and waits for it to be up', async () => {
      recipes.put(WORKSPACE, RECIPE);
      const result = await tool('use_app').run({ action: 'start', recipe: true }, inWorkspace);
      const id = idOf(result.text);
      const [prepare] = scripts();
      expect(prepare).toContain(`export LOCAL_LLM_BASE_URL='http://localhost:11500/v1'`);
      expect(prepare).toContain(`bash -c 'npm run build'`);
      // A service is only started where its address does not answer already
      expect(prepare).toContain(`if ! answers 'http://localhost:11500/v1/models'; then`);
      expect(prepare).toContain(`(setsid nohup bash -c 'node fake-llm.js'`);
      expect(prepare).toContain(`cp -a 'test/fixtures/user-data/.' '/tmp/ch-data-${id}'`);
      // The app gets the variables and its own copy of the data, and a port to be driven by
      expect(launched()).toContain('export LOCAL_LLM_BASE_URL=');
      expect(launched()).toContain(
        `npx electron . --no-sandbox --user-data-dir=/tmp/ch-data-${id} --remote-debugging-port=$port`
      );
      expect(drove('#composer')).toBe(true);
      expect(drove('.finish-later')).toBe(true);
      expect(result.text).toContain("from this workspace's run recipe");
      expect(result.text).toContain(`Give session "${id}"`);
    });

    it('does the steps given with it once the recipe has the app up', async () => {
      recipes.put(WORKSPACE, RECIPE);
      await tool('use_app').run(
        { action: 'start', recipe: true, steps: [{ action: 'text', selector: '#messages' }] },
        inWorkspace
      );
      const order = scripts().map((script) =>
        script.includes('"#composer"') ? 'ready' : script.includes('"#messages"') ? 'mine' : ''
      );
      expect(order.filter(Boolean)).toEqual(['ready', 'mine']);
    });

    it('says to save one where the workspace has none, and starts nothing', async () => {
      await expect(tool('use_app').run({ action: 'start', recipe: true }, inWorkspace)).rejects.toThrow(
        'save_run_recipe'
      );
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('is not given with url or command', async () => {
      recipes.put(WORKSPACE, RECIPE);
      await expect(
        tool('use_app').run({ action: 'start', recipe: true, url: 'http://localhost:3000' }, inWorkspace)
      ).rejects.toThrow('not both');
    });

    it('says which part of it failed and what that said, and keeps it for the next model to be told', async () => {
      recipes.put(WORKSPACE, RECIPE);
      docker.exec.mockResolvedValueOnce({
        code: 1,
        output: '@@ch-recipe-failed:setup 1 (npm run build)\nsrc/a.ts(3,1): error TS2304\n',
      });
      const failing = tool('use_app').run({ action: 'start', recipe: true }, inWorkspace);
      await expect(failing).rejects.toThrow('failed at setup 1 (npm run build).\nsrc/a.ts(3,1): error TS2304');
      await expect(failing).rejects.not.toThrow('still running');
      expect(launched()).toBeUndefined();
      expect(recipes.get(WORKSPACE)!.failed).toMatchObject({
        stage: 'setup 1 (npm run build)',
        why: 'src/a.ts(3,1): error TS2304',
      });
      expect(unwrapped(recipes.prompt(WORKSPACE))).toContain('failed at setup 1 (npm run build)');
    });

    it('leaves the app running to be looked at when it never showed what says it is up', async () => {
      recipes.put(WORKSPACE, RECIPE);
      docker.exec.mockImplementation(async (_thread: string, script: string) =>
        script.includes('"#composer"')
          ? { code: 1, output: 'Step 1 (wait_for) failed: #composer never appeared' }
          : {
              code: 0,
              output: '',
            }
      );
      const failing = tool('use_app').run({ action: 'start', recipe: true }, inWorkspace);
      await expect(failing).rejects.toThrow('failed at the ready check (#composer). Session');
      await expect(failing).rejects.toThrow('is still running');
      expect(recipes.get(WORKSPACE)!.failed!.stage).toBe('the ready check (#composer)');
    });

    it('clears a failure it had once it runs all the way through again', async () => {
      recipes.put(WORKSPACE, RECIPE);
      recipes.failed(WORKSPACE, 'launch', 'gone');
      await tool('use_app').run({ action: 'start', recipe: true }, inWorkspace);
      expect(recipes.get(WORKSPACE)!.failed).toBeUndefined();
    });
  });

  describe('saved by save_run_recipe', () => {
    it('is run from nothing, kept only then, and the app it started is stopped', async () => {
      const result = await tool('save_run_recipe').run(RECIPE, inWorkspace);
      expect(recipes.get(WORKSPACE)).toMatchObject({ ...RECIPE, thread: THREAD });
      expect(launched()).toBeDefined();
      expect(scripts().at(-1)).toMatch(/ch_stop '\/tmp\/ch-app-[0-9a-f]{8}'$/);
      // What it leaves the app showing, drawn once the steps after the ready check are done
      expect(result.images).toHaveLength(1);
      expect(result.text).toContain('`npm run build`, `node fake-llm.js` in the background, then');
    });

    it('is not kept where it does not run through, and says where it stopped', async () => {
      docker.exec.mockResolvedValueOnce({ code: 1, output: '@@ch-recipe-failed:service 1 (node fake-llm.js)\n' });
      await expect(tool('save_run_recipe').run(RECIPE, inWorkspace)).rejects.toThrow(
        'was not saved: run from nothing, it failed at service 1 (node fake-llm.js)'
      );
      expect(recipes.get(WORKSPACE)).toBeUndefined();
    });

    it('keeps the recipe the workspace had where the new one does not run', async () => {
      recipes.put(WORKSPACE, RECIPE);
      docker.exec.mockResolvedValueOnce({ code: 1, output: '@@ch-recipe-failed:setup 1 (make)\n' });
      await expect(tool('save_run_recipe').run({ ...RECIPE, setup: ['make'] }, inWorkspace)).rejects.toThrow();
      expect(recipes.get(WORKSPACE)!.setup).toEqual(['npm run build']);
    });

    it.each([
      [{ ...RECIPE, setup: ['echo built > src/version.ts'] }, 'writes to a file in the project'],
      [{ ...RECIPE, setup: ['git init'] }, 'makes a repository'],
      [{ ...RECIPE, after: [{ action: 'fly' }] }, 'Step 1'],
      [{ setup: ['npm run build'] }, '"app" must be given'],
    ])('is refused before anything is run, for %j', async (given, why) => {
      await expect(tool('save_run_recipe').run(given, inWorkspace)).rejects.toThrow(why);
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('needs a workspace to be kept for', async () => {
      await expect(tool('save_run_recipe').run(RECIPE, context)).rejects.toThrow('started in a workspace');
    });
  });
});
