// Judging whether a model writes down what it has just found out.
//
// A thread keeps two notes, and they are all that survives a message. The
// thread's own note (save_context) holds where the work stands and what was
// learned getting there; the workspace keeps what is true of the project for
// whoever works here next — the overview in one note every message carries
// (update_workspace_context), and the particulars one searchable note at a
// time (add_workspace_note). By the following
// message the tool calls and their results are gone, so anything not written
// into one of them is paid for twice: the same search, the same file read, the
// same command run to find out the same thing. That is the thrashing this
// suite is about, and it is invisible in any one reply — a model that looks
// nothing up because it remembered, and one that looks everything up again,
// both answer the question.
//
// So each case puts the model in the middle of a job: the request, the calls it
// has already made, and what came back from them. The last result is the
// discovery. Then one step is read: what the model reaches for next, with every
// tool the app offers available. Writing the note is never the only thing it
// could do — carrying on with the work is right there, and usually quicker,
// which is the pull being measured.
//
// Four things are judged:
//   wrote    whether it wrote a note at all. The one that matters most, and
//            the one case in eight where the answer is no keeps the suite
//            honest: a suite that only rewards writing would be passed by a
//            model that writes after every tool call, which is its own kind
//            of useless
//   where    which note. Task state in the workspace note misleads every
//            later thread in that workspace; a project fact in the thread note
//            dies with the thread. Some findings are claimed by both prompts
//            ("something you tried that does not work"), and those cases
//            accept either
//   keeps    whether what it wrote actually names the thing it just learned.
//            A note saying "investigated the test setup" costs a tool call and
//            saves nobody anything
//   whole    for a note replaced rather than added to: whether what the note
//            already said survived. The replacing tool is how the note gets
//            lost, and a model that loses it has made the workspace worse
//
// One step is read, not the whole reply, because both prompts say to write the
// moment there is something to write. A model that means to save at the end is
// a model that often never does: by then the results it meant to write down
// are not in front of it any more.

import * as llm from '../src/llm';
import * as project from '../src/harness/project';
import * as sandbox from '../src/sandbox';
import * as tools from '../src/tools';
import type { ChatMessage, ModelInfo, ToolCall } from '../src/types';
import { oneOf, type Case, type Mark, type Suite } from './harness';
import { configure } from './judges';

const FOLDER = '/projects/demo';

// Which note a write went to. The workspace has three tools: two that write
// the one note every message there carries, one replacing it and one adding a
// line to it, and one that writes a note of its own into the searchable
// collection behind it (see ../src/harness/notes.ts). For what is judged here
// they are the same act — the finding went to the project rather than dying
// with the thread, which is the distinction this suite is about.
type Where = 'thread' | 'workspace';
const WHERE: Record<string, Where> = {
  save_context: 'thread',
  add_to_context: 'thread',
  update_workspace_context: 'workspace',
  add_to_workspace_context: 'workspace',
  add_workspace_note: 'workspace',
};

// One call the model has already made, and what came back from it
interface Step {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError?: boolean;
}

export interface Input {
  // What the user asked for
  request: string;
  // What it has already done, oldest first. The last result is the discovery.
  found: Step[];
  // What the workspace's note says already
  note?: string;
}

export interface Expected {
  // Whether there is anything here worth writing down
  write: boolean;
  // Which notes it is right to have written, as 'thread', 'workspace' or
  // 'thread+workspace'
  where?: readonly string[];
  // What the writing has to name, each as the spellings that would do
  keeps?: readonly (readonly string[])[];
  // A phrase of the note as it stands that must still be there afterwards,
  // for a case whose note is replaced rather than added to
  whole?: string;
}

export interface Output {
  // The notes it wrote, in the order it wrote them
  wrote: { where: Where; tool: string; content: string }[];
  // What else it called, for the report to say what it did instead
  did: string[];
  // Whether it wrote to the user rather than calling anything
  answered: boolean;
  // Why there is nothing to judge: the model failed outright
  why?: string;
}

