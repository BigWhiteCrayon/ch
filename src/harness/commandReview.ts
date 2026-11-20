// A second agent's judgement on a git command that could lose work: when the
// opt-in command review is on (settings.commandReview), a command the gate would
// put to the user is first judged by a command-reviewer subagent (see
// ../subagents/commandReviewer.ts), which is given the user's request, the command
// and the folder it would run in, and why it is risky, and reads the repository
// state to decide whether what the command would throw away is what the user
// meant to throw away. It runs nothing and changes nothing itself.
//
// review() returns the verdict, or null. null is what a run that came back no
// verdict was, and it is the only thing the gate reads of it: a null is read as
// "do not let it run unasked", so the gate falls through to asking the user the
// way it always has. A reviewer that fails, or that comes back with no model or
// no verdict, is one that has not said the command may run, and the user is the
// one to say it rather than the work be thrown away.
//
// With the opt-in off, review() returns null before doing anything, so the gate
// spends no subagent and asks the user exactly as it does today.

import * as settings from '../settings';
import * as log from '../log';
import { findings } from '../subagents';
import { COMMAND_REVIEWER } from '../subagents/commandReviewer';
import type { ToolContext } from '../types';

// Characters of the user's request put in the reviewer's task. The command and
// folder are short by themselves; the request is the one thing that may be long,
// and what the reader needs of it is what it asks for, not its whole history.
const MAX_REQUEST_LENGTH = 4000;

// The verdict in the reviewer's reply: the line that says APPROVE or HOLD, as
// asked, in whatever Markdown a model dresses that in. null if no line says
// either.
//
// Looked for from the end, because a model that reasons in its reply reasons its
// way to the verdict rather than opening with it. The verdict is the last line,
// and a HOLD is followed by a line for each reason, each starting "- " (see the
// kind's prompt in ../subagents/commandReviewer.ts).
export function parse(reply: string): { approved: boolean; reason: string } | null {
  const lines = reply.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const verdict = lines[i]
      .replace(/[*_`#]/g, '')
      .replace(/[\s.!:]+$/, '')
      .trim()
      .toUpperCase();
    if (verdict === 'APPROVE') return { approved: true, reason: '' };
    if (verdict !== 'HOLD') continue;
    // The reasons, on the lines under the word, each starting "- "
    const reason = lines
      .slice(i + 1)
      .join('\n')
      .trim();
    return { approved: false, reason };
  }
  return null;
}

// What the reviewer is given: the user's request, the command and the folder it
// would run in, and why it is considered risky.
function reviewTask(input: { command: string; path: string; risk: string; intention: string }): string {
  const request = input.intention.trim();
  const clipped = request.length > MAX_REQUEST_LENGTH ? `${request.slice(0, MAX_REQUEST_LENGTH)} [...]` : request;
  return (
    `The user asked for this:\n${clipped || '(the request could not be read, so judge only the command itself)'}\n\n` +
    `The command that is about to run, and the folder it would run in:\n${input.command} in ${input.path}\n\n` +
    `Why it is considered risky:\n${input.risk}`
  );
}

// The verdict, or null where it was not had: the opt-in is off, there is no model
// to run the reviewer with, the reviewer failed, or it came back with no verdict.
// Any of these is read as "do not let it run unasked", so the gate falls through
// to the user's question.
export async function review(input: {
  command: string;
  path: string;
  risk: string;
  intention: string;
  context: ToolContext;
}): Promise<{ approved: boolean; reason: string } | null> {
  // With the opt-in off the gate spends no subagent: it is exactly as it was.
  if (!settings.get().commandReview) return null;
  try {
    const started = performance.now();
    const [finding] = await findings(
      [
        {
          name: 'command-review',
          task: reviewTask(input),
          kind: COMMAND_REVIEWER,
        },
      ],
      input.context
    );
    const verdict = finding && !finding.isError ? parse(finding.text) : null;
    if (!verdict) {
      log.warn('command.review', {
        ok: false,
        ms: log.since(started),
        error: finding?.isError ? finding.text.slice(0, 300) : 'The reviewer did not say APPROVE or HOLD.',
      });
      return null;
    }
    log.info('command.review', {
      ok: true,
      ms: log.since(started),
      approved: verdict.approved,
      command: input.command,
    });
    return verdict;
  } catch (err) {
    // A reviewer that throws, or comes back with no model to run on, is no
    // verdict: the gate asks the user rather than the work being thrown away.
    log.warn('command.review', { ok: false, error: (err as Error).message });
    return null;
  }
}
