import type { Message, ModelTotal, Phase, Thread, ToolVideo } from './types.js';
import type { Section } from './tool-calls.js';
import { callDetails, dropdown, toolOf, waitingDots } from './tool-calls.js';
import { openMessageMenu } from './message-menu.js';
import { agentMessages, drawTabs, openAgentTab, shownAgent } from './agent-tabs.js';
import { renderMarkdown } from './markdown.js';
import { showSuggestion } from './suggestion.js';
import {
  APP_NAME,
  PURPOSES,
  agentView,
  atEnd,
  composer,
  drawnThread,
  inflight,
  messagesEl,
  requests,
  sendButton,
  setDrawnThread,
  setToTheEnd,
  threadChanges,
  threadList,
  threadTitle,
  threadUsage,
  threadUsageModels,
  threadUsageSummary,
  threadWorkspace,
  toTheEnd,
} from './shared.js';
import {
  about,
  addTotal,
  clock,
  drawMonthCost,
  money,
  tokenCount,
  took,
  usageLine,
  usedLine,
  waitRow,
  waitsOf,
} from './usage.js';
import { contextLines, showBadge } from './events.js';
import { askedOf, feedbackButtons } from './rename-feedback.js';
import { LEFT_ALONE, continueReply, phaseName, phaseNameDone } from './reply.js';
import { activeThread, saveSoon } from './threads.js';
import {
  archiveStale,
  archivedNote,
  automaticRows,
  groupHeading,
  isCollapsed,
  threadGroups,
  threadsRows,
  workspaceName,
} from './sidebar.js';
import { watchedSubagent } from './thread-dialog.js';
import { openChanges } from './changes.js';
import { approvalCard, approvalOf, reviewCard, reviewable } from './approvals.js';
import { questionCard, questionOf } from './questions.js';
import { holdSelection, syncQuote } from './quote.js';

// Draws a list of messages into an element: the thread's own, or one made from
// what a subagent did (see agentMessages). Returns the bubble a reply is
// streaming into, if one of them is.
//
// Everything a message can be is here, so a subagent's work reads exactly as
// the thread's does: thoughts, tool calls with what they returned, and the
// words themselves.
// The element a recorded clip is shown in, made once for each clip and kept.
// The thread is redrawn whole on every render (see the replaceChildren below),
// and a <video> built afresh each time would start the clip over, and decode
// it again, every time anything in the thread changed.
const players = new WeakMap<ToolVideo, HTMLVideoElement>();

// A blob where the window will make one, which keeps megabytes of base64 out
// of the DOM; the data URL it came as where it will not (jsdom, in the tests).
// Both are allowed to play by the page's policy (see the CSP in index.html).
function sourceOf(video: ToolVideo): string {
  try {
    const bytes = Uint8Array.from(atob(video.data), (char) => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: video.mediaType }));
  } catch {
    return `data:${video.mediaType};base64,${video.data}`;
  }
}

function player(video: ToolVideo): HTMLVideoElement {
  const made = players.get(video);
  if (made) return made;
  const el = document.createElement('video');
  el.className = 'tool-video';
  el.controls = true;
  el.loop = true;
  // A clip is recorded with no sound, and a silent one is allowed to start on
  // its own: a short recording of something moving reads as a picture that
  // moves, which is the point of it, rather than something to be pressed first
  el.muted = true;
  el.autoplay = true;
  el.src = sourceOf(video);
  players.set(video, el);
  return el;
}

// The screenshots and clips a message carries, under its text
function appendMedia(into: HTMLElement, m: Message): void {
  // The screenshots the reply took, under what it says of them. Shown
  // even where it said nothing of them: a picture with no words beats the
  // words with no picture, which is what dropping them left (see the
  // 'images' event in events.ts).
  for (const image of m.images ?? []) {
    const img = document.createElement('img');
    img.className = 'tool-image';
    img.src = `data:${image.mediaType};base64,${image.data}`;
    img.alt = 'Screenshot';
    into.append(img);
  }
  // ...and the clips it recorded, under those
  for (const video of m.videos ?? []) into.append(player(video));
}

