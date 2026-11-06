import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest, Provider, ProviderModel, Settings } from '../../src/types';
import { collect } from '../helpers';

// The real providers make network calls; replace them with recorders.
const made = vi.hoisted(() => ({
  anthropic: [] as unknown[],
  compatible: [] as Record<string, any>[],
  ollama: [] as Record<string, any>[],
  providers: new Map<string, any>(),
}));

function fakeProvider(id: string, name: string, local: boolean): Provider & Record<string, any> {
  return {
    id,
    name,
    local,
    models: [] as ProviderModel[],
    listError: null as Error | null,
    listCalls: 0,
    async listModels() {
      this.listCalls++;
      if (this.listError) throw this.listError;
      return this.models;
    },
    async *stream(): AsyncGenerator<ChatEvent> {
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

vi.mock('../../src/llm/providers/anthropic', () => ({
  createAnthropicProvider: (options: unknown) => {
    made.anthropic.push(options);
    const provider = fakeProvider('anthropic', 'Anthropic', false);
    made.providers.set('anthropic', provider);
    return provider;
  },
}));

vi.mock('../../src/llm/providers/openai-compatible', () => ({
  createOpenAICompatibleProvider: (options: Record<string, any>) => {
    made.compatible.push(options);
    const provider = fakeProvider(options.id, options.name, options.local);
    made.providers.set(options.id, provider);
    return provider;
  },
}));

// The Ollama provider wraps the local one; here it is just the one it wraps
vi.mock('../../src/llm/providers/ollama', () => ({
  createOllamaProvider: (options: Record<string, any>) => {
    made.ollama.push(options);
    return options.fallback;
  },
}));

import * as llm from '../../src/llm';
import * as cachelock from '../../src/llm/cachelock';
import { HOLD_MS } from '../../src/llm/cachelock';
import * as log from '../../src/log';

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  anthropic: { apiKey: 'ant-key', disabledModels: [] },
  openai: { apiKey: 'oai-key', disabledModels: [] },
  local: { baseURL: 'http://localhost:11434/v1', apiKey: '' },
  sophistication: {},
  sandbox: { image: '' },
  offline: false,
  ...overrides,
});

const m = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  name: id,
  contextWindow: null,
  default: false,
  ...extra,
});

const provider = (id: string) => made.providers.get(id);
const signal = () => new AbortController().signal;
// What a provider that reports no counts of its own has reckoned up for it as
// it writes, so that the window has something climbing (see TokensEvent, and
// 'the count while a reply is still being written' below). Every fake provider
// here is one of those, so it falls between the reply and the ending.
const reckoned = {
  type: 'tokens',
  estimated: true,
  usage: { input: expect.any(Number), output: expect.any(Number) },
};
const request = (providerId: string, model = 'm'): ChatRequest => ({
  provider: providerId,
  model,
  messages: [{ role: 'user', content: 'hi' }],
});

beforeEach(() => {
  made.anthropic = [];
  made.compatible = [];
  made.ollama = [];
  made.providers.clear();
  llm.configure(settings());
});

describe('configure', () => {
  it('builds the three providers from the settings', () => {
    expect(made.anthropic).toEqual([{ apiKey: 'ant-key' }]);
    expect(made.compatible).toMatchObject([
      { id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'oai-key', local: false, requiresKey: true },
      { id: 'local', baseURL: 'http://localhost:11434/v1', apiKey: '', local: true },
    ]);
  });

  it('speaks to the local server as Ollama, with a wide context window', () => {
    expect(made.ollama).toMatchObject([
      {
        baseURL: 'http://localhost:11434/v1',
        apiKey: '',
        contextLength: 32768,
        briefContextLength: 4096,
        smallModelBytes: 4 * 1024 ** 3,
      },
    ]);
    expect(made.ollama[0].fallback).toBe(provider('local'));
  });

  it('hides OpenAI models that are not chat models', () => {
    const { modelFilter } = made.compatible[0];
    expect(['gpt-x', 'gpt-x-mini', 'o9'].every(modelFilter)).toBe(true);
    expect(
      ['text-embedding-3-large', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-x-realtime', 'omni-moderation'].some(
        modelFilter
      )
    ).toBe(false);
  });
});

