// Judging how a model breaks a job into pieces for subagents (see
// ../src/subagents).
//
// A capable model answering a big request is told to look at the whole of it,
// work out which parts do not depend on each other, and hand those out with
// hand_to_subagent while keeping the rest for itself (see BREAK_UP in
// ../src/subagents/index.ts). Whether it does that well is not visible in any one
// reply: a model that splits nothing is merely slow, and one that splits
// everything produces subagents that undo each other's work or come back
// unable to do what they were asked. Both look like an ordinary answer.
//
// So what is judged here is the breakdown itself, not what the subagents make
// of it. The model is given the request and every tool the app offers, and
// what it reaches for is read rather than run: no containers are started and
// nothing is written. The whole tool list matters. Offered hand_to_subagent
// alone, a model has no other way to act, and every model hands out
// everything; offered the real list, choosing to read a file instead is the
// judgement this suite is about. Five things are judged:
//
//   split       whether it handed anything out at all. The most important of
//               them: half the cases are jobs that should stay whole
//   tasks       how many pieces, as a range - nobody can say whether a job is
//               three pieces or four, but "not one, not ten" is clear
//   kinds       whether each piece went to a kind that can do it
//   standalone  whether a piece reads as work someone could pick up knowing
//               nothing else. A subagent cannot see the conversation, so a
//               task that points back at it ("as discussed above") is one the
//               subagent cannot carry out
//   distinct    whether two pieces were given the same file to change, which
//               is the failure that loses work rather than merely wasting it
//
// This suite asks a strong model to plan, so it is slower than the others: a
// local 9B takes a minute or two per case. It is not run as often, and it is
// the breakdown that is slow to produce, not the judging.

import * as llm from '../src/llm';
import * as subagents from '../src/subagents';
import { SOPHISTICATION } from '../src/llm/sophistication';
import * as tools from '../src/tools';
import type { ChatMessage, ModelInfo, ToolCall } from '../src/types';
import { within, type Case, type Mark, type Suite } from './harness';
import { configure } from './judges';

interface Input {
  // What the user asked for
  request: string;
  // Set for a thread started in a workspace, where there are files to look at
  workspace?: boolean;
}

// What a thread in a surveyed workspace already knows about it (see
// ../src/harness/project.ts). Without it the first move on any workspace
// request is to look around, and rightly so - the app's own prompt says to
// search and read before replying - which leaves nothing to hand out and no
// judgement to measure. A model that has been given the layout can tell
// whether the job divides.
const NOTE = `A note on this workspace, from an earlier look at it:

It is a TypeScript Electron app, built with tsc and tested with vitest.
  src/main.ts        starts the app and owns the window
  src/harness/       the reply loop and the prompts it uses
  src/llm/           the providers, and which model answers
  src/sandbox/       the Docker container each thread works in
  src/search/        the embeddings, and ripgrep behind them
  src/settings.ts    what is saved between runs
  src/tools/         the tools a model may call
  tests/             one file beside each source file
  package.json       the scripts: build, test, lint, typecheck`;

// The breakdown the model asked for, as it asked for it
export interface Output {
  // The pieces, or [] where it handed nothing out
  tasks: { name: string; task: string; kind: string }[];
  // Why there is no breakdown to judge: the model neither answered nor acted,
  // or called the tool with something that is not a list of tasks
  why?: string;
  // How the job was kept whole, when it was: what the model did instead
  kept?: string;
}

export interface Expected {
  // Whether this job is one to hand out at all
  split: boolean;
  // How many pieces are reasonable, when it is
  tasks?: readonly [number, number];
  // The kinds that could do these pieces
  kinds?: readonly string[];
}

// How many pieces a job is expected to come to when the case does not say.
// Nothing stops a model handing out more; what this is judging is whether it
// found the seams, and a job cut into twenty was not cut along them.
const DEFAULT_TASKS: readonly [number, number] = [2, 6];

const FOLDER = '/projects/demo';

function one(
  name: string,
  request: string,
  expected: Expected,
  extra: { workspace?: boolean; ambiguous?: string } = {}
): Case<Input, Output> {
  return {
    name,
    input: { request, workspace: extra.workspace },
    ambiguous: extra.ambiguous,
    grade: (got) => grade(got, expected),
  };
}

// A task that points back at the conversation is one its subagent cannot do:
// it was handed the task and nothing else. These are the ways a model refers
// to what only it can see.
// Built from its parts rather than written as one literal, which no editor
// shows the end of
const POINTS_BACK = new RegExp(
  `\\b(${[
    'as (we |i )?(discussed|agreed|said|mentioned|described)',
    'as above',
    'the above',
    'mentioned (earlier|above)',
    'described above',
    'see above',
    'this conversation',
    'the (previous|preceding) (task|step|message)',
    'per (our|the) (discussion|conversation)',
    "the user'?s? (request|message) above",
    'like the (other|first) (one|task)',
  ].join('|')})\\b`,
  'i'
);

