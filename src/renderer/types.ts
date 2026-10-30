// The renderer's own types: messages, threads, the saved state and what a
// request in flight carries. Also re-exports the shared types from ../types
// that the renderer modules use, so they can all import from './types.js'.

import type {
  ModelInfo,
  ProviderStatus,
  PublicSettings,
  SettingsPatch,
  OllamaStatus,
  SuggestedModel,
  SetupStatus,
  SetupProgress,
  Installable,
  ModelUsage,
  Latency,
  FileChange,
  BranchStatus,
  AgentEvent,
  Resumed,
  Classification,
  ClassificationProblem,
  ThreadPiece,
  ThreadHit,
  WorkspaceDetails,
  WorkspaceNote,
  FileAccessAnswer,
  HarnessEvent,
  PlanMode,
  Phase,
  ToolImage,
  ToolVideo,
} from '../types.js';

export type {
  ModelInfo,
  ProviderStatus,
  PublicSettings,
  SettingsPatch,
  OllamaStatus,
  SuggestedModel,
  SetupStatus,
  SetupProgress,
  Installable,
  ModelUsage,
  Latency,
  FileChange,
  BranchStatus,
  AgentEvent,
  Resumed,
  Classification,
  ClassificationProblem,
  ThreadPiece,
  ThreadHit,
  WorkspaceDetails,
  WorkspaceNote,
  FileAccessAnswer,
  HarnessEvent,
  PlanMode,
  Phase,
  ToolImage,
  ToolVideo,
};

