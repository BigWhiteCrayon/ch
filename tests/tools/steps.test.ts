// The tool a model asks for more rounds with. What a request gets is in
// ../harness/allowance.test.ts; what is here is the asking itself.

import { describe, expect, it, vi } from 'vitest';
import { tool } from '../../src/tools/steps';
import { TOOL_NAME } from '../../src/harness/allowance';
import type { ToolContext } from '../../src/types';

const context = (over: Partial<ToolContext> = {}) => ({ signal: new AbortController().signal, ...over }) as ToolContext;

describe('asking for more rounds', () => {
  it('is the tool the allowance module names, so the prompts and the registry agree', () => {
    expect(tool.name).toBe(TOOL_NAME);
  });

  // The planning step has one pass and writes in it, so there is no allowance
  // of rounds there to extend (see offers in ../../src/harness/phases.ts)
  it('is offered in the steps that work for themselves and not in the one that only writes', () => {
    expect(tool.phases).toEqual(['explore', 'execute', 'suggest']);
  });

  it('hands the reason to whoever is counting the rounds, and answers with what they said', async () => {
    const more = vi.fn(() => 'Granted: 5 more rounds.');
    const answer = await tool.run({ reason: '  Reproduced it; one more run settles the cause.  ' }, context({ more }));
    expect(more).toHaveBeenCalledWith('Reproduced it; one more run settles the cause.');
    expect(answer).toBe('Granted: 5 more rounds.');
  });

  // The asking is what makes the door affordable: a model that has to say what
  // it has and what the rounds are for has written much of the write-up it owed
  it('refuses a request with no reason in it', async () => {
    await expect(tool.run({}, context({ more: vi.fn() }))).rejects.toThrow('"reason" must say');
    await expect(tool.run({ reason: '   ' }, context({ more: vi.fn() }))).rejects.toThrow('"reason" must say');
  });

  // A reply given no ceiling at all is one case of it (see
  // HarnessRequest.rounds): there is nothing to raise, and saying so is better
  // than failing
  it('says there is nothing to extend where nobody is counting', async () => {
    const answer = await tool.run({ reason: 'Still cornering the fault.' }, context());
    expect(answer).toContain('Nothing is counting your rounds');
  });
});
