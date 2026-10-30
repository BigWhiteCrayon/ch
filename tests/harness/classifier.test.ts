import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model } from '../helpers';

const stream = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm', () => ({ stream }));

import {
  FLOOR,
  WORKSPACE_PROMPT,
  PROMPT,
  candidates,
  classify,
  effortFor,
  parse,
  pickModel,
} from '../../src/harness/classifier';

const replyWith = (text: string) =>
  stream.mockImplementation(() =>
    from<ChatEvent>([
      { type: 'text', delta: text.slice(0, 5) },
      { type: 'text', delta: text.slice(5) },
      { type: 'done', stopReason: 'end_turn' },
    ])
  );

const local = model({ id: 'mistral:7b', sophistication: 2 });
const hosted = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
const signal = () => new AbortController().signal;
const ask = (content: string) => ({ messages: [{ role: 'user' as const, content }] });
const sent = () => stream.mock.calls[0][0] as ChatRequest;

beforeEach(() => {
  // Braces matter: a function returned from beforeEach is run as a teardown
  stream.mockReset();
});

describe('the prompt', () => {
  it('asks for just a digit, an effort word and a task word, and stays bounded', () => {
    expect(PROMPT).toContain('Reply with only a digit and two words, like "3 medium coding".');
    // It is read by a small model on every single message, so its length is a
    // standing cost. Not a style rule: a bound, so that growth is deliberate.
    // Raised from 4000 once, for the scope rules and examples that took
    // llama3.2:3b from 60% of runs wholly right to about 75% (evals/classifier.ts,
    // 30 cases x 10 runs). A brief request is given 4096 tokens of context
    // (BRIEF_CONTEXT_LENGTH), which this leaves about two thirds of for the
    // conversation and the summary.
    expect(PROMPT.length).toBeLessThan(5200);
  });

  it('tells the model to rate the message rather than answer it', () => {
    expect(PROMPT).toContain('Do not answer it');
    expect(PROMPT).toContain('Rate what it asks for, not what was done before');
  });
});

describe('the prompt for a thread in a workspace', () => {
  it('rates the message the same way, but offers no general task', () => {
    const shared = PROMPT.slice(0, PROMPT.indexOf('general:'));
    expect(WORKSPACE_PROMPT.startsWith(shared)).toBe(true);
    expect(PROMPT).toContain('general: none of those.');
    expect(WORKSPACE_PROMPT).not.toContain('general:');
    expect(WORKSPACE_PROMPT).toContain("workspace of code on the user's computer");
    // Nothing is a general task there: a message that changes nothing is a question
    expect(WORKSPACE_PROMPT).toContain('a message that asks for nothing to be changed is a question');
  });
});

