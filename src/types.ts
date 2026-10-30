// Types shared by the main process, the harness and the renderer.

// ---- Talking to models (see llm/index.ts)

export interface ToolCall {
  id: string;
  name: string;
  // null if the model's input wasn't valid JSON
  input: Record<string, unknown> | null;
}

// The provider's own form of a reply; kept on the assistant message when
// tool results are sent back, so nothing (e.g. thinking blocks) is lost.
export interface RawReply {
  provider: string;
  content: unknown;
}

// An image a tool returned, base64 encoded
export type ToolImage = { mediaType: 'image/png' | 'image/jpeg'; data: string };

// A clip a tool recorded, base64 encoded. It goes to the user and no further:
// no provider this app talks to has a video channel at all (see the tool-role
// message below, which carries images only), so what the model is given of a
// recording is frames out of it as ordinary images. Kept apart from ToolImage
// for that reason — the two have different audiences.
export type ToolVideo = { mediaType: 'video/webm'; data: string };

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: RawReply }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean; images?: ToolImage[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  provider: string;
  model: string;
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  tools?: ToolSpec[];
  // Goes ahead of other requests waiting for a local model (see llm/index.ts)
  priority?: boolean;
  // How long the model may take to answer, in ms. Counted from when the model
  // is up and the request starts: waiting for a turn, and for a local model to
  // load, are not held against it.
  timeoutMs?: number;
  // A short prompt with a short answer, which needs little context. A local
  // model may be loaded with a smaller context window for it, saving memory.
  brief?: boolean;
  // Whether a model that can reason should, for the providers that can be
  // told. Left unset, a model reasons on anything but a brief request. Set
  // false for work that wants the whole of a small answer and none of the
  // thinking: a model given a token ceiling can otherwise spend all of it
  // reasoning and return nothing (see harness/compactor.ts).
  think?: boolean;
  // What this request has in common with the others of its run. A thread's id,
  // or a subagent's: the requests that share a prefix are the ones that share a
  // key. It tells a provider that can be told where to look for a cached
  // prefix (see llm/providers/openai-compatible.ts), and it says whose prompt a
  // local model is holding, which decides whose request goes next (see
  // llm/cachelock.ts). A request with no key is one of the app's own one-off
  // prompts, which shares a prefix with nothing.
  cacheKey?: string;
  // Added to the log lines about this request, to tell what it was for
  log?: Record<string, unknown>;
}

export interface Usage {
  // Every input token the request was charged for, cached ones included
  input: number;
  output: number;
  // The part of `input` that was written to, or read from, a prompt cache.
  // Both are charged at their own rate (see llm/pricing.ts), and only the
  // providers that cache report them.
  cacheWrite?: number;
  cacheRead?: number;
}

export type ErrorCode = 'auth' | 'rate_limit' | 'spend_limit' | 'unreachable' | 'other';

export interface TextEvent {
  type: 'text';
  delta: string;
}

// A one-sentence note from the model on what it is doing (see harness/thoughts.ts)
export interface ThoughtEvent {
  type: 'thought';
  text: string;
}

// A piece of the model's own reasoning, from a provider that reports it apart
// from the reply (Ollama's `thinking`). It arrives in fragments as the model
// writes it, and never belongs in the reply; the harness gathers the
// fragments into thoughts (see harness/thoughts.ts).
export interface ReasoningEvent {
  type: 'reasoning';
  delta: string;
}

export interface ToolCallEvent extends ToolCall {
  type: 'tool_call';
}

export interface ErrorEvent {
  type: 'error';
  code: ErrorCode;
  message: string;
  // HTTP status, when the provider reports one
  status?: number;
  // How long the provider asked to be left alone for, in ms, when it said
  // (the Retry-After header). Preferred over any guess the app would make.
  retryAfterMs?: number;
}

// The provider is being asked for more than it will give, and the request is
// being made again after a wait rather than given up on (see llm/index.ts).
// Comes before the attempt it is waiting for, and never after anything of an
// answer has arrived: a reply half written is not one to start again.
export interface RateLimitedEvent {
  type: 'rate_limited';
  // Which attempt has just been turned away, and how many there will be
  attempt: number;
  of: number;
  // How long until the next one
  after: number;
  // What the provider said
  message: string;
}

// What the call has used so far, while it is still being written. Cumulative
// for the call rather than a delta, so each one replaces the last; the 'done'
// event's usage is what the call is finally counted as, and is the only count
// ever recorded (see llm/index.ts).
//
// Sent by the providers that count as they stream (Anthropic reports the
// prompt as the reply begins and the output as it goes; an OpenAI-compatible
// server does where it is one of the few that says). For the rest — Ollama
// among them, which counts only in its last line — the figures are estimated
// from what has arrived, and `estimated` says so: it is marked wherever the
// window shows it, and still replaced by the provider's own count at the end.
export interface TokensEvent {
  type: 'tokens';
  usage: Usage;
  estimated?: boolean;
}

export interface ProviderDoneEvent {
  type: 'done';
  // 'tool_use' when the model wants its tool calls run
  stopReason: string;
  usage?: Usage;
  raw?: RawReply;
}

// The request is waiting its turn: a local model answers one at a time, and
// keeps itself for the conversation whose prompt it is holding (see
// llm/index.ts and llm/cachelock.ts). Comes first, if at all.
export interface QueuedEvent {
  type: 'queued';
  // Which model it is waiting for, where that is known. Left out by the one
  // wait that happens before any model has been chosen: classifying the
  // message, which picks its own (see harness/classifier.ts).
  model?: string;
}

// How long the request waited its turn, reported once the wait is over and
// before the model has written anything. It is kept apart from the model's
// own timings because the two say quite different things: a wait is the app
// serialising its work, and counting it as the model being slow has sent us
// looking in the wrong place (see llm/index.ts and harness/index.ts).
export interface WaitedEvent {
  type: 'waited';
  ms: number;
}

// The provider's spend limit was reached, and the request is being made again
// on another model instead (see llm/index.ts). Both are display names, such as
// 'anthropic/claude-x'.
export interface FellBackEvent {
  type: 'fell_back';
  from: string;
  to: string;
}