// What a thread in this workspace has been told about it already. Every case
// runs in a surveyed workspace: a model that has been given the layout is one
// whose findings are its own, rather than the first look at the project.
const NOTE = `It is a TypeScript Electron app, built with tsc and tested with vitest.
  src/main.ts        starts the app and owns the window
  src/harness/       the reply loop and the prompts it uses
  src/llm/           the providers, and which model answers
  src/renderer.ts    the window's own code
  src/sandbox/       the Docker container each thread works in
  src/search/        the embeddings, and ripgrep behind them
  tests/             one file beside each source file`;

// ...and the same note gone stale, for the case about putting it right
const STALE = `${NOTE}

Search is provided by a separate indexing server, which has to be installed
with pipx before the app will index anything.`;

function one(
  name: string,
  request: string,
  found: Step[],
  expected: Expected,
  extra: { note?: string; ambiguous?: string } = {}
): Case<Input, Output> {
  return {
    name,
    input: { request, found, note: extra.note },
    ambiguous: extra.ambiguous,
    grade: (got) => grade(got, expected),
  };
}

// Whether every spelling group is named somewhere in what was written
export function missing(content: string, keeps: readonly (readonly string[])[]): string[] {
  const text = content.toLowerCase();
  return keeps
    .filter((spellings) => !spellings.some((word) => text.includes(word.toLowerCase())))
    .map((spellings) => spellings[0]);
}

export function grade(got: Output, expected: Expected): Mark[] {
  if (got.why) {
    return [{ field: 'wrote', wanted: expected.write ? 'a note' : 'no note', got: got.why, ok: false }];
  }
  // What it did instead, which is the interesting half of a miss
  const instead = got.did.length > 0 ? `ran ${got.did.join(', ')}` : got.answered ? 'answered' : 'did nothing';
  const marks: Mark[] = [
    {
      field: 'wrote',
      wanted: expected.write ? 'a note' : 'no note',
      got: got.wrote.length > 0 ? got.wrote.map((w) => w.tool).join(', ') : `nothing, ${instead}`,
      ok: got.wrote.length > 0 === expected.write,
    },
  ];
  if (!expected.write) return marks;

  const written = [...new Set(got.wrote.map((w) => w.where))].sort().join('+');
  marks.push(oneOf('where', expected.where ?? ['thread'], written || 'nothing'));

  const content = got.wrote.map((w) => w.content).join('\n\n');
  if (expected.keeps) {
    const absent = missing(content, expected.keeps);
    marks.push({
      field: 'keeps',
      wanted: `names ${expected.keeps.map((spellings) => spellings[0]).join(', ')}`,
      got: absent.length === 0 ? 'all of them' : `no mention of ${absent.join(', ')}`,
      ok: absent.length === 0,
    });
  }
  // Only the replacing tool can lose what the note said
  const replaced = got.wrote.filter((w) => w.tool === 'update_workspace_context');
  if (expected.whole && replaced.length > 0) {
    const kept = replaced.some((w) => w.content.includes(expected.whole as string));
    marks.push({
      field: 'whole',
      wanted: `keeps "${expected.whole}"`,
      got: kept ? 'kept it' : 'wrote the note without it',
      ok: kept,
    });
  }
  return marks;
}

const ran = (command: string, output: string, isError = false): Step => ({
  name: 'run_command',
  input: { command },
  output,
  isError,
});
const read = (path: string, output: string): Step => ({ name: 'read_file', input: { path }, output });
const edited = (path: string, output: string): Step => ({ name: 'edit_file', input: { path, old_text: '…' }, output });