export function drawMessages(
  into: HTMLElement,
  thread: Thread | undefined,
  messages: Message[],
  empty: string
): HTMLElement | undefined {
  let streaming: HTMLElement | undefined;
  if (messages.length === 0) {
    const nothing = document.createElement('div');
    nothing.className = 'empty';
    nothing.textContent = empty;
    into.replaceChildren(nothing);
    return undefined;
  }

  // Calls to the same tool, one straight after another, are shown as one entry
  const entries: Message[][] = [];
  for (const m of messages) {
    const last = entries.at(-1);
    const sameTool = m.callId !== undefined && last?.[0].callId !== undefined && toolOf(last[0]) === toolOf(m);
    // ...and thoughts that arrived one after another
    const sameRun = m.role === 'thought' && last?.[0].role === 'thought';
    const together = sameTool || sameRun;
    if (together) last.push(m);
    else entries.push([m]);
  }
  // The streaming bubble that has nothing in it yet, if there is one
  let bare: HTMLElement | undefined;
  const drawEntry = (entry: Message[]): HTMLElement => {
    const [m] = entry;
    const div = document.createElement('div');
    div.className = `message ${m.role}`;
    // Named so that its row in the sidebar can scroll to it
    if (m.role === 'subagent') div.dataset.subagent = m.thoughtId ?? m.text;
    // ...and a request says where in the thread it is, so a search hit can
    // put the user back at the message they were looking for (see goToRequest)
    if (m.role === 'user') div.dataset.at = String(messages.indexOf(m));
    // The app's own asking, which is nobody's message to answer for
    div.classList.toggle('system', Boolean(m.fromApp));
    // Only the thread's own messages can be deleted or retried; the ones a
    // subagent's work is drawn from are not in any thread
    if (thread) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMessageMenu(thread, m, e.clientX, e.clientY, entry);
      });
    }
    if (m.streaming) streaming = div;
    if (m.role === 'user' && m.carries?.length) {
      // What the user did, not the prose the model was sent: a line per
      // comment, each opening the reviewer that is dealing with it
      for (const comment of m.carries) {
        const where = `${comment.path}${comment.line === null ? '' : `, line ${comment.line}`}`;
        const open = document.createElement('button');
        open.className = 'open';
        open.textContent = `Left a comment on ${where}`;
        const reviewer = messages.find(
          (one) => one.role === 'subagent' && one.kind === 'reviewer' && one.text === comment.id
        );
        open.title = reviewer ? 'Open the reviewer dealing with it' : 'Nobody has taken this up yet';
        open.disabled = !reviewer;
        if (reviewer && thread) open.addEventListener('click', () => openAgentTab(thread, reviewer));
        div.append(open);
      }
      // ...and the review itself, where the comments sit on the lines they are
      // about and each shows how far its reviewer has got
      if (thread?.workspace) {
        const review = document.createElement('button');
        review.className = 'open-review';
        review.textContent = 'Open the review';
        review.title = 'See the comments on the changes, and how the reviewers are getting on with them';
        review.addEventListener('click', () => openChanges(thread));
        div.append(review);
      }
    } else if (m.callId !== undefined) {
      div.append(callDetails(entry));
    } else if (m.role === 'thought') {
      // One dropdown for the whole run, open while the model is still
      // thinking and collapsed once it has something to say
      const label = entry.length > 1 ? `${entry.length} thoughts` : 'Thought';
      div.append(
        dropdown(
          m.thoughtId ?? m.text,
          label,
          entry.map((one): Section => ['', one.text])
        )
      );
    } else if (m.role === 'plan') {
      // What it said it was going to change, written before it changed
      // anything (see harness/phases.ts). Left open rather than folded into
      // a dropdown: it is the one part of a coding reply the user is there
      // to read while there is still time to stop the work.
      const caption = document.createElement('div');
      caption.className = 'caption';
      caption.textContent = 'Plan';
      div.classList.add('markdown');
      div.append(caption, renderMarkdown(m.text.trim()));
      appendMedia(div, m);
    } else if (m.role === 'subagent') {
      // A line that opens the subagent itself, rather than a dropdown of
      // its work in the middle of the reply: what it did is a view of its
      // own, and reads better as one (see openSubagentDialog)
      const working = m.finding === undefined;
      // Named by what it is: a reviewer answering a comment reads very
      // differently from a worker looking into a corner of the project
      const what = m.kind === 'reviewer' ? 'Reviewer' : 'Subagent';
      // Waiting its turn counts as working, but it is worth saying which:
      // several subagents handed out at once take the model in turn, so the
      // ones that are not writing are waiting rather than stuck (see
      // llm/cachelock.ts)
      const doing = m.waiting ? ` — waiting its turn for ${m.waiting}…` : ' — working…';
      const open = document.createElement('button');
      open.className = 'open';
      open.textContent = `${what}: ${m.text}${working ? doing : m.failed ? ' — did not finish' : ''}`;
      open.title = 'Open what this subagent is doing';
      if (thread) open.addEventListener('click', () => openAgentTab(thread, m));
      div.append(open);
    } else if (m.usage) {
      const lines: Section[] = m.usage.map((u): Section => [
        `${PURPOSES[u.purpose]} · ${u.model}`,
        about(usedLine([u]), !!u.estimated),
      ]);
      if (m.passes?.length) lines.push(['Context sent with each request', contextLines(m.passes)]);
      div.classList.add('usage');
      div.append(dropdown(m.thoughtId ?? 'usage', m.text, lines));
    } else if (m.summary !== undefined) {
      div.classList.add('summary');
      div.append(dropdown(m.thoughtId ?? 'summary', m.text, [['', m.summary]]));
    } else if (m.blurb !== undefined) {
      div.classList.add('summary');
      div.append(dropdown(m.thoughtId ?? 'blurb', m.text, [['', m.blurb]]));
    } else if (m.classifier) {
      const classifierDetails = dropdown(m.thoughtId ?? 'classifier', m.text, [
        ['Classified by', m.classifier],
        ['Answered by', m.served],
      ]);
      // The thumbs go on the summary line, beside the classification itself,
      // so they show without the dropdown being opened
      if (thread && askedOf(thread, m)?.classification) {
        classifierDetails.querySelector('summary')?.append(feedbackButtons(thread, m));
      }
      div.append(classifierDetails);
    } else if (m.unclassified) {
      div.append(dropdown(m.unclassified.id, m.text, m.unclassified.details));
    } else if (!m.text && m.status && !m.images?.length && !m.videos?.length) {
      // Not a reply yet, so it is shown as a note rather than a bubble
      div.className = 'message note';
      div.textContent = m.status;
    } else if (m.role === 'assistant' && (m.text || m.images?.length || m.videos?.length)) {
      div.classList.add('markdown');
      // Replies saved by an earlier version may still carry result tags
      if (m.text) div.append(renderMarkdown(m.text.replace(/<\/?result>/g, '').trim()));
      appendMedia(div, m);
    } else if (m.streaming && !m.text) {
      // Nothing of the reply has arrived yet: drawn below as a 'Working…'
      // dropdown in the bubble's place
      bare = div;
    } else {
      if (m.label) {
        const caption = document.createElement('div');
        caption.className = 'caption';
        caption.textContent = m.label;
        div.append(caption);
      }
      div.append(document.createTextNode(m.text || '…'));
      if (m.since !== undefined) div.append(' · ', clock(m.since));
      // A reply the app closed on twice is left alone; this picks it up anyway
      if (thread && m.role === 'error' && m.text === LEFT_ALONE) {
        const carryOn = document.createElement('button');
        carryOn.className = 'continue';
        carryOn.textContent = 'Continue';
        carryOn.title = 'Pick the reply up from where it stopped';
        // Nothing in a thread can be changed while a reply is being written to it
        carryOn.disabled = inflight.has(thread.id);
        carryOn.addEventListener('click', () => continueReply(thread, m));
        div.append(carryOn);
      }
    }
    return div;
  };

  // The work that went into a reply — its thoughts and the tool calls that
  // only looked — is folded into one 'Work' dropdown per step, so the thread
  // reads as what was asked, what was changed and what was said. Grouped here
  // and nowhere else: the messages themselves stay as they are saved.
  const isWork = ([m]: Message[]): boolean =>
    m.role === 'thought' || (m.callId !== undefined && toolOf(m) !== 'write_file' && toolOf(m) !== 'edit_file');
  // What the thread shows on its own line, whichever step it came from
  const isEvent = ([m]: Message[]): boolean =>
    m.role === 'subagent' || (m.callId !== undefined && (toolOf(m) === 'write_file' || toolOf(m) === 'edit_file'));
  const drawn: HTMLElement[] = [];
  let block: Message[][] = [];

  // A step of a coding change (see harness/phases.ts) is one dropdown named for
  // it, at the top of its section, holding everything the step did in order —
  // edits and subagents among it, as plain lines in another colour. The edits,
  // subagents, plan and words of the step are drawn again below the dropdown
  // as they would be anywhere else, so it never breaks up around them. Named
  // for what it is doing while the step is on, and for what it did after.
  type Step = { phase: Phase; investigating?: boolean; inside: Message[][]; below: HTMLElement[]; live?: Message };
  let step: Step | undefined;
  // An edit or a subagent as a line in the dropdown rather than a dropdown of
  // its own
  const inline = (entry: Message[]): HTMLElement => {
    const div = drawEntry(entry);
    div.classList.add('event');
    const details = div.querySelector(':scope > details');
    if (details) div.replaceChildren(details.querySelector('summary')?.textContent ?? '');
    return div;
  };
  const endStep = (): void => {
    if (!step) return;
    const { phase, investigating, inside, below, live } = step;
    const work = document.createElement('div');
    work.className = 'message work step';
    // A wait for a model's turn or for subagents is said in the step's place
    const said = live?.status && live.status !== phaseName(phase, investigating) ? live.status : undefined;
    const name = live ? (said ?? phaseName(phase, investigating)) : phaseNameDone(phase, investigating);
    if (inside.length) {
      const [[first]] = inside;
      // Shut until the user opens it: nothing adds its key to `expanded`
      const details = dropdown(`step:${phase}:${first.callId ?? first.thoughtId}`, name, []);
      details.append(...inside.map((entry) => (isEvent(entry) ? inline(entry) : drawEntry(entry))));
      work.append(details);
    } else {
      const line = document.createElement('div');
      line.className = 'step-name';
      line.textContent = name;
      work.append(line);
    }
    if (live) {
      work.classList.add('working');
      const title = work.querySelector(':scope > details > summary, :scope > .step-name');
      if (title && !said) title.append(waitingDots());
      streaming = work;
    }
    drawn.push(work, ...below);
    step = undefined;
  };
  const endBlock = (): void => {
    if (!block.length) return;
    const [[first]] = block;
    const work = document.createElement('div');
    work.className = 'message work';
    // Shut until the user opens it: nothing adds its key to `expanded`
    const details = dropdown(`work::${first.callId ?? first.thoughtId}`, 'Work', []);
    details.append(...block.map(drawEntry));
    work.append(details);
    drawn.push(work);
    block = [];
  };
  for (const entry of entries) {
    const [m] = entry;
    const { phase, investigating } = m;
    // A reply a step of a coding change is waiting to write, or the plan it
    // wrote, or what it did, belongs to that step's section
    const lone = m.streaming && !m.text && phase !== undefined;
    if (phase !== undefined && (lone || m.role === 'plan' || isWork(entry) || isEvent(entry))) {
      endBlock();
      if (step?.phase !== phase) {
        endStep();
        step = { phase, investigating, inside: [], below: [] };
      }
      if (lone) step.live = m;
      else if (m.role === 'plan') step.below.push(drawEntry(entry));
      else {
        step.inside.push(entry);
        if (isEvent(entry)) step.below.push(drawEntry(entry));
      }
      continue;
    }
    // Everything else in a step's section goes below its dropdown, up to the
    // message that starts the next request
    if (step && m.role !== 'user') {
      step.below.push(drawEntry(entry));
      continue;
    }
    endStep();
    if (!isWork(entry)) {
      endBlock();
      drawn.push(drawEntry(entry));
      continue;
    }
    block.push(entry);
  }
  endBlock();
  endStep();
  // The empty bubble becomes the Work dropdown of the step in progress, headed
  // 'Working…' with the dots after it: the one just before it if there is one,
  // and a new one if the reply has not done any work yet
  const at = bare ? drawn.indexOf(bare) : -1;
  if (bare && at >= 0) {
    drawn.splice(at, 1);
    const before = drawn[at - 1];
    let work: HTMLElement;
    if (before?.matches('div.message.work:not(.step)')) {
      work = before;
    } else {
      work = document.createElement('div');
      work.className = 'message work';
      work.append(dropdown('work::working', 'Work', []));
      drawn.splice(at, 0, work);
    }
    work.classList.add('working');
    work.querySelector(':scope > details > summary')?.replaceChildren('Working…', waitingDots());
    streaming = work;
  }
  into.replaceChildren(...drawn);
  return streaming;
}

