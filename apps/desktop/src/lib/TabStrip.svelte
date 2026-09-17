<script lang="ts">
  import {
    activateTab,
    app,
    closeTab,
    moveTab,
    newTab,
    splitTab,
  } from "./state.svelte";
  import { hasDraft, newDraftKey } from "./drafts.svelte";
  import * as tabs from "./tabs";
  import { TAB_DRAG, type Pane } from "./tabs";
  import Icon from "./Icon.svelte";
  import { isMac } from "./platform";

  /**
   * One pane's strip of tabs (nightshift backlog 099, boards 9a and 9d):
   * a glyph for the kind, the title, a pulsing dot while the chat's turn
   * runs, the needs-you dot when it waits on him, ✎ for a draft, × on
   * hover. `+` opens a new chat in a new tab (⌘T). The active tab is the
   * sheet; the focused pane's active tab carries the accent rule on top,
   * so with two panes one strip says which the keys act on.
   *
   * Tabs drag: within the strip to reorder, onto the other pane's strip
   * to move, onto a pane's half to split — the halves are `App.svelte`'s
   * drop zones; this strip owns the reorder and the move. The drag carries
   * the tab's id under its own type, so a file or text dropped here is
   * nothing to it.
   */
  let { pane }: { pane: Pane } = $props();

  const focused = $derived(app.tabs.focused === pane.id);
  const live = $derived(tabs.liveTab(app.tabs, app.activeSessionId));

  function title(t: tabs.Tab): string {
    return tabs.tabTitle(t.content, app.sessions);
  }

  function draft(t: tabs.Tab): boolean {
    const c = t.content;
    if (c.kind === "note") {
      const key = `${c.scope}:${c.name}`;
      return app.noteDrafts[key] !== undefined;
    }
    return hasDraft(c.session ?? newDraftKey(app.project?.id, app.pendingMode));
  }

  /** The chat's turn runs, or waits on him — only the live tab can. */
  function running(t: tabs.Tab): boolean {
    return live?.id === t.id && app.busy;
  }
  function needsYou(t: tabs.Tab): boolean {
    return live?.id === t.id && app.pendingApprovals.length > 0;
  }

  function hint(t: tabs.Tab): string {
    const c = t.content;
    const base = c.kind === "note" ? `${c.name} — a note` : title(t);
    const state = needsYou(t) ? " · waiting on you" : running(t) ? " · a turn is running" : "";
    return `${base}${state} — ${isMac ? "⌘W" : "Ctrl+W"} closes`;
  }

  // ---- drag and drop ----

  /** Where a dragged tab would land in this strip, as an index; null when
   *  nothing is over it. */
  let dropAt = $state<number | null>(null);
  let stripEl = $state<HTMLElement | null>(null);

  function onDragStart(e: DragEvent, t: tabs.Tab) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(TAB_DRAG, t.id);
    e.dataTransfer.effectAllowed = "move";
    app.draggingTab = t.id;
  }
  function onDragEnd() {
    app.draggingTab = null;
    dropAt = null;
  }
  function indexAt(e: DragEvent): number {
    if (!stripEl) return pane.tabs.length;
    const els = Array.from(stripEl.querySelectorAll<HTMLElement>("[data-tab]"));
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  }
  function onDragOver(e: DragEvent) {
    if (!app.draggingTab) return;
    e.preventDefault();
    // The strip's drop is the strip's: the pane behind it draws the
    // *open beside* halves for a drag over its content, not over its tabs.
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropAt = indexAt(e);
  }
  function onDragLeave(e: DragEvent) {
    if (stripEl && e.relatedTarget instanceof Node && stripEl.contains(e.relatedTarget)) return;
    dropAt = null;
  }
  function onDrop(e: DragEvent) {
    const id = e.dataTransfer?.getData(TAB_DRAG) || app.draggingTab;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const at = dropAt ?? indexAt(e);
    dropAt = null;
    app.draggingTab = null;
    void moveTab(id, pane.id, at);
  }

  // ---- the tab's menu (right-click) ----

  let menuFor = $state<string | null>(null);
  let menuAt = $state({ x: 0, y: 0 });
  function openMenu(e: MouseEvent, t: tabs.Tab) {
    e.preventDefault();
    menuFor = t.id;
    menuAt = { x: e.clientX, y: e.clientY };
  }
  function closeOthers(id: string) {
    for (const t of [...pane.tabs]) if (t.id !== id) void closeTab(t.id);
  }
  const canSplit = $derived(app.tabs.panes.length < tabs.MAX_PANES && pane.tabs.length > 1);
  const other = $derived(tabs.otherPane(app.tabs, pane.id));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_interactive_supports_focus -->
