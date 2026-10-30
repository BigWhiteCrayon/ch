// The letterbox a subagent is written to through while it works (see
// ../../src/subagents/mailbox.ts). Delivering from it is the business of the
// loops that run a subagent, and is tested with them (see ./index.test.ts and
// ./agent.test.ts); this is about the box itself: who can be written to, what
// comes back, and that nothing is ever left waiting on an answer that is not
// coming.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { unwrapped } from '../helpers';

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), since: () => 7 }));
vi.mock('../../src/log', () => log);

import * as mailbox from '../../src/subagents/mailbox';

const THREAD = 'bd0b6a2e-0f62-4f3f-9d2b-7a42e7bdb0a1';
const live = () => new AbortController().signal;

afterEach(() => mailbox.forget(THREAD));

describe('who can be written to', () => {
  it('is whoever is running, in the order they started', () => {
    mailbox.open(THREAD, 'parser');
    mailbox.open(THREAD, 'tests');
    expect(mailbox.listening(THREAD)).toEqual(['parser', 'tests']);
  });

  it('is nobody in a thread that has nothing out', () => {
    expect(mailbox.listening(THREAD)).toEqual([]);
    expect(mailbox.listening(undefined)).toEqual([]);
  });

  // A model that wrote to the wrong name can put that right in the same round
  // if it is told which names there are
  it('refuses a name nobody is running under, and says which are', () => {
    mailbox.open(THREAD, 'parser');
    expect(() => mailbox.send(THREAD, 'parsers', 'hello', live())).toThrow(/"parsers" is still running/);
    expect(() => mailbox.send(THREAD, 'parsers', 'hello', live())).toThrow(/Still running: parser\./);
  });

  it('says plainly when there is nothing out at all, rather than naming nothing', () => {
    expect(() => mailbox.send(THREAD, 'parser', 'hello', live())).toThrow(/Still running: nothing\./);
  });

  // One that has been let go is finishing, and anything written to it now
  // would be read by nobody
  it('refuses one that has been let go', () => {
    mailbox.open(THREAD, 'parser');
    mailbox.release(THREAD, 'parser');
    expect(() => mailbox.send(THREAD, 'parser', 'hello', live())).toThrow(/is still running/);
  });
});

describe('a letter and its answer', () => {
  it('waits on the subagent, and comes back with what it said', async () => {
    mailbox.open(THREAD, 'parser');
    const asked = mailbox.send(THREAD, 'parser', 'Skip the legacy routes.', live());
    const [letter] = mailbox.take(THREAD, 'parser');
    expect(letter.text).toBe('Skip the legacy routes.');
    letter.answer('Dropped them; carrying on with v2.');
    await expect(asked).resolves.toBe('Dropped them; carrying on with v2.');
  });

  // Taken rather than copied: a letter put into a conversation twice is
  // answered twice, and the second answer reaches nobody
  it('is taken once, however often the box is asked', () => {
    mailbox.open(THREAD, 'parser');
    void mailbox.send(THREAD, 'parser', 'one', live());
    void mailbox.send(THREAD, 'parser', 'two', live());
    expect(mailbox.take(THREAD, 'parser').map(({ text }) => text)).toEqual(['one', 'two']);
    expect(mailbox.take(THREAD, 'parser')).toEqual([]);
  });

  it('is answered once, a second answer reaching nobody', async () => {
    mailbox.open(THREAD, 'parser');
    const asked = mailbox.send(THREAD, 'parser', 'how far along?', live());
    const [letter] = mailbox.take(THREAD, 'parser');
    letter.answer('Two of four files.');
    letter.answer('Three of four files.');
    await expect(asked).resolves.toBe('Two of four files.');
  });

  // The question was about work that is now over, and the report is what that
  // work came to
  it('is answered with the report where the subagent finished without answering it', async () => {
    mailbox.open(THREAD, 'parser');
    const asked = mailbox.send(THREAD, 'parser', 'how far along?', live());
    mailbox.close(THREAD, 'parser', 'Rewrote the tokenizer; tests pass.');
    await expect(asked).resolves.toBe('Rewrote the tokenizer; tests pass.');
    // ...and nothing more can be addressed to it
    expect(mailbox.listening(THREAD)).toEqual([]);
  });

  it('is given back with that said plainly when nobody gets to it in time', async () => {
    mailbox.open(THREAD, 'parser');
    const asked = mailbox.send(THREAD, 'parser', 'how far along?', live(), 1);
    await expect(asked).resolves.toMatch(/has not answered yet/);
    // The letter was delivered, so it is not sent again
    await expect(asked).resolves.toMatch(/Do not send it again/);
  });

  it('is settled when the work is stopped, rather than waiting on a model that has gone', async () => {
    mailbox.open(THREAD, 'parser');
    const stopping = new AbortController();
    const asked = mailbox.send(THREAD, 'parser', 'stop that', stopping.signal);
    stopping.abort();
    await expect(asked).resolves.toMatch(/stopped before it answered/);
  });

  it('is settled at once where the work was already stopped', async () => {
    mailbox.open(THREAD, 'parser');
    const stopped = new AbortController();
    stopped.abort();
    await expect(mailbox.send(THREAD, 'parser', 'hello', stopped.signal)).resolves.toMatch(/stopped before/);
  });

  // A promise nobody settles is a tool call that never returns
  it('is settled when the thread it was waiting in is forgotten', async () => {
    mailbox.open(THREAD, 'parser');
    const asked = mailbox.send(THREAD, 'parser', 'hello', live());
    mailbox.forget(THREAD);
    await expect(asked).resolves.toBe('The thread is gone.');
    expect(mailbox.listening(THREAD)).toEqual([]);
  });
});

