// Judging the code search: given a question about this project, does the file
// that answers it come back near the top?
//
// The cases are about this repository, so they are run from it. Each names the
// file or files that would be a right answer; a search is right if one of them
// is in the first few results, since a search's job is to put the reader
// somewhere useful, not to be the only answer.
//
// This started out as a comparison against the external index search_workspace
// used to be backed by. That one answered none of these and the embeddings
// answered all of them, so the comparison is over and only the embeddings are
// judged here. What the suite is for now is noticing when a change to the
// chunking, the model or the line-picking makes it worse.

import path from 'path';
import * as embeddings from '../src/search/embeddings';
import type { Case, Mark, Suite } from './harness';

// How far down the results a right answer may be and still count
const TOP = 3;

interface Input {
  query: string;
  // Any of these is a right answer
  wanted: string[];
}

interface Output {
  found: string[];
}

const ask = (query: string, wanted: string[], ambiguous?: string): Case<Input, Output> => ({
  name: query,
  input: { query, wanted },
  ambiguous,
  grade: (got) => [mark(got.found, wanted)],
});

// Where the first right answer came, if it came at all
function mark(ranked: string[], wanted: string[]): Mark {
  const at = ranked.findIndex((file) => wanted.includes(file));
  return {
    field: 'found',
    wanted: `${wanted.join(' or ')} in the first ${TOP}`,
    got: at === -1 ? `not found (${ranked.slice(0, TOP).join(', ') || 'nothing'})` : `${at + 1} of ${ranked.length}`,
    ok: at >= 0 && at < TOP,
  };
}

export const cases: Case<Input, Output>[] = [
  ask('where are the settings loaded and saved', ['src/settings.ts']),
  ask('how is the docker container for a thread created', ['src/sandbox/docker.ts']),
  ask('what prompt is used to classify a message', ['src/harness/classifier.ts']),
  ask('how are tokens counted and priced', ['src/llm/pricing.ts']),
  ask('what keeps a long conversation inside the context window', ['src/harness/compactor.ts']),
  ask('how is the model that answers a message chosen', ['src/harness/router.ts']),
  ask('how does the app talk to ollama', ['src/llm/providers/ollama.ts', 'src/llm/ollama.ts']),
  ask('where are subagents run in parallel', ['src/subagents/run.ts', 'src/subagents/index.ts']),
  ask('what kinds of subagent are there', ['src/subagents/kind.ts', 'src/subagents/index.ts']),
  ask("where does a model's reasoning become the thoughts shown in the chat", ['src/harness/thoughts.ts']),
  ask("how are a thread's changes written back to the workspace", ['src/sandbox/changes.ts']),
  // The fallback is decided in the tool and carried out in ripgrep.ts, so
  // either is a right answer
  ask('what happens when the semantic search does not answer', ['src/search/ripgrep.ts', 'src/tools/search.ts']),
  ask('how is a file split into pieces for embedding', ['src/search/chunks.ts']),
  ask('where is the note on a project workspace kept', ['src/harness/project.ts']),
  ask('where are the tool descriptions a model is shown', [
    'src/tools/search.ts',
    'src/tools/sandbox.ts',
    'src/tools/index.ts',
  ]),
  ask(
    'how does the window get its title',
    ['src/renderer.ts', 'src/main.ts'],
    'the title is set in one and begun in the other'
  ),
];

export const suite: Suite<Input, Output> = {
  name: 'search',
  about: 'whether the file that answers a question comes back near the top',

  async setUp() {
    const workspace = path.resolve(__dirname, '..', '..');
    const data = process.env.CH_EVAL_DATA ?? path.join(workspace, '.eval-data');
    embeddings.configure({
      dir: data,
      local: { baseURL: process.env.CH_LOCAL_URL ?? 'http://127.0.0.1:11434/v1', apiKey: '' },
    });

    const ready = await embeddings.status();
    if (!ready.ready) throw new Error(ready.reason ?? 'The embedding model is not available.');
    // Embedded in full before anything is judged, so no case is answered from
    // half an index
    const indexed = await embeddings.index(workspace, AbortSignal.timeout(30 * 60 * 1000));

    const options = { limit: 10, context: 1, pathsOnly: true };
    return {
      model: `${embeddings.MODEL} over ${indexed.chunks} pieces of ${indexed.files} files`,
      async run({ query }: Input): Promise<Output> {
        const result = await embeddings.search({ workspace }, query, options, AbortSignal.timeout(120000));
        return { found: result.files.map((file) => file.path) };
      },
    };
  },

  cases,
};
