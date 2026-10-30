#!/usr/bin/env node
// Runs the prompt evaluations (see harness.ts). Not part of `npm test`: these
// call real models, so they are run on purpose, after changing a prompt.
//
//   npm run eval                        every suite, once per case
//   npm run eval -- --runs=5             five times each, to see how steady it is
//   npm run eval -- classifier           only that suite
//   npm run eval -- --only=workspace        only the cases whose name says "workspace"
//   npm run eval -- --model=llama3.2:3b  judged with that model alone
//   npm run eval -- --levels=1,2,3,4     one model per level, instead of 2,3,4
//   npm run eval -- --strict             exits non-zero if anything was wrong
//   npm run eval -- feedback             the classifier against the user's own
//                                        verdicts, from the app's record (see
//                                        feedback.ts); CH_FEEDBACK names a file
//
// Keys come from a .env file beside package.json (see .env.example), or from
// the environment, which wins over the file. With a hosted key set, a suite
// that depends on the model is run once per level: a small hosted or local
// model (2), a mid-tier one (3) and a top one (4), so that a prompt which
// only works on one size of model shows itself. Name a model with --model to
// judge that one alone, and widen --levels to take in a small local model,
// which is what the classifier runs on in earnest.

import * as log from '../src/log';
import { run, score, type RunOptions, type Suite } from './harness';
import path from 'path';
import { judges, levelsFrom, loadEnv } from './judges';
import { suite as classifier } from './classifier';
import { suite as compaction } from './compaction';
import { suite as context } from './context';
import { suite as feedback } from './feedback';
import { suite as notes } from './notes';
import { suite as search } from './search';
import { suite as subagents } from './subagents';

// Every suite there is, by the name the command line calls it
const suites: Record<string, Suite<any, any>> = { classifier, compaction, context, feedback, notes, search, subagents };

export interface Args extends RunOptions {
  suites: string[];
  strict: boolean;
  // The sophistication levels to judge, when no one model was named
  levels: number[];
}

// What the command line asked for. Unknown suites are reported by run(), not here.
export function parse(argv: string[]): Args {
  const flag = (name: string) =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  const runs = Number(flag('runs'));
  return {
    suites: argv.filter((arg) => !arg.startsWith('-')),
    runs: Number.isFinite(runs) && runs > 0 ? Math.round(runs) : 1,
    only: flag('only'),
    model: flag('model'),
    levels: levelsFrom(flag('levels')),
    strict: argv.includes('--strict'),
  };
}

// Where a run writes its log. Beside the data the suites keep rather than among
// the app's own logs: a run of these is not the app running, and the two are
// read for different reasons. CH_EVAL_LOG names a directory of your own.
export function logDir(): string {
  if (process.env.CH_EVAL_LOG) return process.env.CH_EVAL_LOG;
  return process.env.CH_EVAL_DATA ?? path.join(__dirname, '..', '..', '.eval-data');
}

export async function main(argv: string[], say: (line: string) => void = console.log): Promise<number> {
  // Before the arguments are read: --levels falls back to the environment,
  // and the keys the suites need are in the file too
  loadEnv();
  // What the suites and everything they call were logging into nothing until
  // now: the app starts logging in its main process, which a run of these is
  // not. Every line a suite causes — what a model was sent, what it wrote, how
  // long it took — lands here instead of in the app's log.
  const logFile = log.init(logDir(), log.EVAL_FILE_NAME);
  const args = parse(argv);
  const names = args.suites.length > 0 ? args.suites : Object.keys(suites);
  const unknown = names.filter((name) => !suites[name]);
  if (unknown.length > 0) {
    say(`No such suite: ${unknown.join(', ')}. There is: ${Object.keys(suites).join(', ')}`);
    return 2;
  }

  // Which models the suites that depend on one are judged with. A model named
  // on the command line is the only one; otherwise one per level is chosen
  // from whatever the keys reach (see ./judges.ts).
  let chosen: (string | undefined)[] = [args.model];
  if (!args.model && names.some((name) => suites[name].perModel)) {
    const found = await judges(args.levels);
    for (const why of found.trouble) say(`(${why})`);
    if (found.missing.length > 0) {
      say(`(no model at level ${found.missing.join(' or ')}: set a key in .env to judge one)`);
    }
    // Nothing reachable at all: let each suite say so in its own words
    chosen = found.chosen.length > 0 ? found.chosen.map((model) => model.id) : [undefined];
  }

  // Said once, at the top: a run that goes wrong is read back from this file,
  // and a file nobody is told about is a file nobody reads
  say(`(logging to ${logFile})`);
  log.info('eval.start', { suites: names, runs: args.runs, only: args.only, models: chosen.filter(Boolean) });

  let wrong = 0;
  for (const name of names) {
    const suite = suites[name];
    // A suite judging something other than a model is run once, however many
    // models there are to judge with
    for (const model of suite.perModel ? chosen : [args.model]) {
      try {
        const result = await run(suite, { ...args, model }, say);
        const { ok, of, errors } = score(result);
        wrong += of - ok + errors;
        log.info('eval.suite', { suite: name, model: result.model, ok, of, errors, ms: result.ms });
      } catch (err) {
        // A suite that could not be set up at all: say why and carry on
        say(`\n${name}${model ? ` with ${model}` : ''}: could not run — ${(err as Error).message}`);
        log.warn('eval.suite', { suite: name, model, ok: false, error: (err as Error).message });
        wrong++;
      }
    }
  }
  if (args.strict && wrong > 0) {
    say(`\n--strict: ${wrong} run(s) were not right.`);
    return 1;
  }
  return 0;
}

// Only when run as a command, so the file can be imported by its tests
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    }
  );
}
