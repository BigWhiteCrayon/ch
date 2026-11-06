import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '../../../src/types';
import { collect } from '../../helpers';

// What the provider says about a thinking block the API dropped (see dropped
// in providers/anthropic.ts); nothing else here logs
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../../src/log', () => log);

// A stand-in for the Anthropic SDK: same shape, no network.
const sdk = vi.hoisted(() => {
  class AnthropicError extends Error {}
  class APIError extends AnthropicError {
    constructor(
      public status: number | undefined,
      message: string
    ) {
      super(message);
    }
  }
  class AuthenticationError extends APIError {}
  class BadRequestError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}

  const state = {
    constructed: [] as unknown[],
    models: [] as unknown[],
    listError: null as unknown,
    stream: (..._args: unknown[]): unknown => undefined,
    streamCalls: [] as unknown[][],
  };

  class Anthropic {
    static AnthropicError = AnthropicError;
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static BadRequestError = BadRequestError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;

    constructor(options: unknown) {
      state.constructed.push(options);
    }

    models = {
      list: () =>
        (async function* () {
          if (state.listError) throw state.listError;
          yield* state.models;
        })(),
    };

    // Chatting goes through the beta endpoint: only it takes the 'updates'
    // thinking display
    beta = {
      messages: {
        stream: (...args: unknown[]) => {
          state.streamCalls.push(args);
          return state.stream(...args);
        },
      },
    };
  }

  return { Anthropic, state, APIError, AuthenticationError, BadRequestError, RateLimitError, APIConnectionError };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: sdk.Anthropic }));

import { createAnthropicProvider, toMessages } from '../../../src/llm/providers/anthropic';

// What messages.stream() returns: stream events, then the final message
function reply(events: unknown[], final: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    finalMessage: async () => final,
  };
}

const textDelta = (text: string) => ({
  type: 'content_block_delta',
  delta: { type: 'text_delta', text },
});

const thinkingDelta = (thinking: string) => ({
  type: 'content_block_delta',
  delta: { type: 'thinking_delta', thinking },
});

// What the Models API reports about a model's thinking
// What every request that asks for thinking says about a thinking block whose
// signature no longer matches the request it is sent back in: drop it rather
// than refuse the request (see KEEP_GOING in providers/anthropic.ts)
const KEEP_GOING = { prefix_mismatch_behavior: 'drop_block' };

const canThink = (adaptive: boolean) => ({
  thinking: { supported: true, types: { adaptive: { supported: adaptive }, enabled: { supported: true } } },
});

const request: ChatRequest = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'hi' }],
};

const signal = () => new AbortController().signal;
const sentParams = () => sdk.state.streamCalls[0][0] as Record<string, unknown>;

beforeEach(() => {
  sdk.state.constructed = [];
  sdk.state.models = [];
  sdk.state.listError = null;
  sdk.state.streamCalls = [];
  sdk.state.stream = () =>
    reply([], { content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
});

describe('toMessages', () => {
  it('passes plain messages through', () => {
    expect(toMessages([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('puts all results for one assistant turn in a single user message', () => {
    const converted = toMessages([
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [
          { id: 't1', name: 'get_time', input: { zone: 'Paris' } },
          { id: 't2', name: 'get_time', input: { zone: 'Tokyo' } },
        ],
      },
      { role: 'tool', toolCallId: 't1', name: 'get_time', content: '12:00', isError: false },
      { role: 'tool', toolCallId: 't2', name: 'get_time', content: 'no such zone', isError: true },
    ]);
    expect(converted).toEqual([
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 't1', name: 'get_time', input: { zone: 'Paris' } },
          { type: 'tool_use', id: 't2', name: 'get_time', input: { zone: 'Tokyo' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '12:00' },
          { type: 'tool_result', tool_use_id: 't2', content: 'no such zone', is_error: true },
        ],
      },
    ]);
  });

  it('starts a new results message for each assistant turn', () => {
    const turn = (id: string) =>
      [
        { role: 'assistant', content: '', toolCalls: [{ id, name: 't', input: {} }] },
        { role: 'tool', toolCallId: id, name: 't', content: 'ok', isError: false },
      ] as const;
    const converted = toMessages([...turn('a'), ...turn('b')]);
    expect(converted.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(converted[1].content).toHaveLength(1);
    expect(converted[3].content).toHaveLength(1);
  });

  it("sends Anthropic's own earlier reply back unchanged, thinking blocks included", () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'SIG' },
      { type: 'tool_use', id: 't1', name: 't', input: {} },
    ];
    const converted = toMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 't', input: {} }],
        raw: { provider: 'anthropic', content: raw },
      },
    ]);
    expect(converted[0].content).toBe(raw);
  });

  // The harness's nudges go in as a user turn with no assistant turn before
  // them, so two of the user's turns land in a row (see NO_ANSWER)
  it("folds a user turn that follows the user's own into it, so the turns still alternate", () => {
    const converted = toMessages([
      { role: 'user', content: 'Explain it.' },
      { role: 'user', content: 'You wrote nothing.' },
    ]);
    expect(converted).toHaveLength(1);
    expect(converted[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Explain it.' },
        { type: 'text', text: 'You wrote nothing.' },
      ],
    });
  });

  it('folds a nudge after a round of tools in with the results, which is one turn', () => {
    const converted = toMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 't', input: {} }] },
      { role: 'tool', toolCallId: 't1', name: 't', content: 'ok', isError: false },
      { role: 'user', content: 'You wrote nothing.' },
    ]);
    expect(converted.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(converted[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'text', text: 'You wrote nothing.' },
    ]);
  });

  it('turns a user message with an image into a text block and an image block', () => {
    const converted = toMessages([
      { role: 'user', content: 'What is in this picture?', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] },
    ]);
    expect(converted).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    ]);
  });

  it('rebuilds the reply from its parts when it came from another provider', () => {
    const converted = toMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 't', input: null }],
        raw: { provider: 'openai', content: 'something else' },
      },
    ]);
    expect(converted[0].content).toEqual([{ type: 'tool_use', id: 't1', name: 't', input: {} }]);
  });
});

