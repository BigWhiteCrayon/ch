import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOllamaProvider, toMessages } from '../../../src/llm/providers/ollama';
import type { ChatEvent, ChatRequest, Provider } from '../../../src/types';
import { collect, jsonResponse, streamResponse } from '../../helpers';

const fetchMock = vi.fn<typeof fetch>();
// What the wrapped, OpenAI-compatible provider would have answered
const viaFallback: ChatEvent[] = [
  { type: 'text', delta: 'from the fallback' },
  { type: 'done', stopReason: 'end_turn' },
];
const fallback = {
  id: 'local',
  name: 'Local',
  local: true,
  listModels: vi.fn(async () => [{ id: 'qwen', name: 'qwen', contextWindow: null, default: false }]),
  stream: vi.fn(async function* (): AsyncGenerator<ChatEvent> {
    yield* viaFallback;
  }),
} satisfies Provider;

const provider = (settings: { maxContext?: number } = {}) =>
  createOllamaProvider({
    baseURL: 'http://server:11434/v1/',
    apiKey: '',
    contextLength: 32768,
    briefContextLength: 4096,
    smallModelBytes: 4 * 1024 ** 3,
    briefKeepAlive: '30m',
    replyKeepAlive: '15m',
    fallback,
    ...settings,
  });

const request: ChatRequest = { provider: 'local', model: 'qwen', messages: [{ role: 'user', content: 'hi' }] };
const signal = () => new AbortController().signal;
const lines = (...parts: unknown[]) => parts.map((part) => `${JSON.stringify(part)}\n`).join('');
const finished = { done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5 };

// Every call as "METHOD url", and the JSON body of the calls to a path
const called = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
const bodies = (path: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => JSON.parse(init?.body as string));

// The server answers as Ollama does, each chat gets `reply()`, and the model
// can do what `capabilities` says (as /api/show reports it; `null` for a
// server that won't say, as an older Ollama doesn't)
let isOllama: boolean;
let reply: () => Response;
let capabilities: string[] | null;
// What /api/show reports as the most context the model can take, if anything
let contextLimit: number | undefined;
// What /api/tags reports: the models installed, and how big each one is
let installed: { name: string; size: number }[];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fallback.stream.mockClear();
  // Restored each time, since a test may give the wrapped provider its own list
  fallback.listModels.mockResolvedValue([{ id: 'qwen', name: 'qwen', contextWindow: null, default: false }]);
  isOllama = true;
  capabilities = ['completion', 'tools'];
  contextLimit = undefined;
  installed = [
    { name: 'qwen', size: 6 * 1024 ** 3 },
    { name: 'tiny:3b', size: 2 * 1024 ** 3 },
  ];
  reply = () => streamResponse([lines({ message: { content: 'Hello' } }, finished)]);
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/version')
      return isOllama ? jsonResponse({ version: '0.35.1' }) : new Response('not found', { status: 404 });
    if (path === '/api/ps') return jsonResponse({ models: [] });
    if (path === '/api/generate') return jsonResponse({ done: true });
    if (path === '/api/tags') return jsonResponse({ models: installed });
    if (path === '/api/show') {
      if (!capabilities) return new Response('not found', { status: 404 });
      const model_info = contextLimit
        ? { 'general.architecture': 'llama', 'llama.context_length': contextLimit }
        : undefined;
      return jsonResponse({ capabilities, model_info });
    }
    return reply();
  });
});

