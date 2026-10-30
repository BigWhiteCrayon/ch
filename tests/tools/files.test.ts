// Reading files on the user's own computer (see ../../src/tools/files.ts).
// The asking is tested in ../harness/access.test.ts; here it is what the tool
// reads once it has been allowed, and that it reads nothing before.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as access from '../../src/harness/access';
import { tool } from '../../src/tools/files';
import type { HarnessEvent, ToolContext } from '../../src/types';

let dir: string;
let asked: HarnessEvent[];
let answer: 'deny' | 'once' | 'file' | 'folder';

const context = (extra: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  threadId: 't',
  workspace: '/w',
  emit: (event) => {
    asked.push(event);
    if (event.type === 'file_access') queueMicrotask(() => access.answer(event.id, answer));
  },
  ...extra,
});
const read = (input: Record<string, unknown>, extra?: Partial<ToolContext>) => tool.run(input, context(extra));

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-files-')));
  asked = [];
  answer = 'once';
  access.configure({ readable: () => [], allow: vi.fn() });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('read_user_file', () => {
  it('is the one tool that reads outside the container, and says the user is asked', () => {
    expect(tool.name).toBe('read_user_file');
    expect(tool.description).toContain('The user is asked before anything is read');
  });

  it('reads a file with its line numbers, once the user says yes', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    expect(await read({ path: file })).toBe('1: one\n2: two\n3: three');
    expect(asked).toHaveLength(1);
  });

  it('reads nothing, and says so, when the user says no', async () => {
    const file = path.join(dir, 'secret.txt');
    fs.writeFileSync(file, 'hunter2');
    answer = 'deny';
    await expect(read({ path: file })).rejects.toThrow(`The user did not allow reading ${file}.`);
  });

  it('reads nothing when there is nobody to ask, as in a subagent', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one');
    await expect(read({ path: file }, { emit: undefined })).rejects.toThrow('did not allow');
  });

  it('does not ask again about what the user allowed for good', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one');
    access.configure({ readable: () => [dir], allow: vi.fn() });
    expect(await read({ path: file })).toBe('1: one');
    expect(asked).toEqual([]);
  });

  it('reads a page at a time, and says where to read on from', async () => {
    const file = path.join(dir, 'long.txt');
    fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    expect(await read({ path: file, start_line: 3, line_count: 2 })).toBe(
      '3: line 3\n4: line 4\n… 6 more lines; read on from start_line 5'
    );
    expect(await read({ path: file, start_line: 11 })).toBe(`${file} has 10 lines, so there is nothing at line 11.`);
  });

  it('says so about an empty file, and refuses one that is not text', async () => {
    const empty = path.join(dir, 'empty.txt');
    const binary = path.join(dir, 'a.bin');
    fs.writeFileSync(empty, '');
    fs.writeFileSync(binary, Buffer.from([1, 0, 2]));
    expect(await read({ path: empty })).toBe(`${empty} is empty.`);
    await expect(read({ path: binary })).rejects.toThrow('not a text file');
  });

  it('says a file too large to read is searched with run_host_command, in its folder', async () => {
    const file = path.join(dir, 'big.log');
    fs.writeFileSync(file, Buffer.alloc(5_000_001, 97));
    await expect(read({ path: file })).rejects.toThrow(
      `${file} is 5000001 bytes, which is too large to read. Search or sample it with run_host_command instead ` +
        `with path ${dir}, for example "rg -n PATTERN ./big.log"`
    );
    const spaced = path.join(dir, 'big file.log');
    fs.renameSync(file, spaced);
    await expect(read({ path: spaced })).rejects.toThrow('with run_host_command instead.');
  });

  it('lists a folder, which the user is asked about as a folder', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    expect(await read({ path: dir })).toBe(
      `Contents of ${dir}:\n\n[FILE] ${path.join(dir, 'a.txt')}\n[DIR] ${path.join(dir, 'sub')}`
    );
    expect(asked[0]).toMatchObject({ path: dir, isFolder: true });
  });

  it('asks about where a link leads, not about the link', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one');
    fs.symlinkSync(file, path.join(dir, 'link'));
    await read({ path: path.join(dir, 'link') });
    expect(asked[0]).toMatchObject({ path: file });
  });

  it('refuses what is not a path before asking anything', async () => {
    await expect(read({})).rejects.toThrow('"path" must be a non-empty string');
    await expect(read({ path: 'relative/file' })).rejects.toThrow('not an absolute path');
    expect(asked).toEqual([]);
  });

  it('asks about a path that is not there, and says so only after a yes', async () => {
    const missing = path.join(dir, 'nope');
    await expect(read({ path: missing })).rejects.toThrow(`Could not find ${missing}: ENOENT`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ path: missing, isFolder: false });
  });

  it('says a path in the container is read with read_file, once it is found not to be there', async () => {
    await expect(read({ path: '/workspace/no-such-file.ts' })).rejects.toThrow('read_file and list_workspace read');
  });

  it("sends a path in the thread's own workspace to its copy, without asking", async () => {
    const file = path.join(dir, 'src', 'a.txt');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'original');
    await expect(read({ path: file }, { workspace: dir })).rejects.toThrow(
      'this thread has its own copy, at /workspace/src/a.txt'
    );
    await expect(read({ path: dir }, { workspace: dir })).rejects.toThrow('at /workspace,');
    expect(asked).toEqual([]);
  });

  it('reads a path in the workspace when the thread has no copy of it, and not one outside it', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one');
    expect(await read({ path: file }, { workspace: dir, threadId: undefined })).toBe('1: one');
    expect(await read({ path: file }, { workspace: path.join(dir, 'other') })).toBe('1: one');
    expect(asked).toHaveLength(2);
  });

  it('does not ask about missing file in allowed folder, and says it is not there', async () => {
    access.configure({ readable: () => [dir], allow: vi.fn() });
    await expect(read({ path: path.join(dir, 'sub', 'nope.txt') })).rejects.toThrow('Could not find');
    expect(asked).toEqual([]);
  });

  it('says the same after a no about a path that is not there as about one that is', async () => {
    const there = path.join(dir, 'a.txt');
    fs.writeFileSync(there, 'one');
    answer = 'deny';
    const refusal = async (file: string) => {
      try {
        await read({ path: file });
        return 'read';
      } catch (err) {
        return (err as Error).message.replace(file, '<path>');
      }
    };
    const missing = await refusal(path.join(dir, 'nope.txt'));
    expect(missing).toContain('did not allow');
    expect(missing).toBe(await refusal(there));
    expect(asked.map((event) => event.type)).toEqual(['file_access', 'file_access']);
  });
});