export type ChatEvent =
  | TextEvent
  | ReasoningEvent
  | ToolCallEvent
  | TokensEvent
  | ProviderDoneEvent
  | ErrorEvent
  | QueuedEvent
  | WaitedEvent
  | RateLimitedEvent
  | FellBackEvent;

// What a provider reports about one of its models
export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number | null;
  default: boolean;
  // Reports its own reasoning apart from its reply (see ReasoningEvent), so
  // it is not asked for thoughts in tags (see harness/thoughts.ts)
  reasons?: boolean;
  // Takes images in its messages (see harness/router.ts). Absent is taken as yes
  vision?: boolean;
}

export interface ModelInfo extends ProviderModel {
  provider: string;
  providerName: string;
  local: boolean;
  // 1-5; see llm/sophistication.ts
  sophistication: number;
  // Switched off by the user in Settings
  disabled: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

export interface ModelList {
  models: ModelInfo[];
  providers: ProviderStatus[];
}

export interface ListModelsOptions {
  includeDisabled?: boolean;
  fresh?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  local: boolean;
  listModels(): Promise<ProviderModel[]>;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  status?(): Promise<'ready' | 'unreachable'>;
  // Makes sure the model is loaded and ready to answer, waiting while it
  // loads. Resolves when it is, or when that can't be told; rejects if the
  // model could not be brought up.
  // request: what the model is being brought up for, when that is known
  ensureUp?(model: string, signal: AbortSignal, request?: ChatRequest): Promise<void>;
  // Whether this request can be served while another is still in progress,
  // instead of waiting its turn (see llm/index.ts). A local provider that can
  // hold a second, small model in memory says so for the requests that go to
  // one. Asked before the request starts, so it must not wait for an answer.
  concurrent?(request: ChatRequest): boolean;
}

// ---- Settings (see settings.ts)

export interface HostedSettings {
  apiKey: string;
  // Model ids the user doesn't want offered
  disabledModels: string[];
}

export interface LocalSettings {
  baseURL: string;
  apiKey: string;
}

export interface Settings {
  anthropic: HostedSettings;
  openai: HostedSettings;
  local: LocalSettings;
  // Manual sophistication levels (1-5), keyed by "provider/model"
  sophistication: Record<string, number>;
  sandbox: SandboxSettings;
  // Files and folders on the user's computer the model may read without asking
  // (see harness/access.ts). Real paths: a folder allows everything in it.
  readable: ReadableSettings;
  // Nothing may be sent to a model on somebody else's computer: only the
  // local server is asked for models, and only local models are offered,
  // routed to or served (see llm/index.ts)
  offline: boolean;
  // Hosted models are preferred wherever one is capable enough, because they
  // answer faster than a local one. Only a preference: offline, or with no
  // hosted model worth the work, the ordinary rule decides (see
  // harness/router.ts)
  fast: boolean;
  // Whether a reply that changed files is reviewed by a model as soon as it
  // is over
  autoReview: boolean;
  // The highest model sophistication (1-5) used without asking the user for
  // approval first
  approvalCeiling: number;
  theme: Record<string, string>;
  // What the user has been led through on the way in (see setup/checks.ts)
  setup: SetupSettings;
}

export interface SetupSettings {
  // The user has been through the setup flow and does not want it again
  completed: boolean;
  // Which set of requirements they went through (see setup/checks.SETUP_VERSION).
  // A flow that has grown a step since shows that step, rather than nothing or
  // all of it again.
  version: number;
  // Requirements they chose to go without, by the id the flow knows them by,
  // so they are not asked a second time
  skipped: string[];
}

export interface SandboxSettings {
  // The Docker image a thread's container is built from. '' lets the workspace
  // decide, which is what it does: the files in it say which toolchain it
  // wants (see sandbox/docker.ts).
  image: string;
}

export interface ReadableSettings {
  // Allowed in every workspace. Nothing puts anything here yet; it is for
  // whoever edits the settings, and for what the app may come to ship with.
  global: string[];
  // Allowed in one workspace, keyed by the workspace's path
  workspaces: Record<string, string[]>;
}

// What the user says to a request to read a file on their computer: no; yes,
// this once; yes, for this file (or folder) in this thread; yes, and always
// for this file in this workspace; yes, and always for everything in its
// folder in this workspace
export type FileAccessAnswer = 'deny' | 'once' | 'thread' | 'file' | 'folder';

// For API keys: a string sets the key, null removes it, absent keeps it.
export interface SettingsPatch {
  anthropic?: { apiKey?: string | null; disabledModels?: string[] };
  openai?: { apiKey?: string | null; disabledModels?: string[] };
  local?: { apiKey?: string | null; baseURL?: string };
  sophistication?: Record<string, number>;
  sandbox?: { image?: string };
  offline?: boolean;
  fast?: boolean;
  approvalCeiling?: number;
  theme?: Record<string, string>;
  autoReview?: boolean;
  setup?: { completed?: boolean; version?: number; skipped?: string[] };
}

// What the renderer is allowed to see: never the keys themselves.
export interface PublicSettings {
  anthropic: { hasKey: boolean; disabledModels: string[] };
  openai: { hasKey: boolean; disabledModels: string[] };
  local: { baseURL: string; hasKey: boolean };
  sophistication: Record<string, number>;
  sandbox: SandboxSettings;
  offline: boolean;
  fast: boolean;
  approvalCeiling: number;
  theme: Record<string, string>;
  autoReview: boolean;
  setup: SetupSettings;
}

// ---- The harness (see harness/index.ts)

export interface ToolContext {
  signal: AbortSignal;
  threadId: string | undefined;
  // The workspace the thread was started in, if any
  workspace?: string;
  // The model answering, for a tool that needs a model of its own
  model?: { provider: string; model: string };
  // The subagent making the call, where one is: it keeps its own notes rather
  // than writing over the thread's or another subagent's (see sandbox/index.ts)
  agent?: string;
  // How far down the chain of subagents this is: 0 in a reply, 1 in a subagent
  // it sent, and so on. An explorer may send explorers of its own, so there has
  // to be a bottom (see MAX_HANDOUT_DEPTH in subagents/kind.ts).
  depth?: number;
  // The step of a coding change the call was made in, where the reply is
  // worked through in steps (see harness/phases.ts). A tool offered in more
  // than one step and bounded differently in them needs to know which it is
  // in: the finding-out step may hand work out, but only to subagents that
  // cannot change anything (see tools/subagents.ts).
  phase?: Phase;
  // How large the answering model's context window is, where it says. A tool
  // whose result has to fit in it sizes the result to it rather than to the
  // largest model there is (see pageFor in tools/sandbox.ts).
  window?: number;
  // The 1-5 level of the model answering, where it is known: the model that
  // ends up on the thread, not the level the classifier asked for, which it
  // falls back to only for a model the user picked that the list does not know
  // (see harness/index.ts). A coder subagent is kept below it (see capped in
  // subagents/run.ts).
  sophistication?: number;
  // Lets a tool say what it is doing while it runs, for work that takes long
  // enough to be worth watching (see subagents/)
  emit?(event: HarnessEvent): void;
  // Puts a question to the user and waits for what they say, which is one of
  // the options or whatever else they wrote. Only where somebody is there to
  // answer: a reply to a message, not a subagent or a look at a workspace
  // (see tools/ask.ts and the 'question' event).
  ask?(question: string, options: string[]): Promise<string>;
}

export interface Tool extends ToolSpec {
  // Which steps of a coding reply this tool is offered in (see
  // harness/phases.ts). Unset means every step that has tools at all, which
  // is what a tool that only reads wants. A tool that changes something
  // names the steps it belongs to, so that the model cannot reach for it
  // while it is still working out what to do.
  //
  // An empty list means no step of a coding reply offers it, which is not the
  // same as nothing offering it: a subagent's tools are its kind's rather than
  // a step's, and a reply not worked through in steps is offered everything.
  // That is where the tools that write a file now live — the doing step hands
  // its changes to coders (see tools/sandbox.ts).
  phases?: Phase[];
  // What the model is told about the tool in a step, where that differs from
  // `description`. A tool whose bounds change with the step would otherwise
  // have to describe every step's in all of them and leave the model to work
  // out which it is in — and a description is resent on every round of every
  // request, so the steps it does not apply to are paid for throughout. Unset
  // means `description` holds everywhere (see toolsFor in harness/index.ts).
  describe?(phase?: Phase, window?: number): string;
  // ...and the same for what it takes, where a step's bound is better kept by
  // the schema refusing the argument than by the tool refusing the call: a
  // narrowed enum costs fewer tokens than the choices it leaves out and is not
  // a round the model can spend finding the bound out.
  schemaFor?(phase?: Phase, window?: number): Record<string, unknown>;
  // Only offered in threads that were started in a workspace
  needsWorkspace?: boolean;
  // Only offered in a general chat, which has no workspace: for what is of use only until it has one
  generalOnly?: boolean;
  // Only offered to a subagent, and never in a reply of its own: for what is a subagent's to decide while it works
  // and the reply's to decide by other means (see tools/branches.ts, and specsFor in subagents/run.ts)
  agentOnly?: boolean;
  // Only offered when the message carries review comments (see harness/review.ts)
  needsReview?: boolean;
  // Writes the note on the workspace's project. Not offered while a first look
  // at that workspace is going on: the look is writing that note, and a thread
  // adding to it at the same time is writing about a project it has only just
  // met (see harness/index.ts).
  writesProjectNote?: boolean;
  // Returns a string or any JSON-serializable value. A ToolReturn carries images
  // along with its text (see splitToolReturn)
  run(input: Record<string, unknown>, context: ToolContext): unknown;
}

// What a tool returns when it has pictures to send back with its text. The
// images go to the model and to the user; the videos only to the user.
export type ToolReturn = { text: string; images: ToolImage[]; videos?: ToolVideo[] };

// Pulls a ToolReturn apart; any other value is text as it stands
export function splitToolReturn(value: unknown): { text: unknown; images?: ToolImage[]; videos?: ToolVideo[] } {
  if (typeof value === 'object' && value !== null && 'text' in value && 'images' in value) {
    const { text, images, videos } = value as ToolReturn;
    if (typeof text === 'string' && Array.isArray(images)) {
      return { text, images, ...(Array.isArray(videos) && videos.length > 0 && { videos }) };
    }
  }
  return { text: value };
}

// How much work a good reply takes; sets how much thinking is asked for
export type Effort = 'low' | 'medium' | 'high';

// The kind of task a message is; sets which instructions the model is given
export type Category = 'coding' | 'question' | 'investigation' | 'general';

// The steps a coding change is worked through, in order (see
// harness/phases.ts). Each is finished before the next begins, and each is
// given the step before it rather than everything that has happened: what
// carries forward is what the last step wrote down, not the tool calls it
// made getting there.
export type Phase = 'explore' | 'plan' | 'execute' | 'respond' | 'report';

// How a thread plans a coding change: 'always' does, 'never' does not, and
// 'auto' asks about each task with a prompt of its own (see harness/planner.ts)
export type PlanMode = 'always' | 'auto' | 'never';

// What judging the message took: the classifier's provider and the tokens it
// used, when those are known
interface ClassifierUse {
  provider?: string;
  usage?: Usage;
}

// sophistication: the least capable model level (1-5) that suits the request;
// effort: how much work it takes; category: what kind of task it is;
// model: the model that judged it
export type Classification =
  | ({
      failed?: false;
      sophistication: number;
      effort: Effort;
      category: Category;
      model: string;
    } & ClassifierUse)
  // model: the classifier, if one was chosen; reply: what it said, when that
  // was the problem
  | ({ failed: true; reason: string; model?: string; reply?: string } & ClassifierUse);

// What was wrong with a classification: its sophistication was lower or higher
// than the request needed, or it was taken for the wrong kind of task
export type ClassificationProblem = 'too_low' | 'too_high' | 'wrong_type';

// The user's verdict on how a message was classified (see feedback.ts)
export interface ClassificationFeedback {
  rating: 'good' | 'bad';
  // Only for a bad rating, and at least one then
  problems?: ClassificationProblem[];
  // The message that was classified, and what the classifier made of it
  request: string;
  classification: Classification;
  thread: string;
  // What the classifier was given, which is what makes a verdict worth keeping:
  // the rating alone says a request was read wrongly, and these say what was
  // read. Without them a verdict can only be replayed against its last message,
  // and a message out of its conversation rates lower than it did, which reads
  // as the prompt having improved (see evals/feedback.ts).
  //
  // The conversation, ending with the message that was rated, trimmed the way
  // the classifier trims it (see harness/classifier.shown)
  messages?: ChatMessage[];
  // The workspace the thread was started in, which decides which prompt was
  // used, and the summary standing in for the turns compacted away
  workspace?: string;
  summary?: string;
}

// How long one call to a model kept whoever asked it waiting. Reported beside
// the tokens it used, and measured where the call is made (see
// harness/index.ts and subagents/run.ts) — nothing further out can tell the
// time a model took from the time the app spent getting to it.
export interface Latency {
  // The whole of the call, from the request going out to the last of the reply
  // arriving. This is what somebody waiting on the answer actually sat
  // through: a reply is not finished when it starts, and a model that begins
  // in half a second and then writes for two minutes has kept them there for
  // two minutes.
  //
  // The wait before the first token is kept too, but only in the log beside
  // this (see firstTokenMs in harness/index.ts): a model that is slow to start
  // and one that is slow to write are a different problem to chase, and that
  // telling-apart belongs where someone is diagnosing one rather than in the
  // window, which answers how long the reply took.
  totalMs: number;
  // Time spent queued behind a request already in progress, which a local
  // provider makes everything do (see WaitedEvent). It is on top of totalMs
  // rather than part of it: the wait is the app serialising its work and not
  // the model being slow, and counting the two as one has sent us looking in
  // the wrong place before. Left out where there was no wait.
  queuedMs?: number;
}

// The tokens one model used for one part of a request, and what they cost
export interface ModelUsage extends Usage {
  // What the model was doing
  purpose:
    'classification' | 'planning' | 'reply' | 'summary' | 'description' | 'compaction' | 'subagent' | 'verification';
  provider: string;
  model: string;
  // In US dollars; null when the model's price isn't known (see llm/pricing.ts)
  cost: number | null;
  // How long it took, where the call was timed. Not every one is: the calls a
  // thread and its subagents make are, those being the ones somebody is
  // waiting on, and the app's own errands — judging a message, writing a
  // summary or a title — are not.
  latency?: Latency;
  // Set only on a count of a call still being written, and only where nobody
  // counted it: the figures are worked out from what has arrived, because the
  // provider says nothing until the end (see TokensEvent). It travels with the
  // count so that every place that shows one can mark it, and it is never on
  // the usage a finished call reports — what is recorded was counted.
  estimated?: boolean;
}

// Why a model was chosen. 'preferred' is the odd one: not the model the work
// asked for, but the best on the side it was to be kept to, because what
// mattered was which queue it joined (see Prefer in harness/router.ts).
// 'not_approved' is odd in the same way: the user declined approval for a
// model above approvalCeiling, so the best model at or below it was used.
export type RouteReason = 'matched' | 'best_available' | 'unclassified' | 'picked' | 'preferred' | 'not_approved';

// What a thread's summary is made from (see harness/summarizer.ts)
export interface SummaryRequest {
  // The messages not yet covered by a summary
  messages: ChatMessage[];
  // The summary so far, covering everything before those messages
  summary?: string;
}

export interface Summary {
  text: string;
  // What writing it took, when the provider reported it
  usage?: ModelUsage;
}

// One piece of what an agent does, as it does it: a thought, a tool call and
// what came back from it, or the app boiling down what has been gathered. The
// same set whether the agent is a thread's subagent (see subagents/) or the
// explorer going through a workspace (see harness/project.ts), so that the
// window can show either of them the same way.
export type AgentEvent =
  | ThoughtEvent
  // Waiting its turn for the model, and that wait being over: subagents of one
  // thread take turns at a local model rather than a round each (see
  // llm/cachelock.ts), so one of several that is doing nothing yet is waiting
  // rather than slow
  | QueuedEvent
  | WaitedEvent
  | { type: 'condensing' }
  // That is over. 'changed' says whether anything came of it: if so the notice
  // becomes a record that it happened, which stays in the log; if not, the
  // notice goes.
  | { type: 'condensed'; changed: boolean }
  // Its report came out longer than its kind has room for, and it is being
  // asked to say the same thing in less (see subagents/run.ts). As with
  // 'condensing', the app's work rather than the model's.
  | { type: 'shortening' }
  // How much of what it was given it reckons is done, 0 to 100, which it is
  // asked for now and then (see PROGRESS in subagents/run.ts). Its own
  // estimate, so it is a sense of how far along the work is and not a
  // measurement of it.
  | { type: 'progress'; percent: number }
  | ToolCallEvent
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; images?: ToolImage[] }
  | RateLimitedEvent
  | FellBackEvent;

