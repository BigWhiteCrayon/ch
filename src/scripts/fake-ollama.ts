#!/usr/bin/env node
// A stand-in for Ollama that answers from a script, so that the app can be run where there are no models — in a
// thread's container, by a model checking a change to the app itself — and still be used the way a person uses it:
// a message sent, a reply streamed back, tools called, a question asked, an error shown.
//
//   node dist/scripts/fake-ollama.js [--port 11500] [--scenario /tmp/ch-scenario.json]
//
// The scenarios kept with the project are in tests/fixtures/scenarios; one is chosen by copying it to the path given
// as --scenario, and until one is, every request gets the default answers.
//
// The app is pointed at it with LOCAL_LLM_BASE_URL=http://localhost:11500/v1 (see ../settings.ts). It speaks as much
// of Ollama's own API as the app asks of it (see ../llm/ollama.ts and ../llm/providers/ollama.ts): the models and
// what each can do, loading one, a chat streamed a line at a time, and embeddings for the search.
//
// What it says is decided by the scenario: a list of rules, the first that matches a request deciding the answer.
// The file is read again for every request, so a model using the app can change what the app is told mid-session by
// writing a new one, rather than starting everything again. A rule matches on what the request is for, which the app
// says in the X-Ch-Purpose header (see ../llm/providers/ollama.ts), and on the user's last message:
//
//   { "rules": [
//     { "purpose": "classification", "reply": "2 general" },
//     { "when": "list the files", "reply": [{ "tool": "list_workspace", "input": {} }, "There they are."] },
//     { "when": "/^fail/i", "error": 500 },
//     { "reply": "You said: {{last}}", "think": "Thinking it over.", "delayMs": 40 }
//   ] }
//
// A reply that is a list is a conversation of tool calls: its first entry answers the user's message, the next
// answers once the results of those calls are back, and so on, the last being said again if the model is asked more
// often than that. An entry is words, a tool call ({tool, input}), or several calls at once with words before them
// ({text, tools: [{tool, input}]}). Where no rule matches, each purpose has an answer of its own that the app can
// read (see DEFAULTS), and a reply says back what it was sent.
//
// What it was asked is kept: GET /__requests says the last of them (the purpose, the model, the last message, the
// tools offered), for a check of what the app sent rather than only of what it showed.

import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

export interface Call {
  tool: string;
  input?: Record<string, unknown>;
}

export type Turn = string | Call | { text?: string; tools: Call[] };

export interface Rule {
  purpose?: string;
  model?: string;
  // Part of the user's last message, any case, or a regular expression written /like this/flags
  when?: string;
  reply?: Turn | Turn[];
  // Said as the model's reasoning, ahead of the reply
  think?: string;
  // An HTTP status to answer with, or words to end the stream on as Ollama does when a model fails part way
  error?: number | string;
  // Between one piece of the reply and the next, so that the streaming can be seen
  delayMs?: number;
}

export interface Scenario {
  rules?: Rule[];
}

