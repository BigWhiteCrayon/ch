// What each kind of subagent is: what it is told, how long it gets, and what
// it is allowed to do. The loop that runs any of them is tested in
// ./index.test.ts.

import { describe, expect, it } from 'vitest';
import { unwrapped } from '../helpers';
import {
  AGENT,
  CODER,
  EXPLORER,
  KINDS,
  MESSAGE_TOOL,
  REVIEWER,
  TESTER,
  TOOL_NAME,
  WORKER,
  byName,
} from '../../src/subagents';
import { ALLOWED as TESTER_ALLOWED } from '../../src/subagents/tester';
import { ALLOWED } from '../../src/subagents/explorer';
import { ASK_TOOL, MAX_HANDOUT_DEPTH, MOVES_THREAD, WAIT_TOOL, forbidden } from '../../src/subagents/kind';
import { work as throughTheReplyFlow } from '../../src/subagents/thread';
import { specsFor } from '../../src/subagents/run';
import { ALLOWED as HEAD_ALLOWED, HEAD_EXPLORER } from '../../src/subagents/head';
import { all } from '../../src/tools';
import { explorerTools } from '../../src/harness/project';
import type { Tool, ToolContext } from '../../src/types';

const EVERY = [CODER, EXPLORER, REVIEWER, WORKER];

// A tool as the registry holds one, for asking a kind whether it is allowed
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: '',
  inputSchema: {},
  run: () => '',
  ...extra,
});

describe('asking the user', () => {
  it('is no subagent’s to do: there is nobody for it to ask', () => {
    for (const kind of EVERY) expect(kind.allows(tool(ASK_TOOL))).toBe(false);
    expect(HEAD_EXPLORER.allows(tool(ASK_TOOL))).toBe(false);
    // Not even the kind that has everything else: an agent is one of several
    // working out of the user's sight, and its sender does the asking
    expect(AGENT.allows(tool(ASK_TOOL))).toBe(false);
  });
});

describe('the kinds there are', () => {
  it('names each one, with room to work and a bound on what it brings back', () => {
    for (const kind of EVERY) {
      expect(kind.name).toMatch(/^[a-z]+$/);
      expect(kind.summary.length).toBeGreaterThan(20);
      expect(kind.prompt.length).toBeGreaterThan(200);
      expect(kind.steps).toBeGreaterThan(0);
      expect(kind.result).toBeGreaterThan(0);
    }
  });

  it('offers the model every kind but the reviewer, which is sent per comment', () => {
    expect(KINDS.map(({ name }) => name)).toEqual(['coder', 'explorer', 'worker', 'agent']);
    expect(byName('reviewer')).toBeUndefined();
    for (const kind of KINDS) expect(byName(kind.name)).toBe(kind);
  });

  it('gives an explorer the most rounds: it is reading a whole project, not doing one errand', () => {
    expect(EXPLORER.steps).toBeGreaterThan(CODER.steps);
    // ...and a coder more than a worker, since it reads, changes and then checks
    expect(CODER.steps).toBeGreaterThan(WORKER.steps);
  });

  it('marks an explorer as wanting a workspace, having nothing to look at without one', () => {
    expect(EXPLORER.needsWorkspace).toBe(true);
    for (const kind of [CODER, REVIEWER, WORKER]) expect(kind.needsWorkspace).toBeUndefined();
  });

  // The read-only limit on host commands lives in the tool itself (src/tools/hostReading.ts), not in the kind
  it('every kind may use `run_host_command` and `read_user_file`, which ask the user through the thread', () => {
    for (const kind of EVERY) {
      expect(kind.allows(tool('run_host_command'))).toBe(true);
      expect(kind.allows(tool('read_user_file'))).toBe(true);
    }
  });

  it('has a reviewer bring back least: its real answer goes under the comment', () => {
    // How many rounds it gets is a matter of taste; what it hands back is not,
    // since the reply to the comment is what the user reads
    expect(REVIEWER.result).toBeLessThan(WORKER.result);
    expect(REVIEWER.result).toBeLessThan(CODER.result);
  });
});