// What a thread's description is written from (see harness/describer.ts)
export interface DescriptionRequest {
  // What the user has asked for in the thread, oldest first
  requests: string[];
}

export interface Description {
  text: string;
  // What writing it took, when the provider reported it
  usage?: ModelUsage;
}

// What a suggested reply is written from (see harness/suggester.ts)
export interface SuggestionRequest {
  // The end of the conversation, oldest first
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface Suggestion {
  // What the user might say next, written as they would
  text: string;
}

// What a reply's changes are checked against (see harness/verifier.ts). The
// changes themselves are read from the thread's container, not sent.
export interface VerificationRequest {
  thread: string;
  // What the user asked for, and what the reply told them it had done
  request: string;
  output: string;
  // The model that wrote the reply, so that the one checking it is at least as
  // capable. Absent where that is not known: the most capable model checks.
  provider?: string;
  model?: string;
}

export interface Verification {
  passed: boolean;
  // What is wrong with the reply, in the reviewer's words; '' when it passed
  problems: string;
  // The model that did the checking
  model: string;
  // Changed files the review did not reach, where there were more than it
  // looks over at once (see harness/verifier.ts). Absent where it saw them all.
  unreviewed?: number;
  // What checking took, when the provider reported it
  usage?: ModelUsage;
}

// What a reply that was cut off had got done before the app closed, so that
// the model picking it up carries on instead of starting again (see resume in
// renderer.ts). A thread's container is kept when the app quits, so whatever
// its tools changed to the files is still changed.
export interface Resumed {
  // What it had written for the user, if anything
  text?: string;
  // What it had done, oldest first: a line per tool call and per subagent,
  // with in brief what came back
  did: string[];
  // On a review: the comments that already have an answer under them, so
  // that nobody is answered twice
  answered?: string[];
  // How the message was classified before the app closed. The reply is routed
  // and instructed by that, rather than the message being classified again.
  classification?: Classification;
  // The answer the user gave to asking about a model above the approval ceiling
  // before the app closed, so that they are not asked again for the same model
  approval?: { provider: string; model: string; approved: boolean };
}

// One failed subagent, to be run again on its own because the user asked
// (see subagents/retry.ts)
export interface RetryRequest {
  thread: string;
  // The workspace the thread was started in, so its container has the files
  workspace?: string;
  // What the window knows this subagent by, which its work is reported back
  // under: a thread can have sent out two of the same name
  id: string;
  // What the subagent is called, the piece of work it was given, and which
  // kind of subagent it is
  name: string;
  task: string;
  kind?: string;
}

// What a subagent brought back, as the window records it
export interface SubagentResult {
  text: string;
  isError: boolean;
}

export interface HarnessRequest {
  thread?: string;
  // Stands in for the earlier messages of the thread, which are left out
  summary?: string;
  // The workspace the thread was started in, copied into its container
  workspace?: string;
  // The last message is the user's review comments on the thread's changes
  review?: boolean;
  // Set when the reply to the last message is being picked up where the app
  // closed on it
  resumed?: Resumed;
  // Whether a coding task in a workspace is planned before it is changed, and
  // so worked through in discrete steps rather than in one run (see
  // harness/phases.ts). Absent is 'auto'.
  plan?: PlanMode;
  // Whether the reply investigates rather than changes: the workspace is read
  // and written up, and nothing in it is touched (see INVESTIGATION in
  // harness/phases.ts)
  investigate?: boolean;
  messages: ChatMessage[];
  // Set only when the user picked a model themselves
  provider?: string;
  model?: string;
  // Rounds of tool calls the reply may take, where what the message's effort
  // bought is not the right bound (see maxSteps in harness/index.ts). Infinity
  // for a reply nothing counts the rounds of: an agent subagent is given a
  // whole job rather than a message, and what ends it is the job being done,
  // the user stopping it, or its own window (see subagents/agent.ts).
  rounds?: number;
  // This reply is a subagent's, put through the whole of the flow rather than
  // the small loop a piece of work gets (see subagents/thread.ts). The name is
  // the one the model that sent it knows it by, which its own context note is
  // kept under; the depth is how far down the chain of subagents it stands
  // (see MAX_HANDOUT_DEPTH in subagents/kind.ts).
  //
  // What it changes about the reply: which tools are offered, what it is told
  // it is, who reads what it writes, and that it has a letterbox (see
  // subagents/mailbox.ts). Nothing else — it works in the thread's own
  // container, on the same files, as every other subagent does.
  agent?: { name: string; depth: number };
}

export type HarnessEvent =
  | ({ type: 'classification' } & Classification)
  | {
      type: 'model';
      provider: string;
      model: string;
      name: string;
      sophistication: number | undefined;
      reason: RouteReason;
    }
  // The model wants to read a file on the user's own computer, outside the
  // thread's container, and the user is being asked whether it may (see
  // harness/access.ts). path is the real path asked for and folder the one it
  // is in (the path itself, where that is a folder); isFolder says which it is.
  // canRemember is whether a yes for good can be kept, which needs a workspace.
  | { type: 'file_access'; id: string; path: string; folder: string; isFolder: boolean; canRemember: boolean }
  // The model wants to run a command on the user's own computer that could
  // lose work — a git that forces, resets, cleans or pushes — and the user is
  // being asked whether it may, this once (see harness/access.ts). command is
  // what would be run, path the folder it would run in, and why what is risky
  // about it, in words the card shows as they are. Nothing about it is
  // remembered: there is no answer here that holds for the next one.
  | { type: 'command_access'; id: string; command: string; path: string; why: string }
  // A model above the approval ceiling is wanted and the user is being asked
  // whether it may be used; fallbackName is the model used if they decline.
  // timeoutMs is how long the question stands before it is taken as a decline,
  // so the window can count the time down where the user can see it.
  | {
      type: 'approval';
      provider: string;
      model: string;
      name: string;
      sophistication: number | undefined;
      ceiling: number;
      fallbackName: string;
      timeoutMs: number;
    }
  // The model has stopped to ask the user something and is waiting for the
  // answer (see tools/ask.ts). The options are what it thinks the answer is
  // likely to be; the user may say something else.
  | { type: 'question'; question: string; options: string[] }
  // A general chat has moved into a workspace of its own (see tools/workspaces.ts). The reply that said so goes on
  // as it began, with the instructions and tools it started with; the thread is in the workspace from its next message.
  | { type: 'workspace'; workspace: string }
  // A subagent has put the thread it is working in on a branch of its own (see tools/branches.ts). Only where the
  // thread's work goes changes: the files in its container stay as they are, and the branch's worktree is the folder
  // the thread's changes are written back to from now on.
  | { type: 'branch'; branch: { name: string; base: string; worktree: string } }
  // Waiting its turn for a local model: either the model is busy with a
  // request that was already in progress, or it is holding another
  // conversation's prompt and that conversation is still using it (see
  // llm/cachelock.ts). The first wait of all is for the model that classifies
  // the message, which is named by neither of them.
  | QueuedEvent
  // ...and that wait is over, so whatever the window said about it goes
  | WaitedEvent
  // The provider turned the request away and it is being made again
  | RateLimitedEvent
  // The model was given up on for another one, said where the reply is
  | FellBackEvent
  | { type: 'step'; step: number }
  // Which step of a coding change the reply has reached (see harness/phases.ts)
  | { type: 'phase'; phase: Phase; investigation?: boolean }
  // What the model says it is going to change, written before it changes
  // anything and shown to the user as its own thing
  // Any pictures or clips the finding-out step took are sent with it, so the
  // plan is shown with what it was based on (see harness/index.ts)
  | { type: 'plan'; text: string; images?: ToolImage[]; videos?: ToolVideo[] }
  // The reply's result text; its thoughts arrive separately
  | TextEvent
  | ThoughtEvent
  | ToolCallEvent
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; images?: ToolImage[] }
  // The screenshots the reply took, and the clips it recorded, sent once at the
  // end for the thread to show under the reply (see SHOWN in harness/index.ts)
  | { type: 'images'; images: ToolImage[]; videos?: ToolVideo[] }
  // The conversation is being boiled down to fit the model's context window
  // (see harness/compactor.ts). Shown as what the reply is doing, not as a
  // thought: it is the app's work, not the model's.
  | { type: 'condensing' }
  // That boiling down is over. 'changed' says whether anything came of it: if
  // so the thread keeps a record of it, as it does of a tool call; if not,
  // the notice that it was happening goes.
  | { type: 'condensed'; changed: boolean }
  // A report that came out longer than there is room for is being written
  // again shorter (see subagents/run.ts). Reaches a thread when the agent
  // doing it is the thread itself, as the head explorer is.
  | { type: 'shortening' }
  | { type: 'progress'; percent: number }
  // A subagent the reply set to work on one piece of a job, so that several
  // pieces are done at once (see subagents/). 'subagent' says one has started,
  // 'subagent_update' is a piece of its work as it happens, and 'subagent_done'
  // is what it came back with.
  | {
      type: 'subagent';
      id: string;
      name: string;
      task: string;
      kind: string;
      // How hard the model handing it out reckoned this piece to be, and what
      // that got it: the same three things a thread is told about its own
      // reply (see the 'classification' and 'model' events)
      complexity?: number;
      effort?: Effort;
      model?: string;
    }
  | { type: 'subagent_update'; id: string; event: AgentEvent }
  // cut: its report was longer than there was room for even after it was
  // asked to shorten it, so what came back stops short of the end
  | { type: 'subagent_done'; id: string; text: string; isError: boolean; cut?: boolean }
  // Sent once a model's part in the request is over, however it ended
  // subagent: the id of the subagent whose call it was, where it was one
  | ({ type: 'usage'; subagent?: string } & ModelUsage)
  // What the call now in flight has used so far, priced the same way, for a
  // window that would otherwise show nothing moving for as long as a pass
  // takes (see TokensEvent). Each replaces the last, and the 'usage' event
  // above replaces them all: nothing one of these says is added to a total or
  // kept with the thread.
  | ({ type: 'tokens'; subagent?: string; estimated?: boolean } & ModelUsage)
  | { type: 'done'; stopReason: string; usage: Usage; steps: number }
  | ErrorEvent;

