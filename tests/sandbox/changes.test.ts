import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The thread's container is stood in for by a record of what Git there would
// say: the changed files, and the contents behind each blob id. The workspace on
// the user's side is a real one, and files are merged with the real Git.
const container = vi.hoisted(() => ({
  exists: true,
  hasRecord: true,
  // The record's files, as "path id" lines: what `ls-tree` would answer
  tree: [] as string[],
  // What has been written into the container, by path
  wrote: {} as Record<string, string>,
  // ...and what has been removed from it
  removed: [] as string[],
  // "status path beforeId afterId [afterMode]" lines; an id of 0 means no file on that side
  changes: [] as string[],
  blobs: {} as Record<string, string | Buffer>,
  patch: '',
  ran: [] as string[],
  // How many times the record's files were read in one go, rather than one
  // command at a time (see docker.readEach)
  batches: 0,
  // The tree `write-tree` answers with: the files in the container as they
  // stand. Changing it stands for the files having been changed.
  treeId: 'tree-now',
  // ...and the tree of the record's last commit, which is where the files
  // started out
  headTree: 'tree-head',
  // What `read-tree` was told to put back, and whether `clean` followed it
  restored: null as string | null,
  cleaned: false,
  // Whether the workspace's files can be listed as a Git repository's are.
  // False stands for a workspace that is not one (see docker.filesToCopy).
  listable: true,
  // The clashes the thread was handed last time, as the record's own
  // directory holds them (see CLASHES)
  clashState: null as string | null,
  // The files whose change the record has been moved on for (see settle)
  settled: [] as string[],
  // Filled in below, once the real one can be reached from here
  blobOf: null as null | ((content: string) => string),
}));

const CLASHES = '/var/lib/ch-baseline.git/ch-clashes.json';

