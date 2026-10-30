import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider, toMessages } from '../../../src/llm/providers/openai-compatible';
import type { ChatRequest } from '../../../src/types';
import { collect, jsonResponse, streamResponse } from '../../helpers';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

const provider = (overrides = {}) =>
  createOpenAICompatibleProvider({
    id: 'local',
    name: 'Local',
    baseURL: 'http://server/v1/',
    apiKey: '',
    local: true,
    ...overrides,
  });

const request: ChatRequest = {
  provider: 'local',
  model: 'llama',
  messages: [{ role: 'user', content: 'hi' }],
};

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1]?.body as string);

describe('toMessages', () => {
  it('passes plain messages through', () => {
    expect(
      toMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ])
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('converts tool calls and their results', () => {
    const converted = toMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'get_time', input: { zone: 'Paris' } },
          { id: 'c2', name: 'broken', input: null },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'get_time', content: '12:00', isError: false },
    ]);
    expect(converted).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{"zone":"Paris"}' } },
          { id: 'c2', type: 'function', function: { name: 'broken', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '12:00' },
    ]);
  });
});

describe('listModels', () => {
  it('lists the models the server reports', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    await expect(provider().listModels()).resolves.toEqual([
      { id: 'a', name: 'a', contextWindow: null, default: false },
      { id: 'b', name: 'b', contextWindow: null, default: false },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://server/v1/models');
  });

  it('leaves out the models that are not for text, which it can only tell by name', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'qwen2.5-coder:7b' },
          { id: 'nomic-embed-text:latest' },
          { id: 'text-embedding-3-large' },
          { id: 'mxbai-embed-large' },
          { id: 'bge-reranker-v2-m3' },
        ],
      })
    );
    // This API says nothing about what a model can do, so the name is all
    // there is to go on (an Ollama server is asked outright instead)
    await expect(provider().listModels()).resolves.toEqual([
      { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', contextWindow: null, default: false },
    ]);
  });

  it('turns one away outright when something asks it to hold a conversation', async () => {
    const events = await collect(
      provider().stream({ ...request, model: 'nomic-embed-text:latest' }, new AbortController().signal)
    );
    expect(events).toEqual([{ type: 'error', code: 'other', message: expect.stringContaining('is not a text model') }]);
    // Nothing was asked of the server
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats "data": null as no models, as Ollama sends when it has none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ object: 'list', data: null }));
    await expect(provider().listModels()).resolves.toEqual([]);
  });

  it('applies the model filter', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'chat' }, { id: 'embedding' }] }));
    const models = await provider({ modelFilter: (id: string) => id !== 'embedding' }).listModels();
    expect(models.map((m) => m.id)).toEqual(['chat']);
  });

  it('sends the API key as a bearer token when there is one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await provider({ apiKey: 'secret' }).listModels();
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('fails without calling the server when a required key is missing', async () => {
    const openai = provider({ name: 'OpenAI', requiresKey: true });
    await expect(openai.listModels()).rejects.toThrow('No OpenAI API key found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable server', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(provider().listModels()).rejects.toThrow('No server reachable at http://server/v1/');
  });

  it('reports an HTTP error', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(provider().listModels()).rejects.toThrow('HTTP 500');
  });
});

describe('status', () => {
  it('is ready when the server answers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await expect(provider().status?.()).resolves.toBe('ready');
  });

  it('is unreachable when the server errors or cannot be reached', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(provider().status?.()).resolves.toBe('unreachable');
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(provider().status?.()).resolves.toBe('unreachable');
  });
});