// Short enough that it cannot be saying where to look and what to report
const TOO_SHORT = 40;

export function grade(got: Output, expected: Expected): Mark[] {
  const split = got.tasks.length > 0;
  const marks: Mark[] = [
    {
      field: 'split',
      wanted: expected.split ? 'handed out' : 'kept whole',
      got: got.why ?? (split ? `handed out ${got.tasks.length}` : `kept whole, ${got.kept ?? 'answered'}`),
      ok: !got.why && split === expected.split,
    },
  ];
  // A job that should have stayed whole has no pieces worth judging, and one
  // that was wrongly kept whole has none to judge either
  if (!expected.split || !split) return marks;

  marks.push(within('tasks', expected.tasks ?? DEFAULT_TASKS, got.tasks.length));
  if (expected.kinds) {
    const used = [...new Set(got.tasks.map((task) => task.kind))];
    const wrong = used.filter((kind) => !expected.kinds!.includes(kind));
    marks.push({
      field: 'kinds',
      wanted: expected.kinds.join(' or '),
      got: wrong.length === 0 ? used.join(', ') : `${used.join(', ')} (${wrong.join(', ')} cannot do this)`,
      ok: wrong.length === 0,
    });
  }

  const adrift = got.tasks.filter((task) => POINTS_BACK.test(task.task) || task.task.length < TOO_SHORT);
  marks.push({
    field: 'standalone',
    wanted: 'every piece stands on its own',
    got: adrift.length === 0 ? 'all of them' : `${adrift.length} of ${got.tasks.length} (${adrift[0].name})`,
    ok: adrift.length === 0,
  });

  // Only what is to be changed can be clobbered: two subagents reading one
  // file is fine, two writing it is the piece of work that goes missing
  const changing = got.tasks.filter((task) => task.kind === 'coder');
  const shared = sharedFiles(changing.map((task) => task.task));
  marks.push({
    field: 'distinct',
    wanted: 'no file given to two coders',
    got: shared.length === 0 ? 'none shared' : shared.join(', '),
    ok: shared.length === 0,
  });
  return marks;
}

