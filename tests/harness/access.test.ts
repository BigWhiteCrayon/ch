// Asking the user before the model reads a file on their computer, and
// remembering what they allowed (see ../../src/harness/access.ts).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as access from '../../src/harness/access';
import type { HarnessEvent } from '../../src/types';

let dir: string;
let global: string[];
let workspaces: Record<string, string[]>;
const allow = vi.fn((workspace: string, entry: string) => {
  workspaces[workspace] = [...(workspaces[workspace] ?? []), entry];
});

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-access-')));
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.writeFileSync(path.join(dir, 'notes', 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  global = [];
  workspaces = {};
  allow.mockClear();
  access.configure({
    readable: (workspace) => [...global, ...(workspace ? (workspaces[workspace] ?? []) : [])],
    allow,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A call to permitted() with the question it asks collected, and answered if asked to
function ask(
  target: string,
  said?: 'deny' | 'once' | 'thread' | 'file' | 'folder',
  workspace: string | null = '/w',
  threadId?: string
) {
  const asked: HarnessEvent[] = [];
  const controller = new AbortController();
  const emit = (event: HarnessEvent) => {
    asked.push(event);
    if (said && event.type === 'file_access') queueMicrotask(() => access.answer(event.id, said));
  };
  const isFolder = fs.statSync(target).isDirectory();
  const result = access.permitted(target, isFolder, {
    workspace: workspace ?? undefined,
    threadId,
    signal: controller.signal,
    emit,
  });
  return { result, asked, controller };
}

describe('the path the model names', () => {
  it('is the real path, so a link cannot stand in for what it points to', () => {
    fs.symlinkSync(path.join(dir, 'b.txt'), path.join(dir, 'link'));
    expect(access.resolve(path.join(dir, 'link'))).toBe(path.join(dir, 'b.txt'));
    expect(access.resolve(path.join(dir, 'notes', '..', 'b.txt'))).toBe(path.join(dir, 'b.txt'));
  });

  it('may start from the home folder', () => {
    expect(access.resolve('~')).toBe(fs.realpathSync(os.homedir()));
  });

  it('has to be absolute, but not to exist, which would tell the model what does before it asks', () => {
    expect(() => access.resolve('notes/a.txt')).toThrow('not an absolute path');
    expect(access.resolve(path.join(dir, 'nope'))).toBe(path.join(dir, 'nope'));
  });

  it('is the real path of the deepest folder that is there, with the rest after it', () => {
    fs.symlinkSync(path.join(dir, 'notes'), path.join(dir, 'link'));
    expect(access.resolve(path.join(dir, 'link', 'new', 'x.txt'))).toBe(path.join(dir, 'notes', 'new', 'x.txt'));
  });
});

describe("whether a path is in the thread's own workspace", () => {
  it('is the path from the workspace root, whether or not the file is there', () => {
    expect(access.relativeToWorkspace(dir, path.join(dir, 'notes', 'a.txt'))).toBe(path.join('notes', 'a.txt'));
    expect(access.relativeToWorkspace(dir, path.join(dir, 'new.txt'))).toBe('new.txt');
    expect(access.relativeToWorkspace(dir, dir)).toBe('');
  });

  it('is null outside it, for a folder that only shares its name, and with no workspace', () => {
    expect(access.relativeToWorkspace(path.join(dir, 'notes'), path.join(dir, 'b.txt'))).toBeNull();
    expect(access.relativeToWorkspace(path.join(dir, 'note'), path.join(dir, 'notes', 'a.txt'))).toBeNull();
    expect(access.relativeToWorkspace(undefined, dir)).toBeNull();
  });

  it('follows a link to the workspace', () => {
    fs.symlinkSync(dir, `${dir}-link`);
    try {
      expect(access.relativeToWorkspace(`${dir}-link`, path.join(dir, 'b.txt'))).toBe('b.txt');
    } finally {
      fs.rmSync(`${dir}-link`);
    }
  });
});

describe('what is allowed without asking', () => {
  it('is the file or folder on a list, and what is inside a folder on it', () => {
    global = [path.join(dir, 'notes')];
    workspaces['/w'] = [path.join(dir, 'b.txt')];
    expect(access.allowed('/w', path.join(dir, 'notes'))).toBe(true);
    expect(access.allowed('/w', path.join(dir, 'notes', 'a.txt'))).toBe(true);
    expect(access.allowed('/w', path.join(dir, 'b.txt'))).toBe(true);
  });

  it('is not a sibling that only starts with the same name', () => {
    fs.mkdirSync(path.join(dir, 'notes-private'));
    global = [path.join(dir, 'notes')];
    expect(access.allowed('/w', path.join(dir, 'notes-private'))).toBe(false);
  });

  it("holds a workspace's own list for that workspace only", () => {
    workspaces['/w'] = [path.join(dir, 'b.txt')];
    expect(access.allowed('/other', path.join(dir, 'b.txt'))).toBe(false);
    expect(access.allowed(undefined, path.join(dir, 'b.txt'))).toBe(false);
  });

  it('holds the global list for every workspace, and for a thread without one', () => {
    global = [dir];
    expect(access.allowed('/other', path.join(dir, 'b.txt'))).toBe(true);
    expect(access.allowed(undefined, path.join(dir, 'b.txt'))).toBe(true);
  });

  it('follows a link in a list to where it points', () => {
    const link = path.join(dir, 'link');
    fs.symlinkSync(path.join(dir, 'notes'), link);
    global = [link];
    expect(access.allowed('/w', path.join(dir, 'notes', 'a.txt'))).toBe(true);
  });
});

describe('asking the user', () => {
  it('does not ask about what is allowed already', async () => {
    global = [dir];
    const { result, asked } = ask(path.join(dir, 'b.txt'));
    expect(await result).toBe(true);
    expect(asked).toEqual([]);
  });

  it('asks about the file, naming it and the folder it is in', async () => {
    const target = path.join(dir, 'notes', 'a.txt');
    const { result, asked } = ask(target, 'once');
    expect(await result).toBe(true);
    expect(asked).toEqual([
      {
        type: 'file_access',
        id: expect.any(String),
        path: target,
        folder: path.join(dir, 'notes'),
        isFolder: false,
        canRemember: true,
      },
    ]);
  });

  it('says a yes cannot be kept when there is no workspace to keep it in', async () => {
    const { result, asked } = ask(path.join(dir, 'b.txt'), 'folder', null);
    expect(await result).toBe(true);
    expect(asked[0]).toMatchObject({ canRemember: false });
    expect(allow).not.toHaveBeenCalled();
  });

  it('matches a file that is not there yet against an allowed folder', () => {
    global = [path.join(dir, 'notes')];
    expect(access.allowed('/w', access.resolve(path.join(dir, 'notes', 'new', 'x.txt')))).toBe(true);
  });

  it('asks about a folder as itself', async () => {
    const target = path.join(dir, 'notes');
    const { asked, result } = ask(target, 'once');
    await result;
    expect(asked[0]).toMatchObject({ path: target, folder: target, isFolder: true });
  });

  it('says no when the user does, and remembers nothing', async () => {
    const { result } = ask(path.join(dir, 'b.txt'), 'deny');
    expect(await result).toBe(false);
    expect(allow).not.toHaveBeenCalled();
  });

  it('says yes for this once without remembering it', async () => {
    const { result } = ask(path.join(dir, 'b.txt'), 'once');
    expect(await result).toBe(true);
    expect(allow).not.toHaveBeenCalled();
    expect(ask(path.join(dir, 'b.txt')).asked).toHaveLength(1);
  });

  it('remembers a yes for this thread only, with or without a workspace, and writes nothing down', async () => {
    const target = path.join(dir, 'notes');
    expect(await ask(target, 'thread', null, 't1').result).toBe(true);
    expect(allow).not.toHaveBeenCalled();
    const again = ask(path.join(dir, 'notes', 'a.txt'), undefined, null, 't1');
    expect(await again.result).toBe(true);
    expect(again.asked).toEqual([]);
    expect(ask(path.join(dir, 'notes', 'a.txt'), undefined, null, 't2').asked).toHaveLength(1);
    expect(ask(path.join(dir, 'b.txt'), undefined, null, 't1').asked).toHaveLength(1);
  });

  it('cannot keep a yes for a thread when there is no thread', async () => {
    const target = path.join(dir, 'b.txt');
    expect(await ask(target, 'thread', null).result).toBe(true);
    expect(ask(target, undefined, null).asked).toHaveLength(1);
  });

  it('remembers a file for the workspace, and then asks no more about it', async () => {
    const target = path.join(dir, 'notes', 'a.txt');
    expect(await ask(target, 'file').result).toBe(true);
    expect(allow).toHaveBeenCalledWith('/w', target);
    const again = ask(target);
    expect(await again.result).toBe(true);
    expect(again.asked).toEqual([]);
  });

  it('remembers the folder when that is what was allowed, and so allows its other files', async () => {
    expect(await ask(path.join(dir, 'notes', 'a.txt'), 'folder').result).toBe(true);
    expect(allow).toHaveBeenCalledWith('/w', path.join(dir, 'notes'));
    expect(access.allowed('/w', path.join(dir, 'notes', 'other.txt'))).toBe(true);
    expect(access.allowed('/w', path.join(dir, 'b.txt'))).toBe(false);
  });

  it('has nowhere to remember a yes for good in a thread without a workspace, and says yes once', async () => {
    expect(await ask(path.join(dir, 'b.txt'), 'file', null).result).toBe(true);
    expect(allow).not.toHaveBeenCalled();
  });

  it('says no when the reply is cancelled while the question is waiting', async () => {
    const { result, controller } = ask(path.join(dir, 'b.txt'));
    controller.abort();
    expect(await result).toBe(false);
  });

  it('says no, without asking, when the reply was already cancelled or nobody can be asked', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = path.join(dir, 'b.txt');
    expect(await access.permitted(target, false, { workspace: '/w', signal: controller.signal, emit: vi.fn() })).toBe(
      false
    );
    expect(await access.permitted(target, false, { workspace: '/w', signal: new AbortController().signal })).toBe(
      false
    );
  });

  it('takes an answer it does not know for a no, and ignores one for a question that is gone', async () => {
    const asked: HarnessEvent[] = [];
    const result = access.permitted(path.join(dir, 'b.txt'), false, {
      workspace: '/w',
      signal: new AbortController().signal,
      emit: (event) => asked.push(event),
    });
    const { id } = asked[0] as { id: string };
    access.answer(id, 'always' as never);
    expect(await result).toBe(false);
    expect(() => access.answer(id, 'once')).not.toThrow();
  });
});

// A command on the user's own computer that could lose work: shown to them as
// itself, allowed for the one command, remembered for nothing
describe('a command that has to be allowed by name', () => {
  const confirm = (command: string, say?: boolean) => {
    const asked: HarnessEvent[] = [];
    const controller = new AbortController();
    const result = access.confirmed(command, dir, 'it forces', {
      signal: controller.signal,
      emit: (event) => {
        asked.push(event);
        if (say !== undefined && event.type === 'command_access') {
          queueMicrotask(() => access.allowCommand(event.id, say));
        }
      },
    });
    return { result, asked, controller };
  };

  it('asks with the command, the folder and what is risky about it', async () => {
    const { result, asked } = confirm('git push --force', true);
    expect(await result).toBe(true);
    expect(asked[0]).toMatchObject({
      type: 'command_access',
      command: 'git push --force',
      path: dir,
      why: 'it forces',
    });
  });

  it('is a no when they say no', async () => {
    const { result } = confirm('git reset --hard', false);
    expect(await result).toBe(false);
  });

  // However much of the folder has been allowed before: a yes to reading there
  // is not a yes to a command that could empty it
  it('asks even where the folder is allowed for good', async () => {
    global = [dir];
    const { result, asked } = confirm('git clean -fd', true);
    expect(await result).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('is a no when the reply is cancelled while it waits, and asks nobody twice', async () => {
    const { result, controller, asked } = confirm('git push --force');
    controller.abort();
    expect(await result).toBe(false);
    const { id } = asked[0] as { id: string };
    expect(() => access.allowCommand(id, true)).not.toThrow();
  });

  it('is a no where there is nobody to ask, as in a look at a workspace', async () => {
    expect(await access.confirmed('git push -f', dir, 'it forces', { signal: new AbortController().signal })).toBe(
      false
    );
  });
});