// The models it has: one small enough to classify and describe and big enough to be asked to (see FLOOR in
// ../harness/classifier.ts), one large enough to answer anything, and the one the search embeds with. Their levels
// are read off the size in the name (see ../llm/sophistication.ts).
export const MODELS = [
  { name: 'fake-small:8b', size: 2_500_000_000, able: ['completion', 'tools'] },
  { name: 'fake-large:32b', size: 20_000_000_000, able: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', size: 270_000_000, able: ['embedding'] },
];
const CONTEXT_LENGTH = 32768;
const EMBEDDING_SIZE = 768;
const KEPT_REQUESTS = 50;
const PIECE = 12; // characters of a reply sent at a time
const DELAY_MS = 15;

// What each purpose is answered with where no rule says otherwise: what its reader takes as an answer (see
// ../harness/classifier.ts, planner.ts, verifier.ts, suggester.ts and the rest)
export const DEFAULTS: Record<string, Turn> = {
  classification: '2 general',
  planning: 'no plan',
  description: 'Test thread',
  suggestion: 'NONE',
  summary: 'The conversation so far, in brief.',
  compaction: 'What was found so far, in brief.',
  shorten: 'In brief.',
  verification: 'PASS',
  project: 'A project used to test the app.',
};
export const ECHO = 'You said: {{last}}';

interface ChatMessage {
  role: string;
  content?: string;
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: { function?: { name?: string } }[];
}

export interface Asked {
  at: string;
  purpose: string;
  model: string;
  last: string;
  round: number;
  tools: string[];
}

function matches(when: string, text: string): boolean {
  const pattern = /^\/(.*)\/([a-z]*)$/s.exec(when);
  if (pattern) {
    try {
      return new RegExp(pattern[1], pattern[2]).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(when.toLowerCase());
}

// The rule that decides the answer to a request, or none
export function pick(scenario: Scenario, asked: Pick<Asked, 'purpose' | 'model' | 'last'>): Rule | undefined {
  return (scenario.rules ?? []).find(
    (rule) =>
      (rule.purpose === undefined || rule.purpose === asked.purpose) &&
      (rule.model === undefined || rule.model === asked.model) &&
      (rule.when === undefined || matches(rule.when, asked.last))
  );
}

// What is answered this round: the entry of a list that this many rounds of tool calls have reached
export function turnFor(rule: Rule | undefined, purpose: string, round: number): Turn {
  const reply = rule?.reply ?? DEFAULTS[purpose] ?? ECHO;
  if (!Array.isArray(reply)) return reply;
  if (reply.length === 0) return '';
  return reply[Math.min(round, reply.length - 1)];
}

// The user's last message, and how many times the model has answered since it: each answer after the first is the
// one after a round of tool calls
export function reading(messages: ChatMessage[] = []): { last: string; round: number } {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      at = i;
      break;
    }
  }
  if (at < 0) return { last: '', round: 0 };
  const round = messages.slice(at + 1).filter((m) => m.role === 'assistant').length;
  return { last: messages[at].content ?? '', round };
}

// Words that share words share directions, so the search finds what it is asked for in a way that can be reasoned
// about: each word adds to one of the dimensions, by its hash
export function embed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_SIZE).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % EMBEDDING_SIZE] += 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function readScenario(file: string | undefined): Scenario {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
  } catch (err) {
    // Not written yet: the defaults, until one is (the run recipe names a path under /tmp for a scenario to be copied
    // to, so that one can be chosen while the app runs)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error(`fake-ollama: could not read the scenario ${file}: ${(err as Error).message}`);
    return {};
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const toCalls = (calls: Call[]) =>
  calls.map((call) => ({ function: { name: call.tool, arguments: call.input ?? {} } }));

// Streams one turn the way Ollama does: a line of JSON per piece, the last saying it is done
async function streamTurn(
  res: http.ServerResponse,
  model: string,
  turn: Turn,
  { think, delayMs = DELAY_MS, last }: { think?: string; delayMs?: number; last: string }
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const line = (message: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    res.write(`${JSON.stringify({ model, created_at: new Date().toISOString(), message, done: false, ...more })}\n`);
  const pieces = async (field: 'thinking' | 'content', text: string) => {
    for (let at = 0; at < text.length; at += PIECE) {
      line({ role: 'assistant', content: '', [field]: text.slice(at, at + PIECE) });
      await sleep(delayMs);
    }
  };
  if (think) await pieces('thinking', think);
  const text = typeof turn === 'string' ? turn : 'tools' in turn ? (turn.text ?? '') : '';
  await pieces('content', text.replaceAll('{{last}}', last));
  const calls = typeof turn === 'string' ? [] : 'tools' in turn ? turn.tools : [turn];
  if (calls.length) line({ role: 'assistant', content: '', tool_calls: toCalls(calls) });
  res.end(
    `${JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 100,
      eval_count: Math.max(1, Math.ceil(text.length / 4)),
    })}\n`
  );
}

export function createServer(scenarioFile?: string): http.Server {
  const asked: Asked[] = [];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/version') return send(res, 200, { version: '0.0.0-fake' });
      if (route === 'GET /api/tags') {
        return send(res, 200, { models: MODELS.map(({ name, size }) => ({ name, model: name, size })) });
      }
      if (route === 'GET /v1/models') {
        return send(res, 200, { object: 'list', data: MODELS.map(({ name }) => ({ id: name, object: 'model' })) });
      }
      if (route === 'GET /api/ps') return send(res, 200, { models: [] });
      if (route === 'GET /__requests') return send(res, 200, asked);
      const body = await readBody(req);
      if (route === 'POST /api/show') {
        const model = MODELS.find(({ name }) => name === body.model || name === `${body.model}:latest`);
        if (!model) return send(res, 404, { error: `model '${body.model}' not found` });
        return send(res, 200, {
          capabilities: model.able,
          model_info: { 'general.architecture': 'fake', 'fake.context_length': CONTEXT_LENGTH },
        });
      }
      if (route === 'POST /api/generate') return send(res, 200, { model: body.model, response: '', done: true });
      if (route === 'POST /api/pull') return send(res, 200, { status: 'success' });
      if (route === 'POST /api/embed') {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        return send(res, 200, { model: body.model, embeddings: input.map((text) => embed(String(text ?? ''))) });
      }
      if (route === 'POST /api/chat') {
        const chat = body as ChatBody;
        const model = chat.model ?? '';
        const purpose = String(req.headers['x-ch-purpose'] ?? 'reply');
        const { last, round } = reading(chat.messages);
        const tools = (chat.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean);
        asked.push({ at: new Date().toISOString(), purpose, model, last: last.slice(0, 500), round, tools });
        if (asked.length > KEPT_REQUESTS) asked.shift();
        console.log(`fake-ollama: ${purpose} to ${model}, round ${round}: ${JSON.stringify(last.slice(0, 120))}`);
        const rule = pick(readScenario(scenarioFile), { purpose, model, last });
        if (typeof rule?.error === 'number') return send(res, rule.error, { error: 'fake-ollama was told to fail' });
        if (typeof rule?.error === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          return res.end(`${JSON.stringify({ error: rule.error })}\n`);
        }
        return await streamTurn(res, model, turnFor(rule, purpose, round), {
          think: rule?.think,
          delayMs: rule?.delayMs,
          last,
        });
      }
      send(res, 404, { error: `fake-ollama does not know ${route}` });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });
}

function option(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

function main(argv: string[] = process.argv): void {
  const port = Number(option(argv, 'port') ?? 11500);
  const scenario = option(argv, 'scenario');
  const server = createServer(scenario);
  server.listen(port, () => {
    const { port: listening } = server.address() as AddressInfo;
    console.log(`fake-ollama: listening on http://localhost:${listening}${scenario ? `, from ${scenario}` : ''}`);
  });
}

if (typeof require !== 'undefined' && require.main === module) main();
