<script lang="ts">
  import CacheDot from "./CacheDot.svelte"; // Item 1022: the cache dot before a chat's name
  import { hudIn, hudOut } from "./hudMenu";
  import { tip } from "./tip";
  import { dragScroll } from "./dragScroll";
  import { activateTab, app, closeTab, moveTab, splitTab } from "./state.svelte";
  import { UNSAVED_TIP } from "./unsavedCue";
  import { selectAllOnMount } from "./renameField";
  import * as tabs from "./tabs";
  import { FORK_GLYPH } from "./forkMark";
  import Icon from "./Icon.svelte";
  import { tabIn, tabOut } from "./tabMotion";
  import TabChooser from "./TabChooser.svelte";
  import RunningBadge from "./RunningBadge.svelte";
  import NeedsYouBadge from "./NeedsYouBadge.svelte";
  import { isMac } from "./platform";
  import { web, webLabel } from "./webtabs.svelte";
  import { tabDrag } from "./tabDrag.svelte";
  // Item 299: Make main on a fork's tab, as on its sidebar row.
  import { canMakeMain } from "./versions";
  import { makeMainChat, versions } from "./versions.svelte";
  import { tabStripLogic, type TabStripLogicProps } from "./tabStrip/logic.svelte";

  // Item 856: the behaviour lives once, in `tabStrip/logic.svelte.ts`; this file is the look.
  const props: TabStripLogicProps = $props();
  const T = tabStripLogic(() => props);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_interactive_supports_focus -->
<div
  class="tab-strip"
  use:dragScroll={{ axis: "x" }}
  class:focused={T.focused}
  role="tablist"
  tabindex="-1"
  bind:this={T.stripEl}
  ondragover={T.onDragOver}
  ondragleave={T.onDragLeave}
  ondrop={T.onDrop}
  onpointermove={() => T.freeze.moved()}
  onpointerleave={() => T.freeze.thaw()}
