// The steps a coding change is worked through, as facts about the steps
// themselves: which of them hold tools, which tools those are, and how long
// the first of them may go on. The loop that runs them is tested in
// ./index.test.ts.

import { describe, expect, it } from 'vitest';
import * as phases from '../../src/harness/phases';
import { maxSteps } from '../../src/harness';
import { all } from '../../src/tools';
import { CODER, specsFor } from '../../src/subagents';
import { ASK_TOOL } from '../../src/subagents/kind';
import { unwrapped } from '../helpers';
import type { Phase } from '../../src/types';

// The four that change no project file: finding out, planning, answering and
// writing up. The doing step is the one the project's changes come out of,
// though it makes none of them itself: it hands each to a coder (see
// PROMPTS.execute).
const NON_EDIT: Phase[] = ['explore', 'plan', 'respond', 'report'];

describe('how the doing step and its coders are told to show a change', () => {
  it('tells both to use a demo copy in /tmp/demo and screenshot steps', () => {
    for (const prompt of [unwrapped(phases.PROMPTS.execute), unwrapped(CODER.prompt)]) {
      expect(prompt).toContain('/tmp/demo');
      expect(prompt).toContain('steps');
    }
  });
});

describe('the tools a step that changes nothing is offered', () => {
  // Reading the project, running code to find things out, and writing down what
  // has already been read. Nothing here can change a project file or hand work
  // out; what writes the note every message in the workspace carries is not
  // here either, that being a change to the project rather than a record of
  // what one step found.
  const READING = new Set([
    'search_workspace',
    'search_workspace_notes',
    'read_file',
    'list_workspace',
    // Runs only programs that cannot write, and refuses the shell's ways of
    // making them (see tools/reading.ts)
    'run_reading_command',
    // Runs a command, so the app or a test can be run to see what it does; it
    // refuses shell writes to the project's files, and writes under /tmp are
    // allowed (see tools/sandbox.ts)
    'run_command',
    // Reads a file outside the container only once the user has said it may
    // (see tools/files.ts)
    'read_user_file',
    // The same, for a read-only command in a folder the user has allowed. The
    // finding-out step needs it: the project's history is only in the user's
    // own checkout, the copy having been made without the .git (see
    // tools/hostReading.ts)
    'run_host_command',
    // Looks at a page, which is reading it; the browser writes only under /tmp
    // (see tools/sandbox.ts)
    'screenshot',
    // The same, for a page that moves: it draws and encodes under /tmp and
    // touches nothing in the project either
    'record',
    'add_workspace_note',
    'add_to_context',
    'save_context',
    // Handing work out, which the finding-out step does so that it reads four
    // parts of a project without four parts of it in its window. What it may
    // send is bounded at the call rather than by the phase: explorers only,
    // which cannot change anything either (see tools/subagents.ts)
    'hand_to_subagent',
    'wait_for_subagent',
    // ...and writing to one of those explorers while it reads, which changes
    // nothing in the project either: it puts a message in front of a subagent
    // and brings back what the subagent says (see tools/subagents.ts)
    'message_subagent',
    // Puts a question to the user and waits, which changes nothing either
    ASK_TOOL,
  ]);

  it('is only those, out of every tool the app has', () => {
    for (const phase of NON_EDIT) {
      const offered = all.filter((tool) => phases.offers(tool, phase)).map(({ name }) => name);
      expect(offered.filter((name) => !READING.has(name))).toEqual([]);
    }
  });

  it('is none at all in the step whose whole job is to answer', () => {
    expect(all.filter((tool) => phases.offers(tool, 'respond'))).toEqual([]);
  });

  // The planning step cannot read, but it can stop to ask the user what the
  // plan would rest on
  it('is only the question to the user in the planning step', () => {
    expect(all.filter((tool) => phases.offers(tool, 'plan')).map(({ name }) => name)).toEqual([ASK_TOOL]);
    for (const tool of all.filter(({ name }) => name !== ASK_TOOL)) {
      expect(phases.offers(tool, 'plan'), tool.name).toBe(false);
    }
  });

  // The step that cannot change anything says so in its own instructions, so a
  // tool that can has to be kept out of it rather than merely discouraged
  it('keeps what writes back to the workspace to the doing step', () => {
    for (const name of ['add_to_workspace_context', 'sync_workspace']) {
      const tool = all.find((one) => one.name === name);
      expect(tool, name).toBeDefined();
      expect(phases.offers(tool!, 'explore'), name).toBe(false);
      expect(phases.offers(tool!, 'execute'), name).toBe(true);
    }
  });

  // It only reads, and the finding-out step is the one that most wants the
  // project's history, which no tool but this one reaches
  it('offers run_host_command while finding out as well as in the do phase', () => {
    const hostTool = all.find((one) => one.name === 'run_host_command')!;
    expect(phases.offers(hostTool!, 'explore')).toBe(true);
    expect(phases.offers(hostTool!, 'execute')).toBe(true);
  });

  // Not even the doing step, which hands its changes to coders: a step holding
  // the tool that writes a file has a cheaper move than writing the piece that
  // would, and takes it (see PROMPTS.execute)
  it('offers the tools that write a file in no step at all', () => {
    for (const name of ['write_file', 'edit_file']) {
      const tool = all.find((one) => one.name === name);
      expect(tool, name).toBeDefined();
      for (const phase of [...phases.ORDER, ...phases.INVESTIGATION]) {
        expect(phases.offers(tool!, phase), `${name} in ${phase}`).toBe(false);
      }
    }
  });

  // ...which is a bound on the steps and not on the tool: what a coder may use
  // is its kind's business, and a reply worked through in no steps is offered
  // everything (see toolsFor in ../../src/harness/index.ts)
  it('still gives those tools to a coder, which is what makes the change', () => {
    for (const name of ['write_file', 'edit_file']) {
      const tool = all.find((one) => one.name === name)!;
      expect(CODER.allows(tool), name).toBe(true);
      expect(
        specsFor(CODER, { workspace: '/w' } as never, all).map(({ name: n }) => n),
        name
      ).toContain(name);
    }
  });

  it('leaves the reading tools in the doing step too, which has to read what it changes', () => {
    for (const name of ['search_workspace', 'read_file']) {
      expect(
        phases.offers(
          all.find((one) => one.name === name)!,
          'execute'
        )
      ).toBe(true);
    }
  });
});

