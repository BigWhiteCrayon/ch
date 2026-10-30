// Debug log: what the app did, whether it worked and how long it took, for
// working out afterwards what went wrong. One JSON object per line, in a file
// in the app's log workspace (see init).
//
// Most lines hold only names, sizes, timings, outcomes and error messages.
// The exception is what goes to and comes from a model (see content), which
// is logged in full: the log therefore holds the user's conversations.
//
// Logging never throws, and does nothing until init() is called, so the
// modules that log can be used (and tested) without a log file.

import fs from 'fs';
import path from 'path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export const FILE_NAME = 'ch.log';
// What the evals log to instead, so that a run of them cannot push the app's own
// lines out of ch.log, and so that reading back what a suite did means reading
// one file of nothing else (see evals/run.ts)
export const EVAL_FILE_NAME = 'evals.log';
// A full log is moved aside as ch.log.1, replacing the one before it
export const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2000; // characters of any one string kept

let file: string | null = null;
let size = 0;

// Starts logging to the given workspace, and returns the file's path. The name
// is the app's own log unless something else asks for its own file, as the evals
// do: everything that logs is shared with them, and their lines are not the
// app's.
export function init(dir: string, name: string = FILE_NAME): string {
  file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.statSync(file).size;
  } catch {
    size = 0; // no log yet
  }
  return file;
}

// The directory the log is in, for what is kept beside it; null until init()
export const directory = (): string | null => (file ? path.dirname(file) : null);

// An error is logged as its message and stack, and a long string is cut short
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (typeof value === 'string' && value.length > MAX_TEXT) return `${value.slice(0, MAX_TEXT)} [...]`;
  return value;
}

// As replacer, but strings are kept whole
function wholeReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}

function write(level: Level, event: string, fields: Fields = {}, whole = false): void {
  if (!file) return;
  try {
    const entry = { time: new Date().toISOString(), level, event, ...fields };
    const line = `${JSON.stringify(entry, whole ? wholeReplacer : replacer)}\n`;
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
      size = 0;
    }
    // Written at once, so the lines leading up to a crash are in the file
    fs.appendFileSync(file, line, { mode: 0o600 });
    size += bytes;
  } catch {
    // A log that can't be written must not break what it was logging
  }
}

export const debug = (event: string, fields?: Fields) => write('debug', event, fields);
export const info = (event: string, fields?: Fields) => write('info', event, fields);
export const warn = (event: string, fields?: Fields) => write('warn', event, fields);
export const error = (event: string, fields?: Fields) => write('error', event, fields);
// For what a model was sent or wrote: logged at debug level, with nothing cut short
export const content = (event: string, fields?: Fields) => write('debug', event, fields, true);

// Milliseconds since a time taken with performance.now()
export const since = (start: number) => Math.round(performance.now() - start);

// Logs whatever would otherwise bring the process down or pass unnoticed.
// Neither is handled here: a crash still crashes.
export function watchProcess(): void {
  process.on('uncaughtExceptionMonitor', (err) => error('process.crash', { error: err }));
  process.on('unhandledRejection', (reason) => {
    error('process.unhandled_rejection', { error: reason });
    console.error('Unhandled rejection:', reason);
  });
}
