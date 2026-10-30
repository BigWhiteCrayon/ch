// Event harness: every chat message is first classified (see classifier.ts),
// then routed to a model that suits it (see router.ts), and then goes through
// a decision loop with that model.
//
// Each step, the chosen model sees the conversation and the available tools
// and decides either to answer or to call tools. Tool results are fed back
// and the model decides again, until it answers.
//
// What the model writes is split into thoughts and results (see thoughts.ts).
// A model that reports its own reasoning is asked for no thoughts in tags:
// its thoughts are gathered from that reasoning instead.
// The kind of task the classifier sees sets which instructions the model is
// given, and the effort it expects sets how much thinking the model is asked
// for and how long its thoughts may be.
//
// run() yields HarnessEvents (see ../types.ts) describing all of this as it
// happens.

import * as llm from '../llm';
import * as cachelock from '../llm/cachelock';
import { priced } from '../llm/pricing';
import { estimate } from '../llm/tokens';
import * as log from '../log';
import * as sandbox from '../sandbox';
import type {
  ChatMessage,
  Classification,
  Category,
  ChatRequest,
  Effort,
  HarnessEvent,
  HarnessRequest,
  Phase,
  ProviderDoneEvent,
  Resumed,
  ToolCall,
  ToolContext,
  ToolImage,
  ToolVideo,
  Usage,
} from '../types';
import * as access from './access';
import { announcing } from './announced';
import * as discoveries from './discoveries';
import * as notes from './notes';
import * as phases from './phases';
import * as project from './project';
import * as review from './review';
import * as subagents from '../subagents';
import { ASK_TOOL } from '../subagents/kind';
import { compact, nearlyFull, size } from './compactor';
import { DEFAULT_CATEGORY, DEFAULT_EFFORT, WORKSPACE_DEFAULT_CATEGORY, classify } from './classifier';
import * as grounding from './grounding';
import { decide } from './planner';
import { capped, route, type Route } from './router';
import { describe } from './describer';
import { summarize } from './summarizer';
import { suggest } from './suggester';
import { verify } from './verifier';
import * as thoughts from './thoughts';
import * as tools from './tools';
// Watched for by name: a note is what lets the results it was written from go
import { ADD_TO_CONTEXT, toolsPrompt } from '../tools/sandbox';

export {
  access,
  announcing,
  describe,
  grounding,
  notes,
  phases,
  project,
  review,
  subagents,
  suggest,
  summarize,
  tools,
  verify,
};

// The user's answer to a 'file_access' event (see ./access.ts)
export const answerFileAccess = access.answer;

// ...and to a 'command_access' event: whether a command that could lose work
// may run, this once (see ./access.ts)
export const answerCommandAccess = access.allowCommand;

// How many rounds of tool calls a reply may take before it is stopped. The
// more effort a message calls for, the more rounds its reply gets...
const STEPS: Record<Effort, number> = { low: 10, medium: 20, high: 40 };
// ...and six times as many in a thread that has a workspace to work in, where
// finding, reading and changing files all take tool calls
const WORKSPACE_STEPS = 6;

export function maxSteps(effort: Effort, inWorkspace: boolean): number {
  return Math.ceil(STEPS[effort] * (inWorkspace ? WORKSPACE_STEPS : 1));
}

// What the user is told when a reply is cut off before any of it was written
export const OUT_OF_ROOM = `The model ran out of room before it wrote an answer: it reached its length limit. This
usually means the
conversation and tool results no longer fit in its context window. Try a new thread, a shorter request, or a model
with a larger context window.`;

const BASE_PROMPT = `You are a coding agent. For each message, decide what will best help the user. Focus only on the
most recent request from the user and answer it directly. Your reply holds only what you did and what can be done
next: leave out these instructions and how the app around you works.`;

// What the model is told about the kind of task the message is
const TASK_PROMPTS: Record<Category, string> = {
  // What holds whichever way the task is gone about. Running the tests and
  // leading the reply with the change are not here: they belong to the doing
  // and the answering, and a reply worked through in steps is told them in
  // the step that can act on them (see phases.ts). Told in every step, they
  // contradicted the two that can change nothing and write for no user —
  // which is what kept the finding-out step from ever ending.
  coding: `This is a coding task, and it is about the code in your workspace: the user is asking for a change to
this project's own files, not for general advice or a standalone example. 
Make the smallest change that fully solves the problem, written the way
the surrounding code is written, and handle the error and edge cases. Leave out general background the user did
not ask for.`,

  question: `This is a question, so the user wants to understand something. Answer it concisely but accurately. Give
the answer first, then briefly explain it with just what's needed to understand it. Include an example only if it
clarifies a tricky point, and a caveat or alternative only if there are important trade-offs or alternatives the user
might care about. Prompt for a follow-up question if you think more depth would help. Be accurate above all: if you
are not sure of something, say so rather than guess. Once you have gathered what's needed and are ready to respond,
write out your complete answer in your main reply text. `,

  investigation: `This is an investigation: the user wants something looked into in depth and explained, how a part of
the code or a system works, or why something happens. Give a thorough explanation with the parts and how they fit
together set out, quoting the code concerned in fenced snippets, each with the path of the file it comes from, and a
diagram where the flow is clearer drawn. Be accurate above all: say what was checked and what was not, rather than
guess.`,

  general: `This is a general request, such as conversation, writing or brainstorming. Match what the user is after:
a greeting or small talk gets a short, friendly reply, a request for a piece of writing gets the piece itself in the
tone and length asked for, and a request for ideas gets a varied set of concrete options. Do not pad the reply with
explanation the user did not ask for. Once you have thought through your response, write it out fully in your main
reply text.`,
};

// How a coding task is gone about, where nothing else makes it happen. A reply
// worked through in steps has the harness for that, and is told about the step
// it is in instead (see phases.ts), so it is not given this as well: being
// told to write a plan while holding the tools to skip it is the problem the
// steps were made to fix.
const CODING_STEPS = `Go about solving this in discrete steps:
* Start with what the request leaves open — which thing it means, where the thing goes, what it is called, how far
it is meant to reach — and settle it against the code as you read: a project has one obvious place for a thing and
one way it already does things of that kind. Where it cannot be settled either way, say in your plan which reading
you took, since the user reads the plan before you act on it; a reading you keep to yourself is one they find out
about from the finished change.
* Then find the files the request concerns. Search the workspace's notes, then the code, and read the files the
search points to. Two searches and the files they point at are usually the whole of it.
* Write out your plan, in a response to the user, as soon as you can name those files and say what has to change in
each. Do not read on to be sure first: everything your tools return stays in front of you for the rest of this
reply, so the search you make to settle a doubt is room you no longer have to make the change in — and a reply that
fills its window finding out ends with no plan, no change and nothing to show for what it cost. Be brief, but give
enough detail to implement the changes. Where the code then shows the plan was wrong, do what is right instead and
say that you did.
* Make the change in those files and carry the task through to the end. Where you can, break up the changes into
smaller subjects and send them out to sub-agents through hand_to_subagent.

Ensure you run the code and its tests, whenever you modify a file if there are tests.

Where the change is to how something looks, or the user asked to see something, the screenshot belongs to this step
rather than to the reply: draw the result with the screenshot tool, look at it, and put right what is wrong before
you write a word of the answer.

Once all work is complete, write out the final response that fulfills the request. In your reply, lead with the code
or the change itself, then say briefly what it does and why, and anything you could not verify.`;

const FORMAT_PROMPT = `Write what the user will read in Markdown. These messages must be sent through your reply,
and not remain in your thought chain. Use headings to organise a longer answer, bullet
or numbered lists for items and steps, a table for a comparison, **bold** for key terms, and backticks for names of
files, commands and code. Put any code or command output in a fenced code block that names its language. Do not use
HTML or images, which are not displayed. To show how parts connect, draw a diagram instead: a fenced code block
named mermaid holding a flowchart, such as flowchart TD on the first line, then lines like A[Parser] --> B{Valid?}
and B -->|yes| C(Cache). Draw diagrams top-down, with at most 3 nodes side by side and short labels. Give nodes
short ids, and keep the same ids if you draw the diagram again. Only flowcharts are drawn; anything else in a mermaid
block is shown as code. A user message that starts with > lines is quoting part of an earlier reply, or a diagram
node or edge written as [diagram N, node "X"] or [diagram N, edge "A->B"], and the text after the quote is the user's
comment on that part.`;