describe('toMessages', () => {
  it("puts tool calls and their results in Ollama's form", () => {
    expect(
      toMessages([
        { role: 'user', content: 'time?' },
        {
          role: 'assistant',
          content: 'Checking.',
          toolCalls: [
            { id: 'c1', name: 'get_time', input: { zone: 'Paris' } },
            { id: 'c2', name: 'broken', input: null },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'get_time', content: '12:00', isError: false },
      ])
    ).toEqual([
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          { function: { name: 'get_time', arguments: { zone: 'Paris' } } },
          { function: { name: 'broken', arguments: {} } },
        ],
      },
      { role: 'tool', tool_name: 'get_time', content: '12:00' },
    ]);
  });

  it("carries a user turn's pictures as the raw base64 strings, the way a tool result does", () => {
    expect(
      toMessages([
        {
          role: 'user',
          content: 'what is this?',
          images: [
            { mediaType: 'image/png', data: 'AAAA' },
            { mediaType: 'image/jpeg', data: 'BBBB' },
          ],
        },
      ])
    ).toEqual([{ role: 'user', content: 'what is this?', images: ['AAAA', 'BBBB'] }]);
  });
});

describe('an Ollama server', () => {
  // A local model costs nothing, so this is not about money: it is the
  // difference between a step that answers at once and one that works through
  // the whole conversation again first, and the window reports it beside the
  // hosted models' own cached share
  it('reports what of the prompt the server already had, as part of the prompt and not beside it', async () => {
    reply = () =>
      streamResponse([
        lines(
          { message: { content: 'Hello' } },
          { ...finished, prompt_eval_count: 1028, prompt_eval_cached_count: 1027 }
        ),
      ]);
    const events = await collect(provider().stream(request, signal()));
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { input: 1028, output: 5, cacheRead: 1027 },
    });
  });

  it('says nothing of a cache where the server worked the whole prompt through, or does not report one', async () => {
    reply = () =>
      streamResponse([lines({ message: { content: 'Hello' } }, { ...finished, prompt_eval_cached_count: 0 })]);
    expect((await collect(provider().stream(request, signal()))).at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { input: 12, output: 5 },
    });
    // An older Ollama, which does not report it at all
    reply = () => streamResponse([lines({ message: { content: 'Hello' } }, finished)]);
    expect((await collect(provider().stream(request, signal()))).at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { input: 12, output: 5 },
    });
  });

  it('is asked through its own chat API, with the wide context window', async () => {
    const events = await collect(provider().stream({ ...request, system: 'Be brief.', maxTokens: 50 }, signal()));
    expect(events).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'done', stopReason: 'end_turn', usage: { input: 12, output: 5 } },
    ]);
    expect(called()).toEqual([
      'GET http://server:11434/api/version',
      'POST http://server:11434/api/show',
      'POST http://server:11434/api/chat',
    ]);
    expect(bodies('/api/chat')).toEqual([
      {
        model: 'qwen',
        stream: true,
        options: { num_ctx: 32768, num_predict: 50 },
        keep_alive: '15m',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
        ],
      },
    ]);
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('is only asked once whether it is Ollama', async () => {
    const local = provider();
    await collect(local.stream(request, signal()));
    await collect(local.stream(request, signal()));
    expect(called().filter((call) => call.endsWith('/api/version'))).toHaveLength(1);
  });

  describe("the model's own reasoning", () => {
    const thinks = () => bodies('/api/chat').map((body) => body.think);

    it('is asked for from a model that can reason, and passed on apart from the reply', async () => {
      capabilities = ['completion', 'tools', 'thinking'];
      reply = () =>
        streamResponse([
          lines(
            { message: { content: '', thinking: 'Hmm, a ' } },
            { message: { content: '', thinking: 'greeting.' } },
            { message: { content: 'Hi!' } },
            finished
          ),
        ]);
      const events = await collect(provider().stream(request, signal()));
      expect(thinks()).toEqual([true]);
      expect(events).toEqual([
        // As written, in the fragments it arrived in; the harness gathers
        // those into thoughts (see harness/thoughts.ts)
        { type: 'reasoning', delta: 'Hmm, a ' },
        { type: 'reasoning', delta: 'greeting.' },
        { type: 'text', delta: 'Hi!' },
        { type: 'done', stopReason: 'end_turn', usage: { input: 12, output: 5 } },
      ]);
    });

    it('is not asked for from a model that cannot reason, and is never the reply if it comes anyway', async () => {
      reply = () =>
        streamResponse([
          lines({ message: { content: '', thinking: 'Hmm.' } }, { message: { content: 'Hi!' } }, finished),
        ]);
      const events = await collect(provider().stream(request, signal()));
      expect(thinks()).toEqual([undefined]);
      expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', delta: 'Hi!' }]);
    });

    it('is switched off on a brief request, which a model would otherwise reason its way through', async () => {
      capabilities = ['completion', 'thinking'];
      await collect(provider().stream({ ...request, brief: true }, signal()));
      // Said outright: a model that can reason reasons unless it is told not to
      expect(thinks()).toEqual([false]);
    });

    it('is switched off for a request that asks for none, however much room it has', async () => {
      capabilities = ['completion', 'thinking'];
      await collect(provider().stream({ ...request, think: false }, signal()));
      // Not a brief request: it is the request itself that said no
      expect(thinks()).toEqual([false]);
    });

    it('is switched on for a request that asks for it even when brief', async () => {
      capabilities = ['completion', 'thinking'];
      await collect(provider().stream({ ...request, brief: true, think: true }, signal()));
      expect(thinks()).toEqual([true]);
    });

    it('is not asked for from a server that will not say what a model can do', async () => {
      capabilities = null;
      await collect(provider().stream(request, signal()));
      expect(thinks()).toEqual([undefined]);
    });

    it('is asked about once per model', async () => {
      capabilities = ['completion', 'thinking'];
      const local = provider();
      await collect(local.stream(request, signal()));
      await collect(local.stream(request, signal()));
      await collect(local.stream({ ...request, model: 'other' }, signal()));
      await collect(local.stream({ ...request, brief: true }, signal()));
      expect(called().filter((call) => call.endsWith('/api/show'))).toHaveLength(2);
      expect(thinks()).toEqual([true, true, true, false]);
    });

    it('is asked about again for a model that could not be asked about', async () => {
      const local = provider();
      // The server is reachable, but asking what the model can do fails
      const server = fetchMock.getMockImplementation()!;
      let asking = false;
      fetchMock.mockImplementation(async (url, init) => {
        if (!asking && new URL(String(url)).pathname === '/api/show') throw new TypeError('fetch failed');
        return server(url, init);
      });
      // Nothing is known about it, so it is used as it is, without reasoning
      await collect(local.stream(request, signal()));
      expect(thinks()).toEqual([undefined]);

      asking = true;
      capabilities = ['completion', 'thinking'];
      await collect(local.stream(request, signal()));
      expect(thinks()).toEqual([undefined, true]);
    });
  });

  it('offers the tools and reports the calls the model makes, each with an id', async () => {
    reply = () =>
      streamResponse([
        lines(
          {
            message: {
              content: '',
              tool_calls: [{ id: 'call_1', function: { name: 'get_time', arguments: { zone: 'Paris' } } }],
            },
          },
          {
            message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
          },
          { message: { content: '', tool_calls: [{ function: { name: 'broken', arguments: '{not json' } }] } },
          finished
        ),
      ]);
    const tool = { name: 'get_time', description: 'Time.', inputSchema: { type: 'object' } };
    const events = await collect(provider().stream({ ...request, tools: [tool] }, signal()));

    expect(bodies('/api/chat')[0].tools).toEqual([
      { type: 'function', function: { name: 'get_time', description: 'Time.', parameters: { type: 'object' } } },
    ]);
    expect(events).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'get_time', input: { zone: 'Paris' } },
      { type: 'tool_call', id: expect.stringMatching(/.{8,}/), name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_call', id: expect.any(String), name: 'broken', input: null },
      // Ollama calls this 'stop' too; the harness needs to know tools are wanted
      { type: 'done', stopReason: 'tool_use', usage: { input: 12, output: 5 } },
    ]);
  });

  it('says when the reply was cut off at its length limit', async () => {
    reply = () =>
      streamResponse([lines({ message: { content: 'Once upon' } }, { ...finished, done_reason: 'length' })]);
    const events = await collect(provider().stream(request, signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'length' });
  });

  it('reads a reply whose lines arrive split across chunks', async () => {
    const whole = lines({ message: { content: 'Hel' } }, { message: { content: 'lo' } }, finished);
    reply = () => streamResponse([whole.slice(0, 20), whole.slice(20, 61), whole.slice(61)]);
    const events = await collect(provider().stream(request, signal()));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join('')
    ).toBe('Hello');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('reports an error status, so that a model without tools can be retried without them', async () => {
    reply = () => jsonResponse({ error: 'llama3 does not support tools' }, { status: 400 });
    await expect(collect(provider().stream(request, signal()))).resolves.toEqual([
      { type: 'error', code: 'other', status: 400, message: 'HTTP 400: {"error":"llama3 does not support tools"}' },
    ]);
  });

  it('reports an error that arrives part-way through the reply', async () => {
    reply = () =>
      streamResponse([lines({ message: { content: 'Par' } }, { error: 'model runner has unexpectedly stopped' })]);
    await expect(collect(provider().stream(request, signal()))).resolves.toEqual([
      { type: 'text', delta: 'Par' },
      { type: 'error', code: 'other', message: 'model runner has unexpectedly stopped' },
    ]);
  });

  it('ends a cancelled reply as cancelled', async () => {
    const controller = new AbortController();
    reply = () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    await expect(collect(provider().stream(request, controller.signal))).resolves.toEqual([
      { type: 'done', stopReason: 'cancelled' },
    ]);
  });

  describe('the context window a model is loaded with', () => {
    const contexts = () => bodies('/api/chat').map((body) => body.options.num_ctx);

    it('is small for a model that is only asked brief things', async () => {
      const local = provider();
      await collect(local.stream({ ...request, model: 'classifier', brief: true }, signal()));
      await collect(local.stream({ ...request, model: 'classifier', brief: true }, signal()));
      await collect(local.stream(request, signal()));
      expect(contexts()).toEqual([4096, 4096, 32768]);
    });

    it('is all the model can take', async () => {
      contextLimit = 131072;
      await collect(provider().stream(request, signal()));
      expect(contexts()).toEqual([131072]);
    });

    it('is never more than the settings allow', async () => {
      contextLimit = 131072;
      await collect(provider({ maxContext: 16384 }).stream(request, signal()));
      expect(contexts()).toEqual([16384]);
    });

    it('is the limit in the settings for a model that does not say what it can take, if that is smaller', async () => {
      await collect(provider({ maxContext: 16384 }).stream(request, signal()));
      await collect(provider({ maxContext: 65536 }).stream(request, signal()));
      expect(contexts()).toEqual([16384, 32768]);
    });

    it('is never more than the model can take', async () => {
      contextLimit = 8192;
      const local = provider();
      await collect(local.stream(request, signal()));
      expect(contexts()).toEqual([8192]);
      await local.ensureUp?.('qwen', signal());
      expect(bodies('/api/generate').map((body) => body.options.num_ctx)).toEqual([8192]);
    });

    it('leaves a brief request its own length under a limit above it', async () => {
      contextLimit = 8192;
      await collect(provider().stream({ ...request, brief: true }, signal()));
      expect(contexts()).toEqual([4096]);
    });

    it('stays wide for a model once it has had the wide one, so that it is not loaded again and again', async () => {
      const local = provider();
      await collect(local.stream({ ...request, brief: true }, signal()));
      await collect(local.stream(request, signal()));
      await collect(local.stream({ ...request, brief: true }, signal()));
      expect(contexts()).toEqual([4096, 32768, 32768]);
    });

    it('is the one the model is brought up with beforehand', async () => {
      const local = provider();
      await local.ensureUp?.('classifier', signal(), { ...request, model: 'classifier', brief: true });
      await local.ensureUp?.('qwen', signal(), request);
      await local.ensureUp?.('other', signal());
      expect(bodies('/api/generate')).toEqual([
        // The brief one is held for longer; the other two only ever answer
        { model: 'classifier', stream: false, options: { num_ctx: 4096 }, keep_alive: '30m' },
        { model: 'qwen', stream: false, options: { num_ctx: 32768 }, keep_alive: '15m' },
        { model: 'other', stream: false, options: { num_ctx: 32768 }, keep_alive: '15m' },
      ]);
    });
  });
});

