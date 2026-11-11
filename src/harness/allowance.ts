// Rounds of tool calls asked for, rather than cut off at.
//
// Every loop that runs a model here runs it on an allowance of rounds: a
// reply's step budget (see maxSteps in ./index.ts), the share of that budget
// the finding-out step is given (see findingRounds in ./phases.ts), and a
// subagent's rounds (see stepsFor in ../subagents/run.ts). Each of those was a
// wall. The allowance ran out, the tools stopped answering, and the model was
// asked for whatever it had — which is the right ending for work whose size
// can be judged before it starts, and most work's can: a change the request
// describes, a file to read, a test to run.
//
// Finding a fault is the exception, and it is what the walls were worst for.
// The work is a loop — reproduce it, form a guess, test the guess — and most
// guesses are wrong, so how many turns of that loop it takes is not knowable
// from the request, which is usually one sentence saying something is broken.
// An allowance worked out from the effort the message was judged to need is
// therefore worked out from the one thing that does not predict the work, and
// a step that spends it on three refuted guesses hands the next step a
// write-up saying nothing was found.
//
// So the wall has a door in it: a model may ask for more rounds, with the tool
// named below (see ../tools/steps.ts), and gets them. Three things keep the
// door from being the same as having no wall at all:
//
// * It is asked for rather than taken, and the asking costs words. A model
//   that has to say what it has established, what is still open and what the
//   rounds are for has written much of the write-up it owed anyway; a model
//   that cannot say those things has answered the question of whether more
//   rounds would have helped.
// * There are two grants and no more. The third ask is a model that is not
//   converging, and what serves the user then is the account of what was ruled
//   out, which the step after it — or they themselves — can act on.
// * The window still rules. Rounds are turns, and what runs out first on a
//   small model is not turns but room: everything a round returns stays in
//   front of the step until the step ends (see windowBound in ./phases.ts).
//   Granting rounds there is no room for is the same lie in a larger number,
//   so a request made with the window nearly full is refused — and refused
//   towards the one thing that does not cost the asker any room, which is an
//   explorer reading in a window of its own.
//
// What this module is not is a second opinion on whether the reason is a good
// one. Nothing here reads it: the cap is what bounds the asking, and the
// reason is written for the record and for the step that follows.

import * as log from '../log';

// The tool a model asks with, as the model sees it (defined in
// ../tools/steps.ts). Named here, in the module that holds what asking gets,
// so that the prompts which tell a model about its allowance can name the tool
// without reaching into the tools (see BUDGET in ./phases.ts).
export const TOOL_NAME = 'request_more_steps';

// How many times one allowance may be added to
export const MAX_GRANTS = 2;

// ...and how much each grant adds. A quarter of what the allowance started
// with, so that a grant stays in proportion to the work the loop was sized
// for, with a floor and a ceiling under and over it because the proportion is
// not what matters at either end.
//
// The floor is what carries one guess through: reproduce it, instrument it,
// read what that showed, be wrong, and start the next one. Fewer than that and
// the grant buys a model the first half of an experiment.
//
// The ceiling is there because no single guess has ever needed more, so a loop
// with a large allowance asking for a quarter of it again is asking for room
// to do something other than what the door is for.
const SHARE = 1 / 4;
const MIN_GRANT = 5;
const MAX_GRANT = 20;

export const grant = (start: number): number => Math.min(MAX_GRANT, Math.max(MIN_GRANT, Math.ceil(start * SHARE)));

// What a grant is answered with. It has to overtake what the model was told
// when its allowance ran out — that the tools listed above it are no longer
// its to call (see spent in ./phases.ts) — because that message is still in
// front of it and nothing else takes it back.
const GRANTED = (more: number, total: number, start: number, left: number, label: string) =>
  `Granted: ${more} more rounds of tool calls, so the ceiling for ${label} is ${total} rather than ${start}. The
tools are yours again, and anything said earlier about them being spent is overtaken by this.

${
  left > 0
    ? `You may ask once more if the work turns out to need it. ${MAX_GRANTS} grants is the whole of what anyone
