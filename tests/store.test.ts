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