// The small model that classifies is asked for once per message and was being
// loaded again almost every time, each load costing more than the last as the
// machine filled up. Ollama is asked to hold on to it instead.
describe('keeping the small model in memory', () => {
  const ready = async () => {
    const local = provider();
    await local.listModels();
    return local;
  };
  const brief = (model: string) => ({ ...request, model, brief: true });
  const keepAlives = (path: string) => bodies(path).map((body) => body.keep_alive);

  it('asks for it on the load and on the chat, since each request sets the clock afresh', async () => {
    const local = await ready();
    await local.ensureUp?.('tiny:3b', signal(), brief('tiny:3b'));
    await collect(local.stream(brief('tiny:3b'), signal()));
    expect(keepAlives('/api/generate')).toEqual(['30m']);
    expect(keepAlives('/api/chat')).toEqual(['30m']);
  });

  // The model that answers is kept too, for less: losing it costs the work it
  // has done on the prompt as well as the load
  it('keeps the model that answers for less than the small one', async () => {
    const local = await ready();
    await local.ensureUp?.('qwen', signal(), request);
    await collect(local.stream(request, signal()));
    expect(keepAlives('/api/generate')).toEqual(['15m']);
    expect(keepAlives('/api/chat')).toEqual(['15m']);
  });

  // The classifier's size floor means the model it asks may be a large one,
  // which is the model the five-minute default punishes hardest
  it('keeps a model too big to skip the queue, the request still being a brief one', async () => {
    const local = await ready();
    await collect(local.stream(brief('qwen'), signal()));
    await collect(local.stream(brief('never-heard-of-it'), signal()));
    expect(keepAlives('/api/chat')).toEqual(['30m', '30m']);
    // ...which is not the same as letting it load beside the answer
    expect(local.concurrent?.(brief('qwen'))).toBe(false);
  });

  // Ollama takes each request's keep_alive as the new one, and a reply follows
  // the classification of the message it answers, so reading the length off
  // each request would undo the pin on every message
  it('holds a model that both classifies and answers for the longer time', async () => {
    const local = await ready();
    await collect(local.stream(brief('qwen'), signal()));
    await collect(local.stream(request, signal()));
    expect(keepAlives('/api/chat')).toEqual(['30m', '30m']);
  });

  it('holds a model that has only ever answered for the shorter time', async () => {
    const local = await ready();
    await collect(local.stream(request, signal()));
    await collect(local.stream({ ...request, model: 'tiny:3b' }, signal()));
    expect(keepAlives('/api/chat')).toEqual(['15m', '15m']);
  });

  // Unlike skipping the queue, this does not care whether the model is busy:
  // a second brief request to it should renew the pin, not drop it
  it('pins it even while it is already serving something', async () => {
    const local = await ready();
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(true);
    await collect(local.stream(brief('tiny:3b'), signal()));
    await collect(local.stream(brief('tiny:3b'), signal()));
    expect(keepAlives('/api/chat')).toEqual(['30m', '30m']);
  });
});