describe('what a kind of subagent may do', () => {
  it('lets an explorer send out explorers, and nobody else send out anybody', () => {
    // An area that is really several areas is split, the way the project is
    // (see head.ts); how far that goes is settled by depth, not by refusal
    expect(EXPLORER.allows(tool(TOOL_NAME))).toBe(true);
    expect(HEAD_EXPLORER.allows(tool(TOOL_NAME))).toBe(true);
    for (const kind of [CODER, REVIEWER, WORKER]) expect(kind.allows(tool(TOOL_NAME))).toBe(false);
  });

  it('stops offering it at the bottom of the chain, rather than offering what cannot be used', () => {
    const offer = [tool(TOOL_NAME), tool('read_file')];
    const context = (depth: number): ToolContext => ({
      signal: new AbortController().signal,
      threadId: 't',
      workspace: '/projects/demo',
      depth,
    });
    expect(specsFor(EXPLORER, context(0), offer).map((t) => t.name)).toEqual([TOOL_NAME, 'read_file']);
    expect(specsFor(EXPLORER, context(1), offer).map((t) => t.name)).toEqual([TOOL_NAME, 'read_file']);
    // Two deep: it may still read, but it has nobody left to send
    expect(specsFor(EXPLORER, context(MAX_HANDOUT_DEPTH), offer).map((t) => t.name)).toEqual(['read_file']);
  });

  it('lets none of them overwrite the workspace note, which others are writing to', () => {
    // Several run at once, so a wholesale write is one of them throwing away
    // what another just did
    for (const kind of EVERY) expect(kind.allows(tool('update_workspace_context'))).toBe(false);
  });

  // A subagent's report is words: a clip it recorded is dropped when it ends,
  // so recording from one spends the time and shows nobody anything. The
  // screenshot it may still take, which it looks at itself (see coder.ts).
  it('lets none of them record, whose whole point is showing the user, but lets them all screenshot', () => {
    for (const kind of [...EVERY, HEAD_EXPLORER]) {
      expect(kind.allows(tool('record')), kind.name).toBe(false);
    }
    expect(forbidden(tool('record'))).toBe(true);
    for (const kind of [CODER, REVIEWER, WORKER]) {
      expect(kind.allows(tool('screenshot')), kind.name).toBe(true);
    }
  });

  it('keeps the tools that move the thread into a workspace to the reply, which decides where it lives', () => {
    const moves = all.filter(({ name }) => MOVES_THREAD.has(name));
    expect(moves.map(({ name }) => name).sort()).toEqual(['create_workspace', 'enter_workspace']);
    const context: ToolContext = {
      signal: new AbortController().signal,
      threadId: 't',
      workspace: '/projects/demo',
      depth: 0,
    };
    for (const one of moves) {
      expect(forbidden(one), one.name).toBe(true);
      for (const kind of [...EVERY, HEAD_EXPLORER]) {
        expect(kind.allows(one), `${kind.name}: ${one.name}`).toBe(false);
        expect(specsFor(kind, context, all).map(({ name }) => name)).not.toContain(one.name);
      }
    }
  });

  it('lets the kinds that do the work put the thread on a branch', () => {
    const branching = all.filter(({ name }) => name === 'create_branch' || name === 'enter_branch');
    expect(branching).toHaveLength(2);
    const context: ToolContext = {
      signal: new AbortController().signal,
      threadId: 't',
      workspace: '/projects/demo',
      depth: 0,
    };
    for (const one of branching) {
      expect(forbidden(one), one.name).toBe(false);
      // The kinds that change things, and so are the ones that find the work wants a branch
      for (const kind of [CODER, REVIEWER, WORKER]) {
        expect(kind.allows(one), `${kind.name}: ${one.name}`).toBe(true);
        expect(specsFor(kind, context, all).map(({ name }) => name)).toContain(one.name);
      }
      // The ones that only look have no use for it, and are named their tools one by one
      for (const kind of [EXPLORER, HEAD_EXPLORER]) {
        expect(kind.allows(one), `${kind.name}: ${one.name}`).toBe(false);
      }
      // And neither has a thread with nowhere to branch
      expect(specsFor(CODER, { ...context, workspace: undefined }, all).map(({ name }) => name)).not.toContain(
        one.name
      );
    }
  });

  it('lets them add to the workspace note, which cannot lose anything — except an explorer', () => {
    for (const kind of [CODER, REVIEWER, WORKER, HEAD_EXPLORER]) {
      expect(kind.allows(tool('add_to_workspace_context'))).toBe(true);
    }
    // An explorer's findings go back in its report, and the head explorer that
    // sent it writes the project's note from those reports (see head.ts). Several
    // explorers reading at once would otherwise all be writing the one note.
    expect(EXPLORER.allows(tool('add_to_workspace_context'))).toBe(false);
  });

  it('gives a reviewer the review tools and keeps them from everyone else', () => {
    const reply = tool('reply_to_comment', { needsReview: true });
    expect(REVIEWER.allows(reply)).toBe(true);
    for (const kind of [CODER, EXPLORER, WORKER]) expect(kind.allows(reply)).toBe(false);
  });

  it('gives a coder and a worker the tools that change files', () => {
    for (const kind of [CODER, WORKER]) {
      expect(kind.allows(tool('write_file'))).toBe(true);
      expect(kind.allows(tool('edit_file'))).toBe(true);
    }
  });

  it('keeps an explorer from changing anything, so it can run beside a coder', () => {
    for (const name of ['write_file', 'edit_file']) expect(EXPLORER.allows(tool(name))).toBe(false);
    // It can still look, read, and keep a note of its own — which nothing else
    // writes to, so it cannot lose another's work (see ../../src/sandbox)
    for (const name of ['search_workspace', 'read_file', 'add_to_context', 'save_context']) {
      expect(EXPLORER.allows(tool(name))).toBe(true);
    }
  });

  it("lets every kind read and write the workspace's notes, which is where what is found out goes", () => {
    // Each is added under its own subject, so several subagents writing at
    // once cannot lose one another's work (see ../../src/harness/notes.ts) —
    // which is why the explorer has these and not the note every message
    // carries
    for (const kind of [...EVERY, HEAD_EXPLORER]) {
      expect(kind.allows(tool('add_workspace_note'))).toBe(true);
      expect(kind.allows(tool('search_workspace_notes'))).toBe(true);
    }
  });

  it('leaves the general word about the notes to every kind but the explorers', () => {
    // An explorer's prompt is about the notes from end to end, so it is not
    // told the general thing after the particular one; every other kind has
    // the tools and no word of them in its own prompt (see Kind.saysNotes and
    // notesFor in ../../src/subagents/run.ts)
    expect(EXPLORER.saysNotes).toBe(true);
    expect(HEAD_EXPLORER.saysNotes).toBe(true);
    for (const kind of [CODER, REVIEWER, WORKER]) expect(kind.saysNotes).toBeUndefined();
  });

  it("lets nothing into an explorer that isn't named: a new tool is not read-only by default", () => {
    expect(EXPLORER.allows(tool('deploy_to_production'))).toBe(false);
  });

  // The union below is what hid a bug: the list named list_files, which is the
  // workspace's own listing tool, and not list_workspace, which is the
  // container's — so an explorer handed work by a model could search and read
  // but could not see what was in a directory, and this test passed anyway.
  // Each set has to be asked separately for the kinds of tool an explorer
  // cannot do its job without.
  it('gives an explorer something to look, list and read with in either set', () => {
    const sets = {
      container: all,
      workspace: explorerTools('/projects/demo', 't'),
    };
    for (const [which, set] of Object.entries(sets)) {
      const offered = set.filter((one) => EXPLORER.allows(one)).map(({ name }) => name);
      for (const job of [/^search_workspace$/, /^list_/, /^read_file$/]) {
        expect(
          offered.filter((name) => job.test(name)),
          `${which}: ${job}`
        ).not.toEqual([]);
      }
    }
  });

  // What the finding-out step's refusal of every other kind promises in so
  // many words: "the explorer kind, which reads and writes notes and cannot
  // change anything" (see ../../src/tools/subagents.ts). run_command was in
  // the list, which made that untrue — a command can do anything — and left
  // the read-only step able to change the project through the one kind it was
  // allowed to send.
  it('gives an explorer nothing that can change anything, in either set', () => {
    const every = [...all, ...explorerTools('/projects/demo', 't')];
    const changes = ['write_file', 'edit_file', 'run_command', 'sync_workspace', 'update_workspace_context'];
    for (const name of changes) {
      const one = every.find((tool) => tool.name === name);
      if (one) expect(EXPLORER.allows(one), name).toBe(false);
    }
    // ...and the commands it does get are the ones that cannot write
    expect(EXPLORER.allows(tool('run_reading_command'))).toBe(true);
  });

  it("names only tools that really exist in the explorer's list", () => {
    // The list is by name, so a tool renamed elsewhere must show up here. An
    // explorer is run against the registry when a model hands work out, and
    // against the workspace's own tools for a workspace's first look (see
    // ../../src/harness/project.ts), so both sets count.
    const real = new Set([...all, ...explorerTools('/projects/demo', 't')].map(({ name }) => name));
    expect([...ALLOWED].filter((name) => !real.has(name))).toEqual([]);
    expect([...HEAD_ALLOWED].filter((name) => !real.has(name))).toEqual([]);
  });

  it('lets the head explorer do everything an explorer does', () => {
    for (const name of ALLOWED) expect(HEAD_EXPLORER.allows(tool(name))).toBe(true);
    // ...and it changes nothing, as they do not
    expect(HEAD_EXPLORER.allows(tool('write_file'))).toBe(false);
  });
});