vi.mock('../../src/sandbox/docker', () => {
  // One command, as Git in the container would answer it
  const answer = (command: string) => {
    const data = (text: string | Buffer, code = 0) => ({ code, data: Buffer.from(text) });
    if (!container.hasRecord) return data('', 127);
    // `add -A` before the changes are told, and `add -- <paths>` for the files
    // brought in from the workspace
    if (command.startsWith('GIT add')) return data('');
    if (command.startsWith('GIT diff --cached --raw')) {
      const id = (short: string) => (short === '0' ? '0'.repeat(40) : short.padEnd(40, 'f'));
      return data(
        container.changes
          .map((line) => {
            const [status, file, before, after, mode = '100644'] = line.split(' ');
            const modes = `${before === '0' ? '000000' : '100644'} ${after === '0' ? '000000' : mode}`;
            return `:${modes} ${id(before)} ${id(after)} ${status}\0${file}\0`;
          })
          .join('')
      );
    }
    if (command.startsWith('GIT diff --cached --no-renames')) return data(container.patch);
    if (command.startsWith('GIT ls-tree')) {
      const id = (short: string) => short.padEnd(40, 'f');
      return data(
        container.tree
          .map((line) => {
            const [file, blob] = line.split(' ');
            return `100644 blob ${id(blob)}\t${file}\0`;
          })
          .join('')
      );
    }
    const blob = /^GIT cat-file blob '(\w+?)f*'$/.exec(command);
    if (blob) return blob[1] in container.blobs ? data(container.blobs[blob[1]]) : data('', 128);
    if (command.startsWith('GIT commit')) return data('');
    // Taking a snapshot of the files, and putting them back to one
    if (command.startsWith('GIT write-tree')) return data(`${container.treeId}\n`);
    if (command.startsWith('GIT rev-parse')) return data(`${container.headTree}\n`);
    const back = /^GIT read-tree -u --reset '(.+)'$/.exec(command);
    if (back) {
      container.restored = back[1];
      return data('');
    }
    if (command.startsWith('GIT clean')) {
      container.cleaned = true;
      return data('');
    }
    // What the thread was handed last time, kept where the thread cannot
    // reach it (see CLASHES)
    if (command === `cat '${CLASHES}'`) return container.clashState === null ? data('', 1) : data(container.clashState);
    // A file read straight out of the container, as filesText reads them:
    // what has been written there, or the shell's own code for a file it
    // could not read
    const cat = /^cat '(.*)'$/.exec(command);
    if (cat) return cat[1] in container.wrote ? data(container.wrote[cat[1]]) : data('', 1);
    throw new Error(`unexpected command: ${command}`);
  };
  return {
    BASELINE: 'GIT',
    BASELINE_DIR: '/var/lib/ch-baseline.git',
    AGENT_DIR: '.agent',
    WORKDIR: '/workspace',
    quote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
    // The project's files in the workspace, which here is every file in it
    filesToCopy: async (workspace: string) => {
      if (!container.listable) return null;
      const list = (dir: string, prefix = ''): string[] =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((entry) =>
            entry.isDirectory() ? list(`${dir}/${entry.name}`, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
          );
      return list(workspace);
    },
    // Writing a file into the container, and taking one out of it
    exec: async (_threadId: string, command: string, { input }: { input?: string | Buffer } = {}) => {
      if (!container.exists) return { code: 1, output: 'no container' };
      // Moving on what one file's change is measured from (see settle): the
      // record takes the workspace's version, the files themselves untouched
      const took = /update-index --add --cacheinfo \d+,\$ch_blob,'(.+?)'/.exec(command);
      const dropped = /update-index --force-remove '(.+?)'/.exec(command);
      if ((took || dropped) && command.includes('commit-tree')) {
        const file = (took ?? dropped)![1];
        container.tree = container.tree.filter((line) => line.slice(0, line.lastIndexOf(' ')) !== file);
        if (took) container.tree.push(`${file} ${container.blobOf!(String(input ?? ''))}`);
        container.settled.push(file);
        return { code: 0, output: '' };
      }
      const toClashes = new RegExp(`^cat > '${CLASHES}'$`).exec(command);
      if (toClashes) {
        container.clashState = String(input ?? '');
        return { code: 0, output: '' };
      }
      const written = /cat > '(.+?)'$/.exec(command);
      if (written) {
        container.wrote[written[1]] = Buffer.isBuffer(input) ? input.toString('utf8') : (input ?? '');
        return { code: 0, output: '' };
      }
      const removed = /^rm -f '(.+?)'$/.exec(command);
      if (removed) {
        container.removed.push(removed[1]);
        return { code: 0, output: '' };
      }
      throw new Error(`unexpected exec: ${command}`);
    },
    read: async (_threadId: string, command: string) => {
      if (!container.exists) return null;
      container.ran.push(command);
      return answer(command);
    },
    // Several commands in one go, which is how the record's files are read
    // (see docker.readEach); each is answered exactly as it would be alone
    readEach: async (_threadId: string, commands: string[]) => {
      if (!container.exists) return null;
      container.batches++;
      return commands.map((command) => {
        container.ran.push(command);
        return answer(command);
      });
    },
  };
});

import {
  WORKSPACE_COPIES,
  apply,
  describeChanges,
  filesText,
  list,
  report,
  revert,
  snapshot,
  sync,
} from '../../src/sandbox/changes';

const THREAD = '0ad34c48-11d6-466f-8567-79d2df9819bc';
let workspace: string;
const put = (name: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
  fs.writeFileSync(path.join(workspace, name), content);
};
const read = (name: string) => fs.readFileSync(path.join(workspace, name), 'utf8');
const exists = (name: string) => fs.existsSync(path.join(workspace, name));
const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-changes-'));
  Object.assign(container, {
    exists: true,
    hasRecord: true,
    changes: [],
    blobs: {},
    patch: '',
    ran: [],
    batches: 0,
    tree: [],
    wrote: {},
    removed: [],
    treeId: 'tree-now',
    headTree: 'tree-head',
    restored: null,
    cleaned: false,
    listable: true,
    clashState: null,
    settled: [],
  });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('list', () => {
  it('names each changed file with what changed in it', async () => {
    container.changes = ['M src/a.ts a1 a2', 'A src/new.ts 0 n1', 'D gone.txt g1 0', 'A img.png 0 i1'];
    container.patch = [
      'diff --git a/src/a.ts b/src/a.ts\n' +
        'index a1..a2 100644\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -1,2 +1,2 @@\n' +
        ' line 1\n' +
        '-old\n' +
        '+new\n',
      'diff --git a/src/new.ts b/src/new.ts\n' +
        'new file mode 100644\n' +
        'index 0000000..n1\n' +
        '--- /dev/null\n' +
        '+++ b/src/new.ts\n' +
        '@@ -0,0 +1 @@\n' +
        '+hello\n',
      'diff --git a/gone.txt b/gone.txt\n' +
        'deleted file mode 100644\n' +
        'index g1..0000000\n' +
        '--- a/gone.txt\n' +
        '+++ /dev/null\n' +
        '@@ -1 +0,0 @@\n' +
        '-bye\n',
      'diff --git a/img.png b/img.png\n' +
        'new file mode 100644\n' +
        'index 0000000..i1\n' +
        'Binary files /dev/null and b/img.png differ\n',
    ].join('');
    await expect(list(THREAD)).resolves.toEqual({
      files: [
        { path: 'src/a.ts', status: 'modified', binary: false, diff: '@@ -1,2 +1,2 @@\n line 1\n-old\n+new' },
        { path: 'src/new.ts', status: 'added', binary: false, diff: '@@ -0,0 +1 @@\n+hello' },
        { path: 'gone.txt', status: 'deleted', binary: false, diff: '@@ -1 +0,0 @@\n-bye' },
        { path: 'img.png', status: 'added', binary: true, diff: 'Binary files /dev/null and b/img.png differ' },
      ],
    });
    // New files are taken note of before the comparison is made
    expect(container.ran[0]).toBe('GIT add -A');
  });

  it('cuts a very long diff short', async () => {
    container.changes = ['M big.txt b1 b2'];
    const header = 'diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n';
    container.patch = `${header}${'+x\n'.repeat(20000)}`;
    const [file] = (await list(THREAD)).files;
    expect(file.diff.length).toBeLessThan(21000);
    expect(file.diff.endsWith('[diff cut short]')).toBe(true);
  });

  it('is empty when nothing has changed, or when the thread has no container', async () => {
    await expect(list(THREAD)).resolves.toEqual({ files: [] });
    container.exists = false;
    await expect(list(THREAD)).resolves.toEqual({ files: [] });
  });

  it('says so when the container has no record of the files to compare with', async () => {
    container.hasRecord = false;
    const result = await list(THREAD);
    expect(result.files).toEqual([]);
    expect(result.unavailable).toContain("changes can't be told");
  });
});

describe('reading several files as the thread has them', () => {
  it('gives each file its text, and null for one there is nothing to read', async () => {
    container.wrote['one.ts'] = 'first';
    const read = await filesText(THREAD, ['one.ts', 'gone.ts']);
    expect(read?.get('one.ts')).toBe('first');
    expect(read?.get('gone.ts')).toBeNull();
  });

  it('gives null for the whole read when the thread has no container', async () => {
    // Not a map of nulls: a file that is not there and a container that is
    // not there are different answers, and the search falls back to the
    // workspace's own files for the second (see ../../src/search/embeddings.ts)
    container.exists = false;
    await expect(filesText(THREAD, ['one.ts'])).resolves.toBeNull();
  });
});

describe("the thread's own notes", () => {
  it('are not shown as a change to look over', async () => {
    container.changes = ['A .agent/context.md 0 c1', 'M src/a.ts a1 a2'];
    container.patch =
      'diff --git a/src/a.ts b/src/a.ts\n' +
      'index a1..a2 100644\n' +
      '--- a/src/a.ts\n' +
      '+++ b/src/a.ts\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const { files } = await list(THREAD);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('are not written back to the workspace', async () => {
    put('src/a.ts', 'old\n');
    container.changes = ['A .agent/context.md 0 c1', 'A .agent/notes/plan.md 0 c2', 'M src/a.ts a1 a2'];
    container.blobs = { c1: 'what I was doing\n', c2: 'more\n', a1: 'old\n', a2: 'new\n' };

    await expect(apply(THREAD, workspace)).resolves.toEqual({ applied: ['src/a.ts'], conflicts: [], skipped: [] });
    expect(read('src/a.ts')).toBe('new\n');
    // Nothing of the thread's own is left in the user's workspace
    expect(exists('.agent')).toBe(false);
    expect(exists('.agent/context.md')).toBe(false);
  });

  it('count as no change at all when they are the only thing the thread wrote', async () => {
    container.changes = ['A .agent/context.md 0 c1'];
    container.blobs = { c1: 'what I was doing\n' };
    await expect(list(THREAD)).resolves.toEqual({ files: [] });
    await expect(apply(THREAD, workspace)).resolves.toEqual({ applied: [], conflicts: [], skipped: [] });
    expect(exists('.agent')).toBe(false);
  });

  it('are told apart from a file of the project that merely starts the same way', async () => {
    put('.agentrc', 'keep\n');
    container.changes = ['M .agentrc r1 r2', 'A .agent-tools/go.sh 0 t1'];
    container.blobs = { r1: 'keep\n', r2: 'changed\n', t1: 'echo hi\n' };
    const { files } = await list(THREAD);
    expect(files.map((f) => f.path)).toEqual(['.agentrc', '.agent-tools/go.sh']);
    await expect(apply(THREAD, workspace)).resolves.toMatchObject({ applied: ['.agentrc', '.agent-tools/go.sh'] });
    expect(read('.agentrc')).toBe('changed\n');
  });
});

describe('apply', () => {
  it('writes changed and added files, deletes deleted ones, and moves the record on', async () => {
    put('src/a.ts', lines('one', 'two'));
    put('gone.txt', 'bye\n');
    container.changes = ['M src/a.ts a1 a2', 'A deep/er/run.sh 0 r1 100755', 'D gone.txt g1 0'];
    container.blobs = { a1: lines('one', 'two'), a2: lines('one', 'TWO'), r1: '#!/bin/sh\n', g1: 'bye\n' };

    await expect(apply(THREAD, workspace)).resolves.toEqual({
      applied: ['src/a.ts', 'deep/er/run.sh', 'gone.txt'],
      conflicts: [],
      skipped: [],
    });
    expect(read('src/a.ts')).toBe(lines('one', 'TWO'));
    expect(read('deep/er/run.sh')).toBe('#!/bin/sh\n');
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(workspace, 'deep/er/run.sh')).mode & 0o111).not.toBe(0);
    expect(exists('gone.txt')).toBe(false);
    expect(container.ran.at(-1)).toBe('GIT commit -q --allow-empty -m applied');
  });

  it("keeps the user's own edits to a file the thread also changed, when they don't overlap", async () => {
    const base = lines('1', '2', '3', '4', '5', '6', '7', '8');
    put('a.txt', base.replace('7', 'seven (user)'));
    container.changes = ['M a.txt a1 a2'];
    container.blobs = { a1: base, a2: base.replace('2', 'two (thread)') };

    await expect(apply(THREAD, workspace)).resolves.toMatchObject({ applied: ['a.txt'], conflicts: [] });
    expect(read('a.txt')).toBe(lines('1', 'two (thread)', '3', '4', '5', '6', 'seven (user)', '8'));
  });

  it('writes nothing at all when any file clashes with what is in the workspace', async () => {
    put('clash.txt', lines('user', 'same'));
    put('fine.txt', 'before\n');
    container.changes = ['M fine.txt f1 f2', 'M clash.txt c1 c2'];
    container.blobs = { f1: 'before\n', f2: 'after\n', c1: lines('same', 'same'), c2: lines('thread', 'same') };

    await expect(apply(THREAD, workspace)).resolves.toEqual({
      applied: [],
      conflicts: [{ path: 'clash.txt', reason: 'The same lines were changed in the workspace and by the thread.' }],
      skipped: [],
    });
    expect(read('fine.txt')).toBe('before\n');
    expect(read('clash.txt')).toBe(lines('user', 'same'));
    // The record stays where it was, so the same changes can be tried again
    expect(container.ran.some((command) => command.startsWith('GIT commit'))).toBe(false);
  });

  it.each([
    [
      'a file the thread added already exists with other contents',
      'A new.txt 0 n1',
      { n1: 'thread\n' },
      'user\n',
      'added it, but the workspace now has a different file',
    ],
    [
      'a file the thread changed has been deleted from the workspace',
      'M a.txt a1 a2',
      { a1: 'one\n', a2: 'two\n' },
      null,
      'has been deleted from the workspace',
    ],
    [
      'a file the thread deleted has changed in the workspace',
      'D a.txt a1 0',
      { a1: 'one\n' },
      'edited\n',
      'deleted it, but it has changed in the workspace',
    ],
    [
      'a file that is not text changed on both sides',
      'M a.bin a1 a2',
      { a1: Buffer.from([0, 1]), a2: Buffer.from([0, 2]) },
      Buffer.from([0, 3]),
      'not a text file',
    ],
  ])('reports a clash when %s', async (_name, change, blobs, ours, reason) => {
    const file = change.split(' ')[1];
    if (ours !== null) put(file, ours);
    container.changes = [change];
    container.blobs = blobs;
    const result = await apply(THREAD, workspace);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([{ path: file, reason: expect.stringContaining(reason) }]);
  });

  it('has nothing to do where the workspace already matches the thread', async () => {
    put('same.txt', 'new\n');
    container.changes = ['M same.txt s1 s2', 'A added.txt 0 s2', 'D gone.txt g1 0'];
    put('added.txt', 'new\n');
    container.blobs = { s1: 'old\n', s2: 'new\n', g1: 'bye\n' };
    await expect(apply(THREAD, workspace)).resolves.toEqual({ applied: [], conflicts: [], skipped: [] });
  });

  it('replaces a file that is not text when the workspace has not touched it', async () => {
    put('img.bin', Buffer.from([0, 1]));
    container.changes = ['M img.bin i1 i2'];
    container.blobs = { i1: Buffer.from([0, 1]), i2: Buffer.from([0, 9, 9]) };
    await expect(apply(THREAD, workspace)).resolves.toMatchObject({ applied: ['img.bin'] });
    expect(fs.readFileSync(path.join(workspace, 'img.bin'))).toEqual(Buffer.from([0, 9, 9]));
  });

  it('leaves links out, and writes the rest', async () => {
    container.changes = ['A link 0 l1 120000', 'A real.txt 0 r1'];
    container.blobs = { l1: '/etc/passwd', r1: 'real\n' };
    await expect(apply(THREAD, workspace)).resolves.toEqual({
      applied: ['real.txt'],
      conflicts: [],
      skipped: [{ path: 'link', reason: 'Links and nested repositories are not written back.' }],
    });
    expect(exists('link')).toBe(false);
  });

  it("reads every changed file's contents in one command, not two for each", async () => {
    container.changes = ['M one.ts a1 a2', 'M two.ts b1 b2', 'M three.ts c1 c2', 'M four.ts d1 d2'];
    container.blobs = { a1: 'a', a2: 'A', b1: 'b', b2: 'B', c1: 'c', c2: 'C', d1: 'd', d2: 'D' };
    for (const [file, was] of [
      ['one.ts', 'a'],
      ['two.ts', 'b'],
      ['three.ts', 'c'],
      ['four.ts', 'd'],
    ])
      put(file, was);

    await expect(apply(THREAD, workspace)).resolves.toMatchObject({ conflicts: [], applied: expect.any(Array) });

    // Eight blobs behind four files, and one command for the lot: on its own
    // each cost about 55ms of Docker before it read anything
    expect(container.ran.filter((c) => c.startsWith('GIT cat-file'))).toHaveLength(8);
    expect(container.batches).toBe(1);
  });

  it('never writes outside the workspace', async () => {
    container.changes = ['A ../escaped.txt 0 e1'];
    container.blobs = { e1: 'out\n' };
    const result = await apply(THREAD, workspace);
    expect(result.skipped).toEqual([{ path: '../escaped.txt', reason: 'It is outside the workspace.' }]);
    expect(fs.existsSync(path.join(workspace, '..', 'escaped.txt'))).toBe(false);
  });

  it('does nothing when there are no changes or no container, and reports a failure without throwing', async () => {
    await expect(apply(THREAD, workspace)).resolves.toEqual({ applied: [], conflicts: [], skipped: [] });
    container.exists = false;
    await expect(apply(THREAD, workspace)).resolves.toEqual({ applied: [], conflicts: [], skipped: [] });

    container.exists = true;
    container.changes = ['M a.txt a1 a2'];
    put('a.txt', 'one\n');
    // The contents can't be read back from the thread
    const result = await apply(THREAD, workspace);
    expect(result).toMatchObject({ applied: [], error: 'Could not read a file from the thread.' });
    expect(read('a.txt')).toBe('one\n');
  });
});

