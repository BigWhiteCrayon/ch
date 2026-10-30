import { describe, expect, it } from 'vitest';
import { prompt } from '../../src/harness/discoveries';
import { unwrapped } from '../helpers';

describe('discoveries.prompt', () => {
  it('tells every provider that reasoning is not kept with the reply', () => {
    for (const provider of ['anthropic', 'local', 'openai', 'something-else']) {
      expect(prompt(provider)).toMatch(/reasoning is not\s+part of your reply/);
    }
  });

  it('tells Anthropic that thinking lasts the reply and goes at the condensing', () => {
    const said = prompt('anthropic');
    expect(said).toMatch(/does come back to you at each step of this reply/);
    expect(said).toMatch(/condensing/);
  });

  it('tells a local model that thinking is gone at the next step, and spells it out', () => {
    const said = prompt('local');
    expect(said).toMatch(/does not come back to you at the next step/);
    // The local models are the ones that need telling at length (see LOCAL)
    expect(said.length).toBeGreaterThan(prompt('anthropic').length);
    expect(said.length).toBeGreaterThan(prompt('openai').length);
  });

  it('assumes a provider it does not know keeps nothing, which is the safe way to be wrong', () => {
    expect(prompt('a-provider-added-later')).toBe(prompt('openai'));
  });

  it('asks for the things a compaction has to have: paths, line numbers and exact values', () => {
    for (const provider of ['anthropic', 'local', 'openai']) {
      expect(prompt(provider)).toMatch(/line numbers/);
      expect(prompt(provider)).toMatch(/copied, not remembered/);
    }
  });

  // A reply that runs long loses an unwritten thought to the condensing. The
  // finding-out step is never condensed — it ends instead (see the loop in
  // ../../src/harness/index.ts) — so it is told about the thing that does
  // happen to it, which comes sooner and takes the tool results with it.
  it('gives the finding-out step the end of the step as the reason, not the condensing', () => {
    const said = unwrapped(prompt('anthropic', 'explore'));
    expect(said).toContain('what is at risk is not the next round but the end of the step');
    expect(said).toContain('the step after this one will never know you knew it');
    expect(said).not.toContain('the condensing');
    // The advice itself is the same, since it is right either way
    expect(said).toContain('put it in your reply in a line before you call the next tool');
  });

  it('gives every other step the condensing, which is what happens to them', () => {
    for (const phase of [undefined, 'execute' as const]) {
      expect(unwrapped(prompt('anthropic', phase))).toContain('what is at risk here is not the next step but the');
      expect(unwrapped(prompt('anthropic', phase))).toContain('condensing');
    }
  });
});
