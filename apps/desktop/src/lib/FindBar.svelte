<script lang="ts">
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { isMac } from "./platform";
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

  export function close() {
    if (!open) return;
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
    painter.apply(segments, hits, current);
    if (fresh) reveal();
    watch();
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
    search(true);
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
</style>
