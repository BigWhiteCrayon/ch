import { describe, expect, it } from 'vitest';
import { PREFERENCE_FLOOR, capped, cheapestFirst, route } from '../../src/harness/router';
import type { Classification } from '../../src/types';
import { model } from '../helpers';

// Sorted smartest first, as llm.listModels() returns them
const models = [
  model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4, default: true }),
  model({ id: 'gpt', provider: 'openai', local: false, sophistication: 4 }),
  model({ id: 'sonnet', provider: 'anthropic', local: false, sophistication: 3 }),
  model({ id: 'qwen:32b', sophistication: 3 }),
  model({ id: 'haiku', provider: 'anthropic', local: false, sophistication: 2 }),
  model({ id: 'llama:3b', sophistication: 1 }),
];

const needs = (sophistication: number): Classification => ({
  sophistication,
  effort: 'low',
  category: 'question',
  model: 'classifier',
});

describe('cheapestFirst', () => {
  it('orders by sophistication, then local before hosted', () => {
    const sorted = [...models].sort(cheapestFirst).map((m) => m.id);
    expect(sorted).toEqual(['llama:3b', 'haiku', 'qwen:32b', 'sonnet', 'opus', 'gpt']);
  });
});

describe('route', () => {
  it.each([
    [1, 'llama:3b'],
    [2, 'haiku'],
    [4, 'opus'],
  ])('serves a request needing %i with the least capable sufficient model', (level, id) => {
    expect(route(models, needs(level), {})).toMatchObject({ id, reason: 'matched' });
  });

  it('prefers a local model over a hosted one at the same level', () => {
    expect(route(models, needs(3), {})).toMatchObject({ id: 'qwen:32b', provider: 'local' });
  });

  it('serves a request with images from a model that takes them, where there is one', () => {
    const seen = [
      model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4, vision: true }),
      model({ id: 'llama:3b', sophistication: 1, vision: false }),
    ];
    expect(route(seen, needs(1), { vision: true })).toMatchObject({ id: 'opus', reason: 'matched' });
    expect(route(seen, needs(1), {})).toMatchObject({ id: 'llama:3b', reason: 'matched' });
  });

  it('still serves a request with images when no model takes them', () => {
    const blind = [model({ id: 'llama:3b', sophistication: 1, vision: false })];
    expect(route(blind, needs(1), { vision: true })).toMatchObject({ id: 'llama:3b' });
  });

  it('falls back to the best model when none is capable enough', () => {
    expect(route(models, needs(5), {})).toMatchObject({ id: 'opus', reason: 'best_available' });
  });

  it('never chooses a level-0 model for a reply, even as the best available', () => {
    const system = model({ id: 'router:0.5b', sophistication: 0 });
    expect(route([...models, system], needs(5), {})).toMatchObject({ id: 'opus', reason: 'best_available' });
    expect(route([system, ...models], needs(0), {})).not.toMatchObject({ id: 'router:0.5b' });
    expect(route([system], needs(5), {})).toBeNull();
  });

  it('treats a failed classification as a request needing level 2', () => {
    const failed: Classification = { failed: true, reason: 'timeout' };
    expect(route(models, failed, {})).toMatchObject({ id: 'haiku', reason: 'unclassified' });
  });

  it('uses the best model when classification failed and nothing reaches level 2', () => {
    const failed: Classification = { failed: true, reason: 'timeout' };
    expect(route([models[5]], failed, {})).toMatchObject({ id: 'llama:3b', reason: 'unclassified' });
  });

  it('honours a model the user picked, whatever the request needs', () => {
    const picked = route(models, needs(5), { provider: 'local', model: 'llama:3b' });
    expect(picked).toMatchObject({ id: 'llama:3b', sophistication: 1, reason: 'picked' });
  });

  it('still serves a picked model that is not in the list', () => {
    expect(route([], needs(1), { provider: 'local', model: 'new:1b' })).toEqual({
      provider: 'local',
      id: 'new:1b',
      name: 'new:1b',
      reason: 'picked',
    });
  });

  it('ignores a half-specified pick', () => {
    expect(route(models, needs(1), { provider: 'local' })).toMatchObject({ reason: 'matched' });
  });

  it('returns null when there are no models to choose from', () => {
    expect(route([], needs(1), {})).toBeNull();
  });

  it('does not reorder the list it was given', () => {
    const before = models.map((m) => m.id);
    route(models, needs(2), {});
    expect(models.map((m) => m.id)).toEqual(before);
  });
});

describe('a side the work is to be kept to', () => {
  it('serves it from that side when that side can', () => {
    // The least capable sufficient model on the preferred side, not the least
    // capable sufficient model there is
    expect(route(models, needs(3), {}, 'local')).toMatchObject({ id: 'qwen:32b', reason: 'matched' });
    expect(route(models, needs(3), {}, 'hosted')).toMatchObject({ id: 'sonnet', reason: 'matched' });
  });

  it('gives up a level of sophistication to stay on that side', () => {
    // Nothing local is a 4; the best local model does it anyway, because the
    // point of the preference is which queue the work joins
    expect(route(models, needs(4), {}, 'local')).toMatchObject({ id: 'qwen:32b', reason: 'preferred' });
  });

  it('does not give up more than that', () => {
    const toys = [...models.filter((m) => !m.local), model({ id: 'llama:3b', sophistication: 1 })];
    // The only local model is below the floor, so the preference is dropped
    // rather than the work going to something that cannot do it
    expect(PREFERENCE_FLOOR).toBeGreaterThan(1);
    expect(route(toys, needs(4), {}, 'local')).toMatchObject({ id: 'opus', reason: 'matched' });
  });

  it('is dropped when that side has nothing at all, as offline leaves it', () => {
    const local = models.filter((m) => m.local);
    expect(route(local, needs(3), {}, 'hosted')).toMatchObject({ id: 'qwen:32b', reason: 'matched' });
  });

  it('never overrides a model the user picked themselves', () => {
    expect(route(models, needs(1), { provider: 'anthropic', model: 'opus' }, 'local')).toMatchObject({
      id: 'opus',
      reason: 'picked',
    });
  });
});

describe('capped', () => {
  it('chooses from the models at or below the ceiling, and says it was not approved', () => {
    const chosen = capped(models, needs(4), 3);
    expect(chosen).toMatchObject({ id: 'sonnet', reason: 'not_approved' });
    expect(chosen?.sophistication).toBeLessThanOrEqual(3);
  });

  it('keeps to the preferred side within the ceiling', () => {
    expect(capped(models, needs(4), 3, 'hosted')).toMatchObject({ id: 'sonnet', reason: 'not_approved' });
  });

  it('serves the need as route would where the ceiling allows it', () => {
    expect(capped(models, needs(2), 3)).toMatchObject({ id: 'haiku', reason: 'not_approved' });
  });

  it('uses the least sophisticated model when nothing is within the ceiling', () => {
    expect(capped(models, needs(4), 0)).toMatchObject({ id: 'llama:3b', reason: 'not_approved' });
  });

  it('finds nothing where there are no models', () => {
    expect(capped([], needs(1), 3)).toBeNull();
  });
});
