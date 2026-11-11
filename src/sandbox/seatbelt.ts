// Confining a command run on the user's own computer, on macOS, with the
// kernel's own sandbox (Seatbelt, through sandbox-exec) rather than by what
// the command says.
//
// run_host_command takes a command apart and checks every word of it against
// lists (see ../tools/hostReading.ts). That bound is on what may be named, and
// a program's flags are a list nobody finishes: `sort -o` writes, `rg --pre`
// runs a program, and the next version of either may add another. So the
// lists stay, to steer, and this is what holds: a command that only reads is
// run where nothing may be written, no network reached and no system service
// asked to act for it (launchd, preferences, AppleScript, the keychain), and a
// git that changes a repository may write in that repository and nowhere else.
//
// sandbox-exec has been marked deprecated for years and is still what macOS
// itself, browsers and other agents' sandboxes are built on. Where it is not
// there (Linux, Windows), commands run as they did, bounded by the lists alone
// (see available).

import fs from 'fs';
import os from 'os';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// What every command gets: everything allowed but writing, which is allowed
// only to the devices a program writes to without meaning to keep anything,
// and signalling any process but its own.
const COMMON = `(version 1)
(allow default)
(deny file-write*)
(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(deny signal (target others))`;

// A command that only reads. No network, and no system service but the two
// that git as Apple ships it (the xcrun shim at /usr/bin/git) asks where the
// user's temporary folder is and who the user is; without the first it warns
// on every run. Every other way a process gets something done for it outside
// the sandbox — launchd, cfprefsd, LaunchServices, AppleEvents — is a lookup
// of a service by name, and is refused here.
const READS = `${COMMON}
(deny network*)
(deny mach-lookup)
(allow mach-lookup (global-name "com.apple.bsd.dirhelper" "com.apple.system.opendirectoryd.libinfo"))`;

// A git that changes a repository, which may write in the folders given as
// W0, W1, ... (the repository's, and the temporary folder), and nowhere else.
// Its hooks run under the same bound. The network and system services are
// left to it: a push or a fetch needs the one, and the keychain that holds the
// credentials it pushes with is the other.
const writes = (count: number) =>
  `${COMMON}
(allow file-write*${Array.from({ length: count }, (_, i) => ` (subpath (param "W${i}"))`).join('')})`;

// Whether commands on this computer can be confined at all
export function available(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

// The sandbox matches a path as the kernel resolves it, so a folder is given
// to it resolved: /tmp and /var are links to /private/tmp and /private/var
function real(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
}

// The argv that runs argv confined: only reading, or writing in the folders
// given and the temporary folder. The folders go in as parameters rather than
// into the profile's text, so that no path can be read as part of the profile.
export function confine(argv: string[], writable: string[] | null = null): string[] {
  if (!writable) return [SANDBOX_EXEC, '-p', READS, ...argv];
  const folders = [...new Set([...writable, os.tmpdir()].map(real))];
  return [
    SANDBOX_EXEC,
    '-p',
    writes(folders.length),
    ...folders.flatMap((folder, i) => ['-D', `W${i}=${folder}`]),
    ...argv,
  ];
}