export interface Message {
  // 'assistant' holds a reply's results. 'thought', 'error', 'note', 'plan',
  // 'tool' and 'subagent' are shown in the thread but never sent to a model.
  role: 'user' | 'assistant' | 'thought' | 'error' | 'note' | 'plan' | 'tool' | 'subagent';
  text: string;
  // On a note, the plan, or a reply still to write: the step of a coding change
  // it was made in (see harness/phases.ts), which the thread is drawn in
  // sections by
  phase?: Phase;
  // The explore step was an investigation's, so its title differs
  investigating?: boolean;
  streaming?: boolean;
  // On an 'assistant' message: set when the reply that wrote it finished, and it is the answer rather than narration
  final?: boolean;
  // On a reply that has no text yet: what is happening in the meantime
  status?: string;
  // On a 'tool' note: the tool call it reports
  callId?: string;
  // On a 'user' message: the app asked it, not the user — the task a subagent
  // was given, or what a look at the workspace was sent to do. It holds the
  // user's turn as far as the model is concerned, but nobody typed it, and it
  // is drawn so that nobody thinks they did.
  fromApp?: boolean;
  // On a 'subagent' message: how much of its piece it says is done, 0 to 100,
  // while it is still working (see the 'progress' event). Undefined for one
  // that has not said, or has finished.
  progress?: number;
  // ...and the model it is waiting its turn for, while it is waiting for one.
  // Subagents of one thread take turns at a local model (see
  // llm/cachelock.ts), so the row for one that is doing nothing says which.
  waiting?: string;
  // ...and, once it has finished, whether its report was cut for length
  cut?: boolean;
  // A caption over the words, in small print. On the task a subagent was
  // given, which is the first thing in its tab and would otherwise read as a
  // message somebody sent it (see goalOf).
  label?: string;
  // On a 'user' message: it is the user's review comments on the thread's changes
  review?: boolean;
  // On a 'user' message: a reply to it is on its way. Written to disk as soon
  // as the reply is asked for and taken off when it ends, so a message left
  // marked is one the app went down in the middle of: that is how a cut-off
  // reply is found again on the next launch (see resumeCutOff). The number is
  // how many times the app has closed on this same reply.
  pending?: number;
  // On a 'user' message: how it was classified for the reply to it, so that
  // a reply picked up after the app closed is not classified again
  classification?: Classification;
  // On a 'user' message: the model that was chosen to answer it, which whoever
  // checks the changes it led to must at least match (see verifyReply)
  answeredBy?: { provider: string; model: string };
  // On a 'user' message: the answer given when a model above the user's approval level was asked about for its
  // reply, kept so that it is not asked again after the app closes (see answerApproval)
  approval?: { provider: string; model: string; approved: boolean };
  // ...and whether the changes it led to have been checked since
  reviewed?: boolean;
  // On a review message: the comments it carries, so each can be shown as a
  // line of its own and lead to the reviewer dealing with it
  carries?: { id: string; path: string; line: number | null }[];
  // On a 'thought': an id to remember its dropdown by
  thoughtId?: string;
  // On the note left when a workspace was first looked at: what was noted about it
  blurb?: string;
  // On a classification note: the model that classified the message, and
  // the one chosen to answer it (unless the user picked that themselves)
  classifier?: string;
  served?: string;
  // ...and how the user rated that classification, once they have
  feedback?: 'good' | 'bad';
  // Covered by the thread's summary, so no longer sent to the model itself
  summarized?: boolean;
  // On the note that marks where the thread was summarized: the summary
  summary?: string;
  // On the note that closes a request: what each model used for it. On a
  // 'subagent': what it has used itself, added up the same way.
  usage?: Used[];
  // On that same note: each call made to a model for the request, in order,
  // with the input tokens it was sent — how much context that call carried
  passes?: { purpose: ModelUsage['purpose']; model: string; input: number }[];
  // On a 'tool' note: the tool's name
  tool?: string;
  // On a 'tool' note: what the tool was called with, in full (as JSON) and in
  // brief. A failed call keeps the full form, a successful one the brief.
  input?: string;
  inputSummary?: string;
  // On the note of a file that was written or edited: what changed, as a diff
  diff?: string;
  // On a 'tool' note whose call succeeded: the start of what the tool returned
  output?: string;
  // ...and the images it returned, shown under its output; on an 'assistant'
  // reply, the screenshots it took, shown under its text (never saved)
  images?: ToolImage[];
  // On an 'assistant' reply, the clips it recorded, shown under its text in
  // the same way and saved no more than the images are (see save in
  // threads.ts). Only ever on a reply: a clip is the user's to watch and is
  // never sent to a model, so it has no place on a tool's note.
  videos?: ToolVideo[];
  // On a 'tool' note whose call failed: what the tool reported
  failure?: string;
  // On the note for a message that could not be classified: why, as
  // [label, text] pairs, with an id to remember the dropdown by
  unclassified?: { id: string; details: [string, string][] };
  // On a 'subagent': what kind of subagent it is, the piece of work it was
  // given, what it has done so far, and what it brought back once it has
  // finished (see subagents/)
  kind?: string;
  task?: string;
  // ...and how hard the piece was reckoned to be, which is what sent it to
  // the model it went to (named in `served`, as a reply's model is)
  complexity?: number;
  effort?: string;
  // Its work, as it reported it. Saved with the thread, so what a subagent did
  // can be read again later.
  events?: AgentEvent[];
  finding?: string;
  failed?: boolean;
  // On a 'subagent' that failed: the user is done with it, so it is off the
  // list of work under its thread. It stays here in the thread, where what it
  // did can still be read.
  dismissed?: boolean;
  // On a 'subagent': how many times the app has started it again because it
  // closed while it worked (see resumeSubagents)
  restarts?: number;
  // On a note made only to be drawn (see agentMessages), never saved: when the
  // work it speaks for began, so that it can say how long it has been going
  since?: number;
}

// A comment the user left on a line of a thread's changes, and what has been
// said under it since
export interface ReviewComment {
  // "c1", "c2", …: what the assistant calls it when it replies
  id: string;
  // The file, and the line of its diff, the comment is about
  path: string;
  row: string;
  line: number | null;
  entries: { from: 'user' | 'assistant'; text: string; sent?: boolean }[];
}

