// Whether a write-up's claims about files rest on files the step opened. The
// run this was written for is the case in the first block: a finding-out step
// that put the threads' save() and load() in harness/index.ts, having never
// opened it, and a plan that repeated it to three coders.

import { describe, expect, it } from 'vitest';
import { CAVEAT, CHECK, named, normalize, ungrounded } from '../../src/harness/grounding';
import { unwrapped } from '../helpers';

// What the step in that run actually wrote, shortened, and what it actually
// opened: types.ts and renderer.ts, and nothing else.
const WRITE_UP = `## Thread Architecture Summary

**Thread storage and persistence:**
- Thread state is saved/retrieved via \`src/harness/index.ts\` methods: \`load()\` returns JSON string of all
  threads, \`save()\` writes it to disk
- Defined across: \`src/types.ts\` (Resumed, HarnessRequest), \`src/renderer.ts\` (drawn in render())
- \`src/search/threads.ts\` maintains an embeddings index of thread pieces`;

const OPENED = ['src/types.ts', 'src/renderer.ts'];

describe('the claims a write-up makes about files it never opened', () => {
  it('catches the two the run it was written for got wrong', () => {
    expect(ungrounded(WRITE_UP, OPENED)).toEqual(['src/harness/index.ts', 'src/search/threads.ts']);
  });

  it('passes the files the step did open', () => {
    const loose = ungrounded(WRITE_UP, OPENED);
    expect(loose).not.toContain('src/types.ts');
    expect(loose).not.toContain('src/renderer.ts');
  });

  // The failure this cannot catch, said out loud so that nobody reads a pass
  // as more than it is: the same run had the Thread type in types.ts, which it
  // had read four times, and a check against the call log cannot know.
  it('says nothing about a wrong claim concerning a file that was opened', () => {
    const wrong = 'The Thread interface is defined in `src/types.ts`.';
    expect(ungrounded(wrong, ['src/types.ts'])).toEqual([]);
  });

  it('finds nothing to report when every path was opened', () => {
    expect(ungrounded('Sidebar rendering is in `src/renderer.ts`.', OPENED)).toEqual([]);
  });

  // The gap between what was read and what was written about is the signal, and
  // a step that read nothing has no gap: what is wrong there is the whole
  // write-up, not one path in it (see ungrounded).
  it('leaves a step that opened nothing at all alone', () => {
    expect(ungrounded(WRITE_UP, [])).toEqual([]);
  });

  it('counts a file an explorer read and reported as opened, since it was read', () => {
    // The finding-out step is told to hand the wide reading out, so a step that
    // did as it was told must not be told it worked from memory (see
    // PROMPTS.explore in phases.ts)
    const reported = [...OPENED, 'src/store.ts'];
    expect(ungrounded('Threads are saved in `src/store.ts`.', reported)).toEqual([]);
  });
});

describe('grounding.named', () => {
  it('takes a path however the model wrote it', () => {
    const said = 'Both `/workspace/src/store.ts` and ./src/store.ts and src/store.ts are the one file.';
    expect(named(said)).toEqual(['src/store.ts']);
  });

  it('keeps the order they were first mentioned in', () => {
    expect(named('src/renderer.ts, then src/types.ts, then src/renderer.ts again')).toEqual([
      'src/renderer.ts',
      'src/types.ts',
    ]);
  });

  it('leaves a dotted field name alone, which is what a bare extension rule would have taken', () => {
    expect(named('The thread.archived flag is read off state.threads at render time.')).toEqual([]);
  });

  it('leaves a root file named without a directory alone', () => {
    // Deliberate: see the comment on PATH. There is nothing to be wrong about
    // in where package.json is.
    expect(named('Scripts live in package.json.')).toEqual([]);
  });

  it('leaves built and installed files alone', () => {
    expect(named('Built to dist/main.js from node_modules/typescript/lib/tsc.js')).toEqual([]);
  });

  it("leaves a path inside somebody else's URL alone", () => {
    expect(named('Documented at https://example.com/docs/setup.md')).toEqual([]);
  });

  it('strips the punctuation a sentence leaves on the end', () => {
    expect(named('It is in src/log.ts, and also (src/store.ts).')).toEqual(['src/log.ts', 'src/store.ts']);
  });

  it('takes the test files and config files this project actually has', () => {
    const said = 'See tests/harness/index.test.ts, vitest.config.mts is at the root, and evals/run.ts drives it.';
    expect(named(said)).toContain('tests/harness/index.test.ts');
    expect(named(said)).toContain('evals/run.ts');
  });
});

describe('grounding.normalize', () => {
  it('makes one path of the ways a container path is written', () => {
    for (const path of ['/workspace/src/store.ts', './src/store.ts', 'src/store.ts']) {
      expect(normalize(path)).toBe('src/store.ts');
    }
  });
});

describe('what the step is told', () => {
  it('names the paths it has to read, since a step told only that something is unchecked re-reads', () => {
    const said = CHECK(['src/harness/index.ts', 'src/search/threads.ts']);
    expect(said).toContain('`src/harness/index.ts`');
    expect(said).toContain('`src/search/threads.ts`');
  });

  it('says why the words matter: the plan cannot check them and the coders act on them', () => {
    const said = unwrapped(CHECK(['src/harness/index.ts']));
    expect(said).toMatch(/has no tools and cannot check/);
    expect(said).toMatch(/coders are sent to the files your words name/);
  });

  it('reads as one file or several, so neither case is written for the other', () => {
    expect(unwrapped(CHECK(['src/a.ts']))).toContain('you did not open it in this step');
    expect(unwrapped(CHECK(['src/a.ts', 'src/b.ts']))).toContain('you did not open any of them in this step');
  });

  it('leaves a path an explorer read a way to keep its claim', () => {
    expect(unwrapped(CHECK(['src/a.ts']))).toMatch(/explorer read for you and reported back/);
  });
});

describe('the caveat carried on when there are no rounds left to check with', () => {
  it('names the paths and says they are recollection rather than findings', () => {
    const said = unwrapped(CAVEAT(['src/harness/index.ts']));
    expect(said).toContain('`src/harness/index.ts`');
    expect(said).toMatch(/recollection rather than a finding/);
  });

  it('tells the plan not to send a change there without confirming where it belongs', () => {
    expect(unwrapped(CAVEAT(['src/a.ts', 'src/b.ts']))).toMatch(/has to be confirmed first/);
  });

  it('is added to a write-up rather than replacing it', () => {
    expect(CAVEAT(['src/a.ts']).startsWith('\n\n')).toBe(true);
  });

  it('reads as one file or several', () => {
    expect(unwrapped(CAVEAT(['src/a.ts']))).toContain('that location is recollection');
    expect(unwrapped(CAVEAT(['src/a.ts', 'src/b.ts']))).toContain('those locations are recollection');
  });
});
