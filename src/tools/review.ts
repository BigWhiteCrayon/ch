// The tool a reviewer replies to one of the user's comments with. What the
// model is told about reviewing is in ../harness/review.ts.

import type { Tool } from '../types';

export const tools: Tool[] = [
  {
    name: 'reply_to_comment',
    phases: ['execute'],
    needsWorkspace: true,
    needsReview: true,
    description: `Reply to one of the review comments the user left on your changes. The reply is shown to the user
under that
comment. Use it once for each comment, after you have made the change it asks for or worked out the answer to its
question.`,
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'The id of the comment, such as "c1".' },
        reply: { type: 'string', description: 'What you changed, or the answer to the question. A sentence or two.' },
      },
      required: ['comment_id', 'reply'],
    },
    // The reply reaches the user by way of the call itself, which the window
    // shows under the comment; there is nothing else to do with it
    run(input) {
      for (const key of ['comment_id', 'reply']) {
        if (typeof input?.[key] !== 'string' || !(input[key] as string).trim()) {
          throw new Error(`"${key}" must be a non-empty string.`);
        }
      }
      return 'Reply posted.';
    },
  },
];

export function registerTools(registry: { register(tool: Tool): void }): void {
  for (const tool of tools) registry.register(tool);
}
