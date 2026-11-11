import type { HarnessEvent, Message, PendingRequest, Thread } from './types.js';
import {
  expanded,
  inflight,
  MAX_RECENT_WORKSPACES,
  onTab,
  PURPOSES,
  requests,
  runningCalls,
  startedAgents,
} from './shared.js';
import { activate, save, saveSoon, state } from './threads.js';
import { branchKey } from './sidebar.js';
import { drawText, render } from './thread-view.js';
import { about, clock, mergeUsage, recordUsage, tokenCount, usedLine } from './usage.js';
import {
  CATEGORY_NAMES,
  CLASSIFYING,
  CONDENSED,
  CONDENSING,
  describeThread,
  markFinal,
  phaseName,
  SHORTENING,
  touch,
  turnOf,
  WAITING,
  waitingOn,
  waitingTurn,
} from './reply.js';
import { APPROVING, approvalOf, askApproval, autoVerify, clearApproval } from './approvals.js';
import { askQuestion, questionOf } from './questions.js';
import { suggestReply } from './suggestion.js';
import { toolOf } from './tool-calls.js';
import { changesThread, countChanges, drafting, drawChanges } from './changes.js';
export function contextLines(passes: NonNullable<Message['passes']>): string {
  return passes
    .map((c, i) => `${i + 1}. ${PURPOSES[c.purpose]} · ${c.model}: ${tokenCount(c.input)} tokens`)
    .join('\n');
}

// Failure details are saved with the thread, so they are kept to a sensible size
export const MAX_DETAIL = 5000;
export const clip = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n[truncated]` : text);

// A successful call is shown in brief: enough to see what was asked and what
// came back, without the whole of a file or a command's output

export const SUMMARY_VALUE = 120; // characters of each input value
export const SUMMARY_LINES = 6; // lines of output
export const SUMMARY_LINE = 160; // characters of each output line

// A function declaration, since the first render runs before this line
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// One line per input: "path: src/main.ts"
export function summarizeInput(input: Record<string, unknown> | null): string {
  if (input === null) return 'The input was not valid JSON.';
  const lines = Object.entries(input).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}: ${shorten(String(text).replace(/\s+/g, ' ').trim(), SUMMARY_VALUE)}`;
  });
  return lines.join('\n') || 'No input.';
}

// The first few lines of the output, and how many more there were
export function summarizeOutput(output: string): string {
  const lines = output.trimEnd().split('\n');
  if (!lines.join('').trim()) return 'No output.';
  const shown = lines.slice(0, SUMMARY_LINES).map((line) => shorten(line, SUMMARY_LINE));
  const more = lines.length - shown.length;
  if (more > 0) shown.push(`… ${more} more ${more === 1 ? 'line' : 'lines'}`);
  return shown.join('\n');
}

// What the thread shows for a reply that ended without a word for the user
export const NOTHING_WRITTEN = 'The model finished without writing an answer. Its thoughts above are all it produced.';

export const NOTE_BODY = 200; // characters of a failure a notification carries

// A thread's news, said to the user where they will see it when they are not
// looking at the thread: the same moments the sidebar's dot changes for (a
// question waiting, a reply over), for the user who has gone to another thread
// or another window. Not said of the app's own threads, whose work is none of
// the user's asking, nor where the system has no notifications to give (the
// test page has none). Clicking it brings the thread up.
// Whether the user is looking at this thread as its news arrives: it is the
// one on screen and the window has the focus. News about a thread being
// watched is not news — and news about one that is not is news even when it is
// the thread that happens to be open, the user having gone to another window.
//
// Shared by the notification and the icon's count, which each used to decide
// this for themselves and had drifted apart: the notification asked about the
// focus and the count did not, so a reply landing in the open thread while the
// user was in another app was notified and never counted. One thread open is
// the ordinary case, so that was most of them.
export const watching = (thread: Thread): boolean => thread.id === state.activeId && document.hasFocus();