describe('parse', () => {
  it.each([
    ['3 medium coding', 3, 'medium', 'coding'],
    [' 5 high question\n', 5, 'high', 'question'],
    ['1 low general', 1, 'low', 'general'],
    ['Rating: 2, Medium, Question.', 2, 'medium', 'question'],
    ['**4** HIGH CODING', 4, 'high', 'coding'],
    ['coding high 4', 4, 'high', 'coding'],
    ['3 medium investigation', 3, 'medium', 'investigation'],
  ])('reads the level, effort and kind of task from %j', (reply, sophistication, effort, category) => {
    expect(parse(reply)).toEqual({ sophistication, effort, category });
  });

  // The prompt lays down which effort each level takes, so the two disagreeing
  // is a model sampling rather than following it: "4 medium" is what put a
  // message of "1" through a four-step coding reply (see effortFor)
  it.each([
    ['1 high coding', 1, 'low'],
    ['2 low coding', 2, 'medium'],
    ['3 high question', 3, 'medium'],
    ['4 medium coding', 4, 'high'],
    ['5 low coding', 5, 'high'],
  ])('takes the effort from the level, not the word, in %j', (reply, sophistication, effort) => {
    expect(parse(reply)).toMatchObject({ sophistication, effort });
  });

  it('gives every level the effort the prompt says it takes', () => {
    expect([1, 2, 3, 4, 5].map(effortFor)).toEqual(['low', 'medium', 'medium', 'high', 'high']);
    expect(PROMPT).toContain('1 is low. 2 and 3 are medium. 4 and 5 are high.');
  });

  it('takes an investigation in a workspace and outside one alike', () => {
    expect(parse('3 medium investigation', true)).toEqual({
      sophistication: 3,
      effort: 'medium',
      category: 'investigation',
    });
    expect(parse('3 medium investigation', false)).toEqual({
      sophistication: 3,
      effort: 'medium',
      category: 'investigation',
    });
  });

  it('assumes a general task when the reply leaves the kind out', () => {
    expect(parse('3')).toEqual({ sophistication: 3, effort: 'medium', category: 'general' });
    expect(parse('4 highly complex code')).toEqual({ sophistication: 4, effort: 'high', category: 'general' });
    expect(parse('2 low')).toEqual({ sophistication: 2, effort: 'medium', category: 'general' });
    expect(parse('2 question')).toEqual({ sophistication: 2, effort: 'medium', category: 'question' });
  });

  it('never takes a task in a workspace to be general: one that is not coding is a question', () => {
    expect(parse('1 low general', true)).toEqual({ sophistication: 1, effort: 'low', category: 'question' });
    expect(parse('3', true)).toEqual({ sophistication: 3, effort: 'medium', category: 'question' });
    expect(parse('3 medium coding', true)).toEqual({ sophistication: 3, effort: 'medium', category: 'coding' });
    expect(parse('2 high question', true)).toEqual({ sophistication: 2, effort: 'medium', category: 'question' });
    expect(parse('1 low general', false).category).toBe('general');
  });

  it.each([
    ['no number at all', 'This looks like a high effort coding task.'],
    ['an empty reply', ''],
    ['a level below the scale', '0 low general'],
    ['a level above the scale', '6 high coding'],
    ['a longer number that starts with a valid digit', '10 low question'],
  ])('rejects %s', (_name, reply) => {
    expect(parse(reply)).toBeNull();
  });
});

describe('pickModel', () => {
  it('uses the least sophisticated model there is, local or hosted', () => {
    const models = [
      hosted,
      model({ id: 'qwen:32b', sophistication: 3 }),
      model({ id: 'mistral:7b', sophistication: 2 }),
      model({ id: 'llama:3b', sophistication: 1 }),
    ];
    expect(pickModel(models)?.id).toBe('llama:3b');

    const nano = model({ id: 'nano', provider: 'openai', local: false, sophistication: 1 });
    expect(pickModel([hosted, nano, local])?.id).toBe('nano');
  });

  it('prefers a local model over a hosted one at the same level', () => {
    const haiku = model({ id: 'haiku', provider: 'anthropic', local: false, sophistication: 2 });
    expect(pickModel([hosted, haiku, local])?.id).toBe('mistral:7b');
  });

  it('uses whatever there is when there is only one model', () => {
    expect(pickModel([hosted])?.id).toBe('opus');
  });

  it('returns undefined when there are no models', () => {
    expect(pickModel([])).toBeUndefined();
  });

  // A model too small to rate a message well is worse than the 400ms saved by
  // asking it: it decides the model, the effort and the instructions for the
  // whole reply (see FLOOR)
  it('skips a model below the floor and takes the cheapest one above it', () => {
    const tiny = model({ id: 'llama3.2:3b', sophistication: 0 });
    const nineB = model({ id: 'qwen3.5:9b', sophistication: FLOOR });
    expect(pickModel([tiny, nineB, hosted])?.id).toBe('qwen3.5:9b');
    // ...and still the cheapest above it, not the best there is
    expect(pickModel([tiny, hosted, nineB, local])?.id).toBe('qwen3.5:9b');
  });

  it('asks a model below the floor when there is nothing above it, a late rating beating none', () => {
    const tiny = model({ id: 'llama3.2:3b', sophistication: 0 });
    const tinier = model({ id: 'tiny:1b', sophistication: 0 });
    expect(pickModel([tiny])?.id).toBe('llama3.2:3b');
    // Still cheapest-first among them
    expect(pickModel([tiny, tinier])?.sophistication).toBe(0);
  });
});

