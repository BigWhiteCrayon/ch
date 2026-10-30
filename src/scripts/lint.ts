#!/usr/bin/env node
// Checks that no line of the code is longer than it can be read comfortably.
// Run by hand with `npm run lint`, which runs Prettier over the same files
// first: Prettier wraps the code, and this catches what Prettier cannot wrap
// for us — long prompts, tool descriptions and comments, which are text inside
// a string and so are left exactly as they are written.
//
// The limit is the point of it. A prompt is written once and then read every
// time someone wonders why a model did what it did, so it is worth the same
// care as the code around it: wrap it at a width an editor shows in full, and
// break the lines where the sense breaks.
//
// Exits non-zero, naming every line that is too long, so it can gate a commit.

import fs from 'fs';
import path from 'path';

export const LIMIT = 120;

// Where the code is. Markdown is left out: prose is wrapped for the person
// writing it, not to a rule.
export const ROOTS = ['src', 'evals', 'tests'];
export const EXTENSIONS = ['.ts', '.mts', '.html', '.css'];
export const ALSO = ['index.html', 'styles.css'];

export interface TooLong {
  file: string;
  line: number;
  length: number;
  text: string;
}

export interface System {
  readDir(dir: string): { name: string; directory: boolean }[];
  readFile(file: string): string;
  exists(file: string): boolean;
  say(line: string): void;
}

export const realSystem: System = {
  readDir: (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  exists: (file) => fs.existsSync(file),
  say: (line) => console.log(line),
};

// Every file to check, in a settled order so the report reads the same twice
export function files(system: System, roots = ROOTS, also = ALSO): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of system.readDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.directory) walk(full);
      else if (EXTENSIONS.includes(path.extname(entry.name))) found.push(full);
    }
  };
  for (const root of roots) if (system.exists(root)) walk(root);
  return [...found, ...also.filter((file) => system.exists(file))];
}

// The lines of a file that are over the limit. A tab counts as one character:
// how wide it looks is the editor's business.
export function check(file: string, text: string, limit = LIMIT): TooLong[] {
  return text
    .split('\n')
    .map((line, i) => ({ file, line: i + 1, length: line.length, text: line }))
    .filter((row) => row.length > limit);
}

export function lint(system: System, limit = LIMIT): TooLong[] {
  return files(system).flatMap((file) => check(file, system.readFile(file), limit));
}

export function report(system: System, limit = LIMIT): number {
  const over = lint(system, limit);
  if (over.length === 0) {
    system.say(`No line over ${limit} characters.`);
    return 0;
  }
  for (const { file, line, length, text } of over) {
    system.say(`${file}:${line}  ${length} characters`);
    system.say(`  ${text.trim().slice(0, 100)}…`);
  }
  const lines = over.length === 1 ? '1 line is' : `${over.length} lines are`;
  system.say(`\n${lines} over ${limit} characters. Wrap them, or run \`npm run format\` if it is code.`);
  return 1;
}

// Only when run as a command, so the file can be imported by its tests
if (require.main === module) process.exit(report(realSystem));
