import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real vector maths is kept — scaling a vector to bytes and back is most of
// what decides whether a search works — and only the model is replaced.
const embedding = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('../../src/search/embeddings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/search/embeddings')>();
  return { ...real, embed: embedding.embed };
});

import { configure, excerpt, forgetThread, index, keyOf, search, textOf } from '../../src/search/threads';
import type { Piece } from '../../src/search/threads';

// A stand-in for the embedder: one dimension per word it knows, counting how
// often each appears. Text about the same things comes out pointing the same
// way, which is all a search needs of it.
const VOCAB = ['docker', 'image', 'parser', 'token', 'embedding', 'dialog'];
const vectorFor = (text: string) => VOCAB.map((word) => text.toLowerCase().split(word).length - 1);

const signal = () => new AbortController().signal;
const piece = (over: Partial<Piece> = {}): Piece => ({
  thread: 't1',
  title: 'Containers',
  at: 0,
  request: 'how is the docker image chosen?',
  reply: 'From the files in the workspace: a docker image per toolchain.',
  when: 1_700_000_000_000,
  ...over,
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-threads-'));
  configure({ dir });
  embedding.embed.mockReset();
  embedding.embed.mockImplementation(async (inputs: string[]) => inputs.map(vectorFor));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// How many texts have been embedded since the last reset
const embedded = () => embedding.embed.mock.calls.flatMap(([inputs]) => inputs as string[]);

describe('what a piece is known by', () => {
  it('is the thread and what was asked, not where the message sits', () => {
    expect(keyOf({ thread: 't1', request: 'how is the image chosen?' })).toBe(
      keyOf({ thread: 't1', request: '  how is the image chosen?  ' })
    );
    expect(keyOf({ thread: 't1', request: 'a' })).not.toBe(keyOf({ thread: 't2', request: 'a' }));
    expect(keyOf({ thread: 't1', request: 'a' })).not.toBe(keyOf({ thread: 't1', request: 'b' }));
  });

  it('embeds the request with the replies to it, and the request alone when there are none', () => {
    expect(textOf({ request: 'why?', reply: 'because.' })).toBe('why?\n\nbecause.');
    expect(textOf({ request: 'why?', reply: '  ' })).toBe('why?');
  });
});

describe('indexing', () => {
  it('embeds every piece the first time, and nothing at all the second', async () => {
    const pieces = [piece(), piece({ at: 4, request: 'and the parser?', reply: 'It is in src/parser.ts.' })];
    await expect(index(pieces, signal())).resolves.toEqual({ pieces: 2, embedded: 2, dropped: 0 });

    embedding.embed.mockClear();
    await expect(index(pieces, signal())).resolves.toEqual({ pieces: 2, embedded: 0, dropped: 0 });
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('embeds the request with the reply, under the model’s document prefix', async () => {
    await index([piece()], signal());
    expect(embedded()).toEqual([
      'search_document: how is the docker image chosen?\n\n' +
        'From the files in the workspace: a docker image per toolchain.',
    ]);
  });

  it('embeds a piece again when the reply has grown, which is what happens as one is written', async () => {
    await index([piece({ reply: 'Looking…' })], signal());
    embedding.embed.mockClear();
    await expect(index([piece({ reply: 'Looking… from the files in the workspace.' })], signal())).resolves.toEqual({
      pieces: 1,
      embedded: 1,
      dropped: 0,
    });
  });

  it('takes a new title or place without embedding anything again', async () => {
    await index([piece()], signal());
    embedding.embed.mockClear();
    await index([piece({ title: 'Docker images', at: 6 })], signal());
    expect(embedding.embed).not.toHaveBeenCalled();
    const [hit] = await search('docker image', signal());
    expect(hit).toMatchObject({ title: 'Docker images', at: 6 });
  });

  it('forgets a piece whose message has gone', async () => {
    await index([piece(), piece({ at: 4, request: 'and the parser?' })], signal());
    await expect(index([piece()], signal())).resolves.toEqual({ pieces: 1, embedded: 0, dropped: 1 });
    expect(await search('parser', signal())).toEqual([]);
  });

  it('keeps the vectors between runs, so a restart embeds nothing', async () => {
    await index([piece()], signal());
    // A fresh start, with the same place to keep them
    configure({ dir });
    embedding.embed.mockClear();
    const [hit] = await search('docker image', signal());
    expect(hit).toMatchObject({ thread: 't1', request: 'how is the docker image chosen?' });
    // Only the query was embedded, not the piece again
    expect(embedded()).toEqual(['search_query: docker image']);
  });

  it('throws the lot away when the model changes, since the vectors cannot be compared', async () => {
    await index([piece()], signal());
    await expect(index([piece()], signal(), 'other-model')).resolves.toEqual({ pieces: 1, embedded: 1, dropped: 0 });
  });

  it('indexes nothing when there is nothing to index', async () => {
    await expect(index([], signal())).resolves.toEqual({ pieces: 0, embedded: 0, dropped: 0 });
    expect(embedding.embed).not.toHaveBeenCalled();
  });
});

describe('searching', () => {
  const pieces = [
    piece(),
    piece({ thread: 't2', title: 'The parser', at: 2, request: 'where is the parser?', reply: 'In src/parser.ts.' }),
    piece({ thread: 't3', title: 'Costs', at: 0, request: 'what did that cost?', reply: 'About 900 token of input.' }),
  ];

  beforeEach(async () => {
    await index(pieces, signal());
  });

  it('answers with the piece that is most like the query, and says how alike', async () => {
    const hits = await search('docker image', signal());
    expect(hits[0]).toMatchObject({ thread: 't1', at: 0, title: 'Containers' });
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(hits.map((hit) => hit.thread)).not.toContain('t3');
  });

  it('shows the part of the reply the query is about', async () => {
    const [hit] = await search('parser', signal());
    expect(hit.preview).toBe('In src/parser.ts.');
  });

  it('asks the model under the query prefix, which is not the document one', async () => {
    embedding.embed.mockClear();
    await search('docker', signal());
    expect(embedded()).toEqual(['search_query: docker']);
  });

  it('leaves out what has nothing to do with the query', async () => {
    expect(await search('dialog', signal())).toEqual([]);
  });

  it('leaves out what is much less alike than the best of them', async () => {
    // Both are about something in the query; one is about twice as much of it
    const hits = await search('docker image parser', signal());
    expect(hits.map((hit) => hit.thread)).toEqual(['t1']);
    // Widen what counts as the same company and the other one is an answer too
    const wider = await search('docker image parser', signal(), { spread: 0.5 });
    expect(wider.map((hit) => hit.thread)).toEqual(['t1', 't2']);
  });

  it('answers with nothing when even the best of them is not close', async () => {
    // One word of a piece that is about several things is not a match
    expect(await search('docker', signal(), { floor: 0.8 })).toEqual([]);
    expect(await search('docker', signal())).toHaveLength(1);
  });

  it('gives back nothing for an empty query, and asks the model nothing', async () => {
    embedding.embed.mockClear();
    expect(await search('   ', signal())).toEqual([]);
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('gives back no more than it was asked for', async () => {
    expect(await search('docker parser token', signal(), { limit: 2 })).toHaveLength(2);
  });

  it('says what the embedder said when there is nothing to embed with', async () => {
    embedding.embed.mockRejectedValue(new Error('No Ollama reachable at http://localhost:11434 to embed with.'));
    await expect(search('docker', signal())).rejects.toThrow('No Ollama reachable');
  });
});

describe('a thread that is deleted', () => {
  it('is no longer searchable, and takes nothing else with it', async () => {
    await index(
      [piece(), piece({ thread: 't2', request: 'where is the parser?', reply: 'In src/parser.ts.' })],
      signal()
    );
    forgetThread('t1');
    expect(await search('docker image', signal())).toEqual([]);
    expect((await search('parser', signal()))[0]).toMatchObject({ thread: 't2' });
  });
});

describe('the preview', () => {
  const text = ['The container is built from an image.', 'The image comes from the toolchain.', 'Tests run with npm.'];

  it('is the line with most of the query in it, and what follows it', () => {
    expect(excerpt(text.join('\n'), 'toolchain')).toBe('The image comes from the toolchain. Tests run with npm.');
  });

  it('is the opening when the query matches no line, which is what it was about', () => {
    expect(excerpt(text.join('\n'), 'nothing here')).toContain('The container is built');
  });

  it('is cut short, with something to say it was', () => {
    const long = 'word '.repeat(200);
    const short = excerpt(long, 'word', 40);
    // The limit, less whatever whitespace the cut landed in, and then the mark
    expect(short.length).toBeLessThanOrEqual(41);
    expect(short.length).toBeGreaterThan(30);
    expect(short.endsWith('…')).toBe(true);
  });

  it('has nothing to show for nothing', () => {
    expect(excerpt('   \n  \n', 'anything')).toBe('');
  });
});
