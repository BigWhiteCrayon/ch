import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUGGESTED, ensureLoaded, pull, status } from '../../src/llm/ollama';
import { jsonResponse, streamResponse } from '../helpers';

const fetchMock = vi.fn<typeof fetch>();
const config = { baseURL: 'http://localhost:11434/v1', apiKey: '' };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

const lines = (...updates: unknown[]) => updates.map((u) => JSON.stringify(u) + '\n').join('');

describe('status', () => {
  it('lists installed models and suggests the ones that are missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: 'mistral:7b', size: 4_100_000_000, digest: 'abc' }] }));
    const result = await status(config);
    expect(result).toEqual({
      reachable: true,
      url: 'http://localhost:11434',
      installed: [{ name: 'mistral:7b', size: 4_100_000_000 }],
      suggested: SUGGESTED.filter((m) => m.name !== 'mistral:7b').map((m) => ({
        ...m,
        sophistication: expect.any(Number),
      })),
    });
  });

  it('gives every suggestion a recommended memory and the level it would get', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    const { suggested } = await status(config);
    expect(suggested).toHaveLength(SUGGESTED.length);
    for (const model of suggested) {
      expect([4, 8, 16, 32]).toContain(model.memoryGB);
    }
    const levels = Object.fromEntries(suggested.map((m) => [m.name, m.sophistication]));
    expect(levels).toMatchObject({ 'llama3.2:3b': 0, 'mistral:7b': 1, 'qwen2.5:32b': 2 });
    // Bigger models want more memory
    const memory = Object.fromEntries(suggested.map((m) => [m.name, m.memoryGB]));
    expect(memory['llama3.2:3b']).toBeLessThan(memory['qwen2.5:14b']);
    expect(memory['qwen2.5:14b']).toBeLessThan(memory['qwen2.5:32b']);
  });

  it("asks Ollama's native API at the server root, not under /v1", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    await status({ baseURL: 'http://host:1234/v1/', apiKey: '' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://host:1234/api/tags');
  });

  it('copes with a missing or null model list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: null }));
    await expect(status(config)).resolves.toMatchObject({ reachable: true, installed: [], suggested: SUGGESTED });
    expect(SUGGESTED.length).toBeGreaterThan(0);
  });

  it('sends the API key when there is one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    await status({ ...config, apiKey: 'secret' });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('is unreachable when the server cannot be contacted', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(status(config)).resolves.toEqual({
      reachable: false,
      url: 'http://localhost:11434',
      installed: [],
      suggested: [],
    });
  });

  it('is unreachable when the server is not Ollama', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(status(config)).resolves.toMatchObject({ reachable: false });
  });
});

describe('ensureLoaded', () => {
  const signal = () => new AbortController().signal;
  const called = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

  it('does nothing when the model is already loaded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: 'llama3.2:3b' }] }));
    await ensureLoaded(config, 'llama3.2:3b', signal());
    expect(called()).toEqual(['GET http://localhost:11434/api/ps']);
  });

  it('knows a model listed with the default tag', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: 'mistral:latest' }] }));
    await ensureLoaded(config, 'mistral', signal());
    expect(called()).toHaveLength(1);
  });

  it('loads a model that is not loaded, and waits for it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen2.5:14b' }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true, done_reason: 'load' }));
    await ensureLoaded({ ...config, apiKey: 'secret' }, 'llama3.2:3b', signal());
    expect(called()).toEqual(['GET http://localhost:11434/api/ps', 'POST http://localhost:11434/api/generate']);
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'llama3.2:3b',
      stream: false,
      options: { num_ctx: 32768 },
    });
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('loads a model again for another context length, and not when it has the right one', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'llama3.2:3b', context_length: 4096 }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true }));
    await ensureLoaded(config, 'llama3.2:3b', signal(), 32768);
    expect(called()).toEqual(['GET http://localhost:11434/api/ps', 'POST http://localhost:11434/api/generate']);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).options).toEqual({ num_ctx: 32768 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'llama3.2:3b', context_length: 4096 }] }));
    await ensureLoaded(config, 'llama3.2:3b', signal(), 4096);
    expect(called()).toEqual(['GET http://localhost:11434/api/ps']);
  });

  it('asks Ollama to keep the model when it is told how long for', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ done: true, done_reason: 'load' }));
    await ensureLoaded(config, 'llama3.2:3b', signal(), 4096, '30m');
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      model: 'llama3.2:3b',
      stream: false,
      options: { num_ctx: 4096 },
      keep_alive: '30m',
    });
  });

  it('copes with nothing being loaded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: null })).mockResolvedValueOnce(jsonResponse({}));
    await ensureLoaded(config, 'llama3.2:3b', signal());
    expect(called()).toHaveLength(2);
  });

  it('reports why Ollama could not load the model', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(new Response('{"error":"model requires more system memory"}', { status: 500 }));
    await expect(ensureLoaded(config, 'qwen2.5:32b', signal())).rejects.toThrow(/^model requires more system memory$/);
  });

  it.each([
    ['is not Ollama', () => fetchMock.mockResolvedValue(new Response('not found', { status: 404 }))],
    ['cannot be reached', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
  ])('carries on without loading anything when the server %s', async (_name, arrange) => {
    arrange();
    await expect(ensureLoaded(config, 'llama3.2:3b', signal())).resolves.toBeUndefined();
    expect(called()).toEqual(['GET http://localhost:11434/api/ps']);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(ensureLoaded(config, 'llama3.2:3b', controller.signal)).rejects.toThrow('aborted');
  });
});

