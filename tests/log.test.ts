import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let log: typeof import('../src/log');
let dir: string;
const file = () => path.join(dir, 'ch.log');
const lines = (name = file()) =>
  fs
    .readFileSync(name, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-log-'));
  // A fresh copy of the module, as after an app restart
  vi.resetModules();
  log = await import('../src/log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('before init', () => {
  it('logs nowhere and does not throw', () => {
    expect(() => log.error('too.early', { a: 1 })).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// The evals log too, and their lines are not the app's: a run of them would
// otherwise push the app's out of ch.log, and reading back what a suite did would
// mean picking it out of everything else
describe('a log of its own', () => {
  it('writes to the name it is given rather than the app log', () => {
    const evals = path.join(dir, log.EVAL_FILE_NAME);
    expect(log.init(dir, log.EVAL_FILE_NAME)).toBe(evals);
    log.info('eval.start', { suites: ['notes'] });
    expect(lines(evals)[0]).toMatchObject({ event: 'eval.start', suites: ['notes'] });
    // ...and nothing reached the app's own
    expect(fs.existsSync(file())).toBe(false);
  });

  it('is a different file from the app log, so one cannot rotate the other away', () => {
    expect(log.EVAL_FILE_NAME).not.toBe(log.FILE_NAME);
  });

  it('is the app log when no name is asked for', () => {
    expect(log.init(dir)).toBe(path.join(dir, log.FILE_NAME));
  });
});

describe('logging', () => {
  it('writes one JSON line per entry, with its time, level, event and fields', () => {
    expect(log.init(dir)).toBe(file());
    log.info('tool.call', { tool: 'run_command', ok: true, ms: 12 });
    log.warn('tool.call', { tool: 'read_file', ok: false });
    log.debug('quiet');
    log.error('loud');

    const written = lines();
    expect(written.map((l) => l.level)).toEqual(['info', 'warn', 'debug', 'error']);
    expect(written[0]).toMatchObject({ event: 'tool.call', tool: 'run_command', ok: true, ms: 12 });
    expect(new Date(written[0].time).toISOString()).toBe(written[0].time);
  });

  it('creates the log workspace, and keeps the file readable only by the user', () => {
    dir = path.join(dir, 'nested', 'logs');
    log.init(dir);
    log.info('hello');
    expect(lines()).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('adds to the log left by an earlier session', () => {
    fs.writeFileSync(file(), `${JSON.stringify({ event: 'earlier' })}\n`);
    log.init(dir);
    log.info('later');
    expect(lines().map((l) => l.event)).toEqual(['earlier', 'later']);
  });

  it('logs an error as its message and stack, and cuts a long string short', () => {
    log.init(dir);
    log.error('failed', { error: new Error('boom'), output: 'x'.repeat(5000) });
    const [entry] = lines();
    expect(entry.error.message).toBe('boom');
    expect(entry.error.stack).toContain('log.test.ts');
    expect(entry.output).toHaveLength(2000 + ' [...]'.length);
  });

  it('keeps what a model was sent or wrote whole, at debug level', () => {
    log.init(dir);
    log.content('llm.input', { system: 'x'.repeat(5000), messages: [{ role: 'user', content: 'y'.repeat(5000) }] });
    const [entry] = lines();
    expect(entry).toMatchObject({ level: 'debug', event: 'llm.input' });
    expect(entry.system).toHaveLength(5000);
    expect(entry.messages[0].content).toHaveLength(5000);
  });

  it('never throws, even when the entry or the file cannot be written', () => {
    log.init(dir);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info('circular', circular)).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => log.info('nowhere')).not.toThrow();
  });
});

describe('rotation', () => {
  it('moves a full log aside and starts a new one, keeping one old file', () => {
    fs.writeFileSync(file(), 'x'.repeat(log.MAX_BYTES - 10));
    fs.writeFileSync(`${file()}.1`, 'the log before that');
    log.init(dir);
    log.info('first.in.new.file');
    log.info('second');

    expect(lines().map((l) => l.event)).toEqual(['first.in.new.file', 'second']);
    expect(fs.statSync(`${file()}.1`).size).toBe(log.MAX_BYTES - 10);
    expect(fs.readdirSync(dir).sort()).toEqual(['ch.log', 'ch.log.1']);
  });
});

describe('since', () => {
  it('gives whole milliseconds since a performance.now() time', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1500.6);
    expect(log.since(1000)).toBe(501);
  });
});

describe('watchProcess', () => {
  it('logs an unhandled rejection and a crash, without handling the crash', () => {
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    log.init(dir);
    log.watchProcess();

    const listeners = Object.fromEntries(on.mock.calls) as Record<string, (arg: unknown) => void>;
    expect(Object.keys(listeners).sort()).toEqual(['uncaughtExceptionMonitor', 'unhandledRejection']);
    listeners.unhandledRejection(new Error('nobody caught this'));
    listeners.uncaughtExceptionMonitor(new Error('fatal'));

    expect(lines()).toMatchObject([
      { level: 'error', event: 'process.unhandled_rejection', error: { message: 'nobody caught this' } },
      { level: 'error', event: 'process.crash', error: { message: 'fatal' } },
    ]);
    expect(console.error).toHaveBeenCalled();
  });
});
