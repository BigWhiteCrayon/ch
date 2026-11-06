import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }));

const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../src/log', () => log);

import * as store from '../src/store';

const file = () => path.join(electron.userData, 'threads.json');
const state = JSON.stringify({ threads: [{ id: 't1', messages: [{ role: 'user', text: 'hi' }] }], activeId: 't1' });

beforeEach(() => {
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-'));
  log.error.mockReset();
});

afterEach(() => {
  fs.rmSync(electron.userData, { recursive: true, force: true });
});

describe('load', () => {
  it('is null when nothing has been saved', () => {
    expect(store.load()).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns what was saved, as after a restart', () => {
    store.save(state);
    expect(store.load()).toBe(state);
  });

  it('moves a file that is not JSON aside instead of using or overwriting it', () => {
    fs.writeFileSync(file(), '{"threads": [half a fi');
    expect(store.load()).toBeNull();
    expect(log.error).toHaveBeenCalledWith('threads.load', expect.objectContaining({ ok: false }));
    expect(fs.readFileSync(`${file()}.unreadable`, 'utf8')).toBe('{"threads": [half a fi');

    store.save(state);
    expect(store.load()).toBe(state);
    expect(fs.existsSync(`${file()}.unreadable`)).toBe(true);
  });
});

describe('threadIds', () => {
  it('names every thread there is', () => {
    store.save(JSON.stringify({ threads: [{ id: 't1' }, { id: 't2' }] }));
    expect(store.threadIds()).toEqual(['t1', 't2']);
  });

  it('is an empty list when the threads were all deleted', () => {
    store.save(JSON.stringify({ threads: [] }));
    expect(store.threadIds()).toEqual([]);
  });

  // The caller takes away the sandboxes of threads that are not named, so
  // "cannot tell" has to be told from "none" (see sweep in sandbox/docker.ts)
  it('is null when there is nothing to read it from', () => {
    expect(store.threadIds()).toBeNull();
  });

  it('is null when the file is not JSON, and leaves it where it is', () => {
    fs.writeFileSync(file(), '{"threads": [half a fi');
    expect(store.threadIds()).toBeNull();
    expect(fs.existsSync(`${file()}.unreadable`)).toBe(false);
  });

  it('is null when it is not the shape it should be, or a thread has no id', () => {
    store.save(JSON.stringify({ activeId: 't1' }));
    expect(store.threadIds()).toBeNull();
    store.save(JSON.stringify({ threads: [{ id: 't1' }, { title: 'no id' }] }));
    expect(store.threadIds()).toBeNull();
    store.save(JSON.stringify({ threads: [{ id: '' }] }));
    expect(store.threadIds()).toBeNull();
  });
});

