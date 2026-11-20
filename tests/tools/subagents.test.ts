// The tool a model hands work out with, and what each step may hand out
// through it (see ../../src/tools/subagents.ts). Running a subagent is tested
// in ../subagents/index.test.ts; this is about the bound on the call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';

const subagents = vi.hoisted(() => ({ run: vi.fn(), waitFor: vi.fn() }));
vi.mock('../../src/subagents', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/subagents')>();
  return { ...real, run: subagents.run, waitFor: subagents.waitFor };
});

import { messageTool, tool, waitTool } from '../../src/tools/subagents';
import { MESSAGE_TOOL, WAIT_TOOL, mailbox } from '../../src/subagents';
import type { Phase, ToolContext } from '../../src/types';

const context = (phase?: Phase): ToolContext => ({
  signal: new AbortController().signal,
  threadId: 't1',
  phase,
});

const piece = (name: string, kind?: string) => ({ name, task: `do ${name}`, ...(kind ? { kind } : {}) });
const hand = (pieces: ReturnType<typeof piece>[], phase?: Phase) => tool.run({ tasks: pieces }, context(phase));

describe('what the finding-out step may hand out', () => {
  it('sends explorers, which read and write notes and cannot change anything', async () => {
    subagents.run.mockResolvedValue('found it');
    await expect(hand([piece('parser', 'explorer'), piece('tests', 'explorer')], 'explore')).resolves.toBe('found it');
    expect(subagents.run.mock.calls[0][0].map((task: { name: string }) => task.name)).toEqual(['parser', 'tests']);
  });

  it.each([['coder'], ['worker']])('refuses a %s there, and says which kind to send instead', async (kind) => {
    subagents.run.mockClear();
    await expect(hand([piece('change it', kind)], 'explore')).rejects.toThrow(/only hands work to the "explorer"/);
    // Refused before anything is started: a coder sent from there would have
    // changed files the step says it cannot touch
    expect(subagents.run).not.toHaveBeenCalled();
  });

  it('names the pieces that asked for the wrong kind, there being several', async () => {
    const failed = hand([piece('a', 'explorer'), piece('b', 'coder'), piece('c', 'worker')], 'explore');
    await expect(failed).rejects.toThrow(/"b", "c"/);
  });

  it('refuses the default kind there, which is a worker rather than an explorer', async () => {
    subagents.run.mockClear();
    await expect(hand([piece('whatever')], 'explore')).rejects.toThrow(/only hands work to the "explorer"/);
  });
});

// The planning step is a step that changes nothing, so it may send one kind of
// subagent and no other, for the same reason the finding-out step may (see
// ../harness/phases.ts, which offers the handout tools to both).
describe('what the planning step may hand out', () => {
  it('sends explorers, which read and write notes and cannot change anything', async () => {
    subagents.run.mockResolvedValue('found it');
    await expect(hand([piece('parser', 'explorer')], 'plan')).resolves.toBe('found it');
    expect(subagents.run.mock.calls[0][0].map((task: { name: string }) => task.name)).toEqual(['parser']);
  });

  it.each([['coder'], ['worker'], ['agent']])('refuses a %s there, and names the kind instead', async (kind) => {
    subagents.run.mockClear();
    await expect(hand([piece('change it', kind)], 'plan')).rejects.toThrow(/only hands work to the "explorer"/);
    // Refused before anything is started: a coder sent from the planning step
    // would have changed files the step says it cannot touch
    expect(subagents.run).not.toHaveBeenCalled();
  });

  // Said by naming the steps it holds for, the description being the same in
  // every step now (see EVERY_STEP). What the planning step may send is kept by
  // the refusal above, and the schema no longer narrows it either.
  it('names the planning step as one that sends the one kind', async () => {
    const said = unwrapped(tool.description);
    expect(said).toContain('In the finding-out step and the planning step every piece goes to an explorer');
    expect(said).toContain('a piece for any other kind is refused there');
    const schema = tool.inputSchema as {
      properties: { tasks: { items: { properties: { kind: { enum: string[] } }; required: string[] } } };
    };
    expect(schema.properties.tasks.items.properties.kind.enum).toContain('coder');
  });
});

describe('what the doing step may hand out', () => {
  it.each([['coder'], ['worker'], ['explorer']])('sends a %s, having every kind', async (kind) => {
    subagents.run.mockResolvedValue('done');
    await expect(hand([piece('a', kind)], 'execute')).resolves.toBe('done');
  });

  it('is unbounded in a reply that is not worked through in steps, which has no phase', async () => {
    subagents.run.mockResolvedValue('done');
    await expect(hand([piece('a', 'coder')])).resolves.toBe('done');
  });
});

describe('which steps hold the tools at all', () => {
  it('offers handing out, and waiting, in the steps that may send work', () => {
    expect(tool.phases).toEqual(['explore', 'plan', 'execute', 'suggest']);
    // Work handed out and not waited for has to be collectable in the step
    // that started it
    expect(waitTool.phases).toEqual(['explore', 'plan', 'execute', 'suggest']);
    // ...and writable to, for the same reason
    expect(messageTool.phases).toEqual(['explore', 'plan', 'execute', 'suggest']);
  });
});

