// First stage of the harness: an LLM sizes up each request before it is
// answered, deciding how sophisticated a model it calls for, how much effort
// the reply will take, and what kind of task it is. The result is a Classification (see
// ../types.ts); classify() never throws.
//
// This runs before every reply, so it is kept quick: a short prompt, a small
// slice of the conversation, and a three-word answer.

import * as llm from '../llm';
import * as log from '../log';
import { SOPHISTICATION } from '../llm/sophistication';
import type { Category, ChatMessage, Classification, Effort, ModelInfo, Usage } from '../types';
import { cheapestFirst } from './router';

// How long the last model asked is given. This covers bringing the model up as
// well as answering (see ChatRequest.timeoutMs and wholeBudget in ../llm), and
// it is the whole of what a rating gets where there is nobody else to ask: a
// late rating is worth more than none, and a local server with a big model
// mid-reply can take this long to find room for a small one.
const TIMEOUT_MS = 2 * 60 * 1000;
// ...and how long the first model is given when there is another to fall back
// to. Shorter, because the fall-back is the quicker way to a rating from here:
// a model that cannot even be started in this long is a server with no room
// rather than a model being slow, and the model on the other provider rates a
// prompt this short in about a second.
const FIRST_TIMEOUT_MS = 60 * 1000;
const RECENT_MESSAGES = 4;
const MAX_MESSAGE_LENGTH = 600;
const MAX_SUMMARY_LENGTH = 1500;

// Assumed when there is no rating at all to take an effort from
export const DEFAULT_EFFORT: Effort = 'medium';

// The effort a level calls for, which the prompt below gives as a rule the
// model is to follow every time: "1 is low. 2 and 3 are medium. 4 and 5 are
// high."
export function effortFor(sophistication: number): Effort {
  if (sophistication <= 1) return 'low';
  return sophistication <= 3 ? 'medium' : 'high';
}

const CATEGORIES: Category[] = ['coding', 'question', 'investigation', 'suggestion', 'general'];
// Assumed when the kind of task can't be told
export const DEFAULT_CATEGORY: Category = 'general';
// The same, in a thread that was started in a workspace. Such a thread is about
// the workspace's files, so its messages are never a general task: one that
// isn't plainly about code is taken as a question about the files.
export const WORKSPACE_DEFAULT_CATEGORY: Category = 'question';

