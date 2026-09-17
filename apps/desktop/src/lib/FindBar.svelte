<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { app, toggleSidebar } from "./state.svelte";
  import { isMac } from "./platform";
  import { registerFindBar } from "./search";
  import {
    collectSegments,
    countLabel,
    currentMark,
    findChord,
    findMatches,
    highlightApi,
    hitRange,
    keepHit,
    markFallback,
    scrollRangeIntoView,
    SEARCH_CHORD_LABEL,
    stepHit,
    supportsHighlightApi,
    type Hit,
    type Highlighter,
    type Segments,
  } from "./find";

  /**
   * Find in page (nightshift backlog 106, first half): Chrome's bar, at
   * the top right of the transcript area. ⌘F opens it (`App.svelte`'s
   * `onShortcut` calls `show()`), and opens it again with the text
   * selected when it is already up; the page is searched as he types,
   * every hit lit and the current one brighter and scrolled into view;
   * ⏎ / ⇧⏎ in the field and ⌘G / ⌘⇧G anywhere step; ⎋ in the field
   * closes, and so does the ×.
   *
   * The page is whatever this is mounted beside: the bar sits inside
   * `App.svelte`'s `.content`, so its parent is the transcript, the open
   * note's preview, the Welcome page — whichever is showing. It searches
   * that parent's visible text from outside (`find.ts`'s walker) and
   * lights the hits from outside (the Highlight API, or `<mark>`s where
   * the webview lacks it), so the message components are untouched. A
   * page that changes under an open search — a reply streaming in, a chat
   * switch, a note opened — is searched again on the next frame, the
   * current hit kept where it still exists.
   *
   * A note being edited is a textarea, which has no text nodes: find
   * works on the note's preview, not its editor.
   *
   * The search-everywhere panel (backlog 117, board 11b) hands off here:
   * `openWith(query, turn)` opens the bar without taking focus, searches,
   * and makes current the first hit inside the transcript's
   * `[data-turn]` for that message — resolved on the observer's re-search
   * when the chat has not rendered yet. The link at the bar's right goes
   * the other way: "search all chats" opens the panel with this query,
   * and "back to results" while the panel holds an answer.
   */

  let open = $state(false);
  let query = $state("");
  let hits = $state<Hit[]>([]);
  let current = $state<number | null>(null);
  let bar = $state<HTMLDivElement | null>(null);
  let field = $state<HTMLInputElement | null>(null);

  const label = $derived(countLabel(current, hits.length));

  let segments: Segments = { nodes: [], texts: [] };
  let painter: Highlighter | null = null;
  let observer: MutationObserver | null = null;
  let frame = 0;
  /** The turn `openWith` asked for and the page has not yet shown. */
  let pendingTurn: number | null = null;

  onMount(() => registerFindBar({ openWith, query: () => (open ? query : "") }));
  // The bar leaves with its pane's focus (`{#if focused}` in App.svelte):
  // an open one must take its light and its observer with it, or the
  // highlights stay painted on the page and the observer keeps scheduling
  // searches against a bar that is gone (review E, 2026-09-17).
  onDestroy(() => {
    close();
    registerFindBar(null);
  });

  /** The page: the bar's parent. Null before mount and while closed. */
  function page(): HTMLElement | null {
    return bar?.parentElement ?? null;
  }

  /** The bar itself and the toasts are chrome over the page, not the page. */
  function excluded(el: Element): boolean {
    return el === bar || el.classList.contains("toasts");
  }

  export async function show() {
    if (!open) {
      open = true;
      await tick();
      watch();
      if (query) search(true);
    }
    field?.focus();
    field?.select();
  }

  /**
   * The panel's hand-off: open with `q` (the focus stays where it is —
   * in the panel, whose arrows keep previewing), search, and land on the
   * first hit inside turn `turn` when one is on the page. A chat that is
   * still loading has no such turn yet: the request is kept and resolved
   * by the observer's re-search once the transcript renders.
   */
  export async function openWith(q: string, turn?: number) {
    query = q;
    pendingTurn = turn ?? null;
    if (!open) {
      open = true;
      await tick();
      watch();
    }
    search(true);
  }

  export function close() {
    if (!open) return;
    pendingTurn = null;
    unwatch();
    painter?.clear();
    painter = null;
    hits = [];
    current = null;
    segments = { nodes: [], texts: [] };
    open = false;
  }

  /**
   * Search the page for the field's text and light the hits. `fresh` puts
   * the current hit at the first one; otherwise the ordinal is kept across
   * a page change where it can be. The mark fallback edits the DOM, so the
   * observer stands aside while it paints.
   */
  function search(fresh: boolean) {
    const root = page();
    if (!root) return;
    if (!painter) painter = supportsHighlightApi() ? highlightApi() : markFallback(page);
    observer?.disconnect();
    painter.clear();
    segments = collectSegments(root, excluded);
    hits = findMatches(segments.texts, query);
    current = fresh ? (hits.length > 0 ? 0 : null) : keepHit(current, hits.length);
    let landed = false;
    if (pendingTurn !== null) {
      const i = hitInTurn(root, pendingTurn);
      if (i !== null) {
        current = i;
        pendingTurn = null;
        landed = true;
      }
    }
    painter.apply(segments, hits, current);
    if (fresh || landed) reveal();
    watch();
  }

  /**
   * The first hit whose text sits inside `[data-turn="turn"]`, or null.
   * A turn on the page with no hit inside it — the hit was in the chat's
   * name, or in text the transcript folds — gives up the request rather
   * than waiting for a render that will not come, and scrolls the turn
   * itself into view instead.
   */
  function hitInTurn(root: HTMLElement, turn: number): number | null {
    const sel = `[data-turn="${turn}"]`;
    for (let i = 0; i < hits.length; i++) {
      const node = segments.nodes[hits[i].start.seg];
      if (node?.parentElement?.closest(sel)) return i;
    }
    const el = root.querySelector<HTMLElement>(sel);
    if (el) {
      pendingTurn = null;
      const r = root.ownerDocument.createRange();
      r.selectNodeContents(el);
      scrollRangeIntoView(r, root);
    }
    return null;
  }

  /** Re-light with a new current hit and bring it into view. */
  function step(dir: 1 | -1) {
    const root = page();
    if (!root || !painter) return;
    current = stepHit(current, dir, hits.length);
    observer?.disconnect();
    painter.clear();
    painter.apply(segments, hits, current);
    watch();
    reveal();
  }

  /** Scroll the current hit into the middle of its scroller. */
  function reveal() {
    const root = page();
    if (!root || current === null) return;
    let range: Range | null = null;
    if (painter?.mutates) {
      const mark = currentMark(root);
      if (mark) {
        range = root.ownerDocument.createRange();
        range.selectNodeContents(mark);
      }
    } else {
      range = hitRange(segments, hits[current]);
    }
    if (range) scrollRangeIntoView(range, root);
  }

  /** Watch the page for changes and search again on the next frame. */
  function watch() {
    const root = page();
    if (!root) return;
    if (!observer) {
      observer = new MutationObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (open) search(false);
        });
      });
    }
    observer.observe(root, { childList: true, characterData: true, subtree: true });
  }

  function unwatch() {
    observer?.disconnect();
    observer = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function onInput() {
    pendingTurn = null;
    search(true);
  }

  /** The bar's link: the panel, with this query (board 11c's "from ⌘F"),
   *  or back to the results it already holds. */
  function toPanel() {
    if (!app.search.result) app.search.query = query;
    if (app.layout.sidebarCollapsed) toggleSidebar();
    app.search.open = true;
  }

  function fieldKeys(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  /** ⌘G / ⌘⇧G step from anywhere while the bar is open; ⌘F is App.svelte's. */
  function windowKeys(e: KeyboardEvent) {
    if (!open) return;
    const chord = findChord(e, isMac ? e.metaKey : e.ctrlKey);
    if (chord === "next" || chord === "prev") {
      e.preventDefault();
      step(chord === "next" ? 1 : -1);
    }
  }
</script>

<svelte:window onkeydown={windowKeys} />

{#if open}
  <div class="find-bar" bind:this={bar} role="search" aria-label="Find in page">
    <input
      class="find-field"
      bind:this={field}
      bind:value={query}
      oninput={onInput}
      onkeydown={fieldKeys}
      placeholder="Find"
      aria-label="Find in page"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="find-count" class:none={query.length > 0 && hits.length === 0}>{label}</span>
    <button class="find-btn up" title="Previous match (⇧⏎)" disabled={hits.length === 0} onclick={() => step(-1)}>
      <Icon name="chev" size={12} />
    </button>
    <button class="find-btn" title="Next match (⏎)" disabled={hits.length === 0} onclick={() => step(1)}>
      <Icon name="chev" size={12} />
    </button>
    <button class="find-btn" title="Close (⎋)" onclick={close}>
      <Icon name="x" size={12} />
    </button>
    {#if !app.search.open}
      <span class="find-sep"></span>
      <button class="find-link" onclick={toPanel}>
        {app.search.result ? "back to results" : "search all chats"}
        <span class="find-link-key">{SEARCH_CHORD_LABEL}</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  /* Positioned by `App.svelte`'s `.content`, the transcript's area: top
     right, clear of the message navigator's strip at the right edge. */
  .find-bar {
    position: absolute;
    top: 8px;
    right: 26px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    font-family: var(--sans);
  }
  .find-field {
    width: 14rem;
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    outline: none;
  }
  .find-field:focus {
    border-color: var(--accent);
  }
  .find-field::placeholder {
    color: var(--dim);
  }
  .find-count {
    min-width: 4.5rem;
    padding: 0 6px;
    font-size: 11.5px;
    color: var(--dim);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .find-count.none {
    color: var(--failed);
  }
  .find-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--ink2);
    cursor: pointer;
  }
  .find-btn:hover:not(:disabled) {
    background: var(--well);
    color: var(--ink);
  }
  .find-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .find-btn.up :global(svg) {
    transform: rotate(180deg);
  }
  /* The link to the search panel (backlog 117), after a hairline. */
  .find-sep {
    width: 1px;
    height: 16px;
    background: var(--line2);
    margin: 0 2px;
  }
  .find-link {
    background: transparent;
    border: none;
    padding: 0 4px;
    font: inherit;
    font-size: 11.5px;
    color: var(--accent-ink);
    cursor: pointer;
    white-space: nowrap;
  }
  .find-link:hover {
    text-decoration: underline;
  }
  .find-link-key {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    margin-left: 4px;
  }
</style>
