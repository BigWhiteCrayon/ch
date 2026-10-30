// Judging whether an agent writes down what it finds out as it works.
//
// Everything a tool returns is in context for the rest of the message and gone
// by the next one: the renderer sends on the conversation alone (see
// renderer.conversation), so the thread's context note and the files are the
// only things that outlive a reply. An agent that finds out where something
// lives, what is really causing a bug, or which command actually works, and
// does not write it down, pays for it again next message — and the user pays
// twice for the same tool calls.
//
// This is not evals/context.ts. That one reads a single step: the work is handed
// to the model already done, and what is judged is the one move it makes next.
// This one runs the whole loop. The model searches, reads and runs commands
// against a scripted workspace, for as many rounds as it wants, and what is
// judged is the shape of the run: whether notes were written at all, whether
// they were written as the work went or saved up for the end, whether they name
// what was found, and whether writing one lost what the last one said.
//
// Four things are judged:
//   wrote    whether anything was written down. The floor: a run that finds
//            three things and writes none has to be done again
//   asFound  whether a note was written before the last step. Both prompts say
//            to write the moment there is something to write, and a model that
//            means to write at the end is a model that often never does: by
//            then the results it meant to write about are behind it
//   keeps    whether the notes name what was actually found — the path, the
//            cause, the command and its flags. "Investigated the test setup"
//            costs a tool call and saves nobody anything
//   kept     whether writing a note lost what an earlier one said. The thread
//            note's only writer replaced the whole note, so every save risked
//            everything in it; this is the field that says whether that is
//            happening
//
// The world the model works in is scripted: a search that always answers, files
// that can be read, commands with fixed output. Nothing is in a container, so
// the suite costs no Docker and the same run happens every time — only the model
// varies, which is the point.

import * as llm from '../src/llm';
import * as log from '../src/log';
import { setAside } from '../src/harness/index';
import * as project from '../src/harness/project';
import * as sandbox from '../src/sandbox';
import * as tools from '../src/tools';
import type { ChatMessage, ModelInfo, ToolCall } from '../src/types';
import { within, type Case, type Mark, type Suite } from './harness';
import { configure } from './judges';

const WORKSPACE = '/projects/demo';
// Rounds the model is given. Enough for a search, three or four reads and a
// command, with room to write notes along the way.
const MAX_STEPS = 8;

// Every tool that writes to the thread's own note, under whatever name it goes
// by. Named here rather than imported so that the suite measures the same thing
// before and after a tool is added.
export const NOTE_TOOLS = new Set(['save_context', 'add_to_context']);
// ...and the ones that write the workspace's note, which is a different note for
// a different purpose: findings about the project, not about this piece of work.
// Written to the same field here, since either is a model writing something down.
export const WORKSPACE_NOTE_TOOLS = new Set(['update_workspace_context', 'add_to_workspace_context']);

// What the model can find out, if it looks. A world is its files and its
// commands; the search is worked out from the files rather than fixed, so that
// asking a better question gets a better answer — a search that returns the same
// block whatever it is asked teaches a model that searching is pointless, and
// what then gets measured is the fixture.
export interface World {
  // What read_file can return, by path
  files: Record<string, string>;
  // What a command prints: the first entry the command contains the text of
  commands: { when: string; output: string; isError?: boolean }[];
}

// Words worth matching on: the short ones match everything and tell nothing
const words = (query: string) =>
  query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((word) => word.length > 3);