// Every line of this says one thing, and the model reads it a line at a
// time, so the lines are joined rather than wrapped: a sentence broken over
// two of them would read as two items.
const RATING =
  'Rate the last user message. Do not answer it. Reply with only a digit and two words, like "3 medium coding".\n' +
  'Earlier turns are there only to make sense of that message. Rate what it asks for, not what was done before.\n' +
  'The digit, 1 to 5, is how capable a model the reply needs. Judge the work asked for, not the length of the ' +
  'message: a long message can be a 1, and four words can be a 5.\n' +
  '1: small talk, a thank-you, a simple fact, a short piece of writing, reformatting, or a change to one line or ' +
  'one file.\n' +
  '2: one clear job with the steps already plain: an exactly described change to a single file or function, a ' +
  'feature in a named place, a straightforward explanation, a short script written from scratch.\n' +
  '3: a job with some openness in it: a change over two or three files, or details you have to settle yourself ' +
  'such as an algorithm or a name.\n' +
  '4: a job spread over many files or modules, or one that means weighing designs against each other, or a fault ' +
  'with nothing to say where it is.\n' +
  '5: a whole working system built from nothing, or a change that touches the whole project.\n' +
  'Where two ratings both seem fair, give the lower one: most messages are 1 or 2.\n' +
  'That rule is off, and the rating is 4 or 5, whenever the message asks for one of these, however briefly it ' +
  'asks and however little it says about how:\n' +
  '- a whole app, site, service, product or system, built from nothing: 5\n' +
  '- a migration, a port, a rewrite, or swapping out a framework, database or protocol: 5\n' +
  '- a change named after a property of the whole project, such as making it multi-tenant, real-time, ' +
  'collaborative or offline-first: 5\n' +
  '- a list of requirements, or several jobs strung together with "then": 5\n' +
  '- restructuring code across modules, or putting what is scattered behind one new interface: 4\n' +
  '- finding why something is slow, wrong or failing when nothing in the message says where to look: 4\n' +
  "- which approach to adopt in the user's own system, and what it costs to pick it: 4\n" +
  'The first word is how much work a good reply takes, and it follows from the digit every time:\n' +
  '1 is low. 2 and 3 are medium. 4 and 5 are high.\n' +
  'The second word is the kind of task.\n' +
  'coding: software is to be written, changed, deleted, renamed, run, tested, debugged or reviewed - the files the ' +
  'user already has, or something new built for them. Asking for a program, a feature or a system to be built is ' +
  'coding even when no file, language or command is named, and finding a fault and fixing it is coding. But what ' +
  'is asked for has to be software: a poem, a name, an essay or an email is not coding however it is asked for. A ' +
  'job being small or easy does not stop it being coding.\n' +
  'question: the user wants to be told, shown or advised something, and nothing of theirs is to be built or ' +
  'changed. What a thing means, how two approaches compare, which one to pick: all questions, even where the ' +
  'subject is code. A message that asks whether to do something, or whether it is worth doing, wants the advice ' +
  'and not the work, so "should I", "is it worth" and "which is better" are questions. Code being talked about ' +
  'does not make it coding; only code being worked on does.\n' +
  'investigation: a long explanation of why something already happens, or how a system the user has works end to ' +
  'end. Nothing is built or changed. A short answer is a question, and a fault to be fixed is coding.\n' +
  'suggestion: a change is to be proposed, not made: "suggest how to", "how would I", "how could this be ' +
  'improved". Asking for the change itself is coding; asking how a thing works is a question or an investigation.\n' +
  'A message that asks for nothing at all - a greeting, a thank-you, an acknowledgement - is always 1 low.';

// What the classifier is told in a general chat. The examples come last and
// are what a small model follows most closely, so they carry the hard part:
// which kind a message is, that an easy message stays at 1 and low, and that
// a system asked for in one line is a 5 however short the asking was.
export const PROMPT = `${RATING}
general: none of those. Greetings, thanks, chat, and writing or brainstorming that is not software: a poem, a list
of names, an email, an essay. Outside a workspace an investigation is rare; weigh question first.
Examples:
hi there -> 1 low general
thanks, that did it -> 1 low general
suggest five names for a podcast about birds -> 1 low general
write me a limerick about missing the last train -> 1 low general
write me a short post about why I left my job -> 1 low general
what does O(n log n) mean? -> 1 low question
what is the difference between a list and a tuple? -> 1 low question
why is quicksort usually faster than mergesort in practice? -> 2 medium question
why would I reach for a bloom filter instead of a hash set? -> 2 medium question
is it worth moving this service to gRPC? what do I give up? -> 4 high question
fix the typo in the README -> 1 low coding
delete the file scripts/old_backup.sh -> 1 low coding
remove the unused import from utils.py -> 1 low coding
give the importer a --dry-run flag that prints what it would write -> 2 medium coding
write me a script that renames every photo in a folder by the date it was taken -> 2 medium coding
pull the database calls out of the handlers and behind one interface -> 4 high coding
the nightly job has started failing and the log says nothing; find the cause and fix it -> 4 high coding
build me a recipe site: people sign up, post recipes and leave comments -> 5 high coding
move the whole project off REST and onto GraphQL -> 5 high coding
Reply with only a digit and two words.`;