describe('save', () => {
  it('replaces the file whole, leaving nothing else behind', () => {
    store.save(state);
    store.save('{"threads":[]}');
    expect(fs.readFileSync(file(), 'utf8')).toBe('{"threads":[]}');
    expect(fs.readdirSync(electron.userData)).toEqual(['threads.json']);
  });

  it('writes the file readable only by the user', () => {
    store.save(state);
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('keeps the last complete copy when a save fails part-way, and logs the failure', () => {
    store.save(state);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => store.save('{"threads":[]}')).not.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe(state);
    expect(log.error).toHaveBeenCalledWith('threads.save', expect.objectContaining({ ok: false, error: 'disk full' }));
  });
});

const mediaFile = () => path.join(electron.userData, 'media.json');
const shot = (id: string) => ({ id, mediaType: 'image/png', data: `base64-${id}` });

describe('the media sidecar', () => {
  it('is null when nothing has been saved', () => {
    expect(store.loadMedia()).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps what was written, as after a restart', () => {
    store.saveMedia([shot('a'), shot('b')]);
    expect(JSON.parse(store.loadMedia() as string)).toEqual({
      a: { mediaType: 'image/png', data: 'base64-a' },
      b: { mediaType: 'image/png', data: 'base64-b' },
    });
  });

  // Most saves have nothing new, and the window waits on every one
  it('leaves the sidecar alone when there is nothing new', () => {
    store.saveMedia([shot('a')]);
    const write = vi.spyOn(fs, 'writeFileSync');
    const read = vi.spyOn(fs, 'readFileSync');
    store.saveMedia([]);
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(store.loadMedia() as string))).toEqual(['a']);
  });

  // Writes are added to what is there, not over it: a shot taken in an earlier
  // session is still on hand when a later one is saved
  it('adds to what is there rather than replacing it', () => {
    store.saveMedia([shot('a')]);
    store.saveMedia([shot('b')]);
    expect(Object.keys(JSON.parse(store.loadMedia() as string))).toEqual(['a', 'b']);
  });

  // An item with no id or no bytes has nothing to keep: it is left out, and the
  // one beside it that can be kept is
  it('writes nothing for an item with no id or no bytes', () => {
    store.saveMedia([
      { id: 'a', mediaType: 'image/png', data: 'base64-a' },
      { mediaType: 'image/png', data: 'base64-x' },
    ]);
    expect(JSON.parse(store.loadMedia() as string)).toEqual({ a: { mediaType: 'image/png', data: 'base64-a' } });
  });

  // A thread that has taken a great many screenshots over the years does not
  // grow the sidecar without bound: the most recent MAX_MEDIA are kept, by the
  // order they came in, and the older ones fall out
  it('keeps only the most recent MAX_MEDIA, the older ones falling out', () => {
    for (let i = 0; i < store.MAX_MEDIA + 50; i++) store.saveMedia([shot(String(i))]);
    const kept = Object.keys(JSON.parse(store.loadMedia() as string));
    expect(kept).toHaveLength(store.MAX_MEDIA);
    expect(kept[0]).toBe('50'); // the first fifty have fallen out
    expect(kept.at(-1)).toBe(String(store.MAX_MEDIA + 49));
  });

  it('moves a sidecar that is not JSON aside instead of using or overwriting it', () => {
    fs.writeFileSync(mediaFile(), '{ half a fi');
    expect(store.loadMedia()).toBeNull();
    expect(log.error).toHaveBeenCalledWith('media.load', expect.objectContaining({ ok: false }));
    expect(fs.readFileSync(`${mediaFile()}.unreadable`, 'utf8')).toBe('{ half a fi');

    store.saveMedia([shot('a')]);
    expect(JSON.parse(store.loadMedia() as string)).toEqual({ a: { mediaType: 'image/png', data: 'base64-a' } });
  });

  // The bytes are written beside the threads, not in them: the threads file
  // still holds only the threads, and the sidecar is its own file
  it('keeps the bytes out of the threads file, in a sidecar beside it', () => {
    store.save(state);
    store.saveMedia([shot('a')]);
    expect(fs.readFileSync(file(), 'utf8')).toBe(state);
    expect(fs.existsSync(mediaFile())).toBe(true);
  });
});

// What an app being tested starts from (see tests/fixtures/user-data/README.md): saved by the app itself, and read by
// it as it reads its own
describe('the threads an app being tested starts with', () => {
  it('are read as the threads the app saved, each with its messages', () => {
    // A copy, since the folder each test is given is cleared after it
    fs.cpSync(path.join(__dirname, 'fixtures/user-data'), electron.userData, { recursive: true });
    const saved = JSON.parse(store.load()!) as {
      activeId: string;
      threads: { id: string; title: string; messages: { role: string }[] }[];
    };
    expect(saved.threads.map((thread) => thread.title)).toEqual([
      'A reply that failed',
      'A question answered',
      'A long conversation',
      'A short conversation',
    ]);
    expect(saved.threads.every((thread) => thread.id && thread.messages.length > 0)).toBe(true);
    expect(saved.threads.find((thread) => thread.title === 'A reply that failed')!.messages.at(-1)!.role).toBe('error');
  });
});