describe('skipping the queue', () => {
  // The sizes are learned when the models are listed
  const ready = async () => {
    const local = provider();
    await local.listModels();
    return local;
  };
  const brief = (model: string) => ({ ...request, model, brief: true });

  it('lets a brief request to a small model be served alongside the one answering', async () => {
    const local = await ready();
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(true);
  });

  it('makes a big model wait, however brief the request: loading it would push the answer out', async () => {
    const local = await ready();
    expect(local.concurrent?.(brief('qwen'))).toBe(false);
  });

  it('makes a reply wait however small the model, since a reply gets the full context window', async () => {
    const local = await ready();
    expect(local.concurrent?.({ ...request, model: 'tiny:3b' })).toBe(false);
  });

  it('makes a model of unknown size wait, which is the safe way round', async () => {
    const local = await ready();
    expect(local.concurrent?.(brief('never-heard-of-it'))).toBe(false);
    // Nothing is known at all until the models have been listed
    expect(provider().concurrent?.(brief('tiny:3b'))).toBe(false);
  });

  it('counts a model listed only as ":latest" as the same model', async () => {
    installed = [{ name: 'tiny:latest', size: 2 * 1024 ** 3 }];
    const local = await ready();
    expect(local.concurrent?.(brief('tiny'))).toBe(true);
  });

  // The wait this avoids is not the answer's: a brief request that cannot skip
  // the queue joins the provider's one, behind whatever long reply is running
  it('lets a brief request join another brief one on the same model, both being short of context', async () => {
    const local = await ready();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    reply = () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(lines({ message: { content: 'rating ' } })));
            await held;
            controller.enqueue(encoder.encode(lines(finished)));
            controller.close();
          },
        })
      );
    };

    const classifying = collect(local.stream(brief('tiny:3b'), signal()));
    await vi.waitFor(() => expect(bodies('/api/chat')).toHaveLength(1));
    // Another thread classifying at the same time: the same model, the same
    // context length, so there is nothing for it to wait for
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(true);
    // A reply on that model still waits: it would load it again, wider
    expect(local.concurrent?.({ ...request, model: 'tiny:3b' })).toBe(false);

    release();
    await classifying;
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(true);
  });

  it('makes a request wait for the very model that is answering, which it would reload', async () => {
    const local = await ready();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    reply = () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(lines({ message: { content: 'Half an ' } })));
            await held;
            controller.enqueue(encoder.encode(lines(finished)));
            controller.close();
          },
        })
      );
    };

    const answering = collect(local.stream({ ...request, model: 'tiny:3b' }, signal()));
    await vi.waitFor(() => expect(bodies('/api/chat')).toHaveLength(1));
    // That model is busy, and asking it anything else would change the
    // context length it is loaded with
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(false);

    release();
    await answering;
    // Free again once it has finished
    expect(local.concurrent?.(brief('tiny:3b'))).toBe(true);
  });
});