export function notify(thread: Thread, body: string): void {
  if (thread.automatic || typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  if (watching(thread)) return;
  // One at a time for a thread: the latest news replaces what it has not yet read
  const shown = new Notification(thread.title, { body, tag: thread.id });
  shown.addEventListener('click', () => {
    window.host.show();
    onTab.delete(thread.id);
    activate(thread);
    save();
    render();
  });
}

// What the app's icon last said (see showBadge), so that it is only told when
// the number changes. Null until it has been told anything, which is not the
// same as having told it none: a reload gives the page this state afresh while
// the icon keeps whatever it was last set to, so starting this at 0 made a
// count of 0 the one number that could never be sent, and a badge seen before
// a reload stayed on the icon with nothing left to clear it.
let badged: number | null = null;

// The app's icon carries the number of threads that need the user: a question
// waiting or a reply not yet read, which is what a notification is about. Not
// the app's own threads, whose work is none of the user's asking (see notify).
export function showBadge(): void {
  const count = state.threads.filter(
    (t) => (t.unread || approvalOf(t) !== undefined || questionOf(t) !== undefined) && !t.automatic
  ).length;
  if (count === badged) return;
  badged = count;
  window.host.badge(count);
}

// Coming back to the window is reading what is on screen. The active thread's
// news is marked unread while the user is away (see watching), and nothing
// else would take that mark off again: opening a thread clears it, and this
// one is open already.
window.addEventListener('focus', () => {
  const active = state.threads.find((thread) => thread.id === state.activeId);
  if (!active?.unread) return;
  delete active.unread;
  save();
  render();
});

export function fail(thread: Thread, message: Message, text: string): void {
  if (message.text) {
    // Keep the partial reply and report the failure after it
    thread.messages.splice(thread.messages.indexOf(message) + 1, 0, { role: 'error', text });
  } else {
    message.role = 'error';
    message.text = text;
  }
}

// What the reply says while its subagents work, and nothing once they are
// done: the words it writes then are its own.
export function sayWaiting(request: PendingRequest): void {
  const working = [...request.subagents.values()].filter((one) => one.finding === undefined).length;
  if (working > 0) request.message.status = waitingOn(working);
  else if (request.message.status?.startsWith('Waiting on')) delete request.message.status;
}

// Ends the bubble a reply was streaming into (dropping it if nothing
// arrived), puts a note in its place, and carries the reply on in a new bubble
// after the note. The reply may be in the middle of the thread, when an
// earlier message is being retried.
export function interject(thread: Thread, request: PendingRequest, note: Message): void {
  const bubble = request.message;
  delete bubble.streaming;
  bubble.text = bubble.text.trimEnd();
  const at = thread.messages.indexOf(bubble);
  request.message = { role: 'assistant', text: '', streaming: true };
  // What the reply is waiting on is still what it is waiting on
  if (bubble.status) request.message.status = bubble.status;
  // The step of a coding change it was made in, for drawMessages to group by
  if (request.phase !== undefined) note.phase = request.message.phase = request.phase;
  if (request.investigating) note.investigating = request.message.investigating = true;
  if (bubble.text) thread.messages.splice(at + 1, 0, note, request.message);
  else thread.messages.splice(at, 1, note, request.message);
}

// The note of what this request has used so far, after everything it has
// written. It is put there when the first count arrives and brought up to date
// by each one after, so it is already in place when the request ends. Notes
// the reply adds as it goes are put above its bubble, so this stays last.
export function noteUsage(thread: Thread, request: PendingRequest): void {
  // The passes that have finished, and what the one still being written has
  // used so far (see Live): without it the note stands still for as long as a
  // pass takes, which on a local model is most of the reply. Said as "so far"
  // and marked while any of it is estimated, so that a note the app goes down
  // on is still a true account of what it knew.
  const live = [...request.live.values()];
  const used = mergeUsage([...request.usage, ...live]);
  const estimated = live.some((one) => one.estimated);
  const text = `${live.length ? 'Tokens so far' : 'Tokens'}: ${about(usedLine(used), estimated)}`;
  // Each pass on its own, since the merged lines add up what every pass was
  // sent and so say nothing of how much context any one of them carried
  const passes = request.usage.map(({ purpose, model, input }) => ({ purpose, model, input }));
  if (request.tokens) {
    request.tokens.text = text;
    request.tokens.usage = used;
    request.tokens.passes = passes;
    return;
  }
  request.tokens = { role: 'note', text, usage: used, passes, thoughtId: crypto.randomUUID() };
  const at = thread.messages.indexOf(request.message);
  thread.messages.splice(at < 0 ? thread.messages.length : at + 1, 0, request.tokens);
}

window.llm.onEvent(handleEvent);

// Everything that happens while something is being written into a thread: a
// reply to the user's message, or a look at the workspace, which is put
// through here as well so that it is drawn, saved and read exactly as a reply
// is (see automaticThread).
export function handleEvent(requestId: string, event: HarnessEvent): void {
  const request = requests.get(requestId);
  if (!request) return;
  const { thread, message } = request;
  // What has arrived of a reply is kept even if the app goes down mid-reply.
  // Text arrives a few characters at a time, so it is saved on a timer; the
  // events a cut-off reply would be picked up from are each saved as they
  // happen (below), so that what the next launch can see is as near as it can
  // be to what really went on. (The end of a reply is saved at once, below.)
  saveSoon();

  if (event.type === 'step') return;

  // The harness is waiting to hear whether a model above the user's approval
  // level may be used, or the tool is waiting to hear that the model may read a
  // file on the user's computer or run a command there that could lose work.
  // The question is not awaited: events keep being handled.
  if (event.type === 'approval' || event.type === 'file_access' || event.type === 'command_access') {
    askApproval(request, event);
    // Whichever thread it is, since the sidebar says which one is waiting
    render();
    notify(thread, APPROVING);
    return;
  }

  // The model has put a question to the user, asked in the thread like the
  // approval above and not awaited either
  if (event.type === 'question') {
    askQuestion(request, event);
    render();
    notify(thread, shorten(event.question, NOTE_BODY));
    return;
  }

  // Which step of a coding change the reply has reached (see
  // harness/phases.ts). Shown where a reply with nothing written yet says what
  // it is doing, so it stands until that step writes something.
  if (event.type === 'phase') {
    // The finding-out step of a suggestion is said as an investigation's is: it
    // reads the code to work out how it stands, and the notes it adds are drawn
    // under that title (see harness/phases.ts SUGGESTION)
    const investigating = event.investigation === true || event.suggestion === true;
    message.status = phaseName(event.phase, investigating);
    // Kept so the notes the step adds can say which step made them (see
    // interject), and be drawn under it
    request.phase = event.phase;
    request.investigating = investigating;
    message.phase = event.phase;
    message.investigating = investigating;
    if (thread.id === state.activeId) render();
    return;
  }

  // The plan, which streamed into the reply as it was written and now becomes
  // its own thing: above the work it is a plan for, where it can still be read
  // once the work has buried it, and out of the reply, which holds the answer.
  if (event.type === 'plan') {
    if (!event.text) return;
    const at = thread.messages.indexOf(message);
    request.message = { role: 'assistant', text: '', streaming: true, status: message.status };
    const plan: Message = { role: 'plan', text: event.text, phase: message.phase };
    // Any pictures or clips the planning step took go on the plan, shown under it
    if (event.images?.length) plan.images = event.images;
    if (event.videos?.length) plan.videos = event.videos;
    thread.messages.splice(at, 1, plan, request.message);
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'queued') {
    // Whatever the bubble was saying is kept and put back when the turn comes:
    // a step of a coding change says which step it is, and waiting for a model
    // does not make that less true of it (see the 'phase' event)
    request.said = message.status;
    message.status = event.model ? waitingTurn(event.model) : WAITING;
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'waited') {
    // Its turn came: the model has it, and what it is doing is no longer
    // waiting. How long it waited is reported with the tokens the pass used
    // (see Latency), not here.
    if (request.said === undefined) delete message.status;
    else message.status = request.said;
    delete request.said;
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'shortening') {
    // As with condensing: the app's doing, said plainly. It only reaches a
    // thread when the thread is itself an agent (see harness/project.ts).
    if (message.text) interject(thread, request, { role: 'note', text: SHORTENING });
    else message.status = SHORTENING;
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'condensing') {
    // What the app is doing to make room, not something the model thought, so
    // it is said plainly rather than put behind a dropdown. A status shows
    // only while the reply has written nothing; once it has, the reply carries
    // on below this instead, so it is seen either way.
    if (message.text) {
      request.condensing = { role: 'note', text: CONDENSING };
      interject(thread, request, request.condensing);
    } else message.status = CONDENSING;
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'condensed') {
    // Over, so the notice of it happening gives way to a record that it did,
    // which stays in the log as a tool call or a thought does. Nothing to
    // record when nothing came of it.
    const note = request.condensing;
    delete request.condensing;
    if (note) {
      if (event.changed) note.text = CONDENSED;
      else thread.messages.splice(thread.messages.indexOf(note), 1);
    } else {
      if (message.status === CONDENSING) delete message.status;
      if (event.changed) interject(thread, request, { role: 'note', text: CONDENSED });
    }
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'classification') {
    // Any wait for the classifier's turn is over
    if (message.status) message.status = CLASSIFYING;
    if (event.failed) {
      // Kept for the note that names the model used instead
      request.unclassified = [['Reason', clip(event.reason)]];
      if (event.model) request.unclassified.push(['Classifier', event.model]);
      if (event.reply !== undefined) {
        request.unclassified.push(['Its reply', clip(event.reply) || 'Nothing.']);
      }
      return;
    }
    // Kept with the message, on disk at once, so that a reply the app closes
    // on is picked up with this rating rather than another (see resumeCutOff).
    // What it cost is counted already and has no use being kept.
    const { type: _type, usage: _usage, ...classification } = event;
    request.asked.classification = classification;
    // The work on review comments is the reviewers', each with a rating of its
    // own; what this reply does is sum up what they did, and rating that says
    // nothing about the message the user sent
    if (request.asked.review) {
      save();
      if (thread.id === state.activeId) render();
      return;
    }
    // Shown above the reply it applies to
    const note: Message = {
      role: 'note',
      text:
        `${CATEGORY_NAMES[event.category] ?? 'General'} · ` +
        `${event.sophistication}/5 Complexity · ${event.effort} effort`,
      // Which model made the call is there for whoever opens the note
      classifier: event.model,
      thoughtId: crypto.randomUUID(),
    };
    thread.messages.splice(thread.messages.indexOf(message), 0, note);
    request.note = note;
    // ...with the note, which a reply picked up goes on under (see reply)
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'model') {
    // A question still standing here is one whose time ran out: the harness has
    // gone on with the lesser model, so the card goes, unanswered. Redrawn
    // whichever thread it was asked in, the sidebar having said it was waiting.
    if (request.approval) {
      clearApproval(request);
      render();
    }
    request.asked.answeredBy = { provider: event.provider, model: event.model };
    // Classifying and routing are over; the reply itself comes next
    delete message.status;
    if (thread.id === state.activeId) render();
    // Which model summed the reviewers up is no more this thread's business
    // than how the message was rated (see the 'classification' event)
    if (request.asked.review) return;
    if (event.reason === 'picked') return; // the user chose it; nothing to report
    const served = `${event.name} (${event.sophistication}/5)`;
    if (request.note) {
      // Why it is not the model the rating asked for, where that is so. The
      // two reasons are not the same: nothing better exists, or something
      // better exists and was left alone on purpose (see RouteReason).
      const shortfall =
        event.reason === 'best_available'
          ? ', the best available'
          : event.reason === 'preferred'
            ? ', picked to stay off a busy queue'
            : event.reason === 'not_approved'
              ? ', the best allowed without approval'
              : '';
      request.note.served = `${served}${shortfall}`;
      // When the model is rejected for lack of approval, note that a lower model is being used.
      const suffix = ` · using a lower model: ${served}`;
      if (event.reason === 'not_approved' && !request.note.text.endsWith(suffix)) {
        request.note.text += suffix;
      }
    } else {
      // The classifier failed, so there is no note to add to
      const note: Message = { role: 'note', text: 'Not classified' };
      note.unclassified = { id: requestId, details: [...(request.unclassified ?? []), ['Answered by', served]] };
      thread.messages.splice(thread.messages.indexOf(message), 0, note);
    }
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'text') {
    // The reply has something to say, so its thinking is done with and folds
    // away; a thought after this one starts a run of its own
    if (!message.text) for (const old of request.thoughts) expanded.delete(old);
    message.text += event.delta;
    request.wrote = true;
    if (thread.id === state.activeId) drawText(message);
    return;
  }

  // The screenshots the reply took, shown under what it says. Not saved with
  // the thread (see save in threads.ts).
  if (event.type === 'images') {
    // Hung on the words they belong to rather than on the bubble in hand,
    // which by now is usually not the same message. The harness ends a reply
    // that changed files by squaring them with the workspace and reports that
    // as a tool call after the answer (see SYNC_TOOL in harness/index.ts);
    // that closes the bubble the answer was written into and opens an empty
    // one, and this event arrives after it. Put on that empty bubble the
    // screenshots went out with it when it was dropped (see the end of the
    // request below), so every coding reply's screenshots were thrown away —
    // the replies that take them most. The bubble in hand is the fallback, for
    // a reply that has not written its answer yet.
    const turn = thread.messages.includes(request.asked) ? turnOf(thread, request.asked) : [];
    const answer = turn.findLast((m) => m.role === 'assistant' && m.text) ?? message;
    answer.images = event.images;
    if (event.videos?.length) answer.videos = event.videos;
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'thought') {
    // Close the current bubble, show the thought, and continue in a new one.
    // Thoughts that arrive one after another are one dropdown, remembered by
    // the first of the run: a model that reasons at length would otherwise
    // leave a column of them to open one at a time. The newest run is open
    // while more may still come, and is folded away once the reply writes
    // anything (see the text event) or the request ends.
    // A run carries on only while the reply has written nothing since: once
    // it has, the thinking that follows is a run of its own
    const before = message.text ? undefined : thread.messages[thread.messages.indexOf(message) - 1];
    // ...and so does thinking in a different step of a coding change, which
    // is drawn under that step's own 'Work' dropdown
    const run = before?.role === 'thought' && before.phase === request.phase ? before.thoughtId : undefined;
    const thoughtId = run ?? crypto.randomUUID();
    if (!run) {
      for (const old of request.thoughts) expanded.delete(old);
      request.thoughts.push(thoughtId);
      expanded.add(thoughtId);
    }
    interject(thread, request, { role: 'thought', text: event.text, thoughtId });
    if (thread.id === state.activeId) render();
    return;
  }

  // A general chat has moved into a workspace. Only the thread changes here: the reply in flight keeps the
  // instructions and tools it began with, and the next message is sent from the workspace (see tools/workspaces.ts).
  if (event.type === 'workspace') {
    if (thread.workspace !== undefined) return;
    thread.workspace = event.workspace;
    const others = (state.recentWorkspaces ?? []).filter((f) => f !== event.workspace);
    state.recentWorkspaces = [event.workspace, ...others].slice(0, MAX_RECENT_WORKSPACES);
    // Its group is new, but a name that was used before may have been left collapsed
    state.collapsed = state.collapsed?.filter((group) => group !== event.workspace);
    window.threads.open(thread.id, event.workspace);
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  // The reply or a subagent has put the thread on a branch of its own (see tools/branches.ts). Only where the thread's
  // work goes changes: its container and the changes in it stay as they are, and the branch's worktree is what Apply
  // writes to and what a reply works from. The sidebar lists the thread under the branch from here, which the
  // re-render does.
  if (event.type === 'branch') {
    thread.branch = event.branch;
    // Its group is new to this thread, but a branch of that name may have been left collapsed by another
    if (thread.workspace) {
      const key = branchKey(thread.workspace, event.branch.name);
      state.collapsed = state.collapsed?.filter((group) => group !== key);
    }
    window.threads.open(thread.id, event.branch.worktree);
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'tool_call' && event.name === 'reply_to_comment') {
    // The assistant's answer to a review comment goes under the comment, not
    // in the thread as a tool it used
    postReply(thread, event.input);
    return;
  }

  if (event.type === 'tool_call') {
    runningCalls.set(event.id, event.name);
    request.calls.push(event.id);
    // Close the current bubble, note the tool, and continue in a new bubble
    interject(thread, request, {
      role: 'tool',
      text: `Used ${event.name}`,
      tool: event.name,
      callId: event.id,
      input: clip(event.input === null ? 'The input was not valid JSON.' : JSON.stringify(event.input, null, 2)),
      inputSummary: summarizeInput(event.input),
    });
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'tool_result') {
    runningCalls.delete(event.id);
    const note = thread.messages.find((m) => m.callId === event.id);
    if (note && event.isError) {
      note.text += ' (failed)';
      note.failure = clip(event.output);
      delete note.inputSummary;
    } else if (note) {
      // A written or edited file reports what changed: kept whole, to be
      // shown as a diff, where any other output is kept only in brief
      const [first, ...rest] = event.output.split('\n\n');
      const diff = ['write_file', 'edit_file'].includes(toolOf(note)) ? rest.join('\n\n') : '';
      note.output = summarizeOutput(diff ? first : event.output);
      if (diff) note.diff = clip(diff);
      if (event.images?.length) note.images = event.images;
      delete note.input;
    }
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'subagent') {
    // Its own dropdown in the thread, open while it works, and the reply
    // carries on in a new bubble below it
    const note: Message = {
      role: 'subagent',
      text: event.name,
      task: event.task,
      kind: event.kind,
      // How hard the piece was reckoned to be and what is doing it, which is
      // what a thread is told about its own reply (see the 'model' event)
      complexity: event.complexity,
      effort: event.effort,
      served: event.model,
      events: [],
      thoughtId: event.id,
    };
    expanded.add(event.id);
    startedAgents.set(note, Date.now());
    clock(Date.now());
    request.thoughts.push(event.id);
    request.subagents.set(event.id, note);
    interject(thread, request, note);
    // The reply can write nothing until they are done, so it says what it is
    // waiting for rather than pulsing as though words were on their way
    sayWaiting(request);
    save();
    if (changesThread === thread && !drafting) drawChanges(thread);
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'subagent_update' || event.type === 'subagent_done') {
    const note = request.subagents.get(event.id);
    // A subagent from a reply this window never saw the start of
    if (!note) return;
    if (event.type === 'subagent_update') {
      note.events?.push(event.event);
      // How far along it says it is, kept on the subagent itself rather than
      // among its work: it is the state of the ring on its tab, and each
      // estimate replaces the one before (see drawTabs)
      if (event.event.type === 'progress') note.progress = event.event.percent;
      // ...and whether it is waiting its turn at the model, which its row says
      // in the thread as its work says it in its own tab (see appendEvent)
      if (event.event.type === 'queued') note.waiting = event.event.model;
      if (event.event.type === 'waited') delete note.waiting;
    } else {
      note.finding = event.text;
      note.failed = event.isError;
      // Its last call is over, so whatever it was reckoned to be using goes
      // with it: a subagent that ended without its usage being counted would
      // otherwise leave the guess standing in the thread's total (see Live)
      request.live.delete(event.id);
      // Its report ran past what there was room for and lost its end
      note.cut = event.cut;
      delete note.progress;
      delete note.waiting;
      // One fewer to wait for; the last of them hands the reply back its words
      sayWaiting(request);
      save();
    }
    // The review, if it is open, shows how far each reviewer has got
    if (changesThread === thread && !drafting) drawChanges(thread);
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'rate_limited') {
    // Said in the thread rather than passed over: a reply that sits there for
    // half a minute should say why it is sitting there
    const seconds = Math.max(1, Math.round(event.after / 1000));
    interject(thread, request, {
      role: 'note',
      text:
        `${event.unreachable ? 'Could not reach the provider' : 'Rate limited by the provider'}; ` +
        `trying again in ${seconds} second${seconds === 1 ? '' : 's'} ` +
        `(attempt ${event.attempt + 1} of ${event.of})`,
      blurb: event.message,
      thoughtId: crypto.randomUUID(),
    });
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'fell_back') {
    // Said in the thread so that a reply that has changed model says why
    interject(thread, request, {
      role: 'note',
      text: `Out of credit on ${event.from}; continuing on ${event.to}.`,
      thoughtId: crypto.randomUUID(),
    });
    save();
    if (thread.id === state.activeId) render();
    return;
  }

  // What the call in flight has used so far. It replaces whatever the last one
  // said rather than adding to it, and goes nowhere near the thread's totals
  // or the day's: a count that is still climbing is not a record of anything
  // (see Live). The call's own usage event, below, is what gets recorded.
  if (event.type === 'tokens') {
    const { type: _type, subagent, ...usage } = event;
    request.live.set(subagent ?? '', usage);
    noteUsage(thread, request);
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'usage') {
    const { type: _type, subagent, ...usage } = event;
    // The counted article in place of the guess: the call is over, so what it
    // used is known and what it was reckoned to be using is of no more use
    request.live.delete(subagent ?? '');
    request.usage.push(usage);
    const agent = subagent ? request.subagents.get(subagent) : undefined;
    recordUsage(thread, usage, agent?.kind);
    noteUsage(thread, request);
    // A subagent's own call is kept on the subagent as well, for its tab
    if (agent) agent.usage = mergeUsage([...(agent.usage ?? []), usage]);
    // One of these arrives after every pass of a reply, so the request's note
    // and the thread's running total climb while the work is happening
    if (thread.id === state.activeId) render();
    return;
  }

  if (event.type === 'progress') {
    // Only a thread that is itself an agent sends these — the head explorer —
    // and the thread's own tab has no ring to put it on, so it is noted and
    // not drawn. Taken rather than ignored so that it never reaches the code
    // below, which is for the event that ends a request.
    request.progress = event.percent;
    return;
  }

  // The request is over
  // What went wrong, for the notification
  let failure: string | undefined;
  const failed = (text: string): void => {
    failure = text;
    fail(thread, message, text);
  };
  if (event.type === 'error') {
    failed(event.message);
  } else if (event.stopReason === 'refusal') {
    failed('The model declined to respond.');
  } else if (event.stopReason === 'max_steps') {
    failed('Stopped: the model kept calling tools without answering.');
  } else if (!message.text) {
    // The bubble the reply was streaming into is empty, which is not the same
    // as the reply having written nothing. Everything that interjects — a
    // tool, a thought, a note — closes the bubble in hand and opens a fresh
    // one for the reply to carry on in, and a reply that had already said its
    // last word carries on into nothing. The harness ends a reply that changed
    // files by squaring them with the workspace, and reports that as a tool
    // call after the answer (see SYNC_TOOL in harness/index.ts), so every
    // coding reply in a workspace ended with the answer it had just written
    // replaced by a message saying it had written none.
    //
    // So the empty bubble goes either way, and what decides whether anything
    // is said in its place is whether the reply wrote anywhere at all.
    //
    // A reply that truly ran to its end with nothing for the user is said
    // rather than dropped: the harness asks a model that answers only in its
    // reasoning for the answer itself, and takes the reasoning for one failing
    // that, so there was never anything to show. And a turn that leaves no
    // trace at all is a turn the next message cannot tell was ever answered,
    // and so asks for again (see conversation).
    if (!request.wrote && event.stopReason !== 'cancelled' && !thread.automatic) {
      failed(NOTHING_WRITTEN);
    }
    // Answered and then interjected on, cancelled before anything arrived, or
    // one of the app's own looks, which writes what it finds to the project's
    // note rather than to the thread: nothing to keep in the bubble, and
    // nothing to report either.
    else thread.messages = thread.messages.filter((m) => m !== message);
  }

  // What the reply ended on is what later requests are told it said
  markFinal(thread, request.asked);

  // The reply is what matters now, so its thoughts are folded away
  for (const thoughtId of request.thoughts) expanded.delete(thoughtId);
  // A tool that was cut short is no longer running
  for (const callId of request.calls) runningCalls.delete(callId);
  delete message.streaming;
  delete message.status;
  requests.delete(requestId);
  inflight.delete(thread.id);
  // However it went, this reply is no longer on its way: only one the app
  // closes on is picked up again, and this one reached an end of its own
  // (see resumeCutOff)
  delete request.asked.pending;
  // Finished out of sight: flagged in the sidebar until the thread is read,
  // which is opening it, or coming back to the window it is already open in
  // (see watching and the focus listener below)
  if (!watching(thread)) thread.unread = true;
  touch(thread);
  save();
  render();
  // A reply the user stopped is news to nobody
  if (event.type === 'error' || event.stopReason !== 'cancelled') {
    notify(thread, failure ? `Failed: ${shorten(failure, NOTE_BODY)}` : 'Finished replying');
  }
  // Nothing of this is a conversation the app's own thread should be named
  // after, and it changes no files in any container
  if (thread.automatic) return;
  // Now that the model is free again, the thread's title can catch up
  describeThread(thread);
  // ...and the box can offer what to say to it, if the reply got as far as an answer
  if (!failure && event.type !== 'error' && event.stopReason !== 'cancelled') void suggestReply(thread);
  // The reply may have changed files, which then wait to be written back
  if (!thread.workspace) return;
  // Reviewing needs the count to be current, so it waits for it
  const replied = event.type !== 'error' && event.stopReason !== 'cancelled';
  void countChanges(thread).then(() => {
    if (replied) autoVerify(thread);
  });
}

// What a reviewer said to one of the user's comments, put under that comment
export function postReply(thread: Thread, input: Record<string, unknown> | null): void {
  const comment = thread.review?.find((c) => c.id === input?.comment_id);
  if (!comment || typeof input?.reply !== 'string') return;
  comment.entries.push({ from: 'assistant', text: input.reply });
  save();
  if (changesThread === thread) drawChanges(thread);
}

// The tool a 'tool' note is about. Notes saved by an earlier version have
// only their text, "Used read_file", to tell by.
// A function declaration, since the first render runs before this line.