describe('candidates', () => {
  const smaller = model({ id: 'llama:3b', sophistication: 1 });
  const nano = model({ id: 'nano', provider: 'openai', local: false, sophistication: 1 });

  it('asks the cheapest model first and the cheapest elsewhere second', () => {
    // nano is the least sophisticated of the three, and mistral the least of
    // what is left on another provider
    expect(candidates([hosted, local, nano]).map((m) => m.id)).toEqual(['nano', 'mistral:7b']);
  });

  it('never offers two models on one provider: a server with no room would turn both away', () => {
    expect(candidates([local, smaller, hosted]).map((m) => m.id)).toEqual(['llama:3b', 'opus']);
  });

  it('offers the one model there is when they are all on the same provider', () => {
    expect(candidates([local, smaller]).map((m) => m.id)).toEqual(['llama:3b']);
    expect(candidates([local])).toEqual([local]);
  });

  it('offers nothing when there are no models', () => {
    expect(candidates([])).toEqual([]);
  });

  it('leaves out a model below the floor, here and in the fall-back', () => {
    const tiny = model({ id: 'llama3.2:3b', sophistication: 0 });
    const nineB = model({ id: 'qwen3.5:9b', sophistication: FLOOR });
    expect(candidates([tiny, nineB, hosted]).map((m) => m.id)).toEqual(['qwen3.5:9b', 'opus']);
    // The only local model being below the floor leaves the hosted one alone,
    // rather than pairing it with a model whose rating is not worth having
    expect(candidates([tiny, hosted]).map((m) => m.id)).toEqual(['opus']);
  });

  it('falls back to what there is when every model is below the floor', () => {
    const tiny = model({ id: 'llama3.2:3b', sophistication: 0 });
    const other = model({ id: 'tiny:1b', provider: 'lmstudio', sophistication: 0 });
    expect(candidates([tiny, other]).map((m) => m.id)).toEqual(['llama3.2:3b', 'tiny:1b']);
  });
});

