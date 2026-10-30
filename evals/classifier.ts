// Judging the classifier's prompt (see ../src/harness/classifier.ts).
//
// Every message the app answers goes through the classifier first, and what it
// says decides which model replies, how much effort that model is asked for,
// and which instructions it is given. A classifier that drifts makes the whole
// app worse in a way that is hard to see from any one reply, which is why it
// is the first thing worth evaluating.
//
// Two things are judged per case:
//   sophistication  a range, not a number: nobody can say whether a request
//                   needs a 3 or a 4, but "not the smallest model" is clear
//   category        exact, being a choice between three named kinds
//
// The effort is not judged: it follows from the level by a rule rather than
// from anything the model says (see effortFor in ../src/harness/classifier.ts),
// so scoring it would be scoring the level twice.
//
// A case with no one right answer is marked ambiguous and kept for what it
// shows rather than scored. There are several: they are the interesting ones.

import * as llm from '../src/llm';
import { classify } from '../src/harness/classifier';
import type { Category, ChatMessage, Classification } from '../src/types';
import { oneOf, within, type Case, type Mark, type Suite } from './harness';
import { configure } from './judges';

interface Input {
  // The conversation, oldest first; most cases are one message
  messages: ChatMessage[];
  // Set for a thread started in a workspace, which is classified differently
  workspace?: string;
}

interface Expected {
  sophistication: readonly [number, number];
  category: readonly Category[];
}

const FOLDER = '/projects/demo';
const user = (content: string): ChatMessage => ({ role: 'user', content });
const said = (content: string): ChatMessage => ({ role: 'assistant', content });

// A case: the message, what a good reading of it looks like, and why
function one(
  name: string,
  messages: ChatMessage[],
  expected: Expected,
  extra: { workspace?: boolean; ambiguous?: string } = {}
): Case<Input, Classification> {
  return {
    name,
    input: { messages, workspace: extra.workspace ? FOLDER : undefined },
    ambiguous: extra.ambiguous,
    grade: (got) => grade(got, expected),
  };
}

function grade(got: Classification, expected: Expected): Mark[] {
  // A reply the classifier could not read at all: every field is wrong, and
  // the reason says so once
  if (got.failed) {
    const why = got.reply ? `unreadable reply ${JSON.stringify(got.reply.slice(0, 60))}` : got.reason;
    return [
      { field: 'sophistication', wanted: expected.sophistication.join('-'), got: why, ok: false },
      { field: 'category', wanted: expected.category.join(' or '), got: why, ok: false },
    ];
  }
  return [
    within('sophistication', expected.sophistication, got.sophistication),
    oneOf('category', expected.category, got.category),
  ];
}

// A long message with nothing hard in it: the length should not move the rating
const CONFIG = Array.from({ length: 30 }, (_, i) => `key_${i} = value_${i}`).join('\n');

// A whole system asked for as a list of requirements. Past the 600 characters
// the classifier is given of a message (see MAX_MESSAGE_LENGTH), so what it
// rates is the opening and the first few points: the scale has to be plain
// from those, which is what a message like this is being judged on.
const SPEC = [
  'build me an inventory system for a small warehouse. Requirements:',
  '1. staff log in with email and password, and there are three roles: picker, supervisor and admin',
  '2. products have a SKU, a name, a supplier, a unit cost and a reorder level',
  '3. stock movements are recorded in and out, each with who did it and when, and can never be deleted',
  '4. the current stock level of anything is derived from its movements, not stored',
  '5. supervisors can import a supplier price list from CSV, with the bad rows reported back',
  '6. admins see a report of what is below its reorder level, and can export it',
  '7. everything staff do is written to an audit log that admins can search',
  '8. there is a REST API for all of it, with tokens, so the handheld scanners can use it too',
  '9. tests for the lot, and a seed script with sample data',
].join('\n');