export interface Thread {
  id: string;
  title: string;
  // The workspace the thread was started in, if the user chose one
  workspace?: string;
  // Set when the thread works on a Git branch rather than the checkout as it is. The workspace stays the repo root,
  // which is what threads are grouped and keyed by; branch.worktree is the host folder the thread's files come from
  // and that Apply writes to (see sourceOf).
  // `upstream` is the remote branch it was pushed to ("origin/feature"), once it has been.
  branch?: { name: string; base: string; worktree: string; upstream?: string };
  // A reply finished here while another thread was on screen
  unread?: boolean;
  // When a message was last sent or a reply last finished (ms since 1970)
  lastActive?: number;
  // When the user last opened the thread (see activate)
  opened?: number;
  // Kept out of the sidebar because its group had more than MAX_OPEN_THREADS
  // (see archiveStale). Still searched; opening it brings it back.
  archived?: boolean;
  // Set on a thread that was branched off another while its reply was still on its way (see startOffshoot): the
  // id of that thread. It is a thread in its own right, but the sidebar lists it under the one it came from.
  offshootOf?: string;
  // Started by the app rather than by the user: the work it does on a
  // workspace of its own accord (see automaticThread). Kept out of the
  // sidebar until it is asked for.
  automatic?: boolean;
  // The user's comments on the thread's changes, and the assistant's replies
  review?: ReviewComment[];
  // How many comments have been left so far, which numbers the next one
  reviewCount?: number;
  // How many of the user's messages the title was written from, once a model
  // has described the thread (see describeThread)
  described?: number;
  // Stands in, when talking to the model, for the messages marked summarized
  summary?: string;
  // Whether a change asked for in this thread is planned before it is made: the
  // reply is worked through in four steps and the plan is shown before anything
  // happens (see harness/phases.ts). Absent is 'auto', where a model is asked
  // about each task; it is kept only when the user picked 'always' or 'never'.
  plan?: PlanMode;
  // Whether this thread only reads the workspace and explains what it found,
  // changing nothing: a reply that is an investigation, with a hypothesis and
  // follow-ups. Absent is off, and it is kept only when the user turned it on.
  // It takes precedence over plan.
  investigate?: boolean;
  // How many files the thread was last seen to have changed, which wait to be
  // written back. Kept so that the sidebar can mark the thread before the
  // container is asked; absent is none.
  changes?: number;
  // Tokens used in this thread so far and what they cost, by "provider/model"
  usage?: Record<string, ModelTotal>;
  messages: Message[];
}

export interface State {
  threads: Thread[];
  activeId: string | null;
  // Workspaces threads were started in, most recently used first
  recentWorkspaces?: string[];
  // Sidebar groups that are collapsed: workspaces, and '' for general chats
  collapsed?: string[];
  // Threads whose subagents are shown under them in the sidebar (see
  // subagentItem). Hidden is the default: most threads have none, and a
  // thread that does can have as many as its work split into. Covers subagent
  // rows only; openedOffshoots is the same for offshoot rows.
  opened?: string[];
  // Threads whose offshoots are shown under them in the sidebar, as opened
  // does for subagents. Hidden is the default.
  openedOffshoots?: string[];
  // ...and workspaces whose automatic threads are shown. Hidden is the default:
  // they are the app's own work, not the user's conversations.
  shownAutomatic?: string[];
  // A "provider/model" key, or AUTO
  modelChoice?: string;
  // Workspace -> the name the user gave it, shown in place of the workspace's own
  workspaceNames?: Record<string, string>;
  // What the models were used for each day, by local date ("2026-10-09") and
  // then by "provider/model". Kept here rather than on the threads because a
  // day's spending is not a property of any one of them: it stands whether or
  // not the thread it was spent in is still around. This is what the token
  // usage page is drawn from (see drawUsage).
  daily?: Record<string, Record<string, ModelTotal>>;
  // The same days, by what the usage was for: a purpose, or "purpose/kind" for
  // the share of it a subagent of that kind spent (see recordUsage)
  dailyPurpose?: Record<string, Record<string, PurposeTotal>>;
}

// What one purpose has used. Like a ModelTotal, the cache figures are left
// absent where nothing was reported
export type PurposeTotal = { input: number; output: number; cost: number; cacheRead?: number; cacheWrite?: number };

// What the waiting on one model has come to. Kept apart from the tokens
// because it is not a count of the same things: a call the provider gave no
// token counts for is never reported at all, and the app's own errands —
// judging a message, writing a title — are not timed, so `timed` says how
// many calls these numbers are the measure of rather than how many were made
// (see Latency).
export interface Waits {
  timed: number;
  // The time the calls took, added up, and the longest single one of them: a
  // total on its own says nothing about whether it was one call that made
  // somebody wonder whether the app had stopped or twenty quick ones.
  spent: number;
  slowest: number;
  // Time spent queued behind another request, which is on top of the waiting
  // above rather than part of it (see Latency). Added up over the same calls.
  queued: number;
}