// ---- Ollama model management (see llm/ollama.ts)

// A model offered for download, with enough to judge it before downloading
export interface SuggestedModel {
  name: string;
  // The level (1-5) it will be given once downloaded
  sophistication: number;
  // How much memory the computer running Ollama should have, in GB
  memoryGB: number;
}

export interface OllamaStatus {
  reachable: boolean;
  url: string;
  installed: { name: string; size: number }[];
  suggested: SuggestedModel[];
}

export interface PullProgress {
  name: string;
  status?: string;
  percent?: number | null;
  done?: boolean;
  error?: string;
}

// ---- Getting the app ready to use (see setup/checks.ts)

// What the local server has to offer, and what is missing from it
export interface LocalReadiness {
  // Ollama answered at its own API, so models can be listed and downloaded
  // from here. False for another OpenAI-compatible server, which may still be
  // serving models (see `models` below).
  reachable: boolean;
  url: string;
  installed: { name: string; size: number }[];
  // Worth downloading on this computer: the suggested models that are not
  // here yet and that its memory can hold, largest first (see llm/ollama.ts)
  recommended: SuggestedModel[];
  // How much memory this computer has, in GB, which is what the recommendation
  // was made against
  memoryGB: number;
  // Local models the app can actually answer with, however they are served
  models: number;
  // One of them is at or above the floor the classifier wants, so routing has
  // something it trusts (see harness/classifier.FLOOR)
  routable: boolean;
  // The embedding model the workspace search is built on is downloaded
  embedding: boolean;
  embeddingModel: string;
}

