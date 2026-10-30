import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ configure: vi.fn(), listModels: vi.fn() }));
vi.mock('../../src/llm', () => mocks);

import { DEFAULT_LEVELS, configure, judges, levelsFrom, loadEnv } from '../../evals/judges';
import { model } from '../helpers';

let dir: string;
const write = (text: string, name = '.env') => fs.writeFileSync(path.join(dir, name), text);

// The environment is this process's own, so whatever a test sets is put back
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CH_LOCAL_URL', 'CH_EVAL_LEVELS', 'EXAMPLE', 'QUOTED', 'SPACED'];
let before: Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-'));
  before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  mocks.configure.mockReset();
  mocks.listModels.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, was] of Object.entries(before)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

describe('reading the keys out of .env', () => {
  it('sets what the file names, and says what it set', () => {
    write('ANTHROPIC_API_KEY=sk-ant-123\nOPENAI_API_KEY=sk-oai-456\n');
    expect(loadEnv(dir)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');
    expect(process.env.OPENAI_API_KEY).toBe('sk-oai-456');
  });

  it('leaves alone a key the environment already has, so the shell wins', () => {
    process.env.ANTHROPIC_API_KEY = 'from-the-shell';
    write('ANTHROPIC_API_KEY=from-the-file\n');
    expect(loadEnv(dir)).toEqual([]);
    expect(process.env.ANTHROPIC_API_KEY).toBe('from-the-shell');
  });

  it('skips comments, blank lines and names with nothing after the equals', () => {
    write(['# a comment', '', 'ANTHROPIC_API_KEY=', '   ', 'OPENAI_API_KEY=real'].join('\n'));
    expect(loadEnv(dir)).toEqual(['OPENAI_API_KEY']);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('takes a value in quotes whole, and trims one without them', () => {
    write(['QUOTED="  kept  "', 'SPACED=   trimmed   ', 'EXAMPLE=value # and a comment'].join('\n'));
    loadEnv(dir);
    expect(process.env.QUOTED).toBe('  kept  ');
    expect(process.env.SPACED).toBe('trimmed');
    expect(process.env.EXAMPLE).toBe('value');
  });

  it('reads a line written with export in front of it', () => {
    write('export OPENAI_API_KEY=sk-oai\n');
    expect(loadEnv(dir)).toEqual(['OPENAI_API_KEY']);
  });

  it('does nothing at all when there is no .env, which is the ordinary case', () => {
    expect(loadEnv(dir)).toEqual([]);
    expect(() => loadEnv('/no/such/place')).not.toThrow();
  });

  it("falls back to the package's own directory, so the built runner finds the keys", () => {
    // Nowhere named: it looks where the command was run from, then beside the
    // package, and this project's own .env is the second of those
    expect(() => loadEnv()).not.toThrow();
    expect(Array.isArray(loadEnv())).toBe(true);
  });

  it('never carries a key into the report: it returns names, not values', () => {
    write('ANTHROPIC_API_KEY=sk-ant-secret\n');
    expect(JSON.stringify(loadEnv(dir))).not.toContain('secret');
  });
});

describe('which levels to judge', () => {
  it('is two, three and four when nothing says otherwise', () => {
    expect(levelsFrom()).toEqual(DEFAULT_LEVELS);
    expect(DEFAULT_LEVELS).toEqual([2, 3, 4]);
  });

  it('takes the flag, in order and without repeats', () => {
    expect(levelsFrom('3,1,3,2')).toEqual([1, 2, 3]);
  });

  it('falls back to the environment when there is no flag', () => {
    process.env.CH_EVAL_LEVELS = '1,2';
    expect(levelsFrom()).toEqual([1, 2]);
    expect(levelsFrom('4')).toEqual([4]);
  });

  it('leaves out what is not a level, and keeps the default if none is left', () => {
    expect(levelsFrom('2,nine,7,0')).toEqual([2]);
    expect(levelsFrom('nine')).toEqual(DEFAULT_LEVELS);
    expect(levelsFrom('')).toEqual(DEFAULT_LEVELS);
  });
});

describe('choosing the models to judge with', () => {
  const offer = (...models: ReturnType<typeof model>[]) =>
    mocks.listModels.mockResolvedValue({ models, providers: [] });

  it('takes one model per provider per level, cheapest level first', async () => {
    offer(
      model({ id: 'claude-haiku-5', provider: 'anthropic', sophistication: 2 }),
      model({ id: 'claude-sonnet-5', provider: 'anthropic', sophistication: 3 }),
      model({ id: 'claude-opus-5', provider: 'anthropic', sophistication: 4 }),
      model({ id: 'gpt-5-mini', provider: 'openai', sophistication: 2 }),
      model({ id: 'qwen3.5:9b', provider: 'local', sophistication: 2 })
    );
    const { chosen } = await judges([2, 3, 4]);
    expect(chosen.map((m) => m.id)).toEqual([
      'claude-haiku-5',
      'qwen3.5:9b',
      'gpt-5-mini',
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
  });

  it('prefers a plain name to a dated snapshot of the same model', async () => {
    offer(
      model({ id: 'claude-sonnet-5-5-20260101', provider: 'anthropic', sophistication: 3 }),
      model({ id: 'claude-sonnet-5-5', provider: 'anthropic', sophistication: 3 })
    );
    expect((await judges([3])).chosen.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
  });

  it('says which levels nothing could be found for', async () => {
    offer(model({ id: 'qwen3.5:9b', provider: 'local', sophistication: 2 }));
    const { chosen, missing } = await judges([2, 3, 4]);
    expect(chosen.map((m) => m.id)).toEqual(['qwen3.5:9b']);
    expect(missing).toEqual([3, 4]);
  });

  it('passes on why a provider could not be reached', async () => {
    mocks.listModels.mockResolvedValue({
      models: [],
      providers: [
        { name: 'Anthropic', ok: false, error: 'no key' },
        { name: 'Ollama', ok: true },
      ],
    });
    const { chosen, trouble } = await judges([2]);
    expect(chosen).toEqual([]);
    expect(trouble).toEqual(['Anthropic: no key']);
  });

  it('configures the providers from the environment before it asks', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.CH_LOCAL_URL = 'http://elsewhere:1234/v1';
    offer();
    await judges([2]);
    expect(mocks.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropic: { apiKey: 'sk-ant', disabledModels: [] },
        local: { baseURL: 'http://elsewhere:1234/v1', apiKey: '' },
      })
    );
  });

  it('configures with empty keys rather than failing when there are none', () => {
    configure();
    expect(mocks.configure).toHaveBeenCalledWith(
      expect.objectContaining({ anthropic: { apiKey: '', disabledModels: [] } })
    );
  });
});
