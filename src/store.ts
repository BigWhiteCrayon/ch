// Where the threads and their messages are kept between sessions: one JSON
// file in the app's data folder. The window owns what is in it (see
// renderer.ts) and hands it over whole each time it changes.
//
// The file is replaced in one step, so a crash or a forced quit mid-write
// leaves the last complete copy rather than half of a new one.
// Only usable after the app's 'ready' event.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as log from './log';

const filePath = () => path.join(app.getPath('userData'), 'threads.json');

// The saved state as JSON, or null if nothing usable is saved. A file that
// can't be read as JSON is moved aside, not written over.
export function load(): string | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath(), 'utf8');
  } catch {
    return null; // nothing saved yet
  }
  try {
    JSON.parse(text);
    return text;
  } catch (err) {
    log.error('threads.load', { ok: false, error: (err as Error).message });
    try {
      fs.renameSync(filePath(), `${filePath()}.unreadable`);
    } catch {}
    return null;
  }
}

// Never throws: a save that fails is logged, and the next one tries again.
export function save(json: string): void {
  const file = filePath();
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, json, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    log.error('threads.save', { ok: false, bytes: json.length, error: (err as Error).message });
  }
}
