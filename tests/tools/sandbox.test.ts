import { describe, expect, it } from 'vitest';
import {
  copyHint,
  makesRepository,
  pageFor,
  scratchScript,
  toolsPrompt,
  tools,
  writesFiles,
} from '../../src/tools/sandbox';
import { unwrapped } from '../helpers';

describe('the original of a file the thread has a copy of', () => {
  it('is sent to the copy in the container, and only for a thread with one', () => {
    const context = { threadId: 't', workspace: '/w' };
    // The path is text here, so /w need not exist: a path that is not there resolves to itself
    expect(copyHint(context, '/w/src/a.ts')).toContain('its own copy, at /workspace/src/a.ts,');
    expect(copyHint(context, '/w')).toContain('at /workspace,');
    expect(copyHint(context, '/elsewhere/a.ts')).toBeNull();
    expect(copyHint({ workspace: '/w' }, '/w/src/a.ts')).toBeNull();
    expect(copyHint({ threadId: 't' }, '/w/src/a.ts')).toBeNull();
  });
});

const ALL = ['run_command', 'read_file', 'write_file', 'edit_file', 'search_workspace', 'list_workspace'];

describe('which tool to use for what', () => {
  it('sends searching, listing, reading and editing to their own tools rather than run_command', () => {
    const said = toolsPrompt(ALL);
    for (const name of ['search_workspace', 'list_workspace', 'read_file', 'edit_file', 'write_file']) {
      expect(said).toContain(name);
    }
    expect(said).toMatch(/no grep/);
    expect(said).toMatch(/Python/);
  });

  it('says how to show a page that needs clicking, with a demo copy of the project in /tmp/demo', () => {
    const said = toolsPrompt([...ALL, 'screenshot']);
    expect(said).toContain('/tmp/demo');
    expect(said).toContain('steps');
  });

  // The way to run the app goes with the tool that runs it (see ../../src/sandbox/recipes.ts)
  it("says how the workspace's app is run to a model that can run it, and only to one in a workspace", () => {
    const said = unwrapped(toolsPrompt([...ALL, 'use_app'], '/projects/none-saved'));
    expect(said).toContain('no run recipe');
    expect(said).toContain('save_run_recipe');
    expect(toolsPrompt(ALL, '/projects/none-saved')).not.toContain('run recipe');
    expect(toolsPrompt([...ALL, 'use_app'])).not.toContain('run recipe');
  });

  it('names only the tools the model has', () => {
    const said = toolsPrompt(['run_command', 'read_file', 'search_workspace']);
    expect(said).toContain('search_workspace');
    expect(said).toContain('read_file');
    expect(said).not.toContain('list_workspace');
    expect(said).not.toContain('edit_file');
  });

  // A thread told that run_command is for "git and the like" runs git in a
  // copy that has no .git, reads "not a git repository", and concludes the
  // project is not kept in one — which is what happened to a thread asked to
  // squash its changes into a commit
  it('does not offer version control in the copy, and sends the history to the host', () => {
    const said = toolsPrompt([...ALL, 'run_host_command']);
    expect(said).toContain('Not version control');
    expect(said).toContain('without its .git');
    expect(said).toContain('run_host_command');
    expect(said).not.toMatch(/installing dependencies, git/);
  });

  it('says nothing where there is no run_command to warn off, or nothing to use instead', () => {
    expect(toolsPrompt(['read_file', 'search_workspace'])).toBe('');
    expect(toolsPrompt(['run_command'])).toBe('');
  });
});

// How much of a file one read returns. Four hundred lines of real source is
// about six thousand tokens once each carries its line number — a fifth of a
// 32k window in one call, and the 2000-line ceiling is more than such a window
// holds at all. So the page follows the window, and the old numbers are the
// ceiling rather than the rule (see pageFor).
describe('how much of a file a read returns', () => {
  it('is the old page and the old ceiling for a model that does not say its window', () => {
    expect(pageFor()).toEqual({ lines: 400, most: 2000 });
  });

  it('is unchanged for a window with room to spare', () => {
    expect(pageFor(200_000)).toEqual({ lines: 400, most: 2000 });
  });

  it('shrinks with the window, so that no one call can take it over', () => {
    const pages = [200_000, 128_000, 64_000, 32_000, 16_000].map((w) => pageFor(w).lines);
    for (let i = 1; i < pages.length; i++) expect(pages[i]).toBeLessThan(pages[i - 1]);
    // A page is a small share of the window at every size, where it used to be
    // a fifth of a small one and more than the whole of the smallest
    for (const window of [16_000, 32_000, 64_000, 128_000]) {
      const { lines, most } = pageFor(window);
      expect(lines * 15).toBeLessThan(window * 0.1);
      // ...and what one call may ask for outright still fits
      expect(most * 15).toBeLessThan(window * 0.8);
    }
  });

  it('keeps a page worth reading however small the window', () => {
    for (const window of [1000, 4000, 8000]) expect(pageFor(window).lines).toBeGreaterThanOrEqual(40);
  });

  it('tells the model the page it will get, not the one the largest model gets', () => {
    const read = tools.find((tool) => tool.name === 'read_file');
    const small = pageFor(32_000);
    expect(unwrapped(read!.describe!(undefined, 32_000))).toContain(`${small.lines} lines at a time by default`);
    // ...and the same number where it asks for a count, with its own ceiling
    const schema = read!.schemaFor!(undefined, 32_000) as {
      properties: { line_count: { description: string } };
    };
    expect(schema.properties.line_count.description).toContain(`Defaults to ${small.lines}`);
    expect(schema.properties.line_count.description).toContain(`at most ${small.most}`);
    // The unchanged numbers for a model with room, which is what the static
    // description and schema still say
    expect(unwrapped(read!.description)).toContain('400 lines at a time by default');
    expect(unwrapped(read!.describe!(undefined, 200_000))).toContain('400 lines at a time by default');
  });
});

