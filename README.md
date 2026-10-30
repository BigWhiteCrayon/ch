# ch

A desktop coding focused chat app I've slopped together.

**This is at best a curiosity I will abandon in a few weeks.** It is not finished, it is not reliable, and it's not actually good enough to consistently work on itself yet.
Don't depend on it for anything.

## The idea

Every message is first sized up by a small local model, which judges how
sophisticated a model the request needs, how much effort it deserves and what
kind of task it is. The message is then routed to the cheapest model that
clears that bar, with instructions shaped by the same judgement.

Threads can be started in a workspace: a folder on your computer. Such a thread
gets its own container with a copy of it, searches the code to find what a
request concerns, and can read, write and run things in there. Nothing is
written back to the real folder until you ask for it.

The first thread in a workspace nobody has opened before sends an explorer
through it straight away, which reads around and writes down each thing it finds as it
finds it. When it has finished, a condensing job turns those findings into the
note on the project: one piece of prose in an order someone meeting the project
would want, rather than the list of discoveries it was written as. That note is
shown to every thread in that workspace from then on, and is pushed to each of
them as soon as it exists rather than waiting to be asked for.

Right-click a workspace in the sidebar to read the note as it stands; right-
click a thread to see the notes it keeps for itself and what it has changed in
the workspace note, as a diff. Both are otherwise read by nobody but the
models. A question can be answered while the explorer is still reading; anything
that changes code waits for it, since code written in ignorance of a project is
code that does not fit it.

When what is left splits into pieces that don't depend on each other, the model
hands them out to subagents that run at once, in the same container, each with
the same tools. They show up as dropdowns in the thread and fill in as they go,
and the reply waits for all of them before it answers. They also appear as
sub-threads under their thread in the sidebar, collapsed until you want them:
clicking one goes to what it did.

A piece that is really a job of its own goes to an agent instead. That kind of
subagent is put through the whole of the same flow the thread is — classified,
routed, worked through in steps, condensed when its window fills — with no
limit on its rounds and subagents of its own to hand parts of the job to. It
works in the thread's container on the thread's files, like every other
subagent, and keeps a context note under its own name.

Any subagent can be written to while it works, and answers in words: the model
that sent it can narrow a piece, pass on something it has since found out, or
ask how far along the work is, without throwing away what has been done so far.
An agent stays for as long as that model has anything more to say to it.

## What it leans on

Two outside pieces, neither of them optional:

- **[Ollama](https://ollama.com)** — runs the local models. The classifier that
  routes every message is a small local model, so without Ollama there is no
  routing. Spoken to through its own API rather than the OpenAI-compatible one,
  so that models can be loaded with a usable context window and asked to
  report their thinking.
- **[Docker](https://www.docker.com)** — one container per thread, which is
  where `run_command`, `read_file`, `write_file` and `edit_file` do their work.
  Without it you get plain chat and nothing else. The image is picked from the
  workspace's own files — a Node image for a `package.json`, a Python one for a
  `pyproject.toml` — so a thread can run the project's tests; Settings has a
  box to say otherwise. Only the files Git would track are copied in, and the
  threads of a workspace share what their package managers download while
  keeping their installed dependencies to themselves.

Anthropic and OpenAI models work too, if you put a key in Settings or in the
setup flow. They are hosted, so they cost money and the routing will reach for
them when a request looks like it needs one.

## The search

Ollama also runs the semantic file search behind `search_workspace`, which is
slopped together here rather than borrowed. Every file Git would track is cut
into pieces at its blank lines and brace boundaries, each piece is embedded by
a small local model (`nomic-embed-text`), and the vectors are squeezed down to
a byte apiece and kept in one file per workspace. A search embeds the query and
takes the closest pieces; since an embedding can say a piece is about your
query but not which line of it is, the query's own words pick the line to show.

Each thread searches its own copy, taken from the workspace's index when the
thread opens and then kept in step with whatever the thread writes in its
container — so it searches the project as it has made it, not as it found it.
When the embeddings can't be had at all, searches fall back to plain ripgrep
keyword matches and say so.

It is judged by an eval suite of questions about this repository, each with the
file that ought to come back: `npm run eval -- search`.

## Setting it up

The app leads you through it the first time it opens, and again whenever
something it needs has gone (Colima, which is what the Docker install sets up
on macOS, does not come back after a reboot). Three steps:

- **Models on this computer** — required, and the only step that is. Ollama
  has to be answering and it has to have `nomic-embed-text`: the workspace
  search is built on an embedding model and nothing else here serves one, so
  without it `search_workspace` is reduced to matching keywords. The step also
  offers the models worth downloading on this machine — filtered by how much
  memory it has and offered largest first, since the biggest model a machine
  can hold is the best one routing can reach for. Ollama itself is not
  installed for you: it ships as an application on macOS and Windows, which
  cannot be installed unattended, so the flow opens the download page and
  notices when Ollama starts answering.
- **Hosted models.** The Anthropic and OpenAI keys, saved from the flow
  itself. Optional, so long as there is a local model for the routing to land
  on instead.
- **Containers.** Docker, which the app can install where there is something to
  install it with — Homebrew on macOS, winget on Windows, a sudo that doesn't
  ask on Linux — and otherwise sends you to the download. The installer is the
  same script `npm run install-docker` runs, in a process of its own, with its
  output on screen as it goes.

So it will not be finished until Ollama is running with the embedding model
and *something* can answer a message — a local model or a key. It says which
of those is missing, one at a time, rather than listing everything at once.
The rest can be skipped, and what you skip is remembered rather than asked
about again; Settings has a way back in. What it requires it asks for however
many times it has been finished before, because an Ollama that has stopped is
a part of the app missing again.

What is missing shows up in the title bar too: Fast Mode is greyed out with no
hosted model to prefer and Offline Mode with no local one to keep to, and
clicking either says what it would take. A switch that is *on* stays usable
whatever is available, so there is always a way back out of it.

## Running it

```sh
npm install
npm start          # build, then launch
npm run dev        # rebuild and reload as you edit
npm test           # vitest
npm run typecheck
npm run format     # prettier
npm run lint       # prettier --check, then no line over 120 characters
npm run pack       # a packaged app in release/, unpacked and quick
npm run dist       # ...and the installers: dmg and zip, nsis, AppImage
```

`npm install` builds the app and signs the Electron that development runs
under (macOS only, and only so that notifications work — see
`src/scripts/sign-electron.ts`). It no longer installs Docker: that is the
app's own job now, since nobody running a packaged build has an `npm install`
to hang it off.

Lines stop at 120 characters, prompts included. Prettier wraps the code;
prompts it cannot wrap for you, so they are hard-wrapped by hand and
`src/scripts/lint.ts` keeps them honest. Where a newline would change what a
string means — a shell command, a line-per-item prompt, anything the user
reads — the lines are joined with `+` instead of wrapped.


## Layout

```
src/setup/      what the app needs installed, and installing it
src/harness/    classify a message, route it, run the tool loop
src/subagents/  the kinds of subagent there are, one to a file
src/llm/        provider registry: Anthropic, OpenAI, Ollama
src/sandbox/    per-thread Docker container and the baseline it diffs against
src/search/     the embeddings, the chunking, and the keyword fallback
src/tools/      every tool a model is given, with its description
src/main.ts     Electron main process
src/renderer.ts  the entry of the UI
src/renderer/*.ts the UI, one module per part of the window
```

Built with Electron and TypeScript. Tests are vitest.