// Files named in more than one of the given tasks
export function sharedFiles(tasks: string[]): string[] {
  const seen = new Map<string, number>();
  for (const task of tasks) {
    const named = new Set(task.match(/\b[\w/-]+\.(?:ts|tsx|js|mjs|py|go|rs|java|rb|css|html|json|md)\b/g) ?? []);
    for (const file of named) seen.set(file, (seen.get(file) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([file]) => file);
}

export const cases: Case<Input, Output>[] = [
  // ---- Jobs that split: the parts do not need each other, and each is real work
  one(
    'the same change in several files',
    'add a JSDoc comment to the exported function in each of src/a.ts, src/b.ts, src/c.ts and src/d.ts, ' +
      'describing what it does and what it returns',
    { split: true, tasks: [2, 4], kinds: ['coder'] },
    { workspace: true }
  ),
  one(
    'finding out about several parts at once',
    'I am new to this project. Work out how it is built, how its tests are run, and how it is configured, ' +
      'and tell me all three',
    { split: true, tasks: [2, 4], kinds: ['explorer', 'worker'] },
    { workspace: true }
  ),
  one(
    'checking several things that have nothing to do with each other',
    'tell me whether each of these is still used anywhere in the project: the quote helper, the isBinary ' +
      'helper, and the toInput helper',
    { split: true, tasks: [2, 4], kinds: ['explorer', 'worker'] },
    { workspace: true }
  ),
  one(
    'one change per area, across areas that do not touch',
    'our logging is inconsistent: make the search module, the sandbox module and the settings module each log ' +
      'their failures the way the harness module already does',
    { split: true, tasks: [2, 4], kinds: ['coder', 'explorer'] },
    { workspace: true }
  ),

  // ---- Jobs that stay whole: one piece, or each part needs the one before it
  one(
    'a job one tool call does',
    'rename the function parse to parseInput in src/parser.ts',
    { split: false },
    {
      workspace: true,
    }
  ),
  one(
    'one part needs what the part before it found',
    'find whichever test is slowest and then make it faster',
    { split: false },
    { workspace: true }
  ),
  one(
    'two changes to the same file',
    'in src/parser.ts, handle the empty-input case and then add a test covering it',
    { split: false },
    { workspace: true }
  ),
  one(
    'a question with nothing to do',
    'what does the compactor do, and when does it run?',
    { split: false },
    {
      workspace: true,
    }
  ),
  one('small talk', 'thanks, that worked!', { split: false }),
  one(
    'a decision, which is the part only the model can take',
    'should this project keep its own embeddings or go back to an off-the-shelf search? decide and say why',
    { split: false },
    { workspace: true }
  ),

  // ---- Awkward on purpose
  one(
    'work that is plural but tiny',
    'fix the three typos in README.md: "recieve", "seperate" and "occured"',
    { split: false },
    { workspace: true, ambiguous: 'three changes, but to one file and together they are one tool call' }
  ),
  one(
    'a big job with no seams given',
    'make this project easier for a new contributor to pick up',
    { split: true, tasks: [2, 4] },
    {
      workspace: true,
      ambiguous: 'open enough that planning it alone or handing out pieces of it are both fair',
    }
  ),
];

// What the model is working under: the instructions a capable model answering
// in a workspace is given about breaking its work up, and nothing else. The
// rest of the system prompt (how to write a reply, what the workspace is) says
// nothing about splitting work, so leaving it out keeps the suite judging the
// one thing it is for.
export function systemPrompt(workspace: boolean): string {
  const parts = [
    'You are answering a request in a chat application. You have tools available.',
    workspace ? `The user started this thread in the workspace ${FOLDER}, so the request is about those files.` : '',
    workspace ? NOTE : '',
    subagents.prompt(SOPHISTICATION.STRONG),
  ];
  return parts.filter(Boolean).join('\n\n');
}

// The pieces out of the model's tool call, or why there are none. parse() is
// the app's own reader (see ../src/subagents), so a call it would reject counts
// here as a breakdown that did not happen.
export function breakdown(calls: ToolCall[], text: string): Output {
  const asked = calls.filter((call) => call.name === subagents.TOOL_NAME);
  // Keeping the job whole is an answer, and for half of these cases it is the
  // right one. It looks like either starting the work with another tool, or
  // simply replying. Neither calling nor writing anything is not an answer.
  if (asked.length === 0) {
    const started = calls.map((call) => call.name).join(', ');
    if (started) return { tasks: [], kept: `began it with ${started}` };
    return text.trim() ? { tasks: [], kept: 'answered' } : { tasks: [], why: 'wrote nothing and called nothing' };
  }
  try {
    const tasks = asked.flatMap((call) => subagents.parse(call.input ?? {}));
    return { tasks: tasks.map(({ name, task, kind }) => ({ name, task, kind: kind.name })) };
  } catch (err) {
    return { tasks: [], why: `unusable tasks: ${(err as Error).message}` };
  }
}

export const suite: Suite<Input, Output> = {
  name: 'subagents',
  about: 'how it breaks a job into pieces to be done at once',
  perModel: true,

  async setUp({ model: wanted }) {
    configure();
    const { models, providers } = await llm.listModels({ fresh: true });
    // The most capable model there is, since only such a model is told how to
    // break its work up at all (see BREAKS_UP in ../src/subagents)
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
    // The app only tells a strong model how to break its work up, so that is
    // what the suite judges by default. A model named on the command line is
    // judged whatever its level: asking how a smaller one copes is a fair
    // question, and the answer is worth having before the prompt is given to
    // one. The heading says which of the two happened.
    const under = chosen.sophistication < subagents.BREAKS_UP;
    if (under && !wanted) {
      throw new Error(
        `No model here is told how to break its work up: that needs sophistication ${subagents.BREAKS_UP} ` +
          `and the most capable available is ${chosen.id} at ${chosen.sophistication}. ` +
          'Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or name a model with --model to judge it anyway.'
      );
    }

    return {
      model: under
        ? `${chosen.id} (level ${chosen.sophistication}, below the ${subagents.BREAKS_UP} that is normally told how)`
        : chosen.id,
      async run({ request, workspace }: Input): Promise<Output> {
        const messages: ChatMessage[] = [{ role: 'user', content: request }];
        const calls: ToolCall[] = [];
        let text = '';
        let failure = '';
        const events = llm.stream(
          {
            provider: chosen.provider,
            model: chosen.id,
            system: systemPrompt(Boolean(workspace)),
            messages,
            // Every tool the app offers, not just the one being judged. With
            // only hand_to_subagent to call, handing work out is the one way a
            // model can act at all, and every model splits everything: the
            // suite measures the shape of the tool list rather than the
            // judgement. Given the real list, doing it yourself is reading a
            // file or running a command, and choosing that over handing out
            // is the judgement being asked for.
            tools: tools.all.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            log: { purpose: 'eval.subagents' },
          },
          AbortSignal.timeout(300000)
        );
        for await (const event of events) {
          if (event.type === 'text') text += event.delta;
          if (event.type === 'tool_call') calls.push({ id: event.id, name: event.name, input: event.input });
          if (event.type === 'error') failure = event.message;
        }
        if (failure) return { tasks: [], why: failure };
        return breakdown(calls, text);
      },
    };
  },

  cases,
};