// What search_workspace answers: the files whose path or lines the query's own
// words appear in, likeliest first, with the lines they matched. The same shape
// the real search answers in (see src/tools/search.ts).
export function searchWorld(query: string, files: Record<string, string>): string {
  const asked = words(query);
  const scored = Object.entries(files)
    .map(([path, text]) => {
      const lines = text.split('\n');
      const hits = lines.filter((line) => asked.some((word) => line.toLowerCase().includes(word)));
      const inPath = asked.filter((word) => path.toLowerCase().includes(word)).length;
      // A file that matched on its path alone is shown from its first line
      // rather than with nothing under it, as the real search is (see
      // src/search/embeddings.pick)
      const shown = hits.length > 0 ? hits.slice(0, 3) : lines.slice(0, 1);
      return { path, hits: shown, score: hits.length + inPath * 2 };
    })
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (scored.length === 0) return 'No matches.';
  return scored.map((one) => [one.path, ...one.hits.map((line) => `  ${line}`)].join('\n')).join('\n\n');
}

export interface Input {
  request: string;
  world: World;
}

export interface Expected {
  // What the notes have to name, each as the spellings that would do
  keeps: readonly (readonly string[])[];
  // How many of the run's steps should have written a note, as a range: a run
  // that writes after every single call is as wrong as one that never writes
  notes: readonly [number, number];
}

// One note, and when it was written
export interface Written {
  tool: string;
  content: string;
  // The step it was written on, counting from 1
  step: number;
}

export interface Output {
  wrote: Written[];
  // What it called, step by step, for the report to say what it did instead
  steps: string[][];
  // Whether it stopped and answered rather than running out of rounds
  answered: boolean;
  why?: string;
}

// The system prompt the app really builds for a workspace thread, so that what
// is judged is the app's own wording and not a copy of it
export function systemPrompt(note: string): string {
  return [
    'You are answering a request in a chat application. You have tools available.',
    sandbox.PROMPT,
    sandbox.workspacePrompt(WORKSPACE),
    project.prompt(note),
    project.OWN_COPY,
  ].join('\n\n');
}

// What the workspace note says before the run: enough that the model is not
// discovering the project from nothing, so what it finds is its own
export const NOTE = `It is a TypeScript Electron app, built with tsc and tested with vitest.
  src/harness/   the reply loop and the prompts it uses
  src/llm/       the providers, and which model answers
  src/search/    the embeddings, and ripgrep behind them
  tests/         one file beside each source file`;

// What a tool call gets back from the scripted world
export function answer(call: ToolCall, world: World): { output: string; isError: boolean } {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  if (call.name === 'search_workspace') {
    return { output: searchWorld(text('query'), world.files), isError: false };
  }
  if (call.name === 'list_workspace' || call.name === 'list_files') {
    const under = text('path');
    const paths = Object.keys(world.files).filter((path) => !under || path.startsWith(under));
    return { output: paths.join('\n') || 'Nothing there.', isError: false };
  }
  if (call.name === 'read_file') {
    const path = text('path');
    const file = world.files[path];
    return file === undefined
      ? { output: `cat: ${path}: No such file or directory`, isError: true }
      : { output: file, isError: false };
  }
  if (call.name === 'run_command') {
    const command = text('command');
    const match = world.commands.find((one) => command.includes(one.when));
    return match
      ? { output: match.output, isError: Boolean(match.isError) }
      : { output: `sh: ${command.split(' ')[0]}: command not found`, isError: true };
  }
  if (NOTE_TOOLS.has(call.name)) return { output: 'Context saved.', isError: false };
  if (WORKSPACE_NOTE_TOOLS.has(call.name)) return { output: 'The note was updated.', isError: false };
  // Writing to files, and anything else it reaches for: let it believe it worked
  return { output: 'Done.', isError: false };
}

// Whether every spelling group is named somewhere in what was written
export function missing(content: string, keeps: readonly (readonly string[])[]): string[] {
  const text = content.toLowerCase();
  return keeps
    .filter((spellings) => !spellings.some((word) => text.includes(word.toLowerCase())))
    .map((spellings) => spellings[0]);
}