describe('listModels', () => {
  it('combines every provider, most sophisticated first, with provider details', async () => {
    provider('anthropic').models = [m('claude-haiku-4-5'), m('claude-opus-5-5', { default: true })];
    provider('local').models = [m('qwen:32b'), m('llama:3b')];

    const { models, providers } = await llm.listModels();
    expect(models.map((x) => `${x.provider}/${x.id}:${x.sophistication}`)).toEqual([
      'anthropic/claude-opus-5-5:4',
      'anthropic/claude-haiku-4-5:2',
      'local/qwen:32b:2',
      'local/llama:3b:0',
    ]);
    expect(models[0]).toMatchObject({ providerName: 'Anthropic', local: false, default: true, disabled: false });
    expect(models[2]).toMatchObject({ providerName: 'Local', local: true });
    expect(providers).toEqual([
      { id: 'anthropic', name: 'Anthropic', ok: true },
      { id: 'openai', name: 'OpenAI', ok: true },
      { id: 'local', name: 'Local', ok: true },
    ]);
  });

  it('reports a failing provider without losing the others', async () => {
    provider('anthropic').listError = new Error('No Anthropic API key found.');
    provider('local').models = [m('llama:3b')];

    const { models, providers } = await llm.listModels();
    expect(models.map((x) => x.id)).toEqual(['llama:3b']);
    expect(providers[0]).toEqual({
      id: 'anthropic',
      name: 'Anthropic',
      ok: false,
      error: 'No Anthropic API key found.',
    });
  });

  it('leaves out models the user switched off, unless asked to include them', async () => {
    llm.configure(settings({ anthropic: { apiKey: 'k', disabledModels: ['claude-haiku-4-5'] } }));
    provider('anthropic').models = [m('claude-haiku-4-5'), m('claude-opus-5-5')];

    expect((await llm.listModels()).models.map((x) => x.id)).toEqual(['claude-opus-5-5']);
    const all = (await llm.listModels({ includeDisabled: true })).models;
    expect(all.map((x) => [x.id, x.disabled])).toEqual([
      ['claude-opus-5-5', false],
      ['claude-haiku-4-5', true],
    ]);
  });

  it('applies manual sophistication levels from the settings', async () => {
    llm.configure(settings({ sophistication: { 'local/llama:3b': 5 } }));
    provider('local').models = [m('llama:3b')];
    expect((await llm.listModels()).models[0].sophistication).toBe(5);
  });

  it('caches each provider list for a minute, unless a fresh list is asked for', async () => {
    vi.useFakeTimers();
    try {
      await llm.listModels();
      await llm.listModels();
      expect(provider('local').listCalls).toBe(1);

      await llm.listModels({ fresh: true });
      expect(provider('local').listCalls).toBe(2);

      vi.advanceTimersByTime(61_000);
      await llm.listModels();
      expect(provider('local').listCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a failure', async () => {
    provider('local').listError = new Error('down');
    await llm.listModels();
    provider('local').listError = null;
    provider('local').models = [m('llama:3b')];
    expect((await llm.listModels()).models).toHaveLength(1);
  });

  it('forgets cached lists when reconfigured', async () => {
    await llm.listModels();
    llm.configure(settings());
    provider('local').models = [m('new:1b')];
    expect((await llm.listModels()).models.map((x) => x.id)).toEqual(['new:1b']);
  });
});

describe('register', () => {
  it('adds a provider that is then listed and streamed from', async () => {
    const extra = fakeProvider('extra', 'Extra', false);
    extra.models = [m('x')];
    llm.register(extra);
    expect((await llm.listModels()).models.map((x) => x.provider)).toContain('extra');
    await expect(collect(llm.stream(request('extra'), signal()))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });
});

describe('offline', () => {
  const OFFLINE = 'Offline is switched on, so models on other computers are not used.';

  beforeEach(() => {
    provider('anthropic').models = [m('claude-opus-5-5')];
    provider('openai').models = [m('gpt-x')];
    provider('local').models = [m('qwen:32b'), m('llama:3b')];
    llm.configure(settings({ offline: true }));
    // configure builds the providers again, so the models are set on the new ones
    provider('anthropic').models = [m('claude-opus-5-5')];
    provider('openai').models = [m('gpt-x')];
    provider('local').models = [m('qwen:32b'), m('llama:3b')];
  });

  it('offers only the models on this computer, and says why the others are gone', async () => {
    const { models, providers } = await llm.listModels();
    expect(models.map((x) => `${x.provider}/${x.id}`)).toEqual(['local/qwen:32b', 'local/llama:3b']);
    expect(providers).toEqual([
      { id: 'anthropic', name: 'Anthropic', ok: false, error: OFFLINE },
      { id: 'openai', name: 'OpenAI', ok: false, error: OFFLINE },
      { id: 'local', name: 'Local', ok: true },
    ]);
  });

  it('does not so much as ask a hosted provider what it has: asking is a request to it', async () => {
    await llm.listModels({ fresh: true });
    expect(provider('anthropic').listCalls).toBe(0);
    expect(provider('openai').listCalls).toBe(0);
    expect(provider('local').listCalls).toBe(1);
  });

  it('refuses to serve a hosted model, however it came to be asked for', async () => {
    provider('anthropic').stream = async function* () {
      throw new Error('this should never run');
    };
    await expect(collect(llm.stream(request('anthropic', 'claude-opus-5-5'), signal()))).resolves.toEqual([
      { type: 'error', code: 'other', message: OFFLINE },
    ]);
  });

  it('serves a local model as it always did', async () => {
    provider('local').stream = async function* () {
      yield { type: 'text', delta: 'hi' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    await expect(collect(llm.stream(request('local', 'llama:3b'), signal()))).resolves.toEqual([
      { type: 'text', delta: 'hi' },
      reckoned,
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('gives the hosted models back when it is switched off again', async () => {
    llm.configure(settings({ offline: false }));
    provider('anthropic').models = [m('claude-opus-5-5')];
    provider('local').models = [m('llama:3b')];
    const { models } = await llm.listModels();
    expect(models.map((x) => x.provider)).toEqual(['anthropic', 'local']);
  });
});

// ---- The count while a reply is still being written (see TokensEvent)
//
// A provider that counts as it streams is left to it. The rest say nothing
// until the call is over — Ollama counts in its last line, and most
// OpenAI-compatible servers in a chunk after the reply — so what has arrived
// is reckoned up here instead, and marked as reckoned wherever it is shown.
describe('the count while a reply is still being written', () => {
  const tokens = (seen: ChatEvent[]) => seen.filter((e) => e.type === 'tokens');

  it('reckons up what the model has written, where the provider says nothing', async () => {
    provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: 'a'.repeat(70) };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const seen = await collect(llm.stream(request('local', 'llama:3b'), signal()));
    // The prompt as sent, and the reply as far as it has got: 70 characters
    // at 2.8 to the token (see CHARS_PER_TOKEN in tokens.ts)
    expect(tokens(seen)).toEqual([{ type: 'tokens', estimated: true, usage: { input: 1, output: 25 } }]);
  });

  it("counts the model's own reasoning with it, the user waiting through that too", async () => {
    provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'reasoning', delta: 'b'.repeat(28) };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const seen = await collect(llm.stream(request('local', 'llama:3b'), signal()));
    expect(tokens(seen)).toEqual([{ type: 'tokens', estimated: true, usage: { input: 1, output: 10 } }]);
  });

  // Reckoning the same figures over and over would redraw the window for a
  // count that has not visibly moved; the text arriving redraws it anyway
  it('does not reckon up again for every word', async () => {
    provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
      for (let i = 0; i < 20; i++) yield { type: 'text', delta: 'word ' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    expect(tokens(await collect(llm.stream(request('local', 'llama:3b'), signal())))).toHaveLength(1);
  });

  it('leaves a provider that counts for itself to it, rather than guessing over it', async () => {
    provider('anthropic').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'tokens', usage: { input: 1000, output: 2 } };
      yield { type: 'text', delta: 'c'.repeat(70) };
      yield { type: 'tokens', usage: { input: 1000, output: 20 } };
      yield { type: 'done', stopReason: 'end_turn', usage: { input: 1000, output: 21 } };
    };
    const seen = await collect(llm.stream(request('anthropic', 'claude-opus-5-5'), signal()));
    // Its own counts, passed on as they came and none of ours among them
    expect(tokens(seen)).toEqual([
      { type: 'tokens', usage: { input: 1000, output: 2 } },
      { type: 'tokens', usage: { input: 1000, output: 20 } },
    ]);
  });

  it('says nothing of its own where the model wrote nothing', async () => {
    provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'done', stopReason: 'end_turn' };
    };
    expect(tokens(await collect(llm.stream(request('local', 'llama:3b'), signal())))).toEqual([]);
  });
});

describe('stream', () => {
  it('passes the request to the right provider and relays its events', async () => {
    const seen: unknown[] = [];
    provider('anthropic').stream = async function* (req: ChatRequest, sig: AbortSignal) {
      seen.push(req, sig);
      yield { type: 'text', delta: 'hi' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const abort = signal();
    const req = request('anthropic', 'claude-opus-5-5');
    await expect(collect(llm.stream(req, abort))).resolves.toEqual([
      { type: 'text', delta: 'hi' },
      reckoned,
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(seen).toEqual([req, abort]);
  });

  it('reports an unknown provider', async () => {
    await expect(collect(llm.stream(request('nope'), signal()))).resolves.toEqual([
      { type: 'error', code: 'other', message: 'Unknown provider "nope"' },
    ]);
  });

  it('refuses a model the user switched off', async () => {
    llm.configure(settings({ openai: { apiKey: 'k', disabledModels: ['gpt-x'] } }));
    await expect(collect(llm.stream(request('openai', 'gpt-x'), signal()))).resolves.toEqual([
      { type: 'error', code: 'other', message: 'gpt-x is switched off in Settings.' },
    ]);
  });

  it('turns a provider that throws into an error event', async () => {
    provider('anthropic').stream = async function* () {
      throw new Error('boom');
    };
    await expect(collect(llm.stream(request('anthropic'), signal()))).resolves.toEqual([
      { type: 'error', code: 'other', message: 'boom' },
    ]);
  });

  describe('when the provider says it is being asked for too much', () => {
    const limited = (message = 'HTTP 429: slow down', extra: Record<string, unknown> = {}) => ({
      type: 'error' as const,
      code: 'rate_limit' as const,
      message,
      ...extra,
    });
    // Answers with a rate limit the first `times` times, then properly
    const turnedAway = (times: number) => {
      let asked = 0;
      provider('anthropic').stream = async function* () {
        if (++asked <= times) {
          yield limited();
          return;
        }
        yield { type: 'text', delta: 'hi' };
        yield { type: 'done', stopReason: 'end_turn' };
      };
      return () => asked;
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Runs the stream to the end with the clock under the test's control
    async function run(events = llm.stream(request('anthropic'), signal())) {
      const seen: ChatEvent[] = [];
      const reading = (async () => {
        for await (const event of events) seen.push(event);
      })();
      // Each wait is let through as it is reached
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(120000);
      await reading;
      return seen;
    }

    it('waits and asks again, saying so, rather than handing back the failure', async () => {
      const asked = turnedAway(1);
      const seen = await run();
      expect(asked()).toBe(2);
      expect(seen).toEqual([
        { type: 'rate_limited', attempt: 1, of: 4, after: expect.any(Number), message: 'HTTP 429: slow down' },
        { type: 'text', delta: 'hi' },
        reckoned,
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    it('gives up after four goes and hands back what the provider said', async () => {
      const asked = turnedAway(99);
      const seen = await run();
      expect(asked()).toBe(4);
      expect(seen.filter((e) => e.type === 'rate_limited')).toHaveLength(3);
      expect(seen.at(-1)).toEqual(limited());
    });

    it('waits longer each time, and no longer than a minute', async () => {
      const waits = [1, 2, 3, 4, 5, 9].map((attempt) => llm.backoff(attempt, undefined, () => 0.5));
      expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    });

    it('waits as long as the provider asked, where it asked', async () => {
      expect(llm.backoff(1, 30000)).toBe(30000);
      // ...but not for ever, whatever it says
      expect(llm.backoff(1, 600000)).toBe(60000);
    });

    it('spreads the waits out, so that everything turned away at once does not return at once', () => {
      expect(llm.backoff(1, undefined, () => 0)).toBe(1500);
      expect(llm.backoff(1, undefined, () => 1)).toBe(2500);
    });

    it('does not start a reply again once any of it has arrived', async () => {
      provider('anthropic').stream = async function* () {
        yield { type: 'text', delta: 'half an ans' };
        yield limited();
      };
      const seen = await run();
      expect(seen.filter((e) => e.type === 'rate_limited')).toEqual([]);
      expect(seen.at(-1)).toEqual(limited());
    });

    it('stops waiting when whoever asked has given up', async () => {
      turnedAway(99);
      const controller = new AbortController();
      const events = llm.stream(request('anthropic'), controller.signal);
      const seen: ChatEvent[] = [];
      const reading = (async () => {
        for await (const event of events) seen.push(event);
      })();
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await reading;
      expect(seen.at(-1)).toEqual(limited());
      expect(seen.filter((e) => e.type === 'rate_limited')).toHaveLength(1);
    });

    // A server that took the request and then went quiet is the one failure
    // here that is not asked again: it may still be working on what it was
    // given, so a second copy of the same question joins the queue behind the
    // first rather than replacing it (see transport.failure)
    describe('or the server took the request and went quiet', () => {
      const stalled = {
        type: 'error' as const,
        code: 'stalled' as const,
        message: 'http://x took the request and then sent nothing back for five minutes.',
      };

      it('hands the failure back at once instead of asking again', async () => {
        let asked = 0;
        provider('anthropic').stream = async function* () {
          asked++;
          yield stalled;
        };
        const seen = await run();
        expect(asked).toBe(1);
        expect(seen.filter((e) => e.type === 'rate_limited')).toEqual([]);
        expect(seen.at(-1)).toEqual(stalled);
      });
    });

    describe('or there is no server to ask', () => {
      const gone = { type: 'error' as const, code: 'unreachable' as const, message: 'No server reachable at http://x' };
      // Finds nothing there the first `times` times, then answers properly
      const away = (times: number) => {
        let asked = 0;
        provider('anthropic').stream = async function* () {
          if (++asked <= times) {
            yield gone;
            return;
          }
          yield { type: 'text', delta: 'hi' };
          yield { type: 'done', stopReason: 'end_turn' };
        };
        return () => asked;
      };

      it('waits and asks again, saying which it was', async () => {
        const asked = away(1);
        const seen = await run();
        expect(asked()).toBe(2);
        expect(seen[0]).toEqual({
          type: 'rate_limited',
          attempt: 1,
          of: 4,
          after: expect.any(Number),
          message: gone.message,
          unreachable: true,
        });
        expect(seen.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
      });

      it('gives up after four goes and hands back the failure', async () => {
        const asked = away(99);
        const seen = await run();
        expect(asked()).toBe(4);
        expect(seen.at(-1)).toEqual(gone);
      });

      it.each([['brief'], ['priority']])('does not hold up a %s request that a reply is waiting on', async (kind) => {
        const asked = away(99);
        const seen = await run(llm.stream({ ...request('anthropic'), [kind]: true }, signal()));
        expect(asked()).toBe(1);
        expect(seen).toEqual([gone]);
      });
    });
  });

  describe('when the provider says the credit behind it is gone', () => {
    const broke = { type: 'error' as const, code: 'spend_limit' as const, message: 'credit balance too low' };
    // Turns every request away, counting them
    const spentOut = () => {
      let asked = 0;
      provider('anthropic').stream = async function* () {
        asked++;
        yield broke;
      };
      return () => asked;
    };
    const fellBack = (to: string) => ({ type: 'fell_back', from: 'anthropic/m', to });

    it('sends the request to a model on another hosted provider, saying so, without asking again', async () => {
      const asked = spentOut();
      provider('openai').models = [m('gpt-x')];
      const seen = await collect(llm.stream(request('anthropic'), signal()));
      expect(asked()).toBe(1);
      expect(seen).toEqual([fellBack('openai/gpt-x'), { type: 'done', stopReason: 'end_turn' }]);
    });

    it('takes the most sophisticated hosted model, before any local one', async () => {
      spentOut();
      provider('openai').models = [m('gpt-x-mini'), m('o9')];
      provider('local').models = [m('qwen:32b')];
      const sent: string[] = [];
      provider('openai').stream = async function* (req: ChatRequest) {
        sent.push(req.model);
        yield { type: 'done', stopReason: 'end_turn' };
      };
      const seen = await collect(llm.stream(request('anthropic'), signal()));
      const best = (await llm.listModels()).models.find((x) => x.provider === 'openai')!;
      expect(seen[0]).toEqual(fellBack(`openai/${best.id}`));
      expect(sent).toEqual([best.id]);
    });

    it('falls back to a local model when there is no other hosted one, even one too small to reply', async () => {
      spentOut();
      provider('local').models = [m('llama:3b')];
      const seen = await collect(llm.stream(request('anthropic'), signal()));
      expect(seen).toEqual([fellBack('local/llama:3b'), { type: 'done', stopReason: 'end_turn' }]);
    });

    it('hands back the error when there is nothing left to go to', async () => {
      spentOut();
      await expect(collect(llm.stream(request('anthropic'), signal()))).resolves.toEqual([broke]);
    });

    it('sends the next request straight to the fallback, until the providers are configured again', async () => {
      const asked = spentOut();
      provider('openai').models = [m('gpt-x')];
      await collect(llm.stream(request('anthropic'), signal()));
      const seen = await collect(llm.stream(request('anthropic'), signal()));
      expect(asked()).toBe(1);
      expect(seen).toEqual([fellBack('openai/gpt-x'), { type: 'done', stopReason: 'end_turn' }]);
      // Spent providers are not offered either
      const { models, providers } = await llm.listModels({ fresh: true });
      expect(models.some((x) => x.provider === 'anthropic')).toBe(false);
      expect(providers.find((p) => p.id === 'anthropic')).toMatchObject({ ok: false, error: llm.SPENT_REASON });

      llm.configure(settings());
      expect(await collect(llm.stream(request('anthropic'), signal()))).toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    it('does not move on once any of the reply has arrived', async () => {
      provider('anthropic').stream = async function* () {
        yield { type: 'text', delta: 'half an ans' };
        yield broke;
      };
      provider('openai').models = [m('gpt-x')];
      const seen = await collect(llm.stream(request('anthropic'), signal()));
      expect(seen.some((e) => e.type === 'fell_back')).toBe(false);
      expect(seen.at(-1)).toEqual(broke);
    });
  });

  // A provider stream that records when it runs and waits to be released
  function gated(log: string[]) {
    const gates: (() => void)[] = [];
    const stream = async function* (req: ChatRequest): AsyncGenerator<ChatEvent> {
      log.push(`start ${req.model}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      log.push(`end ${req.model}`);
      yield { type: 'done', stopReason: 'end_turn' };
    };
    return { stream, gates };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('runs requests to a local provider one at a time, in order', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    provider('local').stream = stream;

    const first = collect(llm.stream(request('local', 'a'), signal()));
    const second = collect(llm.stream(request('local', 'b'), signal()));
    await tick();
    expect(log).toEqual(['start a']);

    gates[0]();
    await first;
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);

    gates[1]();
    await second;
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('lets a priority request go ahead of others that are waiting, but not the one running', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    provider('local').stream = stream;
    const priority = (model: string) => ({ ...request('local', model), priority: true });

    const all = [
      collect(llm.stream(request('local', 'running'), signal())),
      collect(llm.stream(request('local', 'waiting 1'), signal())),
      collect(llm.stream(request('local', 'waiting 2'), signal())),
      collect(llm.stream(priority('classify 1'), signal())),
      collect(llm.stream(priority('classify 2'), signal())),
    ];
    await tick();
    expect(log).toEqual(['start running']);

    // Each request that finishes lets the next in line start
    for (let i = 0; i < 5; i++) {
      gates[i]();
      await tick();
    }
    await Promise.all(all);
    expect(log.filter((line) => line.startsWith('start'))).toEqual([
      'start running',
      'start classify 1',
      'start classify 2',
      'start waiting 1',
      'start waiting 2',
    ]);
  });

  it('lets a request the provider will serve alongside others skip the queue entirely', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    const local = provider('local');
    local.stream = stream;
    // As the Ollama provider does for a brief request to a small model
    local.concurrent = (req: ChatRequest) => !!req.brief;

    const answering = collect(llm.stream(request('local', 'answering'), signal()));
    const classifying = collect(llm.stream({ ...request('local', 'classify'), brief: true }, signal()));
    await tick();
    // Read before anything is let go, and the queue freed before asserting,
    // so that a surprise here doesn't leave it held for the tests after
    const started = [...log].sort();
    gates.forEach((open) => open());
    const [, brief] = await Promise.all([answering, classifying]);

    // The brief one ran alongside the answer rather than waiting for it...
    expect(started).toEqual(['start answering', 'start classify']);
    // ...and was never told it was waiting
    expect(brief).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('still makes the requests the provider will not serve alongside others wait', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    const local = provider('local');
    local.stream = stream;
    local.concurrent = (req: ChatRequest) => !!req.brief;

    const answering = collect(llm.stream(request('local', 'answering'), signal()));
    const second = collect(llm.stream(request('local', 'another answer'), signal()));
    await tick();
    const first = [...log];
    gates[0]();
    await answering;
    await tick();
    gates[1]();
    await second;
    expect(first).toEqual(['start answering']);
    expect(log).toEqual(['start answering', 'end answering', 'start another answer', 'end another answer']);
  });

  it('starts a priority request straight away when nothing is running', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    provider('local').stream = stream;
    const done = collect(llm.stream({ ...request('local', 'classify'), priority: true }, signal()));
    await tick();
    expect(log).toEqual(['start classify']);
    gates[0]();
    await done;
  });

  // Which of the waiting requests goes next, once a local model is keeping one
  // conversation's prompt (see src/llm/cachelock.ts)
  describe('a local model kept for one conversation', () => {
    const forThread = (thread: string, model = 'm') => ({ ...request('local', model), cacheKey: thread });

    // As gated, but recording whose prompt each request was: which model ran is
    // not the question here, and every request in these is to the one model
    function byConversation(log: string[]) {
      const gates: (() => void)[] = [];
      const stream = async function* (req: ChatRequest): AsyncGenerator<ChatEvent> {
        const whose = req.cacheKey ?? 'a one-off prompt';
        log.push(`start ${whose}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        log.push(`end ${whose}`);
        yield { type: 'done', stopReason: 'end_turn' };
      };
      return { stream, gates };
    }

    it('lets the conversation it is holding go ahead of one that has waited longer', async () => {
      const log: string[] = [];
      const { stream, gates } = byConversation(log);
      provider('local').stream = stream;

      const first = collect(llm.stream(forThread('thread 1'), signal()));
      const other = collect(llm.stream(forThread('thread 2'), signal()));
      const next = collect(llm.stream(forThread('thread 1'), signal()));
      await tick();
      expect(log).toEqual(['start thread 1']);

      // The model is holding thread 1's prompt, so thread 1's next step has it
      // back although thread 2 asked first
      gates[0]();
      await first;
      await tick();
      expect(log).toEqual(['start thread 1', 'end thread 1', 'start thread 1']);

      // ...and thread 2 waits on the hold until thread 1 says it has nothing
      // left to carry on from
      gates[1]();
      await next;
      await tick();
      expect(log).toEqual(['start thread 1', 'end thread 1', 'start thread 1', 'end thread 1']);
      cachelock.broke('thread 1', 'reply over');
      await tick();
      expect(log.at(-1)).toBe('start thread 2');
      gates[2]();
      await other;
    });

    it('tells a request waiting on the hold that it is waiting, and how long it waited', async () => {
      const log: string[] = [];
      const { stream, gates } = byConversation(log);
      provider('local').stream = stream;

      const first = collect(llm.stream(forThread('thread 1'), signal()));
      await tick();
      gates[0]();
      await first;
      const other = collect(llm.stream(forThread('thread 2'), signal()));
      await tick();
      expect(log).toEqual(['start thread 1', 'end thread 1']);
      cachelock.broke('thread 1', 'reply over');
      await tick();
      gates[1]();
      expect(await other).toEqual([
        { type: 'queued' },
        { type: 'waited', ms: expect.any(Number) },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    // The app's own one-off prompts: a compaction, a classification on the
    // model that is answering, a subagent asked for a shorter report. Whatever
    // was being held is gone the moment one of them runs, so there is nothing
    // left for it or for anyone else to wait for.
    it('never makes a request with no prompt of its own wait, and frees the model when one runs', async () => {
      const log: string[] = [];
      const { stream, gates } = byConversation(log);
      provider('local').stream = stream;

      const first = collect(llm.stream(forThread('thread 1'), signal()));
      await tick();
      gates[0]();
      await first;

      const oneOff = collect(llm.stream(request('local', 'm'), signal()));
      await tick();
      expect(log.at(-1)).toBe('start a one-off prompt');
      gates[1]();
      expect(await oneOff).toEqual([{ type: 'done', stopReason: 'end_turn' }]);

      // The hold went with it, so another conversation goes straight through
      const other = collect(llm.stream(forThread('thread 2'), signal()));
      await tick();
      expect(log.at(-1)).toBe('start thread 2');
      gates[2]();
      await other;
    });

    it('hands the model on once the hold has run out with nothing from the conversation', async () => {
      vi.useFakeTimers();
      try {
        const log: string[] = [];
        const { stream, gates } = byConversation(log);
        provider('local').stream = stream;

        const first = collect(llm.stream(forThread('thread 1'), signal()));
        await vi.advanceTimersByTimeAsync(0);
        gates[0]();
        await first;

        const other = collect(llm.stream(forThread('thread 2'), signal()));
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual(['start thread 1', 'end thread 1']);

        // Nothing has come from thread 1 for as long as its prompt was worth
        // keeping, so thread 2 is started without anything having to say so
        await vi.advanceTimersByTimeAsync(HOLD_MS);
        expect(log).toEqual(['start thread 1', 'end thread 1', 'start thread 2']);
        gates[1]();
        await other;
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds one model without holding another', async () => {
      const log: string[] = [];
      const { stream, gates } = gated(log);
      provider('local').stream = stream;

      const first = collect(llm.stream(forThread('thread 1', 'big'), signal()));
      await tick();
      gates[0]();
      await first;
      // Another model, which nothing is holding: thread 2 waits for neither
      const other = collect(llm.stream(forThread('thread 2', 'small'), signal()));
      await tick();
      expect(log).toEqual(['start big', 'end big', 'start small']);
      gates[1]();
      await other;
    });
  });

  describe('a request with a time limit', () => {
    const limited = (providerId: string, timeoutMs = 30_000) => ({ ...request(providerId, 'small'), timeoutMs });

    // The real one asks Ollama over the network; tests that care replace this
    beforeEach(() => {
      provider('local').ensureUp = async () => {};
    });

    it('brings the model up before starting it, and gives it its own signal', async () => {
      const order: string[] = [];
      const seen: AbortSignal[] = [];
      provider('local').ensureUp = async (model: string) => {
        order.push(`up ${model}`);
      };
      provider('local').stream = async function* (_req: ChatRequest, sig: AbortSignal): AsyncGenerator<ChatEvent> {
        order.push('stream');
        seen.push(sig);
        yield { type: 'done', stopReason: 'end_turn' };
      };
      const caller = signal();
      await expect(collect(llm.stream(limited('local'), caller))).resolves.toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ]);
      expect(order).toEqual(['up small', 'stream']);
      expect(seen[0]).not.toBe(caller);
    });

    it('does not hold the time the model takes to load against the limit', async () => {
      vi.useFakeTimers();
      try {
        provider('local').ensureUp = () => new Promise<void>((resolve) => setTimeout(resolve, 90_000));
        provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', delta: '2 low general' };
          yield { type: 'done', stopReason: 'end_turn' };
        };
        const result = collect(llm.stream(limited('local', 30_000), signal()));
        await vi.advanceTimersByTimeAsync(90_000);
        await expect(result).resolves.toEqual([
          { type: 'text', delta: '2 low general' },
          reckoned,
          { type: 'done', stopReason: 'end_turn' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    // A classification holds up the whole reply, so its limit covers coming up
    // as well as answering: two minutes spent loading has already failed it
    describe('a request something else is waiting on', () => {
      const waited = (timeoutMs: number) => ({ ...limited('local', timeoutMs), brief: true });

      it('spends the limit on the load as well, and gives up when the load uses it all', async () => {
        vi.useFakeTimers();
        try {
          // Like the real one: the load is given a signal and gives up on it
          provider('local').ensureUp = (_model: string, sig: AbortSignal) =>
            new Promise<void>((resolve, reject) => {
              setTimeout(resolve, 90_000);
              sig.addEventListener('abort', () => reject(new Error('aborted')));
            });
          const started = vi.fn();
          provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
            started();
            yield { type: 'done', stopReason: 'end_turn' };
          };
          const result = collect(llm.stream(waited(30_000), signal()));
          await vi.advanceTimersByTimeAsync(90_000);
          await expect(result).resolves.toEqual([
            { type: 'error', code: 'other', message: 'small could not be started: it did not load within 30 seconds' },
          ]);
          // Not sent to a model whose answer would be too late to use
          expect(started).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it('leaves the answer only what the load did not use', async () => {
        vi.useFakeTimers();
        try {
          provider('local').ensureUp = () => new Promise<void>((resolve) => setTimeout(resolve, 20_000));
          provider('local').stream = async function* (_req: ChatRequest, sig: AbortSignal): AsyncGenerator<ChatEvent> {
            await new Promise((resolve) => sig.addEventListener('abort', resolve));
            yield { type: 'done', stopReason: 'cancelled' };
          };
          const result = collect(llm.stream(waited(30_000), signal()));
          // Twenty seconds of the thirty went on the load, so the answer has
          // ten: at twenty-nine all together it is still waiting...
          await vi.advanceTimersByTimeAsync(29_000);
          await expect(Promise.race([result, Promise.resolve('waiting')])).resolves.toBe('waiting');
          // ...and at thirty it is over, rather than at fifty
          await vi.advanceTimersByTimeAsync(1_000);
          await expect(result).resolves.toEqual([
            { type: 'error', code: 'other', message: 'small did not answer within 30 seconds.' },
          ]);
        } finally {
          vi.useRealTimers();
        }
      });

      it('still answers in good time when the model was already up', async () => {
        provider('local').ensureUp = async () => {};
        provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', delta: '2 low general' };
          yield { type: 'done', stopReason: 'end_turn' };
        };
        await expect(collect(llm.stream(waited(30_000), signal()))).resolves.toEqual([
          { type: 'text', delta: '2 low general' },
          reckoned,
          { type: 'done', stopReason: 'end_turn' },
        ]);
      });
    });

    it('reports a model that is up but does not answer in time', async () => {
      vi.useFakeTimers();
      try {
        // Like a real provider: ends with "cancelled" when its signal aborts
        provider('local').stream = async function* (_req: ChatRequest, sig: AbortSignal): AsyncGenerator<ChatEvent> {
          yield { type: 'text', delta: 'thinking' };
          await new Promise((resolve) => sig.addEventListener('abort', resolve));
          yield { type: 'done', stopReason: 'cancelled' };
        };
        const result = collect(llm.stream(limited('local', 30_000), signal()));
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(result).resolves.toEqual([
          { type: 'text', delta: 'thinking' },
          reckoned,
          { type: 'error', code: 'other', message: 'small did not answer within 30 seconds.' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a model that could not be brought up, without starting it', async () => {
      provider('local').ensureUp = async () => {
        throw new Error('model requires more system memory');
      };
      const started = vi.fn();
      provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
        started();
        yield { type: 'done', stopReason: 'end_turn' };
      };
      await expect(collect(llm.stream(limited('local'), signal()))).resolves.toEqual([
        { type: 'error', code: 'other', message: 'small could not be started: model requires more system memory' },
      ]);
      expect(started).not.toHaveBeenCalled();
    });

    it('stops quietly when the caller cancels while the model is loading', async () => {
      const controller = new AbortController();
      provider('local').ensureUp = (_model: string, sig: AbortSignal) =>
        new Promise<void>((_resolve, reject) => sig.addEventListener('abort', () => reject(new Error('aborted'))));
      const result = collect(llm.stream(limited('local'), controller.signal));
      await tick();
      controller.abort();
      await expect(result).resolves.toEqual([{ type: 'done', stopReason: 'cancelled' }]);
    });

    it('starts the clock straight away for a provider with nothing to bring up', async () => {
      delete provider('anthropic').ensureUp;
      await expect(collect(llm.stream(limited('anthropic'), signal()))).resolves.toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    it('frees the local queue afterwards, whatever happened', async () => {
      provider('local').ensureUp = async () => {
        throw new Error('no');
      };
      await collect(llm.stream(limited('local'), signal()));
      await expect(collect(llm.stream(request('local'), signal()))).resolves.toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });
  });

  it('tells the provider what a model is being brought up for', async () => {
    const ensureUp = vi.fn(async () => {});
    provider('local').ensureUp = ensureUp;
    const req = { ...request('local', 'small'), timeoutMs: 1000, brief: true };
    await collect(llm.stream(req, signal()));
    expect(ensureUp).toHaveBeenCalledWith('small', expect.any(AbortSignal), req);
  });

  it('runs requests to a hosted provider in parallel', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    provider('anthropic').stream = stream;

    const both = [
      collect(llm.stream(request('anthropic', 'a'), signal())),
      collect(llm.stream(request('anthropic', 'b'), signal())),
    ];
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    gates.forEach((open) => open());
    await Promise.all(both);
  });

  it('frees the local queue even when a request fails', async () => {
    provider('local').stream = async function* () {
      throw new Error('boom');
    };
    await collect(llm.stream(request('local'), signal()));
    provider('local').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'done', stopReason: 'end_turn' };
    };
    await expect(collect(llm.stream(request('local'), signal()))).resolves.toEqual([
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('does not start a queued local request that was cancelled while waiting', async () => {
    const log: string[] = [];
    const { stream, gates } = gated(log);
    provider('local').stream = stream;

    const first = collect(llm.stream(request('local', 'a'), signal()));
    const controller = new AbortController();
    const second = collect(llm.stream(request('local', 'b'), controller.signal));
    await tick();
    controller.abort();

    // It ends at once, while the request ahead of it is still running
    await expect(second).resolves.toEqual([
      { type: 'queued' },
      { type: 'waited', ms: expect.any(Number) },
      { type: 'done', stopReason: 'cancelled' },
    ]);
    expect(log).toEqual(['start a']);
    gates[0]();
    await first;
    await tick();
    expect(log).toEqual(['start a', 'end a']);
  });

  it('says so first when a local request has to wait for one in progress, and only then', async () => {
    const { stream, gates } = gated([]);
    provider('local').stream = stream;

    const running = collect(llm.stream(request('local', 'a'), signal()));
    const waiting = collect(llm.stream({ ...request('local', 'classify'), priority: true }, signal()));
    await tick();
    gates[0]();
    await tick();
    gates[1]();

    const finished = { type: 'done', stopReason: 'end_turn' };
    await expect(running).resolves.toEqual([finished]);
    // Said first, then answered with how long it came to, before the reply
    await expect(waiting).resolves.toEqual([{ type: 'queued' }, { type: 'waited', ms: expect.any(Number) }, finished]);
  });

  it('never says a hosted request is waiting', async () => {
    const { stream, gates } = gated([]);
    provider('anthropic').stream = stream;
    const both = [
      collect(llm.stream(request('anthropic', 'a'), signal())),
      collect(llm.stream(request('anthropic', 'b'), signal())),
    ];
    await tick();
    gates.forEach((open) => open());
    for (const events of await Promise.all(both)) expect(events).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });
});

describe('logging what a model is sent and writes', () => {
  let dir: string;
  const logged = (event: string) =>
    fs
      .readFileSync(path.join(dir, 'ch.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === event);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-llm-log-'));
    log.init(dir);
    llm.configure(settings());
  });

  afterEach(() => {
    // Back to logging nowhere
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logs the whole input, and the whole output with how it ended, as a pair', async () => {
    const long = 'x'.repeat(5000);
    provider('anthropic').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: '<thought>Looking.</thought>' };
      yield { type: 'text', delta: long };
      yield { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.txt' } };
      yield { type: 'done', stopReason: 'tool_use', usage: { input: 10, output: 5 } };
    };
    const tool = { name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } };
    await collect(
      llm.stream(
        {
          ...request('anthropic', 'opus'),
          system: long,
          tools: [tool],
          maxTokens: 100,
          log: { request: 'r1', step: 2, purpose: 'reply' },
        },
        signal()
      )
    );

    const [input] = logged('llm.input');
    const [output] = logged('llm.output');
    expect(input).toMatchObject({
      level: 'debug',
      request: 'r1',
      step: 2,
      purpose: 'reply',
      provider: 'anthropic',
      model: 'opus',
      system: long,
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['read_file'],
      maxTokens: 100,
    });
    expect(output).toMatchObject({
      request: 'r1',
      purpose: 'reply',
      call: input.call,
      ok: true,
      stopReason: 'tool_use',
      usage: { input: 10, output: 5 },
      text: `<thought>Looking.</thought>${long}`,
      toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
    });
    expect(output.ms).toEqual(expect.any(Number));
  });

  it('logs what was written before a failure, with the error', async () => {
    provider('anthropic').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: 'partial' };
      yield { type: 'error', code: 'rate_limit', status: 429, message: 'slow down' };
    };
    await collect(llm.stream(request('anthropic'), signal()));
    expect(logged('llm.output')).toMatchObject([
      { ok: false, code: 'rate_limit', status: 429, error: 'slow down', text: 'partial', toolCalls: [] },
    ]);
  });

  it('logs a request that never reached a model', async () => {
    await collect(llm.stream(request('nope'), signal()));
    expect(logged('llm.input')).toHaveLength(1);
    expect(logged('llm.output')).toMatchObject([{ ok: false, error: 'Unknown provider "nope"', text: '' }]);
  });

  it('logs the output so far when whoever asked stops listening', async () => {
    provider('anthropic').stream = async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'text', delta: 'first' };
      yield { type: 'text', delta: 'second' };
    };
    for await (const _event of llm.stream(request('anthropic'), signal())) break;
    expect(logged('llm.output')).toMatchObject([
      { ok: false, error: 'The reply stopped before it finished.', text: 'first' },
    ]);
  });
});
