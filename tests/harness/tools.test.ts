import { beforeEach, describe, expect, it } from 'vitest';
import * as tools from '../../src/harness/tools';
import type { Tool } from '../../src/types';

const tool = (name: string, description = name): Tool => ({
  name,
  description,
  inputSchema: { type: 'object' },
  run: () => name,
});

beforeEach(() => {
  tools.clear();
  tools.resetStats();
});

describe('tool registry', () => {
  it('starts empty', () => {
    expect(tools.list()).toEqual([]);
    expect(tools.get('anything')).toBeUndefined();
  });

  it('returns registered tools by name and in registration order', () => {
    const a = tool('a');
    const b = tool('b');
    tools.register(a);
    tools.register(b);
    expect(tools.get('a')).toBe(a);
    expect(tools.list()).toEqual([a, b]);
  });

  it('replaces a tool registered again under the same name', () => {
    tools.register(tool('a', 'first'));
    const second = tool('a', 'second');
    tools.register(second);
    expect(tools.list()).toEqual([second]);
  });

  it('hands out a copy of the list, so callers cannot change the registry', () => {
    tools.register(tool('a'));
    tools.list().pop();
    expect(tools.list()).toHaveLength(1);
  });
});

describe('tool stats', () => {
  it('has nothing for tools that were never called', () => {
    tools.register(tool('a'));
    expect(tools.stats()).toEqual({});
  });

  it('counts calls and failures per tool, with average and longest latency', () => {
    tools.record('run_command', true, 100);
    tools.record('run_command', false, 301);
    tools.record('run_command', true, 50);
    tools.record('read_file', true, 7);
    expect(tools.stats()).toEqual({
      run_command: { calls: 3, failures: 1, avgMs: 150, maxMs: 301 },
      read_file: { calls: 1, failures: 0, avgMs: 7, maxMs: 7 },
    });
  });
});