describe('pull', () => {
  const signal = () => new AbortController().signal;

  it('requests the model and reports progress as a percentage', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        lines(
          { status: 'pulling manifest' },
          { status: 'pulling abc', total: 200, completed: 50 },
          { status: 'pulling abc', total: 200, completed: 200 },
          { status: 'success' }
        ),
      ])
    );
    const progress = vi.fn();
    await pull(config, 'llama3.2:3b', progress, signal());

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/pull');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      model: 'llama3.2:3b',
      name: 'llama3.2:3b',
      stream: true,
    });
    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      { status: 'pulling manifest', percent: null },
      { status: 'pulling abc', percent: 25 },
      { status: 'pulling abc', percent: 100 },
      { status: 'success', percent: null },
    ]);
  });

  it('only reports when the visible progress changes', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        lines(
          { status: 'pulling abc', total: 1000, completed: 100 },
          { status: 'pulling abc', total: 1000, completed: 101 },
          { status: 'pulling abc', total: 1000, completed: 104 },
          { status: 'pulling abc', total: 1000, completed: 110 }
        ),
      ])
    );
    const progress = vi.fn();
    await pull(config, 'm', progress, signal());
    expect(progress.mock.calls.map(([update]) => update.percent)).toEqual([10, 11]);
  });

  it('handles updates split across network chunks', async () => {
    const whole = lines({ status: 'pulling abc', total: 10, completed: 5 }, { status: 'success' });
    fetchMock.mockResolvedValue(streamResponse([whole.slice(0, 20), whole.slice(20)]));
    const progress = vi.fn();
    await pull(config, 'm', progress, signal());
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('treats a missing "completed" as zero', async () => {
    fetchMock.mockResolvedValue(streamResponse([lines({ status: 'pulling abc', total: 10 })]));
    const progress = vi.fn();
    await pull(config, 'm', progress, signal());
    expect(progress).toHaveBeenCalledWith({ status: 'pulling abc', percent: 0 });
  });

  it('throws the error Ollama reports mid-stream', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([lines({ status: 'pulling manifest' }, { error: 'file does not exist' })])
    );
    await expect(pull(config, 'bogus', vi.fn(), signal())).rejects.toThrow('file does not exist');
  });

  it('throws on an HTTP error, using the response text', async () => {
    fetchMock.mockResolvedValue(new Response('invalid model name', { status: 400 }));
    await expect(pull(config, '!!', vi.fn(), signal())).rejects.toThrow('invalid model name');
  });

  it('passes the abort signal to the request', async () => {
    fetchMock.mockResolvedValue(streamResponse([lines({ status: 'success' })]));
    const abort = signal();
    await pull(config, 'm', vi.fn(), abort);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(abort);
  });
});