describe('a model that cannot answer messages', () => {
  // What Ollama says of each model, by name
  const able = (by: Record<string, string[]>) => {
    fetchMock.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/version') return jsonResponse({ version: '0.35.1' });
      if (path === '/api/tags') return jsonResponse({ models: installed });
      if (path === '/api/ps') return jsonResponse({ models: [] });
      if (path === '/api/generate') return jsonResponse({ done: true });
      if (path === '/api/show') {
        const { model } = JSON.parse(init?.body as string);
        return jsonResponse({ capabilities: by[model] ?? [] });
      }
      return reply();
    });
  };

  it('is left out of the models offered, so nothing routes a message to it', async () => {
    fallback.listModels.mockResolvedValue([
      { id: 'qwen', name: 'qwen', contextWindow: null, default: false },
      { id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest', contextWindow: null, default: false },
    ]);
    able({ qwen: ['completion', 'tools'], 'nomic-embed-text:latest': ['embedding'] });
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen']);
  });

  it('is turned away outright when something asks it anyway', async () => {
    able({ qwen: ['embedding'] });
    const events = await collect(provider().stream(request, signal()));
    expect(events).toEqual([
      { type: 'error', code: 'other', message: expect.stringContaining('cannot answer messages') },
    ]);
    // Nothing was asked of it
    expect(bodies('/api/chat')).toEqual([]);
  });

  it('is kept when the server says nothing about what its models can do', async () => {
    // An older Ollama reports no capabilities for anything, and all of its
    // models are chat models as far as anyone can tell
    fallback.listModels.mockResolvedValue([
      { id: 'qwen', name: 'qwen', contextWindow: null, default: false },
      { id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest', contextWindow: null, default: false },
    ]);
    able({});
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen', 'nomic-embed-text:latest']);
    await expect(collect(provider().stream(request, signal()))).resolves.toContainEqual(
      expect.objectContaining({ type: 'done' })
    );
  });
});