export const cases: Case<Input, Output>[] = [
  // ---- The thread's own note: where the work stands, and what this job has
  // cost to find out. None of it is true of the project, so none of it belongs
  // in the workspace's note.
  one(
    'thread: how far through a long job it is',
    'switch every call of log() over to the new (event, fields) signature',
    [
      ran(
        "grep -rln 'log(' src",
        [
          'src/harness/index.ts',
          'src/llm/index.ts',
          'src/main.ts',
          'src/sandbox/docker.ts',
          'src/search/index.ts',
        ].join('\n')
      ),
      edited('src/main.ts', 'Edited src/main.ts in 4 places'),
      edited('src/llm/index.ts', 'Edited src/llm/index.ts in 6 places'),
    ],
    {
      write: true,
      where: ['thread'],
      // The ones left, which is the whole use of the note here
      keeps: [['src/search/index.ts'], ['src/sandbox/docker.ts'], ['src/main.ts']],
    }
  ),
  one(
    'thread: a dead end, so it is not tried twice',
    'the search endpoint takes four seconds on a cold cache; find out why and make it faster',
    [
      ran('npm run bench -- search', 'cold 4.10s   warm 0.08s'),
      edited('src/search/embeddings.ts', 'Edited src/search/embeddings.ts in 1 place'),
      ran('npm run bench -- search', 'cold 4.05s   warm 0.08s'),
    ],
    {
      write: true,
      // Both prompts claim a thing that did not work, so either note is a fair
      // place for it; what matters is that it is written down at all
      where: ['thread', 'thread+workspace'],
      keeps: [
        ['batch', 'embedding'],
        ['4.0', '4.1', 'no change', 'nothing'],
      ],
    }
  ),
  one(
    'thread: what is left of it, and the test it has just broken',
    'give the three dialogs in the renderer one shared close button',
    [
      ran(
        "grep -n 'dialog-close' index.html",
        [
          '31:        <button id="workspace-dialog-close">Close</button>',
          '58:        <button id="thread-dialog-close">Close</button>',
          '72:        <button id="subagent-dialog-close">Close</button>',
        ].join('\n')
      ),
      edited('index.html', 'Edited index.html in 1 place'),
      ran(
        'npx vitest run tests/renderer.test.ts',
        'Tests  2 failed | 318 passed (320)\n' +
          '  × closes the workspace dialog on Escape\n' +
          '  × says display: none for every hidden element it gives a display to'
      ),
    ],
    {
      write: true,
      where: ['thread'],
      // Two dialogs still to do, and two tests it has just broken: everything
      // the next message needs and nothing anyone else does
      keeps: [
        ['subagent-dialog-close', 'subagent'],
        ['renderer.test.ts', 'display: none', 'hidden', 'escape'],
      ],
    }
  ),

  // ---- The workspace's note: what anyone working here would otherwise have
  // to find out for themselves, which is exactly what it is for
  one(
    'workspace: the command that actually works',
    'run the test suite and tell me what fails',
    [
      ran('npm test', '> vitest run\n\nsh: 1: vitest: not found\n\nexit code 127', true),
      ran('ls node_modules', 'ls: cannot access node_modules: No such file or directory', true),
      ran('npm ci', 'added 412 packages in 31s'),
      ran('npm test', 'Test Files  41 passed (41)\n     Tests  1352 passed (1352)'),
    ],
    {
      write: true,
      where: ['workspace', 'thread+workspace'],
      keeps: [
        ['npm ci', 'npm install'],
        ['npm test', 'vitest'],
      ],
    }
  ),
  one(
    'workspace: where a kind of thing lives',
    'where are the tools the model can call defined?',
    [
      ran('ls src/tools', 'context.ts\nindex.ts\nlist.ts\nreview.ts\nsandbox.ts\nsearch.ts\nsubagents.ts'),
      read(
        'src/tools/index.ts',
        'export const all: Tool[] = [...sandboxTools, ...searchTools, ...contextTools];\n' +
          'export function registerAll(registry: Registry) { for (const tool of all) registry.register(tool); }'
      ),
    ],
    {
      write: true,
      where: ['workspace', 'thread+workspace'],
      keeps: [['src/tools'], ['index.ts', 'registerAll', 'all']],
    }
  ),
  one(
    'workspace: a trap anyone here would fall into',
    'add a helper to the renderer that diffs two blocks of text, and use it in the changes dialog',
    [
      read(
        'src/renderer.ts',
        "// The window's UI. Loaded by index.html as a plain script, so it has no\n" +
          '// imports; it talks to the main process through the bridges in preload.ts.'
      ),
      ran("grep -c '^export' src/renderer.ts", '0'),
      ran(
        'npm run build && grep -n exports dist/renderer.js',
        '1:Object.defineProperty(exports, "__esModule", { value: true });'
      ),
    ],
    {
      write: true,
      where: ['workspace', 'thread+workspace'],
      keeps: [['export'], ['renderer.ts'], ['script', 'commonjs', 'module']],
    }
  ),
  one(
    'workspace: the note is wrong, and saying so is the work',
    'index this workspace for search and tell me it worked',
    [
      ran('ls src/search', 'chunks.ts\nembeddings.ts\nenv.ts\nindex.ts\nresults.ts\nripgrep.ts'),
      ran('pipx list', 'pipx: command not found', true),
      read(
        'src/search/embeddings.ts',
        '// The app embeds the workspace itself with a local model and keeps the\n' +
          '// vectors in the user data directory. No server, nothing to install.'
      ),
    ],
    {
      write: true,
      where: ['workspace', 'thread+workspace'],
      keeps: [['embedding']],
      // Replacing the note must not cost the workspace what it already said
      whole: 'src/main.ts',
    },
    { note: STALE }
  ),

  // ---- And the other way: a job that taught nobody anything. Written up, it
  // is a line of noise in a note that is read at the start of every message,
  // and the next thing worth keeping is that much harder to see.
  one(
    'nothing was found out, so there is nothing to write',
    'delete src/old-helper.ts, it is dead code',
    [ran("grep -rn 'old-helper' src tests", 'no matches'), ran('rm src/old-helper.ts', '')],
    { write: false }
  ),
];