export interface DockerReadiness {
  installed: boolean;
  running: boolean;
  // This computer has something to install Docker with — Homebrew, winget, or
  // a sudo that doesn't ask — so the flow can offer to do it rather than
  // sending the user to a download page (see setup/install.ts)
  automatic: boolean;
}

// Everything the setup flow decides what to show from. Read in one go, so the
// flow never shows two steps that disagree about the same thing.
export interface SetupStatus {
  local: LocalReadiness;
  docker: DockerReadiness;
  keys: { anthropic: boolean; openai: boolean };
  // A message can be answered at all: a local model, or a key to a hosted one
  canAnswer: boolean;
  // Everything the flow insists on before it lets the user out of it: Ollama,
  // running and holding the embedding model, and something to answer with.
  // Ollama is not optional — the workspace search is built on an embedding
  // model nothing else here serves, and without it search is reduced to
  // keyword matching (see search/embeddings.ts).
  ready: boolean;
  // Threads can run, read and write code in a container of their own
  canRunCode: boolean;
  // search_workspace can find things by meaning rather than by keyword
  canSearch: boolean;
  setup: SetupSettings;
  // The set of requirements this is an answer about (see setup/checks.ts).
  // Echoed back when the flow is finished, so the renderer records what it
  // got through without keeping its own copy of the number.
  version: number;
  // The flow should open itself: it has never been finished, it was finished
  // against an older set of requirements, or what it set up is not there any
  // more (Colima does not come back after a reboot)
  wanted: boolean;
  platform: string;
}