// What shapes the instructions the model is given: how the classifier sized
// the message up, and the summary standing in for the thread's earlier messages
// Carries what a tool reports while it runs out to whoever is listening: the
// tool pushes, the loop pulls, and draining ends when the tools are done.
function relay<T>() {
  const waiting: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stir = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (item: T) => {
      waiting.push(item);
      stir();
    },
    close: () => {
      closed = true;
      stir();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (waiting.length > 0) yield waiting.shift() as T;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

// What the finding-out step is allowed, and why it is that much (see
// phases.findingRounds and phases.windowBound)
interface Finding {
  rounds: number;
  tight: boolean;
}

interface Task {
  category: Category;
  effort: Effort;
  // How capable the model answering is, which decides whether it is told to
  // break the work up for subagents (see subagents.ts)
  sophistication?: number;
  summary?: string;
  // The note on the project in the thread's workspace, if it has one
  project?: string;
  // ...and how many of the workspace's detailed notes this thread can search,
  // which is what it is told about them (see notes.prompt). Undefined in a
  // thread with no workspace, which has none to search.
  notes?: number;
  // A first look at the workspace is going on while this is answered, so there
  // is no settled note yet and the thread keeps what it finds out to itself
  // (see ALONGSIDE_SURVEY)
  surveying?: boolean;
  // The message is the user's review comments on the thread's changes
  review?: boolean;
  // ...and reviewers have been through them already, so all that is left is
  // to tell the user what was done (see subagents.ts)
  reviewed?: boolean;
  // The name this reply is working under, where it is not an answer to a
  // message at all but an agent subagent of another reply (see
  // HarnessRequest.agent and ../subagents/agent.ts). What it changes here is
  // what the model is told it is, and who reads what it writes: its words go
  // back to the assistant that sent it, which reads them as they stand.
  agent?: string;
}

// What a model without tools is told
// tools: whether the model has tools, which decides how it is to answer
// review comments
function plainPrompt(
  { category, summary, project: note, notes: kept, surveying, review: reviewing, reviewed, agent }: Task,
  // The tools this step is being offered, by name. A boolean would do for most
  // of what is below, but not for the project note: that prompt is only true
  // of a step that can write the note, and "has tools at all" is not the same
  // question (see project.prompt).
  names: readonly string[] = [],
  // The step of a coding change this is for, when the reply is worked through
  // in steps (see phases.ts). Its instructions stand in for the ordering a
  // reply that is not worked through in steps has to be told.
  phase?: Phase,
  // The finding-out step's allowance, where this is that step: how many rounds
  // of tool calls it has, and whether that is the window's doing rather than
  // the effort's. Told to it rather than only enforced, so that it can stop on
  // its own — and, where the room is what bound it, so that it can spend what
  // it has on explorers instead (see phases.BUDGET).
  finding?: Finding,
  // What a model with tools is told about them, split by how often it changes:
  // `held` is the same for the whole thread, and `stepped` changes with the
  // step (see systemPrompt)
  tooling: { held: string[]; stepped: string[] } = { held: [], stepped: [] }
): string {
  const withTools = names.length > 0;
  const budget = phase === 'explore' && finding ? phases.BUDGET(finding.rounds, finding.tight) : '';
  const step = phase ? [phases.PROMPTS[phase], budget] : [];
  // An investigation is worked through in steps whatever the task's category
  const ordering =
    category === 'coding' || category === 'investigation'
      ? [...step, ...(phase ? [] : [CODING_STEPS])].filter(Boolean).join('\n\n')
      : '';
  // How to write for the user, for the steps whose words a user reads. What
  // the other two write is a handover to the step after them, and telling a
  // model to write what the user will read while it is writing for itself is
  // the contradiction that kept a step from ever ending (see phases.ts).
  //
  // An agent subagent has no user to write for: what it writes is read by the
  // model that sent it, as it stands, beside the reports of everything else
  // that model handed out. So it is told what every subagent is told about
  // that, which is the opposite instruction (see PLAIN in ../subagents/run.ts).
  const read = !phase || phases.readByUser(phase);
  const format = read ? (agent ? subagents.PLAIN : FORMAT_PROMPT) : '';
  // The prompt runs from what changes least to what changes most, because the
  // order is the prompt cache's. A cache matches on a prefix, so the first
  // byte that differs between one request and the next throws away every
  // identical byte after it. Three tiers, then:
  //
  // - what is the same for the whole thread: who the model is, and what it is
  //   told about its container, the project note and the notes collection
  //   (which change when somebody writes to them, not between steps)
  // - what is the same for the whole reply, and changes with the next message:
  //   the kind of task, a review, the summary of the thread so far
  // - what changes with the step of the reply: what it is told about its tools
  //   and about what it is making, and last of all (see systemPrompt) the
  //   context note, which a step is built from afresh
  //
  // It used to run the other way for the last tier, with the step's own
  // instructions third, ahead of the project note and the notes collection,
  // and the tools and the container after all of it. A reply worked through
  // in four steps therefore paid to have the whole of its prompt read again
  // at every step boundary: one reply in the log reused 24,370 of 24,855
  // tokens within a step and nothing at all across either boundary, at fifty
  // seconds a time.
  //
  // The note and the notes collection refer to each other — "see below" and
  // "the note above" — so they keep their order, and what the step can do
  // with the note is said after both (see project.OWN_COPY).
  // What it is, where it is a subagent rather than an answer to a message,
  // goes second: straight after who the model is, and in the same tier of the
  // ordering below, since it is the same for every agent and as true of its
  // last round as of its first.
  const parts = [BASE_PROMPT, ...(agent ? [subagents.AGENT.prompt] : []), ...tooling.held];
  if (note) parts.push(project.prompt(note));
  // Only with tools, since searching and writing them is all tools: a model
  // that cannot call one has nothing to do with this but be told about it
  if (withTools && kept !== undefined) parts.push(notes.prompt(kept));
  // ...and from here, what this message alone is told
  parts.push(TASK_PROMPTS[category]);
  if (surveying) parts.push(ALONGSIDE_SURVEY);
  if (reviewing) {
    parts.push(reviewed ? review.SUMMARY_PROMPT : withTools ? review.PROMPT : review.PLAIN_PROMPT);
  }
  if (summary) {
    parts.push(`${EARLIER}\n\n${summary}`);
  }
  // ...and from here, what this step alone is told
  parts.push(...tooling.stepped);
  if (note && names.includes(UPDATES_PROJECT_NOTE) && !surveying) parts.push(project.OWN_COPY);
  parts.push(ordering, format);
  return parts.filter(Boolean).join('\n\n');
}

// What the thread's summary is put under, where it stands in for the messages
// it covers (see ../harness/summarizer.ts)
export const EARLIER = `This conversation has been going on for a while. Its earlier messages are not shown to you;
this summary of them is what you have instead. Focus only on the most recent request from the user and answer it
directly, using context from this summary if needed.`;

// What a model is told when it is picking a reply up where the app closed on
// it. The account it is given is of what was done, not of what was thought: a
// model's own reasoning cannot be handed back to it, while the work its tools
// did is still there to be built on — a thread's container outlives the app
// (see ../sandbox/docker.ts).
//
// The last call of a cut-off reply is the one to be careful about. The app can
// close between a tool running and its result coming back, and from here
// there is no telling which of those happened, so that call is reported as
// unknown and the model is told to look before making it again. Everything
// else in the account either finished or failed, and is reported as it went.
export const PICKED_UP = `The app closed while you were working on this message, and you are picking that work up
again now.`;

const RESUMED_FACTS = `Everything in that list happened. The container you work in is kept when the app closes, so a
file you changed is still changed. What a call returned is given above in brief, so read anything again that you need
in full. Where a call's result is not known, the app closed between the call being made and its result coming back:
look at what is actually there before making that call again.`;

const RESUMED_WROTE = `What you had already written for the user is above, and they can see it. Carry on from where it
stops rather than starting your answer again.`;

const RESUMED_CARRY_ON = `Do not do again what the list shows as done. Do what is left of the message, and answer.`;

// The whole of it: what happened, what that means, and what to do now
export function pickedUp({ text, did }: Resumed): string {
  const parts = [PICKED_UP];
  if (did.length > 0) {
    parts.push(`What you had done before it closed, oldest first:\n\n${did.map((line) => `- ${line}`).join('\n')}`);
    parts.push(RESUMED_FACTS);
  } else {
    parts.push('Nothing you did had been recorded before it closed, so start the message from the beginning.');
  }
  if (text) parts.push(RESUMED_WROTE);
  parts.push(RESUMED_CARRY_ON);
  return parts.join('\n\n');
}

// The tool that brings a thread level with its workspace (see ../tools/sync.ts).
// Named rather than imported: the harness knows the registry it runs tools
// through, not the tools in it.
const SYNC_TOOL = 'sync_workspace';

// The tools after which a thread's copy of the workspace may differ from what
// it was. A subagent is here because a coder is one of the kinds it hands work
// to, and a command because a command can do anything.
const WRITES_FILES = new Set(['write_file', 'edit_file', 'run_command', subagents.TOOL_NAME]);

// The three tools that are only any use to a reply with subagents of its own:
// handing work out, collecting it, and writing to it while it runs. Kept
// together because they are offered and withheld together (see the bottom of
// the chain in the tool list below).
const HANDS_WORK_OUT = new Set([subagents.TOOL_NAME, subagents.WAIT_TOOL, subagents.MESSAGE_TOOL]);

// The tools that only write down what the model already has in front of it,
// and so tell it nothing it did not know. A round spent on nothing but these
// is not a round spent looking, and does not come off the finding-out step's
// allowance (see the loop below): the step is capped to stop it reading for
// ever, and a cap that also charged it for writing its findings down would buy
// the shallower pass at the price of the notes, which are the thing worth
// keeping out of it.
const WRITES_DOWN = new Set([ADD_TO_CONTEXT, 'save_context', 'add_workspace_note']);

// The tool that puts a file in front of the step, and the two whose results
// say what is in a file the step never opened for itself: the handing out,
// because an explorer read it in a window of its own and reported back, and
// the reading command, because grep and its like print lines off the file.
// Between them they are what a write-up may make claims from (see
// ./grounding.ts).
const OPENS_A_FILE = 'read_file';
const REPORTS_A_FILE = new Set([subagents.TOOL_NAME, 'run_reading_command', 'run_host_command']);

// The tools a step has to hold for one of the prompts above to be true of it:
// the note on the project is only to be kept true by a step that can write it,
// and only a step that can change a file is told how the user gets the change
// (see project.prompt and sandbox.workspacePrompt).
const UPDATES_PROJECT_NOTE = 'update_workspace_context';
const ADDS_TO_PROJECT_NOTE = 'add_to_workspace_context';
const changesFiles = (name: string) => name === 'write_file' || name === 'edit_file';
// A step can also change files without holding either: the doing step hands
// them to coders (see phases.PROMPTS.execute), and is the one step that does.
// So it is not one question but two — whether a change comes out of this step,
// and whether this step is the thing that makes it — and the prompt wants both,
// because the step that causes every change in the project is also the step
// that must not be told to make one (see sandbox.Changes, where what went wrong
// when it was told to is written down).
const changing = (names: string[], phase?: Phase): sandbox.Changes =>
  names.some(changesFiles) ? 'itself' : phase === 'execute' ? 'coders' : 'none';

// How many times one reply is brought level before it is let go
const MAX_LEVELLINGS = 2;

// ...and how many times it stops to collect what it handed out. Two: what is
// collected may set the model going again, and what that hands out is
// collected once more, but a reply that keeps starting work as it is being
// ended is not finishing.
const MAX_GATHERINGS = 2;
// ...and how many times an agent subagent is told that the letter it answered
// was not its report (see mailbox.ANSWERED and the step loop)
const MAX_ANSWERED = 2;

// What the model is told when it ended a reply having written nothing for the
// user. Some models — the local reasoning ones especially — write the whole
// answer into their reasoning and leave the reply itself empty. The reasoning
// is shown as thoughts, so the user sees words going by and then no answer,
// and worse: nothing of that turn is kept as the assistant's, so the next
// message in the thread goes out with the request before it looking
// unanswered, and gets answered all over again (see ../renderer.ts's
// conversation). So the model is asked once, plainly, for the reply itself.
const NO_ANSWER = `You ended that turn without writing anything for the user. Your reasoning is not shown to them as
your answer, and it is not kept. Write the answer out now, in your reply itself, as your whole message: everything you
worked out, in Markdown, without calling any more tools.`;

// How many times one reply is asked for its answer before the reasoning is
// taken for it instead
const MAX_NUDGES = 1;

// How many of the images a reply's tools returned (screenshots) are shown to
// the user under the reply: the latest, which are what the work ended on. The
// answering step has no tools and is not given the pictures, so the reply
// carries them out itself rather than leaving it to the model to.
const SHOWN = 3;
// ...and how many of the clips it recorded (see the record tool). Fewer: one
// clip says more than three do, and each is megabytes held in the window for
// as long as the thread is open.
const SHOWN_FILMS = 1;

// Showing the user the thing rather than telling them about it. The
// screenshots a reply's tools return are shown to them under it (see SHOWN
// above), so a reply about how something looks can end in the thing itself.
// Said in every step that is offered the tool, whatever the task's category:
// the reply that most needs a picture is often not a coding change at all but
// "what does the settings page look like now", and a model answering that
// from the code alone describes a page nobody drew. Left out where the tool is
// not offered, since a step told to show something it has nothing to draw with
// spends a round finding that out.
function showPrompt(names: readonly string[], phase?: Phase): string {
  if (!names.includes('screenshot')) return '';
  // In the finding-out step the pictures are shown under the plan, not the reply
  const under = phase === 'explore' ? 'under the plan' : 'under your reply';
  return `Show the user what you are talking about. The screenshots you take are shown to them ${under}, so
take one whenever seeing it beats reading about it:

- You changed how something looks — a page, a stylesheet, a component, a layout. Draw the result once the change is
made, look at it yourself, and put right what is wrong before you reply.
- The user asked to see something, or asked how it looks or what it does now ("show me", "what does it look like",
"is it working"). The screenshot is the answer; a description of one is not.
- You are about to say what a page or a view looks like. Said from the code alone that is a guess, and drawing it is
how the guess becomes something you checked.

Take the shot that shows what was asked about, at a size that fits it. Only the last ${SHOWN} you take are shown, so
take the ones that matter last rather than ending on a page the user did not ask about. Then point to it in your
reply — "the screenshot below" — and say what it shows. Do not try to draw, embed or link an image yourself: Markdown
images are not displayed.${names.includes('record') ? RECORD_PROMPT : ''}`;
}

// Said on top of the above where the reply can record as well as draw. The
// line worth drawing for the model is between a moment and a movement: asked
// for "the new animation" it will take a screenshot of a page mid-animation
// and describe the rest from the CSS, which is the same guess the screenshot
// prompt above exists to stop.
const RECORD_PROMPT = `

Where what you are showing moves — an animation, a transition, a loading sequence, a flow going past — record it
instead. The clip is shown to the user under your reply in the same way, and you are shown frames out of it. Only the
last ${SHOWN_FILMS} is shown, so record the one that matters last. A page that does not move is a screenshot: a clip
of it is seconds of nothing, and the still tells you both more.`;

// What the model is told when it ended a turn by saying what it was about to
// do, having done nothing. Short, and it names the two ways out: make the
// call, or answer. A model told only that it went wrong tends to apologise
// and stop again.
export const ANNOUNCED = `You said what you were going to do and then ended your turn without doing it. That turn
made no tool call, so nothing happened, and the user has your sentence and nothing else.

Do it now: make the tool call itself. A tool is called by calling it, not by writing the call out in your message —
anything you write in the message is only read by the user. If there is nothing left to do, give the user your
answer instead.`;

// What the model is told when it tried to end a reply with work still out. It
// asked for that work, so this gives it rather than mentioning that it exists.
const GATHERED = `You handed these pieces out without waiting for them, and they have now finished. Here is what they
found. Use what is worth using, and give the user your answer.`;

// What the model is told when its changes will not go back into the workspace
// as they are. It thought it was finished, so this says plainly that it is not,
// and what finishing means now.
const SETTLE_CLASHES = `Before your work can go back to the user's workspace, it has to fit into it. The workspace has
changed since this thread started, and some of what you changed cannot be put together with it automatically. That is
below, with where to read the workspace's version of each file.

Settle each of them: read both versions, work out what the other change was for, and make the file hold both. Then
carry on and answer. Do not describe the problem to the user instead of settling it, and do not throw away either
side's work to make the clash go away.`;

// ...and what the user is told when it did not, after being asked as often as
// it is going to be. Saying nothing would leave them to find out at the one
// moment this is all meant to spare them: when they come to apply the work
// and none of it will go back.
const UNSETTLED = (paths: string[]) =>
  `\n\n---\n\nThese changes will not go back into your workspace as they are: ${paths.join(', ')} ` +
  `${paths.length === 1 ? 'was changed' : 'were changed'} both here and in your workspace since this thread ` +
  'started, in ways that could not be put together, and this reply did not settle them. Ask again to have ' +
  'another go at it, or reconcile the files yourself.';

// What a thread is told when it is answering a message in a workspace that is
// being looked at for the first time right now. It used to wait for that look
// to finish; it does not, because a look takes as long as the project is big
// and the user is sitting there. So it is told what is going on, told that
// what it knows about this project it will have to find out, and told to keep
// it where keeping it costs nobody anything: its own note.
const ALONGSIDE_SURVEY = `Nobody has worked in this workspace before, and the project is being read through right now
by somebody else, in another thread. There is no settled note on it yet: what you have above, if anything, is as far
as that reading has got.

So do not take the absence of a note for the absence of a convention. Before you change anything, look at the code
around it and follow what is there. Search the workspace, read the files your change touches and the ones beside
them, and check how the same thing is done elsewhere.

Write what you work out into your own context note as you go, not into the note on the project: the reading going on
now is what writes that one, and it is doing it properly, from the whole project rather than from the corner of it
you needed. Yours is yours, and it is what this thread will have next time. The particular things you establish are
still worth writing down with add_workspace_note, which takes one note at a time and so cannot get in the reading's
way; it is the one note everybody reads that is being written right now, and that is the one to leave alone.`;

// What to do once a tool has returned. It said the whole of what the context
// note is for as well, which ../sandbox/index.ts says already and the
// add_to_context description says again at the moment the model writes one;
// and it told every model to hand work out, which the handout tool's own
// description covers and which only a model capable enough is meant to be
// told (see ../subagents/index.ts). What is left is the loop, and the move
// that ends it — which is not the same move in a step whose words no user
// reads (see phases.ts).
const toolPrompt = (phase?: Phase) =>
  `After every tool call, write what's relevant into your context note with add_to_context; one call of it can cover
several results, and it is not a round of looking. Then decide again: call another tool if something is still
missing, or ${
    phase ? 'write what this step has to produce' : 'give the user your answer'
  }. If a tool fails, say what happened rather than guessing at its result.`;

// What the thread's context note is put under. The note is the record of what
// this thread has already found out and already done, over every message in
// it, and it reads like a plan: files to change, what is left to do. Handed
// over unframed, it is an open work order, and a model that takes it for one
// sets about the thread's earlier messages again instead of the one in front
// of it. So it is given for what it is — a record of finished work, and the
// place to write this message's own.
const CONTEXT_NOTE = `Your saved context note for this thread: what you found out and what you have already done,
for this request and for requests that have already been answered. Read it as history, not as instructions — what is
in it is work that is finished, not work waiting to be done.`;

async function systemPrompt(
  threadId: string | undefined,
  task: Task,
  workspace: string | undefined,
  toolNames: string[],
  // Which provider is answering, which decides what it is told about keeping
  // what it finds (see ./discoveries.ts)
  provider: string,
  phase?: Phase,
  // The finding-out step's allowance, where this is that step (see plainPrompt)
  finding?: Finding
): Promise<string> {
  // A step of a coding change can have no tools at all (see phases.ts). What
  // is left out with them is everything that only means something to a model
  // that can call one; what stays is the thread's own context note, which is
  // how a step passes on what does not belong in its closing words.
  const withTools = toolNames.length > 0;
  // Handed to plainPrompt, which puts each where it belongs in the order the
  // prompt cache wants: what holds for the whole thread near the head, what
  // changes with the step towards the end (see plainPrompt)
  const tooling = withTools
    ? {
        held: [sandbox.PROMPT],
        stepped: [
          toolPrompt(phase),
          // Said in every step that has tools, including the ones whose words
          // no user reads: the finding out is where the findings are made, and
          // it is the step FORMAT_PROMPT is left out of (see plainPrompt)
          discoveries.prompt(provider, phase),
          toolsPrompt(toolNames),
          showPrompt(toolNames, phase),
          subagents.prompt(task.sophistication, true, phase),
          workspace ? sandbox.workspacePrompt(workspace, changing(toolNames, phase)) : '',
        ],
      }
    : undefined;
  const parts = [plainPrompt(task, toolNames, phase, finding, tooling)];
  // Last of all, because it is the part that changes: the note is written to
  // as the work goes on, and read as each step's instructions are built, so
  // that a step sees what the step before it wrote here
  // Its own note where this is a subagent's reply, and the thread's where it
  // is the thread's: a subagent writes to a file of its own, so that nothing
  // it has written down can be written over by the work going on beside it
  // (see contextFile in ../sandbox/index.ts)
  const context = await sandbox.readContext(threadId, task.agent);
  if (context) parts.push(`${CONTEXT_NOTE}\n\n${context}`);
  return parts.join('\n\n');
}

// Whether a result the model has written about is set aside (see setAside).
//
// Off, because rewriting a result rewrites the conversation that the thinking
// blocks of the same reply were signed against: Anthropic binds each block's
// signature to the conversation it was created in, and the step after the first
// note is refused with "Invalid `signature` in `thinking` block. The block is
// bound to a different conversation." (see ../llm/providers/anthropic.ts, which
// passes our earlier replies back whole to keep those blocks intact).
//
// The way back to it is to let the API drop the blocks whose binding no longer
// holds, with thinking.block_binding.prefix_mismatch_behavior: 'drop_block' and
// the thinking-binding-controls beta. Until then the room a long reply needs
// comes back only from the compactor (see compactor.ts), as it did before, and
// setAside stays here, tested and ready, rather than being torn out.
const SETTING_ASIDE = false;

// What a tool result is cut down to once it has been written about
export const SET_ASIDE = '[Set aside. What you wrote down about it with add_to_context is what is left of it.]';

// Gives back the room taken by the results the model has written about.
//
// A reply otherwise carries every result it has ever read until the window fills
// and the compactor comes for all of them at once. Here the model earns the room
// back as it goes: once it has written a note, everything it had read before
// writing is covered by that note, and the text of those results goes while the
// note stays in front of it.
//
// What it has *not* written about is left exactly as it is. That is deliberate,
// and it was not always so: setting results aside whether or not anything had
// been written about them was tried, and a model that writes no notes — which
// the local models mostly do not — then works blind. It re-read the same four
// files three times over and never answered at all (measured with
// evals/notes.ts). So a note buys room, and the want of one costs only the room
// it would have bought.
//
// Only the text and the images are replaced. The message and the call it answers
// stay where they are: a provider is owed a result for every call it made, and
// splicing them out is how that promise gets broken.
//
// `from` is where this reply's own work starts, so the conversation before it is
// not touched. Returns how many were set aside, for the log.
export function setAside(messages: ChatMessage[], from: number): number {
  // The last note the model wrote: everything it had read by then is what that
  // note was written from
  let lastNote = -1;
  for (let at = from; at < messages.length; at++) {
    const message = messages[at];
    if (message.role === 'assistant' && message.toolCalls?.some((call) => call.name === ADD_TO_CONTEXT)) lastNote = at;
  }
  if (lastNote === -1) return 0;
  let set = 0;
  for (let at = from; at < lastNote; at++) {
    const message = messages[at];
    if (message.role === 'tool' && message.content !== SET_ASIDE) {
      message.content = SET_ASIDE;
      delete message.images;
      set++;
    }
  }
  return set;
}

// Replies waiting on the user's say-so for a model above the approval ceiling,
// by the requestId the message was sent with (see ../main.ts)
const approvals = new Map<string, (approved: boolean) => void>();

// How long such a question stands. A reply that nobody answers is a reply that
// never comes, and the user may well have walked away from the window; so when
// the time is up the question is taken as a decline and the reply goes on with
// the best model the ceiling allows, which is the answer that needs no one. The
// window counts the same time down on the card (see renderer/approvals.ts).
export const APPROVAL_TIMEOUT_MS = 60_000;

// The user's answer to an 'approval' event. Nothing happens if the request is
// no longer waiting, as when it was cancelled first.
export function answerApproval(requestId: string, approved: boolean): void {
  const answer = approvals.get(requestId);
  if (!answer) return;
  approvals.delete(requestId);
  answer(approved);
}

// Replies waiting on an answer to a question the model asked, by requestId. One
// at a time for a reply (see ask in run).
const questions = new Map<string, (answer: string) => void>();

// The user's answer to a 'question' event. Nothing happens if the request is no
// longer waiting, as when it was cancelled first, or if there is no answer.
export function answerQuestion(requestId: string, answer: string): void {
  const resolve = questions.get(requestId);
  if (!resolve || !answer.trim()) return;
  questions.delete(requestId);
  resolve(answer.trim());
}

export async function* run(
  {
    thread: threadId,
    workspace,
    summary,
    review: reviewing,
    resumed,
    plan: planning,
    investigate,
    rounds,
    agent,
    ...asked
  }: HarnessRequest,
  signal: AbortSignal,
  // Ties the log lines about this message together; see ../main.ts
  requestId?: string
): AsyncGenerator<HarnessEvent> {
  const where: log.Fields = { request: requestId, thread: threadId };
  // Puts a question to the user and holds the reply until they answer it, or
  // until the reply is stopped. The model may ask in two calls of one round, and
  // the user can only be asked one thing at a time, so each waits for the one
  // before it. The event is passed to whoever is draining the tool's reports
  // (see the context a round's tools are given).
  let earlier: Promise<unknown> = Promise.resolve();
  const ask = (emit: (event: HarnessEvent) => void, question: string, options: string[]): Promise<string> => {
    const answered = earlier.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (!requestId) return reject(new Error('There is nobody to ask here.'));
          const id = requestId;
          const stopped = () => {
            questions.delete(id);
            reject(new Error('The reply was stopped before the user answered.'));
          };
          if (signal.aborted) return stopped();
          signal.addEventListener('abort', stopped, { once: true });
          questions.set(id, (answer) => {
            signal.removeEventListener('abort', stopped);
            resolve(answer);
          });
          log.info('question.asked', { ...where, options: options.length });
          emit({ type: 'question', question, options });
        })
    );
    earlier = answered.catch(() => undefined);
    return answered;
  };
  // A workspace nobody has looked at yet is looked at: an explorer goes through
  // it and writes the note every thread here is shown from then on (see
  // project.ts). Started at once, and not waited for — a message that does
  // not touch the code can be answered while the explorer is still reading.
  if (workspace && project.due(workspace)) void project.survey(workspace, threadId);
  let note = workspace ? project.get(workspace, threadId) : '';
  const { models, providers } = await llm.listModels();

  let classification: Classification;
  if (resumed?.classification && !resumed.classification.failed) {
    // A reply picked up after the app closed keeps the rating the message
    // was given the first time. The window still has the note showing it,
    // so nothing is announced and nothing is spent.
    classification = resumed.classification;
    const { sophistication, effort, category } = classification;
    log.info('classification.reused', { ...where, sophistication, effort, category });
  } else {
    const classifying = performance.now();
    // Classifying may have to wait its turn; the user is told if it does
    let queued!: () => void;
    const waiting = new Promise<'queued'>((resolve) => (queued = () => resolve('queued')));
    const pending = classify({ ...asked, summary, workspace, note }, models, signal, queued);
    if ((await Promise.race([pending, waiting])) === 'queued') {
      log.info('classification.queued', where);
      yield { type: 'queued' };
    }
    classification = await pending;
    const { provider: classifier, model: classifierModel } = classification;
    const classified = { ...where, ms: log.since(classifying), provider: classifier, model: classifierModel };
    if (classification.failed) {
      log.warn('classification', { ...classified, ok: false, error: classification.reason });
    } else {
      const { sophistication, effort, category } = classification;
      log.info('classification', { ...classified, ok: true, sophistication, effort, category });
    }
    yield { type: 'classification', ...classification };
    if (classification.provider && classification.model && classification.usage) {
      const { provider, model, usage } = classification;
      yield { type: 'usage', ...priced('classification', provider, model, usage, models) };
    }
  }
  if (signal.aborted) {
    yield { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 0 };
    return;
  }

  // A first look at this workspace may be going on right now, in a thread of
  // its own (see project.survey). This message does not wait for it: the look
  // takes as long as the project is big, and a user who asks for something in
  // a fresh workspace should not sit through it. The thread is told instead,
  // and finds out what it needs for itself.
  const surveying = Boolean(workspace) && project.surveying(workspace as string);
  if (surveying) log.info('reply.alongside-survey', { ...where, workspace });

  // A look going on anywhere — not only in this workspace — is a long job on
  // the local models, which serve one request at a time. So while one is
  // running the reply goes the other way, to a hosted model, rather than
  // queueing behind a job nobody is waiting for. Offline drops the preference
  // on its own, there being no hosted models to prefer (see route). Fast mode
  // asks for the same for every reply, for the speed of it.
  const looking = project.looking().length > 0;
  const prefer = looking || llm.isFast() ? 'hosted' : undefined;
  const vision = asked.messages.some((m) => m.role === 'tool' && (m.images?.length ?? 0) > 0);
  const routed = route(models, classification, { ...asked, vision }, prefer);
  if (!routed) {
    const reasons = providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`);
    log.error('route', { ...where, ok: false, error: 'No models available.', providers: reasons });
    yield { type: 'error', code: 'other', message: ['No models available.', ...reasons].join('\n') };
    return;
  }
  // Declared with its type so that it can be changed later in the reply (see
  // below, where a screenshot calls for a model that can see it)
  let chosen: Route = routed;
  // A model above the ceiling is not used until the user says so; a model they
  // picked themselves needs no say-so. Without a requestId there is no way to
  // be answered, so the lesser model is used.
  const ceiling = llm.approvalCeiling();
  if (chosen.reason !== 'picked' && chosen.sophistication !== undefined && chosen.sophistication > ceiling) {
    const fallback = capped(models, classification, ceiling, prefer, vision);
    if (fallback) {
      let approved = false;
      const saved = resumed?.approval;
      if (saved && saved.provider === chosen.provider && saved.model === chosen.id) {
        // The answer was given before the app closed, so the user is not asked again
        approved = saved.approved;
      } else if (requestId) {
        yield {
          type: 'approval',
          provider: chosen.provider,
          model: chosen.id,
          name: chosen.name,
          sophistication: chosen.sophistication,
          ceiling,
          fallbackName: fallback.name,
          timeoutMs: APPROVAL_TIMEOUT_MS,
        };
        log.info('route.approval', { ...where, provider: chosen.provider, model: chosen.id, ceiling });
        const asking = { ...where, provider: chosen.provider, model: chosen.id };
        approved = await new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settle = (answer: boolean) => {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            approvals.delete(requestId);
            resolve(answer);
          };
          const aborted = () => settle(false);
          signal.addEventListener('abort', aborted, { once: true });
          approvals.set(requestId, settle);
          // Nobody answered: the lesser model is used (see APPROVAL_TIMEOUT_MS)
          timer = setTimeout(() => {
            log.info('route.approval.timeout', { ...asking, ms: APPROVAL_TIMEOUT_MS });
            settle(false);
          }, APPROVAL_TIMEOUT_MS);
          if (signal.aborted) aborted();
        });
        if (signal.aborted) {
          yield { type: 'done', stopReason: 'cancelled', usage: { input: 0, output: 0 }, steps: 0 };
          return;
        }
      }
      if (!approved) chosen = fallback;
    }
  }
  yield {
    type: 'model',
    provider: chosen.provider,
    model: chosen.id,
    name: chosen.name,
    sophistication: chosen.sophistication,
    reason: chosen.reason,
  };
  log.info('route', { ...where, ok: true, provider: chosen.provider, model: chosen.id, reason: chosen.reason });

  // How much room the answering model has, which decides how much of a file a
  // read returns and how many rounds of looking the finding-out step is given
  // (see pageFor in ../tools/sandbox.ts and phases.findingRounds). Undefined
  // for a model that does not say.
  let window = models.find((m) => m.provider === chosen.provider && m.id === chosen.id)?.contextWindow ?? undefined;
  const offered = tools
    .list()
    .filter((tool) => workspace || !tool.needsWorkspace)
    .filter((tool) => !workspace || !tool.generalOnly)
    // A subagent's own, never offered in a reply of its own: see
    // ../tools/branches.ts. This reply may be a subagent's, in which case they
    // are exactly what it is here for.
    .filter((tool) => agent || !tool.agentOnly)
    // ...and what no subagent may do, whatever else it is given: ask the user,
    // replace the workspace's note, move the thread, or record for somebody to
    // watch. All four belong to the reply that sent it, and an agent is one of
    // several at work out of the user's sight (see allows in
    // ../subagents/agent.ts, which is where the list and the reasons are).
    .filter((tool) => !agent || subagents.AGENT.allows(tool))
    // ...and, at the bottom of the chain of subagents, not the tools for
    // handing more work out: they are not offered rather than offered and
    // refused, a tool a model can see being a tool it will try. The same bound
    // specsFor keeps for the kinds that run in the loop, read from the running
    // subagent's side rather than from its sender's (see MAX_HANDOUT_DEPTH in
    // ../subagents/kind.ts). Without it an agent could send agents for ever:
    // the list a subagent run through this flow is offered is built here and
    // not by specsFor.
    .filter((tool) => !agent || agent.depth <= subagents.MAX_HANDOUT_DEPTH || !HANDS_WORK_OUT.has(tool.name))
    .filter((tool) => reviewing || !tool.needsReview)
    // Without a requestId there is no way to be answered (see ../main.ts)
    .filter((tool) => requestId || tool.name !== ASK_TOOL)
    // The look going on is writing the project's note. A thread that has just
    // met the workspace has nothing to add to it that the look is not already
    // finding out properly, and what it does know belongs in its own note.
    .filter((tool) => !surveying || !tool.writesProjectNote);
  // What a step of a coding change is offered, which is not all of them: the
  // tools that write are kept back until there is a plan to write from (see
  // phases.ts). Without a step, every tool there is.
  const toolsFor = (phase?: Phase) =>
    (phase ? offered.filter((tool) => phases.offers(tool, phase)) : offered).map((tool) => ({
      name: tool.name,
      // What this step is told about it, where the tool says that apart from
      // its general description (see Tool.describe)
      description: tool.describe?.(phase, window) ?? tool.description,
      inputSchema: tool.schemaFor?.(phase, window) ?? tool.inputSchema,
    }));
  let useTools = offered.length > 0;
  // Known before any tool runs, so the container is created with its files
  if (threadId && workspace) sandbox.setWorkspace(threadId, workspace);

  const messages: ChatMessage[] = [...asked.messages];

  // A reply the app closed on is picked up rather than started again: the
  // model is handed what it had written and what it had done, and carries on
  // from there (see pickedUp). The conversation itself is unchanged, so the
  // message is classified and routed on its own merits, as it was the first
  // time.
  if (resumed) {
    if (resumed.text) messages.push({ role: 'assistant', content: resumed.text });
    messages.push({ role: 'user', content: pickedUp(resumed) });
    log.info('reply.resumed', { ...where, did: resumed.did.length, wrote: resumed.text?.length ?? 0 });
  }

  // Review comments go to a reviewer each, at once, rather than to the model
  // answering: a comment is one small, self-contained job, and the model that
  // would work through them one at a time is better spent on the summary of
  // what was done (see subagents.ts). Each reviewer replies to its own
  // comment, so the user sees the answers under the comments either way.
  const asking = asked.messages.at(-1)?.content ?? '';
  const all = reviewing && useTools ? review.comments(asking) : [];
  // A comment a reviewer answered before the app closed is not sent again:
  // its answer is already under it, where the user can see it
  const comments = resumed?.answered?.length ? all.filter(({ id }) => !resumed.answered!.includes(id)) : all;
  // Every comment was answered before the app closed, so what is left is the
  // summary, exactly as it is when the reviewers have just finished
  let reviewed = all.length > 0 && comments.length === 0;
  if (comments.length > 0) {
    const context: ToolContext = {
      signal,
      threadId,
      workspace,
      model: { provider: chosen.provider, model: chosen.id },
    };
    const reports = relay<HarnessEvent>();
    const running = subagents.reviewComments(comments, { ...context, emit: reports.push }).finally(reports.close);
    yield* reports.drain();
    try {
      const said = await running;
      messages.push({ role: 'user', content: `What the reviewers did with the comments:\n\n${said}` });
      reviewed = true;
      log.info('review.delegated', { ...where, comments: comments.length });
    } catch (err) {
      // The model answering goes through them itself, as it used to
      log.warn('review.delegated', { ...where, comments: comments.length, error: (err as Error).message });
    }
  }

  const shared = {
    sophistication: chosen.sophistication,
    summary,
    ...(agent ? { agent: agent.name } : {}),
    project: note,
    notes: workspace ? notes.count(workspace, threadId) : undefined,
    surveying,
    review: reviewing,
    reviewed,
  };
  const judged = classification.failed
    ? { category: workspace ? WORKSPACE_DEFAULT_CATEGORY : DEFAULT_CATEGORY, effort: DEFAULT_EFFORT }
    : { category: classification.category, effort: classification.effort };
  // Asked for outright, the reply is an investigation whatever the classifier made of the message
  const task: Task = { ...judged, ...shared, ...(investigate ? { category: 'investigation' as const } : {}) };
  // Which instructions the model is working under. They change with the step
  // of a coding change the reply has reached, and change again when a model
  // that cannot take tools makes the reply fall back to a plain answer
  // (below), so they are asked for rather than worked out once. Each step's
  // are built when it first asks for them, which is what lets a step read the
  // context note the step before it wrote (see systemPrompt).
  const built = new Map<string, string>();
  // One set per step, and the same set all the way through it: a step whose
  // rounds are spent is told so in a message at the end of what it has been
  // sent (see phases.spent), not in instructions built again without the
  // tools. A local server keeps what it has already read of a prompt and
  // reads only what was added to the end — and the instructions and the tools
  // are the head of it, so building them again moved the first changed token
  // from the end of a 21,000-token prompt to the start of it, and the server
  // read the whole thing again. That cost 110 seconds of a 396-second reply,
  // on the one step with the most in front of it, to say something that fits
  // in a sentence at the end. Measured: a turn appended to a prompt whose head
  // is unchanged is read in 17 tokens, and the same turn with the tools taken
  // out of the head is read in 1,389.
  const systemFor = async (phase?: Phase): Promise<string> => {
    if (!useTools) return plainPrompt(task, [], phase);
    const names = !phase || phases.hasTools(phase) ? toolsFor(phase).map(({ name }) => name) : [];
    const key = phase ?? '';
    let system = built.get(key);
    if (system === undefined) {
      system = await systemPrompt(threadId, task, workspace, names, chosen.provider, phase, allowance);
      built.set(key, system);
    }
    return system;
  };
  // What the answering model has used across every pass so far, for the event
  // that ends the reply. Each pass reports its own as soon as it is over, so
  // that a thread's total grows as the work happens rather than arriving whole
  // at the end (see the loop below).
  // cacheRead and cacheWrite are parts of input rather than additions to it
  // (see Usage), kept so that the line ending the reply says how much of what
  // it sent it paid full price for.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // ...and the same, as the reply reports it: a cached share of none is left
  // out rather than sent as a nought, because most providers say nothing about
  // caching at all and "nothing cached" is not the same answer as "no idea".
  const tally = (): Usage => ({
    input: usage.input,
    output: usage.output,
    ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWrite: usage.cacheWrite } : {}),
  });

  // What the message's effort bought, which is the bound unless the caller
  // asked for another one: an agent subagent is given a job and no ceiling at
  // all (see HarnessRequest.rounds)
  const bought = maxSteps(task.effort, Boolean(workspace));
  const limit = rounds ?? bought;
  // ...of which the finding-out step gets a share and no more (see phases.ts),
  // bounded by what its window holds as well as by what its effort bought. It
  // is told the number as well as held to it.
  //
  // The share is taken from what the effort bought rather than from the whole,
  // so that a reply with no ceiling on its rounds still has a step that stops
  // reading and writes down what it has. That step is what keeps the window
  // from filling with file contents before there is a plan to fit in it, and a
  // share of no ceiling would be no share at all.
  const share = Math.min(limit, bought);
  const finding = phases.findingRounds(share, window);
  const allowance: Finding = { rounds: finding, tight: phases.windowBound(share, window) };
  // The doing step has no such allowance: its reading is how it finds out that
  // the plan is wrong, which is the one thing nothing before it can do for it,
  // and what bounds it is the step budget and the window (see phases.ts, where
  // the cap it used to have is written down).
  //
  // A long run of tool calls is kept inside the model's context window: when
  // the window is nearly full, the older calls and results of this reply are
  // condensed into findings (see compactor.ts). The conversation itself, up
  // to the message being answered, is left as it is.
  const conversation = messages.length;
  // What the messages come to, as the model will see them, tools included
  const total = (system: string, phase?: Phase) => size(messages, system) + estimate(JSON.stringify(toolsFor(phase)));
  // Not every compaction can win back much room: the carried findings and the
  // latest few messages are a floor, and a reply whose tool results are large
  // can sit above the mark with nothing left that is worth condensing. So a
  // reply must take on this much new work before it is condensed again.
  // Without it, a reply that stays above the mark is condensed at every step
  // for the rest of its life, each one a pass over the model for room that is
  // not there to win. A fifth of the window is more than a compaction that
  // worked leaves to be filled, so this only ever bites on one that did not,
  // and the reply cut off for want of room is condensed regardless (below).
  const growth = Math.ceil((window ?? 0) * 0.2);
  let compactAgainAt = 0;
  const condense = async function* (): AsyncGenerator<HarnessEvent, boolean> {
    const before = messages.length;
    // Said before the work, which can take a while, and again after it
    yield { type: 'condensing' };
    const compacted = await compact(
      messages,
      { provider: chosen.provider, model: chosen.id, window },
      signal,
      conversation
    );
    // Condensing is itself work for the model, so what it took is reported
    // like any other pass, even when nothing came of it
    if (compacted.usage.input || compacted.usage.output) {
      yield { type: 'usage', ...priced('compaction', chosen.provider, chosen.id, compacted.usage, models) };
    }
    // The findings outlive this reply only if they are written down: the message
    // they were put into is gone when it ends (see sandbox.keepFindings)
    if (compacted.findings) {
      const kept = await sandbox.keepFindings(threadId, compacted.findings, agent?.name);
      log.debug('compaction.kept', { ...where, ok: kept, chars: compacted.findings.length });
    }
    const condensed = compacted.messages !== messages;
    if (condensed) {
      messages.splice(0, messages.length, ...compacted.messages);
      log.info('reply.compacted', { ...where, from: before, to: messages.length });
    }
    // Whether or not anything came of it, this reply has now been through a
    // compaction and must take on more work before it is worth another
    compactAgainAt = total(await systemFor(phase), phase) + growth;
    yield { type: 'condensed', changed: condensed };
    return condensed;
  };
  // A reply cut off with nothing written is condensed and tried again, once
  let retried = false;
  // Whether this reply has changed any files, which is what makes bringing the
  // thread level with its workspace worth the work (see WRITES_FILES)
  let wrote = false;
  // How many times the thread has been asked to settle a clash this reply. A
  // model that cannot settle one in two goes is not going to settle it in
  // ten; the check itself is run once more than that, so that a reply ending
  // with clashes still in it is one the user can be told about (see
  // UNSETTLED).
  let levelled = 0;
  // ...and how many times the reply has stopped to collect subagents it handed
  // out without waiting for
  let gathered = 0;
  // ...and how many times it has been told that answering a letter is not the
  // same as finishing the job, which is only ever said to an agent subagent
  // (see mailbox.ANSWERED). Twice: a model that reports the moment it is
  // spoken to twice running is reporting, not being interrupted.
  let lettersAnswered = 0;
  // Letters it has been sent and not yet answered, where it is an agent
  // subagent (see ../subagents/mailbox.ts). Kept across the steps rather than
  // per step, because a step can end with the model having said nothing at all
  // — cut off for length, or stopped without writing anything — and such a
  // step is asked again. A letter answered there would be answered with the
  // nothing that step produced.
  let letters: ReturnType<typeof subagents.mailbox.take> = [];
  // ...and how many times it has been asked for an answer it wrote into its
  // reasoning instead of its reply, or said it would do something and did
  // not (see NO_ANSWER and ANNOUNCED)
  let nudged = 0;
  // Tool calls this reply has made, over all its steps. A reply that has run
  // nothing and ends by saying what it was about to do has not answered
  // anybody (see announcing).
  let acted = 0;
  // Images this reply's tools have returned, for the user to be shown at the
  // end (see SHOWN). Kept apart from the messages, where setAside() drops them.
  const pictures: ToolImage[] = [];
  // ...and the clips it recorded, which are the user's alone: no provider
  // takes video, so these never go near `messages` (see ToolVideo in
  // ../types.ts). What the model sees of a recording is frames, and those
  // arrive as ordinary images above.
  const films: ToolVideo[] = [];
  // A coding change in a workspace is worked through in discrete steps: find
  // out, plan, do, answer. Each is finished before the next begins and each
  // is given the one before it rather than everything that has happened (see
  // phases.ts). Null for every other reply, which is answered in one run as
  // it always was.
  let order = phases.forReply({
    plan: planning !== 'never',
    category: task.category,
    workspace: Boolean(workspace),
    tools: useTools,
    resumed: Boolean(resumed),
  });
  // A thread set to plan always does, and one set never to does not. Any other
  // thread is asked about this task, once, with a prompt of its own (see
  // planner.ts): only a task that is a coding change in a workspace is worth
  // the question. An investigation is not asked: it has no plan to decide on.
  if (order && planning !== 'always' && task.category !== 'investigation') {
    const deciding = performance.now();
    const decision = await decide({ messages: asked.messages, summary }, models, signal);
    const { provider, model, usage: spent } = decision;
    log.info('planning', {
      ...where,
      ms: log.since(deciding),
      provider,
      model,
      plan: decision.plan,
      error: decision.reason,
    });
    if (provider && model && spent) yield { type: 'usage', ...priced('planning', provider, model, spent, models) };
    if (!decision.plan) order = null;
  }
  let phase = order?.[0];
  // How many times a step that wrote nothing has been asked for the words the
  // next step is given
  let carried = 0;
  // Rounds the step in hand has spent looking — calling a tool that told it
  // something it did not already have. What the finding-out step is held to
  // (see phases.findingRounds and WRITES_DOWN).
  let looked = 0;
  // ...and whether it has been told its rounds are gone, which is said once
  let told = false;
  // Files the step in hand has actually had open: what it read itself, what an
  // explorer read for it and reported, and what a reading command printed out
  // of a file. What the finding-out step's write-up may make claims about (see
  // ./grounding.ts), and emptied with everything else when a step ends.
  const opened = new Set<string>();
  // ...and whether it has been asked to check a claim about a file it never
  // opened, which is asked once: a step that will not read the file the second
  // time it is told to is not going to, and the write-up carries the caveat
  // instead (see grounding.CAVEAT).
  let checked = false;
  // What the step before this one sent, as far as a local server keeping its
  // prompt is concerned (see cachelock.Shape)
  let sentBefore: cachelock.Shape | undefined;
  if (phase) {
    log.info('phase.start', { ...where, phase, steps: order?.length });
    yield { type: 'phase', phase, ...(task.category === 'investigation' ? { investigation: true } : {}) };
  }

  for (let step = 1; step <= limit; step++) {
    yield { type: 'step', step };
    // Where this reply is an agent subagent's: anything the model that sent it
    // has written to it since the last round. Each goes in as a turn of its
    // own, here rather than anywhere else in the step because a turn added
    // after the room has been measured is a turn the measuring did not count —
    // and it is answered with whatever this round writes (see below, and
    // ../subagents/mailbox.ts). Only the ones that have just arrived: the rest
    // are in the conversation already, waiting on a round that says something.
    const fresh = agent ? subagents.mailbox.take(threadId, agent.name) : [];
    letters.push(...fresh);
    for (const letter of fresh) {
      messages.push({ role: 'user', content: subagents.mailbox.WROTE_TO_YOU(letter.text) });
      log.info('agent.letter.read', { ...where, step, agent: agent?.name, chars: letter.text.length });
    }
    // What the step would be sent as things stand, which decides both whether
    // the finding-out step has room for another round and whether the reply
    // wants condensing
    const system = await systemFor(phase);
    const now = window ? total(system, phase) : 0;
    // The finding-out step has a share of the reply's rounds and no more. A
    // model with tools can always find one more thing worth reading, and the
    // step that goes on reading is the one that fills the window with file
    // contents and leaves nothing for the plan or for the change — so when the
    // share is gone the tools go with it, and writing down what it has is the
    // only move left. The same thing that makes the planning step work at all
    // (see phases.SPENT).
    //
    // ...or when the window is nearly full, whichever comes first. The share
    // is worked out from what a round is reckoned to cost (see
    // phases.findingRounds) and a read can be dearer than that, so this is the
    // same ending reached by measuring instead of counting.
    //
    // Condensing is the wrong answer for this step twice over: what it
    // condenses away is the tool results this step's whole output is drawn
    // from, and on a small window it cannot win the room back at all, because
    // the last few messages it has to keep are already over the mark — so it
    // was attempted, cost a pass, achieved nothing, and the reply reached the
    // user as OUT_OF_ROOM with no plan and nothing to show. Ending the step
    // instead gets them a write-up made from what was read, and the steps
    // after it start nearly empty whatever this one spent.
    //
    // Only once the step has had a turn: before that there is nothing of this
    // reply in front of it to write up, and nothing to condense either.
    const full =
      phase === 'explore' && messages.length > conversation && window !== undefined && nearlyFull(now, window);
    const spent = phase === 'explore' && (looked >= finding || full);
    if (spent && !told) {
      told = true;
      log.info('phase.spent', { ...where, step, phase, rounds: finding, why: full ? 'window' : 'rounds' });
      messages.push({ role: 'user', content: phases.spent(full ? 'window' : 'rounds') });
    }
    // The doing step has no such ending: its reading is the only point in the
    // reply where anything is read against the plan rather than from it, so it
    // is bounded by the step budget and the window like any other reply and not
    // by an allowance of its own (see phases.ts).
    //
    // Only for a model that says how large its window is; one that doesn't
    // is condensed when it actually runs out (below). Never in the finding-out
    // step, which ends instead (see full above).
    if (window && phase !== 'explore') {
      if (nearlyFull(now, window) && now >= compactAgainAt) yield* condense();
    }
    // Two of the steps have no tools at all, which is what makes writing the
    // one thing they can do (see phases.ts). A step whose rounds are spent
    // keeps the ones it was offered, so that the head of its prompt is the one
    // the server has already read (see systemFor); what it may no longer do is
    // call them, which is done where its calls are (see spent below).
    //
    // The planning step is offered the one tool that asks the user something
    // (see phases.offers), so it is toolsFor that says which steps have any.
    const stepTools = useTools ? toolsFor(phase) : [];

    let text = '';
    let done: ProviderDoneEvent | undefined;
    let retryWithoutTools = false;
    // Whether any of this step's reply was for the user, not just thoughts
    let answered = false;
    // This step's reasoning as the model wrote it, kept whole rather than in
    // the thoughts it was broken into: it is what the answer is taken from
    // when the model wrote the answer there and left its reply empty (see
    // NO_ANSWER)
    let reasoned = '';
    const calls: ToolCall[] = [];
    // The model's own reasoning becomes the thoughts; its reply is its reply
    const reasoning = thoughts.reasoner();
    // Start timing when we're about to send the request, capturing any model
    // loading time before streaming starts (see https://github.com/ch-chat/ch/issues/1)
    const started = performance.now();
    // Whether what is about to be sent carries on from what the step before it
    // sent, which is what decides whether the model is kept for this reply or
    // handed to whatever is waiting (see ../llm/cachelock.ts). A step that
    // changed its tools or its instructions, or that has had a message pushed
    // in among the ones already read, starts again from the top of the prompt
    // whether or not anything else is waiting, so this is where the hold on it
    // is worth no more than the wait it is costing somebody else.
    const sending = cachelock.shapeOf(system, stepTools, messages);
    const why = sentBefore && cachelock.brokeBy(sentBefore, sending);
    if (why) cachelock.broke(threadId, why);
    sentBefore = sending;
    const request: ChatRequest = {
      provider: chosen.provider,
      model: chosen.id,
      messages,
      system,
      tools: stepTools,
      // Every pass of this reply sends the same prompt with a little more
      // after it, so they all look for their prefix in the same place
      cacheKey: threadId,
      log: { ...where, step, purpose: 'reply' },
    };
    // How long the model took to start replying. Logged rather than shown:
    // what the window reports is the whole call (see the usage event below),
    // and this is the part that says whether a slow one was slow to begin or
    // slow to write. The time spent queued behind another request is taken off
    // both: that is the app serialising its work, not the model being slow,
    // and counting the two as one has sent us looking in the wrong place
    // before.
    let firstTokenMs: number | undefined;
    let queuedMs = 0;
    const timing = (): log.Fields => ({
      ...where,
      step,
      provider: chosen.provider,
      model: chosen.id,
      tools: stepTools.length > 0,
      phase,
      ms: log.since(started),
      queuedMs,
      firstTokenMs,
    });
    for await (const event of llm.stream(request, signal)) {
      // Waiting behind another request, or behind the conversation the model is
      // holding its prompt for (see ../llm/cachelock.ts). Said in the thread:
      // a reply that has not started yet is either waiting or broken, and the
      // two look exactly alike from outside. It says nothing about the model
      // itself, so what the wait came to is kept off the model's own timings.
      if (event.type === 'queued') {
        log.debug('llm.waiting', { ...where, step, provider: chosen.provider, model: chosen.id });
        yield { type: 'queued', model: chosen.id };
        continue;
      }
      if (event.type === 'waited') {
        queuedMs = event.ms;
        yield { type: 'waited', ms: event.ms };
        continue;
      }
      // Turned away and being asked again: said in the thread, because a reply
      // that stops for half a minute should say why (see llm/index.ts)
      if (event.type === 'rate_limited') {
        yield event;
        continue;
      }
      // Given up on for another model: said in the thread too, so the reply
      // that follows is not taken for the first one's (see llm/index.ts)
      if (event.type === 'fell_back') {
        yield event;
        continue;
      }
      // What this pass has used so far, priced as the finished pass will be
      // (see TokensEvent): the window's running total climbs while the model
      // writes, instead of standing still until the pass is over. Nothing is
      // logged and nothing is kept — the usage event below is the record —
      // and it is taken before the timing, since the first of these arrives
      // with the prompt's own count, before the model has written anything.
      if (event.type === 'tokens') {
        yield {
          type: 'tokens',
          ...priced('reply', chosen.provider, chosen.id, event.usage, models),
          ...(event.estimated ? { estimated: true } : {}),
        };
        continue;
      }
      if (event.type !== 'error') firstTokenMs ??= log.since(started) - queuedMs;
      if (event.type === 'error') {
        log.warn('llm.call', { ...timing(), ok: false, code: event.code, status: event.status, error: event.message });
        // Some models (many small local ones) reject requests that carry
        // tools. Fall back to a plain answer rather than failing the message.
        if (event.status === 400 && useTools && step === 1) {
          retryWithoutTools = true;
          break;
        }
        // An error that arrives with some of the reply already written is the
        // stream ending badly rather than the request failing, and what was
        // written is worth more to the user than the message is. So the step
        // ends here with what arrived, as if the model had stopped there, and
        // the reply goes on: its reasoning stands in for an answer it never
        // wrote (see NO_ANSWER below), a step of a coding change is asked for
        // the write-up it owes and carries on to the next step, and a round of
        // tool calls that arrived before the error is still run.
        //
        // The error that brought this on comes from the local server's own
        // post-processing rather than from the model: Ollama parses tool calls
        // out of what the model wrote, and a model that writes a malformed one
        // has the parse failure reported as the stream's error — which Ollama
        // itself logs as a warning, having answered HTTP 200 with every token
        // generated. Failing on it cost a finding-out step the whole write-up
        // it had just reasoned its way to, six minutes in, and gave the user
        // the Go parser's words for it in place of a reply.
        //
        // A reply truncated by a connection that dropped mid-answer ends this
        // way too, and is the reason the warning above is logged whatever
        // happens here: the user gets the part that arrived, and the log is
        // what says it was not all of it.
        if (answered || reasoned || calls.length > 0) {
          done = { type: 'done', stopReason: calls.length > 0 ? 'tool_use' : 'end_turn' };
          break;
        }
        yield* reasoning.end();
        yield event;
        return;
      }
      if (event.type === 'text') {
        // The model has stopped reasoning and started answering, so whatever
        // reasoning is still held back is a finished thought even if it does
        // not look like one to a buffer waiting for a paragraph to end. It
        // goes out before the words it came before, rather than after the
        // whole reply (see thoughts.ts).
        if (!answered) yield* reasoning.end();
        text += event.delta;
        answered = true;
        // What a step writes for the step after it is not the reply, and does
        // not go into it: the finding-out step's write-up and the doing step's
        // account of what it did are both handovers, shown as thoughts when
        // the step ends. Only the steps whose words the user is there for —
        // the plan, the answer, the write-up of an investigation — stream into
        // the reply (see phases.readByUser). Left in, the doing step's account
        // is answered again by the answering step a moment later, and a doing
        // step that ran no tools at all, having nothing to hand out, puts the
        // whole of the reply in the bubble twice.
        if (!phase || phases.readByUser(phase)) yield event;
      } else if (event.type === 'reasoning') {
        // Reasoning the provider reports apart from the reply (see
        // ReasoningEvent). It is shown, but never kept in the model's own
        // history, which is its reply alone.
        reasoned += event.delta;
        yield* reasoning.reason(event.delta);
      } else if (event.type === 'tool_call') {
        calls.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === 'done') {
        done = event;
      }
    }

    if (retryWithoutTools) {
      useTools = false;
      // The steps are built out of which tools a step is offered, and there
      // are none to offer now
      order = null;
      phase = undefined;
      step--;
      continue;
    }
    yield* reasoning.end();
    if (!done) {
      log.warn('llm.call', { ...timing(), ok: false, error: 'The model stopped without finishing.' });
      yield { type: 'error', code: 'other', message: 'The model stopped without finishing.' };
      return;
    }

    log.info('llm.call', {
      ...timing(),
      ok: true,
      stopReason: done.stopReason,
      input: done.usage?.input,
      output: done.usage?.output,
      // What of the input was read back from the prompt cache, and what was
      // written into it. Logged on every pass because this is where a cache
      // that has stopped working shows: a loop whose cacheRead stays at zero
      // from one step to the next is resending the prompt in full, and the
      // reason is somewhere in what changed before the breakpoint (see
      // ../llm/providers/anthropic.ts).
      cacheRead: done.usage?.cacheRead,
      cacheWrite: done.usage?.cacheWrite,
      toolCalls: calls.length,
    });
    usage.input += done.usage?.input ?? 0;
    usage.output += done.usage?.output ?? 0;
    usage.cacheRead += done.usage?.cacheRead ?? 0;
    usage.cacheWrite += done.usage?.cacheWrite ?? 0;
    // This pass's own tokens, not the running total: whoever is listening adds
    // them up. Nothing to report if the provider gave no counts.
    if (done.usage && (done.usage.input || done.usage.output)) {
      yield {
        type: 'usage',
        ...priced('reply', chosen.provider, chosen.id, done.usage, models),
        // How long this pass kept the user waiting, reported beside what it
        // cost so that the window can show the one with the other (see
        // Latency). The whole of it, taken here because here is where the
        // stream has ended; the log line above has the same total as `ms`.
        // Untimed where nothing ever arrived: a pass that failed before the
        // first token measures the failure, not the model.
        ...(firstTokenMs === undefined
          ? {}
          : { latency: { totalMs: log.since(started) - queuedMs, ...(queuedMs ? { queuedMs } : {}) } }),
      };
    }

    // What it said in the round that read them goes back to whoever wrote to
    // it, whether or not it was meant as an answer: a letter is answered in a
    // round of the work or not at all (see mailbox.answered, for a round that
    // wrote nothing and called something). A round that neither wrote nor
    // called anything is not one of those — it is asked again below — so those
    // letters stay waiting for a round that says something.
    const wasWritten = letters.length > 0 && Boolean(text.trim() || reasoned.trim() || calls.length > 0);
    if (wasWritten) {
      const back = subagents.mailbox.answered(text || reasoned, calls);
      for (const letter of letters) letter.answer(back);
      letters = [];
    }

    // Its rounds are spent, so the tools it still has in front of it are
    // there for the prompt's sake and not for its use (see stepTools above).
    // A call it makes now is dropped rather than run, which is the ending the
    // step would have had anyway: what it has is what it has, and writing that
    // down is the only move left to it.
    //
    // Dropped whole, with the turn that made it: a call whose result never
    // comes back is a turn some providers refuse outright, and leaving it in
    // front of the model would only invite the next step to take up where it
    // left off. What the step is asked for next is the write-up (see
    // phases.NOTHING_CARRIED), which is all that was ever going to carry on.
    if (spent && calls.length > 0) {
      log.info('phase.late_call', { ...where, step, phase, dropped: calls.map((call) => call.name) });
      calls.length = 0;
      done = { ...done, stopReason: 'end_turn' };
    }

    // The model answered (or was cut off): the loop is over
    if (done.stopReason !== 'tool_use' || calls.length === 0) {
      // ...unless it changed files and has not been brought level with the
      // workspace since. The workspace does not stand still while a thread
      // works, and a file that will not go back is worth finding now, while the
      // model still has the problem in mind, rather than when the user comes to
      // apply the changes with the work behind them (see sandbox/changes.sync,
      // and tools/sync.ts for the same thing done on the model's own say-so).
      // ...and unless it handed work out without waiting for it, and that work
      // is still running. Ending now would throw away what those subagents
      // find and leave the thread with rows that never finish, so they are
      // collected and the model answers with them in hand (see waitFor).
      // ...and unless it answered a letter this round and called nothing. The
      // answer has gone back to whoever wrote to it already (above), but a
      // turn that answered a message is not the end of the job this agent was
      // given, and ending here would hand that sentence back as the whole of
      // its work (see mailbox.ANSWERED).
      if (wasWritten && done.stopReason === 'end_turn' && lettersAnswered < MAX_ANSWERED) {
        lettersAnswered++;
        log.info('agent.answered', { ...where, step, agent: agent?.name, chars: text.trim().length });
        const said = text.trim() || reasoned.trim();
        if (said) messages.push({ role: 'assistant', content: said, raw: done.raw });
        messages.push({ role: 'user', content: subagents.mailbox.ANSWERED });
        continue;
      }
      const outstanding = threadId ? subagents.stillRunning(threadId) : [];
      if (outstanding.length > 0 && done.stopReason === 'end_turn' && gathered < MAX_GATHERINGS) {
        gathered++;
        const call: ToolCall = { id: `${requestId ?? 'reply'}-wait-${gathered}`, name: subagents.WAIT_TOOL, input: {} };
        yield { type: 'tool_call', ...call };
        const found = await subagents.waitFor(threadId, outstanding);
        const output = subagents.report(found);
        yield { type: 'tool_result', id: call.id, name: call.name, output, isError: false };
        log.info('reply.gathered', { ...where, step, subagents: found.length });
        messages.push({ role: 'assistant', content: text, raw: done.raw });
        messages.push({ role: 'user', content: `${GATHERED}\n\n${output}` });
        continue;
      }

      if (wrote && threadId && workspace && done.stopReason === 'end_turn' && levelled <= MAX_LEVELLINGS) {
        levelled++;
        const call: ToolCall = { id: `${requestId ?? 'reply'}-level-${levelled}`, name: SYNC_TOOL, input: {} };
        yield { type: 'tool_call', ...call };
        const synced = await sandbox.changes.sync(threadId, workspace);
        const output = sandbox.changes.report(synced);
        yield { type: 'tool_result', id: call.id, name: call.name, output, isError: Boolean(synced.error) };
        log.info('reply.levelled', {
          ...where,
          step,
          pulled: synced.pulled.length,
          merged: synced.merged.length,
          clashes: synced.clashes.length,
        });
        if (synced.clashes.length > 0 && levelled <= MAX_LEVELLINGS) {
          messages.push({ role: 'assistant', content: text, raw: done.raw });
          messages.push({ role: 'user', content: `${SETTLE_CLASHES}\n\n${output}` });
          // `wrote` is left as it is on purpose. What the model does about a
          // clash is work of its own and earns its own check, but a model
          // that answers without touching a file would otherwise never be
          // checked again, and the reply would end with the clash still
          // there and nobody told.
          continue;
        }
        // It has had its goes and they are still there. The user is told,
        // because the alternative is being told the work is done and finding
        // out when they come to apply it that none of it will go back.
        if (synced.clashes.length > 0) {
          log.warn('reply.unsettled', { ...where, step, clashes: synced.clashes.map((clash) => clash.path) });
          yield { type: 'text', delta: UNSETTLED(synced.clashes.map((clash) => clash.path)) };
        }
      }
      // The step is over rather than the reply: the next one begins. Only on a
      // clean end — a refusal, a cancellation or running out of room ends the
      // reply wherever it had got to, and falls through to the handling below.
      if (phase && order && !phases.last(phase, order) && done.stopReason === 'end_turn') {
        const said = text.trim();
        // Its words are all the next step is given, so a step that wrote none
        // is asked for them before the reply goes on without them — hardest
        // of all in the finding-out step, whose write-up is the only thing the
        // planning step will have (see phases.asks)
        if (!said && carried < phases.asks(phase) && step < limit) {
          carried++;
          log.info('phase.empty', { ...where, step, phase });
          messages.push({ role: 'user', content: phases.NOTHING_CARRIED[phase] });
          continue;
        }
        // A write-up that says what is inside a file this step never opened is
        // the one error nothing downstream can catch: the planning step has no
        // tools, and the coders are sent to the files the words name (see
        // ./grounding.ts). So it is caught here. While the step has rounds and
        // room left it is sent to read them; once it has neither, the write-up
        // goes on with the caveat attached, which the plan shows the user.
        const loose = phase === 'explore' && said ? grounding.ungrounded(said, opened) : [];
        let carries = said;
        if (loose.length > 0) {
          log.info('phase.ungrounded', { ...where, step, phase, paths: loose, asked: !checked && !spent });
          if (!checked && !spent && step < limit) {
            checked = true;
            messages.push({ role: 'user', content: grounding.CHECK(loose) });
            continue;
          }
          carries += grounding.CAVEAT(loose);
        }
        // The plan is the step the user is there for, so it is handed over as
        // its own thing rather than left in the reply. What the steps that
        // write for the step after them wrote — the finding out, and the
        // doing step's account of what it did — are notes to themselves, and
        // are shown as ones.
        if (phase === 'plan') {
          // What the finding-out step took is shown with the plan, and so is
          // not left to be shown again under the reply (see SHOWN)
          yield {
            type: 'plan',
            text: said,
            ...(pictures.length > 0 && { images: pictures.slice(-SHOWN) }),
            ...(films.length > 0 && { videos: films.slice(-SHOWN_FILMS) }),
          };
          pictures.length = 0;
          films.length = 0;
        } else if (said && !phases.readByUser(phase)) yield { type: 'thought', text: said };
        const moving = phases.next(phase, order) as Phase;
        log.info('phase.done', { ...where, step, phase, next: moving, chars: said.length });
        // Everything this step did is left behind with it: what goes on is the
        // conversation up to the user's message, and then what the step wrote
        // down. Its tool calls and their results stay here (see phases.ts).
        messages.splice(conversation);
        messages.push({ role: 'user', content: phases.carry(moving, carries) });
        phase = moving;
        carried = 0;
        looked = 0;
        told = false;
        // What the step that is starting has had open, and whether it has been
        // asked about a claim from memory: both are about the step that just
        // ended (see ./grounding.ts)
        opened.clear();
        checked = false;
        // All three are about the step that has just ended: what it ran,
        // whether that changed any files, and whether those have been squared
        // with the workspace
        acted = 0;
        wrote = false;
        levelled = 0;
        yield { type: 'phase', phase };
        continue;
      }

      // Said what it was about to do and then stopped, having done nothing at
      // all this reply. The user is left with the sentence and none of the
      // work, so it is asked once to make the call it described.
      //
      // Only when the reply has run no tools whatever: a model that has
      // searched and read and then says it needs to look at one more thing
      // has given an answer of a kind, and badgering it would be worse than
      // taking it. This is for the turn that did nothing (see announcing).
      if (acted === 0 && answered && announcing(text) && nudged < MAX_NUDGES && step < limit) {
        nudged++;
        log.info('reply.announced', { ...where, step, chars: text.length });
        messages.push({ role: 'assistant', content: text, raw: done.raw });
        messages.push({ role: 'user', content: ANNOUNCED });
        continue;
      }
      // Cut off before it wrote any of its answer. If that is for want of
      // room, making room and trying again may get an answer
      if (done.stopReason === 'length' && !answered && !retried) {
        retried = true;
        if (yield* condense()) {
          step--;
          continue;
        }
      }
      // Still nothing to show for the reply, so it failed
      if (done.stopReason === 'length' && !answered) {
        log.warn('reply.empty', { ...where, step, input: done.usage?.input, output: done.usage?.output });
        yield { type: 'error', code: 'other', message: OUT_OF_ROOM };
        return;
      }
      // A model that declined has given its answer, and the window says as much
      // for itself. Asking it again would be pressing it for the one it has
      // just refused, so it is not asked - only logged, nothing else recording
      // that it happened.
      if (done.stopReason === 'refusal') {
        log.warn('reply.refused', { ...where, step, input: done.usage?.input, output: done.usage?.output });
      } else if (!answered && done.stopReason !== 'cancelled') {
        // The reply ended with nothing written for the user. Asked once for the
        // answer itself; failing that, its reasoning stands in for the answer
        // where there is any, rather than leaving the turn with nothing in it
        // (see NO_ANSWER).
        //
        // Asked whether or not it reasoned anywhere we could see. This used to
        // turn on there being reasoning to fall back on, which most of a reply
        // from Anthropic does not have: what it reports of its thinking is the
        // short notes it writes between tool calls, and on all but a few steps
        // there are none (4 of 143 steps, measured over the log). So the turn
        // that most needed asking again - the one that produced nothing at all
        // - was the only one never asked, and the user was told the model had
        // finished without writing an answer (see NOTHING_WRITTEN in
        // ../renderer.ts).
        //
        // ...unless there is no round left to ask in, when asking would end
        // the reply as one that ran out of rounds and throw the answer away
        if (nudged < MAX_NUDGES && step < limit) {
          nudged++;
          log.info('reply.no-answer', { ...where, step, reasoned: reasoned.length, action: 'asked' });
          // No assistant turn goes in with it: there was nothing in that one
          // to keep, and an empty one is what some providers refuse. Two of
          // the user's turns in a row are folded into one where that matters
          // (see ../llm/providers/anthropic.ts addUser).
          messages.push({ role: 'user', content: NO_ANSWER });
          continue;
        }
        if (reasoned.trim()) {
          log.warn('reply.no-answer', { ...where, step, reasoned: reasoned.length, action: 'reasoning' });
          yield { type: 'text', delta: reasoned.trim() };
        } else {
          log.warn('reply.no-answer', { ...where, step, reasoned: 0, action: 'nothing' });
        }
      }
      if ((pictures.length > 0 || films.length > 0) && done.stopReason !== 'cancelled') {
        yield {
          type: 'images',
          images: pictures.slice(-SHOWN),
          ...(films.length > 0 && { videos: films.slice(-SHOWN_FILMS) }),
        };
      }
      yield { type: 'done', stopReason: done.stopReason, usage: tally(), steps: step };
      return;
    }

    acted += calls.length;
    // A call to a tool this step was not offered, which is run all the same:
    // what a step offers decides what the model is shown, not what the registry
    // will answer to (see tools.execute). Worth a line of its own, because the
    // one that brings a model here is a doing step reaching for write_file
    // rather than handing the change out — the step looking exactly as it did
    // before, with nothing in the log to say the handing out never happened.
    if (phase) {
      for (const call of calls) {
        const tool = tools.get(call.name);
        if (tool && !phases.offers(tool, phase)) log.warn('tool.unoffered', { ...where, step, phase, tool: call.name });
      }
    }
    // A round that only wrote something down is not a round of looking, and is
    // not charged to the finding-out step's allowance (see WRITES_DOWN)
    // ...nor is one that only asked the user something
    if (calls.some((call) => !WRITES_DOWN.has(call.name) && call.name !== ASK_TOOL)) looked++;
    if (calls.some((call) => WRITES_FILES.has(call.name))) wrote = true;
    for (const call of calls) yield { type: 'tool_call', ...call };
    messages.push({ role: 'assistant', content: text, toolCalls: calls, raw: done.raw });

    // A tool may say what it is doing while it runs (subagents do), so its
    // events are passed on as they arrive rather than after it returns
    const reports = relay<HarnessEvent>();
    const context: ToolContext = {
      signal,
      threadId,
      workspace,
      model: { provider: chosen.provider, model: chosen.id },
      emit: reports.push,
      ask: (question, options) => ask(reports.push, question, options),
      phase,
      window,
      // Where this reply is itself a subagent's: its name, so that what it
      // writes down goes in its own note, and how far down the chain it
      // stands, so that what it hands out in turn knows the same (see
      // MAX_HANDOUT_DEPTH in ../subagents/kind.ts)
      ...(agent ? { agent: agent.name, depth: agent.depth } : {}),
      // The level of the model actually answering, not the level the classifier
      // asked for. The two part whenever the request was routed down: nothing
      // that capable was available, or the user did not approve what was
      // chosen. A coder piece is held below the model handing it out, and that
      // is the model, not the hope: Sonnet answering a request rated 4 hands
      // out at 2, where the rating would have had it hand out at 3 — Sonnet
      // again (see capped in ../subagents/run.ts). The rating stands in only
      // for a model whose level is unknown, which is one the user picked by
      // hand (see route).
      sophistication: chosen.sophistication ?? (classification.failed ? undefined : classification.sophistication),
    };
    const running = Promise.all(calls.map((call) => tools.execute(call, context, { ...where, step }))).finally(
      reports.close
    );
    yield* reports.drain();
    const results = await running;
    for (const result of results) {
      messages.push({
        role: 'tool',
        toolCallId: result.id,
        name: result.name,
        content: result.output,
        isError: result.isError,
        ...(result.images && { images: result.images }),
      });
      // Files this step can now say what is in. A read that failed opened
      // nothing, and the paths a handout or a reading command printed are
      // taken from what came back rather than from what was asked for (see
      // OPENS_A_FILE and ./grounding.ts).
      if (!result.isError) {
        if (result.name === OPENS_A_FILE) {
          const path = calls.find((call) => call.id === result.id)?.input?.path;
          if (typeof path === 'string') opened.add(grounding.normalize(path));
        } else if (REPORTS_A_FILE.has(result.name)) {
          for (const path of grounding.named(result.output)) opened.add(path);
        }
      }
      if (result.images) pictures.push(...result.images);
      if (result.videos) films.push(...result.videos);
      yield { type: 'tool_result', ...result };
    }

    // A result that carried images is of no use to a model that cannot see
    // them, and route() has only been asked once, before there were any. So the
    // rounds after it go to a model that can, where there is one; where there
    // is none the model stays. A model the user picked themselves stays too,
    // and a model above the approval ceiling is not moved to unasked.
    const current = models.find((m) => m.provider === chosen.provider && m.id === chosen.id);
    if (chosen.reason !== 'picked' && current?.vision === false && results.some((r) => r.images?.length)) {
      let seeing = route(models, classification, { vision: true }, prefer);
      if (seeing && seeing.sophistication !== undefined && seeing.sophistication > ceiling) {
        seeing = capped(models, classification, ceiling, prefer, true);
      }
      const next = seeing && models.find((m) => m.provider === seeing.provider && m.id === seeing.id);
      if (seeing && next && next.vision !== false) {
        chosen = seeing;
        window = next.contextWindow ?? undefined;
        yield {
          type: 'model',
          provider: chosen.provider,
          model: chosen.id,
          name: chosen.name,
          sophistication: chosen.sophistication,
          reason: chosen.reason,
        };
        log.info('route.vision', { ...where, step, provider: chosen.provider, model: chosen.id });
      }
    }

    // What the model has written about is set aside, and what it has not is left
    // for it to write about
    if (SETTING_ASIDE) {
      const set = setAside(messages, conversation);
      if (set > 0) log.debug('context.set_aside', { ...where, step, results: set });
    }
  }

  log.warn('request.max_steps', { ...where, effort: task.effort, limit });
  yield { type: 'done', stopReason: 'max_steps', usage: tally(), steps: limit };
}