describe('what the head explorer is told', () => {
  const said = () => unwrapped(HEAD_EXPLORER.prompt);

  it('is to read almost nothing itself: enough to name the parts, and no further', () => {
    expect(said()).toContain('You are not the one who reads this project');
    expect(said()).toContain('Look only as far as you must to see what the parts are, and then stop looking');
    expect(said()).toContain('Two or three tool calls, not ten');
    // What it reads, it reads while every explorer it has not sent yet is idle
    expect(said()).toContain('Do not open source files to understand them');
    expect(said()).toContain('read while nobody else is reading anything');
  });

  it('is to search the notes first, in case somebody got part of the way here before it', () => {
    expect(said()).toContain('Ask search_workspace_notes first');
    expect(said()).toContain('it names the parts for you without your reading anything');
    expect(said()).toContain('send the explorers at what is not');
  });

  it('is to send explorers the moment it can name an area, not once it is sure', () => {
    expect(said()).toContain('Hand an area out the moment you can name it');
    expect(said()).toContain('Do not keep looking to be sure you have found them all before you send anybody');
    // Being early costs nothing, because a missed area has a second round
    expect(said()).toContain('can go out in a second round');
    expect(said()).toContain('one agent instead of five');
    // However many parts there are: holding one back buys nothing
    expect(said()).toContain('Send one for every part there is to look into');
    expect(said()).toContain('they all read at the same time');
    // A task an explorer cannot act on is a wasted explorer
    expect(said()).toContain('the explorer cannot see this conversation');
    expect(said()).toContain('Do not give two explorers the same ground');
  });

  it('is to send a second round rather than go and look itself', () => {
    expect(said()).toContain('send a second round out for it rather than going there yourself');
  });

  it('is told that what comes back is the shape of each area, the findings being written down already', () => {
    expect(said()).toContain("writes what it finds into the project's notes as it goes");
    expect(said()).toContain('What comes back to you is not those findings but the shape of each area');
  });

  it('is to write one short note, and is told what does not belong in it', () => {
    // The detail is in the notes the explorers wrote (see
    // ../../src/harness/notes.ts); putting it here too would charge every
    // message in the workspace for what one search finds
    expect(said()).toContain('It is one short note');
    expect(said()).toContain('it is the overview');
    expect(said()).toContain('not a summary of everything your explorers found');
    expect(said()).toContain('Nothing else belongs in it');
    expect(said()).toContain('those are notes, not this');
  });

  it('is what the note has to end up saying, which is what the next thread needs', () => {
    // How to run it, and what a bare container would be missing
    expect(said()).toContain('How to run it, and how to build it: the actual commands');
    expect(said()).toContain('What has to be installed for any of that to work');
    expect(said()).toContain('a bare container would not have');
    // ...and the tests, as they are written rather than that they exist
    expect(said()).toContain('what a test in this project looks like');
    expect(said()).toContain('so that a test added');
  });

  it('is to write as it goes, and to write only what outlives the task', () => {
    expect(said()).toContain('as you settle each of those, not at the end');
    expect(said()).toContain('only what will still be true tomorrow');
    expect(said()).toContain('Leave out what the task in hand is');
  });

  it('is to say its report out loud, since that is all that comes back', () => {
    expect(said()).toContain('report back briefly');
    expect(said()).toContain('a run that ends on a tool call comes back empty');
  });
});