>
  {#each T.pane.tabs as t, i (t.id)}
    {@const favicon = t.content.kind === "web" ? web.live[webLabel(t.id)]?.favicon : undefined}
    {#if T.dropAt === i || T.dragMark === i}<span class="tab-drop"></span>{/if}
    <!-- A div, not a button: a button cannot hold the close button, and
         the strip's keys are the window's (⌘⇧] / ⌘⇧[). Focusable so the
         Tab key reaches it; ↵ and Space activate. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tab"
      class:active={T.pane.active === t.id}
      class:dragging={app.draggingTab === t.id}
      role="tab"
      tabindex="0"
      aria-selected={T.pane.active === t.id}
      data-tab={t.id}
      style:flex={T.frozenW !== null ? `0 0 ${T.frozenW}px` : undefined}
      in:tabIn
      out:tabOut
      use:tip={T.hint(t)}
      onpointerdown={(e) => T.onTabPointerDown(e, t)}
      onclick={() => void activateTab(t.id)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void activateTab(t.id);
        }
      }}
      onauxclick={(e) => {
        // The middle button closes, as in every browser.
        if (e.button === 1) T.closeFromStrip(e, t);
      }}
      oncontextmenu={(e) => T.openMenu(e, t)}
    >
      <span class="glyph" aria-hidden="true"
        >{#if favicon}<img class="favicon" src={favicon} alt="" width="12" height="12" referrerpolicy="no-referrer" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />{:else}<Icon
            name={tabs.tabGlyph(t.content)}
            size={12}
          />{/if}</span
      >
      {#if T.renamingTab === t.id}
        <input autocorrect="off" autocapitalize="off" spellcheck="false"
          class="name rename"
          aria-label="Chat name"
          bind:value={T.tabDraft}
          use:selectAllOnMount
          onpointerdown={(e) => e.stopPropagation()}
          onclick={(e) => e.stopPropagation()}
          onblur={() => void T.commitTabRename(t)}
          onkeydown={(e) => {
            // The tab's own keys (↵ and Space activate) stay out of the field.
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") T.renamingTab = null;
          }}
        />
      {:else}
        {@const f = T.fork(t)}
        <!-- Item 534: the state dot before the title, as the mockup's live
             tab — the signal while a turn runs, the accent while it waits
             on him. -->
        {#if T.needsYou(t)}
          <span class="dot needs" use:tip={"Waiting on you"}></span>
        {:else if T.running(t)}
          <span class="dot run" use:tip={"A turn is running"}></span>
        {/if}
        {#if f}<span class="fork" role="img" aria-label={f.tip} use:tip={f.tip}>{FORK_GLYPH}</span>{/if}
        {#if t.content.kind === "chat"}<CacheDot session={t.content.session} />{:else if t.content.kind === "aside"}<CacheDot session={t.content.session} thread={t.content.thread} aside />{/if}
        <span class="name">{T.title(t)}</span>
      {/if}
      <!-- Item 867: on a note's tab the ring says its edits are not on disk yet. -->
      {#if T.draft(t)}{@const words = t.content.kind === "note" ? UNSAVED_TIP : "has a draft"}<span
          class="mark"
          class:unsaved={t.content.kind === "note"}
          role="img"
          aria-label={words}
          use:tip={words}
        ></span>{/if}
      <button
        class="close"
        use:tip={`Close tab (${isMac ? '⌘W' : 'Ctrl+W'})`}
        aria-label="Close tab"
        tabindex="-1"
        onclick={(e) => {
          e.stopPropagation();
          T.closeFromStrip(e, t);
        }}
      >
        <Icon name="x" size={10} />
      </button>
    </div>
  {/each}
  {#if T.dropAt === T.pane.tabs.length || T.dragMark === T.pane.tabs.length}<span class="tab-drop"></span>{/if}
  <!-- The + (backlog 140): a chooser of what the new tab becomes. ⌘T is
       still the one-key new chat and lives in the File menu. -->
  <button
    class="tab-new"
    class:open={T.chooser}
    use:tip={"New tab… (⌘T is a new chat)"}
    aria-label="New tab"
    aria-expanded={T.chooser}
    onclick={() => (T.chooser = !T.chooser)}
  >
    <Icon name="plus" size={12} />
  </button>
  <!-- The terminal pane's dock button lives in `App.svelte`'s pane foot,
       not here: the strip is the tabs' and stays the tabs'. The one
       exception is the running badge (backlog 309): the strip is the only
       bar drawn over every view. -->
  {#if T.lastPane}<NeedsYouBadge /><RunningBadge />{/if}
</div>
{#if T.catching}
  <!-- Item 877: the strip's drop, reached before the strip (and before the
       top of the screen, where macOS opens Mission Control). -->
  <div
    class="strip-catch"
    aria-hidden="true"
    bind:this={T.catchEl}
    style:top="{T.catchTop()}px"
    style:height="{T.BAND_PX}px"
    ondragover={T.onCatchDragOver}
    ondragleave={T.onDragLeave}
    ondrop={T.onDrop}
  ></div>
{/if}
{#if T.ghost}
  <!-- The dragged tab under the pointer (backlog 195); after a drag that
       does nothing it flies back to its tab (`home`), then goes. -->
  <div
    class="tab-ghost"
    class:home={T.ghost.home !== null}
    aria-hidden="true"
    style:width="{T.ghost.width}px"
    style:left="{T.ghost.home ? T.ghost.home.left : tabDrag.x - T.ghost.dx}px"
    style:top="{T.ghost.home ? T.ghost.home.top : tabDrag.y - T.ghost.dy}px"
    style:transition-duration="{T.SNAP_MS}ms"
  >
    <span class="glyph"><Icon name={tabs.tabGlyph(T.ghost.tab.content)} size={12} /></span>
    {#if T.fork(T.ghost.tab)}<span class="fork" aria-hidden="true">{FORK_GLYPH}</span>{/if}
    <span class="name">{T.title(T.ghost.tab)}</span>
  </div>
{/if}
{#if T.chooser}
  <TabChooser paneId={T.pane.id} close={() => (T.chooser = false)} />
{/if}

{#if T.menuFor}
  {@const t = T.pane.tabs.find((x) => x.id === T.menuFor)}
  <button class="tab-scrim" aria-label="Close" onclick={() => (T.menuFor = null)} oncontextmenu={(e) => { e.preventDefault(); T.menuFor = null; }}></button>
  <div class="tab-menu hud-m" role="menu" use:T.placeTabMenu={T.menuAt} in:hudIn|global out:hudOut|global>
    <button role="menuitem" onclick={() => T.menuAct((x) => void closeTab(x.id))}>Close</button>
    <button role="menuitem" disabled={T.pane.tabs.length < 2} onclick={() => T.menuAct((x) => T.closeOthers(x.id))}>Close others</button>
    {#if T.other}
      <button role="menuitem" onclick={() => T.menuAct((x) => void moveTab(x.id, T.other!.id, T.other!.tabs.length))}>Move to the other pane</button>
    {:else}
      <button role="menuitem" disabled={!T.canSplit} use:tip={T.canSplit ? "" : "A pane keeps at least one tab"} onclick={() => T.menuAct((x) => void splitTab(x.id, "right"))}>Open beside</button>
    {/if}
    {#if t?.content.kind === "chat" && t.content.session}
      <button role="menuitem" onclick={() => T.menuAct(T.startTabRename)}>Rename</button>
    {/if}
    {#if t?.content.kind === "chat" && t.content.session && canMakeMain(app.sessions, versions.map, t.content.session)}
      <button role="menuitem" use:tip={"Put this fork in its original's row, name and place; the original stays a version under the edited message"} onclick={() => T.menuAct((x) => { if (x.content.kind === "chat" && x.content.session) void makeMainChat(x.content.session); })}>Make main</button>
    {/if}
  </div>
{/if}

<style>
  /* Item 877: invisible; the strip's own drop marker is its cue. Over the
     pane's open-beside zone (z-index 8), under menus. */
  .strip-catch {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 9;
  }
  /* Item 534 (Filament IV): the strip is a panel; tabs are flat cells
     ruled at their right, the active one cut into the ground below with
     the accent along its top. */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 0;
    height: 38px;
    padding: 0;
    background: var(--sheet);
    /* The strip's foot rule as an inset shadow, under its children: the
       active tab's ground paints over it, so the tab opens into the page. */
    box-shadow: inset 0 -1px 0 var(--line);
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
    gap: 8px;
    padding: 0 10px 0 14px;
    max-width: 240px;
    min-width: 0;
    /* Item 603: one width for every tab, as Chrome's — a share of the strip
       up to 240 px, not the title's length. A close from the strip holds
       it (`frozenW`, inline) until the pointer leaves. */
    flex: 1 1 0;
    border-right: 1px solid var(--line);
    color: var(--dim);
    font-size: 12.5px;
    cursor: default;
    user-select: none;
  }
  .tab:hover {
    background: var(--raised);
    color: var(--ink2);
  }
  .tab.active {
    background: var(--paper);
    color: var(--ink);
  }
  /* The accent rule on the focused pane's active tab (board 9d). */
  .tab-strip.focused .tab.active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: var(--accent);
    pointer-events: none;
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
  /* A web tab's page icon (backlog 172), in the glyph's square. */
  .favicon {
    width: 12px;
    height: 12px;
    object-fit: contain;
  }
  /* The fork mark (backlog 379): never shrinks, so a narrow tab
     truncates the title and keeps the mark. */
  .fork {
    flex-shrink: 0;
    color: var(--dim);
    font-size: 0.95em;
    line-height: 1;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* The title as a field while it is renamed (backlog 376). */
  input.rename {
    flex: 1;
    width: 0;
    padding: 1px 4px;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    outline: none;
  }
  /* ~~Running in the accent, pulsing; waiting in the live blue~~ — item
     534, the colour rule of Filament IV: blue is Claude working, amber is
     his. The running dot is lit in IV+ (`--glow-live`) and pulses only
     with motion allowed. */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.run {
    background: var(--signal);
    box-shadow: var(--glow-live);
  }
  @media (prefers-reduced-motion: no-preference) {
    .dot.run {
      animation: tab-pulse 1.6s ease-in-out infinite;
    }
  }
  .dot.needs {
    background: var(--accent);
  }
  @keyframes tab-pulse {
    50% {
      opacity: 0.45;
    }
  }
  /* The draft mark (backlog 221, blocker 480 answered "hollow ring sounds
     fine"): ~~a ✎ glyph, which he found clunky~~ — a hollow accent ring,
     kin to the sidebar's filled draft dot (208) and hollow so it cannot be
     read as the filled, pulsing running dot beside it. */
  .mark {
    box-sizing: border-box;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1.5px solid var(--accent);
    flex-shrink: 0;
  }
  /* Item 867: a note tab's ring (unsaved edits) is lit in his amber; Calm's
     --glow-accent is none. */
  .mark.unsaved {
    width: 7px;
    height: 7px;
    box-shadow: var(--glow-accent, none);
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
    /* Item 603: at the tab's right edge whatever the title's length, so
       every tab's × sits at the same place in its tab — the one that
       slides in under the pointer is under it. */
    margin-left: auto;
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
    width: 28px;
    height: 28px;
    margin: 5px 0 0 6px;
    border: none;
    border-radius: var(--r1);
    background: transparent;
    color: var(--dim);
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .tab-new:hover,
  .tab-new.open {
    background: var(--well);
    color: var(--ink);
  }
  .tab-ghost {
    position: fixed;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    box-sizing: border-box;
    border-radius: 0;
    border-top: 2px solid var(--accent);
    background: var(--paper);
    color: var(--ink);
    font-size: 12.5px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    opacity: 0.92;
    pointer-events: none;
    transition-property: none;
  }
  .tab-ghost.home {
    transition-property: left, top, opacity;
    transition-timing-function: ease-out;
    opacity: 0.4;
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
    /* Item 477: capped by placeMenu only when taller than the window. */
    overflow-y: auto;
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