describe('a local server that is not Ollama', () => {
  it('is asked the OpenAI-compatible way instead', async () => {
    isOllama = false;
    const controller = new AbortController();
    await expect(collect(provider().stream(request, controller.signal))).resolves.toEqual(viaFallback);
    expect(fallback.stream).toHaveBeenCalledWith(request, controller.signal);
    expect(called()).toEqual(['GET http://server:11434/api/version']);
  });

  it('is asked again whether it is Ollama after it could not be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const local = provider();
    await expect(collect(local.stream(request, signal()))).resolves.toEqual(viaFallback);
    await collect(local.stream(request, signal()));
    expect(bodies('/api/chat')).toHaveLength(1);
  });
});

describe('a chat that does not come back', () => {
  // Every fetch rejection is a TypeError reading "fetch failed", so the two
  // look alike to the caller and want opposite things done about them: a
  // server that isn't there is worth asking again in a moment, and one that
  // took the request and went quiet is still holding it (see failure in
  // ../../../src/llm/transport.ts)
  const rejectWith = (code: string) => {
    reply = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    };
  };
  const errorFrom = async () => {
    const [event] = await collect(provider().stream(request, signal()));
    return event as { type: string; code: string; message: string };
  };

  it('says a server that went quiet is running, rather than that it was not reached', async () => {
    rejectWith('UND_ERR_HEADERS_TIMEOUT');
    const event = await errorFrom();
    expect(event).toMatchObject({ type: 'error', code: 'stalled' });
    expect(event.message).toContain('http://server:11434/v1/');
    expect(event.message).not.toContain('No server reachable');
  });

  it('says a refused connection was a server that was not reached', async () => {
    rejectWith('ECONNREFUSED');
    expect(await errorFrom()).toEqual({
      type: 'error',
      code: 'unreachable',
      message: 'No server reachable at http://server:11434/v1/',
    });
  });
});