// Whether a later note kept what an earlier one said. Judged on the lines of
// the earlier note: a note rewritten from scratch loses them, one added to does
// not. Only the notes that replace the whole thing can lose anything.
export function lost(wrote: Written[]): string[] {
  const gone: string[] = [];
  for (let at = 1; at < wrote.length; at++) {
    const before = wrote[at - 1];
    const after = wrote[at];
    // An append says nothing about what the note held, so there is nothing to
    // have lost
    if (after.tool !== 'save_context' && after.tool !== 'update_workspace_context') continue;
    for (const line of before.content.split('\n').map((l) => l.trim())) {
      // Short lines are headings and bullets, which a rewrite may fairly reword
      if (line.length < 25) continue;
      if (!after.content.includes(line)) gone.push(line);
    }
  }
  return gone;
}

export function grade(got: Output, expected: Expected): Mark[] {
  if (got.why) return [{ field: 'wrote', wanted: 'notes', got: got.why, ok: false }];
  const did = got.steps.map((names) => names.join('+')).join(' → ') || 'nothing';
  const marks: Mark[] = [
    {
      field: 'wrote',
      wanted: 'something written down',
      got: got.wrote.length > 0 ? `${got.wrote.length} note(s)` : `nothing, did ${did}`,
      ok: got.wrote.length > 0,
    },
  ];
  if (got.wrote.length === 0) return marks;

  // Written as the work went, rather than saved for the end. The last step is
  // where a model that means to write at the end writes.
  const lastStep = got.steps.length;
  const early = got.wrote.filter((one) => one.step < lastStep);
  marks.push({
    field: 'asFound',
    wanted: 'a note before the last step',
    got: early.length > 0 ? `on step ${early.map((one) => one.step).join(', ')}` : `only on the last (${lastStep})`,
    ok: early.length > 0,
  });

  const content = got.wrote.map((one) => one.content).join('\n\n');
  const absent = missing(content, expected.keeps);
  marks.push({
    field: 'keeps',
    wanted: `names ${expected.keeps.map((spellings) => spellings[0]).join(', ')}`,
    got: absent.length === 0 ? 'all of them' : `no mention of ${absent.join(', ')}`,
    ok: absent.length === 0,
  });

  const gone = lost(got.wrote);
  marks.push({
    field: 'kept',
    wanted: 'nothing lost from an earlier note',
    got: gone.length === 0 ? 'nothing lost' : `${gone.length} line(s) dropped: ${gone[0].slice(0, 60)}`,
    ok: gone.length === 0,
  });

  marks.push(within('notes', expected.notes, new Set(got.wrote.map((one) => one.step)).size));
  return marks;
}

function one(name: string, request: string, world: World, expected: Expected, ambiguous?: string): Graded {
  return { name, input: { request, world }, ambiguous, expected, grade: (got) => grade(got, expected) };
}

// A case with what it expects kept on it, so a test can check the world really
// holds what the case says must be found in it
export type Graded = Case<Input, Output> & { expected: Expected };

// ---- The worlds. Each holds a few things that cost a tool call to find out
// and are worth writing down, among a project large enough that the model has to
// look for them: a world of four files is exhausted in one round, and what gets
// measured then is the fixture rather than the model.

// The files every world has, which hold nothing any case is about. They are here
// so that a search has to choose and a listing is not the answer by itself.
const BACKGROUND: Record<string, string> = Object.fromEntries(
  [
    ['src/main.ts', 'starts the app and owns the window'],
    ['src/renderer.ts', "the window's own code, and every dialog in it"],
    ['src/settings.ts', 'the encrypted settings store: API keys and model choice'],
    ['src/llm/index.ts', 'the provider registry and the queue local models wait in'],
    ['src/llm/router.ts', 'which model answers a message, given how hard it is'],
    ['src/harness/index.ts', 'the reply loop: classify, route, call tools, answer'],
    ['src/harness/classifier.ts', 'sizes up each message before it is answered'],
    ['src/sandbox/docker.ts', "each thread's own container, and its lifecycle"],
    ['tests/helpers.ts', 'what the tests share: fakes for Docker and the providers'],
  ].map(([path, what]) => [
    path,
    [`1: // ${what}`, '2:', '3: import type { Thing } from "../types";', '4:', '5: export function thing() {}'].join(
      '\n'
    ),
  ])
);

