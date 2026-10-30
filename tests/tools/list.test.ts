// Listing what is in a thread's container (see ../../src/tools/list.ts).
//
// This replaces tests/harness/tools_list.test.ts, which checked the tool's
// name and its schema and never once ran it. Three bugs lived behind that:
// the listing began with the folder being listed, every directory in it was
// labelled a file, and asking for the top of the workspace listed nothing at
// all. Each has a test here that runs the thing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext } from '../../src/types';

const docker = vi.hoisted(() => ({
  exec: vi.fn(),
  WORKDIR: '/workspace',
  quote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
}));
vi.mock('../../src/sandbox/docker', () => docker);

import { MAX_DEPTH, MAX_ENTRIES, SKIPPED, command, format, registerTools, target, tools } from '../../src/tools/list';

const signal = new AbortController().signal;
const context: ToolContext = { signal, threadId: 'thread-1', workspace: '/Users/someone/projects/demo' };
const list = tools[0] as Tool;
// What the container says: the directories, the marker, then the files
const answered = (directories: string[], files: string[]) =>
  docker.exec.mockResolvedValue({ code: 0, output: [...directories, '<<<files>>>', ...files].join('\n') });
const ran = () => String(docker.exec.mock.calls[0][1]);

beforeEach(() => {
  vi.clearAllMocks();
  answered([], []);
});

describe('the path it is asked for', () => {
  it.each([
    ['nothing', undefined, '.'],
    ['an empty string', '   ', '.'],
    ['a folder', 'src/search', 'src/search'],
    ['one written from here', './src', 'src'],
    ['one with a trailing slash', 'src/', 'src'],
    ['the top, spelled out', '.', '.'],
  ])('reads %s as %s', (_name, given, wanted) => {
    expect(target(given)).toBe(wanted);
  });
});

describe('the command it runs in the container', () => {
  it('starts below the folder, so the folder is not listed as something inside itself', () => {
    // The bug this is for: `find src/sandbox` prints "src/sandbox" first, and
    // the listing opened with the folder itself, labelled a file
    expect(command('src/sandbox')).toContain('-mindepth 1');
  });

  it('asks for directories and files apart, there being no portable way to mark them', () => {
    const asked = command('.');
    expect(asked).toContain('-type d -print');
    expect(asked).toContain('-type f -print');
    expect(asked).toContain("echo '<<<files>>>'");
  });

  it('goes no deeper than it says, and brings back no more than it will show', () => {
    expect(command('.')).toContain(`-maxdepth ${MAX_DEPTH}`);
    expect(command('.')).toContain(`head -n ${MAX_ENTRIES + 1}`);
    expect(command('.', 2, 10)).toContain('-maxdepth 2');
    expect(command('.', 2, 10)).toContain('head -n 11');
  });

  it('walks past the folders that would bury the project', () => {
    const asked = command('.');
    for (const name of SKIPPED) expect(asked).toContain(`-name '${name}'`);
    expect(asked).toContain('-prune');
  });

  it('says plainly when there is nothing at the path, rather than listing nothing', () => {
    // An empty listing used to be what a missing path looked like: find's
    // complaint went to /dev/null and its exit code was swallowed by the pipe
    const asked = command('nope');
    expect(asked).toContain("if [ ! -e 'nope' ]");
    expect(asked).toContain("if [ ! -d 'nope' ]");
  });

  it('quotes the path, so one with a space or a quote in it cannot be two arguments', () => {
    expect(command("my files/o'brien")).toContain(`'my files/o'\\''brien'`);
  });
});

describe('what it shows', () => {
  it('marks folders as folders and files as files, each by its path', () => {
    answered(['./src', './src/search'], ['./src/main.ts', './src/search/index.ts']);
    const shown = format(
      ['./src', './src/search', '<<<files>>>', './src/main.ts', './src/search/index.ts'].join('\n'),
      '.'
    );
    expect(shown.split('\n').slice(2)).toEqual([
      '[DIR]  src',
      '[DIR]  src/search',
      '[FILE] src/main.ts',
      '[FILE] src/search/index.ts',
    ]);
    // Where the paths are relative to, since the model works in the container
    expect(shown).toContain('Workspace structure, in /workspace:');
  });

  it('gives each entry its path, not its name: "index.ts" alone says nothing', () => {
    const shown = format(['<<<files>>>', 'src/search/index.ts', 'src/llm/index.ts'].join('\n'), 'src');
    expect(shown).toContain('[FILE] src/search/index.ts');
    expect(shown).toContain('[FILE] src/llm/index.ts');
    expect(shown).toContain('Contents of "src":');
  });

  it('says what there is too much of, and what to do instead', () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const shown = format(['<<<files>>>', ...many].join('\n'), '.', 10);
    expect(shown.match(/^\[FILE]/gm)).toHaveLength(10);
    expect(shown).toContain('… and more, not listed');
    expect(shown).toContain('Give a path to look inside one of these folders');
  });

  it.each([
    ['nothing at the path', '<<<missing>>>', 'There is no "nope" in this thread\'s container.'],
    ['a file rather than a folder', '<<<file>>>', '"nope" is a file, not a folder. Use read_file to read it.'],
  ])('says so for %s', (_name, output, said) => {
    expect(format(output, 'nope')).toBe(said);
  });

  it('tells an empty folder from a missing one', () => {
    expect(format('<<<files>>>', 'src/empty')).toBe('"src/empty" is empty.');
    expect(format('<<<files>>>', '.')).toBe('The workspace is empty.');
  });
});

describe('running it', () => {
  it("lists the container's copy, never the workspace path on the user's computer", async () => {
    // The bug this is for: the path given to find was the workspace on the
    // host, which does not exist in the container, so every listing of the
    // top of the workspace came back empty
    await list.run({}, context);
    expect(ran()).not.toContain(context.workspace as string);
    expect(ran()).toContain("'.'");
  });

  it('passes on the path it was given', async () => {
    await list.run({ path: 'src/search' }, context);
    expect(ran()).toContain("'src/search'");
  });

  it('shows what came back', async () => {
    answered(['src/search'], ['src/main.ts']);
    const shown = String(await list.run({}, context));
    expect(shown).toContain('[DIR]  src/search');
    expect(shown).toContain('[FILE] src/main.ts');
  });

  it('says when the command itself failed, rather than showing an empty workspace', async () => {
    docker.exec.mockResolvedValue({ code: 1, output: 'no such container' });
    expect(String(await list.run({}, context))).toBe('The workspace could not be listed: no such container');
  });

  it.each([
    ['a path that is not text', { path: 7 }, context, '"path" must be a string'],
    ['a thread with no workspace', {}, { signal, threadId: 't' }, 'This thread has no workspace to list.'],
  ])('refuses %s', async (_name, input, where, message) => {
    await expect(list.run(input as Record<string, unknown>, where as ToolContext)).rejects.toThrow(message);
  });
});

describe('the tool itself', () => {
  it('is offered only in a thread that has a workspace, and takes an optional path', () => {
    expect(list).toMatchObject({ name: 'list_workspace', needsWorkspace: true });
    expect(list.inputSchema).toMatchObject({ type: 'object', required: [] });
    expect((list.inputSchema as { properties: { path: unknown } }).properties.path).toBeDefined();
  });

  it('registers with the registry it is given', () => {
    const registry = { register: vi.fn() };
    registerTools(registry);
    expect(registry.register.mock.calls.map(([tool]) => tool.name)).toEqual(['list_workspace']);
  });
});