describe('classify', () => {
  it('asks the chosen model and returns its judgement with the model named', async () => {
    replyWith('3 medium coding');
    await expect(classify(ask('fix my bug'), [hosted, local], signal())).resolves.toEqual({
      sophistication: 3,
      effort: 'medium',
      category: 'coding',
      model: 'mistral:7b',
      provider: 'local',
    });
    expect(sent()).toMatchObject({ provider: 'local', model: 'mistral:7b', system: PROMPT });
    // Ahead of other work queued for a local model
    expect(sent().priority).toBe(true);
    // Little context is needed, so a local model needn't be loaded with much
    expect(sent().brief).toBe(true);
  });

  it('uses the workspace prompt, and allows no general task, for a thread in a workspace', async () => {
    replyWith('2 low general');
    const inWorkspace = { ...ask('thanks!'), workspace: '/projects/demo' };
    await expect(classify(inWorkspace, [local], signal())).resolves.toMatchObject({ category: 'question' });
    expect(sent().system).toBe(WORKSPACE_PROMPT);

    stream.mockClear();
    replyWith('2 low general');
    await expect(classify(ask('thanks!'), [local], signal())).resolves.toMatchObject({ category: 'general' });
    expect(sent().system).toBe(PROMPT);
  });

  it("shows a thread in a workspace the workspace's note, ahead of the examples", async () => {
    replyWith('2 low question');
    const note = 'ch is a desktop coding chat app built with Electron.';
    await classify({ ...ask('hi'), workspace: '/projects/demo', note }, [local], signal());
    const system = sent().system as string;
    expect(system).toContain(`<project>\n${note}\n</project>`);
    expect(system.indexOf('<project>')).toBeLessThan(system.indexOf('Examples:'));
    expect(system.startsWith(WORKSPACE_PROMPT.slice(0, WORKSPACE_PROMPT.indexOf('Examples:')))).toBe(true);

    // No note, or a blank one, leaves the prompt as it was; a general chat never has one
    for (const request of [
      { ...ask('hi'), workspace: '/projects/demo', note: '  ' },
      { ...ask('hi'), workspace: '/projects/demo' },
    ]) {
      stream.mockClear();
      replyWith('2 low question');
      await classify(request, [local], signal());
      expect(sent().system).toBe(WORKSPACE_PROMPT);
    }
    stream.mockClear();
    replyWith('2 low general');
    await classify({ ...ask('hi'), note }, [local], signal());
    expect(sent().system).toBe(PROMPT);
  });

  it('reports that it is waiting behind a request in progress, and still classifies', async () => {
    stream.mockImplementation(() =>
      from<ChatEvent>([
        { type: 'queued' },
        { type: 'text', delta: '2 low question' },
        { type: 'done', stopReason: 'end_turn' },
      ])
    );
    const onQueued = vi.fn();
    await expect(classify(ask('hi'), [local], signal(), onQueued)).resolves.toMatchObject({ sophistication: 2 });
    expect(onQueued).toHaveBeenCalledOnce();

    replyWith('2 low question');
    onQueued.mockClear();
    await classify(ask('hi'), [local], signal(), onQueued);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('passes on the tokens it used, whether or not the reply was usable', async () => {
    const answer = (reply: string) =>
      stream.mockImplementation(() =>
        from<ChatEvent>([
          { type: 'text', delta: reply },
          { type: 'done', stopReason: 'end_turn', usage: { input: 140, output: 4 } },
        ])
      );
    answer('2 low question');
    await expect(classify(ask('hi'), [local], signal())).resolves.toMatchObject({
      sophistication: 2,
      provider: 'local',
      usage: { input: 140, output: 4 },
    });
    answer('no idea');
    await expect(classify(ask('hi'), [local], signal())).resolves.toMatchObject({
      failed: true,
      usage: { input: 140, output: 4 },
    });
  });

  it('wraps the conversation so the model rates it instead of answering', async () => {
    replyWith('1 low general');
    await classify(
      {
        messages: [
          { role: 'user', content: 'What is Rust?' },
          { role: 'assistant', content: 'A language.' },
          { role: 'user', content: 'Show me a loop in it' },
        ],
      },
      [local],
      signal()
    );
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content:
          '<conversation>\n' +
          'user: What is Rust?\n\n' +
          'assistant: A language.\n\n' +
          'user: Show me a loop in it\n' +
          '</conversation>\n\n' +
          'Rating:',
      },
    ]);
  });

  it('puts the summary of the earlier conversation ahead of the recent messages, when there is one', async () => {
    replyWith('1 low general');
    await classify({ ...ask('and then?'), summary: '  The user is building a CLI.  ' }, [local], signal());
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content:
          '<summary>\n' +
          'The user is building a CLI.\n' +
          '</summary>\n\n' +
          '<conversation>\n' +
          'user: and then?\n' +
          '</conversation>\n\n' +
          'Rating:',
      },
    ]);
  });

  it('sends no summary when there is none, or it is blank', async () => {
    for (const summary of [undefined, '   ']) {
      stream.mockClear();
      replyWith('1 low general');
      await classify({ ...ask('and then?'), summary }, [local], signal());
      expect((sent().messages[0] as { content: string }).content).not.toContain('<summary>');
    }
  });

  it('sends only the most recent messages and shortens very long ones', async () => {
    replyWith('1 low general');
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: i === 9 ? 'x'.repeat(5000) : `message ${i}`,
    }));
    await classify({ messages }, [local], signal());
    const content = (sent().messages[0] as { content: string }).content;
    expect(content).not.toContain('message 5');
    expect(content).toContain('message 6');
    expect(content).toContain(`${'x'.repeat(600)} [...]`);
    expect(content).not.toContain('x'.repeat(601));
  });

  it('fails when there are no models', async () => {
    await expect(classify(ask('hi'), [], signal())).resolves.toEqual({
      failed: true,
      reason: 'No models available.',
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it('fails when the reply cannot be used', async () => {
    replyWith('It looks like a coding question to me.');
    await expect(classify(ask('hi'), [local], signal())).resolves.toEqual({
      failed: true,
      reason: 'The reply was not a level from 1 to 5.',
      model: 'mistral:7b',
      provider: 'local',
      reply: 'It looks like a coding question to me.',
    });
  });

  it('fails with the provider error', async () => {
    stream.mockImplementation(() =>
      from<ChatEvent>([{ type: 'error', code: 'unreachable', message: 'No server reachable' }])
    );
    await expect(classify(ask('hi'), [local], signal())).resolves.toEqual({
      failed: true,
      reason: 'No server reachable',
      model: 'mistral:7b',
      provider: 'local',
    });
  });

  it('never throws, even if the model call does', async () => {
    stream.mockImplementation(() => {
      throw new Error('exploded');
    });
    const result = await classify(ask('hi'), [local], signal());
    expect(result).toEqual({ failed: true, reason: 'exploded', model: 'mistral:7b', provider: 'local' });
  });

  it('allows the only model there is two minutes, and passes on the signal that cancels it', async () => {
    replyWith('1 low general');
    const caller = new AbortController();
    await classify(ask('hi'), [local], caller.signal);
    expect(sent().timeoutMs).toBe(120_000);
    expect(stream.mock.calls[0][1]).toBe(caller.signal);
  });

  // A local server with a big model mid-reply cannot load the small one that
  // rates the message, and the rating is what the reply is waiting on
  it('asks a model on another provider when the first cannot be started', async () => {
    stream
      .mockImplementationOnce(() =>
        from<ChatEvent>([
          { type: 'error', code: 'other', message: 'mistral:7b could not be started: it did not load in time' },
        ])
      )
      .mockImplementationOnce(() =>
        from<ChatEvent>([
          { type: 'text', delta: '3 medium coding' },
          { type: 'done', stopReason: 'end_turn' },
        ])
      );

    await expect(classify(ask('fix my bug'), [local, hosted], signal())).resolves.toEqual({
      sophistication: 3,
      effort: 'medium',
      category: 'coding',
      model: 'opus',
      provider: 'anthropic',
      usage: undefined,
    });
    expect(stream.mock.calls.map(([req]: [ChatRequest]) => req.model)).toEqual(['mistral:7b', 'opus']);
  });

  it('gives the first model less time than the last, which has nowhere to fall back to', async () => {
    replyWith('1 low general');
    await classify(ask('hi'), [local, hosted], signal());
    expect(sent().timeoutMs).toBe(60_000);
  });

  it('gives the model it falls back to the whole of the time, there being nobody after it', async () => {
    stream
      .mockImplementationOnce(() => from<ChatEvent>([{ type: 'error', code: 'other', message: 'no room' }]))
      .mockImplementationOnce(() =>
        from<ChatEvent>([
          { type: 'text', delta: '1 low general' },
          { type: 'done', stopReason: 'end_turn' },
        ])
      );
    await classify(ask('hi'), [local, hosted], signal());
    expect((stream.mock.calls[1][0] as ChatRequest).timeoutMs).toBe(120_000);
  });

  it('reports the last failure when nothing could be started', async () => {
    stream.mockImplementation(() =>
      from<ChatEvent>([{ type: 'error', code: 'unreachable', message: 'No server reachable' }])
    );
    await expect(classify(ask('hi'), [local, hosted], signal())).resolves.toEqual({
      failed: true,
      reason: 'No server reachable',
      model: 'opus',
      provider: 'anthropic',
    });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('asks nobody else about a reply it could not read: the model has had its say', async () => {
    replyWith('It looks like a coding question to me.');
    await expect(classify(ask('hi'), [local, hosted], signal())).resolves.toMatchObject({
      failed: true,
      model: 'mistral:7b',
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('asks nobody else once the user has given up', async () => {
    const caller = new AbortController();
    stream.mockImplementation(() => {
      caller.abort();
      return from<ChatEvent>([{ type: 'error', code: 'other', message: 'cancelled' }]);
    });
    await classify(ask('hi'), [local, hosted], caller.signal);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