// Writing to a subagent that is still working (see
// ../../src/tools/subagents.ts). The letterbox itself is tested in
// ../subagents/mailbox.test.ts; this is about the call.
describe('writing to a subagent', () => {
  const THREAD = 'a0ca1f3e-9b52-4a0e-8d18-25b8c8a1b6f2';
  const mine: ToolContext = { signal: new AbortController().signal, threadId: THREAD };
  const write = (input: Record<string, unknown>) => messageTool.run(input, mine) as Promise<string>;
  afterEach(() => mailbox.forget(THREAD));

  it('puts the message to it and comes back with what it said', async () => {
    mailbox.open(THREAD, 'the importer');
    const asked = write({ name: 'the importer', message: 'Drop the legacy path.' });
    const [letter] = mailbox.take(THREAD, 'the importer');
    expect(letter.text).toBe('Drop the legacy path.');
    letter.answer('Dropped it.');
    await expect(asked).resolves.toBe('Dropped it.');
  });

  it('asks for both of the two things it needs, rather than writing an empty message to nobody', async () => {
    mailbox.open(THREAD, 'the importer');
    await expect(write({ message: 'hello' })).rejects.toThrow(/"name" has to be the name you gave/);
    await expect(write({ name: 'the importer', message: '  ' })).rejects.toThrow(/"message" has to be/);
  });

  it('says who there is to write to when the name is one nobody is running under', async () => {
    mailbox.open(THREAD, 'the importer');
    await expect(write({ name: 'the parser', message: 'hello' })).rejects.toThrow(/Still running: the importer\./);
  });
});

describe('what the model is told about writing to one', () => {
  const said = unwrapped(messageTool.description);

  it('says what comes back from it: the subagent’s own words, in the round that read the message', () => {
    expect(said).toContain('get back what it says');
    expect(said).toContain('arrives as a turn of its own in the middle of that');
    expect(said).toContain('following your message over what it was originally given');
  });

  it('says when it is worth a round: something has changed since the piece went out', () => {
    expect(said).toContain('something has changed since you handed the piece out');
    expect(said).toContain('handing the same piece out again costs the whole of it twice over');
  });

  // One waited for has the sender's round, so there is nobody at that end
  it('says which subagents can be written to at all, and which is most worth talking to', () => {
    expect(said).toContain('Only the subagents you started without waiting for (blocking: false)');
    expect(said).toContain('An agent is the one most worth talking to');
    expect(said).toContain(`until you collect it with ${WAIT_TOOL}`);
  });

  it('is called what the kinds are told it is called', () => {
    expect(messageTool.name).toBe(MESSAGE_TOOL);
  });
});

describe('what the model is told about handing work out', () => {
  const said = (phase?: Phase) => unwrapped(tool.describe?.(phase) ?? tool.description);
  const kinds = (phase?: Phase) => {
    const schema = (tool.schemaFor?.(phase) ?? tool.inputSchema) as {
      properties: { tasks: { items: { properties: { kind: { enum: string[] } }; required: string[] } } };
    };
    return schema.properties.tasks.items;
  };

  // What ../../src/subagents/index.ts used to say as well, which is read here
  // instead: at the moment the model writes a piece rather than at the top of
  // the prompt, and once rather than twice
  it('says what goes in a piece, which is what the prompt no longer says twice', () => {
    expect(said()).toContain('cannot see this conversation');
    expect(said()).toContain('It cannot ask you anything');
    expect(said()).toContain('Say which kind of subagent each piece wants');
    expect(said()).toContain('something you can do in a single tool call');
    expect(said()).toContain('pieces that would write to the same file');
    for (const kind of ['coder', 'explorer', 'worker']) expect(said()).toContain(kind);
  });

  it('asks for a short explanation of the change, and says a coder is rated below the thread', () => {
    for (const phase of [undefined, 'execute' as const]) {
      expect(said(phase)).toContain('rated lower than the complexity of this thread');
    }
    expect(said()).toContain("don't over-explain");
  });

  // Every step is told all of it, each part named by the step it holds for,
  // and the same words whatever step is asking: a description that changes
  // with the step ends what two steps of a reply share of their prompts at
  // this tool, which is the first one they are sent (see breadth in
  // ../../src/harness/phases.ts).
  it('says the same thing in every step', () => {
    for (const phase of ['explore', 'plan', 'execute', 'suggest'] as const) {
      expect(said(phase)).toBe(said());
    }
  });

  // The two steps that may send one kind only, which run() refuses above
  it('names the steps where every piece goes to an explorer', () => {
    expect(said()).toContain('In the finding-out step and the planning step every piece goes to an explorer');
    expect(said()).toContain('a piece for any other kind is refused there');
  });

  // The doing step holds no tool that writes a file, so handing out is not one
  // way of making the change there but the only one
  it('says that in the doing step this is how the change gets made', () => {
    expect(said()).toContain('no tool there writes a file');
    expect(said()).toContain('in the plan goes to a coder');
  });

  // What a step that can write for itself is not to hand out. Said of the
  // tools the step holds rather than of the work, because the doing step holds
  // none that writes a file: there, a piece a single call would do is a piece
  // for a coder all the same.
  it('says not to hand out what a tool of its own would do in one call', () => {
    expect(said()).toContain('something you can do in a single tool call of your own');
  });

  // The bound is kept by the refusal and said in the description, and no
  // longer narrowed in the schema as well. A schema that changes with the step
  // ends what two steps share of their prompts at this tool, and this tool is
  // at the top of the list every step is sent (see breadth in
  // ../../src/harness/phases.ts).
  it('asks for the same thing in every step, whatever that step may send', () => {
    for (const phase of ['explore', 'plan', 'suggest'] as const) {
      expect(kinds(phase)).toEqual(kinds('execute'));
    }
    expect(kinds('execute').properties.kind.enum.length).toBeGreaterThan(1);
    expect(kinds('execute').required).not.toContain('kind');
  });
});