// An installer saying how it is going. Lines are its own output, verbatim.
export interface SetupProgress {
  line?: string;
  done?: boolean;
  // Whether the installer exited cleanly. It says little about whether Docker
  // now works — the installer reports its own troubles and still exits 0 — so
  // the flow asks for the status again rather than believing this.
  ok?: boolean;
  error?: string;
}

// What the setup flow can be told to install, and where its download lives
export type Installable = 'docker' | 'ollama';

// ---- What the preload script exposes to the renderer (see preload.ts)

export interface LlmBridge {
  listModels(options?: ListModelsOptions): Promise<ModelList>;
  send(requestId: string, request: HarnessRequest): void;
  // Resolves with a summary of the conversation, or null if none could be made
  summarize(request: SummaryRequest): Promise<Summary | null>;
  // A few words on what the user has asked for; null if none could be written
  describe(request: DescriptionRequest): Promise<Description | null>;
  // What the user might say next, to be offered in the message box; null if
  // there is nothing worth suggesting
  suggest(request: SuggestionRequest): Promise<Suggestion | null>;
  // Has a model at least as capable as the one that wrote a reply check its
  // changes. Rejects with why when it could not be done.
  verify(request: VerificationRequest): Promise<Verification>;
  // Keeps the user's verdict on a classification in a file beside the log
  feedback(feedback: ClassificationFeedback): void;
  cancel(requestId: string): void;
  // The user's answer to a 'file_access' event, by the event's id
  allowFileAccess(id: string, answer: FileAccessAnswer): void;
  // ...and to a 'command_access' event: whether the command it named may run
  allowCommand(id: string, allowed: boolean): void;
  // The user's answer to an 'approval' event: whether the model above the
  // approval ceiling may be used
  approve(requestId: string, approved: boolean): void;
  // The user's answer to a 'question' event: one of its options or their own words
  answer(requestId: string, answer: string): void;
  onEvent(callback: (requestId: string, event: HarnessEvent) => void): void;
  // Runs one failed subagent again, resolving with what it brought back this
  // time. Its work arrives meanwhile through onSubagentEvent.
  retrySubagent(request: RetryRequest): Promise<SubagentResult>;
  onSubagentEvent(callback: (threadId: string, id: string, event: AgentEvent) => void): void;
}

