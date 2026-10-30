import { describe, expect, it, vi } from 'vitest';
import { LIMIT, check, files, lint, report, type System } from '../../src/scripts/lint';

// A tree of files, by path, with the directories worked out from the paths
function system(tree: Record<string, string>): System & { said: string[] } {
  const said: string[] = [];
  const paths = Object.keys(tree);
  return {
    readDir(dir) {
      const prefix = `${dir}/`;
      const names = new Map<string, boolean>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const cut = rest.indexOf('/');
        names.set(cut === -1 ? rest : rest.slice(0, cut), cut !== -1);
      }
      return [...names].map(([name, directory]) => ({ name, directory }));
    },
    readFile: (file) => tree[file] ?? '',
    exists: (file) => file in tree || paths.some((path) => path.startsWith(`${file}/`)),
    say: (line) => void said.push(line),
    said,
  };
}

const long = (n: number) => 'x'.repeat(n);

describe('the line length check', () => {
  it('passes a file whose longest line is exactly the limit', () => {
    expect(check('a.ts', long(LIMIT))).toEqual([]);
  });

  it('reports a line one character over, with where it is and how long it is', () => {
    expect(check('a.ts', `short\n${long(LIMIT + 1)}`)).toEqual([
      { file: 'a.ts', line: 2, length: LIMIT + 1, text: long(LIMIT + 1) },
    ]);
  });

  it('counts characters, not bytes: a wide character is one character', () => {
    // 120 em-dashes are three bytes each and still only 120 columns
    expect(check('a.ts', '—'.repeat(LIMIT))).toEqual([]);
    expect(check('a.ts', '—'.repeat(LIMIT + 1))).toHaveLength(1);
  });
});

describe('which files are checked', () => {
  it('walks the code, in a settled order, and leaves other kinds of file alone', () => {
    const sys = system({
      'src/main.ts': '',
      'src/llm/index.ts': '',
      'src/notes.md': '',
      'src/logo.png': '',
      'tests/main.test.ts': '',
      'index.html': '',
      'styles.css': '',
    });
    expect(files(sys)).toEqual(['src/llm/index.ts', 'src/main.ts', 'tests/main.test.ts', 'index.html', 'styles.css']);
  });

  it('skips a root that is not there', () => {
    expect(files(system({ 'src/main.ts': '' }), ['src', 'nowhere'], [])).toEqual(['src/main.ts']);
  });
});

describe('the report', () => {
  it('says so and passes when every line fits', () => {
    const sys = system({ 'src/a.ts': 'const a = 1;\n' });
    expect(report(sys)).toBe(0);
    expect(sys.said[0]).toBe(`No line over ${LIMIT} characters.`);
  });

  it('names every line that is too long, and fails', () => {
    const sys = system({ 'src/a.ts': `${long(130)}\nfine\n${long(125)}`, 'src/b.ts': 'fine' });
    expect(report(sys)).toBe(1);
    expect(sys.said.filter((line) => line.startsWith('src/'))).toEqual([
      'src/a.ts:1  130 characters',
      'src/a.ts:3  125 characters',
    ]);
    expect(sys.said.at(-1)).toContain('2 lines are over 120 characters');
  });

  it('counts one offending line as one line', () => {
    const sys = system({ 'src/a.ts': long(121) });
    report(sys);
    expect(sys.said.at(-1)).toContain('1 line is over');
  });

  it('shows the start of the line, so it can be recognised without opening the file', () => {
    const sys = system({ 'src/a.ts': `  const greeting = 'hello';${long(120)}` });
    report(sys);
    expect(sys.said[1]).toContain("const greeting = 'hello';");
    expect(sys.said[1].length).toBeLessThan(110);
  });

  it('checks this project and finds nothing, which is the point of it', () => {
    const over = lint({
      ...system({}),
      readDir: (dir) =>
        require('fs')
          .readdirSync(dir, { withFileTypes: true })
          .map((e: { name: string; isDirectory(): boolean }) => ({ name: e.name, directory: e.isDirectory() })),
      readFile: (file) => require('fs').readFileSync(file, 'utf8'),
      exists: (file) => require('fs').existsSync(file),
      say: vi.fn(),
    });
    expect(over.map(({ file, line, length }) => `${file}:${line} is ${length} characters`)).toEqual([]);
  });
});