// What the model is working under: what the app really tells a thread in a
// workspace about its two notes, and nothing else. The task and format prompts
// say nothing about notes, so leaving them out keeps the suite judging the one
// thing it is for.
export function systemPrompt(note: string): string {
  return [
    'You are answering a request in a chat application. You have tools available.',
    sandbox.PROMPT,
    sandbox.workspacePrompt(FOLDER),
    project.prompt(note),
    project.OWN_COPY,
  ].join('\n\n');
}

// The work so far, as the model would be holding it: the request, each call it
// made, and what came back
export function history({ request, found }: Input): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'user', content: request }];
  found.forEach((step, i) => {
    const id = `c${i + 1}`;
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: step.name, input: step.input }] });
    messages.push({
      role: 'tool',
      toolCallId: id,
      name: step.name,
      content: step.output,
      isError: Boolean(step.isError),
    });
  });
  return messages;
}

// What the model did with its next step: which notes it wrote, and what else
// it reached for
export function written(calls: ToolCall[], text: string): Output {
  const wrote = calls.flatMap((call) => {
    const where = WHERE[call.name];
    if (!where) return [];
    const given = call.input as { content?: unknown; subject?: unknown } | null;
    const content = typeof given?.content === 'string' ? given.content : '';
    // A note with a subject may name what it is about there rather than in its
    // body, and what is judged is whether the finding was written down at all
    const subject = typeof given?.subject === 'string' ? given.subject : '';
    return [{ where, tool: call.name, content: subject ? `${subject}\n\n${content}` : content }];
  });
  return {
    wrote,
    did: calls.filter((call) => !WHERE[call.name]).map((call) => call.name),
    answered: Boolean(text.trim()),
  };
}

export const suite: Suite<Input, Output> = {
  name: 'context',
  about: 'whether it writes down what it just found out, and in the right note',
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
    // Every tool the app offers in a workspace thread, so that writing the
    // note is one thing it could do among many rather than the only one. A
    // model given the note tools alone writes a note every time, which would
    // measure the tool list and not the judgement.
    const offer = tools.all
      .filter((tool) => !tool.needsReview)
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

    return {
      model: chosen.id,
      async run(input: Input): Promise<Output> {
        const calls: ToolCall[] = [];
        let text = '';
        let failure = '';
        const events = llm.stream(
          {
            provider: chosen.provider,
            model: chosen.id,
            system: systemPrompt(input.note ?? NOTE),
            messages: history(input),
            tools: offer,
            log: { purpose: 'eval.context' },
          },
          AbortSignal.timeout(300000)
        );
        for await (const event of events) {
          if (event.type === 'text') text += event.delta;
          if (event.type === 'tool_call') calls.push({ id: event.id, name: event.name, input: event.input });
          if (event.type === 'error') failure = event.message;
        }
        if (failure) return { wrote: [], did: [], answered: false, why: failure };
        return written(calls, text);
      },
    };
  },

  cases,
};
