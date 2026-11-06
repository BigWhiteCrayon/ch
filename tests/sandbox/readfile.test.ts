import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFileInWorkspace, resolveInWorkspace } from '../../src/sandbox/readfile';

// A folder the files a reference reads live in, written once for the suite
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-file-ref-'));
fs.writeFileSync(path.join(WORKSPACE, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
fs.writeFileSync(path.join(WORKSPACE, 'empty.txt'), '');
fs.writeFileSync(path.join(WORKSPACE, 'binary.txt'), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]));
fs.mkdirSync(path.join(WORKSPACE, 'sub'));
fs.writeFileSync(path.join(WORKSPACE, 'sub', 'b.txt'), 'hello\nworld\n');

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

describe('resolveInWorkspace', () => {
  it('resolves a name that is inside the workspace', () => {
    expect(resolveInWorkspace(WORKSPACE, 'a.txt')).toBe(path.resolve(WORKSPACE, 'a.txt'));
  });

  it('resolves a name in a subfolder', () => {
    expect(resolveInWorkspace(WORKSPACE, 'sub/b.txt')).toBe(path.resolve(WORKSPACE, 'sub', 'b.txt'));
  });

  it('refuses an absolute name, that being a path on the computer', () => {
    expect(resolveInWorkspace(WORKSPACE, '/etc/passwd')).toBeNull();
  });

  it('refuses a name that climbs out by ..', () => {
    expect(resolveInWorkspace(WORKSPACE, '../a.txt')).toBeNull();
    expect(resolveInWorkspace(WORKSPACE, 'sub/../../a.txt')).toBeNull();
  });
});

describe('readFileInWorkspace', () => {
  it('reads a file from the top up to the cap', () => {
    expect(readFileInWorkspace(WORKSPACE, 'a.txt')).toEqual({
      path: 'a.txt',
      lines: ['one', 'two', 'three', 'four', 'five'],
      from: 1,
      total: 5,
    });
  });

  it('reads a range the reference named', () => {
    expect(readFileInWorkspace(WORKSPACE, 'a.txt', 2, 3)).toEqual({
      path: 'a.txt',
      lines: ['two', 'three'],
      from: 2,
      total: 5,
      more: 2,
    });
  });

  it('says there are more lines past what it showed', () => {
    expect(readFileInWorkspace(WORKSPACE, 'a.txt', 1, 2)).toEqual({
      path: 'a.txt',
      lines: ['one', 'two'],
      from: 1,
      total: 5,
      more: 3,
    });
  });

  it('brings a range that runs past the file back into it', () => {
    expect(readFileInWorkspace(WORKSPACE, 'a.txt', 4, 10)).toEqual({
      path: 'a.txt',
      lines: ['four', 'five'],
      from: 4,
      total: 5,
    });
  });

  it('reads a file in a subfolder', () => {
    expect(readFileInWorkspace(WORKSPACE, 'sub/b.txt')).toEqual({
      path: 'sub/b.txt',
      lines: ['hello', 'world'],
      from: 1,
      total: 2,
    });
  });

  it('says when a file is not there', () => {
    expect(readFileInWorkspace(WORKSPACE, 'nope.txt')).toEqual({ path: 'nope.txt', notFound: true });
  });

  it('reads an empty file as no lines', () => {
    expect(readFileInWorkspace(WORKSPACE, 'empty.txt')).toEqual({
      path: 'empty.txt',
      lines: [],
      from: 1,
      total: 0,
    });
  });

  it('does not read a binary file', () => {
    expect(readFileInWorkspace(WORKSPACE, 'binary.txt')).toEqual({ path: 'binary.txt', binary: true });
  });

  it('refuses a path that reaches outside the workspace', () => {
    expect(readFileInWorkspace(WORKSPACE, '../a.txt')).toEqual({ path: '../a.txt', outside: true });
    expect(readFileInWorkspace(WORKSPACE, '/etc/passwd')).toEqual({ path: '/etc/passwd', outside: true });
  });
});