describe('waiting to be written to', () => {
  it('ends as soon as a letter lands', async () => {
    mailbox.open(THREAD, 'job');
    const waiting = mailbox.arrived(THREAD, 'job', live());
    void mailbox.send(THREAD, 'job', 'now do the other half', live());
    await expect(waiting).resolves.toBe(true);
  });

  it('ends at once where one is already waiting', async () => {
    mailbox.open(THREAD, 'job');
    void mailbox.send(THREAD, 'job', 'hello', live());
    await expect(mailbox.arrived(THREAD, 'job', live())).resolves.toBe(true);
  });

  // Being collected is what tells an agent kept on for further messages that
  // there are none coming (see waitFor in ../../src/subagents/run.ts)
  it('ends with nothing when it is let go', async () => {
    mailbox.open(THREAD, 'job');
    const waiting = mailbox.arrived(THREAD, 'job', live());
    mailbox.release(THREAD, 'job');
    await expect(waiting).resolves.toBe(false);
  });

  it('ends with nothing when the work is stopped', async () => {
    mailbox.open(THREAD, 'job');
    const stopping = new AbortController();
    const waiting = mailbox.arrived(THREAD, 'job', stopping.signal);
    stopping.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it('ends with nothing for a subagent that is not running at all', async () => {
    await expect(mailbox.arrived(THREAD, 'nobody', live())).resolves.toBe(false);
  });
});

describe('what a letter is put to a subagent as', () => {
  const said = unwrapped(mailbox.WROTE_TO_YOU('Skip the legacy routes.'));

  // A message arriving out of nowhere in the middle of a piece of work is read
  // as a new task, which is the one thing it must not be taken for
  it('says who it is from, that the answer goes back, and which instruction wins', () => {
    expect(said).toContain('The assistant that sent you has written to you');
    expect(said).toContain('Skip the legacy routes.');
    expect(said).toContain('goes straight back to it');
    expect(said).toContain('that is the instruction to follow from here');
    expect(said).toContain('carry straight on with what you were doing');
  });
});

describe('what stands in for an answer the subagent never wrote', () => {
  it('is what it said, where it said anything', () => {
    expect(mailbox.answered('  Dropped them.  ', [{ name: 'edit_file' }])).toBe('Dropped them.');
  });

  // A model that reads a letter and answers with a tool call has answered
  // nothing, and the asker is owed something truer than silence
  it('is what it called, where it wrote nothing and carried on', () => {
    const back = mailbox.answered('', [{ name: 'read_file' }, { name: 'edit_file' }, { name: 'read_file' }]);
    expect(back).toContain('carried straight on working');
    // Each tool once, however many calls it made to it
    expect(back).toContain('read_file, edit_file');
  });

  it('says so plainly where it neither wrote nor called anything', () => {
    expect(mailbox.answered('', [])).toBe('It read your message and wrote nothing back in that round.');
  });
});
