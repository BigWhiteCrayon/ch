import { describe, expect, it } from 'vitest';
import { cost } from '../../src/llm/pricing';

const million = { input: 1_000_000, output: 1_000_000 };

describe('cost', () => {
  it('prices input and output tokens at the model’s own rates', () => {
    expect(cost('anthropic', 'claude-opus-5-5', million, false)).toBe(24);
    expect(cost('anthropic', 'claude-haiku-4-5', { input: 2000, output: 500 }, false)).toBeCloseTo(0.0045, 10);
    expect(cost('openai', 'gpt-5.4-mini', { input: 1_000_000, output: 0 }, false)).toBe(0.75);
    expect(cost('openai', 'gpt-5.4-mini', { input: 0, output: 1_000_000 }, false)).toBe(4.5);
  });

  // A cached token is part of usage.input, and charged at its own rate: a
  // quarter more to write into the cache, and its own listed price to read
  // back — a tenth of an uncached token on most models, less on some
  describe('cached input', () => {
    const opus = (usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number }) =>
      cost('anthropic', 'claude-opus-5-5', usage, false);

    it("prices a token read from the cache at the model's own cache rate", () => {
      // Opus 5.5 reads at $0.20 against $4 in: a twentieth, not a tenth
      expect(opus({ input: 1_000_000, output: 0, cacheRead: 1_000_000 })).toBeCloseTo(0.2, 10);
      expect(opus({ input: 1_000_000, output: 0 })).toBe(4);
    });

    // The multiple used to be taken for granted, and these are the models it
    // was wrong about: a thread on either was billed several times over
    it('prices the models whose cache rate is not a tenth at the rate they charge', () => {
      const read = (model: string) =>
        cost('anthropic', model, { input: 1_000_000, output: 0, cacheRead: 1_000_000 }, false);
      expect(read('claude-opus-5-5')).toBeCloseTo(0.2, 10);
      expect(read('claude-sonnet-5-5')).toBeCloseTo(0.1, 10);
      expect(read('claude-fable-5-1')).toBeCloseTo(0.25, 10);
      expect(read('claude-mythos-5-1')).toBeCloseTo(0.25, 10);
    });

    it('falls back to a tenth for a model that lists no cache rate of its own', () => {
      const read = (model: string) =>
        cost('anthropic', model, { input: 1_000_000, output: 0, cacheRead: 1_000_000 }, false);
      expect(read('claude-opus-5')).toBeCloseTo(0.5, 10);
      expect(read('claude-fable-5')).toBeCloseTo(1, 10);
      expect(read('claude-sonnet-4-6')).toBeCloseTo(0.3, 10);
      expect(read('claude-haiku-4-5')).toBeCloseTo(0.1, 10);
    });

    it('prices writing one into the cache at a quarter more', () => {
      expect(opus({ input: 1_000_000, output: 0, cacheWrite: 1_000_000 })).toBe(5);
    });

    it('charges the rest of the input at the full rate', () => {
      // Half read from the cache, a quarter written to it, a quarter fresh
      const usage = { input: 1_000_000, output: 0, cacheRead: 500_000, cacheWrite: 250_000 };
      expect(opus(usage)).toBeCloseTo((250_000 + 250_000 * 1.25) * 4e-6 + 500_000 * 0.2e-6, 10);
    });

    it('is the plain price for a provider that reports no cache', () => {
      expect(opus({ input: 1_000_000, output: 1_000_000 })).toBe(24);
    });
  });

  // The one model whose price depends on how large the prompt is. The
  // threshold counts every input token, cache hits included, and each request
  // is priced on its own.
  describe('a model priced by the length of the prompt', () => {
    const haiku = (usage: { input: number; output: number; cacheRead?: number }) =>
      cost('anthropic', 'claude-haiku-5-5', usage, false);

    it('charges the short-prompt prices up to the threshold, and at it', () => {
      expect(haiku({ input: 50_000, output: 10_000 })).toBeCloseTo(50_000 * 0.1e-6 + 10_000 * 0.5e-6, 10);
      // A prompt exactly at the threshold is still a short one
      expect(haiku({ input: 100_000, output: 100_000 })).toBeCloseTo(0.01 + 0.05, 10);
    });

    it('charges the long-prompt prices above it, on the whole prompt and not the part over', () => {
      // 100,001 in at $0.50/MTok, not 100,000 at $0.10 and one at $0.50
      expect(haiku({ input: 100_001, output: 0 })).toBeCloseTo(100_001 * 0.5e-6, 10);
      expect(haiku({ input: 1_000_000, output: 1_000_000 })).toBeCloseTo(0.5 + 2.5, 10);
    });

    it('reads back from the cache at a tenth of whichever tier the request is in', () => {
      expect(haiku({ input: 100_000, output: 0, cacheRead: 100_000 })).toBeCloseTo(100_000 * 0.01e-6, 10);
      expect(haiku({ input: 200_000, output: 0, cacheRead: 200_000 })).toBeCloseTo(200_000 * 0.05e-6, 10);
    });

    // The prompt is what decides the tier, so a cache hit does not take a
    // request back under the threshold
    it('pays the long-prompt prices even where most of the prompt was a cache hit', () => {
      const cached = { input: 150_000, output: 0, cacheRead: 149_000 };
      expect(haiku(cached)).toBeCloseTo(1000 * 0.5e-6 + 149_000 * 0.05e-6, 10);
    });

    it('prices a dated snapshot of it by the same tiers', () => {
      expect(cost('anthropic', 'claude-haiku-5-5-20260401', { input: 50_000, output: 0 }, false)).toBeCloseTo(
        0.005,
        10
      );
      expect(cost('anthropic', 'claude-haiku-5-5-20260401', { input: 500_000, output: 0 }, false)).toBeCloseTo(
        0.25,
        10
      );
    });
  });

  it('prices the models that were only on the price list', () => {
    // Mythos 5 is Fable 5's twin, cache reads included (a tenth, so $1/MTok)
    expect(cost('anthropic', 'claude-mythos-5', million, false)).toBe(60);
    expect(cost('anthropic', 'claude-mythos-5', { input: 1_000_000, output: 0, cacheRead: 1_000_000 }, false)).toBe(1);
  });

  // The same mechanism on the other provider, where the figures agree with
  // nothing: the read discount is a tenth, a twentieth, a quarter or a half
  // depending on the model, and most of them do not charge for a write at all
  describe("openai's own rates", () => {
    const read = (model: string) => cost('openai', model, { input: 1_000_000, output: 0, cacheRead: 1_000_000 }, false);
    const write = (model: string) =>
      cost('openai', model, { input: 1_000_000, output: 0, cacheWrite: 1_000_000 }, false);

    it('reads back at the price the model lists, not at a tenth of the input', () => {
      expect(read('gpt-6-astra')).toBeCloseTo(1, 10); // a tenth
      expect(read('gpt-6.1-sol')).toBeCloseTo(0.1, 10); // a twentieth
      expect(read('gpt-4o')).toBeCloseTo(1.25, 10); // a half
      expect(read('o4-mini')).toBeCloseTo(0.275, 10); // a quarter
      expect(read('gpt-5-nano')).toBeCloseTo(0.005, 10);
    });

    // A model with no cached price does not discount one: the pro models and
    // the oldest ones charge for a cached token what they charge for any other
    it('charges full price for a cached token on a model that does not discount one', () => {
      expect(read('gpt-5-pro')).toBeCloseTo(15, 10);
      expect(read('gpt-3.5-turbo')).toBeCloseTo(0.5, 10);
    });

    it('charges a quarter more for a write only where the model charges for writes', () => {
      // The newest families have a cache-write price, at the usual quarter more
      expect(write('gpt-6-sol')).toBeCloseTo(2.5, 10);
      expect(write('gpt-5.6-luna')).toBeCloseTo(0.25, 10);
      // Below them there is no such price: a written token is an ordinary one
      expect(write('gpt-5.1')).toBeCloseTo(1.25, 10);
      expect(write('gpt-4o')).toBeCloseTo(2.5, 10);
      expect(write('o3-mini')).toBeCloseTo(1.1, 10);
    });

    it('prices a mixed request from its parts', () => {
      // Half read back, a fifth written, the rest fresh, on a model that
      // discounts the read by half and charges nothing extra for the write
      const usage = { input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 200_000 };
      expect(cost('openai', 'gpt-4o', usage, false)).toBeCloseTo(
        300_000 * 2.5e-6 + 200_000 * 2.5e-6 + 500_000 * 1.25e-6 + 100_000 * 10e-6,
        10
      );
    });
  });

  it('costs nothing when no tokens were used', () => {
    expect(cost('anthropic', 'claude-opus-5-5', { input: 0, output: 0 }, false)).toBe(0);
  });

  it('prices a dated snapshot as the model it is a snapshot of', () => {
    expect(cost('anthropic', 'claude-haiku-4-5-20251001', million, false)).toBe(6);
    expect(cost('openai', 'gpt-4o-2024-08-06', million, false)).toBe(12.5);
  });

  it('does not mistake a different model for a snapshot of a shorter-named one', () => {
    // Not snapshots of gpt-5 or gpt-4o
    expect(cost('openai', 'gpt-5-mini', million, false)).toBe(2.25);
    expect(cost('openai', 'gpt-4o-mini', million, false)).toBe(0.75);
    expect(cost('openai', 'gpt-5-turbo-preview', million, false)).toBeNull();
    expect(cost('openai', 'gpt-5.9', million, false)).toBeNull();
  });

  it('has no cost to give for a model or provider it has no price for', () => {
    expect(cost('anthropic', 'claude-next-9', million, false)).toBeNull();
    expect(cost('elsewhere', 'gpt-5', million, false)).toBeNull();
  });

  it('prices each provider’s models separately', () => {
    expect(cost('openai', 'claude-opus-5-5', million, false)).toBeNull();
  });

  it('is free for a model that runs locally, whatever it is called', () => {
    expect(cost('local', 'llama3.2:3b', million, true)).toBe(0);
    expect(cost('local', 'gpt-5', million, true)).toBe(0);
  });
});