const world = (files: Record<string, string>, commands: World['commands'] = []): World => ({
  files: { ...BACKGROUND, ...files },
  commands,
});

export const cases: Graded[] = [
  // ---- A cause that takes three steps to find. The cause is the whole value
  // of the run, and it is the thing most easily lost.
  one(
    'a cause found partway through a run',
    'search results sometimes come back as line numbers with no code. Find out why and fix it',
    world(
      {
        'src/search/embeddings.ts': [
          '619: // Which lines of a piece to show.',
          '620: export function pick(hit: Hit, query: string, context: number) {',
          '621:   const all = hit.text.split("\\n");',
          '622:   if (all.length === 0) return [];',
          '623:   // ... chooses the likeliest line ...',
          '624:   return all.slice(from, to).map((line, i) => ({ line: hit.start + from + i, text: line }));',
          '625: }',
        ].join('\n'),
        'src/search/results.ts': '43: export function mergeBlocks(blocks: Block[]): Block[] {',
      },
      [
        {
          when: 'vitest',
          output: [
            'FAIL tests/search/embeddings.test.ts > pick',
            "AssertionError: expected [ { line: 10, text: '' } ] to deeply equal []",
            'The guard on line 622 never fires: "".split("\\n") is [""], not [].',
          ].join('\n'),
          isError: true,
        },
      ]
    ),
    {
      keeps: [['src/search/embeddings.ts'], ['pick'], ['622', 'never fires', 'split']],
      notes: [1, 4],
    }
  ),

  // ---- Something that does not work. The next message would try it again.
  one(
    'a dead end, so it is not tried twice',
    'the search index takes four seconds to build on a cold start; make it faster',
    world(
      {
        'src/search/embeddings.ts': '200: export async function index(workspace: string) { /* embeds every chunk */ }',
      },
      [
        { when: 'bench', output: 'cold 4.10s   warm 0.08s' },
        {
          when: 'test',
          output: 'All 1491 tests pass. Batching the embed calls changed nothing: cold 4.05s, still four seconds.',
        },
      ]
    ),
    {
      keeps: [
        ['batch', 'batching'],
        ['4.0', '4.1', 'changed nothing', 'no difference'],
      ],
      notes: [1, 4],
    }
  ),

  // ---- A fact about the machine, not the project: the command that works.
  // Cheap to write down, and expensive to find twice.
  one(
    'the command that actually works, after the obvious one fails',
    'run the test suite and tell me what is failing',
    world({ 'package.json': '{ "scripts": { "test": "vitest run" } }' }, [
      { when: 'npm test', output: 'sh: vitest: command not found', isError: true },
      { when: 'npm ci', output: 'added 412 packages in 31s' },
      {
        when: 'npx vitest',
        output: 'Test Files  1 failed | 44 passed (45)\nTests  3 failed | 1491 passed (1494)',
      },
    ]),
    {
      keeps: [
        ['npx vitest', 'npm ci'],
        ['3 failed', '3'],
      ],
      notes: [1, 4],
    }
  ),

  // ---- Four files, one fact in each. A note written once at the end holds the
  // last of them; a note added to as it goes holds all four.
  one(
    'a trail of facts, one file at a time',
    'write up how a search request travels through the code, from the tool call to the lines that come back',
    world(
      {
        'src/tools/search.ts': '18: // The tool trims every answer to the limits here, whichever backend answered.',
        'src/search/embeddings.ts': '560: // rank() narrows by path before anything is read from the container.',
        'src/search/results.ts': '35: // mergeBlocks joins runs that overlap, so no line is shown twice.',
        'src/search/ripgrep.ts': '74: // The fallback answers with paths alone when the embeddings cannot.',
      },
      []
    ),
    {
      keeps: [
        ['src/tools/search.ts', 'trims'],
        ['rank', 'narrows by path'],
        ['mergeblocks', 'overlap'],
        ['ripgrep', 'fallback'],
      ],
      // Four facts in four files: writing them down as it goes is the behaviour
      notes: [2, 5],
    }
  ),
];

