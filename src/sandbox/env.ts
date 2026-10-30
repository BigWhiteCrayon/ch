// Environment for running docker and colima. Homebrew's directories are added
// because they are often missing from PATH, e.g. when the app is opened from
// Finder or Homebrew was never added to the shell profile.

import path from 'path';

export function toolEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const extraDirs = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
  const PATH = [env.PATH, ...extraDirs].filter(Boolean).join(path.delimiter);
  return { ...env, PATH };
}