// What Git calls a file's content, which is how the record and the workspace
// are told apart (see blobId in changes.ts)
const blobOf = (content: string) =>
  crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
container.blobOf = blobOf;
// A file in the workspace, and the record agreeing with it
const agreed = (name: string, content: string) => {
  put(name, content);
  container.tree.push(`${name} ${blobOf(content)}`);
};

describe('being brought level with the workspace', () => {
  it('says so, and does nothing, when the workspace has not moved on', async () => {
    agreed('src/a.ts', lines('one', 'two'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: lines('one', 'two'), a2: lines('one', 'two', 'three') };

    const synced = await sync(THREAD, workspace);
    expect(synced).toEqual({ pulled: [], merged: [], clashes: [] });
    expect(report(synced)).toContain('has not moved on');
  });

  it('brings in a file the workspace changed that the thread had not touched', async () => {
    agreed('src/other.ts', lines('as it was'));
    // ...and the workspace has moved on since the record was made
    put('src/other.ts', lines('as it is now'));

    const synced = await sync(THREAD, workspace);
    expect(synced.pulled).toEqual(['src/other.ts']);
    expect(container.wrote['src/other.ts']).toBe(lines('as it is now'));
    // The record moves with it, so it is nobody's change to write back
    expect(container.ran).toContain("GIT add -- 'src/other.ts'");
    expect(container.ran).toContain("GIT commit -q -m pulled -- 'src/other.ts'");
    expect(report(synced)).toContain('out of date');
  });

  it('takes out of the container a file the workspace no longer has', async () => {
    container.tree.push(`gone.txt ${blobOf('old')}`);
    const synced = await sync(THREAD, workspace);
    expect(synced.pulled).toEqual(['gone.txt']);
    expect(container.removed).toEqual(['gone.txt']);
  });

  it('puts together a file both changed where the changes go together', async () => {
    const base = lines('one', 'two', 'three');
    agreed('src/a.ts', base);
    // The workspace changed the first line, the thread the last
    put('src/a.ts', lines('ONE', 'two', 'three'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: base, a2: lines('one', 'two', 'THREE') };

    const synced = await sync(THREAD, workspace);
    expect(synced).toMatchObject({ pulled: [], merged: ['src/a.ts'], clashes: [] });
    // The thread's copy holds both changes now, rather than being told the
    // two fit and left on its own version of the file
    expect(container.wrote['src/a.ts']).toBe(lines('ONE', 'two', 'THREE'));
    // ...and its change is measured from the workspace's version from now on
    expect(container.settled).toEqual(['src/a.ts']);
    expect(report(synced)).toContain('went together');
  });

  it('settles a clash the thread has worked on since being handed it', async () => {
    const base = lines('one', 'two');
    agreed('src/a.ts', base);
    put('src/a.ts', lines('one', 'theirs'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: base, a2: lines('one', 'ours') };

    expect((await sync(THREAD, workspace)).clashes).toHaveLength(1);

    // The thread does what it was told: reads the workspace's version and
    // makes its file hold both changes. Measured against the file as it was
    // when the container was copied, that still clashes on the same lines.
    container.changes = ['M src/a.ts a1 a3'];
    container.blobs = { a1: base, a3: lines('one', 'theirs', 'ours') };

    const settled = await sync(THREAD, workspace);
    expect(settled).toMatchObject({ merged: ['src/a.ts'], clashes: [] });
    // Its version goes back as it stands, so the workspace's is what the
    // change is measured from now
    expect(container.settled).toEqual(['src/a.ts']);
    // ...and the copy it was given to read is cleared away with it
    expect(container.removed).toContain(`${WORKSPACE_COPIES}/src/a.ts`);
  });

  it('hands back a clash the thread has left alone, rather than taking its version', async () => {
    const base = lines('one', 'two');
    agreed('src/a.ts', base);
    put('src/a.ts', lines('one', 'theirs'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: base, a2: lines('one', 'ours') };

    expect((await sync(THREAD, workspace)).clashes).toHaveLength(1);
    expect((await sync(THREAD, workspace)).clashes).toHaveLength(1);
    expect(container.settled).toEqual([]);
  });

  it('opens a settled clash again where the workspace has moved on once more', async () => {
    const base = lines('one', 'two');
    agreed('src/a.ts', base);
    put('src/a.ts', lines('one', 'theirs'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: base, a2: lines('one', 'ours') };
    expect((await sync(THREAD, workspace)).clashes).toHaveLength(1);

    // The thread settled what it was shown, but the user has written
    // something else since, which it has not seen
    container.changes = ['M src/a.ts a1 a3'];
    container.blobs = { a1: base, a3: lines('one', 'theirs', 'ours') };
    put('src/a.ts', lines('one', 'theirs again'));

    const synced = await sync(THREAD, workspace);
    expect(synced.clashes).toHaveLength(1);
    expect(container.settled).toEqual([]);
    expect(container.wrote[`${WORKSPACE_COPIES}/src/a.ts`]).toBe(lines('one', 'theirs again'));
  });

  it('never takes a file it did not look at for one the workspace has deleted', async () => {
    // More files have moved than can be dealt with in one go
    for (let at = 0; at < 501; at++) put(`new/${String(at).padStart(4, '0')}.ts`, 'new');
    // ...and one the record and the workspace agree on, after all of them
    agreed('zzz.ts', 'kept');

    const synced = await sync(THREAD, workspace);
    expect(synced.cut).toBe(1);
    expect(synced.pulled).toHaveLength(500);
    expect(container.removed).toEqual([]);
    expect(report(synced)).toContain('than can be dealt with in one go');
  });

  it('works in a workspace that is not a Git repository', async () => {
    container.listable = false;
    container.tree.push(`a.ts ${blobOf('as it was')}`);
    put('a.ts', 'as it is now');

    const synced = await sync(THREAD, workspace);
    expect(synced.pulled).toEqual(['a.ts']);
    expect(container.wrote['a.ts']).toBe('as it is now');
  });

  it('says so, and empties nothing, when the workspace cannot be read at all', async () => {
    container.listable = false;
    container.tree.push(`a.ts ${blobOf('one')}`, `b.ts ${blobOf('two')}`);

    const synced = await sync(THREAD, workspace);
    expect(synced.error).toContain('could not be read');
    // Not a workspace the user emptied: nothing is taken out of the container
    expect(container.removed).toEqual([]);
  });

  it('hands back a clash with the workspace’s version where the thread can read it', async () => {
    const base = lines('one', 'two');
    agreed('src/a.ts', base);
    put('src/a.ts', lines('one', 'theirs'));
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: base, a2: lines('one', 'ours') };

    const synced = await sync(THREAD, workspace);
    expect(synced.merged).toEqual([]);
    expect(synced.clashes).toEqual([
      {
        path: 'src/a.ts',
        reason: 'The same lines were changed in the workspace and by the thread.',
        copy: `${WORKSPACE_COPIES}/src/a.ts`,
      },
    ]);
    // The workspace's version is in the thread's own corner, which is never
    // written back and never shown as a change
    expect(container.wrote[`${WORKSPACE_COPIES}/src/a.ts`]).toBe(lines('one', 'theirs'));
    const said = report(synced);
    expect(said).toContain('cannot be put together');
    expect(said).toContain(`The workspace's version is at ${WORKSPACE_COPIES}/src/a.ts`);
    expect(said).toContain('call this tool again');
  });

  it('says there is nothing to read when the clash is with a file the workspace deleted', async () => {
    container.tree.push(`src/a.ts ${blobOf(lines('one'))}`);
    container.changes = ['M src/a.ts a1 a2'];
    container.blobs = { a1: lines('one'), a2: lines('ours') };

    const synced = await sync(THREAD, workspace);
    expect(synced.clashes).toEqual([
      {
        path: 'src/a.ts',
        reason: 'The thread changed it, but it has been deleted from the workspace.',
        copy: '',
      },
    ]);
    expect(report(synced)).toContain('no version in the workspace to read');
  });

  it('leaves the thread’s own notes out of it, as the changes do', async () => {
    container.tree.push(`.agent/context.md ${blobOf('old notes')}`);
    put('.agent/context.md', 'notes the workspace happens to have');
    expect(await sync(THREAD, workspace)).toEqual({ pulled: [], merged: [], clashes: [] });
    expect(container.wrote).toEqual({});
  });

  it('gives back what went wrong rather than throwing it at the reply', async () => {
    container.hasRecord = false;
    const synced = await sync(THREAD, workspace);
    expect(synced.error).toContain('without a record');
    expect(report(synced)).toContain('could not be checked against');
  });

  it('has nothing to do for a thread with no container', async () => {
    container.exists = false;
    expect(await sync(THREAD, workspace)).toEqual({ pulled: [], merged: [], clashes: [] });
  });
});

describe('describing the thread’s changes to a model', () => {
  it('gives each file with its status and diff', () => {
    const said = describeChanges({
      files: [
        { path: 'a.ts', status: 'modified', diff: '@@ -1 +1 @@\n-one\n+two', binary: false },
        { path: 'b.png', status: 'added', diff: 'Binary files /dev/null and b/b.png differ', binary: true },
      ],
      more: 1,
    });
    expect(said).toContain('## a.ts (modified)\n@@ -1 +1 @@\n-one\n+two');
    expect(said).toContain('## b.png (added)\nBinary file.');
    expect(said).toContain('1 more changed file is not shown.');
  });

  it('says so when nothing has changed, or the changes cannot be told', () => {
    expect(describeChanges({ files: [] })).toContain('not changed anything');
    expect(describeChanges({ files: [], unavailable: 'no record' })).toContain('could not be told: no record');
  });
});

// A reply that failed partway has still done whatever its tools did before it
// failed, so the files are put back before the user's next attempt at the
// same message (see the retry in ../../src/renderer.ts)
describe('snapshot and revert', () => {
  it('takes everything in the container as it stands, new files included', async () => {
    expect(await snapshot(THREAD)).toBe('tree-now');
    // Everything is taken note of first, or files the thread added would be
    // left out of the snapshot and survive the revert
    expect(container.ran).toEqual(['GIT add -A', 'GIT write-tree']);
  });

  it('has no snapshot to give when the thread has no container', async () => {
    container.exists = false;
    expect(await snapshot(THREAD)).toBeNull();
    expect(await revert(THREAD, 'tree-before')).toBe(false);
  });

  it('has none either when the container keeps no record of the files', async () => {
    container.hasRecord = false;
    expect(await snapshot(THREAD)).toBeNull();
  });

  it('puts the files back to the snapshot and clears away what came after', async () => {
    // The files have moved on since the snapshot was taken
    container.treeId = 'tree-after-the-failure';
    expect(await revert(THREAD, 'tree-before')).toBe(true);
    expect(container.restored).toBe('tree-before');
    expect(container.cleaned).toBe(true);
  });

  it('leaves them alone when nothing has changed since the snapshot', async () => {
    container.treeId = 'tree-before';
    expect(await revert(THREAD, 'tree-before')).toBe(false);
    expect(container.restored).toBeNull();
    expect(container.cleaned).toBe(false);
  });

  // A turn that began before the thread had a container wrote everything that
  // is in one now, so back is the state the container was made in
  it('goes back to the record itself when there was no snapshot to take', async () => {
    expect(await revert(THREAD, null)).toBe(true);
    expect(container.restored).toBe('tree-head');
  });

  it('leaves them alone when the container is already as it was made', async () => {
    container.treeId = 'tree-head';
    expect(await revert(THREAD, null)).toBe(false);
    expect(container.restored).toBeNull();
  });
});
