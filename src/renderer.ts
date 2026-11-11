// The entry of the window's UI. The code is in src/renderer/, one module for each
// part of the window; this file loads them in order and then calls start().

import './renderer/types.js';
import { SUMMARY_IDLE_MS } from './renderer/shared.js';
import './renderer/markdown.js';
import { state, createThread, activate, activeThread } from './renderer/threads.js';
import { loadModels, loadOffline } from './renderer/models.js';
import { pickUpLooks } from './renderer/settings.js';
import { openSetupIfWanted } from './renderer/setup.js';
import './renderer/notice.js';
import './renderer/approvals.js';
import './renderer/questions.js';
import { summarizeWhenIdle, resumeCutOff, resumeSubagents } from './renderer/reply.js';
import './renderer/usage.js';
import './renderer/usage-dialog.js';
import './renderer/events.js';
import './renderer/tool-calls.js';
import './renderer/search.js';
import './renderer/message-menu.js';
import './renderer/zoom.js';
import './renderer/sidebar.js';
import './renderer/agent-tabs.js';
import { render } from './renderer/thread-view.js';
import './renderer/new-thread.js';
import './renderer/changes.js';
import './renderer/workspace-dialog.js';
import './renderer/thread-dialog.js';
import './renderer/rename-feedback.js';
import './renderer/composer.js';
import './renderer/attachments.js';

// The first drawing of the window, and everything else that happens on the way
// in. Called at the very end of this file, once every module has been evaluated:
// drawing a thread reaches `const`s in the other modules (PHASES, subagentKey and
// the rest), which are still in their dead zone while the modules are being
// evaluated, so running it any earlier throws "Cannot access 'X' before
// initialization" and leaves the window dead.
function start(): void {
  if (state.threads.length === 0) createThread();
  else activate(activeThread());
  // Which computer this is drawn on: on macOS the window's own buttons are inset
  // into the top bar, so what is in the bar starts to the right of them (see
  // body > header in styles.css)
  document.body.dataset.platform = window.host?.platform ?? '';
  render();
  loadModels();
  loadOffline();
  pickUpLooks();
  // Whatever the app needs and hasn't got, asked about before anything is
  // typed into a window that could not have answered it (see renderer/setup.ts)
  void openSetupIfWanted();
  // Threads that went quiet in an earlier session are still due their summary
  for (const thread of state.threads) {
    if (thread.lastActive) summarizeWhenIdle(thread, thread.lastActive + SUMMARY_IDLE_MS - Date.now());
  }
  // A reply the app closed in the middle of carries on from where it got to...
  setTimeout(resumeCutOff);
  // ...and so does a subagent
  setTimeout(resumeSubagents);
}

// Everything above is in place, so the window can be drawn (see start)
start();