describe('stream', () => {
  const run = (req: ChatRequest = request, signal = new AbortController().signal) =>
    collect(provider().stream(req, signal));

  it('streams text and finishes with usage', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse(
          { choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }
        ),
      ])
    );
    await expect(run()).resolves.toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      // The counts are passed on as they arrive as well as with the ending:
      // most servers send them once, after the reply, but the few that count
      // as they go have the window show it (see TokensEvent)
      { type: 'tokens', usage: { input: 5, output: 2 } },
      { type: 'done', stopReason: 'end_turn', usage: { input: 5, output: 2 } },
    ]);
  });

  // This API caches of its own accord and says what it reused, so the counts
  // come back whether or not anything was asked for
  it('passes on what the prompt read back from the cache and what it wrote into it', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse(
          { choices: [{ delta: { content: 'Hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 5000,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 600, text_tokens: 5000 },
            },
          }
        ),
      ])
    );
    const events = await run();
    // The cached tokens are part of the input rather than beside it
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { input: 5000, output: 2, cacheRead: 4000, cacheWrite: 600 },
    });
  });

  it('says nothing of a cache where the server does not, rather than reporting nothing cached', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse(
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          // A local server, and a prompt too short to cache, both look like this
          {
            choices: [],
            usage: { prompt_tokens: 120, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
          }
        ),
      ])
    );
    const events = await run();
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { input: 120, output: 3 },
    });
  });

  it("tells somebody else's server where to look for the prefix, and a local one nothing", async () => {
    fetchMock.mockResolvedValue(streamResponse([sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })]));
    await collect(
      provider({ local: false }).stream({ ...request, cacheKey: 'thread-1' }, new AbortController().signal)
    );
    expect(sentBody().prompt_cache_key).toBe('thread-1');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(streamResponse([sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })]));
    await collect(provider().stream({ ...request, cacheKey: 'thread-1' }, new AbortController().signal));
    expect(sentBody().prompt_cache_key).toBeUndefined();
  });

  it('reassembles events split across network chunks', async () => {
    const whole = sse({ choices: [{ delta: { content: 'Hello' } }] });
    const cut = 17;
    fetchMock.mockResolvedValue(streamResponse([whole.slice(0, cut), whole.slice(cut)]));
    const events = await run();
    expect(events[0]).toEqual({ type: 'text', delta: 'Hello' });
  });

  it('sends the system prompt first, and tools only when there are some', async () => {
    fetchMock.mockImplementation(async () => streamResponse([sse()]));
    await run({ ...request, system: 'Be brief.', maxTokens: 50 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://server/v1/chat/completions');
    expect(sentBody()).toMatchObject({
      model: 'llama',
      stream: true,
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(sentBody()).not.toHaveProperty('tools');

    fetchMock.mockClear();
    const tool = { name: 'get_time', description: 'Time.', inputSchema: { type: 'object' } };
    await run({ ...request, tools: [tool] });
    expect(sentBody().tools).toEqual([
      { type: 'function', function: { name: 'get_time', description: 'Time.', parameters: { type: 'object' } } },
    ]);
    expect(sentBody()).not.toHaveProperty('max_tokens');
  });

  it('assembles tool calls that arrive in fragments, including parallel ones', async () => {
    const part = (tool_calls: unknown[]) => ({ choices: [{ delta: { tool_calls } }] });
    fetchMock.mockResolvedValue(
      streamResponse([
        sse(
          part([{ index: 0, id: 'c1', function: { name: 'get_time', arguments: '' } }]),
          part([{ index: 0, function: { arguments: '{"zone":' } }]),
          part([
            { index: 0, function: { arguments: '"Tokyo"}' } },
            { index: 1, id: 'c2', function: { name: 'noop', arguments: '' } },
          ]),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ),
      ])
    );
    await expect(run()).resolves.toEqual([
      { type: 'tool_call', id: 'c1', name: 'get_time', input: { zone: 'Tokyo' } },
      { type: 'tool_call', id: 'c2', name: 'noop', input: {} },
      { type: 'done', stopReason: 'tool_use', usage: undefined },
    ]);
  });

  it('reports tool input that is not valid JSON as null', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        sse({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: '{"a":' } }] } }],
        }),
      ])
    );
    const events = await run();
    expect(events[0]).toEqual({ type: 'tool_call', id: 'c1', name: 't', input: null });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'other'],
    [500, 'other'],
  ])('maps HTTP %i to the "%s" error code and keeps the status', async (status, code) => {
    fetchMock.mockResolvedValue(new Response('model does not support tools', { status }));
    await expect(run()).resolves.toEqual([
      { type: 'error', code, status, message: `HTTP ${status}: model does not support tools` },
    ]);
  });

  it.each([
    ['insufficient_quota', '{"error":{"code":"insufficient_quota","message":"Check your plan"}}'],
    ['exceeded your current quota', 'You exceeded your current quota, please check your plan.'],
  ])('maps a 429 whose body says "%s" to the "spend_limit" error code', async (_name, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 429 }));
    await expect(run()).resolves.toEqual([
      { type: 'error', code: 'spend_limit', status: 429, message: `HTTP 429: ${body}` },
    ]);
  });

  it('reports an unreachable server', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(run()).resolves.toEqual([
      { type: 'error', code: 'unreachable', message: 'No server reachable at http://server/v1/' },
    ]);
  });

  it('ends quietly as cancelled when the request is aborted', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(run(request, controller.signal)).resolves.toEqual([{ type: 'done', stopReason: 'cancelled' }]);
  });

  it('reports a malformed stream as an error instead of throwing', async () => {
    fetchMock.mockResolvedValue(streamResponse(['data: {not json}\n\n']));
    const events = await run();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'other' });
  });

  it('fails without calling the server when a required key is missing', async () => {
    const openai = provider({ name: 'OpenAI', requiresKey: true });
    const events = await collect(openai.stream(request, new AbortController().signal));
    expect(events).toEqual([{ type: 'error', code: 'auth', message: 'No OpenAI API key found. Add one in Settings.' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
