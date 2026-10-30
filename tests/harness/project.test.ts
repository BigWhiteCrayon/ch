import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../../src/types';
import { from, model, unwrapped } from '../helpers';

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), stream: vi.fn() }));
vi.mock('../../src/llm', () => mocks);
// The search tool the explorer borrows; nothing is really searched
const search = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/tools/search', () => ({
  tools: [
    {
      name: 'search_workspace',
      description: 'Search.',
      inputSchema: { type: 'object', required: ['query'] },
      run: search.run,
    },
  ],
}));

import { FLOOR, readable } from '../../src/harness/compactor';
import * as project from '../../src/harness/project';
import { EXPLORER } from '../../src/subagents/explorer';
import { HEAD_EXPLORER } from '../../src/subagents/head';
import { registerTools as registerContextTools, tools as projectTools } from '../../src/tools/context';

const small = model({ id: 'llama:3b', sophistication: 1 });
const sonnet = model({ id: 'sonnet', provider: 'anthropic', local: false, sophistication: 3 });
const opus = model({ id: 'opus', provider: 'anthropic', local: false, sophistication: 4 });
// The request passed to each llm.stream call, copied as it was at that moment
const requests: ChatRequest[] = [];
const sent = () => requests[0];
function onStream(reply: (request: ChatRequest) => ChatEvent[]) {
  mocks.stream.mockImplementation((request: ChatRequest) => {
    requests.push(structuredClone(request));
    return from(stands(request, reply(request)));
  });
}
// A compaction job that answers a long record with a line or two is treated as
// having failed (see FLOOR in the compactor), so what the stubs here write is
// padded out to stand for the record it was given. Only the compaction jobs,
// and only as far as the floor, so every reply the tests name reaches them as
// they wrote it.
function stands(request: ChatRequest, events: ChatEvent[]): ChatEvent[] {
  if (request.log?.purpose !== 'compaction') return events;
  const record = request.messages[0]?.content ?? '';
  const wrote = events.reduce((n, e) => n + (e.type === 'text' ? e.delta.length : 0), 0);
  const short = Math.ceil(record.length * FLOOR) - wrote;
  return short > 0 && wrote > 0 ? [...events, { type: 'text', delta: '.'.repeat(short) }] : events;
}
const replyWith = (...events: ChatEvent[]) => onStream(() => events);
// Each call to llm.stream replays the next scripted reply
function script(...replies: ChatEvent[][]) {
  const queue = [...replies];
  onStream(() => queue.shift() ?? []);
}
const text = (delta: string): ChatEvent => ({ type: 'text', delta });
// The explorer writing each finding into the note, a tool call apiece, and
// then reporting back
const EXPLORER_PROMPT = EXPLORER.prompt;

function explores(...found: string[]) {
  const queue = [
    ...found.map((content, i) => [call(`a${i}`, 'add_to_workspace_context', { content }), done('tool_use')]),
    [text('Written down.'), done()],
  ];
  onStream((request) => {
    // The job that makes the findings into one note runs after the explorer
    // rather than in its turn, so it is answered wherever it falls
    if (request.log?.purpose === 'project.condense') {
      return composed === null ? [done('end_turn')] : [text(composed), done()];
    }
    return queue.shift() ?? [];
  });
}
// Everything a look yields, and the note it ends with
const drain = async (events: AsyncGenerator<unknown, string>) => {
  const seen: unknown[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return { seen, note: next.value };
    seen.push(next.value);
  }
};

// What that job replies; null for one that comes back with nothing, so the
// findings stand as they were written
let composed: string | null = null;
const composes = (note: string | null) => void (composed = note);
const done = (stopReason = 'end_turn'): ChatEvent => ({ type: 'done', stopReason });
const call = (id: string, name: string, input: Record<string, unknown> | null = {}): ChatEvent => ({
  type: 'tool_call',
  id,
  name,
  input,
});

// A workspace to look at, and the app's data folder the notes are kept in
let workspace: string;
let data: string;
const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'projects.json'), 'utf8'));
const put = (name: string, content = '') => {
  fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
  fs.writeFileSync(path.join(workspace, name), content);
};

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-project-'));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-project-data-'));
  put('README.md', '# Demo\nA demo parser.');
  put('package.json', '{"name":"demo","scripts":{"test":"vitest run"}}');
  put('src/parser.ts', 'export const parse = () => {};');
  mocks.listModels.mockReset();
  mocks.stream.mockReset();
  search.run.mockReset();
  search.run.mockResolvedValue('src/parser.ts\n  1: export const parse = () => {};');
  requests.length = 0;
  composed = 'A TypeScript parser, tested with Vitest.';
  // Most sophisticated first, as llm.listModels gives them
  mocks.listModels.mockResolvedValue({ models: [opus, sonnet, small], providers: [] });
  replyWith(
    { type: 'text', delta: ' A TypeScript parser, ' },
    { type: 'text', delta: 'tested with Vitest.\n' },
    { type: 'done', stopReason: 'end_turn' }
  );
  project.init(data);
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of [workspace, data]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('gather', () => {
  it('lists the files, workspaces first, and shows the ones that say most about the project', async () => {
    put('tests/parser.test.ts');
    put('.gitignore', 'dist');
    const seen = await project.gather(workspace);
    expect(seen).toContain(
      '<files>\nsrc/\n  parser.ts\ntests/\n  parser.test.ts\n.gitignore\npackage.json\nREADME.md\n</files>'
    );
    expect(seen).toContain('<file name="README.md">\n# Demo\nA demo parser.\n</file>');
    expect(seen).toContain('<file name="package.json">');
    expect(seen.indexOf('README.md">')).toBeLessThan(seen.indexOf('package.json">'));
    expect(seen).not.toContain('<file name="parser.ts">');
  });

  it('leaves out what is not the project itself: dependencies, build output and hidden workspaces', async () => {
    put('node_modules/dep/index.js');
    put('dist/parser.js');
    put('.git/HEAD');
    const seen = await project.gather(workspace);
    expect(seen).not.toMatch(/node_modules|dist|\.git\b|HEAD/);
  });

  it('goes only a few workspaces deep, and says where it stopped', async () => {
    put('a/b/c/d/e/deep.ts');
    const seen = await project.gather(workspace);
    expect(seen).toContain('a/\n  b/\n    c/\n      d/ …\n');
    expect(seen).not.toContain('deep.ts');
  });

  it('cuts a long listing and long files short', async () => {
    for (let i = 0; i < 400; i++) put(`many/file-${String(i).padStart(3, '0')}.txt`);
    put('README.md', 'x'.repeat(10000));
    const seen = await project.gather(workspace);
    expect(seen).toContain('… and more');
    expect(seen).not.toContain('file-399.txt');
    expect(seen).toContain(`${'x'.repeat(3000)}\n[...]`);
    expect(seen.length).toBeLessThan(25000);
  });

  it('is empty for a workspace with nothing in it, or one that is not there', async () => {
    fs.rmSync(workspace, { recursive: true, force: true });
    expect(await project.gather(workspace)).toBe('');
    fs.mkdirSync(workspace);
    expect(await project.gather(workspace)).toBe('');
  });
});

