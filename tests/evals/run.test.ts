import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, Suite } from '../../evals/harness';

// Three stand-in suites, so that what is tested is the runner's choice of
// models and not any real suite's cases
const fakes = vi.hoisted(() => {
  const made: Record<string, { suite: any; judged: string[] }> = {};
  const make = (name: string, perModel: boolean) => {
    const judged: string[] = [];
    const one: Case<unknown, unknown> = {
      name: `${name} case`,
      input: {},
      grade: () => [{ field: 'f', wanted: 'a', got: 'a', ok: true }],
    };
    const suite: Suite<unknown, unknown> = {
      name,
      about: 'a stand-in',
      perModel,
      async setUp({ model }) {
        judged.push(model ?? '(the suite chose)');
        return { model: model ?? '(the suite chose)', run: async () => ({}) };
      },
      cases: [one],
    };
    made[name] = { suite, judged };
    return made[name];
  };
  return {
    made,
    classifier: make('classifier', true),
    context: make('context', true),
    search: make('search', false),
    subagents: make('subagents', true),
  };
});

const judging = vi.hoisted(() => ({
  judges: vi.fn(),
  levelsFrom: vi.fn(() => [2, 3, 4]),
  loadEnv: vi.fn(() => [] as string[]),
}));

vi.mock('../../evals/classifier', () => ({ suite: fakes.classifier.suite }));
vi.mock('../../evals/context', () => ({ suite: fakes.context.suite }));
vi.mock('../../evals/search', () => ({ suite: fakes.search.suite }));
vi.mock('../../evals/subagents', () => ({ suite: fakes.subagents.suite }));
vi.mock('../../evals/judges', () => judging);

// The runner starts logging, which would otherwise write into the repo while the
// tests run
const logging = vi.hoisted(() => ({
  init: vi.fn(() => '/tmp/evals/evals.log'),
  FILE_NAME: 'ch.log',
  EVAL_FILE_NAME: 'evals.log',
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  since: () => 1,
}));
vi.mock('../../src/log', () => logging);

import { main } from '../../evals/run';

const said: string[] = [];
const say = (line: string) => said.push(line);
const report = () => said.join('\n');
const at = (id: string, sophistication: number, provider = 'anthropic') => ({ id, sophistication, provider });

beforeEach(() => {
  said.length = 0;
  for (const { judged } of Object.values(fakes.made)) judged.length = 0;
  judging.judges.mockReset();
  judging.loadEnv.mockReset().mockReturnValue([]);
  judging.levelsFrom.mockReset().mockReturnValue([2, 3, 4]);
  judging.judges.mockResolvedValue({ chosen: [], trouble: [], missing: [] });
  logging.init.mockClear().mockReturnValue('/tmp/evals/evals.log');
  logging.info.mockClear();
  logging.warn.mockClear();
});

// A run that goes wrong is read back from its log, and the evals keep their own:
// theirs would otherwise push the app's lines out of ch.log
describe('the log a run keeps', () => {
  it('logs to a file of the evals’ own, not the app’s', async () => {
    await main(['search'], say);
    expect(logging.init).toHaveBeenCalledWith(expect.any(String), 'evals.log');
    expect(logging.init.mock.calls[0][0]).not.toBe('');
  });

  it('says where it is logging, since a file nobody is told about is one nobody reads', async () => {
    await main(['search'], say);
    expect(report()).toContain('logging to /tmp/evals/evals.log');
  });

  it('records what each suite came to, so a run can be read back without its output', async () => {
    await main(['search'], say);
    expect(logging.info).toHaveBeenCalledWith('eval.start', expect.objectContaining({ suites: ['search'] }));
    expect(logging.info).toHaveBeenCalledWith(
      'eval.suite',
      expect.objectContaining({ suite: 'search', ok: 1, of: 1, errors: 0 })
    );
  });

  it('records a suite that could not be set up at all', async () => {
    const was = fakes.made.search.suite.setUp;
    fakes.made.search.suite.setUp = async () => {
      throw new Error('no embedding model');
    };
    try {
      await main(['search'], say);
    } finally {
      fakes.made.search.suite.setUp = was;
    }
    expect(logging.warn).toHaveBeenCalledWith(
      'eval.suite',
      expect.objectContaining({ suite: 'search', ok: false, error: 'no embedding model' })
    );
  });
});