// One request of a thread and the replies to it, as the window cuts a thread up
// for searching (see search/threads.ts)
export interface ThreadPiece {
  thread: string;
  title: string;
  // Which message of the thread began it
  at: number;
  request: string;
  reply: string;
  when?: number;
}

// The same, found: how like the query it is, and the part worth showing
export interface ThreadHit extends ThreadPiece {
  score: number;
  preview: string;
}

export interface ThreadsBridge {
  // Opens the system's workspace picker; null if the user backs out of it
  chooseWorkspace(): Promise<string | null>;
  // A thread with a workspace is on screen: gets the workspace indexed for search
  open(threadId: string, workspace: string): void;
  // The workspace's git branches and the one checked out (null if detached or not a repository)
  branches(workspace: string): Promise<{ current: string | null; names: string[] }>;
  // Gets a worktree of the workspace ready on `branch`, made from `base` if `create` is set.
  // Resolves with the worktree's path.
  prepareBranch(workspace: string, branch: string, base: string, create: boolean): Promise<string>;
  // Where a branch's worktree stands: its upstream, how far ahead of and behind it, and whether it has uncommitted work
  branchStatus(worktree: string): Promise<BranchStatus>;
  // Commits everything in the worktree. Resolves with false, having done nothing, if there was nothing to commit.
  commitBranch(worktree: string, message: string): Promise<boolean>;
  // Pushes the worktree's branch, setting its upstream (`git push -u origin`) the first time.
  // Resolves with the upstream, like "origin/feature".
  pushBranch(worktree: string): Promise<string>;
  // Brings the upstream's new commits into the worktree, fast-forward only
  pullBranch(worktree: string): Promise<void>;
  // Takes a worktree away (never the branch itself, and never one with uncommitted work: that is refused)
  removeWorktree(workspace: string, worktree: string): Promise<void>;
  // Removes the thread's container and its files, and its copy of the search index
  remove(threadId: string): void;
  // What the thread has changed in its copy of the workspace
  changes(threadId: string): Promise<ThreadChanges>;
  // Writes those changes back to the workspace itself
  applyChanges(threadId: string, workspace: string): Promise<AppliedChanges>;
  // Puts the thread back as it was before the attempt named by `request`, for
  // an attempt whose messages have been thrown away. The context note it wrote
  // always goes; its files go with it unless `files` is false, which is for an
  // attempt that ran to the end rather than failing partway. Resolves with
  // whether the files were in fact put back.
  revert(threadId: string, request: string, options?: { files?: boolean }): Promise<boolean>;
  // Throws away what the thread has changed in its copy since it was last written back (or made), without
  // touching the workspace. Resolves with whether anything was in fact put back.
  discardChanges(threadId: string): Promise<boolean>;
  // The threads and their messages as last saved (JSON), or null if none are
  load(): string | null;
  // Saves the threads and their messages (JSON) to disk
  save(state: string): void;
  // As save, but does not return until it is on disk: for when the window is closing
  saveNow(state: string): void;
  // What is known about a workspace: the note on its project as it stands
  workspace(workspace: string): Promise<WorkspaceDetails>;
  // What this thread keeps for itself, and what it has made of that note
  details(threadId: string, workspace?: string): Promise<ThreadDetails>;
  // The workspaces an explorer is going through right now, for a window that
  // has just opened and missed the news
  looking(): Promise<string[]>;
  // A look starting or ending, so the window can show it going on under the
  // workspace it is of (see harness/project.ts). task is what the explorer was
  // sent after, given when one starts.
  onLooking(callback: (workspace: string, going: boolean, task?: string) => void): void;
  // What the explorer says while it works: its thoughts, the tools it calls
  // and what they came back with, as they happen
  onLookEvent(callback: (workspace: string, event: HarnessEvent) => void): void;
  // Throws the workspace's note away and has an explorer write a new one.
  // Resolves with the new note, or '' if none could be written, in which case
  // the one it had is kept.
  relook(workspace: string, threadId?: string): Promise<string>;
  // A workspace's first note has just been written (see harness/project.ts). It
  // is pushed here rather than asked for, so that every thread started in the
  // workspace is shown it as soon as it exists, not when it next has something
  // to say.
  onSurveyed(callback: (workspace: string, note: string) => void): void;
  // Brings the search index up to date with the threads as they are. Only the
  // pieces whose text has changed are embedded.
  index(pieces: ThreadPiece[]): Promise<void>;
  // The requests most like what was typed, most alike first
  search(query: string): Promise<ThreadHit[]>;
  // The workspace's detailed notes most like what was typed, most alike first.
  // The same search the models make (see harness/notes.ts), so what the user
  // reads here is what a thread asking the same question would be given.
  searchNotes(workspace: string, query: string): Promise<WorkspaceNote[]>;
  // Throws one of those notes away for good, named by what it is about and by
  // the thread whose it still is, where it is one thread's (see
  // harness/notes.remove). Resolves with whether there was one to throw: a
  // note on screen can have been promoted or pruned since it was drawn.
  forgetNote(workspace: string, subject: string, threadId?: string): Promise<boolean>;
}

