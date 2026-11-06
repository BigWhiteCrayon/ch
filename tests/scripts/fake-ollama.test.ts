import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as llm from '../../src/llm';
import { createServer, embed, pick, reading, turnFor } from '../../src/scripts/fake-ollama';
import type { ChatEvent, Settings } from '../../src/types';

describe('a rule', () => {
  const scenario = {
    rules: [
      { purpose: 'classification', reply: '3 coding' },
      { when: 'LIST the files', reply: [{ tool: 'list_workspace', input: {} }, 'There they are.'] },
      { when: '/^fail(ing)?$/i', error: 500 },
      { model: 'fake-small:8b', reply: 'small' },
    ],
  };

  it('is the first whose purpose, model and words all fit', () => {
    expect(pick(scenario, { purpose: 'classification', model: 'x', last: 'list the files' })!.reply).toBe('3 coding');
    expect(pick(scenario, { purpose: 'reply', model: 'x', last: 'please list the files' })!.when).toBe(
      'LIST the files'
    );
    expect(pick(scenario, { purpose: 'reply', model: 'x', last: 'Failing' })!.error).toBe(500);
    expect(pick(scenario, { purpose: 'reply', model: 'x', last: 'not failing' })).toBeUndefined();
    expect(pick(scenario, { purpose: 'reply', model: 'fake-small:8b', last: 'hi' })!.reply).toBe('small');
    expect(pick({}, { purpose: 'reply', model: 'x', last: 'hi' })).toBeUndefined();
  });

  it('answers each round of tool calls with the next entry of its list, and the last one after that', () => {
    const rule = scenario.rules[1];
    expect(turnFor(rule, 'reply', 0)).toEqual({ tool: 'list_workspace', input: {} });
    expect(turnFor(rule, 'reply', 1)).toBe('There they are.');
    expect(turnFor(rule, 'reply', 5)).toBe('There they are.');
  });

  it("falls back to what each purpose's reader takes for an answer, and to saying back what it was sent", () => {
    expect(turnFor(undefined, 'classification', 0)).toBe('2 general');
    expect(turnFor(undefined, 'planning', 0)).toBe('no plan');
    expect(turnFor(undefined, 'verification', 0)).toBe('PASS');
    expect(turnFor(undefined, 'reply', 0)).toBe('You said: {{last}}');
  });
});

describe('the conversation it is sent', () => {
  it('is read for the last thing the user said, and how many rounds of tool calls have come since', () => {
    expect(
      reading([
        { role: 'system', content: 's' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'list the files' },
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'a.ts' },
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'b.ts' },
      ])
    ).toEqual({ last: 'list the files', round: 2 });
    expect(reading([])).toEqual({ last: '', round: 0 });
  });
});

describe('its embeddings', () => {
  const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);

  it('are the same for the same words, closer for shared words, and of the length the search expects', () => {
    expect(embed('the token usage dialog')).toEqual(embed('the token usage dialog'));
    expect(embed('x')).toHaveLength(768);
    const near = cosine(embed('token usage dialog'), embed('the usage dialog'));
    const far = cosine(embed('token usage dialog'), embed('docker container image'));
    expect(near).toBeGreaterThan(far);
  });
});