describe('the models a run is judged with', () => {
  it('runs a suite that depends on the model once per model chosen', async () => {
    judging.judges.mockResolvedValue({
      chosen: [at('haiku', 2), at('sonnet', 3), at('opus', 4)],
      trouble: [],
      missing: [],
    });
    await main(['classifier'], say);
    expect(fakes.classifier.judged).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('runs a suite that does not depend on the model once, however many there are', async () => {
    judging.judges.mockResolvedValue({ chosen: [at('haiku', 2), at('opus', 4)], trouble: [], missing: [] });
    await main(['search'], say);
    expect(fakes.search.judged).toEqual(['(the suite chose)']);
    // Nothing was looked up for it: it has no model to look up
    expect(judging.judges).not.toHaveBeenCalled();
  });

  it('judges with the one model named, and does not go looking for others', async () => {
    await main(['classifier', '--model=llama3.2:3b'], say);
    expect(fakes.classifier.judged).toEqual(['llama3.2:3b']);
    expect(judging.judges).not.toHaveBeenCalled();
  });

  it('asks for the levels the arguments settled on', async () => {
    judging.levelsFrom.mockReturnValue([1, 2]);
    await main(['classifier'], say);
    expect(judging.judges).toHaveBeenCalledWith([1, 2]);
  });

  it('leaves each suite to say so in its own words when no model could be reached', async () => {
    judging.judges.mockResolvedValue({ chosen: [], trouble: [], missing: [2, 3, 4] });
    await main(['classifier'], say);
    expect(fakes.classifier.judged).toEqual(['(the suite chose)']);
  });

  it('reads the .env before anything looks at the environment', async () => {
    await main([], say);
    expect(judging.loadEnv).toHaveBeenCalled();
    expect(judging.loadEnv.mock.invocationCallOrder[0]).toBeLessThan(judging.levelsFrom.mock.invocationCallOrder[0]);
  });
});

describe('what the run says about the models it could not reach', () => {
  it('names a provider that could not be reached, without printing its key', async () => {
    judging.judges.mockResolvedValue({
      chosen: [at('qwen3.5:9b', 2, 'local')],
      trouble: ['Anthropic: no API key'],
      missing: [3, 4],
    });
    await main(['classifier'], say);
    expect(report()).toContain('Anthropic: no API key');
    expect(report()).toContain('no model at level 3 or 4');
  });

  it('says nothing about levels when every one of them was found', async () => {
    judging.judges.mockResolvedValue({ chosen: [at('haiku', 2)], trouble: [], missing: [] });
    await main(['classifier'], say);
    expect(report()).not.toContain('no model at level');
  });
});

describe('when a suite will not run', () => {
  it('says which model it was trying, and carries on with the rest', async () => {
    judging.judges.mockResolvedValue({ chosen: [at('haiku', 2), at('opus', 4)], trouble: [], missing: [] });
    const was = fakes.subagents.suite.setUp;
    fakes.subagents.suite.setUp = async ({ model }: { model?: string }) => {
      if (model === 'haiku') throw new Error('not told how to break its work up');
      fakes.subagents.judged.push(model ?? '');
      return { model: model ?? '', run: async () => ({}) };
    };
    const code = await main(['subagents', '--strict'], say);
    fakes.subagents.suite.setUp = was;

    expect(report()).toContain('subagents with haiku: could not run — not told how to break its work up');
    // The one that could run still did
    expect(fakes.subagents.judged).toEqual(['opus']);
    expect(code).toBe(1);
  });
});
