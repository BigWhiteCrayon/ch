import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';

let log: typeof import('../src/log');
let capabilities: typeof import('../src/capabilities');
let tool: typeof import('../src/tools/capabilities');
let dir: string;
const file = () => path.join(dir, 'missing-capabilities.csv');

// A small CSV reader, enough for quoted cells with commas, quotes and line breaks
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  return rows;
}

const context = (more: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  threadId: 't1',
  ...more,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-capabilities-'));
  vi.resetModules();
  log = await import('../src/log');
  capabilities = await import('../src/capabilities');
  tool = await import('../src/tools/capabilities');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the missing-capabilities file', () => {
  it('keeps nothing until the log has been started', () => {
    capabilities.record({ capability: 'browse', user_goal: 'read a page' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('writes the header once, then one row per report', () => {
    log.init(dir);
    capabilities.record({ capability: 'browse', user_goal: 'read a page', thread: 't1' });
    capabilities.record({ capability: 'print', user_goal: 'print a doc', thread: 't2' });
    const rows = parse(fs.readFileSync(file(), 'utf8'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([...capabilities.COLUMNS]);
    const column = (name: (typeof capabilities.COLUMNS)[number]) => capabilities.COLUMNS.indexOf(name);
    expect(rows[1][column('capability')]).toBe('browse');
    expect(rows[2][column('user_goal')]).toBe('print a doc');
    expect(rows[2][column('thread')]).toBe('t2');
    expect(rows[1][column('agent')]).toBe('');
  });

  it('survives commas, quotes and line breaks in a cell', () => {
    log.init(dir);
    const goal = 'say "hi", then\nmove on';
    capabilities.record({ capability: 'a, b', user_goal: goal });
    const rows = parse(fs.readFileSync(file(), 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe('a, b');
    expect(rows[1][2]).toBe(goal);
  });

  it('stops a cell that starts like a formula from being run by a spreadsheet', () => {
    log.init(dir);
    capabilities.record({ capability: '=HYPERLINK("x")', user_goal: '+1', detail: '@cmd', phase: '\tx' });
    capabilities.record({ capability: 'plain', user_goal: 'a=b' });
    const rows = parse(fs.readFileSync(file(), 'utf8'));
    const column = (name: (typeof capabilities.COLUMNS)[number]) => capabilities.COLUMNS.indexOf(name);
    expect(rows[1][column('capability')]).toBe('\'=HYPERLINK("x")');
    expect(rows[1][column('user_goal')]).toBe("'+1");
    expect(rows[1][column('detail')]).toBe("'@cmd");
    expect(rows[1][column('phase')]).toBe("'\tx");
    expect(rows[2][column('capability')]).toBe('plain');
    expect(rows[2][column('user_goal')]).toBe('a=b');
  });
});

describe('the report_missing_capability tool', () => {
  const read = () => {
    const [header, row] = parse(fs.readFileSync(file(), 'utf8'));
    return Object.fromEntries(header.map((name, i) => [name, row[i]]));
  };

  it('records what was missing, what the user wanted and where it was said', async () => {
    log.init(dir);
    const result = await tool.reportMissingCapability.run(
      { capability: ' open a browser ', user_goal: 'check the live site' },
      context({
        workspace: '/projects/demo',
        model: { provider: 'ollama', model: 'llama3.2:3b' },
        phase: 'explore',
        agent: 'explorer-1',
        conversation: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'is the site up?' },
        ],
      }),
    );
    expect(String(result)).toContain('Recorded');
    expect(read()).toMatchObject({
      capability: 'open a browser',
      user_goal: 'check the live site',
      detail: '',
      last_user_message: 'is the site up?',
      thread: 't1',
      workspace: '/projects/demo',
      model: 'llama3.2:3b',
      phase: 'explore',
      agent: 'explorer-1',
    });
  });

  it('records a report made with no conversation to read the user from', async () => {
    log.init(dir);
    await tool.reportMissingCapability.run({ capability: 'x', user_goal: 'y', detail: 'tried z' }, context());
    expect(read()).toMatchObject({ detail: 'tried z', last_user_message: '' });
  });

  it('refuses a report that does not say what was missing or what the user wanted', async () => {
    log.init(dir);
    await expect(tool.reportMissingCapability.run({ user_goal: 'y' }, context())).rejects.toThrow('capability');
    await expect(tool.reportMissingCapability.run({ capability: 'x', user_goal: '  ' }, context())).rejects.toThrow(
      'user_goal',
    );
    expect(fs.existsSync(file())).toBe(false);
  });
});