describe('client credentials', () => {
  it('passes a saved key to the SDK', async () => {
    await createAnthropicProvider({ apiKey: 'sk-saved' }).listModels();
    expect(sdk.state.constructed).toEqual([{ apiKey: 'sk-saved' }]);
  });

  it('lets the SDK read the environment when no key is saved', async () => {
    await createAnthropicProvider({ apiKey: '' }).listModels();
    expect(sdk.state.constructed).toEqual([undefined]);
  });

  it('creates the client once and reuses it', async () => {
    const provider = createAnthropicProvider({ apiKey: 'k' });
    await provider.listModels();
    await collect(provider.stream(request, signal()));
    expect(sdk.state.constructed).toHaveLength(1);
  });
});

describe('listModels', () => {
  it('maps the models and marks the default', async () => {
    sdk.state.models = [
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    ];
    await expect(createAnthropicProvider({ apiKey: 'k' }).listModels()).resolves.toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        contextWindow: 1000000,
        default: true,
        reasons: false,
        vision: false,
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        contextWindow: null,
        default: false,
        reasons: false,
        vision: false,
      },
    ]);
  });

  it('says a model takes images only when the API says it does', async () => {
    sdk.state.models = [
      { id: 'sees', display_name: 'Sees', capabilities: { image_input: { supported: true } } },
      { id: 'blind', display_name: 'Blind', capabilities: { image_input: { supported: false } } },
    ];
    const models = await createAnthropicProvider({ apiKey: 'k' }).listModels();
    expect(models.map((m) => [m.id, m.vision])).toEqual([
      ['sees', true],
      ['blind', false],
    ]);
  });

  it('says a model reports its own reasoning only when it can be asked to think adaptively', async () => {
    sdk.state.models = [
      { id: 'adaptive', display_name: 'Adaptive', capabilities: canThink(true) },
      // Thinks, but only to a fixed token budget, which this never asks for
      { id: 'budgeted', display_name: 'Budgeted', capabilities: canThink(false) },
      { id: 'no-thinking', display_name: 'Plain', capabilities: null },
    ];
    const models = await createAnthropicProvider({ apiKey: 'k' }).listModels();
    expect(models.map((m) => [m.id, m.reasons])).toEqual([
      ['adaptive', true],
      ['budgeted', false],
      ['no-thinking', false],
    ]);
  });

  it('explains missing credentials', async () => {
    sdk.state.listError = new Error('Could not resolve authentication method');
    await expect(createAnthropicProvider({ apiKey: '' }).listModels()).rejects.toThrow(
      'No Anthropic API key found. Add one in Settings.'
    );
  });

  it('explains a rejected key', async () => {
    sdk.state.listError = new sdk.AuthenticationError(401, '401 invalid x-api-key');
    await expect(createAnthropicProvider({ apiKey: 'bad' }).listModels()).rejects.toThrow(
      'Anthropic rejected the API key'
    );
  });

  it('passes other failures through', async () => {
    sdk.state.listError = new sdk.APIError(500, 'overloaded');
    await expect(createAnthropicProvider({ apiKey: 'k' }).listModels()).rejects.toThrow('overloaded');
  });
});

