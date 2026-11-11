// How the app makes an HTTP request to a model server, and what it makes of
// one that doesn't come back.
//
// Node's fetch is undici's, and undici gives every request two limits the app
// never asked for: 300 seconds to receive the response headers
// (headersTimeout) and 300 seconds between one piece of the body and the next
// (bodyTimeout). Both are wrong for a model running on this computer. A local
// server sends no headers at all until it has worked through the prompt, and
// when it cannot reuse what it read last time it reads the whole conversation
// again from the start, which on a long thread is minutes of work rather than
// seconds.
//
// Measured on a 144,000-token prompt whose cache Ollama had just lost: three
// requests in a row were cut off at 301.4 seconds each, every one of them
// reported as a server that could not be reached and asked again, and the
// fourth — by which time the server had the prompt in hand — answered in 39
// seconds. Sixteen minutes, twice over, for a reply the server was writing
// the whole time.
//
// So a request to a server on this computer is made through a dispatcher with
// neither limit, and waits as long as whoever asked is willing to wait. The
// limits the app does mean to keep are its own, and they are held where they
// are decided: ChatRequest.timeoutMs and the deadlines around it (see
// ./index.ts), which abort through the request's own signal.
//
// A hosted provider keeps undici's limits. A request that crosses the network
// has no prompt to read back and nothing useful to say after five silent
// minutes, and it is answered by a machine that is not this one.

import { Agent } from 'undici';
import type { ErrorCode } from '../types';

// No limit on either wait. Undici reads 0 as "no limit" rather than "at once"
// (checked against 7.30.1, and the behaviour is documented).
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// Still the global fetch, which is the same undici underneath and takes the
// dispatcher to make the request with. Going through undici's own fetch
// instead would mean two copies of the library in one request and a Response
// of a type that isn't the global one; this way there is one path to a server
// and one kind of answer back from it, and what the app stands in front of in
// a test is the fetch it already stands in front of.
//
// `dispatcher` is undici's rather than the standard's, so it is not in
// RequestInit; it is honoured all the same (checked against this Node, and
// the throw it produces is undici's own).
export const patientFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, dispatcher: patient } as RequestInit);

// What a request that threw was. A fetch rejection says almost nothing by
// itself — each one is a TypeError reading "fetch failed" — so what happened
// is in its cause.
//
// The distinction that matters is between a server that isn't there and one
// that is there and has gone quiet. They look the same to the caller and are
// opposites: the first is worth asking again in a moment, and the second is a
// server that may still be working on what it was asked, where asking again
// achieves nothing and costs another copy of the same work.
const SILENT = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export function failure(err: unknown, baseURL: string): { code: ErrorCode; message: string } {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code && SILENT.has(code)) {
    return {
      code: 'stalled',
      message:
        `${baseURL} took the request and then sent nothing back for five minutes. ` +
        'The server is running; it is either still working through the prompt or it has got stuck.',
    };
  }
  // Everything else — a refused connection, a name that doesn't resolve, a
  // connection dropped or reset — is a server that was not reached, which is
  // what a server still starting up looks like and is worth asking again.
  return { code: 'unreachable', message: `No server reachable at ${baseURL}` };
}