gets, so the next one is the last.`
    : `That was the last grant: there are no more rounds to be had after these, whatever they show.`
} Spend them on what you said you would, and write down what they show as they show it — writing still costs you
none of them.`;

// ...and what a request is refused with, which is two different refusals.
//
// Out of grants: the model is told what is left to do, because the answer to
// "I need more rounds" that helps the user is not "no" but "write down what
// you have, including the part you did not get to the bottom of".
const ENOUGH = (label: string) =>
  `No more rounds: you have asked ${MAX_GRANTS} times for ${label}, which is as often as anyone may. What is left is to
write down what you have — what you established, what you ruled out, and what you would have done next. A guess you
could not test is worth writing as a guess, plainly labelled, and it is worth more than another round of looking
that nobody is going to grant you.`;

// ...and out of room, which is not the same thing and does not want the same
// answer: there are rounds to be had and nowhere to put what they would
// return, so the way on is somebody else's window rather than more of this one.
const NO_ROOM = `No more rounds, and it is not the rounds that are short but the room: everything your calls have
returned is still in front of you, and this window is nearly full. More rounds spent filling it would be condensed
away or cut off, so granting them would only move where this ends.

What costs you no room at all is somebody else's window. Hand what is left to find out to an explorer: it reads in a
window of its own and comes back with a few sentences, leaving the detail in the workspace's notes for you or the
step after you to search. Otherwise write down what you have now, while there is still room to write it in.`;

// What a loop with no allowance in its instructions says when its budget is
// about to run out, where more of it could be had.
//
// The finding-out step is told its number up front and told again when it is
// spent (see BUDGET and spent in ./phases.ts). The reply's step budget is told
// to nobody: it is a bound on the whole reply rather than a thing any one step
// works under, and before this it was reached in silence — the loop stopped,
// and whatever had been written was what the user got, mid-change as often as
// not. So the last round says so, which is the first point at which saying it
// can change anything.
export const LAST_ROUND = `This is the last round of tool calls this reply has. When it ends, what you have written
is what the user gets.

If what is left is the writing, write it now. If what is left is work — a change half made, a check not run, a fault
you have cornered and not fixed — ask for more rounds with ${TOOL_NAME}, saying what is done, what is left and what
the rounds are for. Stopping mid-change serves the user worse than a reply that took longer, and this is the last
round in which either can be chosen.`;

export interface Allowance {
  // Rounds granted so far, to be added to the allowance the loop started with
  rounds(): number;
  // Whether another grant could be had. The loop asks before it tells a model
  // its allowance is gone, since a door that cannot be opened is better not
  // pointed at (see spent in ./phases.ts).
  may(): boolean;
  // ...and the asking itself, answered in the words the model reads
  request(reason: string): string;
}

export interface Options {
  // Whether there is room for more rounds, asked at the moment of asking
  // rather than once: what the answer depends on is how full the window is
  // now. Unset means there always is, which is what a loop that can condense
  // its way out of a full window wants (see the subagents' own condensing in
  // ../subagents/run.ts).
  room?: () => boolean;
  // What the allowance is of, in the words the model's own instructions use
  // for it
  label?: string;
  // What a log line about this allowance carries
  where?: log.Fields;
}

export function create(start: number, { room = () => true, label = 'this step', where = {} }: Options = {}): Allowance {
  let grants = 0;
  let extra = 0;
  return {
    rounds: () => extra,
    may: () => grants < MAX_GRANTS && room(),
    request(reason: string): string {
      const asked = reason.trim();
      if (grants >= MAX_GRANTS) {
        log.info('allowance.refused', { ...where, why: 'grants', grants, reason: asked });
        return ENOUGH(label);
      }
      if (!room()) {
        log.info('allowance.refused', { ...where, why: 'window', grants, reason: asked });
        return NO_ROOM;
      }
      const more = grant(start);
      grants++;
      extra += more;
      log.info('allowance.granted', { ...where, rounds: more, total: start + extra, grants, reason: asked });
      return GRANTED(more, start + extra, start + extra - more, MAX_GRANTS - grants, label);
    },
  };
}