export function render(): void {
  const active = activeThread();
  // The bubble a reply is streaming into, if one is on screen
  let streaming: HTMLElement | undefined;
  // Measured before the thread is redrawn, since redrawing it is what moves
  // the scroll out from under the answer (see FOLLOWING). Of whichever pane is
  // showing, as it was left by the last render: the other one is not on screen
  // and has no scroll of its own to speak of, and reading both would have the
  // hidden one — with no height at all — answer for the one being read.
  const reading = agentView.hidden ? messagesEl : agentView;
  const following = toTheEnd || drawnThread !== active?.id || atEnd(reading);
  setToTheEnd(false);
  setDrawnThread(active?.id ?? null);

  if (archiveStale()) saveSoon();
  showBadge();
  threadList.replaceChildren(
    ...threadGroups().flatMap(({ workspace, threads }) => [
      groupHeading(workspace, threads),
      // The threads the app started for itself come first, behind an arrow of
      // their own: they are the workspace's work rather than the user's, and
      // what they wrote is already in the workspace's notes.
      ...(workspace && !isCollapsed(workspace) ? automaticRows(workspace) : []),
      // ...and under each thread, the subagents it set to work, behind an
      // arrow of their own in the same way
      ...(isCollapsed(workspace) ? [] : [...threadsRows(workspace, threads), ...archivedNote(workspace)]),
    ])
  );

  drawMonthCost();
  threadTitle.textContent = active.title;
  // The window names the app, and the project when the thread has one
  document.title = active?.workspace ? `${APP_NAME} — ${workspaceName(active.workspace)}` : APP_NAME;
  // Just the workspace's own name; the full path is in the tooltip
  threadWorkspace.textContent = active.workspace ? workspaceName(active.workspace) : '';
  threadWorkspace.title = active.workspace ?? '';
  // What the thread has changed in its copy of the workspace, to look over and
  // write back; not while it may still be changing things
  const changed = active.changes ?? 0;
  threadChanges.hidden = !active.workspace;
  threadChanges.textContent = changed ? `Changes (${changed})` : 'Changes';
  threadChanges.disabled = inflight.has(active.id);
  threadChanges.title = inflight.has(active.id)
    ? 'Wait for the reply to finish'
    : 'See what this thread changed, and write it to the workspace';

  // ...and, from the moment a message is sent, how long this reply has been
  // going: classification is the first thing it spends time on, and nothing
  // has been used yet to show for it
  const running = requests.get(inflight.get(active.id) ?? '');
  // The thread's running total, opening to show it model by model, with what
  // the calls now in flight have used so far counted in: a pass on a local
  // model is most of a reply, and a total that only moves when one ends looks
  // stuck for as long as the user is actually waiting (see Live).
  //
  // Added to a copy, and never to the thread's own totals or the day's: the
  // count is still climbing, the figures may be nobody's but ours, and the
  // call's usage event is what gets recorded when it ends.
  const shown: Record<string, ModelTotal> = {};
  for (const total of Object.values(active.usage ?? {})) {
    shown[`${total.provider}/${total.model}`] = { ...total, ...(total.waits ? { waits: { ...total.waits } } : {}) };
  }
  // Which of the models' figures an estimate has gone into, so that they are
  // marked and the counted ones are not (see about)
  const reckoned = new Set<string>();
  for (const used of running?.live.values() ?? []) {
    addTotal(shown, used);
    if (used.estimated) reckoned.add(`${used.provider}/${used.model}`);
  }
  const totals = Object.values(shown).sort((a, b) => b.cost - a.cost);
  threadUsage.hidden = totals.length === 0 && !running;
  const all = totals.reduce((n, t) => n + t.input + t.output, 0);
  const spent = totals.reduce((n, t) => n + t.cost, 0);
  // ...and how long they have been at it, where any call was timed: what a
  // thread costs and what it makes somebody sit through are the two things
  // worth knowing about a model as it works, so they are shown together
  const waits = waitsOf(totals);
  const said = totals.length
    ? [
        about(`${tokenCount(all)} tokens`, reckoned.size > 0),
        about(
          money(
            spent,
            totals.some((t) => t.unpriced)
          ),
          reckoned.size > 0
        ),
        waits && took(waits),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  threadUsageSummary.replaceChildren(said, ...(running ? [...(said ? [' · '] : []), clock(running.startedAt)] : []));
  threadUsageModels.replaceChildren(
    ...totals.map((total) => {
      const row = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = total.model;
      const used = document.createElement('small');
      // What this one model used, and how long its own calls took: per model
      // rather than only in the total, since a thread that uses a local model
      // for its small work and a hosted one for the rest has two quite
      // different answers and nothing useful in the two added together
      used.textContent = [
        about(usageLine([total]), reckoned.has(`${total.provider}/${total.model}`)),
        total.waits && took(total.waits),
      ]
        .filter(Boolean)
        .join(' · ');
      row.append(name, used);
      return row;
    }),
    // The waiting in full, under a rule: it is about all of them together, and
    // reads as one of the models if it is left looking like one
    ...(waits ? [waitRow(waits)] : [])
  );
  sendButton.textContent = inflight.has(active.id) ? 'Stop' : 'Send';

  // The thread, or one of its subagents when a tab of its own is showing
  drawTabs(active);
  const agent = shownAgent(active);
  messagesEl.hidden = !!agent;
  agentView.hidden = !agent;
  // There is nobody to write to in either of these. A subagent is not in a
  // conversation: it was handed one piece of work and it reports back to
  // whoever handed it over, not to the window. A thread the app started for
  // itself is the same — it is doing a job it was given. A box that takes
  // what is typed and has nowhere to send it is worse than no box.
  composer.hidden = Boolean(agent) || Boolean(active.automatic);
  showSuggestion();
  if (agent) {
    drawMessages(
      agentView,
      active,
      agentMessages(watchedSubagent(active, agent)),
      'This subagent has said nothing yet.'
    );
    if (following) agentView.scrollTop = agentView.scrollHeight;
  } else {
    holdSelection();
    streaming = drawMessages(messagesEl, active, active.messages, 'Send a message to start the conversation.');
    // The question waits at the end, where the user's eye is, with the reply it holds up above it
    const asking = approvalOf(active);
    if (asking) {
      messagesEl.querySelector(':scope > .empty')?.remove();
      streaming = messagesEl.appendChild(approvalCard(inflight.get(active.id) as string, asking));
    }
    const questioned = questionOf(active);
    if (questioned) {
      messagesEl.querySelector(':scope > .empty')?.remove();
      streaming = messagesEl.appendChild(questionCard(inflight.get(active.id) as string, questioned));
    }
    // The offer to check what the last reply changed
    const toReview = reviewable(active);
    if (toReview) messagesEl.appendChild(reviewCard(active, toReview));
  }
  syncQuote();
  // Follow the reply as it arrives: usually at the end of the thread, but
  // further up when an earlier message is being retried. Only for a user who
  // was reading the end of it — one who has scrolled up stays where they put
  // themselves until they come back down.
  if (!following) return;
  if (streaming && streaming !== messagesEl.lastElementChild) {
    streaming.scrollIntoView?.({ block: 'nearest' });
  } else {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// The new-thread pop-up: start in a recently used workspace, browse for another,
// or start a general chat, which has no workspace and so no files or search