export const cases: Case<Input, Classification>[] = [
  // ---- Small talk and writing: the cheapest model, the least effort
  one('greeting', [user('hey')], { sophistication: [1, 1], category: ['general'] }),
  one('thanks', [user('thanks, that worked!')], { sophistication: [1, 1], category: ['general'] }),
  one('short piece of writing', [user('write me a haiku about rain on a tin roof')], {
    sophistication: [1, 1],
    category: ['general'],
  }),
  one('brainstorming', [user('give me ten name ideas for a bicycle repair shop')], {
    sophistication: [1, 2],
    category: ['general'],
  }),

  // ---- Questions: understanding something, not changing anything
  one('simple fact', [user("what's the time complexity of binary search?")], {
    sophistication: [1, 2],
    category: ['question'],
  }),
  one(
    'concept needing care',
    [user('explain the difference between a mutex and a semaphore, and when each is the wrong choice')],
    { sophistication: [2, 4], category: ['question'] }
  ),
  one('question about a language feature', [user('what does the volatile keyword actually guarantee in C?')], {
    sophistication: [2, 4],
    category: ['question'],
  }),
  one(
    'open design question',
    [user('should I use event sourcing for an order system that needs a full audit trail? what are the trade-offs?')],
    { sophistication: [3, 5], category: ['question'] }
  ),

  // ---- Coding: changing the project in front of it
  one('mechanical rename', [user('rename the function parse to parseInput everywhere it appears')], {
    sophistication: [1, 3],
    category: ['coding'],
  }),
  one('small feature', [user('add a --verbose flag to the CLI that prints each file as it is processed')], {
    sophistication: [2, 4],
    category: ['coding'],
  }),
  one(
    'debugging from a stack trace',
    [
      user(
        'my tests started failing after I changed the parser:\n\n' +
          "TypeError: Cannot read properties of undefined (reading 'length')\n" +
          '    at tokenize (src/parser.ts:48:19)\n' +
          '    at parse (src/parser.ts:12:3)\n\n' +
          'what is going on?'
      ),
    ],
    { sophistication: [3, 5], category: ['coding', 'question'] },
    { ambiguous: 'a failure to explain and a failure to fix are both fair readings' }
  ),
  one(
    'large refactor',
    [user('refactor the auth module to take its dependencies by injection instead of importing them directly')],
    { sophistication: [3, 5], category: ['coding'] }
  ),
  one(
    'migration across the project',
    [user('migrate this project from webpack to vite, keeping the dev server and the test setup working')],
    { sophistication: [4, 5], category: ['coding'] }
  ),
  one(
    'performance work',
    [user('the search endpoint takes 4 seconds on a cold cache; find out why and make it faster')],
    { sophistication: [4, 5], category: ['coding'] }
  ),

  // ---- One message, a whole system. These are the ones the rating is most
  // likely to go wrong on: the prompt tells the classifier that most messages
  // are 1 or 2 and that the lower of two fair ratings wins, which is right for
  // the ordinary traffic and is exactly the pull to resist here. The work is
  // not hidden — it is a system, said in a sentence — so the reply needs the
  // most capable model there is and many steps of it, however short the asking
  // was. A message like this under-rated goes to a small model, which answers
  // it with a sketch and a confident tone.
  one('one shot: a whole product in one line', [user('build me a social network: posts, follows, a feed, the lot')], {
    sophistication: [4, 5],
    category: ['coding'],
  }),
  one('one shot: a system given as a list of requirements', [user(SPEC)], {
    sophistication: [4, 5],
    category: ['coding'],
  }),
  // Four words, and every table, query and migration in the project. Scored,
  // not marked ambiguous: there is no reading of this that a small model can
  // answer, so a low rating here is simply wrong.
  one('one shot: a system that sounds like one change', [user('make the app multi-tenant')], {
    sophistication: [4, 5],
    category: ['coding'],
  }),
  one(
    'one shot: the system and everything around it',
    [
      user(
        'write a URL shortener with custom slugs, click stats and an admin page, then dockerise it, ' +
          'set up CI and deploy it'
      ),
    ],
    { sophistication: [4, 5], category: ['coding'] }
  ),
  one(
    'one shot: something distributed, from nothing',
    [
      user(
        'I need a job queue I can trust: at-least-once delivery, retries with backoff, dead letters, ' +
          'workers that can be added and removed while it runs, and a page to watch it. write it'
      ),
    ],
    { sophistication: [4, 5], category: ['coding'] }
  ),
  one(
    'one shot: workspace: a feature that is a system of its own',
    [user('add real-time collaborative editing to this: live cursors, offline edits that merge, the works')],
    { sophistication: [4, 5], category: ['coding'] },
    { workspace: true }
  ),
  one(
    'one shot: workspace: the whole project in another language',
    [user('port this project from Python to Rust, keeping the CLI and the tests working')],
    { sophistication: [4, 5], category: ['coding'] },
    { workspace: true }
  ),

  // ---- What the classifier only sees part of: it is given the conversation,
  // so a follow-up has to be read in the light of what came before
  one(
    'follow-up that needs the turn before it',
    [
      user('add a retry to the upload, three attempts with a backoff'),
      said('Done: upload() now retries three times, doubling the wait each time.'),
      user('do the same for the download'),
    ],
    { sophistication: [2, 4], category: ['coding'] }
  ),
  one(
    'follow-up to a question',
    [
      user('what is a bloom filter?'),
      said('A bloom filter is a probabilistic set: it can say "probably present" or "definitely absent".'),
      user('why would I use one over a hash set?'),
    ],
    { sophistication: [2, 3], category: ['question'] }
  ),
  one(
    'bare approval of work just described',
    [
      user('how should I structure the cache layer?'),
      said(
        'I would put it behind a single Cache interface with get/set/evict, and start with an in-memory implementation.'
      ),
      user('do it'),
    ],
    { sophistication: [2, 4], category: ['coding'] }
  ),

  // ---- Awkward on purpose: what the prompt does with too little to go on
  one(
    'one word',
    [user('docs')],
    { sophistication: [1, 3], category: ['coding', 'question', 'general'] },
    {
      ambiguous: 'could be asking for docs, asking about them, or naming a workspace',
    }
  ),
  one('a request that only looks hard', [user('delete the file src/old.ts')], {
    sophistication: [1, 2],
    category: ['coding'],
  }),
  one(
    'long but simple',
    [user(`here is my config, please just reformat it as JSON:\n\n${CONFIG}`)],
    { sophistication: [1, 3], category: ['coding', 'general'] },
    { ambiguous: 'mechanical work on text the user pasted, rather than on the project' }
  ),

  // ---- In a workspace, where there is no "general" kind at all
  one(
    'workspace: where something lives',
    [user('where does the program start?')],
    { sophistication: [1, 3], category: ['question'] },
    { workspace: true }
  ),
  one(
    'workspace: a change to make',
    [user('add a test for the parser covering the empty-input case')],
    { sophistication: [2, 4], category: ['coding'] },
    { workspace: true }
  ),
  one(
    'workspace: small talk with nowhere to put it',
    [user('hey')],
    { sophistication: [1, 2], category: ['coding', 'question'] },
    { workspace: true, ambiguous: 'the workspace prompt offers no general kind, so neither answer is right' }
  ),

  // ---- Taken from the app's own record of classifications the user marked
  // wrong (see ../src/feedback.ts, and ../evals/feedback.ts which replays that
  // record once the verdicts carry their conversations). Every case above this
  // point was written by imagining what the app would be asked; these are what
  // it was actually asked, and the two distributions turned out not to match.
  // Two thirds of the complaints were the rating coming out too high, nearly
  // always a flat `4 high coding` on a small request, and the cases above had
  // no equivalent for that at all - their hardest cases are whole systems
  // asked for in one line, which the record does not contain once.
  //
  // The messages are the real ones, lightly tidied for spelling, with the
  // turns before them written out where the message leans on them. What the
  // user said was that the rating was too high or the kind was wrong; the
  // ranges here are the obvious reading of that, not their own words.

  // Being shown or told something about the work, with nothing to change. All
  // of these were rated `4 high coding`; the user called the kind wrong too.
  // The range takes in a 2 because what the user said was that 4 was too high,
  // and a 2 is not.
  one(
    'workspace: asked to be shown what was done',
    [user('can you show what changes you have made?')],
    { sophistication: [1, 2], category: ['question'] },
    { workspace: true }
  ),
  one(
    'workspace: a yes-or-no question about work already done',
    [
      user('delete the heap dump once the profiler has read it'),
      said('Done: the dump is removed as soon as it has been read.'),
      user('did you clean up the heap dump?'),
    ],
    { sophistication: [1, 2], category: ['question'] },
    { workspace: true }
  ),
  one(
    'workspace: a fix asked for as advice rather than as work',
    [user('whenever an agent outputs a diagram it is often too small to read. test this and suggest a fix')],
    { sophistication: [2, 4], category: ['coding', 'question'] },
    {
      workspace: true,
      ambiguous: '"test this" asks for the work and "suggest a fix" asks only for the advice',
    }
  ),

  // An ordinary small change, rated as though it were a big one. Each of these
  // was rated `4 high coding`, which buys the reply 240 rounds of tool calls
  // (see maxSteps) and the most capable model the user has.
  one(
    'workspace: a figure added to a panel that already exists',
    [user('add the review token usage into the detailed dropdown')],
    { sophistication: [2, 3], category: ['coding'] },
    { workspace: true }
  ),
  one(
    'workspace: a sizing change in one view',
    [
      user('the diagrams in a thread are hard to read'),
      said('I have given them a minimum width and put them in a scroll container.'),
      user('can we also make the diagram larger in the chat view?'),
    ],
    { sophistication: [1, 3], category: ['coding'] },
    { workspace: true }
  ),
  one(
    'workspace: widening what something already has access to',
    [user('give subagents access to the host commands')],
    { sophistication: [2, 3], category: ['coding'] },
    { workspace: true }
  ),
];

export const suite: Suite<Input, Classification> = {
  name: 'classifier',
  about: 'how it rates the sophistication and kind of a message',
  perModel: true,

  async setUp({ model: wanted }) {
    configure();
    const { models, providers } = await llm.listModels({ fresh: true });
    // Only the model asked for, so that the classifier's own choice of the
    // least sophisticated one does not decide what is being judged
    const offered = wanted ? models.filter((m) => m.id === wanted) : models;
    if (offered.length === 0) {
      const trouble = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
      throw new Error(
        [wanted ? `No model called "${wanted}".` : 'No models available.', ...trouble].join('\n') +
          `\nModels there are: ${models.map((m) => m.id).join(', ') || 'none'}`
      );
    }
    return {
      model: offered.map((m) => m.id).join(', '),
      run: (input) => classify(input, offered, AbortSignal.timeout(120000)),
    };
  },

  cases,
};