describe('everything but chatting', () => {
  it('is left to the provider it wraps', async () => {
    const local = provider();
    expect(local).toMatchObject({ id: 'local', name: 'Local', local: true });
    // The models are the wrapped provider's, with the window Ollama will load
    // them with and whether each one can reason
    await expect(local.listModels()).resolves.toEqual([
      { id: 'qwen', name: 'qwen', contextWindow: 32768, default: false, reasons: false, vision: false },
    ]);
    capabilities = ['completion', 'thinking', 'vision'];
    await expect(provider().listModels()).resolves.toEqual([
      { id: 'qwen', name: 'qwen', contextWindow: 32768, default: false, reasons: true, vision: true },
    ]);
    // ...which is all each model can take, unless the settings say less
    contextLimit = 8192;
    await expect(provider().listModels()).resolves.toMatchObject([{ contextWindow: 8192 }]);
    contextLimit = 131072;
    await expect(provider().listModels()).resolves.toMatchObject([{ contextWindow: 131072 }]);
    await expect(provider({ maxContext: 16384 }).listModels()).resolves.toMatchObject([{ contextWindow: 16384 }]);
    contextLimit = undefined;

    isOllama = false;
    await expect(provider().listModels()).resolves.toEqual([
      { id: 'qwen', name: 'qwen', contextWindow: null, default: false },
    ]);
  });
});
