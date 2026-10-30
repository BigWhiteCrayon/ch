// Judging the classifier against the user's own verdicts (see ../src/feedback.ts).
//
// Every other suite here is hand-written: someone decided in advance what a
// good answer looks like. This one is the other way round. Each case is a real
// message the app classified and the user then marked good, or bad and why, so
// it is the only suite that says whether a change to the prompt helped the
// traffic the app actually sees rather than the traffic its examples describe.
// The two disagree: of the verdicts recorded up to 2026-10-26, two thirds of
// the bad ones were the rating coming out too high on an ordinary small
// request, which the hand-written suite has no case for at all, while its own
// hardest cases - a whole system asked for in one line - never once occurred.
//
// A verdict gives a direction, never an answer. "Too high" says the rating
// should have been lower than the one recorded; it does not say what it should
// have been. So that is what is graded, and a case can only be scored at all
// if the conversation was kept with it: replaying a message without the turns
// around it rates it lower than it was rated in the app, which looks exactly
// like the prompt having improved. Verdicts recorded before the conversation
// was kept are reported and left out of the score.

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as llm from '../src/llm';
import { classify } from '../src/harness/classifier';
import { FILE_NAME } from '../src/feedback';
import type { ChatMessage, Classification, ClassificationProblem } from '../src/types';
import type { Case, Mark, Suite } from './harness';
import { configure } from './judges';

// The app's own name, which is what Electron puts its logs under
const APP = 'ch';

// One line of the file. Everything but the first four fields is absent on a
// verdict recorded before the conversation was kept.
export interface Verdict {
  time?: string;
  rating: 'good' | 'bad';
  problems?: ClassificationProblem[];
  request: string;
  classification: Classification;
  thread?: string;
  messages?: ChatMessage[];
  workspace?: string;
  summary?: string;
}

interface Input {
  messages: ChatMessage[];
  summary?: string;
  workspace?: string;
}

// Where the app keeps its verdicts. CH_FEEDBACK names a file of your own,
// which is how a copy taken off another machine is judged.
export function file(): string {
  if (process.env.CH_FEEDBACK) return process.env.CH_FEEDBACK;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', APP, FILE_NAME);
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(roaming, APP, 'logs', FILE_NAME);
  }
  return path.join(home, '.config', APP, 'logs', FILE_NAME);
}

// The verdicts in a file, newest last. A line that cannot be read is skipped
// rather than failing the run: the file is appended to by a running app, so a
// half-written last line is an ordinary thing to meet.
export function read(from = file()): Verdict[] {
  let text: string;
  try {
    text = fs.readFileSync(from, 'utf8');
  } catch {
    return [];
  }
  const verdicts: Verdict[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Verdict;
      if (parsed.rating && parsed.request) verdicts.push(parsed);
    } catch {
      // Not a verdict; the rest of the file still is
    }
  }
  return verdicts;
}

// What a verdict is called in the report: what was wrong with it, the model
// that was rated, and enough of the message to recognise it. The model is in
// the name so that --only=llama judges one model's verdicts.
export function name(verdict: Verdict, at: number): string {
  const said = verdict.rating === 'good' ? 'good' : (verdict.problems ?? ['bad']).join('+');
  const model = verdict.classification.model ?? 'unknown';
  const gist = verdict.request.replace(/\s+/g, ' ').trim().slice(0, 56);
  return `${at + 1} ${said} [${model}] ${gist}`;
}

// How far a rating the user called good may drift and still pass. Not zero:
// the local model is sampled rather than greedy, so the same prompt gives the
// same message a 2 one time and a 3 the next, and a suite that called that a
// regression would report noise. A direction asked for by a bad verdict is
// graded strictly, there being no such excuse for not moving at all.
export const GOOD_DRIFT = 1;