// ...and in a thread that was started in a workspace, where there is no general kind
const WORKSPACE_INTRO = `${RATING}
The conversation is about a workspace of code on the user's computer, so every message is about those files and
there is no general kind: a message that asks for nothing to be changed is a question or an investigation.`;
// The kinds are balanced here on purpose. These examples were nine coding to
// four question, and a small model reading a prompt this long leans on whichever
// label it has seen most: "can you show what changes you have made?" and "did
// you clean up the heap dump?" came back coding every time out of twenty, though
// the question kind as defined above plainly covers both. Two examples of being
// shown or told what was done, and one redundant trivial coding example dropped,
// moved the workspace cases from 62% of runs wholly right to 69% and left the
// general prompt alone (evals/classifier.ts, 10 runs, paired against the prompt
// before it). Prose saying the same thing did nothing, and so did an example
// worded almost exactly like the case it was meant to fix: what counts is how
// many of each kind it has read, not what it has been told.
//
// So: keep this list roughly even between coding and the rest. Adding a coding
// example here has a cost somewhere else.
const WORKSPACE_EXAMPLES = `Examples:
where does the program start? -> 1 low question
what is this helper for? -> 1 low question
can you show me what you changed? -> 1 low question
did you delete the old dump? -> 1 low question
why is quicksort usually faster than mergesort in practice? -> 2 medium question
would a queue serve this better than the table we have? what do we lose? -> 4 high question
how does a request get from the router to the database? -> 3 medium investigation
why does the importer skip rows with a blank date? -> 3 medium investigation
suggest how I could split this module apart without breaking the tests -> 3 medium suggestion
how would I make the settings screen work offline? show me what it would take -> 4 high suggestion
fix the typo in the README -> 1 low coding
remove the unused import from utils.py -> 1 low coding
add a test that the config loader rejects a missing key -> 2 medium coding
give the importer a --dry-run flag that prints what it would write -> 2 medium coding
pull the database calls out of the handlers and behind one interface -> 4 high coding
the nightly job has started failing and the log says nothing; find the cause and fix it -> 4 high coding
make everything in here work offline and sync when it reconnects -> 5 high coding
rewrite this project in Go, keeping the CLI exactly as it is -> 5 high coding
Reply with only a digit and two words.`;
export const WORKSPACE_PROMPT = `${WORKSPACE_INTRO}\n${WORKSPACE_EXAMPLES}`;

// The prompt for a request, with the workspace's note on the project (see
// project.ts) put in ahead of the examples, which stay last. The note is only
// there to tell the model what the messages are about, so it is said not to
// be what is rated.
export function systemPrompt(workspace: boolean, note?: string): string {
  if (!workspace) return PROMPT;
  const overview = note?.trim();
  if (!overview) return WORKSPACE_PROMPT;
  return (
    `${WORKSPACE_INTRO}\nThis is what is known of the project. It is background for making sense of the message; ` +
    `rate the message, not the project.\n<project>\n${overview}\n</project>\n${WORKSPACE_EXAMPLES}`
  );
}

// The least sophisticated model worth asking for a rating. Classifying is easy
// work and goes to a cheap model, but not to any model however cheap: a rating
// is dear to get wrong, since it picks the model, the effort and the
// instructions for the whole of the reply that follows.
//
// Below this the ratings are not worth having. llama3.2:3b - a level 0 by its
// parameter count - gets 72-76% of the eval's cases wholly right where
// qwen3.5:9b gets 85%; it reads the kind of task right 85% of the time against
// 97%; and on the cases drawn from the user's own complaints it manages 42%
// against 84% (evals/classifier.ts, 36 cases x 10 runs). Thirteen attempts at
// closing that gap by rewording this file's prompts moved one of them.
//
// The 9B costs about 400ms more for a rating, against a reply measured in
// seconds, and some of that is paid back: the ratings now lost when a 9B
// mid-reply leaves a local server no room to load a 3B beside it are ratings
// that a 9B classifier never needed a second model for (see candidates).
//
// A level rather than a size, so that it means something for a hosted model
// too - every one of which is above it, so this changes nothing for anyone
// classifying on a hosted model. Only the 9B has been measured; the level is
// the band that holds every local model from 5B up.
export const FLOOR = SOPHISTICATION.BASIC;

