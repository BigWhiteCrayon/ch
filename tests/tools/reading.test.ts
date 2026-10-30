// The command tool a step that cannot change anything is allowed to hold (see
// ../../src/tools/reading.ts). What it runs is bounded by what may be named
// rather than by what may happen, so these are tests of the bound: everything
// it will run, and the ways round it that it refuses.

import { describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';

const docker = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../../src/sandbox/docker', () => ({ ...docker, WORKDIR: '/work' }));

import { refuse, tool } from '../../src/tools/reading';

const context = { signal: new AbortController().signal, threadId: 't1' };
const run = (command: string) => tool.run({ command }, context);

describe('what it will run', () => {
  it.each([
    ['git log --oneline -20'],
    ['git show abc123'],
    ['git blame src/parse.ts'],
    ['git diff HEAD~1'],
    ['git ls-files src'],
    ['git --version'],
    ['ls -la src'],
    ['cat package.json'],
    ['wc -l src/parse.ts'],
    ['grep -c function src/parse.ts'],
    ['rg --count TODO'],
    ['file src/parse.ts'],
    ['diff src/a.ts src/b.ts'],
    ['which node'],
    // A pipeline of two of them, which is how a reading command is usually
    // worth making at all
    ['git log --format=%an | sort | uniq -c'],
    ['ls src | wc -l'],
    // What is installed, which is a question a reader has and the tools cannot
    // otherwise answer
    ['node --version'],
    ['python3 --version'],
    ['go version'],
  ])('runs %s', (command) => {
    expect(refuse(command)).toBeNull();
  });

  it('hands the command to the container as it was given, and reports the exit code', async () => {
    docker.exec.mockResolvedValue({ code: 0, output: 'abc123 first commit' });
    await expect(run('git log --oneline')).resolves.toBe('exit code 0\nabc123 first commit');
    expect(docker.exec).toHaveBeenCalledWith('t1', 'git log --oneline', { signal: context.signal });
  });
});

describe('what it refuses', () => {
  const why = (command: string) => refuse(command) ?? '';

  it('refuses a redirection, which is the one thing a reading program could write with', () => {
    expect(why('git log > out.txt')).toContain('writes');
    expect(why('cat a.ts >> b.ts')).toContain('writes');
    expect(why('cat < a.ts')).toContain('redirection');
  });

  it.each([
    ['two commands at once', 'ls; rm -rf src'],
    ['a newline', 'ls\nrm -rf src'],
    ['commands joined with &&', 'ls && rm -rf src'],
    ['a backquote', 'cat `echo /etc/passwd`'],
    ['a $(…)', 'cat $(echo /etc/passwd)'],
    ['a ${…}', 'cat ${HOME}/.ssh/id_rsa'],
  ])('refuses %s', (_name, command) => {
    expect(refuse(command)).not.toBeNull();
  });

  it('refuses the git subcommands that change the repository, and says which ones read', () => {
    for (const command of ['git checkout main', 'git reset --hard', 'git apply p.diff', 'git commit -m x']) {
      expect(why(command)).toContain('only read');
    }
    expect(why('git checkout main')).toContain('blame');
    // ...and a git with no subcommand at all is told to name one
    expect(why('git')).toContain('which git subcommand');
  });

  // The same command on the user's own computer is allowed to write, the
  // repository being there and nowhere else (see ../../src/tools/hostReading.ts)
  it('allows the git that writes where the caller says it may, and still refuses the git that runs a program', () => {
    const asked = (command: string) => refuse(command, { git: 'writes' }) ?? '';
    for (const command of ['git checkout main', 'git reset --hard', 'git commit -m x', 'git push --force']) {
      expect(refuse(command, { git: 'writes' })).toBeNull();
    }
    for (const command of ['git config alias.x !sh', 'git submodule foreach ls', 'git bisect run ./x', 'git help -a']) {
      expect(asked(command)).toContain('runs a program of its own');
    }
    // ...and the flags that would run one, or point git at another repository
    for (const command of [
      'git -c core.pager=sh log',
      'git --git-dir=other/.git log',
      'git -C dir status',
      'git diff --ext-diff',
    ]) {
      expect(asked(command)).toContain('not allowed here');
    }
    // Those are refused where git reads them, which is before the subcommand: a -c after one is the subcommand's
    // own flag and nothing to do with configuration
    expect(refuse('git log -c', { git: 'writes' })).toBeNull();
    expect(refuse('git log -c')).toBeNull();
    expect(asked('git')).toContain('which git subcommand');
  });

  it('refuses the programs that edit in place, rather than policing their flags', () => {
    for (const command of ['sed -i s/a/b/ src/parse.ts', 'perl -pi -e s/a/b/ x', 'awk {print} src/parse.ts']) {
      expect(why(command)).toContain('not one of the programs this tool runs');
    }
  });

  it('refuses the programs that take a program as an argument', () => {
    for (const command of ['xargs rm', 'env rm -rf src', 'find . -delete', 'nohup sleep 1']) {
      expect(refuse(command)).not.toBeNull();
    }
  });

  it('asks a language or package manager its version and nothing else', () => {
    expect(refuse('node --version')).toBeNull();
    expect(why("node -e \"require('fs').rmSync('src')\"")).toContain('runs code of its own');
    expect(why('npm install')).toContain('runs code of its own');
    expect(why('make clean')).toContain('runs code of its own');
    // ...and says where that work belongs instead
    expect(why('npm test')).toContain('run_command');
  });

  it('refuses a program named by its path, which would get round the list', () => {
    expect(why('/bin/sh -c "rm -rf src"')).toContain('names a program by its path');
    expect(why('./scripts/build.sh')).toContain('names a program by its path');
  });

  it('refuses an unknown program, naming what it will run and what to use instead', () => {
    const said = why('curl https://example.com');
    expect(said).toContain('not one of the programs this tool runs');
    expect(said).toContain('search_workspace');
    expect(said).toContain('run_command');
  });

  // What a reply did four times over: gave the thing it wanted to find in
  // place of the program that would find it
  it('tells a search term apart from a program, and says how to search for it', () => {
    for (const term of ['llm:cancel', 'llm\\.onEvent', 'onEvent(']) {
      const said = why(term);
      expect(said).toContain('does not name a program');
      expect(said).toContain('search_workspace');
      expect(said).toContain('grep -rn');
    }
    // A name that could be a program is told what the programs are instead
    expect(why('curl https://example.com')).toContain('not one of the programs this tool runs');
  });

  it('refuses an empty command, and an empty half of a pipeline', () => {
    expect(why('   ')).toContain('empty');
    expect(why('ls |')).toContain('empty command between two pipes');
  });

  it('runs nothing it refused: the container is never asked', async () => {
    docker.exec.mockClear();
    await expect(run('rm -rf src')).rejects.toThrow('not one of the programs');
    await expect(run('git log > out.txt')).rejects.toThrow('writes');
    expect(docker.exec).not.toHaveBeenCalled();
  });
});

// Every command here was sent by an agent and refused, in one run of a few
// days: a pattern with a | in it was split on that pipe, and whatever followed
// it was read as the name of the second program ("ctx.workspace\\", "\\bdaily\\b").
// grep alternation is the commonest thing a reader greps for, so this was more
// than a third of every call to the tool.
describe("a pattern that holds the shell's own punctuation", () => {
  it.each([
    ['grep -rn "context.workspace\\|ctx.workspace\\|{ workspace" src --include=*.ts'],
    ['grep -rnE "ModelTotal|\\bdaily\\b|recordUsage" src --include=*.ts'],
    ['grep -n "renderer\\|\\"build\\"\\|typecheck" package.json'],
    ['grep -n "<script\\|Content-Security" index.html'],
    // Not from the logs, but refused the same way: an arrow and an && are
    // the two most searched-for things in a TypeScript project
    ['grep -rn "=>" src --include=*.ts'],
    ['grep -c "&&" src/main.ts'],
    ["grep -rn 'a|b' src"],
    ['grep -rn "a;b" src'],
    // A pattern on one side of a real pipe is still both of those things
    ['grep -rn "a\\|b" src | wc -l'],
  ])('runs %s, the pipe in it being part of the pattern', (command) => {
    expect(refuse(command)).toBeNull();
  });

  it.each([
    // Double quotes do not make these inert: the shell would still run them
    ['grep -n "$(whoami)" x', 'runs a command inside another'],
    ['grep -n "`whoami`" x', 'runs a command inside another'],
    ['grep -n "${HOME}" x', 'expansion'],
    // ...nor are these a pattern just for sitting next to one
    ['grep -rn "a|b" src > out.txt', 'writes'],
    ['grep -rn "a|b" src; rm -rf /', 'more than one command'],
    ['grep -rn "a|b" src & cat y', 'not allowed'],
  ])('still refuses %s', (command, because) => {
    expect(refuse(command) ?? '').toContain(because);
  });

  it('still refuses a pipe into a program it does not run', () => {
    expect(refuse('grep -rn "a|b" src | xargs rm') ?? '').toContain('xargs');
  });
});

describe('what the model is told about it', () => {
  const said = () => unwrapped(tool.description);

  it('names the programs it runs, so the description is the bound itself', () => {
    for (const name of ['git', 'wc', 'grep', 'ls']) expect(said()).toContain(name);
    expect(said()).toContain('--version');
  });

  it('says what it cannot do, and which tool to use instead', () => {
    expect(said()).toContain('cannot change the project');
    expect(said()).toContain('run_command');
    expect(said()).toContain('search_workspace');
  });

  // The copy is made without the project's .git (see filesToCopy in
  // sandbox/docker.ts), so a description that offered git log here sent the
  // reader to a git that finds no repository
  it('sends the history to the host rather than offering it here, the copy having no .git', () => {
    expect(said()).toContain('no .git');
    expect(said()).toContain('run_host_command');
    expect(said()).not.toMatch(/quickest answered by running something[^.]*git log/);
  });

  // It reads, so it is offered wherever there are tools at all, which is what
  // an unset `phases` means (see harness/phases.ts)
  it('belongs to no step in particular, being a tool that reads', () => {
    expect(tool.phases).toBeUndefined();
  });
});
