import { describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';
import { PLAIN_PROMPT, PROMPT, SUMMARY_PROMPT, comments } from '../../src/harness/review';
import { registerTools, tools } from '../../src/tools/review';

const [reply] = tools;
const context = { signal: new AbortController().signal, threadId: 't', workspace: '/projects/demo' };

describe('what the model is told once reviewers have been through them', () => {
  it('says the work is done and replied to, and asks only for the summary', () => {
    expect(unwrapped(SUMMARY_PROMPT)).toContain('each has already been replied to');
    expect(unwrapped(SUMMARY_PROMPT)).toContain('Do not go through the comments again');
    expect(unwrapped(SUMMARY_PROMPT)).toContain('do not call reply_to_comment');
    expect(unwrapped(SUMMARY_PROMPT)).toContain('short summary');
    // ...and to be straight about what could not be done
    expect(unwrapped(SUMMARY_PROMPT)).toContain('could not do what was asked');
  });
});

describe('the comments in a review message', () => {
  const message = [
    'Review comments on your changes:',
    '',
    '[c1] src/a.ts, line 3',
    '> const x = 1;',
    'Me: rename this',
    'You: to what?',
    'Me: to count',
    '',
    '[c2] src/b.ts',
    '> export const b = 2;',
    'Me: what is this for?',
  ].join('\n');

  it('are taken back out one at a time, keeping the whole of what was said', () => {
    const found = comments(message);
    expect(found.map((c) => c.id)).toEqual(['c1', 'c2']);
    // Each keeps where it is, the line it quotes and the conversation so far
    expect(found[0].body).toContain('src/a.ts, line 3');
    expect(found[0].body).toContain('> const x = 1;');
    expect(found[0].body).toContain('Me: to count');
    expect(found[0].body).not.toContain('what is this for?');
  });

  it('are none for a message that is not a review', () => {
    expect(comments('just a question about the code')).toEqual([]);
    expect(comments('')).toEqual([]);
  });

  it('are none when the heading is there but no comment is', () => {
    expect(comments('Review comments on your changes:')).toEqual([]);
  });

  it('keep a comment whose own text has blank lines in it', () => {
    const awkward = 'Review comments on your changes:\n\n[c1] a.ts\nMe: this\n\nand that\n\n[c2] b.ts\nMe: other';
    const found = comments(awkward);
    expect(found.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(found[0].body).toContain('and that');
  });
});

describe('the review prompts', () => {
  it('have the model change what is asked for, answer what is asked, and reply to every comment', () => {
    expect(unwrapped(PROMPT)).toContain('If it asks for a change, make that change in the files');
    expect(unwrapped(PROMPT)).toContain('If it asks a question, work out the answer');
    expect(unwrapped(PROMPT)).toContain('do not change anything for a question');
    expect(unwrapped(PROMPT)).toContain('Reply to every comment, once each');
  });

  it('have a model without tools answer under each id instead', () => {
    expect(unwrapped(PLAIN_PROMPT)).toContain('under its id');
    expect(unwrapped(PLAIN_PROMPT)).not.toContain('reply_to_comment');
  });
});

describe('reply_to_comment', () => {
  it('is only offered in a workspace thread, on a message that carries review comments', () => {
    expect(reply).toMatchObject({ name: 'reply_to_comment', needsWorkspace: true, needsReview: true });
    expect(reply.inputSchema).toMatchObject({ required: ['comment_id', 'reply'] });
  });

  it('accepts a reply to a comment', () => {
    expect(reply.run({ comment_id: 'c1', reply: 'Done.' }, context)).toBe('Reply posted.');
  });

  it.each([
    ['no comment id', { reply: 'Done.' }, '"comment_id" must be a non-empty string.'],
    ['an empty reply', { comment_id: 'c1', reply: '  ' }, '"reply" must be a non-empty string.'],
  ])('rejects %s', (_name, input, message) => {
    expect(() => reply.run(input, context)).toThrow(message);
  });

  it('registers with the registry it is given', () => {
    const registry = { register: vi.fn() };
    registerTools(registry);
    expect(registry.register.mock.calls.map(([tool]) => tool.name)).toEqual(['reply_to_comment']);
  });
});