<div
  class="tab-strip"
  class:focused
  role="tablist"
  tabindex="-1"
  bind:this={stripEl}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#each pane.tabs as t, i (t.id)}
    {#if dropAt === i}<span class="tab-drop"></span>{/if}
    <!-- A div, not a button: a button cannot hold the close button, and
         the strip's keys are the window's (⌘⇧] / ⌘⇧[). Focusable so the
         Tab key reaches it; ↵ and Space activate. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tab"
      class:active={pane.active === t.id}
      class:dragging={app.draggingTab === t.id}
      role="tab"
      tabindex="0"
      aria-selected={pane.active === t.id}
      data-tab={t.id}
      draggable="true"
      title={hint(t)}
      onclick={() => void activateTab(t.id)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void activateTab(t.id);
        }
      }}
      onauxclick={(e) => {
        // The middle button closes, as in every browser.
        if (e.button === 1) void closeTab(t.id);
      }}
      oncontextmenu={(e) => openMenu(e, t)}
      ondragstart={(e) => onDragStart(e, t)}
      ondragend={onDragEnd}
    >
      <span class="glyph" aria-hidden="true"><Icon name={t.content.kind === "note" ? "note" : "chat"} size={12} /></span>
      <span class="name">{title(t)}</span>
      {#if needsYou(t)}
        <span class="dot needs" title="Waiting on you"></span>
      {:else if running(t)}
        <span class="dot run" title="A turn is running"></span>
      {/if}
      {#if draft(t)}<span class="mark" title="has a draft">✎</span>{/if}
      <button
        class="close"
        title="Close tab ({isMac ? '⌘W' : 'Ctrl+W'})"
        aria-label="Close tab"
        tabindex="-1"
        onclick={(e) => {
          e.stopPropagation();
          void closeTab(t.id);
        }}
      >
        <Icon name="x" size={10} />
      </button>
    </div>
  {/each}
  {#if dropAt === pane.tabs.length}<span class="tab-drop"></span>{/if}
  <button class="tab-new" title="New tab ({isMac ? '⌘T' : 'Ctrl+T'})" aria-label="New tab" onclick={() => void newTab()}>
    <Icon name="plus" size={12} />
  </button>
  <!-- The terminal pane's dock button lives in `App.svelte`'s pane foot,
       not here: the strip is the tabs' and stays the tabs'. -->
</div>

{#if menuFor}
  {@const t = pane.tabs.find((x) => x.id === menuFor)}
  <button class="tab-scrim" aria-label="Close" onclick={() => (menuFor = null)} oncontextmenu={(e) => { e.preventDefault(); menuFor = null; }}></button>
  <div class="tab-menu" role="menu" style:left="{menuAt.x}px" style:top="{menuAt.y}px">
    <button role="menuitem" onclick={() => { menuFor = null; if (t) void closeTab(t.id); }}>Close</button>
    <button role="menuitem" disabled={pane.tabs.length < 2} onclick={() => { menuFor = null; if (t) closeOthers(t.id); }}>Close others</button>
    {#if other}
      <button role="menuitem" onclick={() => { menuFor = null; if (t) void moveTab(t.id, other.id, other.tabs.length); }}>Move to the other pane</button>
    {:else}
      <button role="menuitem" disabled={!canSplit} title={canSplit ? "" : "A pane keeps at least one tab"} onclick={() => { menuFor = null; if (t) void splitTab(t.id, "right"); }}>Open beside</button>
    {/if}
  </div>
{/if}

<style>
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    height: 36px;
    padding: 4px 8px 0;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    flex-shrink: 0;
    min-width: 0;
  }
  .tab-strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 10px;
    max-width: 200px;
    min-width: 0;
    flex: 0 1 auto;
    border-radius: 6px 6px 0 0;
    color: var(--dim);
    font-size: 12.5px;
    cursor: default;
    user-select: none;
    border-top: 2px solid transparent;
  }
  .tab:hover {
    background: var(--well);
    color: var(--ink2);
  }
  .tab.active {
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 0 0 1px var(--line);
  }
  /* The accent rule on the focused pane's active tab (board 9d). */
  .tab-strip.focused .tab.active {
    border-top-color: var(--accent);
  }
  .tab.dragging {
    opacity: 0.4;
    border-style: dashed;
  }
  .glyph {
    display: inline-flex;
    color: var(--dim);
    flex-shrink: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.run {
    background: var(--accent);
    animation: tab-pulse 1.2s ease-in-out infinite;
  }
  .dot.needs {
    background: var(--live);
  }
  @keyframes tab-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  .mark {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--dim);
    padding: 0;
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
  }
  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }
  .close:hover {
    background: var(--line2);
    color: var(--ink);
  }
  .tab-new {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    margin: 3px 0 0 2px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--dim);
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .tab-new:hover {
    background: var(--well);
    color: var(--ink);
  }
  .tab-drop {
    width: 2px;
    margin: 4px 0;
    background: var(--accent);
    border-radius: 1px;
    flex-shrink: 0;
  }
  .tab-scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    cursor: default;
    padding: 0;
  }
  .tab-menu {
    position: fixed;
    z-index: 36;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .tab-menu button {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--ink2);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .tab-menu button:hover:not(:disabled) {
    background: var(--well);
    color: var(--ink);
  }
  .tab-menu button:disabled {
    color: var(--dim);
    cursor: default;
  }
</style>