describe('how long the finding out may go on', () => {
  it('is a sixth of the reply’s rounds, with a floor under it', () => {
    expect(phases.findingRounds(maxSteps('low', true))).toBe(10);
    expect(phases.findingRounds(30)).toBe(5);
    // The floor, for a budget too small for a sixth of it to be worth having
    expect(phases.findingRounds(6)).toBe(5);
  });

  // The share above is an allowance of turns, and what runs out first on a
  // small model is the room: everything a round returns stays in front of the
  // step until it ends. A reply on a 32k model was told it had twenty rounds
  // of looking when the window had room for two, spent them, and reached the
  // user as the message that says it ran out of room.
  it('is no more than the window holds, whatever the effort bought', () => {
    const high = maxSteps('high', true);
    // Unchanged where the window is large enough that the effort is what binds
    expect(phases.findingRounds(high, 200_000)).toBe(phases.findingRounds(high));
    // ...and cut where it is not, by more the smaller the window is
    const rounds = [200_000, 128_000, 64_000, 32_000, 16_000].map((w) => phases.findingRounds(high, w));
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]).toBeLessThan(rounds[i - 1]);
  });

  it('keeps a round even where the window affords none, and never says it has more', () => {
    // A window with no room left once the step's own instructions are in it:
    // one round honestly stated is something a model can work with, where five
    // it has no room for is the same lie in a smaller number
    expect(phases.findingRounds(maxSteps('high', true), 4000)).toBe(1);
    for (const window of [4000, 8000, 16_000, 32_000, 64_000, 128_000, 200_000]) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        const limit = maxSteps(effort, true);
        expect(phases.findingRounds(limit, window)).toBeLessThanOrEqual(phases.findingRounds(limit));
        expect(phases.findingRounds(limit, window)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // Which it is changes what the step should do, not only how much of it: a
  // step out of rounds should look less, and a step out of room should look
  // elsewhere — at explorers, which read in windows of their own
  it('says when the allowance is the window’s doing rather than the effort’s', () => {
    const high = maxSteps('high', true);
    expect(phases.windowBound(high, 32_000)).toBe(true);
    expect(phases.windowBound(high, 200_000)).toBe(false);
    // A model that does not say how large its window is cannot be bound by it
    expect(phases.windowBound(high)).toBe(false);
  });

  it('tells a step bound by its window to spend the rounds on explorers', () => {
    const tight = unwrapped(phases.BUDGET(3, true));
    expect(tight).toContain('3 rounds of looking');
    // Why it is few, since a model told only the number spends three rounds
    // the way it would have spent thirty — on the first few files
    expect(tight).toContain('the reason is room rather than effort');
    expect(tight).toContain('stays in front of you until this step ends');
    // ...and what to do instead, which is the one thing here that does not
    // cost the window
    expect(tight).toContain('look elsewhere rather than less');
    expect(tight).toContain('reads in a window of its own, not in yours');
    expect(tight).toContain('Several at once cost you one round between them');
  });

  it('says none of that to a step whose rounds are its effort’s doing', () => {
    const roomy = unwrapped(phases.BUDGET(20));
    expect(roomy).toContain('20 rounds of looking');
    expect(roomy).not.toContain('the reason is room rather than effort');
    expect(roomy).not.toContain('look elsewhere rather than less');
    // What every allowance is told either way
    expect(roomy).toContain('That is a ceiling, not a target');
    expect(roomy).toContain('Writing something down does not count against it');
  });

  it('asks the finding-out step hardest for the words the next step is given', () => {
    expect(phases.asks('explore')).toBeGreaterThan(phases.asks('plan'));
    for (const phase of ['plan', 'execute', 'respond'] as const) expect(phases.asks(phase)).toBe(1);
  });
});

// The doing step has no cap of its own any more. Its reading is where the plan
// first meets the files, so what bounds it is the reply's own budget and the
// window (see the comment in ../../src/harness/phases.ts, which keeps the
// account of what the cap bought and what it cost).
describe('how much looking the doing step may do before it hands the plan out', () => {
  it('is not held to an allowance of its own', () => {
    const module = phases as Record<string, unknown>;
    for (const gone of ['doingReads', 'STILL_READING', 'READ_NOT_RUN']) {
      expect(module[gone]).toBeUndefined();
    }
  });

  // The finding-out step keeps its cap: it reads towards a write-up, and
  // everything it reads stays in front of it until the step ends
  it("leaves the finding-out step's own allowance alone", () => {
    expect(phases.findingRounds(maxSteps('high', true))).toBeGreaterThan(0);
  });
});

// An investigation reads and writes up, and changes nothing: two steps, the
// second of which has no tools and is read by the user.
describe('the steps of an investigation', () => {
  const args = { plan: false, category: 'question', workspace: true, tools: true, resumed: false };

  it('is the finding out and the writing up', () => {
    expect(phases.INVESTIGATION).toEqual(['explore', 'report']);
    expect(phases.next('explore', phases.INVESTIGATION)).toBe('report');
    expect(phases.last('report', phases.INVESTIGATION)).toBe(true);
    expect(phases.last('explore', phases.INVESTIGATION)).toBe(false);
    // The default order is unchanged
    expect(phases.next('explore')).toBe('plan');
    expect(phases.last('respond')).toBe(true);
  });

  it('is chosen by the classifier as a kind of task, and needs no coding task', () => {
    expect(phases.forReply({ ...args, category: 'investigation' })).toBe(phases.INVESTIGATION);
    expect(phases.forReply({ ...args, category: 'investigation', plan: false })).toBe(phases.INVESTIGATION);
    expect(phases.forReply(args)).toBeNull();
  });

  it('is only written up, with no finding out, when there is no workspace to read', () => {
    expect(phases.forReply({ ...args, category: 'investigation', workspace: false })).toEqual(phases.WRITE_UP);
    expect(phases.forReply({ ...args, category: 'investigation', tools: false })).toEqual(phases.WRITE_UP);
    expect(phases.WRITE_UP).toEqual(['report']);
  });

  it('is not picked up again once resumed', () => {
    expect(phases.forReply({ ...args, category: 'investigation', resumed: true })).toBeNull();
  });

  it('writes up with no tools, for the user', () => {
    expect(phases.hasTools('report')).toBe(false);
    expect(phases.readByUser('report')).toBe(true);
  });
});

// The planning step is the one whose words the user acts on, and the one step
// that cannot check anything: it has no tools, and what it says is handed
// straight to coders. So what it is told to do with an open question is a fact
// about the step worth holding still.
describe('what the planning step is told to write', () => {
  const plan = unwrapped(phases.PROMPTS.plan);

  it('asks for a settled plan rather than one to be worked out while it is carried out', () => {
    expect(plan).toContain('Decide, rather than lay out the options');
    expect(plan).toContain('A branch is not a plan');
    expect(plan).toContain('Do not plan to go and look');
    // The hedges that survive any code at all, named so they can be recognised
    expect(plan).toContain('stays true whatever the code holds');
  });

  it('would rather have the open question than a plan that reads well', () => {
    expect(plan).toContain('do not write a thinner one in its place');
    expect(plan).toContain('what the change turns on that nobody has established');
    // ...and not as a way out of planning anything hard
    expect(plan).toContain('somebody holding one part of it could make that part of the change');
  });

  it('keeps the plan to what the finding-out step established', () => {
    expect(plan).toContain('Every path, function and type you name has to come from the write-up');
    // What grounding.CAVEAT asks of this step, said here as well
    expect(plan).toContain('a location was not checked against the file');
  });

  // The reason given for all of it, which has to be what the coder is really
  // told or the step is being reasoned at with a fiction
  it('gives the reason the coder cannot close an open question', () => {
    expect(plan).toContain('told not to ask questions');
    expect(plan).toContain('make the smallest version that works');
    const coder = unwrapped(CODER.prompt);
    expect(coder).toContain('do not ask questions — nobody can answer them');
    expect(coder).toContain('make the smallest version that works');
  });

  // Asked again when the step wrote nothing, so it asks for the same thing
  it('asks for the same plan again when the step ended without one', () => {
    expect(unwrapped(phases.NOTHING_CARRIED.plan)).toContain('settled rather than left for whoever carries it out');
  });
});
