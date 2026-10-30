import type { Thread, ThreadHit } from './types.js';
import { searchResults, searchInput, searchBox, onTab, messagesEl } from './shared.js';
import { state, activate, save } from './threads.js';
import { render } from './thread-view.js';

export const SEARCH_MIN = 3;
// How long after the last keystroke the search is made. Each one embeds the
// query, which is a request to Ollama, so it waits for the typing to stop.
export const SEARCH_DELAY_MS = 200;
export let searchTimer: ReturnType<typeof setTimeout> | undefined;
// Which search the results on screen are from: answers to an earlier one are
// dropped rather than drawn over a later one
export let searching = 0;
// What is on screen now, and which of them the keyboard is on
export let found: ThreadHit[] = [];
export let onResult = -1;

export const searchOpen = () => !searchResults.hidden;

export function closeSearch(): void {
  searchResults.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  found = [];
  onResult = -1;
}

// Clears the box as well, for Escape and for having opened a hit
export function endSearch(): void {
  closeSearch();
  searchInput.value = '';
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < SEARCH_MIN) {
    closeSearch();
    return;
  }
  searchTimer = setTimeout(() => void runSearch(query), SEARCH_DELAY_MS);
});

export async function runSearch(query: string): Promise<void> {
  const mine = ++searching;
  let hits: ThreadHit[];
  try {
    hits = await window.threads.search(query);
  } catch (err) {
    if (mine === searching) showSearchProblem((err as Error).message);
    return;
  }
  // A later search has been made since; its answer is the one to show
  if (mine !== searching) return;
  found = hits;
  onResult = hits.length > 0 ? 0 : -1;
  drawSearch(query);
}

// What there is to show for a query, as rows that open where they came from
export function drawSearch(query: string): void {
  if (found.length === 0) {
    showSearchProblem(`Nothing about "${query}" in your threads.`);
    return;
  }
  searchResults.replaceChildren(
    ...found.map((hit, i) => {
      const li = document.createElement('li');
      li.className = 'result';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === onResult));
      if (i === onResult) li.classList.add('on');

      const where = document.createElement('div');
      where.className = 'where';
      const title = document.createElement('span');
      title.className = 'thread';
      title.textContent = hit.title;
      where.append(title);
      if (hit.when) {
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = new Date(hit.when).toLocaleDateString();
        where.append(when);
      }

      // What the user asked, which is what they are looking for...
      const asked = document.createElement('div');
      asked.className = 'asked';
      asked.textContent = hit.request;
      // ...and the part of the answer that has most to do with the query
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = hit.preview;

      li.append(where, asked, preview);
      li.addEventListener('mousedown', (e) => {
        // Before the box loses focus, which would put the results away
        e.preventDefault();
        openHit(hit);
      });
      li.addEventListener('mousemove', () => {
        if (onResult === i) return;
        onResult = i;
        markResults();
      });
      return li;
    })
  );
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

// Why there is nothing to show: no match, or nothing to search with
export function showSearchProblem(text: string): void {
  const li = document.createElement('li');
  li.className = 'result none';
  li.textContent = text;
  searchResults.replaceChildren(li);
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  found = [];
  onResult = -1;
}

// Moves the mark without building the rows again
export function markResults(): void {
  [...searchResults.children].forEach((li, i) => {
    li.classList.toggle('on', i === onResult);
    li.setAttribute('aria-selected', String(i === onResult));
  });
  searchResults.children[onResult]?.scrollIntoView?.({ block: 'nearest' });
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    endSearch();
    return;
  }
  if (!searchOpen() || found.length === 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    onResult = (onResult + step + found.length) % found.length;
    markResults();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const hit = found[onResult];
    if (hit) openHit(hit);
  }
});

// Clicking anywhere else puts the results away, as the message menu does
document.addEventListener('click', (e) => {
  if (searchOpen() && !searchBox.contains(e.target as Node)) closeSearch();
});

// Opens the thread the hit came from, at the request it came from
export function openHit(hit: ThreadHit): void {
  const thread = state.threads.find((one) => one.id === hit.thread);
  endSearch();
  searchInput.blur();
  if (!thread) return;
  // The thread is shown as itself, not as whichever subagent tab was last open
  onTab.delete(thread.id);
  activate(thread);
  save();
  render();
  goToRequest(thread, hit);
}

// Scrolls to the message the hit is about and marks it, so that landing is
// something the user sees happen. The message is found by what it says rather
// than by where it was: the thread may have been summarized, retried or had
// messages deleted since it was indexed, and any of those move it.
export function goToRequest(thread: Thread, hit: ThreadHit): void {
  let at = thread.messages.findIndex((m) => m.role === 'user' && m.text === hit.request);
  // Failing that, where it was when it was indexed, if that is still a request
  if (at === -1 && thread.messages[hit.at]?.role === 'user') at = hit.at;
  if (at === -1) return;
  const found_ = messagesEl.querySelector<HTMLElement>(`.message.user[data-at="${at}"]`);
  if (!found_) return;
  // Called the way the rest of the window calls it: not every environment the
  // page runs in has it (see the streaming bubble in render)
  found_.scrollIntoView?.({ block: 'start' });
  // Taken off and put back, so a second landing on the same message shows
  found_.classList.remove('landed');
  void found_.offsetWidth;
  found_.classList.add('landed');
}

// The right-click menu on a message: delete it, or retry the reply it belongs to