// The app's own client for Ollama, pointed at it, the way the app is when it is run to be tested: what the app
// would see is what is checked, rather than what the stand-in thinks it sent
describe("the app's Ollama client, pointed at it", () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  const scenario = () => path.join(dir, 'scenario.json');
  const write = (rules: unknown[]) => fs.writeFileSync(scenario(), JSON.stringify({ rules }));

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fake-ollama-'));
    write([]);
    server = createServer(path.join(dir, 'scenario.json'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    llm.configure({
      anthropic: { apiKey: '', disabledModels: [] },
      openai: { apiKey: '', disabledModels: [] },
      local: { baseURL: `${base}/v1`, apiKey: '' },
      sophistication: {},
      sandbox: { image: '' },
      offline: true,
      fast: false,
      autoReview: false,
      approvalCeiling: 5,
      theme: {},
      readable: { global: [], workspaces: {} },
      setup: { completed: true, version: 1, skipped: [] },
    } as Settings);
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => write([]));
  afterEach(() => write([]));

  async function ask(text: string, purpose = 'reply', extra: Partial<Parameters<typeof llm.stream>[0]> = {}) {
    const events: ChatEvent[] = [];
    for await (const event of llm.stream(
      {
        provider: 'local',
        model: 'fake-large:32b',
        messages: [{ role: 'user', content: text }],
        log: { purpose },
        ...extra,
      },
      new AbortController().signal
    )) {
      events.push(event);
    }
    const said = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) => (event as { delta: string }).delta)
        .join('');
    return { events, text: said('text'), reasoning: said('reasoning') };
  }

  it('lists a small model and a large one, rated by their size, and not the one that only embeds', async () => {
    const { models } = await llm.listModels();
    const local = models.filter((m) => m.provider === 'local');
    expect(local.map((m) => m.id).sort()).toEqual(['fake-large:32b', 'fake-small:8b']);
    const level = (id: string) => local.find((m) => m.id === id)!.sophistication;
    expect(level('fake-large:32b')).toBeGreaterThan(level('fake-small:8b'));
    expect(local.every((m) => m.contextWindow && m.contextWindow > 0)).toBe(true);
  });

  it('streams a reply back in pieces, saying back what it was sent', async () => {
    const { text, events } = await ask('hello there, this is a longer message');
    expect(text).toBe('You said: hello there, this is a longer message');
    expect(events.filter((event) => event.type === 'text').length).toBeGreaterThan(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('answers by what the request is for, which the client says', async () => {
    expect((await ask('rate this', 'classification')).text).toBe('2 general');
    write([{ purpose: 'description', reply: 'Renamed by the scenario' }]);
    expect((await ask('describe', 'description')).text).toBe('Renamed by the scenario');
    const asked = (await (await fetch(`${base}/__requests`)).json()) as { purpose: string }[];
    expect(asked.map((request) => request.purpose)).toEqual(
      expect.arrayContaining(['reply', 'classification', 'description'])
    );
  });

  it('calls tools the client reads as tool calls, ending the round as tool use', async () => {
    write([
      {
        when: 'files',
        reply: [{ text: 'Looking.', tools: [{ tool: 'list_workspace', input: { path: 'src' } }, { tool: 'x' }] }],
      },
    ]);
    const { events, text } = await ask('show me the files', 'reply', {
      tools: [{ name: 'list_workspace', description: 'lists', inputSchema: { type: 'object' } }],
    });
    expect(text).toBe('Looking.');
    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls).toMatchObject([
      { name: 'list_workspace', input: { path: 'src' } },
      { name: 'x', input: {} },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });

  it('reasons before it answers, where the scenario says to', async () => {
    write([{ think: 'Weighing it up.', reply: 'Decided.' }]);
    expect(await ask('go')).toMatchObject({ reasoning: 'Weighing it up.', text: 'Decided.' });
  });

  it('fails the way a server fails, with a status or part way through, as it is told to', async () => {
    write([
      { when: 'status', error: 503 },
      { when: 'midway', error: 'the model ran out of memory' },
    ]);
    expect((await ask('status')).events.at(-1)).toMatchObject({ type: 'error' });
    expect((await ask('midway')).events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('ran out of memory'),
    });
  });

  it('reads the scenario again for every request, so it can be changed while the app runs', async () => {
    write([{ reply: 'first' }]);
    expect((await ask('a')).text).toBe('first');
    write([{ reply: 'second' }]);
    expect((await ask('a')).text).toBe('second');
  });
});

// The scenarios an app being tested is pointed at (see tests/fixtures/scenarios)
describe('the scenarios kept with the project', () => {
  const folder = path.join(__dirname, '../fixtures/scenarios');
  const files = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
  const isTurn = (turn: unknown): boolean =>
    typeof turn === 'string' ||
    (typeof turn === 'object' &&
      turn !== null &&
      (typeof (turn as { tool?: unknown }).tool === 'string' ||
        (Array.isArray((turn as { tools?: unknown }).tools) &&
          (turn as { tools: { tool?: unknown }[] }).tools.every((call) => typeof call.tool === 'string'))));

  it.each(files)('%s says what it is for, and every rule in it is one the stand-in can answer', (name) => {
    const scenario = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    expect(typeof scenario.about).toBe('string');
    for (const rule of scenario.rules) {
      const replies = rule.reply === undefined ? [] : Array.isArray(rule.reply) ? rule.reply : [rule.reply];
      expect(replies.every(isTurn)).toBe(true);
      expect(rule.error === undefined || ['number', 'string'].includes(typeof rule.error)).toBe(true);
    }
  });
});
