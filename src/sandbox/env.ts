// Environment for running docker and colima. Homebrew's directories are added
// because they are often missing from PATH, e.g. when the app is opened from
// Finder or Homebrew was never added to the shell profile. So is the directory
// Docker Desktop installs into on macOS when it is set up per user, which only
// a login shell's profile knows about; docker's credential helpers are there
// too, so it has to be on PATH rather than docker being found by its full path.

import path from 'path';

export function toolEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const extraDirs = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
  if (platform === 'darwin' && env.HOME) extraDirs.push(path.join(env.HOME, '.docker', 'bin'));
  const PATH = [env.PATH, ...extraDirs].filter(Boolean).join(path.delimiter);
  return { ...env, PATH };
}