export function grade(got: Classification, verdict: Verdict): Mark[] {
  const was = verdict.classification;
  if (was.failed) {
    return [{ field: 'verdict', wanted: 'a rating to compare against', got: 'the app never rated it', ok: false }];
  }
  if (got.failed) {
    const why = got.reply ? `unreadable reply ${JSON.stringify(got.reply.slice(0, 60))}` : got.reason;
    return [{ field: 'sophistication', wanted: `to move off ${was.sophistication}`, got: why, ok: false }];
  }
  // Endorsed as it stood, so it is the answer, give or take the sampling
  if (verdict.rating === 'good') {
    return [
      {
        field: 'sophistication',
        wanted: `${was.sophistication}${GOOD_DRIFT ? ` (±${GOOD_DRIFT})` : ''}`,
        got: String(got.sophistication),
        ok: Math.abs(got.sophistication - was.sophistication) <= GOOD_DRIFT,
      },
      { field: 'category', wanted: was.category, got: got.category, ok: got.category === was.category },
    ];
  }
  const problems = verdict.problems ?? [];
  const marks: Mark[] = [];
  if (problems.includes('too_high')) {
    marks.push({
      field: 'sophistication',
      wanted: `below ${was.sophistication}`,
      got: String(got.sophistication),
      ok: got.sophistication < was.sophistication,
    });
  }
  if (problems.includes('too_low')) {
    marks.push({
      field: 'sophistication',
      wanted: `above ${was.sophistication}`,
      got: String(got.sophistication),
      ok: got.sophistication > was.sophistication,
    });
  }
  if (problems.includes('wrong_type')) {
    marks.push({
      field: 'category',
      wanted: `anything but ${was.category}`,
      got: got.category,
      ok: got.category !== was.category,
    });
  }
  // Marked bad with nothing said about what was wrong: there is no direction
  // to grade, so it is reported as unjudgeable rather than passed
  if (marks.length === 0) {
    marks.push({ field: 'verdict', wanted: 'what was wrong with it', got: 'bad, with no problem named', ok: false });
  }
  return marks;
}

// Why a verdict cannot be scored, or undefined if it can
export function unreplayable(verdict: Verdict): string | undefined {
  if (verdict.classification.failed) return 'the app never managed to rate this message, so there is nothing to beat';
  if (!verdict.messages?.length) {
    return 'recorded before the conversation was kept, so it would replay without the turns the classifier saw';
  }
  return undefined;
}

export function casesFrom(verdicts: Verdict[]): Case<Input, Classification>[] {
  return verdicts.map((verdict, at) => ({
    name: name(verdict, at),
    input: {
      // Falls back to the message alone, which is only ever reported, never scored
      messages: verdict.messages ?? [{ role: 'user' as const, content: verdict.request }],
      summary: verdict.summary,
      workspace: verdict.workspace,
    },
    ambiguous: unreplayable(verdict),
    grade: (got) => grade(got, verdict),
  }));
}

export const cases: Case<Input, Classification>[] = casesFrom(read());

export const suite: Suite<Input, Classification> = {
  name: 'feedback',
  about: "how it rates the messages the user has judged it on, from the app's own record",
  perModel: true,

  async setUp({ model: wanted }) {
    configure();
    const where = file();
    if (cases.length === 0) {
      throw new Error(
        `No verdicts to judge in ${where}.\n` +
          'They are written by the app when a classification is rated with the thumbs beside it. ' +
          'Set CH_FEEDBACK to judge a file from somewhere else.'
      );
    }
    const { models, providers } = await llm.listModels({ fresh: true });
    const offered = wanted ? models.filter((m) => m.id === wanted) : models;
    if (offered.length === 0) {
      const trouble = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
      throw new Error(
        [wanted ? `No model called "${wanted}".` : 'No models available.', ...trouble].join('\n') +
          `\nModels there are: ${models.map((m) => m.id).join(', ') || 'none'}`
      );
    }
    const scored = cases.filter((one) => !one.ambiguous).length;
    return {
      model: `${offered.map((m) => m.id).join(', ')} against ${scored} of ${cases.length} verdicts in ${where}`,
      run: (input) => classify(input, offered, AbortSignal.timeout(120000)),
    };
  },

  cases,
};
