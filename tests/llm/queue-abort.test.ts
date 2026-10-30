// A request given up while it waits in the local-model queue leaves the queue
// at once (see acquire in ../../src/llm/index.ts): it ends as cancelled without
// waiting for the request ahead of it, never reaches the model, and holds up
// nobody queued behind it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { register, stream } from '../../src/llm';
import * as cachelock from '../../src/llm/cachelock';
import type { ChatEvent, ChatRequest } from '../../src/types';

type Provider = Parameters<typeof register>[0];

const PROVIDER = 'queue-test';

// The local model: each call is held open until the test lets it go
const gates = new Map<string, () => void>();
const log: string[] = [];
const providerStream = vi.fn(async function* (request: ChatRequest, _signal: AbortSignal) {
  const name = request.messages[0].content as string;
  log.push(`start ${name}`);
  await new Promise<void>((resolve) => gates.set(name, resolve));
  log.push(`end ${name}`);
  yield { type: 'text', delta: name } as ChatEvent;
  yield { type: 'done', stopReason: 'stop', usage: { input: 1, output: 1 } } as ChatEvent;
});

let id = 0;
let providerId = PROVIDER;

const request = (name: string): ChatRequest => ({
  provider: providerId,
  model: 'm',
  messages: [{ role: 'user', content: name }],
});

// Runs a request in the background, keeping every event it yields
function run(name: string, signal: AbortSignal) {
  const events: ChatEvent[] = [];
  const finished = (async () => {
    for await (const event of stream(request(name), signal)) events.push(event);
    return events;
  })();
  return { events, finished };
}

const flush = async (times = 10) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await flush(1);
  expect(check()).toBe(true);
};

const release = (name: string) => {
  const open = gates.get(name);
  expect(open).toBeDefined();
  open!();
};

const names = (events: ChatEvent[]) => events.map((e) => e.type);
const ending = (events: ChatEvent[]) => events.find((e) => e.type === 'done') as { stopReason: string } | undefined;

beforeEach(() => {
  providerStream.mockClear();
  gates.clear();
  log.length = 0;
  cachelock.forget();
  // A queue of its own for every test, so one left busy cannot hold up the next
  providerId = `${PROVIDER}-${++id}`;
  register({
    id: providerId,
    name: 'Queue test',
    local: true,
    listModels: vi.fn(async () => []),
    stream: providerStream,
  } as unknown as Provider);
});

describe('a queued local request that is given up', () => {
  it('ends cancelled before the request ahead of it finishes, and never reaches the model', async () => {
    const a = run('a', new AbortController().signal);
    await until(() => log.includes('start a'));

    const b = new AbortController();
    const second = run('b', b.signal);
    await until(() => second.events.some((e) => e.type === 'queued'));
    expect(providerStream).toHaveBeenCalledTimes(1);

    b.abort();
    await second.finished;
    // A is still running: B did not wait for it
    expect(log).toEqual(['start a']);
    expect(names(second.events)).toEqual(['queued', 'waited', 'done']);
    expect(ending(second.events)?.stopReason).toBe('cancelled');

    release('a');
    const first = await a.finished;
    expect(log).toEqual(['start a', 'end a']);
    expect(ending(first)?.stopReason).toBe('stop');
    expect(providerStream).toHaveBeenCalledTimes(1);
    expect(providerStream.mock.calls.map(([r]) => r.messages[0].content)).toEqual(['a']);
  });

  it('finishes at once, without starting, when it was given up before it asked', async () => {
    const a = run('a', new AbortController().signal);
    await until(() => log.includes('start a'));

    const b = new AbortController();
    b.abort();
    const second = await run('b', b.signal).finished;
    expect(ending(second)?.stopReason).toBe('cancelled');
    expect(log).toEqual(['start a']);
    expect(providerStream).toHaveBeenCalledTimes(1);

    release('a');
    await a.finished;
    expect(log).toEqual(['start a', 'end a']);
    expect(providerStream).toHaveBeenCalledTimes(1);
  });

  it('holds up nobody queued behind it', async () => {
    const a = run('a', new AbortController().signal);
    await until(() => log.includes('start a'));

    const b = new AbortController();
    const second = run('b', b.signal);
    await until(() => second.events.some((e) => e.type === 'queued'));
    const third = run('c', new AbortController().signal);
    await until(() => third.events.some((e) => e.type === 'queued'));

    b.abort();
    await second.finished;
    expect(ending(second.events)?.stopReason).toBe('cancelled');
    // C is still behind A
    await flush();
    expect(log).toEqual(['start a']);

    release('a');
    await a.finished;
    await until(() => log.includes('start c'));
    release('c');
    const last = await third.finished;
    expect(log).toEqual(['start a', 'end a', 'start c', 'end c']);
    expect(ending(last)?.stopReason).toBe('stop');
    expect(providerStream.mock.calls.map(([r]) => r.messages[0].content)).toEqual(['a', 'c']);
  });
});