export const suite: Suite<Input, Output> = {
  name: 'notes',
  about: 'whether an agent writes down what it finds out, as it finds it',
  perModel: true,

  async setUp({ model: wanted }) {
    configure();
    const { models, providers } = await llm.listModels({ fresh: true });
    const offered: ModelInfo[] = wanted
      ? models.filter((m) => m.id === wanted)
      : [...models].sort((a, b) => b.sophistication - a.sophistication).slice(0, 1);
    if (offered.length === 0) {
      const trouble = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
      throw new Error(
        [wanted ? `No model called "${wanted}".` : 'No models available.', ...trouble].join('\n') +
          `\nModels there are: ${models.map((m) => m.id).join(', ') || 'none'}`
      );
    }
    const [chosen] = offered;
    // Every tool a workspace thread is offered, so that writing a note is one
    // thing among many rather than the only thing it could do
    const offer = tools.all
      .filter((tool) => !tool.needsReview)
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

    return {
      model: chosen.id,
      async run(input: Input): Promise<Output> {
        const messages: ChatMessage[] = [{ role: 'user', content: input.request }];
        const wrote: Written[] = [];
        const steps: string[][] = [];
        let answered = false;

        for (let step = 1; step <= MAX_STEPS; step++) {
          const calls: ToolCall[] = [];
          let text = '';
          let failure = '';
          const events = llm.stream(
            {
              provider: chosen.provider,
              model: chosen.id,
              system: systemPrompt(NOTE),
              messages,
              tools: offer,
              log: { purpose: 'eval.notes', step },
            },
            AbortSignal.timeout(300_000)
          );
          for await (const event of events) {
            if (event.type === 'text') text += event.delta;
            if (event.type === 'tool_call') calls.push({ id: event.id, name: event.name, input: event.input });
            if (event.type === 'error') failure = event.message;
          }
          // Nothing to judge if it never got going; a failure partway through
          // leaves what it had already written
          if (failure) {
            if (step === 1) return { wrote, steps, answered, why: failure };
            break;
          }
          if (calls.length === 0) {
            answered = true;
            log.debug('eval.answered', { suite: 'notes', step, chars: text.length });
            break;
          }
          steps.push(calls.map((call) => call.name));
          messages.push({ role: 'assistant', content: text, toolCalls: calls });
          for (const call of calls) {
            const content = (call.input as { content?: unknown } | null)?.content;
            if (NOTE_TOOLS.has(call.name) || WORKSPACE_NOTE_TOOLS.has(call.name)) {
              wrote.push({ tool: call.name, content: typeof content === 'string' ? content : '', step });
            }
            const { output, isError } = answer(call, input.world);
            // What the model asked the world for and what the world told it.
            // Without this a run can only be read back as a list of tool names,
            // which does not say whether the world was any use to it: a shelf
            // of `command not found` reads exactly like work.
            log.debug('eval.tool', {
              suite: 'notes',
              step,
              tool: call.name,
              input: call.input,
              ok: !isError,
              output,
            });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output, isError });
          }
          // The model sees its latest results and what it wrote about the rest.
          // Kept on here although the app has it off for now (see SETTING_ASIDE
          // in ../src/harness/index.ts): this suite is what measured the
          // behaviour and what has to be run again before it goes back on.
          setAside(messages, 1);
        }
        return { wrote, steps, answered };
      },
    };
  },

  cases,
};

// What the suite is built on, so a test can check it against the real thing
export const USES = { MAX_STEPS };
