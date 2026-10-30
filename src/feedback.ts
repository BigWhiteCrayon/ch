// What the user thought of how a message was classified, kept for working out
// afterwards where the classifier goes wrong. One JSON object per line, in a
// file beside the log (see log.directory).
//
// A verdict is kept with the conversation it was given, not just the message
// that was rated, so that `npm run eval -- feedback` can put the same input
// back through the classifier and see whether a change to the prompt moved the
// ratings the user called wrong. The conversation is trimmed to what the
// classifier itself sees, so the file holds what was rated and no more.

import fs from 'fs';
import path from 'path';
import { shown } from './harness/classifier';
import * as log from './log';
import type { ClassificationFeedback, ClassificationProblem } from './types';

export const FILE_NAME = 'classification-feedback.jsonl';

const PROBLEMS: ClassificationProblem[] = ['too_low', 'too_high', 'wrong_type'];

// Adds one verdict to the file. Nothing is kept until the log has been started,
// and a verdict that can't be written is logged rather than thrown, since the
// window has nothing to do about it.
export function record(feedback: ClassificationFeedback): void {
  const dir = log.directory();
  if (!dir) return;
  try {
    const bad = feedback.rating === 'bad';
    // The window sends this over IPC, so only what is known is written
    const problems = bad ? PROBLEMS.filter((problem) => feedback.problems?.includes(problem)) : undefined;
    // The window may be an old one that does not send the conversation; such a
    // verdict is still worth keeping, and reads back as one that cannot be replayed
    const given = feedback.messages ? shown(feedback.messages, feedback.summary) : undefined;
    const entry = {
      time: new Date().toISOString(),
      rating: bad ? 'bad' : 'good',
      ...(problems?.length ? { problems } : {}),
      thread: feedback.thread,
      request: feedback.request,
      classification: feedback.classification,
      ...(given ? { messages: given.messages } : {}),
      ...(given?.summary ? { summary: given.summary } : {}),
      ...(feedback.workspace ? { workspace: feedback.workspace } : {}),
    };
    fs.appendFileSync(path.join(dir, FILE_NAME), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    log.info('feedback.classification', { rating: entry.rating, problems });
  } catch (err) {
    log.error('feedback.failed', { error: err });
  }
}