describe('what each kind is told', () => {
  it('tells a coder to make the change asked for and nothing else, and to check it', () => {
    const said = unwrapped(CODER.prompt);
    expect(said).toContain('one change to make');
    expect(said).toContain('Make the change that was asked for and no more');
    // The failure mode of a coding subagent is tidying up around itself
    expect(said).toContain('Do not refactor, rename, reformat or tidy anything you were not asked about');
    // Follow what is there rather than what is good
    expect(said).toContain('Follow what is already there');
    expect(said).toContain('Prefer changing part of a file over');
    // ...which is asked for as the thing to do, and no longer as a reason to
    // read first: that sentence cost a round whether or not the change needed
    // one, and the edit tool refuses text that does not match the file anyway
    // (see the comment in ../../src/subagents/coder.ts)
    expect(said).not.toContain('Before you write, read');
    // The bound on the reading stayed, being about how far afield to go
    expect(said).toContain('usually the whole of the reading');
    expect(said).toContain('rather than reading on to be sure');
    // And leave it working
    expect(said).toContain('typecheck, build or test what you touched, run it');
    expect(said).toContain('Do not leave it broken');
    expect(said).toContain('the paths you changed and what changed in each');
  });

  it('tells an explorer to find one thing out and write down what it found', () => {
    const said = unwrapped(EXPLORER.prompt);
    expect(said).toContain('You are an explorer');
    expect(said).toContain('write down what you found so that nobody has to find it out again');
    // One searchable note per thing, as it goes rather than at the end (see
    // ../../src/harness/notes.ts)
    expect(said).toContain('Write each thing down with add_workspace_note as you establish it, not at the end');
    expect(said).toContain('One note per thing');
    expect(said).toContain('Write down only what will still be true tomorrow');
    // ...and it reads what the explorers before it wrote before going looking
    expect(said).toContain('Start with search_workspace_notes');
    // Written for whoever reads it later, who has not seen the task
    expect(said).toContain('read on its own by somebody who has not seen your work');
    // Not the place for how far it got
    expect(said).toContain('Do not write down what the task in hand is');
    // And it changes nothing
    expect(said).toContain('You cannot change the project and should not try');
    expect(said).toContain('search_workspace');
  });

  it('tells an explorer that its report is the shape of the area and not the findings themselves', () => {
    // Five explorers paraphrasing their notes into their reports is the window
    // of the model that sent them spent on what it could have searched for
    const said = unwrapped(EXPLORER.prompt);
    expect(said).toContain('Your report is not your findings');
    expect(said).toContain('keep it to the shape of what you explored');
    expect(said).toContain('which of your notes to search for');
    expect(said).toContain('Do not copy your notes into it');
    // Said as what to write and not only as what to leave out: the report is
    // the sense the area made, which is the one thing no note can hold
    expect(said).toContain('written a level up from the notes');
    expect(said).toContain('Write the conclusion you came to, not the ground you covered');
    expect(said).toContain('it belongs in the note and not here');
    // ...and it points at the notes it left rather than quoting them
    expect(said).toContain('name the subjects of the notes you wrote');
    // ...and it is bounded, being read alongside its siblings'
    expect(EXPLORER.result).toBeLessThan(CODER.result);
  });

  // An area that turns out to be several areas is split rather than read end to
  // end, the way the head explorer splits the project
  it('tells an explorer to split an area that is really several, and early', () => {
    const said = unwrapped(EXPLORER.prompt);
    expect(said).toContain(`hand them out with ${TOOL_NAME} as explorers of their own`);
    expect(said).toContain('Do that early, while there are rounds left to do it in');
    // ...and that each task it writes has to stand on its own
    expect(said).toContain('write each task so that it stands on its own');
    expect(EXPLORER.allows(tool(TOOL_NAME))).toBe(true);
  });

  it('lets nobody else hand work out, since nothing would be waiting for it', () => {
    for (const kind of [CODER, REVIEWER, WORKER]) expect(kind.allows(tool(TOOL_NAME))).toBe(false);
  });

  it('tells every kind to write its answer out as its reply, nothing else coming back', () => {
    for (const kind of EVERY) {
      const said = unwrapped(kind.prompt);
      // The failure this guards against: a model that works the answer out in
      // its reasoning, or ends on a tool call, and brings back nothing
      expect(said).toContain('as your reply');
      expect(said).toContain('in words');
      expect(said).toContain('never writes it down');
      // Asked again, it answers from what it has rather than going back to work
      expect(said).toContain('asked for your report a second time');
    }
  });

  it('tells every kind that its report is read by the assistant and asks nothing back', () => {
    for (const kind of EVERY) {
      const said = unwrapped(kind.prompt);
      expect(said).toMatch(/assistant that sent you/);
      expect(said.toLowerCase()).toContain('do not ask');
    }
  });
});

