import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { failure, patientFetch } from '../../src/llm/transport';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}'));
});

// A fetch rejection as the runtime makes one: the message is always the same,
// and what actually happened is in the cause.
const threw = (code?: string) =>
  Object.assign(new TypeError('fetch failed'), code ? { cause: Object.assign(new Error(code), { code }) } : {});

describe('patientFetch', () => {
  // That the dispatcher's waits are off is undici's own business and is not
  // readable from the outside; what this holds is that the request is made
  // through one at all, since without it undici applies its five-minute
  // limits to a local server that is simply still reading the prompt.
  it('asks the server through a dispatcher of its own', async () => {
    await patientFetch('http://server/api/chat', { method: 'POST', body: '{}' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://server/api/chat');
    expect((init as { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
  });

  // One agent for the app, not one per request: a fresh pool each time would
  // leave a socket behind on every call
  it('reuses the one dispatcher across requests', async () => {
    await patientFetch('http://server/a');
    await patientFetch('http://server/b');
    const dispatcherOf = (at: number) => (fetchMock.mock.calls[at][1] as { dispatcher?: unknown }).dispatcher;
    expect(dispatcherOf(0)).toBe(dispatcherOf(1));
  });

  it('passes the request through otherwise untouched', async () => {
    const signal = new AbortController().signal;
    await patientFetch('http://server/api/chat', { method: 'POST', headers: { a: 'b' }, body: 'x', signal });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { a: 'b' }, body: 'x', signal });
  });

  it('is the global fetch, so what stands in front of that stands in front of this', async () => {
    fetchMock.mockResolvedValue(new Response('hello'));
    await expect((await patientFetch('http://server/')).text()).resolves.toBe('hello');
  });
});

describe('failure', () => {
  // The whole point of the split: a server that took the request and went
  // quiet is not a server that wasn't there, and the two want opposite things
  // done about them (see worthRetrying in ../../src/llm/index.ts)
  it.each([['UND_ERR_HEADERS_TIMEOUT'], ['UND_ERR_BODY_TIMEOUT']])('calls %s a stall, not an absence', (code) => {
    const said = failure(threw(code), 'http://localhost:11434/v1');
    expect(said.code).toBe('stalled');
    expect(said.message).toContain('http://localhost:11434/v1');
    expect(said.message).not.toContain('No server reachable');
  });

  it.each([['ECONNREFUSED'], ['ENOTFOUND'], ['ECONNRESET'], ['EHOSTUNREACH'], ['UND_ERR_CONNECT_TIMEOUT']])(
    'calls %s a server that was not reached',
    (code) => {
      expect(failure(threw(code), 'http://x')).toEqual({
        code: 'unreachable',
        message: 'No server reachable at http://x',
      });
    }
  );

  // Anything unrecognised keeps the behaviour the app had before there was a
  // stall to tell apart: worth asking again in a moment
  it('treats a rejection it cannot read as a server that was not reached', () => {
    expect(failure(threw(), 'http://x').code).toBe('unreachable');
    expect(failure(new Error('something else'), 'http://x').code).toBe('unreachable');
    expect(failure(null, 'http://x').code).toBe('unreachable');
  });
});