describe('stream', () => {
  it('streams text and finishes with usage and the raw reply', async () => {
    const content = [{ type: 'text', text: 'Hello' }];
    sdk.state.stream = () =>
      reply([{ type: 'message_start' }, textDelta('Hel'), textDelta('lo')], {
        content,
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      {
        type: 'done',
        stopReason: 'end_turn',
        usage: { input: 10, output: 2, cacheWrite: 0, cacheRead: 0 },
        raw: { provider: 'anthropic', content },
      },
    ]);
  });

  // The API takes a thinking block out of the prompt where its signature no
  // longer matches the request it came back in, rather than refusing the
  // request over it (see KEEP_GOING). It is worth a line: the step ran, and it
  // ran without what it was thinking a moment ago.
  it('says when the API dropped a thinking block it sent back', async () => {
    log.debug.mockClear();
    sdk.state.stream = () =>
      reply(
        [
          {
            type: 'message_start',
            message: {
              usage: { input_tokens: 1, output_tokens: 0 },
              input_transformations: [
                { type: 'thinking_dropped', path: 'messages.3.content.1' },
                { type: 'thinking_mismatch_allowed', path: 'messages.5.content.0' },
              ],
            },
          },
          textDelta('Carrying on.'),
        ],
        { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }
      );
    const asked = { ...request, log: { purpose: 'subagent', subagent: 'renderer-ui' } };
    const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(asked, signal()));
    expect(events[0]).toEqual({ type: 'tokens', usage: { input: 1, output: 0 } });
    // Only the ones that were taken out, and whose request lost them
    expect(log.debug).toHaveBeenCalledWith('llm.unbound', {
      model: request.model,
      purpose: 'subagent',
      subagent: 'renderer-ui',
      blocks: 1,
      at: ['messages.3.content.1'],
    });
  });

  it('says nothing where the API dropped none, which is every other request', async () => {
    log.debug.mockClear();
    sdk.state.stream = () =>
      reply([{ type: 'message_start', message: { usage: {}, input_transformations: [] } }, textDelta('Hi')], {
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
    expect(log.debug).not.toHaveBeenCalled();
  });

  // ---- What the call has used, while it is still being written
  //
  // This API counts as it goes: the prompt before the reply begins, and the
  // output as it is written. Passed on so the window has a figure climbing
  // rather than nothing until the pass ends (see TokensEvent).
  describe('the counts as they arrive', () => {
    const messageStart = (usage: Record<string, number | null>) => ({ type: 'message_start', message: { usage } });
    const messageDelta = (usage: Record<string, number | null>) => ({ type: 'message_delta', usage });
    const streamed = async (events: unknown[], final: unknown) => {
      sdk.state.stream = () => reply(events, final);
      const seen = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
      return seen;
    };

    it('reports the prompt before the model has written anything, and the output as it goes', async () => {
      const seen = await streamed(
        [
          messageStart({ input_tokens: 1000, output_tokens: 1 }),
          textDelta('Hel'),
          messageDelta({ output_tokens: 20 }),
          textDelta('lo'),
          messageDelta({ output_tokens: 42 }),
        ],
        { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 42 } }
      );
      expect(seen.filter((e) => e.type === 'tokens')).toEqual([
        { type: 'tokens', usage: { input: 1000, output: 1 } },
        { type: 'tokens', usage: { input: 1000, output: 20 } },
        { type: 'tokens', usage: { input: 1000, output: 42 } },
      ]);
    });

    // A delta says only what has changed and leaves the rest null, so each
    // report is added into one running count rather than passed on as it came
    it('keeps what an event left out, a delta being only what changed', async () => {
      const seen = await streamed(
        [
          messageStart({
            input_tokens: 40,
            output_tokens: 0,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 950,
          }),
          messageDelta({ input_tokens: null, output_tokens: 7, cache_read_input_tokens: null }),
        ],
        { content: [], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 7 } }
      );
      // The cached tokens are counted into the input, as they are in the
      // finished call's usage: a total is every token the call paid for
      expect(seen.filter((e) => e.type === 'tokens')).toEqual([
        { type: 'tokens', usage: { input: 1000, output: 0, cacheWrite: 10, cacheRead: 950 } },
        { type: 'tokens', usage: { input: 1000, output: 7, cacheWrite: 10, cacheRead: 950 } },
      ]);
    });

    it('says nothing where an event carried no counts at all', async () => {
      const seen = await streamed([{ type: 'message_start' }, textDelta('Hi')], {
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      expect(seen.filter((e) => e.type === 'tokens')).toEqual([]);
    });

    it("ends on the finished message's own counts, whatever the reports said", async () => {
      const seen = await streamed([messageStart({ input_tokens: 1000, output_tokens: 1 }), textDelta('Hi')], {
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 9, cache_read_input_tokens: 64 },
      });
      expect(seen.at(-1)).toMatchObject({
        type: 'done',
        usage: { input: 1064, output: 9, cacheWrite: 0, cacheRead: 64 },
      });
    });
  });

  it('reports tool calls from the final message', async () => {
    sdk.state.stream = () =>
      reply([], {
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG' },
          { type: 'tool_use', id: 't1', name: 'get_time', input: { zone: 'Paris' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
    expect(events[0]).toEqual({ type: 'tool_call', id: 't1', name: 'get_time', input: { zone: 'Paris' } });
    expect(events[1]).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });

  it('sends system and tools only when given, and passes the abort signal', async () => {
    const provider = createAnthropicProvider({ apiKey: 'k' });
    const abort = signal();
    await collect(provider.stream(request, abort));
    expect(sentParams()).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    });
    expect(sdk.state.streamCalls[0][1]).toEqual({ signal: abort });

    sdk.state.streamCalls = [];
    const tool = { name: 'get_time', description: 'Time.', inputSchema: { type: 'object' } };
    await collect(provider.stream({ ...request, system: 'Be brief.', tools: [tool] }, abort));
    expect(sentParams()).toMatchObject({
      system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'get_time', description: 'Time.', input_schema: { type: 'object' } }],
    });
  });

  // Everything before a breakpoint can be read back from the cache on the next
  // step instead of being charged for again (see pricing.cost). The system
  // prompt carries one, which covers the tools in front of it, and the end of
  // the conversation carries the other.
  // The rest of the app knows a cut-off reply as 'length', which is what
  // OpenAI and Ollama both call it; Anthropic calls it something else, and
  // untranslated it was read as a reply that had simply stopped
  describe('how a reply ended', () => {
    const ended = async (stop: string) => {
      sdk.state.stream = () =>
        reply([{ type: 'message_start' }], {
          content: [],
          stop_reason: stop,
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
      return events.at(-1) as { stopReason?: string };
    };

    it("calls a reply cut off at its token ceiling 'length', as the other providers do", async () => {
      expect((await ended('max_tokens')).stopReason).toBe('length');
    });

    it("calls a reply that outgrew the window 'length' too", async () => {
      expect((await ended('model_context_window_exceeded')).stopReason).toBe('length');
    });

    it('passes its own reasons on as they are, a refusal being the one that matters', async () => {
      expect((await ended('refusal')).stopReason).toBe('refusal');
      expect((await ended('end_turn')).stopReason).toBe('end_turn');
      expect((await ended('tool_use')).stopReason).toBe('tool_use');
    });
  });

  describe('the prompt cache', () => {
    const tool = { name: 'get_time', description: 'Time.', inputSchema: { type: 'object' } };

    it('breaks after the system prompt and at the end of the conversation', async () => {
      const messages = [
        { role: 'user' as const, content: 'hi' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 't1', name: 'get_time', input: {} }] },
        { role: 'tool' as const, toolCallId: 't1', name: 'get_time', content: 'noon' },
      ];
      await collect(
        createAnthropicProvider({ apiKey: 'k' }).stream(
          { ...request, system: 'Be brief.', tools: [tool], messages },
          signal()
        )
      );
      const sent = sentParams();
      expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
      // The tool results for one turn go back as a single user message, and
      // the breakpoint goes on the last of them
      expect(sent.messages.at(-1).content.at(-1)).toMatchObject({
        type: 'tool_result',
        cache_control: { type: 'ephemeral' },
      });
      // Only the end of the conversation, not every message in it
      expect(JSON.stringify(sent.messages.slice(0, -1))).not.toContain('cache_control');
    });

    it('leaves a conversation alone when its last block cannot carry a breakpoint', async () => {
      // Our own earlier reply, passed back with the thinking block the model
      // signed; and a message with nothing in it
      const thinking = {
        role: 'assistant' as const,
        content: '',
        raw: { provider: 'anthropic', content: [{ type: 'thinking', thinking: 'hm', signature: 'SIG' }] },
      };
      await collect(createAnthropicProvider({ apiKey: 'k' }).stream({ ...request, messages: [thinking] }, signal()));
      expect(JSON.stringify(sentParams().messages)).not.toContain('cache_control');

      sdk.state.streamCalls = [];
      const empty = [{ role: 'user' as const, content: '' }];
      await collect(createAnthropicProvider({ apiKey: 'k' }).stream({ ...request, messages: empty }, signal()));
      expect(sentParams().messages).toEqual([{ role: 'user', content: '' }]);
    });

    it('counts cached tokens into the input they are part of, and reports them', async () => {
      sdk.state.stream = () =>
        reply([], {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
          },
        });
      const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
      expect(events.at(-1)).toMatchObject({
        usage: { input: 1110, output: 2, cacheWrite: 100, cacheRead: 1000 },
      });
    });
  });

  it('never opts in to refusal fallbacks', async () => {
    await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
    expect(sentParams()).not.toHaveProperty('fallbacks');
  });

  it("caps max_tokens at the model's output limit once it is known", async () => {
    sdk.state.models = [{ id: 'claude-haiku-4-5', display_name: 'Haiku', max_tokens: 8000 }];
    const provider = createAnthropicProvider({ apiKey: 'k' });
    await provider.listModels();
    await collect(provider.stream({ ...request, model: 'claude-haiku-4-5' }, signal()));
    expect(sentParams().max_tokens).toBe(8000);

    sdk.state.streamCalls = [];
    await collect(provider.stream({ ...request, model: 'claude-haiku-4-5', maxTokens: 100 }, signal()));
    expect(sentParams().max_tokens).toBe(100);
  });

  describe("the model's own reasoning", () => {
    const tool = { name: 'get_time', description: 'Time.', inputSchema: { type: 'object' } };
    // A model that can be asked to think, as listModels found out
    const thinker = async () => {
      sdk.state.models = [{ id: 'claude-opus-5-5', display_name: 'Opus', capabilities: canThink(true) }];
      const provider = createAnthropicProvider({ apiKey: 'k' });
      await provider.listModels();
      sdk.state.streamCalls = [];
      return provider;
    };

    it('is asked for as progress notes when there are tools, and passed on apart from the reply', async () => {
      sdk.state.stream = () =>
        reply([thinkingDelta('Checking the '), thinkingDelta('time.'), textDelta('It is noon.')], {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      const provider = await thinker();
      const events = await collect(provider.stream({ ...request, tools: [tool] }, signal()));
      expect(sentParams().thinking).toEqual({ type: 'adaptive', display: 'updates', block_binding: KEEP_GOING });
      expect(sentParams().betas).toEqual([
        'thinking-binding-controls-2026-08-01',
        'thinking-display-updates-2026-08-18',
      ]);
      expect(events.slice(0, 3)).toEqual([
        { type: 'reasoning', delta: 'Checking the ' },
        { type: 'reasoning', delta: 'time.' },
        { type: 'text', delta: 'It is noon.' },
      ]);
    });

    it('is asked for as a summary with no tools, since progress notes come between tool calls', async () => {
      const provider = await thinker();
      await collect(provider.stream(request, signal()));
      expect(sentParams().thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: KEEP_GOING });
      // The progress notes' own flag is the one that is not needed here
      expect(sentParams().betas).toEqual(['thinking-binding-controls-2026-08-01']);
    });

    it('falls back to a summary, from then on, for a model that turns the progress notes down', async () => {
      const provider = await thinker();
      let calls = 0;
      sdk.state.stream = () => {
        if (++calls === 1) throw new sdk.BadRequestError(400, 'display: updates is not supported');
        return reply([textDelta('It is noon.')], {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      };
      const events = await collect(provider.stream({ ...request, tools: [tool] }, signal()));
      expect(events).toEqual([
        { type: 'text', delta: 'It is noon.' },
        {
          type: 'done',
          stopReason: 'end_turn',
          usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
          raw: { provider: 'anthropic', content: [] },
        },
      ]);
      // Asked again straight away, and asked for a summary ever after
      await collect(provider.stream({ ...request, tools: [tool] }, signal()));
      expect(sdk.state.streamCalls.map((call) => (call[0] as { thinking: unknown }).thinking)).toEqual([
        { type: 'adaptive', display: 'updates', block_binding: KEEP_GOING },
        { type: 'adaptive', display: 'summarized', block_binding: KEEP_GOING },
        { type: 'adaptive', display: 'summarized', block_binding: KEEP_GOING },
      ]);
    });

    it('is not asked for on a brief request, whose thoughts are never shown', async () => {
      const provider = await thinker();
      await collect(provider.stream({ ...request, tools: [tool], brief: true }, signal()));
      expect(sentParams()).not.toHaveProperty('thinking');
    });

    it('is not asked for by a request that wants no reasoning', async () => {
      const provider = await thinker();
      await collect(provider.stream({ ...request, tools: [tool], think: false }, signal()));
      expect(sentParams()).not.toHaveProperty('thinking');
    });

    it('is not asked for from a model that cannot be asked to think adaptively', async () => {
      sdk.state.models = [{ id: 'claude-opus-5-5', display_name: 'Opus', capabilities: canThink(false) }];
      const provider = createAnthropicProvider({ apiKey: 'k' });
      await provider.listModels();
      sdk.state.streamCalls = [];
      await collect(provider.stream({ ...request, tools: [tool] }, signal()));
      expect(sentParams()).not.toHaveProperty('thinking');
    });

    it('is left alone once the reply has begun: a later failure is reported, not retried', async () => {
      const provider = await thinker();
      sdk.state.stream = () => ({
        async *[Symbol.asyncIterator]() {
          yield textDelta('Half an ');
          throw new sdk.BadRequestError(400, 'something else broke');
        },
        finalMessage: async () => ({
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      });
      const events = await collect(provider.stream({ ...request, tools: [tool] }, signal()));
      expect(events).toEqual([
        { type: 'text', delta: 'Half an ' },
        { type: 'error', code: 'other', message: 'something else broke' },
      ]);
      expect(sdk.state.streamCalls).toHaveLength(1);
    });
  });

  it.each([
    [
      'a rejected key',
      () => new sdk.AuthenticationError(401, 'bad key'),
      'auth',
      'Anthropic rejected the API key. Check it in Settings.',
    ],
    ['a rate limit', () => new sdk.RateLimitError(429, 'slow down'), 'rate_limit', 'slow down'],
    [
      'an empty credit balance',
      () => new sdk.APIError(400, 'Your credit balance is too low to access the Anthropic API.'),
      'spend_limit',
      'Your credit balance is too low to access the Anthropic API.',
    ],
    ['a connection failure', () => new sdk.APIConnectionError(undefined, 'offline'), 'unreachable', 'offline'],
    ['any other API error', () => new sdk.APIError(500, 'overloaded'), 'other', 'overloaded'],
  ])('reports %s as an error event', async (_name, makeError, code, message) => {
    sdk.state.stream = () => {
      throw makeError();
    };
    const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, signal()));
    expect(events).toEqual([{ type: 'error', code, message }]);
  });

  it('explains missing credentials', async () => {
    sdk.state.stream = () => {
      throw new Error('Could not resolve authentication method');
    };
    const events = await collect(createAnthropicProvider({ apiKey: '' }).stream(request, signal()));
    expect(events).toEqual([
      { type: 'error', code: 'auth', message: 'No Anthropic API key found. Add one in Settings.' },
    ]);
  });

  it('does not blame credentials when the environment provides a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    sdk.state.stream = () => {
      throw new Error('something else broke');
    };
    const events = await collect(createAnthropicProvider({ apiKey: '' }).stream(request, signal()));
    expect(events).toEqual([{ type: 'error', code: 'other', message: 'something else broke' }]);
  });

  it('ends quietly as cancelled when aborted mid-stream', async () => {
    const controller = new AbortController();
    sdk.state.stream = () => ({
      async *[Symbol.asyncIterator]() {
        yield textDelta('partial');
        controller.abort();
        throw new Error('Request was aborted.');
      },
      finalMessage: async () => ({}),
    });
    const events = await collect(createAnthropicProvider({ apiKey: 'k' }).stream(request, controller.signal));
    expect(events).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'done', stopReason: 'cancelled' },
    ]);
  });
});