describe('survey', () => {
  it("sends an explorer through the workspace, and keeps what it writes as the workspace's note", async () => {
    expect(project.due(workspace)).toBe(true);
    expect(project.get(workspace)).toBe('');
    explores('A TypeScript parser, tested with Vitest.');

    await expect(project.survey(workspace)).resolves.toBe('A TypeScript parser, tested with Vitest.');
    expect(sent().system).toContain(HEAD_EXPLORER.prompt);
    // It starts from the top of the workspace, and finds the rest out for itself
    expect(sent().messages[0].content).toContain('<files>\nsrc/\n  parser.ts\npackage.json\nREADME.md\n</files>');
    expect(unwrapped(String(sent().messages[0].content))).toContain('Nobody has looked at it before');
    // The workspace's own tools rather than a thread's container: the notes it
    // writes and searches, the one line-at-a-time writer for the note every
    // message carries, and the one it sends explorers into the parts with
    expect(sent().tools?.map((tool) => tool.name)).toEqual([
      'search_workspace',
      'list_files',
      'read_file',
      'search_workspace_notes',
      'add_workspace_note',
      'add_to_workspace_context',
      'hand_to_subagent',
    ]);

    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
    expect(project.due(workspace)).toBe(false);
    expect(saved()[workspace]).toMatchObject({
      text: 'A TypeScript parser, tested with Vitest.',
      writtenAt: expect.any(String),
    });
  });

  it('writes what it found as it goes, so a look cut short still leaves something', async () => {
    // Nothing is made of the findings here, so they stand as they were written
    composes(null);
    explores('A TypeScript parser.', 'Tested with Vitest, run with npm test.');
    await project.survey(workspace);
    // Each finding added rather than the note rewritten, so neither is lost
    expect(project.get(workspace)).toBe('A TypeScript parser.\n\nTested with Vitest, run with npm test.');
  });

  describe('making the findings into one note', () => {
    it('runs once the explorer is done, and keeps what it wrote as the note', async () => {
      composes('A TypeScript parser, tested with Vitest.');
      explores('A parser.', 'There are tests.', 'They are Vitest.');
      await expect(project.survey(workspace)).resolves.toBe('A TypeScript parser, tested with Vitest.');
      expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
      expect(saved()[workspace]).toMatchObject({ text: 'A TypeScript parser, tested with Vitest.' });

      // It is given the findings, and told they were written one at a time
      const job = requests.find((request) => request.log?.purpose === 'project.condense')!;
      expect(job.system).toBe(project.COMPOSE_PROMPT);
      expect(job.messages[0].content).toBe('A parser.\n\nThere are tests.\n\nThey are Vitest.');
      expect(unwrapped(project.COMPOSE_PROMPT)).toContain('written one at a time');
      expect(unwrapped(project.COMPOSE_PROMPT)).toContain('Do not add anything of your own');
      // A bounded job, and not one to spend a thinking budget on
      expect(job.think).toBe(false);
    });

    it('is what the threads are told about, not the findings it was made from', async () => {
      const told: string[] = [];
      const stop = project.onSurveyed((_where, note) => told.push(note));
      try {
        composes('A TypeScript parser, tested with Vitest.');
        explores('A parser.', 'There are tests.');
        await project.survey(workspace);
        expect(told).toEqual(['A TypeScript parser, tested with Vitest.']);
      } finally {
        stop();
      }
    });

    it('says it is condensing, so the wait is accounted for', async () => {
      composes('A parser.');
      explores('A parser, roughly.');
      const { seen } = await drain(project.watch(workspace));
      expect(seen).toContainEqual({ type: 'condensing' });
      // ...and that it is over, so the notice of it does not stay up
      expect(seen).toContainEqual({ type: 'condensed', changed: true });
    });

    it.each([
      ['it comes back with nothing', null],
      ['what comes back is longer than the findings', 'x'.repeat(7000)],
    ])('leaves the findings as they were when %s', async (_name, reply) => {
      composes(reply);
      explores('A parser.', 'There are tests.');
      await expect(project.survey(workspace)).resolves.toBe('A parser.\n\nThere are tests.');
    });

    it('is not run for an explorer that wrote nothing down: its report is already one note', async () => {
      script([text('A TypeScript parser, tested with Vitest.'), done()]);
      await project.survey(workspace);
      expect(requests.filter((request) => request.log?.purpose === 'project.condense')).toEqual([]);
    });

    it('waits for the end rather than running on half the findings', async () => {
      // Each finding takes the note past the length that would otherwise set a
      // condensing job going in the background
      const long = 'x'.repeat(3000);
      composes('A parser.');
      explores(long, long);
      await project.survey(workspace);
      // One job, after the looking, rather than one as each finding lands
      expect(requests.filter((request) => request.log?.purpose === 'project.condense')).toHaveLength(1);
      expect(requests.at(-1)!.log?.purpose).toBe('project.condense');
    });
  });

  it('keeps what the explorer reported when it wrote nothing down itself', async () => {
    // Its report is the next best thing to the note it was asked to write
    script([text('A TypeScript parser, tested with Vitest.'), done()]);
    await expect(project.survey(workspace)).resolves.toBe('A TypeScript parser, tested with Vitest.');
  });

  it('is a look in progress until it is over, whatever the note says meanwhile', async () => {
    let carryOn!: () => void;
    const held = new Promise<void>((resolve) => (carryOn = resolve));
    search.run.mockImplementation(async () => {
      await held;
      return 'found';
    });
    script([call('c1', 'search_workspace', { query: 'q' }), done('tool_use')], [text('A parser.'), done()]);
    expect(project.surveying(workspace)).toBe(false);
    const begun = project.survey(workspace);
    await vi.waitFor(() => expect(project.surveying(workspace)).toBe(true));
    carryOn();
    await begun;
    expect(project.surveying(workspace)).toBe(false);
  });

  it('tells whoever is listening once the note is written, rather than waiting to be asked', async () => {
    const told: [string, string][] = [];
    const stop = project.onSurveyed((where, note) => told.push([where, note]));
    try {
      explores('A TypeScript parser, tested with Vitest.');
      await project.survey(workspace);
      expect(told).toEqual([[workspace, 'A TypeScript parser, tested with Vitest.']]);
      // Once, and not again for a workspace that already had its note
      await project.survey(workspace);
      expect(told).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('tells nobody when no note could be written', async () => {
    const told: string[] = [];
    const stop = project.onSurveyed((where) => told.push(where));
    try {
      replyWith({ type: 'error', code: 'other', message: 'boom' });
      await project.survey(workspace);
      expect(told).toEqual([]);
    } finally {
      stop();
    }
  });

  it('is high-effort work: the most capable model there is, with room to reason', async () => {
    await project.survey(workspace);
    expect(sent()).toMatchObject({ provider: 'anthropic', model: 'opus' });
    expect(sent().maxTokens).toBeGreaterThanOrEqual(4000);

    requests.length = 0;
    mocks.listModels.mockResolvedValue({ models: [small], providers: [] });
    project.init(data);
    fs.rmSync(path.join(data, 'projects.json'));
    project.init(data);
    await project.survey(workspace);
    expect(sent().model).toBe('llama:3b');
  });

  it('keeps the note across a restart, and does not ask for it again', async () => {
    await project.survey(workspace);
    project.init(data);
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
    expect(project.due(workspace)).toBe(false);
    await project.survey(workspace);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('looks at a workspace once however many ask at the same time', async () => {
    const [first, second] = await Promise.all([project.survey(workspace), project.survey(workspace)]);
    expect(first).toBe(second);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('keeps a note for each workspace', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-project-other-'));
    fs.writeFileSync(path.join(other, 'main.py'), '');
    try {
      await project.survey(workspace);
      replyWith({ type: 'text', delta: 'A Python script.' }, { type: 'done', stopReason: 'end_turn' });
      await project.survey(other);
      expect(project.get(workspace)).toContain('TypeScript');
      expect(project.get(other)).toBe('A Python script.');
      expect(Object.keys(saved()).sort()).toEqual([workspace, other].sort());
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it.each([
    ['there are no models', () => mocks.listModels.mockResolvedValue({ models: [], providers: [] })],
    [
      'the model reports an error',
      () => replyWith({ type: 'text', delta: 'Partial' }, { type: 'error', code: 'other', message: 'boom' }),
    ],
    [
      'the model writes nothing',
      () => replyWith({ type: 'text', delta: '  \n' }, { type: 'done', stopReason: 'length' }),
    ],
    ['listing the models fails', () => mocks.listModels.mockRejectedValue(new Error('offline'))],
    ['the workspace is empty', () => fs.rmSync(workspace, { recursive: true, force: true })],
  ])('writes and saves no note when %s', async (_name, arrange) => {
    arrange();
    await expect(project.survey(workspace)).resolves.toBe('');
    expect(project.get(workspace)).toBe('');
    expect(fs.existsSync(path.join(data, 'projects.json'))).toBe(false);
  });

  it('leaves a workspace alone for a while after failing, then tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    replyWith({ type: 'error', code: 'other', message: 'boom' });
    await project.survey(workspace);
    expect(project.due(workspace)).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(project.due(workspace)).toBe(true);
    replyWith({ type: 'text', delta: 'A parser.' }, { type: 'done', stopReason: 'end_turn' });
    await expect(project.survey(workspace)).resolves.toBe('A parser.');
  });
});

describe('exploring with tools', () => {
  const messages = (n: number) => requests[n].messages;

  it('runs the tools the model calls against the workspace, and lets it carry on to the note', async () => {
    put('src/long.ts', Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n'));
    script(
      [text('Searching first.'), call('c1', 'search_workspace', { query: 'where does it start' }), done('tool_use')],
      [
        call('c2', 'list_files', { path: 'src' }),
        call('c3', 'read_file', { path: 'package.json' }),
        call('c4', 'read_file', { path: 'src/long.ts', start_line: 100 }),
        done('tool_use'),
      ],
      [text('A parser with tests.'), done()]
    );
    await expect(project.survey(workspace, 'thread-1')).resolves.toBe('A parser with tests.');

    // The search is the thread's own, pointed at this workspace
    expect(search.run).toHaveBeenCalledWith(
      { query: 'where does it start' },
      expect.objectContaining({ threadId: 'thread-1', workspace })
    );
    expect(messages(1).slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Searching first.',
        toolCalls: [{ id: 'c1', name: 'search_workspace', input: { query: 'where does it start' } }],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        name: 'search_workspace',
        content: 'src/parser.ts\n  1: export const parse = () => {};',
        isError: false,
      },
    ]);
    const results = messages(2)
      .filter((m) => m.role === 'tool')
      .slice(-3)
      .map((m) => m.content);
    expect(results[0]).toBe('long.ts\nparser.ts');
    expect(results[1]).toBe('1: {"name":"demo","scripts":{"test":"vitest run"}}');
    expect(results[2].startsWith('100: line 100\n101: line 101')).toBe(true);
    expect(results[2].endsWith('299: line 299\n… 151 more lines; read on from start_line 300')).toBe(true);
  });

  it('borrows a name for the search when no thread is open on the workspace', async () => {
    script([call('c1', 'search_workspace', { query: 'q' }), done('tool_use')], [text('A note.'), done()]);
    await project.survey(workspace);
    expect(search.run.mock.calls[0][1]).toMatchObject({ threadId: 'survey', workspace });
  });

  it('tells the model what went wrong with a tool, and never reads outside the workspace', async () => {
    search.run.mockRejectedValue(new Error('No Ollama reachable to embed with.'));
    const outside = path.join(data, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(workspace, 'link.txt'));
    script(
      [
        call('c1', 'search_workspace', { query: 'q' }),
        call('c2', 'read_file', { path: '../../etc/passwd' }),
        call('c3', 'read_file', { path: outside }),
        call('c4', 'read_file', { path: 'link.txt' }),
        call('c5', 'read_file', { path: 'missing.txt' }),
        call('c6', 'no_such_tool'),
        call('c7', 'list_files', null),
        done('tool_use'),
      ],
      [text('A note.'), done()]
    );
    await expect(project.survey(workspace)).resolves.toBe('A note.');
    const results = messages(1).filter((m) => m.role === 'tool');
    expect(results.every((m) => m.role === 'tool' && m.isError)).toBe(true);
    expect(results.map((m) => m.content)).toEqual([
      'No Ollama reachable to embed with.',
      expect.stringMatching(/outside the workspace|There is no/),
      'That path is outside the workspace.',
      'That path is outside the workspace.',
      'There is no missing.txt in the workspace.',
      expect.stringContaining('There is no tool named "no_such_tool". The tools you have are: '),
      'The tool input was not valid JSON.',
    ]);
    expect(JSON.stringify(messages(1))).not.toContain('secret"');
  });

  it(`has the model write the note after ${project.MAX_STEPS} rounds, and offers it no more`, async () => {
    // The round that asks for the report is the one that says so: the tools
    // go with it either way now (see tools in ../../src/subagents/run.ts)
    const asked = (request: ChatRequest) =>
      String(request.messages.at(-1)?.content ?? '').includes('Report what you have found now');
    onStream((request) =>
      asked(request)
        ? [text('Written at last.'), done()]
        : [call(`c${requests.length}`, 'list_files'), done('tool_use')]
    );
    await expect(project.survey(workspace)).resolves.toBe('Written at last.');
    expect(requests).toHaveLength(project.MAX_STEPS);
    expect(requests.at(-1)!.tools).toEqual(requests[0].tools);
    expect(String(requests.at(-1)!.messages.at(-1)!.content)).toContain('Report what you have found now');
  });

  it('shows the workspace in one go to a model that cannot call tools', async () => {
    script(
      [{ type: 'error', code: 'other', status: 400, message: 'does not support tools' }],
      [text('A parser.'), done()]
    );
    await expect(project.survey(workspace)).resolves.toBe('A parser.');
    expect(requests[1].system).toBe(project.PLAIN_PROMPT);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].messages[0].content).toContain('<file name="README.md">\n# Demo');
  });

  describe('when the context window is nearly full', () => {
    const big = 'x'.repeat(5500);
    // A small window, so a few tool results fill it
    const tight = model({ id: 'tight', sophistication: 5, contextWindow: 6000 });
    const compactions = () => requests.filter((request) => request.log?.purpose === 'compaction');

    beforeEach(() => {
      mocks.listModels.mockResolvedValue({ models: [tight], providers: [] });
      search.run.mockResolvedValue(big);
    });

    it('has the older tool results compacted into findings, a bit at a time, and carries on from those', async () => {
      let round = 0;
      onStream((request) => {
        if (request.log?.purpose === 'compaction') return [text(`finding ${compactions().length}`), done()];
        return ++round <= 5
          ? [call(`c${round}`, 'search_workspace', { query: `q${round}` }), done('tool_use')]
          : [text('The note.'), done()];
      });
      await expect(project.survey(workspace)).resolves.toBe('The note.');

      expect(compactions().length).toBeGreaterThanOrEqual(2);
      expect(compactions()[0]).toMatchObject({ provider: 'local', model: 'tight' });
      // What the job reads is a record of the work: the calls and the results
      // they answer. On a window this tight only the latest bit of it fits —
      // two of these results do not go in one job's reading at all, and the
      // record is filled from the latest backwards (see compact), so the first
      // job gets the newest result rather than the first call. It reads about
      // 8,400 characters here; it used to be given 11,800, which was half
      // again what this window holds (see CHARS_PER_TOKEN in src/llm/tokens.ts).
      expect(compactions()[0].messages[0].content).toContain('Result of search_workspace:');
      // No job reads more than the room it has to read in. The record is what
      // readable() bounds; the wrapper and the lines asking for the notes go
      // with it and are counted against the window separately (see ASKING).
      for (const job of compactions()) {
        const read = String(job.messages[0].content).match(/<record>\n([\s\S]*)\n<\/record>/)?.[1] ?? '';
        expect(read).not.toBe('');
        expect(read.length).toBeLessThanOrEqual(readable(6000));
      }

      const last = requests.at(-1)!;
      expect(last.messages[0].content).toContain('Get to know the project in this workspace');
      expect(last.messages[0].content).toContain('What you found earlier');
      // The findings of the first compaction are read again by a later one
      // rather than added to, so what the survey carries on from condenses the
      // whole of it without growing with every pass
      expect(compactions().some((job) => String(job.messages[0].content).includes('finding 1'))).toBe(true);
      expect(last.messages[0].content).toMatch(/finding \d/);
      // Far less is sent than was gathered, and no result is left without its call
      expect(JSON.stringify(last.messages).length).toBeLessThan(4 * big.length);
      expect(last.messages[1].role).toBe('assistant');
    });

    it('compacts and tries once more when the model is cut off with nothing written', async () => {
      mocks.listModels.mockResolvedValue({ models: [opus], providers: [] });
      let cutOff = false;
      onStream((request) => {
        if (request.log?.purpose === 'compaction') return [text('finding'), done()];
        if (!request.messages.some((m) => m.role === 'tool'))
          return [call('c1', 'search_workspace', { query: 'q' }), call('c2', 'list_files'), done('tool_use')];
        if (!cutOff) {
          cutOff = true;
          return [done('length')];
        }
        return [text('The note.'), done()];
      });
      await expect(project.survey(workspace)).resolves.toBe('The note.');
      expect(cutOff).toBe(true);
    });

    it('gives up when the model is cut off again', async () => {
      onStream((request) => {
        if (request.log?.purpose === 'compaction') return [text('finding'), done()];
        return [done('length')];
      });
      await expect(project.survey(workspace)).resolves.toBe('');
      expect(project.get(workspace)).toBe('');
    });
  });
});

describe('watch', () => {
  it('shows the work as it is done: what the model said, the tools it called and what came back', async () => {
    script(
      [text('Searching first.'), call('c1', 'search_workspace', { query: 'entry point' }), done('tool_use')],
      [call('c2', 'read_file', { path: 'missing.txt' }), done('tool_use')],
      [text('A parser.'), done()]
    );
    const { seen, note } = await drain(project.watch(workspace, 'thread-1'));
    expect(note).toBe('A parser.');
    expect(seen).toEqual([
      { type: 'thought', text: 'Searching first.' },
      { type: 'tool_call', id: expect.any(String), name: 'search_workspace', input: { query: 'entry point' } },
      {
        type: 'tool_result',
        id: expect.any(String),
        name: 'search_workspace',
        output: 'src/parser.ts\n  1: export const parse = () => {};',
        isError: false,
      },
      { type: 'tool_call', id: expect.any(String), name: 'read_file', input: { path: 'missing.txt' } },
      {
        type: 'tool_result',
        id: expect.any(String),
        name: 'read_file',
        output: 'There is no missing.txt in the workspace.',
        isError: true,
      },
    ]);
    // The note itself is not part of the work shown
    expect(JSON.stringify(seen)).not.toContain('A parser.');
  });

  it("shows a reasoning model's own reasoning as thoughts, before the tools it then calls", async () => {
    script(
      [
        { type: 'reasoning', delta: 'I should find the entry point.\n\nSearching is quickest.' },
        call('c1', 'search_workspace', { query: 'entry point' }),
        done('tool_use'),
      ],
      [text('A parser.'), done()]
    );
    const { seen, note } = await drain(project.watch(workspace, 'thread-1'));
    expect(note).toBe('A parser.');
    expect(seen.slice(0, 3)).toEqual([
      { type: 'thought', text: 'I should find the entry point.' },
      { type: 'thought', text: 'Searching is quickest.' },
      { type: 'tool_call', id: expect.any(String), name: 'search_workspace', input: { query: 'entry point' } },
    ]);
  });

  it('shows the work from the beginning to someone who starts watching part-way through', async () => {
    let carryOn!: () => void;
    const held = new Promise<void>((resolve) => (carryOn = resolve));
    search.run.mockImplementation(async () => {
      await held;
      return 'found';
    });
    script([call('c1', 'search_workspace', { query: 'q' }), done('tool_use')], [text('A parser.'), done()]);

    // Begun when the workspace was opened, before anyone was watching
    const begun = project.survey(workspace);
    await vi.waitFor(() => expect(search.run).toHaveBeenCalled());
    const watching = drain(project.watch(workspace));
    carryOn();

    const { seen, note } = await watching;
    expect(seen).toMatchObject([
      { type: 'tool_call', name: 'search_workspace' },
      { type: 'tool_result', name: 'search_workspace', output: 'found' },
    ]);
    expect(note).toBe('A parser.');
    await expect(begun).resolves.toBe('A parser.');
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('says when it is condensing what it has found to make room', async () => {
    mocks.listModels.mockResolvedValue({
      models: [model({ id: 'tight', sophistication: 5, contextWindow: 6000 })],
      providers: [],
    });
    search.run.mockResolvedValue('x'.repeat(5500));
    let round = 0;
    onStream((request) => {
      if (request.log?.purpose === 'compaction') return [text('finding'), done()];
      return ++round <= 4
        ? [call(`c${round}`, 'search_workspace', { query: 'q' }), done('tool_use')]
        : [text('The note.'), done()];
    });
    const { seen } = await drain(project.watch(workspace));
    expect(seen).toContainEqual({ type: 'condensing' });
    // Over once the compaction is: the notice gives way to a record of it
    const types = seen.map((event) => event.type);
    expect(types.indexOf('condensed')).toBeGreaterThan(types.indexOf('condensing'));
    expect(seen).toContainEqual({ type: 'condensed', changed: true });
  });

  it('has nothing to show for a workspace that already has its note, or when no note can be written', async () => {
    await project.survey(workspace);
    await expect(drain(project.watch(workspace))).resolves.toEqual({
      seen: [],
      note: 'A TypeScript parser, tested with Vitest.',
    });

    project.init(data);
    fs.rmSync(path.join(data, 'projects.json'));
    project.init(data);
    mocks.listModels.mockResolvedValue({ models: [], providers: [] });
    await expect(drain(project.watch(workspace))).resolves.toEqual({ seen: [], note: '' });
  });
});

describe('a workspace with nothing in it', () => {
  it('is not due while it is empty or holds only a repository, and is again once it holds a file', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-project-bare-'));
    try {
      expect(project.due(bare)).toBe(false);
      fs.mkdirSync(path.join(bare, '.git'));
      expect(project.due(bare)).toBe(false);
      fs.writeFileSync(path.join(bare, 'README.md'), '# Demo');
      expect(project.due(bare)).toBe(true);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is due when the folder cannot be read, which is not taken for empty', () => {
    expect(project.due(path.join(workspace, 'missing'))).toBe(true);
  });
});

describe('before init', () => {
  it('does nothing, so the harness can run without it', async () => {
    vi.resetModules();
    const fresh = await import('../../src/harness/project');
    expect(fresh.due(workspace)).toBe(false);
    expect(fresh.get(workspace)).toBe('');
    await expect(fresh.survey(workspace)).resolves.toBe('');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

describe('update_workspace_context', () => {
  const [tool] = projectTools;
  // What it says, not where its lines break
  const description = unwrapped(tool.description);
  const context = () => ({ signal: new AbortController().signal, threadId: 'thread-1', workspace });

  it('is offered only in a thread that has a workspace, for the model to use on its own initiative', () => {
    expect(tool).toMatchObject({ name: 'update_workspace_context', needsWorkspace: true });
    expect(tool.inputSchema).toMatchObject({ required: ['content'] });
    expect(description).toContain('on your own initiative');
    expect(description).toContain('This overwrites it');
  });

  it('says what this note is for, which is the overview and not the particulars', () => {
    expect(description).toContain('shown at the start of every message');
    expect(description).toContain('the overview and nothing else');
    // Asked for proactively, and as the work goes rather than at the end
    expect(description).toContain('on your own initiative');
    expect(description).toContain('the moment what it says changes or turns out to be wrong');
    // ...and for the rest it points at the tool beside it rather than saying
    // it twice (see below)
    expect(description).toContain('add_to_workspace_context');
  });

  // What belongs in the note is said on the tool that adds to it, and once.
  // Both tools are offered in the same step, so a copy on each was paid for
  // twice every round; the adding one keeps it because it is the one a
  // subagent can be given on its own (see ../../src/subagents/head.ts), while
  // nothing is ever given the replacing one without it.
  it('names concretely what belongs in the note, on the tool that adds to it', () => {
    const told = unwrapped(projectTools[1].description);
    for (const kind of [
      'what the project is',
      'how it is laid out',
      'how it is built, run and tested',
      'what has to be installed',
    ]) {
      expect(told).toContain(kind);
    }
    // The detail has somewhere better to go, where it costs nobody the room
    // (see ../../src/harness/notes.ts)
    expect(told).toContain('Everything more particular than that');
    expect(told).toContain('add_workspace_note');
    // ...and still not the place for the task's own progress
    expect(told).toContain('context note for the thread');
    // The prompt that has the note in front of it does not list this again:
    // its own copy named the particulars — a trap, a command's real flags —
    // which this description routes to add_workspace_note instead, so the two
    // disagreed about the one note they were both describing.
    const prompt = unwrapped(`${project.prompt('A note.')}\n\n${project.OWN_COPY}`);
    expect(prompt).not.toContain('where a kind of thing lives');
    expect(prompt).not.toContain('a trap and how to avoid it');
  });

  it('asks for a short note, and says where the rest of what it knows belongs', () => {
    const { content } = (tool.inputSchema as { properties: { content: { description: string } } }).properties;
    expect(content.description).toContain('about 250 words');
    expect(content.description).toContain(`refused over ${project.MAX_NOTE_LENGTH} characters`);
    // Short because everybody pays for it, not because what was learned does
    // not matter: the particulars go where they can be searched for
    expect(unwrapped(content.description)).toContain('every message in this workspace carries it');
    expect(unwrapped(content.description)).toContain('write those down with add_workspace_note');
    expect(content.description).toContain('shortened for you');
  });

  it("writes the thread's own note, saves it, and has the thread work from it", async () => {
    await project.survey(workspace);
    expect(tool.run({ content: '  A parser, now built with esbuild.\n' }, context())).toBe('The note was updated.');

    // The thread works from what it wrote...
    expect(project.get(workspace, 'thread-1')).toBe('A parser, now built with esbuild.');
    // ...and it survives a restart
    project.init(data);
    expect(project.get(workspace, 'thread-1')).toBe('A parser, now built with esbuild.');
  });

  it("leaves the workspace's own note alone, so other threads are not told what one thread found", async () => {
    await project.survey(workspace);
    tool.run({ content: 'A parser, now built with esbuild.' }, context());
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
    expect(project.get(workspace, 'another-thread')).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('writes the first note for a workspace that has none, without looking at the workspace itself', () => {
    replyWith({ type: 'error', code: 'other', message: 'boom' });
    tool.run({ content: 'A parser.' }, context());
    expect(project.get(workspace, 'thread-1')).toBe('A parser.');
    // Nothing was surveyed to write it...
    expect(mocks.stream).not.toHaveBeenCalled();
    // ...and the workspace itself still has no note of its own, so it is still
    // worth looking at for the threads that come after
    expect(project.get(workspace)).toBe('');
    expect(project.due(workspace)).toBe(true);
  });

  it.each([
    ['an empty note', { content: '   ' }, '"content" must be a non-empty string.'],
    ['a note that is not text', { content: 7 }, '"content" must be a non-empty string.'],
    [
      'a note that is too long',
      { content: 'x'.repeat(project.MAX_NOTE_LENGTH + 1) },
      `Keep it under ${project.MAX_NOTE_LENGTH}`,
    ],
  ])('refuses %s, and keeps the note there was', async (_name, input, message) => {
    await project.survey(workspace);
    expect(() => tool.run(input as Record<string, unknown>, context())).toThrow(message);
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('refuses in a thread without a workspace', () => {
    expect(() => tool.run({ content: 'A note.' }, { signal: new AbortController().signal, threadId: 't' })).toThrow(
      'This thread has no workspace to keep a note on.'
    );
  });

  it('registers with the registry it is given', () => {
    const registry = { register: vi.fn() };
    registerContextTools(registry);
    expect(registry.register.mock.calls.map(([t]) => t.name)).toEqual([
      'update_workspace_context',
      'add_to_workspace_context',
    ]);
  });
});

describe('saying when a look begins and ends', () => {
  const seen: [string, boolean][] = [];
  const watch = () => project.onLook((where, going) => seen.push([where, going]));

  beforeEach(() => {
    seen.length = 0;
  });

  it('says so at the start and at the end, whether or not a note came of it', async () => {
    const stop = watch();
    try {
      composes(null);
      explores('A parser.');
      await project.survey(workspace);
      expect(seen).toEqual([
        [workspace, true],
        [workspace, false],
      ]);

      // ...and for a look that wrote nothing, which still started and stopped
      seen.length = 0;
      project.init(data);
      fs.rmSync(path.join(data, 'projects.json'), { force: true });
      project.init(data);
      replyWith({ type: 'error', code: 'other', message: 'boom' });
      await project.survey(workspace);
      expect(seen).toEqual([
        [workspace, true],
        [workspace, false],
      ]);
    } finally {
      stop();
    }
  });

  it('says nothing for a workspace that already has its note', async () => {
    composes(null);
    explores('A parser.');
    await project.survey(workspace);
    const stop = watch();
    try {
      await project.survey(workspace);
      expect(seen).toEqual([]);
    } finally {
      stop();
    }
  });

  it('lists what is being looked at, for a window that has just opened', async () => {
    let carryOn!: () => void;
    const held = new Promise<void>((resolve) => (carryOn = resolve));
    search.run.mockImplementation(async () => {
      await held;
      return 'found';
    });
    script([call('c1', 'search_workspace', { query: 'q' }), done('tool_use')], [text('A parser.'), done()]);
    expect(project.looking()).toEqual([]);
    const begun = project.survey(workspace);
    await vi.waitFor(() => expect(project.looking()).toEqual([workspace]));
    carryOn();
    await begun;
    expect(project.looking()).toEqual([]);
  });

  it('stops listening when the listener says so', async () => {
    watch()();
    composes(null);
    explores('A parser.');
    await project.survey(workspace);
    expect(seen).toEqual([]);
  });
});

describe("looking again at the user's asking", () => {
  it('sends explorers into the parts it picks out, and they write the note too', async () => {
    // The head looks around, hands two areas out, and writes up what comes back
    const queue: ChatEvent[][] = [
      [call('h1', 'list_files', { path: '' }), done('tool_use')],
      [
        call('h2', 'hand_to_subagent', {
          tasks: [
            { name: 'the tests', task: 'Find out how the tests are written and run.', kind: 'explorer' },
            { name: 'the build', task: 'Find out how the project is built and started.', kind: 'explorer' },
          ],
        }),
        done('tool_use'),
      ],
      [call('h3', 'add_to_workspace_context', { content: 'Run it with npm start.' }), done('tool_use')],
      [text('Explored.'), done()],
    ];
    // ...and each explorer writes what it found and reports back
    const sections: Record<string, ChatEvent[][]> = {
      'the tests': [
        [
          call('t1', 'add_to_workspace_context', { content: 'Vitest, one file beside each source file.' }),
          done('tool_use'),
        ],
        [text('The tests are Vitest.'), done()],
      ],
      'the build': [[text('It is built with tsc.'), done()]],
    };
    // Nothing is made of the findings here, so they stand as they were written
    composes(null);
    onStream((request) => {
      if (request.log?.purpose === 'project.condense')
        return composed === null ? [done('end_turn')] : [text(composed), done()];
      const asked = String(request.messages[0]?.content ?? '');
      for (const [name, replies] of Object.entries(sections)) {
        if (asked.includes(name) || asked.includes(name.replace('the ', '')))
          return replies.shift() ?? [text('done'), done()];
      }
      return queue.shift() ?? [text('done'), done()];
    });

    await project.survey(workspace);
    const note = project.get(workspace);
    // The explorers were sent as explorers, each with its own area
    // One explorer per area, however many rounds each of them took
    const sent = requests.filter((request) => String(request.system).startsWith(EXPLORER_PROMPT));
    const asked = [...new Set(sent.map((request) => String(request.messages[0].content)))];
    expect(asked).toEqual([
      expect.stringContaining('how the tests are written and run'),
      expect.stringContaining('how the project is built and started'),
    ]);
    // ...and can send explorers of their own, an area that turns out to be
    // several being split rather than read end to end
    expect(sent[0].tools?.map((tool) => tool.name)).toContain('hand_to_subagent');
    // What all three of them wrote is the note
    expect(note).toContain('Vitest, one file beside each source file.');
    expect(note).toContain('Run it with npm start.');
  });

  it('throws the note away and has an explorer write a new one', async () => {
    composes(null);
    explores('A TypeScript parser.');
    await project.survey(workspace);
    expect(project.get(workspace)).toBe('A TypeScript parser.');

    requests.length = 0;
    explores('A TypeScript parser, built with esbuild.');
    await expect(project.relook(workspace)).resolves.toBe('A TypeScript parser, built with esbuild.');
    expect(project.get(workspace)).toBe('A TypeScript parser, built with esbuild.');
    // A whole look, not a note edited: the explorer went through it again
    expect(requests[0].system).toContain(HEAD_EXPLORER.prompt);
    expect(saved()[workspace]).toMatchObject({ text: 'A TypeScript parser, built with esbuild.' });
  });

  it('tells the threads about the new note, as the first look does', async () => {
    composes(null);
    const told: string[] = [];
    explores('A parser.');
    await project.survey(workspace);
    const stop = project.onSurveyed((_where, note) => told.push(note));
    try {
      explores('A parser, built with esbuild.');
      await project.relook(workspace);
      expect(told).toEqual(['A parser, built with esbuild.']);
    } finally {
      stop();
    }
  });

  it('keeps the note it had when the fresh look comes to nothing', async () => {
    composes(null);
    explores('A TypeScript parser.');
    await project.survey(workspace);

    replyWith({ type: 'error', code: 'other', message: 'boom' });
    await expect(project.relook(workspace)).resolves.toBe('');
    // Out of date is better than gone, and the user asked for a fresh note
    // rather than for the loss of the one they had
    expect(project.get(workspace)).toBe('A TypeScript parser.');
    expect(saved()[workspace]).toMatchObject({ text: 'A TypeScript parser.' });
  });

  it("leaves a thread that has its own copy alone: that copy is the thread's work", async () => {
    composes(null);
    explores('A parser.');
    await project.survey(workspace);
    const [update] = projectTools;
    const inThread = { signal: new AbortController().signal, threadId: 'thread-1', workspace };
    update.run({ content: 'A parser, as this thread has it.' }, inThread);

    explores('A parser, looked at again.');
    await project.relook(workspace);
    expect(project.get(workspace)).toBe('A parser, looked at again.');
    expect(project.get(workspace, 'thread-1')).toBe('A parser, as this thread has it.');
  });

  it('joins a look already going on rather than starting a second', async () => {
    let carryOn!: () => void;
    const held = new Promise<void>((resolve) => (carryOn = resolve));
    search.run.mockImplementation(async () => {
      await held;
      return 'found';
    });
    script([call('c1', 'search_workspace', { query: 'q' }), done('tool_use')], [text('A parser.'), done()]);
    const first = project.survey(workspace);
    await vi.waitFor(() => expect(project.surveying(workspace)).toBe(true));
    const second = project.relook(workspace);
    carryOn();
    await expect(second).resolves.toBe(await first);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });
});

// A note already as short as the model will make it was condensed again on
// every save: the same 2,292 characters against 2,292, twice over, and once
// 2,580 against 2,476 — thirty-five seconds and a job's tokens each time, for
// an answer that could not change (see resistant in src/harness/project.ts)
describe('a note that will not come down', () => {
  const [tool] = projectTools;
  const context = () => ({ signal: new AbortController().signal, threadId: 'thread-1', workspace });
  const jobs = () => requests.filter((request) => request.log?.purpose === 'project.condense');
  // The background job is started without being waited for (see update), so
  // the test waits for it rather than for the save that set it going
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // Over the length that sets a condensing job going, which is what makes one
  // of these saves ask for one at all
  const long = (n: number) => 'x'.repeat(n);

  beforeEach(async () => {
    await project.survey(workspace);
    requests.length = 0;
  });

  it('is asked once, not on every save, while it stays the length it stuck at', async () => {
    // The job writes a note exactly as long as the one it was given
    onStream((request) =>
      request.log?.purpose === 'project.condense' ? [text(long(2292)), done()] : [text('done'), done()]
    );
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(1);
    // The note is kept as it was, being the only one there is
    expect(project.get(workspace, 'thread-1').length).toBe(2292);

    // Saved again at the same length, and at a length between where it stuck
    // and the length that sets a job going
    tool.run({ content: long(2292) }, context());
    await settle();
    tool.run({ content: long(2000) }, context());
    await settle();
    expect(jobs()).toHaveLength(1);
  });

  it('is asked again once the note has grown past where it stuck', async () => {
    onStream((request) =>
      request.log?.purpose === 'project.condense' ? [text(long(2292)), done()] : [text('done'), done()]
    );
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(1);

    tool.run({ content: long(2400) }, context());
    await settle();
    expect(jobs()).toHaveLength(2);
  });

  it('is asked again after one that did come down, there being nothing stuck any more', async () => {
    let reply = 2292;
    onStream((request) =>
      request.log?.purpose === 'project.condense' ? [text(long(reply)), done()] : [text('done'), done()]
    );
    tool.run({ content: long(2292) }, context());
    await settle();
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(1);

    // It grows, the job gets it down, and the note is the shorter one
    reply = 1200;
    tool.run({ content: long(2400) }, context());
    await settle();
    expect(jobs()).toHaveLength(2);
    expect(project.get(workspace, 'thread-1').length).toBe(1200);

    // Nothing is stuck now, so a note back at the old length is asked about
    reply = 2292;
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(3);
  });

  it('is asked again when the job came back with nothing, that being a failure to write', async () => {
    let empty = true;
    onStream((request) =>
      request.log?.purpose === 'project.condense'
        ? empty
          ? [done('end_turn')]
          : [text(long(1200)), done()]
        : [text('done'), done()]
    );
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(1);

    empty = false;
    tool.run({ content: long(2292) }, context());
    await settle();
    expect(jobs()).toHaveLength(2);
    expect(project.get(workspace, 'thread-1').length).toBe(1200);
  });
});

describe('add_to_workspace_context', () => {
  const add = projectTools[1];
  const description = unwrapped(add.description);
  const context = () => ({ signal: new AbortController().signal, threadId: 'thread-1', workspace });

  it('is offered only in a workspace thread, and says it adds rather than replaces', () => {
    expect(add).toMatchObject({ name: 'add_to_workspace_context', needsWorkspace: true });
    expect(add.inputSchema).toMatchObject({ required: ['content'] });
    expect(description).toContain('leaving the rest of it as it is');
    expect(description).toContain('only ever adds, so others can be writing to the note at the same time');
    // Written for whoever reads the note, not for whoever sent the subagent
    expect(description).toContain('stands on its own');
    expect(description).toContain('the moment something belonging in it changes or turns out to be wrong');
  });

  it("adds to the thread's note, keeping what the workspace's said", async () => {
    await project.survey(workspace);
    add.run({ content: 'Built with esbuild.' }, context());
    expect(project.get(workspace, 'thread-1')).toBe('A TypeScript parser, tested with Vitest.\n\nBuilt with esbuild.');
    // The workspace's own note is untouched, as with a replacement
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('keeps every addition when several arrive, which is the point of it', async () => {
    await project.survey(workspace);
    // What several subagents at work at once do (see ../../src/subagents)
    for (const found of ['Built with esbuild.', 'Tests live in tests/.', 'Node 24 is needed.']) {
      add.run({ content: found }, context());
    }
    const note = project.get(workspace, 'thread-1');
    for (const found of ['Built with esbuild.', 'Tests live in tests/.', 'Node 24 is needed.']) {
      expect(note).toContain(found);
    }
    // ...where a replacement would have left only the last
    expect(note.startsWith('A TypeScript parser, tested with Vitest.')).toBe(true);
  });

  it('starts the note off when the workspace has none', () => {
    add.run({ content: 'A parser.' }, context());
    expect(project.get(workspace, 'thread-1')).toBe('A parser.');
  });

  it('is let through over the length a replacement is refused at, and shortened instead', async () => {
    await project.survey(workspace);
    // An explorer cannot write less than it found out, so refusing the write
    // would only lose the finding
    add.run({ content: 'x'.repeat(project.MAX_NOTE_LENGTH + 100) }, context());
    expect(project.get(workspace, 'thread-1').length).toBeGreaterThan(project.MAX_NOTE_LENGTH);
  });

  it.each([
    ['nothing', { content: '   ' }],
    ['something that is not text', { content: 7 }],
  ])('refuses %s, and keeps the note there was', async (_name, input) => {
    await project.survey(workspace);
    expect(() => add.run(input as Record<string, unknown>, context())).toThrow('"content" must be a non-empty string.');
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('refuses in a thread without a workspace', () => {
    expect(() => add.run({ content: 'A note.' }, { signal: new AbortController().signal, threadId: 't' })).toThrow(
      'This thread has no workspace to keep a note on.'
    );
  });
});

describe("a thread's own note", () => {
  const [tool] = projectTools;
  const inThread = (thread: string) => ({ signal: new AbortController().signal, threadId: thread, workspace });

  beforeEach(async () => {
    await project.survey(workspace);
  });

  it("starts as the workspace's, so the thread begins knowing what the workspace knows", () => {
    project.adopt(workspace, 'thread-1');
    expect(project.get(workspace, 'thread-1')).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('is taken only once, so what the thread has written is not lost', () => {
    project.adopt(workspace, 'thread-1');
    tool.run({ content: 'What the thread found out.' }, inThread('thread-1'));
    project.adopt(workspace, 'thread-1');
    expect(project.get(workspace, 'thread-1')).toBe('What the thread found out.');
  });

  it('is nothing to take before the workspace has a note at all', () => {
    project.init(data);
    project.adopt('/projects/fresh', 'thread-1');
    expect(project.get('/projects/fresh', 'thread-1')).toBe('');
  });

  it("goes back over the workspace's when the thread's work is written back", () => {
    project.adopt(workspace, 'thread-1');
    tool.run({ content: 'A parser, now built with esbuild.' }, inThread('thread-1'));
    expect(project.promote(workspace, 'thread-1')).toBe(true);
    expect(project.get(workspace)).toBe('A parser, now built with esbuild.');
    // ...and every other thread reads it from then on
    expect(project.get(workspace, 'another-thread')).toBe('A parser, now built with esbuild.');
  });

  it('has nothing to write back when it says what the workspace already says', () => {
    project.adopt(workspace, 'thread-1');
    expect(project.promote(workspace, 'thread-1')).toBe(false);
  });

  it('has nothing to write back when the thread never had one', () => {
    expect(project.promote(workspace, 'never-opened')).toBe(false);
  });

  it('goes when the thread goes, leaving the workspace its own', () => {
    project.adopt(workspace, 'thread-1');
    tool.run({ content: 'What the thread found out.' }, inThread('thread-1'));
    project.forgetThread('thread-1');
    expect(project.get(workspace, 'thread-1')).toBe('A TypeScript parser, tested with Vitest.');
    expect(project.get(workspace)).toBe('A TypeScript parser, tested with Vitest.');
  });

  it('is kept apart from the notes of other threads in the same workspace', () => {
    project.adopt(workspace, 'one');
    project.adopt(workspace, 'two');
    tool.run({ content: 'What one found.' }, inThread('one'));
    expect(project.get(workspace, 'one')).toBe('What one found.');
    expect(project.get(workspace, 'two')).toBe('A TypeScript parser, tested with Vitest.');
  });
});

describe('prompt', () => {
  it('gives the model the note as something that may be out of date', () => {
    expect(project.prompt('A parser.')).toMatch(/may be out of date[\s\S]*A parser\.$/);
    expect(unwrapped(project.prompt('A parser.'))).not.toContain('update_workspace_context');
  });

  // Said apart from the note rather than inside it, so that the note reads the
  // same in a step that cannot write it (and so that a prompt cache keeps what
  // every step agrees about — see harness/index.plainPrompt)
  it('tells a model that has the tool to keep the note true as it goes, and why', () => {
    const prompt = unwrapped(project.OWN_COPY);
    // Its own to write, which goes back to the workspace with the work
    expect(prompt).toContain('In this thread the note above is yours');
    expect(prompt).toContain('goes back to the workspace when your work does');
    // Written on discovery, not at the end
    expect(prompt).toContain('Keeping it true is part of the work, not an afterthought');
    expect(prompt).toContain('in the same reply');
    expect(prompt).toContain('rather than at the end of the task');
    // The three occasions, each one something to act on
    expect(prompt).toContain('the moment you work out something it does not say');
    expect(prompt).toContain('find it wrong, out of date or vaguer than what you now know');
    expect(prompt).toContain('change the project so that it no longer describes it');
    // ...and a test to judge it by
    expect(prompt).toContain('would be misled or would have to find out again');
    // The note itself is not repeated here: it is above, and it ends the
    // block it belongs to (see the test before this one)
    expect(prompt).not.toContain('A parser.');
    expect(project.prompt('A parser.').endsWith('A parser.')).toBe(true);
  });
});
