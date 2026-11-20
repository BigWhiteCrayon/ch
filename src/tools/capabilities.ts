// The tool a model uses to say that it could not do something because nothing it
// has covers it. The report goes to a file on this machine and nowhere else (see
// ../capabilities), and the model carries on: it is a note for the developers
// of the app, not a way of stopping a reply.

import * as capabilities from '../capabilities';
import type { Tool } from '../types';

// The user's words are kept as they were said, but a message that pastes a whole
// file would make a row nobody can read
const MESSAGE_LIMIT = 2000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const reportMissingCapability: Tool = {
  name: 'report_missing_capability',
  description: `Report something you could not do, or could only do badly, because none of your tools or
abilities covers it, so that the developers can see what is missing. Name the capability, and say what the
user was trying to get done. Report it once and then carry on with the best you can do: this does not end
your turn, and the user is not shown it. Do not report a task you failed at when the tools to do it were
there, or something the user asked you not to do.`,
  inputSchema: {
    type: 'object',
    properties: {
      capability: {
        type: 'string',
        description: 'What is missing, in a few words, such as "open a URL in a real browser".',
      },
      user_goal: { type: 'string', description: 'What the user wanted to get done, in a sentence.' },
      detail: {
        type: 'string',
        description: 'Optional: what you tried, or the nearest thing you had and why it was not enough.',
      },
    },
    required: ['capability', 'user_goal'],
  },
  async run(input, context) {
    const { capability, user_goal, detail } = input as {
      capability?: unknown;
      user_goal?: unknown;
      detail?: unknown;
    };
    const missing = text(capability);
    if (!missing) {
      throw new Error('"capability" has to name what is missing, such as "open a URL in a real browser".');
    }
    const goal = text(user_goal);
    if (!goal) throw new Error('"user_goal" has to say what the user wanted to get done.');

    let said: string | undefined;
    for (const message of [...(context.conversation ?? [])].reverse()) {
      if (message.role === 'user') {
        said = message.content.slice(0, MESSAGE_LIMIT);
        break;
      }
    }
    capabilities.record({
      capability: missing,
      user_goal: goal,
      detail: text(detail),
      last_user_message: said,
      thread: context.threadId,
      workspace: context.workspace,
      model: context.model?.model,
      phase: context.phase,
      agent: context.agent,
    });
    return 'Recorded. Carry on with the task as best you can.';
  },
};

export const tools: Tool[] = [reportMissingCapability];