// The kind that is a job rather than a piece of work (see
// ../../src/subagents/agent.ts). What runs one is tested in ./agent.test.ts;
// this is about what it is allowed and what it is told.
describe('the agent kind', () => {
  const said = () => unwrapped(AGENT.prompt);

  it('is run through the reply flow, not the loop the other kinds share', () => {
    expect(AGENT.run).toBe(throughTheReplyFlow);
    // ...which is the one thing that makes it different in kind rather than in
    // degree: every other kind is the loop in run.ts with a different prompt
    for (const kind of [...EVERY, HEAD_EXPLORER]) expect(kind.run).toBeUndefined();
  });

  it('has no ceiling on its rounds, where every piece of work has one', () => {
    expect(AGENT.steps).toBe(Infinity);
    for (const kind of [...EVERY, HEAD_EXPLORER]) expect(Number.isFinite(kind.steps)).toBe(true);
  });

  it('brings back most, having the whole account of a job to give', () => {
    expect(AGENT.result).toBeGreaterThan(CODER.result);
    expect(AGENT.result).toBeGreaterThan(WORKER.result);
  });

  it('may hand work out, wait for it, and write to it while it runs', () => {
    for (const name of [TOOL_NAME, WAIT_TOOL, MESSAGE_TOOL]) expect(AGENT.allows(tool(name)), name).toBe(true);
  });

  it('may change the files and run things, as the job needs', () => {
    for (const name of ['write_file', 'edit_file', 'run_command', 'screenshot']) {
      expect(AGENT.allows(tool(name)), name).toBe(true);
    }
  });

  it('may not do the four things that belong to the reply that sent it', () => {
    // Replace the note every message in the workspace carries, or move the
    // thread into a workspace, or record something for the user to watch —
    // and, above, ask the user anything
    for (const name of ['update_workspace_context', 'create_workspace', 'enter_workspace', 'record']) {
      expect(AGENT.allows(tool(name)), name).toBe(false);
    }
    // ...nor answer the user's review comments, which is a reviewer's job
    expect(AGENT.allows(tool('reply_to_comment', { needsReview: true }))).toBe(false);
  });

  it('is the only kind that may write to a subagent, as it is the only kind with siblings to confuse', () => {
    // A kind that cannot hand work out has no subagents of its own, so every
    // name it could write to is a sibling in the middle of somebody else's
    // piece (see MESSAGE_TOOL in ../../src/subagents/kind.ts)
    expect(forbidden(tool(MESSAGE_TOOL))).toBe(true);
    for (const kind of [...EVERY, HEAD_EXPLORER]) expect(kind.allows(tool(MESSAGE_TOOL)), kind.name).toBe(false);
  });

  it('is told it has the job whole, with the tools and the rounds to work it through', () => {
    expect(said()).toContain('given a job of your own by another assistant');
    expect(said()).toContain('no limit on how many rounds you take');
    expect(said()).toContain('subagents of your own');
  });

  it('is told to keep to its job, several of them being at work in one container', () => {
    expect(said()).toContain('Do the job you were given and nothing beyond it');
    expect(said()).toContain('do not refactor, rename, reformat or tidy anything outside it');
    expect(said()).toContain('somebody else may be in that file at this moment');
  });

  it('is told to hand out the parts that are plainer than the whole and keep the rest', () => {
    expect(said()).toContain('Hand out the parts of it that are plainer than the whole');
    expect(said()).toContain('Keep for yourself the deciding');
  });

  it('is told it cannot ask the user, and what to do with what it cannot settle', () => {
    expect(said()).toContain('You cannot ask the user anything');
    expect(said()).toContain('a question you ask them reaches nobody');
    expect(said()).toContain('say in your report what you settled and why');
  });

  it('is told it will be written to, and that the answer goes back in that turn', () => {
    expect(said()).toContain('it can write to you while you work');
    expect(said()).toContain('goes straight back to it');
    expect(said()).toContain('the new instruction is the one to follow');
    // ...and that it still cannot start one
    expect(said()).toContain('You still cannot start one of these');
  });

  it('is told how much room its report has and what belongs in it', () => {
    expect(said()).toContain(`${AGENT.result} characters`);
    expect(said()).toContain('cut off');
    expect(said()).toContain('what you decided that the code could not have told it');
    // As every kind is told, its reply being the only thing that comes back
    expect(said()).toContain('as your reply');
    expect(said()).toContain('in words');
    expect(said()).toContain('never writes it down');
  });

  it('leaves the general word about the notes to the flow it runs in, which says it already', () => {
    expect(AGENT.saysNotes).toBe(true);
  });

  // It works in the thread's container on the thread's files, as every other
  // kind does, so a thread without a workspace can still hand it a job
  it('wants no workspace of its own', () => {
    expect(AGENT.needsWorkspace).toBeUndefined();
  });
});