// ---- What is known about a workspace and a thread (see harness/project.ts)

// Shown when the user asks to see a workspace: the note on its project as it
// stands, which is otherwise only read by the models working in it.
// One of the detailed notes behind that overview (see harness/notes.ts), as
// the window shows one. The fingerprints the notes keep of their files are left
// out: what they are for is telling whether a note has drifted, and that
// question is answered before it gets here.
export interface WorkspaceNote {
  // What it is about, and what it says
  subject: string;
  content: string;
  writtenAt: string;
  // The thread that wrote it, where it is still only that thread's
  thread?: string;
  // The files it was worked out from, relative to the top of the workspace
  files: string[];
  // What has become of those files since, where some of them have moved on:
  // this is the note the user is shown as no longer to be trusted
  drift?: { changed: string[]; gone: string[] };
}

export interface WorkspaceDetails {
  // The note every thread in this workspace is shown, '' if there is none yet
  note: string;
  // When it was last written, ISO, or null for a workspace with no note
  writtenAt: string | null;
  // The detailed notes behind it, newest first, and how many more there are
  // than are listed: a workspace can keep hundreds, and the rest are reached
  // by searching (see ThreadsBridge.searchNotes)
  notes: WorkspaceNote[];
  moreNotes: number;
  // A first look at the workspace is going on right now, so the note is
  // still being filled in (see harness/project.ts)
  surveying: boolean;
}

// The same for one thread: what it keeps for itself, and what it has made of
// the workspace's note.
export interface ThreadDetails {
  // The note the thread keeps in its own container, written with save_context
  context: string;
  // The workspace note as this thread has it: its own copy once it has
  // written to one, and the workspace's own until then
  note: string;
  // ...and as the workspace itself has it, so the two can be compared
  shared: string;
}

// ---- Writing a thread's changes back to its workspace (see sandbox/changes.ts)

export interface FileChange {
  // Relative to the workspace
  path: string;
  status: 'added' | 'modified' | 'deleted';
  // The change as a unified diff, from its first hunk; '' if there is none to show
  diff: string;
  binary: boolean;
}

// Where a branch's worktree stands, as Git sees it
export interface BranchStatus {
  // The remote branch it tracks, like "origin/feature"; null until it has been pushed with -u
  upstream: string | null;
  // Commits the worktree has that the upstream does not, and the other way round (0 with no upstream)
  ahead: number;
  behind: number;
  // Whether there are uncommitted changes (tracked or untracked) in the worktree
  dirty: boolean;
}

export interface ThreadChanges {
  files: FileChange[];
  // How many more files changed than are listed
  more?: number;
  // Why the thread's changes can't be told, if they can't
  unavailable?: string;
}

export interface AppliedChanges {
  // The files written to or deleted from the workspace
  applied: string[];
  // Why nothing was written, file by file, if anything conflicted
  conflicts: { path: string; reason: string }[];
  // Changes that are never written back, such as links
  skipped: { path: string; reason: string }[];
  // What went wrong, if applying failed outright
  error?: string;
}

export interface OllamaBridge {
  status(): Promise<OllamaStatus>;
  pull(name: string): void;
  cancel(name: string): void;
  onProgress(callback: (progress: PullProgress) => void): void;
}

// What the page needs to know about the computer it is drawn on. Only the
// platform so far, which decides whether the window's own buttons are inset
// into the top bar (see body > header in styles.css).
export interface HostBridge {
  platform: string;
  // Brings the window forward, for a notification the user clicked. The page
  // cannot do this for itself: window.focus() does nothing once the user has
  // switched to another app, which is the only time a notification is shown
  // (see notify in renderer.ts).
  show(): void;
  // The number of threads with news the user has not seen, for the app's icon
  // to carry as a badge (the dock's on macOS; see badge in main.ts).
  badge(count: number): void;
}

// Getting the app ready to use, for the flow the window shows on the way in
// (see renderer/setup.ts)
export interface SetupBridge {
  // Everything that is and isn't ready, asked afresh each time
  status(): Promise<SetupStatus>;
  // Installs Docker and starts it, reporting the installer's own output as it
  // goes (see onProgress). One at a time: asked again while one is running,
  // nothing happens.
  installDocker(): void;
  // Gives up on the install that is running
  cancel(): void;
  // Opens a download page in the user's own browser, for what the app cannot
  // install for them
  download(what: Installable): void;
  onProgress(callback: (progress: SetupProgress) => void): void;
}

export interface SettingsBridge {
  get(): Promise<PublicSettings>;
  save(patch: SettingsPatch): Promise<PublicSettings>;
  // A setting was changed outside the window: the Offline switch, which is in
  // the app's menu (see menu.ts). What is on offer follows from it, so the
  // window is told rather than left to find out.
  onChanged(callback: (settings: PublicSettings) => void): void;
}
