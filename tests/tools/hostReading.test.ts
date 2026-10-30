import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as access from '../../src/harness/access';
import { tool } from '../../src/tools/hostReading';

vi.mock('../../src/harness/access', () => ({
  resolve: vi.fn((p: string) => p),
  permitted: vi.fn(),
  confirmed: vi.fn(),
  relativeToWorkspace: vi.fn(() => null),
}));

const permitted = vi.mocked(access.permitted);
const confirmed = vi.mocked(access.confirmed);
const inside = vi.mocked(access.relativeToWorkspace);
const context = { signal: new AbortController().signal, threadId: 't1', workspace: '/w', emit: vi.fn() } as any;
const run = (input: Record<string, unknown>) => tool.run(input, context);
let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  permitted.mockResolvedValue(true);
  confirmed.mockResolvedValue(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-command-'));
});

describe('run_host_command', () => {
  // It only reads, as read_user_file does, and the finding-out step is the one
  // that most wants the project's history (see the tool's own comment)
  it('belongs to no step in particular, being a tool that reads', () => {
    expect(tool.phases).toBeUndefined();
  });

  it.each([
    'echo a; echo b',
    'echo a & echo b',
    'echo $HOME',
    'echo `date`',
    'echo a > out.txt',
    'echo a < in.txt',
    'echo (a)',
  ])('refuses shell operators in %s without asking', async (command) => {
    await expect(run({ path: dir, command })).rejects.toThrow();
    expect(permitted).not.toHaveBeenCalled();
  });

  it.each([
    'rm -rf x',
    'sed -i s/a/b/ f',
    'git config alias.x !sh',
    'find . -delete',
    'find . -exec rm {} +',
    'find . -execdir rm {} +',
    'find . -ok rm {} +',
    'find . -okdir rm {} +',
    'find . -fprint out.txt',
    'find . -fprintf out.txt %p',
    'find . -name a',
  ])('refuses %s without asking', async (command) => {
    await expect(run({ path: dir, command })).rejects.toThrow();
    expect(permitted).not.toHaveBeenCalled();
  });

  it.each(['cat /etc/passwd', 'cat ~/x', 'cat ../secret', 'nl f | grep x /etc/passwd'])(
    'refuses path arguments in %s',
    async (command) => {
      await expect(run({ path: dir, command })).rejects.toThrow('Arguments');
      expect(permitted).not.toHaveBeenCalled();
    }
  );

  it.each(['sort -o out file', 'git -C dir log', 'git --work-tree=.. status', 'cat f | sort -o out'])(
    'refuses writing flags in %s',
    async (command) => {
      await expect(run({ path: dir, command })).rejects.toThrow();
      expect(permitted).not.toHaveBeenCalled();
    }
  );

  // The first stage is the one with a folder to read; a later one is there to
  // shape what it said, so the programs that answer questions about the folder
  // instead are refused there rather than run on nothing
  it.each(['cat f | ls', 'cat f | tree', 'cat f | git log', 'cat f | node --version'])(
    'refuses %s, which pipes into a program that is not a filter',
    async (command) => {
      await expect(run({ path: dir, command })).rejects.toThrow('take their input from a pipe');
      expect(permitted).not.toHaveBeenCalled();
    }
  );

  it("sends the thread's own workspace to its copy without asking, as the original lacks its changes", async () => {
    inside.mockReturnValueOnce('src');
    await expect(run({ path: dir, command: 'ls' })).rejects.toThrow('its own copy, at /workspace/src,');
    expect(permitted).not.toHaveBeenCalled();
  });

  // The copy was made without the project's .git, so the history is here and
  // nowhere else: sending git to the copy would send it to a git that finds no
  // repository (see filesToCopy in sandbox/docker.ts). It is the thread's own
  // folder and the command only reads, so it is not asked about either
  it("runs git in the thread's own workspace without the copy or the question", async () => {
    inside.mockReturnValueOnce('');
    const result = await run({ path: dir, command: 'git log --oneline' });
    expect(result).toContain('exit code');
    expect(permitted).not.toHaveBeenCalled();
  });

  it('asks about git in a folder that is not the workspace, as it asks about anything there', async () => {
    const result = await run({ path: dir, command: 'git log --oneline' });
    expect(result).toContain('exit code');
    expect(permitted).toHaveBeenCalledWith(dir, true, context);
  });

  it('still sends a command that is not git to the copy, the copy being what has the changes', async () => {
    inside.mockReturnValueOnce('src');
    await expect(run({ path: dir, command: 'wc -l src/a.ts' })).rejects.toThrow('its own copy, at /workspace/src,');
    expect(permitted).not.toHaveBeenCalled();
  });

  // The repository is on the user's computer and nowhere else, so the work of a branch has nowhere else to happen:
  // git may change it here. The ordinary part of that work is run as any other command in an allowed folder is.
  it('runs a git that changes the repository, which is what this tool is the only way to', async () => {
    const result = await run({ path: dir, command: 'git init' });
    expect(result).toContain('exit code 0');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(permitted).toHaveBeenCalledWith(dir, true, context);
    expect(confirmed).not.toHaveBeenCalled();
  });

  // ...and the part of it that could lose work is put to the user as itself. Which of the two a command is cannot be
  // read off the words: "git reset" is the same word as the one that throws a day away.
  it.each([
    ['git push --force origin main', '--force'],
    ['git push -f', '-f'],
    ['git reset --hard HEAD~3', '--hard'],
    ['git clean -fd', '-fd'],
    ['git branch -D feature', '-D'],
    ['git commit --amend -m later', '--amend'],
    ['git stash', 'git stash'],
    ['git reflog expire --all', 'git reflog'],
    ['git remote remove origin', 'remove'],
    ['git checkout src/parse.ts', 'git checkout'],
  ])('asks the user before running %s', async (command, named) => {
    await run({ path: dir, command });
    expect(confirmed).toHaveBeenCalledTimes(1);
    const [asked, where, why] = confirmed.mock.calls[0];
    expect(asked).toBe(command);
    expect(where).toBe(dir);
    expect(why).toContain(named);
    // The question names the command and the folder and is answered for this once, so it is asked in place of the
    // one about the folder rather than after it
    expect(permitted).not.toHaveBeenCalled();
  });

  it('does not run it when the user says no, and says so', async () => {
    confirmed.mockResolvedValue(false);
    await expect(run({ path: dir, command: 'git reset --hard' })).rejects.toThrow('did not allow "git reset --hard"');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  });

  // The thread's own workspace is not asked about as a folder, the thread working on it already; what could lose
  // the user's work there is asked about all the same
  it("asks about it in the thread's own workspace, where an ordinary git is not asked about at all", async () => {
    inside.mockReturnValueOnce('').mockReturnValueOnce('');
    await run({ path: dir, command: 'git commit -m x' });
    expect(confirmed).not.toHaveBeenCalled();
    expect(permitted).not.toHaveBeenCalled();
    await run({ path: dir, command: 'git clean -fd' });
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  // A commit message is the one argument git takes that names nothing: a path check and a look for a force flag are
  // both wrong about what is in it
  it('reads a commit message as a message rather than as paths and flags', async () => {
    const result = await run({ path: dir, command: 'git commit -am "revert the --force in /etc/hosts"' });
    expect(result).toContain('exit code');
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('refuses a path that is a file', async () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, '');
    await expect(run({ path: file, command: 'ls' })).rejects.toThrow('is not a folder');
    await expect(run({ path: file, command: 'ls' })).rejects.toThrow('use read_user_file');
  });

  it('asks with isFolder false for a missing path and then refuses it', async () => {
    const missing = path.join(dir, 'nope');
    await expect(run({ path: missing, command: 'ls' })).rejects.toThrow('Could not find');
    expect(permitted).toHaveBeenCalledWith(missing, false, context);
  });

  it('refuses when the user does not allow the folder', async () => {
    permitted.mockResolvedValue(false);
    await expect(run({ path: dir, command: 'ls' })).rejects.toThrow('did not allow');
    expect(permitted).toHaveBeenCalledWith(dir, true, context);
  });

  it('runs an allowed command in the folder and returns its output', async () => {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
    const result = await run({ path: dir, command: 'ls' });
    expect(result).toContain('exit code 0');
    expect(result).toContain('hello.txt');
    expect(permitted).toHaveBeenCalledWith(dir, true, context);
  });

  it('runs a pipeline as processes of its own and answers with the last stage', async () => {
    fs.writeFileSync(path.join(dir, 'lines.txt'), 'one\ntwo\nthree\n');
    const result = await run({ path: dir, command: 'cat lines.txt | head -2' });
    expect(result).toContain('exit code 0');
    expect(result).toContain('one');
    expect(result).toContain('two');
    expect(result).not.toContain('three');
  });

  it('pipes into cat, which numbers and shows what came through it', async () => {
    fs.writeFileSync(path.join(dir, 'lines.txt'), 'one\ntwo\n');
    const result = await run({ path: dir, command: 'grep -v two lines.txt | cat -n' });
    expect(result).toContain('exit code 0');
    expect(result).toMatch(/1\s+one/);
  });

  // Whatever the mask makes inert is an argument and not a stage: a pattern
  // with a pipe in it is one thing to look for (see mask in tools/reading.ts)
  it('does not cut a command at a pipe inside quotes', async () => {
    fs.writeFileSync(path.join(dir, 'lines.txt'), 'a|b\nc\n');
    const result = await run({ path: dir, command: 'grep "a|b" lines.txt' });
    expect(result).toContain('exit code 0');
    expect(result).toContain('a|b');
  });

  // The history is reachable through this tool and no other, and a pipe is how
  // a long one is asked about without 64 KB of it coming back
  it("runs a piped git in the thread's own workspace without the copy or the question", async () => {
    inside.mockReturnValueOnce('');
    const result = await run({ path: dir, command: 'git log --oneline | head -5' });
    expect(result).toContain('exit code');
    expect(permitted).not.toHaveBeenCalled();
  });

  it('keeps what an earlier stage said went wrong, which is the whole of the answer when it is', async () => {
    const result = await run({ path: dir, command: 'nl nope.txt | wc -l' });
    expect(result).toContain('nope.txt');
  });

  // Nothing is at the keyboard: a stage that reads standard input and is given
  // none ends at once rather than waiting out the tool's own timeout
  it('gives the first stage no input, so one that would read it does not wait', async () => {
    const result = await run({ path: dir, command: 'cat' });
    expect(result).toBe('exit code 0\n');
  });

  it('cuts output longer than 64 KB and says so', async () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'a'.repeat(70 * 1024));
    const result = await run({ path: dir, command: 'cat big.txt' });
    expect(result).toContain('output cut at');
  });
});