// The models worth asking, least sophisticated first, and a local one ahead of
// a hosted one at the same level. Nothing below the floor - unless there is
// nothing above it either, because a rating from a model too small for the job
// still beats the reply going unrated.
function worthAsking(models: ModelInfo[]): ModelInfo[] {
  const sorted = [...models].sort(cheapestFirst);
  const enough = sorted.filter((m) => m.sophistication >= FLOOR);
  return enough.length > 0 ? enough : sorted;
}

// The model that classifies: the cheapest one worth asking. Shared with the
// planner, which asks a question of the same size and says it follows this
// choice on purpose (see planner.ts).
export function pickModel(models: ModelInfo[]): ModelInfo | undefined {
  return worthAsking(models)[0];
}

// The models this may ask, in the order it asks them: the cheapest worth
// asking (see FLOOR), and then the cheapest on some other provider.
//
// A classifier that never answers is usually a server with no room left rather
// than a model at fault. A local server holding a 9B model mid-reply cannot
// also load the 3B that rates the message, so the rating waits out its whole
// budget on a load that was never going to happen and the reply goes unrated -
// measured in the log as five of fourteen ratings lost to a 30-second load,
// every one of them while the 9B was busy. Asking that same server again would
// fail the same way, so what is asked next is on the other side of the machine.
//
// Two is the whole chain. This holds up a reply, and a third model costs more
// time than a rating is worth.
export function candidates(models: ModelInfo[]): ModelInfo[] {
  const [first, ...rest] = worthAsking(models);
  if (!first) return [];
  const elsewhere = rest.find((m) => m.provider !== first.provider);
  return elsewhere ? [first, elsewhere] : [first];
}

// All of a request the classifier is actually shown: the last few messages,
// each cut to length, and the summary standing in for the turns before them.
// Exported because a verdict kept for replaying later should hold exactly this
// and no more - what was rated, not the whole thread (see ../feedback.ts and
// evals/feedback.ts). Cutting an already-cut message leaves it as it was, so
// a recorded conversation fed back through classify() is unchanged by it.
export function shown(messages: ChatMessage[], summary?: string): { messages: ChatMessage[]; summary?: string } {
  const recent = messages.slice(-RECENT_MESSAGES).map((m) => ({
    ...m,
    content: m.content.length > MAX_MESSAGE_LENGTH ? `${m.content.slice(0, MAX_MESSAGE_LENGTH)} [...]` : m.content,
  }));
  const overview = summary?.trim() ?? '';
  const cut = overview.length > MAX_SUMMARY_LENGTH ? `${overview.slice(0, MAX_SUMMARY_LENGTH)} [...]` : overview;
  return { messages: recent, ...(cut ? { summary: cut } : {}) };
}

function conversation(messages: ChatMessage[], summary?: string): string {
  const { messages: recent, summary: overview } = shown(messages, summary);
  const turns = recent.map((m) => `${m.role}: ${m.content}`);
  const above = overview ? `<summary>\n${overview}\n</summary>\n\n` : '';
  return `${above}<conversation>\n${turns.join('\n\n')}\n</conversation>\n\nRating:`;
}

// Reads the rating from the reply: the first number in it, which must be 1 to
// 5, and the first task word. A reply missing the task word is still usable.
//
// The effort is worked out from the level rather than read from the word the
// model gave for it, the two being the same thing said twice: the prompt lays
// down which effort each level takes, so a reply where they disagree is a
// model sampling its way through that rule rather than following it. It is
// still asked for, because what the reply is made to say is measured as a
// whole and this file's prompts are not changed without measuring (see
// evals/classifier.ts); it is only no longer believed over the level it
// contradicts. Observed as "4 medium", which put a one-character message of
// "1" through a four-step coding reply on a model the user had to approve.
// inWorkspace: the thread was started in a workspace, so the task can't be general
export function parse(
  reply: string,
  inWorkspace = false
): { sophistication: number; effort: Effort; category: Category } | null {
  const sophistication = Number(/\d+/.exec(reply)?.[0]);
  if (!(sophistication >= 1 && sophistication <= 5)) return null;
  const category = /\b(coding|question|investigation|suggestion|general)\b/i.exec(reply)?.[1].toLowerCase();
  // A model may still answer "general" in a workspace; that is not taken from it
  const allowed = inWorkspace ? CATEGORIES.filter((c) => c !== 'general') : CATEGORIES;
  return {
    sophistication,
    effort: effortFor(sophistication),
    category: allowed.find((c) => c === category) ?? (inWorkspace ? WORKSPACE_DEFAULT_CATEGORY : DEFAULT_CATEGORY),
  };
}

