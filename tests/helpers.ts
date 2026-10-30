import type { ModelInfo } from '../src/types';

// Collects everything an async iterable yields.
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

// An async iterable over fixed items.
export async function* from<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

// A fetch Response whose body arrives in the given chunks.
export function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, init);
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), init);
}

export function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    contextWindow: null,
    default: false,
    provider: 'local',
    providerName: 'Local',
    local: true,
    sophistication: 1,
    disabled: false,
    ...overrides,
  };
}

// A prompt with its line wrapping taken out, for asserting on what it says
// rather than on where its lines happen to break. Prompts are hard-wrapped in
// the source so a person can read them (see src/scripts/lint.ts), and the
// column they wrap at is nobody's business but the editor's.
export function unwrapped(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}
