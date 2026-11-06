// Rounds asked for rather than cut off at: how much one ask buys, how often it
// may be asked, and the two refusals. The loops that hold an allowance are
// tested where they are — a reply's in ./index.test.ts, a subagent's in
// ../subagents/index.test.ts.

import { describe, expect, it, vi } from 'vitest';
import * as allowance from '../../src/harness/allowance';
import * as log from '../../src/log';

const REASON = 'The failure reproduces; one run of the importer with the blank date would show which call throws.';

describe('what one grant buys', () => {
  // A quarter of what the allowance started with, so that it stays in
  // proportion to the work the loop was sized for
  it('is a quarter of the allowance', () => {
    expect(allowance.grant(40)).toBe(10);
    expect(allowance.grant(80)).toBe(20);
  });

  // The floor is what carries one guess through: reproduce it, instrument it,
  // read what that showed, and be wrong. Fewer than that buys half an
  // experiment.
  it('is never fewer than five, however small the allowance', () => {
    expect(allowance.grant(1)).toBe(5);
    expect(allowance.grant(10)).toBe(5);
  });

  // ...and the ceiling is there because no one guess has needed more: a loop
  // with a large allowance asking for a quarter of it again is asking for room
  // to do something other than what the asking is for
  it('is never more than twenty, however large it is', () => {
    expect(allowance.grant(400)).toBe(20);
    expect(allowance.grant(4000)).toBe(20);
  });
});

describe('asking', () => {
  it('adds the grant to what the loop has, and says what the ceiling is now', () => {
    const more = allowance.create(40);
    expect(more.rounds()).toBe(0);
    const answer = more.request(REASON);
    expect(more.rounds()).toBe(10);
    expect(answer).toContain('10 more rounds');
    expect(answer).toContain('is 50 rather than 40');
  });

  // The model was told its tools were no longer its to call, and that message
  // is still in front of it: a grant that did not take it back would be a
  // grant of rounds the model believes it cannot use (see spent in ./phases.ts)
  it('says the tools are the step’s again, since nothing else takes that back', () => {
    expect(allowance.create(40).request(REASON)).toContain('tools are yours again');
  });

  it('counts the second grant on top of the first', () => {
    const more = allowance.create(40);
    more.request(REASON);
    const second = more.request(REASON);
    expect(more.rounds()).toBe(20);
    expect(second).toContain('is 60 rather than 50');
  });

  // Two and no more: the third ask is a model that is not converging, and what
  // serves the user then is the account of what it ruled out
  it('is refused after two grants, and says what is left to do instead', () => {
    const more = allowance.create(40);
    for (let n = 0; n < allowance.MAX_GRANTS; n++) more.request(REASON);
    expect(more.may()).toBe(false);
    const refused = more.request(REASON);
    expect(refused).toContain('No more rounds');
    expect(refused).toContain('what you ruled out');
    expect(more.rounds()).toBe(20);
  });

  // Rounds are turns, and what runs out first on a small model is room. Rounds
  // granted with the window full are rounds with nowhere to put what they
  // return, so the refusal points at the one thing that costs the asker no
  // room at all.
  it('is refused for want of room, and points at an explorer rather than at the ceiling', () => {
    const more = allowance.create(40, { room: () => false });
    expect(more.may()).toBe(false);
    const refused = more.request(REASON);
    expect(refused).toContain('not the rounds that are short but the room');
    expect(refused).toContain('explorer');
    expect(more.rounds()).toBe(0);
  });

  // Asked at the moment of asking rather than once, because what it depends on
  // is how full the window is now
  it('asks about the room again each time', () => {
    let room = false;
    const more = allowance.create(40, { room: () => room });
    more.request(REASON);
    expect(more.rounds()).toBe(0);
    room = true;
    more.request(REASON);
    expect(more.rounds()).toBe(10);
  });

  it('counts the grants it has left, so a loop can tell whether to point at the door', () => {
    const more = allowance.create(40);
    expect(more.may()).toBe(true);
    more.request(REASON);
    expect(more.may()).toBe(true);
    more.request(REASON);
    expect(more.may()).toBe(false);
  });

  // The reason is not judged here — nothing in this module reads it — but it is
  // kept, because it is the record of why a step ran longer than its share
  it('logs the reason it was given, with the rounds and whose allowance it is', () => {
    const info = vi.spyOn(log, 'info');
    allowance.create(40, { where: { scope: 'explore' } }).request(REASON);
    expect(info).toHaveBeenCalledWith(
      'allowance.granted',
      expect.objectContaining({ scope: 'explore', rounds: 10, total: 50, grants: 1, reason: REASON })
    );
  });

  it('names what the allowance is of in the words the model’s own instructions use', () => {
    expect(allowance.create(40, { label: 'this piece of work' }).request(REASON)).toContain('this piece of work');
  });
});