// One model's go at rating the message. Reports whether the model answered at
// all alongside what it made of the message: a model that was never started,
// or that said nothing, is a reason to ask a different one, where a model that
// answered unusably is not (see classify).
async function attempt(
  request: { messages: ChatMessage[]; summary?: string; workspace?: string; note?: string },
  classifier: ModelInfo,
  timeoutMs: number,
  signal: AbortSignal,
  onQueued?: () => void
): Promise<{ classification: Classification; answered: boolean }> {
  const { id: model, provider } = classifier;
  const inWorkspace = Boolean(request.workspace);
  let usage: Usage | undefined;
  try {
    const events = llm.stream(
      {
        provider,
        model,
        system: systemPrompt(inWorkspace, request.note),
        messages: [{ role: 'user', content: conversation(request.messages, request.summary) }],
        // A reply can't start until this is done, so it doesn't wait behind
        // other work queued for a local model
        priority: true,
        brief: true,
        // Counted from when the model is up and has started on this, so a
        // model that is still loading is waited for rather than given up on
        timeoutMs,
        log: { purpose: 'classification' },
      },
      signal
    );

    let reply = '';
    for await (const event of events) {
      if (event.type === 'queued') onQueued?.();
      if (event.type === 'text') reply += event.delta;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') {
        return { classification: { failed: true, reason: event.message, model, provider }, answered: false };
      }
    }
    const rating = parse(reply, inWorkspace);
    if (rating) return { classification: { ...rating, model, provider, usage }, answered: true };
    return {
      classification: {
        failed: true,
        reason: 'The reply was not a level from 1 to 5.',
        model,
        provider,
        usage,
        reply: reply.slice(0, MAX_MESSAGE_LENGTH),
      },
      // A reply there was, only not one that can be read as a rating
      answered: reply.trim().length > 0,
    };
  } catch (err) {
    return { classification: { failed: true, reason: (err as Error).message, model, provider }, answered: false };
  }
}

// request.workspace: the workspace the thread was started in, if any
// request.note: the note on that workspace, shown to the classifier as context
// models: the enabled models, as returned by llm.listModels()
// onQueued: called if the classifier has to wait for a request that is
// already in progress on its model's server. It goes ahead of everything else
// that is waiting, but does not interrupt what is running.
//
// Never throws. Where the first model cannot be reached or started at all, the
// next one is asked (see candidates); the failure returned is the last one's.
export async function classify(
  request: { messages: ChatMessage[]; summary?: string; workspace?: string; note?: string },
  models: ModelInfo[],
  signal: AbortSignal,
  onQueued?: () => void
): Promise<Classification> {
  const chain = candidates(models);
  if (chain.length === 0) return { failed: true, reason: 'No models available.' };
  let failed!: Classification;
  for (const [i, classifier] of chain.entries()) {
    const last = i === chain.length - 1;
    const { classification, answered } = await attempt(
      request,
      classifier,
      last ? TIMEOUT_MS : FIRST_TIMEOUT_MS,
      signal,
      onQueued
    );
    if (!classification.failed) return classification;
    failed = classification;
    // A model that answered has had its say, and the user giving up is not a
    // reason to ask anybody else
    if (last || answered || signal.aborted) break;
    const next = chain[i + 1];
    log.warn('classification.elsewhere', {
      provider: classifier.provider,
      model: classifier.id,
      error: classification.reason,
      then: `${next.provider}/${next.id}`,
    });
  }
  return failed;
}