// What a call still being written has used so far, as the provider counts it
// or as it was estimated where the provider won't (see TokensEvent). Held
// with the request in flight and nowhere else: it is replaced by the next one
// and dropped when the call ends, and what the thread keeps is the call's own
// usage event. Its `estimated` is carried through to wherever it is shown, so
// a figure nobody has counted is never read as one that was (see ModelUsage).
export type Live = ModelUsage;

// What a model used over one or more calls, with the waiting on them where
// they were timed. A single call carries its own timing as `latency`; several
// added together (see mergeUsage) cannot, and carry `waits` instead.
export type Used = ModelUsage & { waits?: Waits };

// Everything one model has used in a thread. cost is in US dollars and
// covers only the usage whose price was known; unpriced says some wasn't.
export interface ModelTotal {
  provider: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  // The part of `input` that came from a prompt cache, or went into one. Kept
  // apart from the rest because it is not the same thing to have sent a
  // million tokens as to have had them read back: the second is a twentieth of
  // the price on some models (see llm/pricing.ts), and a thread whose cached
  // share falls is a thread whose cache has stopped working. Absent on usage
  // recorded before this was counted, and on providers that don't report it.
  cacheRead?: number;
  cacheWrite?: number;
  unpriced?: boolean;
  // How long it kept somebody waiting, where any of its calls were timed
  waits?: Waits;
}

export interface PendingRequest {
  // When it was sent, which is when classification begins (see clock). Kept
  // here and nowhere that is saved: a request does not outlive the window.
  startedAt: number;
  // What the reply was saying it was doing before it began waiting its turn
  // for a model, to be said again once the turn comes (see the 'queued' event)
  said?: string;
  thread: Thread;
  // The bubble the reply is streaming into
  message: Message;
  // The step of a coding change the reply is in, once a 'phase' event has said
  phase?: Phase;
  // Whether that step is the investigation of a question, rather than a change
  // (see the 'phase' event), so the notes it adds are drawn under its title
  investigating?: boolean;
  // The files on the user's computer the model is waiting to hear it may read
  // (see the 'file_access' event), asked one at a time in the thread itself
  fileAccess?: Extract<HarnessEvent, { type: 'file_access' }>[];
  // ...and the commands there that could lose work, which it is waiting to
  // hear it may run (see the 'command_access' event), asked the same way
  commandAccess?: Extract<HarnessEvent, { type: 'command_access' }>[];
  // The model above the user's approval level that the harness is waiting to
  // hear may be used (see the 'approval' event), asked in the thread itself
  approval?: Extract<HarnessEvent, { type: 'approval' }>;
  // When that question's time runs out, as the clock on the card counts down
  // to. Past it the harness has gone with the lesser model on its own.
  approvalDeadline?: number;
  // The question the model has put to the user (see the 'question' event),
  // asked in the thread itself
  question?: Extract<HarnessEvent, { type: 'question' }>;
  // The user message it is a reply to
  asked: Message;
  // The classification note shown above the reply, if any
  note?: Message;
  // Why classification failed, if it did
  unclassified?: [string, string][];
  // What each model has used for this request so far
  usage: ModelUsage[];
  // The note that lists those, kept at the end of the reply and updated as
  // each pass reports in (see noteUsage)
  tokens?: Message;
  // The thoughts shown open while this reply is written (their thoughtIds)
  thoughts: string[];
  // The tool calls made for this reply (their callIds)
  calls: string[];
  // The subagents this reply set to work, by the id their events carry
  subagents: Map<string, Message>;
  // What the calls now in flight have used so far: the reply's own under '',
  // and a subagent's under its id, since several subagents write at once (see
  // Live). One entry per caller, replaced as the count climbs.
  live: Map<string, Live>;
  // The note saying the context is being condensed, while that goes on and
  // the reply had already written something (see the 'condensed' event)
  condensing?: Message;
  // Whether this reply has written anything for the user, anywhere. Not the
  // same as the bubble in hand having something in it: everything that
  // interjects closes that bubble and opens a fresh one, so a reply that has
  // written its last word and then had a note put after it is holding an empty
  // bubble and has still answered (see the 'done' event).
  wrote?: boolean;
  // How far along an agent that is itself a thread says it is, 0 to 100 (see
  // the 'progress' event). Only the head explorer sends these.
  progress?: number;
}