// The reviewer of a reply's changes, which reads them and tries them (see ../../src/subagents/tester.ts and
// ../../src/harness/verifier.ts)
describe('the tester', () => {
  const real = (name: string) => all.find((one) => one.name === name) as Tool;

  it('is sent by the review, never asked for by a model', () => {
    expect(KINDS).not.toContain(TESTER);
    expect(byName('tester')).toBeUndefined();
  });

  it('can find out, run the project, use the app and see it, and keep how it got the app running', () => {
    for (const name of ['read_file', 'search_workspace', 'run_command', 'thread_diff', 'use_app', 'screenshot']) {
      expect(TESTER.allows(real(name)), name).toBe(true);
    }
    expect(TESTER.allows(real('save_run_recipe'))).toBe(true);
  });

  it('can change no file, hand nothing out, move the thread nowhere, and ask nobody anything', () => {
    const not = [
      'write_file',
      'edit_file',
      'sync_workspace',
      'update_workspace_context',
      'create_branch',
      'enter_branch',
    ];
    for (const name of [...not, TOOL_NAME, MESSAGE_TOOL, WAIT_TOOL, ASK_TOOL, 'record', ...MOVES_THREAD]) {
      expect(TESTER.allows(real(name) ?? tool(name)), name).toBe(false);
    }
    // ...not even through the tools that ask the user first: nobody is watching a review to be asked
    expect(TESTER.allows(real('run_host_command'))).toBe(false);
    expect(TESTER.allows(real('read_user_file'))).toBe(false);
  });

  it("lets nothing in that isn't named, and names only tools that really exist", () => {
    expect(TESTER.allows(tool('a_tool_added_later'))).toBe(false);
    const names = new Set(all.map(({ name }) => name));
    expect([...TESTER_ALLOWED].filter((name) => !names.has(name))).toEqual([]);
  });

  it('is given room for the checks and the app, and works in a workspace', () => {
    expect(TESTER.steps).toBeGreaterThan(CODER.steps);
    expect(TESTER.least).toBeGreaterThanOrEqual(CODER.least!);
    expect(TESTER.needsWorkspace).toBe(true);
  });

  it('is told to try the change in the app, change nothing, and end on a verdict the app can read', () => {
    const told = unwrapped(TESTER.prompt);
    expect(told).toContain('recipe: true');
    expect(told).toContain('You change nothing');
    expect(told).toContain('one thing the author may not have');
    expect(told).toContain('"Checked:"');
    expect(told).toContain('the single word PASS on a line of its own');
    expect(told).toContain('never claim to have run or seen anything you did not');
  });
});