// The guard is there so a shell write cannot race an edit_file for the same
// file, which needs them to be the same file: scratch space is nobody's
// project (see src/tools/sandbox.ts SCRATCH)
// A thread asked to squash its changes into a commit ran `git status`, was told
// "not a git repository", took the project for one kept in no version control,
// and made its own with `git init` — a commit the user can never receive
describe('whether a command makes a repository in the copy', () => {
  it.each([
    ['git init'],
    ['git init --bare'],
    ['git add -A && git commit -m "Initial commit"'],
    ['git -c user.name=ch -c user.email=ch@localhost commit -m x'],
    ['git --no-pager commit --amend'],
    ['sudo git init'],
  ])('refuses %s', (command) => {
    expect(makesRepository(command)).toBe(true);
  });

  it.each([
    // The baseline is the app's own repository, kept outside the copy, and the
    // commands that read it name it: those are left alone (see writesFiles)
    ['git --git-dir=/var/lib/ch-baseline.git show HEAD:src/a.ts > /tmp/base.ts'],
    // A scratch repository somewhere that is not the project is the model's
    // business, as is any git that only reads
    ['cd /tmp/demo && git init && git add -A'],
    ['git -C /tmp/demo commit -m x'],
    ['git log --oneline -5'],
    ['git status'],
    // The word in a message or in something else's arguments is not a command
    ['echo "git init"'],
    ['npm run commit'],
  ])('lets %s through', (command) => {
    expect(makesRepository(command)).toBe(false);
  });

  it('says what it would cost and what to do instead, which is what the model can act on', async () => {
    const run = tools.find(({ name }) => name === 'run_command')!.run;
    const context = { signal: new AbortController().signal, threadId: 't1' } as never;
    await expect(run({ command: 'git init' }, context)).rejects.toThrow('without its .git');
    await expect(run({ command: 'git init' }, context)).rejects.toThrow('run_host_command');
    await expect(run({ command: 'git init' }, context)).rejects.toThrow('changes for them to apply');
  });
});

describe('whether a command writes a file the guard is for', () => {
  it.each([
    // Both commands the log shows refused: a thread comparing its own work
    // against the baseline, which it cannot do without somewhere to put it
    ['git --git-dir=/var/lib/ch-baseline.git show HEAD:tests/a.test.ts > /tmp/base.ts'],
    ['git merge-file -p a.ts /tmp/base.ts b.ts > /tmp/merged.ts; grep -c "^<<<<<<<" /tmp/merged.ts'],
    ['npx vitest run 2>&1 | tee /tmp/out.log'],
    ['npx vitest run 2>&1 | tee -a /tmp/out.log'],
    ['cat x > /var/tmp/scratch'],
    ['dd if=x of=/tmp/copy'],
    // What the guard already allowed, and still does
    ['npx vitest run 2>&1 | tail -8'],
    ['cat x > /dev/null'],
    ['grep -rn "=>" src'],
  ])('lets %s through', (command) => {
    expect(writesFiles(command)).toBe(false);
  });

  it.each([
    ['cat x > out.txt'],
    ['cat x >> src/notes.md'],
    ['cat x > /workspace/src/a.ts'],
    ['echo hi | tee src/a.ts'],
    ['echo hi | tee -a src/a.ts'],
    ['sed -i "s/a/b/" src/a.ts'],
    ['truncate -s 0 src/a.ts'],
    ['dd if=x of=src/a.ts'],
    // /tmp is where it may write, not a word that excuses the rest of the line
    ['cat /tmp/base.ts > src/a.ts'],
  ])('still refuses %s', (command) => {
    expect(writesFiles(command)).toBe(true);
  });

  it('tells the model where it may write, that being the thing it can act on', () => {
    const schema = tools.find(({ name }) => name === 'run_command')?.inputSchema as {
      properties: { command: { description: string } };
    };
    const said = unwrapped(schema.properties.command.description);
    expect(said).toContain('/tmp');
    expect(said).toContain('write_file');
  });

  // What the copy is, and what it is not: a git that finds no repository here
  // is the copy's doing and not the project's, and a commit made here is lost
  it('says the copy was made without the project .git, so a repository made in it goes nowhere', () => {
    const said = unwrapped(tools.find(({ name }) => name === 'run_command')!.description!);
    expect(said).toContain('without its .git');
    expect(said).toContain('never reaches them');
    expect(said).toContain('changes for');
    expect(said).not.toMatch(/installing[^.]*, git and the like/);
  });
});

// A script of the model's own, run apart from the app, is answered with a word
// about the app's own tools and the project's tests rather than refused
describe('whether a command runs a scratch script', () => {
  it.each([
    ["cat > /tmp/check.ts <<'EOF'\nimport { load } from '/workspace/src/store';\nEOF"],
    ['npx tsx /tmp/check.ts'],
    ['node /tmp/repro.mjs'],
    ['python3 /tmp/try.py'],
    [`node -e "const s = require('./dist/store'); console.log(s.load())"`],
    [`python -c "import app; print(app.run())"`],
  ])('notices %s', (command) => {
    expect(scratchScript(command)).toBe(true);
  });

  it.each([
    ['npx vitest run'],
    ['node -e "console.log(process.version)"'],
    ['node dist/main.js'],
    ['git --git-dir=/var/lib/ch-baseline.git show HEAD:src/a.ts > /tmp/base.ts'],
    ['cp -r . /tmp/demo'],
  ])('leaves %s alone', (command) => {
    expect(scratchScript(command)).toBe(false);
  });
});
