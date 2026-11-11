// The tool a model asks for more rounds of tool calls with, where the loop
// running it counts them. What a request gets, and what bounds it, is in
// ../harness/allowance.ts; this is the face that module shows a model.
//
// Offered in the steps that have tools and work for themselves — finding out,
// doing, suggesting — and to a reply that is not worked through in steps at
// all, which is bounded by its step budget like any other. Not in the planning
// step: that step has one pass and writes in it, so there is no allowance of
// rounds there to extend (see offers in ../harness/phases.ts).

import { MAX_GRANTS, TOOL_NAME } from '../harness/allowance';
import type { Tool } from '../types';

export const tool: Tool = {
  name: TOOL_NAME,
  phases: ['explore', 'execute', 'suggest'],
  description: `Ask for more rounds of tool calls than your allowance holds. For work whose size could not be judged
before it began — finding a fault, where each guess has to be tested against the running thing and most guesses are
wrong — and not for one more look at something you already believe.

At most ${MAX_GRANTS} requests are granted, so ask when a round of them would settle something and not when you are
merely close to the ceiling. A request is refused where the window is nearly full rather than the rounds spent: the
rounds would be granted and there would be nowhere to put what they returned, and what to do then is hand the
reading to an explorer, which reads in a window of its own.

Say in "reason" what you have established, what is still open, and what you will do with the rounds. That is read and
kept, and it is most of what you owe whoever reads your write-up, so writing it is not a round spent on nothing.`,
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'What you have established so far, what is still open, and what the extra rounds are for: the experiment ' +
          'you would run, or the guess you would test.',
      },
    },
    required: ['reason'],
  },
  async run(input, { more }) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason) {
      throw new Error(
        '"reason" must say what you have established, what is still open, and what the extra rounds are for.'
      );
    }
    // Nothing is counting this model's rounds, so there is no ceiling to raise.
    // A reply with no ceiling at all is one case of it (see HarnessRequest.rounds).
    if (!more) return 'Nothing is counting your rounds here, so there is no allowance to extend. Carry on.';
    return more(reason);
  },
};

export function registerTools(registry: { register(tool: Tool): void }): void {
  registry.register(tool);
}
