// Running one subagent again, on its own, because the user asked for it.
//
// A subagent that failed was one piece of a reply that is long over: the
// model that handed the work out is not waiting for anything any more, and
// nothing it brings back now can change what that reply said. So this does
// not re-open the reply. It runs the one piece again, in the same container
// the thread works in, and what comes back stands where the failed work did
// (see resumeCutOff's neighbour, retrySubagent, in ../renderer.ts).
//
// Which model it runs on is worked out here rather than remembered: the reply
// that first handed the work out may have been answered by a model that is no
// longer installed, or the user may have better ones now than they did then.

import * as llm from '../llm';
import * as log from '../log';
import { route } from '../harness/router';
import { SOPHISTICATION } from '../llm/sophistication';
import * as sandbox from '../sandbox';
import type { AgentEvent, RetryRequest, SubagentResult } from '../types';
import { HEAD_EXPLORER } from './head';
import { REVIEWER } from './reviewer';
import { DEFAULT_KIND, KINDS } from './index';
import { findings } from './run';

// Every kind a failed subagent can turn out to be: the kinds a model may ask
// for, and the two it never asks for — the reviewer sent per comment, and the
// head explorer the app sends at a workspace (see ./index.ts)
export const byAnyName = (name: string | undefined) =>
  [...KINDS, REVIEWER, HEAD_EXPLORER].find((kind) => kind.name === name);

// What one piece of work is run again on. A subagent is work a model handed
// out because it was plainer than the whole, so it wants a capable model and
// not the most capable one there is.
export const RETRY_LEVEL = SOPHISTICATION.CAPABLE;

export async function retry(
  asked: RetryRequest,
  emit: (event: AgentEvent) => void,
  signal: AbortSignal
): Promise<SubagentResult> {
  const kind = byAnyName(asked.kind) ?? DEFAULT_KIND;
  const where = { thread: asked.thread, agent: asked.name, kind: kind.name };
  const { models } = await llm.listModels();
  const model = route(models, { sophistication: RETRY_LEVEL }, {});
  if (!model) {
    log.error('subagent.retry', { ...where, ok: false, error: 'No models available.' });
    return { text: 'No models available.', isError: true };
  }
  // The container is the thread's own, with the files as this thread has them
  if (asked.workspace) sandbox.setWorkspace(asked.thread, asked.workspace);

  const started = Date.now();
  log.info('subagent.retry.start', { ...where, provider: model.provider, model: model.id });
  try {
    const [found] = await findings(
      [{ name: asked.name, task: asked.task, kind }],
      {
        signal,
        threadId: asked.thread,
        workspace: asked.workspace,
        model: { provider: model.provider, model: model.id },
        // Its work is passed straight on: a subagent reports in the same
        // events the window already shows one by (see ./run.ts)
        emit: (event) => {
          if (event.type === 'subagent_update') emit(event.event);
        },
        // Where the run is one that picks it up where the app closed on it: what
        // it had done, so the model carries on rather than starting over (see
        // ./run.ts and ./thread.ts). A run the user asks for again carries none.
        resumed: asked.resumed,
      },
      undefined
    );
    const result = { text: found?.text ?? 'The subagent brought nothing back.', isError: found?.isError ?? true };
    log.info('subagent.retry', { ...where, ok: !result.isError, ms: Date.now() - started });
    return result;
  } catch (err) {
    const text = (err as Error).message;
    log.warn('subagent.retry', { ...where, ok: false, error: text });
    return { text, isError: true };
  }
}
