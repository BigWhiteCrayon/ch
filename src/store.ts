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

// The id of every thread there is, or null when that cannot be told: nothing
// saved yet, or a file that would not parse. Read straight off the file rather
// than through load(), which has the window's copy of it to think about.
//
// For finding the sandboxes whose thread is gone (see sweep in
// sandbox/docker.ts), where null has to mean "cannot tell" and not "none":
// a file that cannot be read is no reason to take a thread's container away.
// An entry without an id makes the whole answer null for the same reason.
export function threadIds(): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return null;
  }
  const threads = (parsed as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) return null;
  const ids = threads.map((thread) => (thread as { id?: unknown } | null)?.id);
  if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) return null;
  return ids;
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

// The screenshots and clips a reply took. Kept in a sidecar beside the threads
// rather than in them, so a thread's JSON does not carry tens of megabytes of
// base64 (see the comment on save in renderer/threads.ts): the JSON names each
// one by id, and this holds its bytes, keyed by that id.
//
// Capped, so a thread that has taken a great many over the years does not grow
// the sidecar without bound: the most recent MAX_MEDIA are kept, by the order
// they were added. An item that falls out of the cap is simply not found again
// on the next load — its ref in the JSON is left in place, and a ref whose
// bytes are gone draws as nothing.
export const MAX_MEDIA = 200;
const mediaPath = () => path.join(app.getPath('userData'), 'media.json');

// The sidecar as a map of id -> the item's bytes, or {} if it has never been
// written. As with the threads, a file that can't be read as JSON is moved
// aside, not written over.
function readMedia(): Record<string, { mediaType: string; data: string }> {
  let text: string;
  try {
    text = fs.readFileSync(mediaPath(), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, { mediaType: string; data: string }>) : {};
  } catch (err) {
    log.error('media.load', { ok: false, error: (err as Error).message });
    try {
      fs.renameSync(mediaPath(), `${mediaPath()}.unreadable`);
    } catch {}
    return {};
  }
}

// Hangs the new items onto the sidecar and keeps only the most recent, writing
// it whole (atomic, as the threads file is) so a crash or a forced quit leaves
// the last complete sidecar rather than half of a new one. Never throws.
export function saveMedia(items: { id: string; mediaType: string; data: string }[]): void {
  // Nearly every save has nothing new, and the window waits on this one
  if (items.length === 0) return;
  const held = readMedia();
  for (const item of items) {
    if (!item?.id || item.data === undefined) continue;
    held[item.id] = { mediaType: item.mediaType, data: item.data };
  }
  const keys = Object.keys(held);
  if (keys.length > MAX_MEDIA) for (const key of keys.slice(0, keys.length - MAX_MEDIA)) delete held[key];
  const file = mediaPath();
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(held), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    log.error('media.save', { ok: false, error: (err as Error).message });
  }
}

// The sidecar as JSON, or null if nothing is in it — the window hangs these back
// on the media the threads' JSON names by id when it loads (see load in
// renderer/threads.ts).
export function loadMedia(): string | null {
  const held = readMedia();
  return Object.keys(held).length ? JSON.stringify(held) : null;
}
