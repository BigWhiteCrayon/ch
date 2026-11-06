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
import { MAX_GRANTS, TOOL_NAME as MORE_TOOL, grant } from '../../src/harness/allowance';
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
    // Using the running app, which is how the finding-out step reproduces a bug
    // rather than with a script of its own: the session and the browser's
    // profile are kept under /tmp, and nothing is written to the project
    'use_app',
    // Keeping how the app was got running, for the threads after this one: the
    // recipe is kept in the app's data folder, beside the workspace's notes, and
    // what it runs to check itself is what use_app runs
    'save_run_recipe',
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
    // Asks for more rounds than the step's allowance holds, which changes
    // nothing in the project: all it changes is how long the step may go on
    // (see harness/allowance.ts)
    MORE_TOOL,
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
  // plan would rest on, and it can send work out to an explorer — which reads
  // and writes notes and changes nothing — so the plan is not built on a part of
  // the project the finding-out step did not reach. Those four are all it offers.
  it('offers the question to the user and the three tools that hand work out in the planning step', () => {
    const offered = all.filter((tool) => phases.offers(tool, 'plan')).map(({ name }) => name);
    expect(offered).toEqual(['hand_to_subagent', 'wait_for_subagent', 'message_subagent', ASK_TOOL]);
    // Every other tool is kept out of the planning step
    for (const tool of all.filter(({ name }) => name !== ASK_TOOL && !offered.includes(name))) {
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

  // The finding-out prompt sent history questions to run_reading_command,
  // which runs in a copy with no .git: every git log asked of it found no
  // repository
  it('sends questions about the history to run_host_command, not to the copy', () => {
    const prompt = unwrapped(phases.PROMPTS.explore);
    expect(prompt).toContain('what a commit did — run_host_command answers it');
    expect(prompt).not.toMatch(/commit did — run_reading_command/);
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

  // The one step that holds the change tools itself is the suggest step: it
  // makes the change a suggestion is about, in a demo copy that is reverted, so
  // it needs the tools that write a file and the doing step does not (see
  // phases.SUGGESTION).
  it('offers the tools that write a file in the suggest step, where the change is made and reverted', () => {
    for (const name of ['write_file', 'edit_file']) {
      const tool = all.find((one) => one.name === name)!;
      expect(phases.offers(tool!, 'suggest'), `${name} in suggest`).toBe(true);
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

// A suggestion finds out how the code stands and then suggests a change to it:
// two steps, the second of which holds the tools that make the change and is
// read by the user. The change it makes is in a demo copy that is reverted, so
// the suggest step is unlike the doing step: it holds the change tools itself
// and its words are the reply, not a handover.
describe('the steps of a suggestion', () => {
  const args = { plan: false, category: 'question', workspace: true, tools: true, resumed: false };

  it('is the finding out and the suggesting', () => {
    expect(phases.SUGGESTION).toEqual(['explore', 'suggest']);
    expect(phases.next('explore', phases.SUGGESTION)).toBe('suggest');
    expect(phases.last('suggest', phases.SUGGESTION)).toBe(true);
    expect(phases.last('explore', phases.SUGGESTION)).toBe(false);
  });

  it('is chosen by the classifier as a kind of task, and needs no coding task', () => {
    expect(phases.forReply({ ...args, category: 'suggestion' })).toBe(phases.SUGGESTION);
    expect(phases.forReply({ ...args, category: 'suggestion', plan: false })).toBe(phases.SUGGESTION);
    // A coding task is not a suggestion
    expect(phases.forReply(args)).toBeNull();
  });

  it('is only written up, with no finding out, when there is no workspace to read', () => {
    expect(phases.forReply({ ...args, category: 'suggestion', workspace: false })).toEqual(phases.WRITE_UP);
    expect(phases.forReply({ ...args, category: 'suggestion', tools: false })).toEqual(phases.WRITE_UP);
  });

  it('is not picked up again once resumed', () => {
    expect(phases.forReply({ ...args, category: 'suggestion', resumed: true })).toBeNull();
  });

  // Unlike the writing up, the suggest step holds the tools that make the
  // change, and its words are read by the user: it makes a change to show, then
  // explains it, and the explanation is the reply.
  it('suggests with the change tools in hand, for the user', () => {
    expect(phases.hasTools('suggest')).toBe(true);
    expect(phases.readByUser('suggest')).toBe(true);
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

// Working a fault through is the same four steps as any other change, and the
// difference is what each of them is told: see it happen before reading for it,
// carry the diagnosis forward, name the cause in the plan, and settle the fix
// by doing again what showed the fault.
describe('a change that is a fix', () => {
  const explore = unwrapped(phases.PROMPTS.explore);
  const plan = unwrapped(phases.PROMPTS.plan);
  const execute = unwrapped(phases.PROMPTS.execute);
  const respond = unwrapped(phases.PROMPTS.respond);

  // The real application rather than a script of its own, and by the quickest
  // route to it: the recipe whoever first got it running saved (see
  // sandbox/recipes.ts), which the doing step, the coder and the tester all
  // name and this step did not
  it('is reproduced in the real application, started from the workspace’s run recipe', () => {
    expect(explore).toContain('use the real application, not a script of your own');
    expect(explore).toContain('use_app with recipe: true');
    // The session stays up, so a fault is walked into one move at a time
    expect(explore).toContain('reproduce the bug one move at a time');
    // ...and what it worked out about launching is kept where the next thread
    // to reproduce something finds it
    expect(explore).toContain('save how you did it with save_run_recipe');
  });

  it('is reproduced before it is read for', () => {
    expect(explore).toContain('see it happen before you read for it');
    // The real thing, not a script of its own: the ways in are the project's
    // tests, the app, and the command the user ran
    expect(explore).toContain("the project's tests for a failing test");
    expect(explore).toContain('use_app for anything the user');
    // A fault that will not reproduce is a finding, not a licence to plan a fix
    expect(explore).toContain('Where it will not reproduce, that is itself a finding');
  });

  // The pictures are taken in the step that runs the thing, because the step
  // that writes the plan has no tools and the plan is where they are shown
  it('is screenshot and filmed while finding out, for showing under the plan', () => {
    expect(explore).toContain('recording of a use_app session');
    expect(explore).toContain('shown to the user underneath the plan');
  });

  // The ordinary stopping rule is understanding the code the change touches,
  // which a fault does not satisfy: an unlocated fault sends coders to the
  // wrong file with every confidence
  it('does not let the finding-out step stop at understanding the area', () => {
    expect(explore).toContain('stop when you have reproduced the fault and can say what causes it');
    expect(explore).toContain('Where you got as far as ruling things out and no further');
  });

  // The planning step has no tools and cannot go and look, so what it knows of
  // the diagnosis is what the finding-out step wrote down
  it('carries the diagnosis into the write-up the plan is made from', () => {
    expect(explore).toContain('how to reproduce it, what the cause is, the');
    expect(explore).toContain('what would show it was wrong, and how sure you are');
  });

  it('names the cause in the plan, before what changes', () => {
    expect(plan).toContain('say what the cause is before you say what changes');
    // An unconfirmed cause is planned for and labelled, rather than asserted
    // or turned into two plans
    expect(plan).toContain('rests on a cause not yet confirmed');
    expect(plan).toContain('One plan either way');
  });

  it('is checked by doing again what showed the fault', () => {
    expect(execute).toContain('do again exactly what showed the fault');
    // The project's own tests cannot settle it: they passed with the bug in
    expect(execute).toContain('passed with the bug in place');
    // ...and the check that would have caught it is worth keeping
    expect(execute).toContain('a test which would have failed before this change');
  });

  it('is answered with the cause first, since the user already knew the symptom', () => {
    expect(respond).toContain('the cause is what leads instead');
    expect(respond).toContain('what they did not know is why');
  });
});

// The finding-out step's share of the rounds is a ceiling that can be raised,
// for the one kind of work whose size cannot be judged from the request (see
// harness/allowance.ts)
describe('what a step is told about asking for more rounds', () => {
  it('is told with its allowance, since a ceiling that can be raised is a different thing to work under', () => {
    const budget = unwrapped(phases.BUDGET(10));
    expect(budget).toContain('The ceiling can be raised');
    expect(budget).toContain(MORE_TOOL);
    expect(budget).toContain(`${MAX_GRANTS} such grants are all anyone gets`);
    // ...and what it is for, which is not one more look at a settled question
    expect(budget).toContain('a guess that has to be tested against the running thing');
  });

  // A step whose rounds are gone keeps the tools in front of it for the
  // prompt cache's sake and may call none of them. The one exception is the
  // asking, so the asking is the one thing named.
  it('names the one call a spent step may still make, where a grant is to be had', () => {
    const told = unwrapped(phases.spent('rounds', true));
    expect(told).toContain('One call is still answered');
    expect(told).toContain(MORE_TOOL);
    expect(told).toContain('an experiment rather than another read');
  });

  // A door that cannot be opened is worse than no door: the model spends a
  // round finding out
  it('says nothing of it where there is no grant to be had', () => {
    for (const why of ['rounds', 'window'] as const) {
      const told = unwrapped(phases.spent(why));
      expect(told).not.toContain(MORE_TOOL);
      expect(told).not.toContain('One call is still answered');
      // ...and still asks for the write-up, which is what is left either way
      expect(told).toContain('write it down now');
    }
  });
});
