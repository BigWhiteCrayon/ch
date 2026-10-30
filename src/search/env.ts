// Environment for the commands a search runs: git, to list the files worth
// embedding, and ripgrep, for the keyword matches that stand in when the
// embeddings can't answer.
//
// It is the environment docker is run with (Homebrew's directories added,
// since they are often missing from PATH when the app is opened from Finder),
// and ~/.local/bin on top of that: uv, pipx and friends install there, and
// ripgrep is as likely to have come from one of them as from Homebrew.

import os from 'os';
import path from 'path';
import { toolEnv as baseEnv } from '../sandbox/env';

export function toolEnv(): NodeJS.ProcessEnv {
  const base = baseEnv();
  const PATH = [base.PATH, path.join(os.homedir(), '.local', 'bin')].join(path.delimiter);
  return { ...base, PATH };
}
