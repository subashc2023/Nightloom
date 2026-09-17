<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    activateTab,
    app,
    closePrompts,
    focusPane,
    init,
    inTextField,
    moveTab,
    paneWidth,
    reflectTabs,
    runMenuCommand,
    runToastAction,
    setPaneWidth,
    splitTab,
    syncUndoMenu,
    setSidebarWidth,
    sidebarColumn,
    syncPromptLayers,
    toggleSidebar,
    SIDEBAR_MAX,
    SIDEBAR_MIN,
  } from "./lib/state.svelte";
  import * as tabs from "./lib/tabs";
  import TabStrip from "./lib/TabStrip.svelte";
  import { isMac } from "./lib/platform";
  import { toggleTranscriptPref } from "./lib/transcriptPrefs.svelte";
  import { thinkingToggleDead } from "./lib/activity";
  import { initZoom, runZoom, zoomChord } from "./lib/zoom";
  import { findChord } from "./lib/find";
  import FindBar from "./lib/FindBar.svelte";
  import Grip from "./lib/Grip.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import TitleBar from "./lib/TitleBar.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import ContextPanel from "./lib/ContextPanel.svelte";
  import PromptLibrary from "./lib/PromptLibrary.svelte";
  import Transcript from "./lib/Transcript.svelte";
  import Composer from "./lib/Composer.svelte";
  import NoteView from "./lib/NoteView.svelte";
  import GraphView from "./lib/GraphView.svelte";
  import Welcome from "./lib/Welcome.svelte";
  import NewProject from "./lib/NewProject.svelte";
  import Palette from "./lib/Palette.svelte";
  import NightshiftSurface from "./lib/NightshiftSurface.svelte";
  import TerminalDock from "./lib/TerminalDock.svelte";
  import Icon from "./lib/Icon.svelte";

  onMount(() => {
    void init();
    // The stored zoom back on the window, and the View menu's zoom items
    // (nightshift backlog 108).
    void initZoom();
  });

  /**
   * The engine is built once per rail change and a chat's switched-off
   * prompt layers live in its log, so opening a different chat can leave
   * the wire carrying the last chat's prompt. Re-checked whenever the open
   * chat changes, and again when a turn or a connect ends, since the sync
   * itself stands aside while either is in flight (`syncPromptLayers`).
   *
   * The pending kind is a dependency too (nightshift backlog 061): New chat
   * from the blank state leaves `activeSessionId` null as it was, and a
   * pending incognito chat needs its engine built without writers before
   * the first message, not one reconnect after it.
   */
  $effect(() => {
    void app.activeSessionId;
    void app.pendingMode;
    void app.connecting;
    void app.busy;
    void syncPromptLayers();
  });

  /**
   * The macOS Edit menu's Undo and Redo follow the stack and the open chat
   * (nightshift backlog 064): retitled with the operation, disabled when
   * there is nothing to reverse and no text box has the focus. The focus
   * half is the two window events below.
   */
  $effect(() => {
    void app.activeSessionId;
    void app.undoTick;
    void syncUndoMenu();
  });

  /**
   * The tab model's reflection (nightshift backlog 099): whenever the view,
   * the open chat or the open note changes, the focused pane's active tab
   * is made to hold it — see `reflectTabs`. Untracked inside, since it
   * writes the workspace this component also draws.
   */
  $effect(() => {
    void app.view;
    void app.activeSessionId;
    void app.openNote;
    untrack(() => reflectTabs());
  });

  /**
   * The views that are tabs — a chat, a note — against the ones that take
   * the whole centre as they always have: the graph, Nightshift, the New
   * project form. The panes draw only for the first kind.
   */
  const tabbed = $derived(app.view === "chat" || app.view === "note");
  /** The tab whose chat is the open one; its pane draws the transcript. */
  const liveTab = $derived(tabs.liveTab(app.tabs, app.activeSessionId));
  /**
   * The pane that carries the top bar: the bar describes the open chat, so
   * it sits over the pane showing it, and over the focused pane when no
   * pane does (both showing notes, say — the chat is open underneath).
   */
  const barPane = $derived(
    (liveTab ? tabs.paneOf(app.tabs, liveTab.id)?.id : undefined) ?? app.tabs.focused,
  );
  /** The split's geometry: the left pane's width, saved as a pane pref. */
  let splitWidth = $state(0);
  const SPLIT_MIN = 280;
  const leftPx = $derived(
    Math.max(SPLIT_MIN, Math.min(splitWidth - SPLIT_MIN, paneWidth("split", Math.round(splitWidth / 2)))),
  );

  /**
   * A tab dragged over a pane's content: which half, for the *open beside*
   * zone (board 9e). The strip takes drops of its own; this is the rest of
   * the pane.
   */
  let dropHalf = $state<{ pane: string; side: "left" | "right" } | null>(null);
  function onPaneDragOver(e: DragEvent, paneId: string) {
    if (!app.draggingTab) return;
    // Over the strip the strip answers (it stops the event); this guard
    // is for a strip that has not — a synthetic event, say.
    if (e.target instanceof Element && e.target.closest(".tab-strip")) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const side = e.clientX < r.left + r.width / 2 ? "left" : "right";
    if (dropHalf?.pane !== paneId || dropHalf.side !== side) dropHalf = { pane: paneId, side };
  }
  function onPaneDragLeave(e: DragEvent) {
    const el = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    dropHalf = null;
  }
  function onPaneDrop(e: DragEvent, paneId: string) {
    if (e.target instanceof Element && e.target.closest(".tab-strip")) return;
    const id = e.dataTransfer?.getData(tabs.TAB_DRAG) || app.draggingTab;
    const half = dropHalf;
    dropHalf = null;
    if (!id) return;
    e.preventDefault();
    app.draggingTab = null;
    const from = tabs.paneOf(app.tabs, id);
    if (app.tabs.panes.length < tabs.MAX_PANES) {
      // One pane: a drop on either half opens the second pane on that side.
      void splitTab(id, half?.side ?? "right");
    } else if (from && from.id !== paneId) {
      // Two panes: a drop on the other pane's content moves the tab there.
      const to = tabs.paneById(app.tabs, paneId);
      if (to) void moveTab(id, paneId, to.tabs.length);
    }
  }

  /**
   * A conversation with nothing in it yet gets the launcher instead of an
   * empty transcript with a docked composer: an empty pane is where the two
   * questions that actually start a chat belong — which folder, and what do
   * you want. `app.live` is checked as well as the log so the switch happens
   * on the first send rather than on the re-sync a whole turn later.
   *
   * "Nothing in it" means no message, not no event (review round 1,
   * 2026-09-13): a session re-opened from the sidebar carries its
   * `session_created` line, and on the old test that one line turned the
   * Welcome page into an empty transcript. New chat and the empty session it
   * made now show the same page — and since 2026-09-15 (nightshift backlog
   * 061) New chat makes no session at all: `app.events` is `[]` until the
   * first message, which is blank by the same test.
   */
  const blank = $derived(
    !app.live &&
      !app.events.some(
        (e) =>
          e.event === "user_message" ||
          e.event === "assistant_message" ||
          e.event === "compaction",
      ),
  );

  /** The find bar (nightshift backlog 106), for ⌘F below. */
  let findBar = $state<FindBar | null>(null);

  /**
   * The redesign's shortcuts (nightshift blocker 035) on Windows and Linux,
   * where there is no menu bar to carry accelerators. On macOS the same keys
   * arrive as `menu` events from `mac_menu`, and binding them here as well
   * would fire each command twice — so this table is off there.
   */
  const KEYS: Record<string, string> = {
    k: "commands",
    p: "projects",
    m: "model",
    e: "engine",
    z: "undo_app",
    y: "redo_app",
    // Ctrl+N is a new Claude Code chat (nightshift backlog 102,
    // 2026-09-16); Ctrl+Alt+N a new Chat, in `onShortcut` below since
    // this table is for bare chords. On macOS the File menu carries both.
    n: "new_build",
  };
  const SHIFT_KEYS: Record<string, string> = {
    s: "model_sonnet",
    o: "model_opus",
    f: "model_fable",
    h: "model_haiku",
    // ⌘⇧N is an incognito chat (nightshift backlog 059, 2026-09-15); on
    // macOS the File menu carries it.
    n: "new_incognito",
    // Ctrl+Shift+Z redoes, beside Ctrl+Y (nightshift backlog 064); on
    // macOS the Edit menu carries ⌘Z and ⌘⇧Z.
    z: "redo_app",
  };
  function onShortcut(e: KeyboardEvent): boolean {
    // Ctrl+Alt+N is a new Chat on Windows and Linux (nightshift backlog
    // 102); on macOS ⌥⌘N arrives from the File menu. The one Option chord
    // in the app — blocker 035's table has none — so every other Alt
    // chord is still the platform's.
    if (e.altKey) {
      if (!isMac && e.ctrlKey && !e.shiftKey && e.code === "KeyN") {
        runMenuCommand("new_talk");
        return true;
      }
      return false;
    }
    // Undo and redo (nightshift backlog 064): app-level only when the
    // focus is not in a text box, whose own history the key belongs to —
    // so the handler steps aside there and lets the box have it. ⌘Y is
    // the redo he asked for, on every platform, since no menu item
    // carries it; ⌘Z and ⌘⇧Z arrive from the macOS Edit menu, and on the
    // other platforms from the tables below.
    const primary = isMac ? e.metaKey : e.ctrlKey;
    // Since 2026-09-16 the Edit menu's Redo *is* ⌘Y (his ask), so on macOS
    // it arrives as a menu event and this branch would double-fire; there
    // the window handler carries ⌘⇧Z instead, which is no longer a menu
    // item. Both go through `redo_app`, which hands a text box its own
    // redo. Other platforms keep the ⌘Y branch and the tables below.
    if (isMac) {
      if (primary && e.shiftKey && e.code === "KeyZ") {
        runMenuCommand("redo_app");
        return true;
      }
    } else if (primary && !e.shiftKey && e.code === "KeyY") {
      runMenuCommand("redo_app");
      return true;
    }
    // ⌘1…9 (Ctrl+1…9 elsewhere) is the n-th provider pill, on every
    // platform: it is not a menu item, so macOS cannot double-fire it.
    // Bare ⌘, not ⌘⇧, since his second look (2026-09-13): "anthropic
    // shouldn't be special" — the alias letters need Shift, the providers
    // do not. Matched on the physical key so a layout cannot move it.
    // Settings open: ⌘1…9 and ⌘[ / ⌘] are the modal's — its groups and
    // its next/previous pane (nightshift backlog 109) — and the app's
    // provider and model digits wait for it to close. `SettingsModal`'s
    // own window handler takes them; this one only stands aside.
    if (app.showSettings && primary && !e.shiftKey && /^(Digit[1-9]|Bracket(Left|Right))$/.test(e.code)) {
      return false;
    }
    if (primary && /^Digit[1-9]$/.test(e.code)) {
      // ⌘⇧digit is the n-th model of the picker, every provider alike
      // (2026-09-14); Shift means model on both engines — letters on
      // Claude Code, numbers on the API.
      runMenuCommand(`${e.shiftKey ? "model" : "provider"}_${e.code.slice(5)}`);
      return true;
    }
    // ⌘⇧T shows or folds thinking, ⌘⇧B the tool calls (nightshift backlog
    // 052, 2026-09-14). On every platform, like the digits: neither is a
    // menu item, so macOS cannot double-fire them. Physical keys, so a
    // layout cannot move them. Both were free — the grep on 2026-09-14
    // found no Shift+T or Shift+B anywhere in the app or its menu.
    if (primary && e.shiftKey && (e.code === "KeyT" || e.code === "KeyB")) {
      // ⌘⇧T is inert where the chip is disabled (nightshift backlog 097):
      // a chat whose thinking the model does not return has nothing to open.
      if (e.code === "KeyT" && thinkingToggleDead(app.events, app.connection)) return true;
      toggleTranscriptPref(e.code === "KeyT" ? "thinking" : "tool");
      return true;
    }
    // ⌘= / ⌘− / ⌘0 zoom the whole app (nightshift backlog 108). On macOS
    // the three are View-menu items and arrive as `menu` events, so only
    // ⌘⇧= — the literal ⌘+ on a US layout, no menu item — is taken here;
    // elsewhere all of them are. Physical keys, so a layout cannot move
    // them. ⌘0 was free: blocker 035's "0" is a bare key inside the ⌘P
    // palette, not a chord.
    const zoom = zoomChord(e, primary, isMac);
    if (zoom) {
      void runZoom(zoom);
      return true;
    }
    // ⌘F opens find in page (nightshift backlog 106), or refocuses the
    // bar with its text selected when it is already up — Chrome's
    // behaviour, and from inside a text box too. On every platform: not
    // a menu item, so macOS cannot double-fire it. The bar takes ⌘G /
    // ⌘⇧G itself while open; ⌘⇧F is left for the search-everywhere half
    // (backlog 117).
    if (findChord(e, primary) === "open") {
      void findBar?.show();
      return true;
    }
    // Tabs (nightshift backlog 099): ⌘T, ⌘W, ⌘⇧], ⌘⇧[ are File and View
    // menu items on macOS and arrive as `menu` events; bound here for the
    // other platforms only, physical keys.
    if (!isMac && primary) {
      if (!e.shiftKey && e.code === "KeyT") {
        runMenuCommand("new_tab");
        return true;
      }
      if (!e.shiftKey && e.code === "KeyW") {
        runMenuCommand("close_tab");
        return true;
      }
      if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        runMenuCommand(e.code === "BracketRight" ? "next_tab" : "prev_tab");
        return true;
      }
    }
    if (isMac || !e.ctrlKey) return false;
    const k = e.key.toLowerCase();
    const id = e.shiftKey ? SHIFT_KEYS[k] : KEYS[k];
    if (!id) return false;
    if ((id === "undo_app" || id === "redo_app") && inTextField()) return false;
    runMenuCommand(id);
    return true;
  }
</script>

<!--
  The title bar spans the whole window rather than sitting inside the centre
  column, because it is the window's own chrome and not a toolbar: with the
  system frame off there has to be somewhere to grab at the top of the screen
  wherever the pointer is, including over the sidebar and the rail.
-->
<svelte:window
  onkeydown={(e) => {
    // ⌘\ (Ctrl+\ elsewhere) collapses and reopens the sidebar.
    if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (onShortcut(e)) e.preventDefault();
  }}
  onfocusin={() => void syncUndoMenu()}
  onfocusout={() => void syncUndoMenu()}
/>

<div class="shell">
  <TitleBar />
  <div
    class="app"
    class:nightshift={app.view === "nightshift"}
    class:collapsed={app.layout.sidebarCollapsed}
    style:grid-template-columns="{app.layout.sidebarCollapsed ? 0 : sidebarColumn()}px minmax(0, 1fr)"
  >
    <Sidebar />
    {#if app.layout.sidebarCollapsed}
      <button class="side-expand" title="Show sidebar (⌘\)" onclick={() => toggleSidebar()}>
        <Icon name="chevr" size={12} />
      </button>
    {:else}
      <!-- The sidebar's collapse button and resize grip sit on its edge,
           drawn here because the sidebar clips its own overflow. -->
      <button
        class="side-toggle"
        style:left="{sidebarColumn() - 11}px"
        title="Collapse sidebar (⌘\)"
        onclick={() => toggleSidebar()}
      >
        <Icon name="chevl" size={12} />
      </button>
      <div class="side-grip" style:left="{sidebarColumn() - 4}px">
        <Grip
          width={app.layout.sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          edge="left"
          onchange={(w) => setSidebarWidth(w)}
        />
      </div>
    {/if}
    <div class="main">
      {#if tabbed}
        <!-- The panes (nightshift backlog 099): one or two, each with its
             strip of tabs; a chat or a note per tab. A pane draws by its
             own active tab — a note live in either pane, the open chat
             where its tab is, any other chat as a card — and the focused
             pane (the accent rule on its active tab) is what the sidebar
             and the keys act on. The composer's grip is the divider. -->
        <div
          class="split"
          class:two={app.tabs.panes.length > 1}
          bind:clientWidth={splitWidth}
          style:grid-template-columns={app.tabs.panes.length > 1
            ? `${leftPx}px minmax(0, 1fr)`
            : "minmax(0, 1fr)"}
        >
          {#each app.tabs.panes as pane, i (pane.id)}
            {@const t = tabs.activeTab(pane)}
            {@const focused = pane.id === app.tabs.focused}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <section
              class="pane"
              class:focused
              data-pane={pane.id}
              onmousedowncapture={() => focusPane(pane.id)}
              ondragover={(e) => onPaneDragOver(e, pane.id)}
              ondragleave={onPaneDragLeave}
              ondrop={(e) => onPaneDrop(e, pane.id)}
            >
              {#if i === 1}
                <div class="split-grip">
                  <Grip
                    width={leftPx}
                    min={SPLIT_MIN}
                    max={Math.max(SPLIT_MIN, splitWidth - SPLIT_MIN)}
                    edge="left"
                    onchange={(w) => setPaneWidth("split", w)}
                  />
                </div>
              {/if}
              <TabStrip {pane} />
              {#if barPane === pane.id}
                <TopBar />
              {/if}
              {#if t.content.kind === "note"}
                <div class="content">
                  <NoteView note={t.content} />
                  {#if focused}<FindBar bind:this={findBar} />{/if}
                </div>
              {:else if liveTab?.id === t.id}
                <div class="content">
                  {#if blank}
                    <Welcome />
                  {:else}
                    <Transcript />
                  {/if}
                  <!-- ⌘F's find bar (nightshift backlog 106), over whichever
                       view is showing: it searches and lights its parent's
                       text from outside, so it sits here beside the views
                       rather than in any of them. -->
                  {#if focused}<FindBar bind:this={findBar} />{/if}
                </div>
                {#if !blank}
                  <Composer />
                {/if}
              {:else}
                <!-- A chat that is not the open one (blocker 182): the
                     backend holds one session, so this tab is a card until
                     it is brought forward. -->
                <div class="content">
                  <div class="tab-card">
                    <div class="tab-card-title">{tabs.tabTitle(t.content, app.sessions)}</div>
                    <p>
                      Not the open chat. One chat is live at a time — its transcript is
                      in the other pane's tab, or under a note.
                    </p>
                    <button class="ns-btn small" onclick={() => void activateTab(t.id)} disabled={app.busy}
                      >{app.busy ? "Opens when the running turn ends" : "Open here"}</button
                    >
                  </div>
                  {#if focused}<FindBar bind:this={findBar} />{/if}
                </div>
              {/if}
              <!-- The terminal's dock (wave 3, agent M; backlog 113): a
                   terminal for this pane mounts here, under the composer,
                   keyed by `data-pane`. The dock draws only under the pane
                   it was opened from (`term.pane`); the first pane's
                   instance carries ⌃`. -->
              <div class="pane-dock" data-pane={pane.id}><TerminalDock pane={pane.id} /></div>
              {#if dropHalf?.pane === pane.id}
                <div class="split-zone {dropHalf.side}" aria-hidden="true">
                  <span>{app.tabs.panes.length > 1 ? "move here" : "open beside"}</span>
                </div>
              {/if}
            </section>
          {/each}
        </div>
      {:else}
        {#if app.view !== "nightshift"}
          <TopBar />
        {/if}
        <div class="content">
          {#if app.view === "graph"}
            <GraphView />
          {:else if app.view === "nightshift"}
            <NightshiftSurface />
          {:else if app.view === "new-project"}
            <NewProject />
          {/if}
          <FindBar bind:this={findBar} />
        </div>
      {/if}
      {#if app.toasts.length > 0}
        <div class="toasts">
          {#each app.toasts as t (t.id)}
            <!-- A toast with an action (backlog 066: "Removed from
                 context · Undo") takes the pointer; the rest stay
                 inert, as they were. -->
            <div class="toast" class:actionable={!!t.action}>
              {t.text}{#if t.action}<span class="toast-sep"> · </span><button
                  class="toast-action"
                  onclick={() => runToastAction(t.id)}>{t.action.label}</button>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <!-- A click on the overlay itself — outside the modal — closes it. The
         handler checks the target so clicks inside the modal that bubble up
         are left alone. -->
    {#if app.showSettings}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) app.showSettings = false; }}><SettingsModal /></div>
    {/if}
    <!-- The Context page, on the same overlay as Settings (nightshift
         backlog 056, 2026-09-15): what the next request carries, one card
         per layer. It was a popover under the gauge chip; the chip and
         ⌘⇧C still toggle it. -->
    {#if app.showContext}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) app.showContext = false; }}><ContextPanel /></div>
    {/if}
    <Palette />
    {#if app.showPrompts}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) closePrompts(); }}><PromptLibrary /></div>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .app {
    position: relative;
    display: grid;
    /* The columns are set inline: the sidebar's width is a preference and
       it collapses to nothing. The right rail is no longer a column — it
       opens as a popover from the chat top bar's model chip (2026-09-11). */
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  /* The round button that brings a collapsed sidebar back — where its
     collapse button sat, on the sidebar's edge. */
  .side-expand {
    position: absolute;
    left: 10px;
    top: 30px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--dim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 6;
  }
  .side-expand:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .side-toggle {
    position: absolute;
    top: 30px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--dim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 6;
  }
  .side-toggle:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .side-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7px;
    display: flex;
    z-index: 5;
  }
  .side-grip :global(.grip) {
    height: 100%;
    margin: 0;
  }
  .side-grip :global(.grip::after) {
    height: 100%;
    background: transparent;
  }
  .side-grip :global(.grip:hover::after),
  .side-grip :global(.grip.dragging::after) {
    background: var(--accent);
  }
  /* Room for the sidebar's expand button (top-left) on whatever sits at
     the top of the centre: the first pane's tab strip when the views are
     tabs, the bar itself on the graph and the New project form. */
  .app.collapsed :global(.main > header.topbar),
  .app.collapsed :global(.split > .pane:first-child .tab-strip) {
    padding-left: 44px;
  }
  .main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  /* The panes (backlog 099): a grid of one or two columns; the divider is
     the second pane's own left edge, so the columns stay two. */
  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
  }
  .pane {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .split.two .pane + .pane {
    border-left: 1px solid var(--line);
  }
  .split-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 7px;
    display: flex;
    z-index: 5;
  }
  .split-grip :global(.grip) {
    height: 100%;
    margin: 0;
  }
  .split-grip :global(.grip::after) {
    height: 100%;
    background: transparent;
  }
  .split-grip :global(.grip:hover::after),
  .split-grip :global(.grip.dragging::after) {
    background: var(--accent);
  }
  /* A chat tab that is not the open one (blocker 182). */
  .tab-card {
    margin: auto;
    max-width: 380px;
    padding: 20px 24px;
    text-align: center;
    color: var(--dim);
    font-size: 13px;
  }
  .tab-card-title {
    font-family: var(--serif);
    font-size: 18px;
    color: var(--ink);
    margin-bottom: 8px;
  }
  .tab-card p {
    margin: 0 0 14px;
  }
  /* The terminal's dock under a pane (agent M mounts into it). */
  .pane-dock:empty {
    display: none;
  }
  /* The *open beside* zone while a tab is dragged over a pane's half
     (board 9e). */
  .split-zone {
    position: absolute;
    top: 36px;
    bottom: 0;
    width: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(224, 164, 88, 0.12);
    border: 1px dashed var(--accent);
    color: var(--accent);
    font-size: 13px;
    pointer-events: none;
    z-index: 8;
  }
  .split-zone.left {
    left: 0;
  }
  .split-zone.right {
    right: 0;
  }
  .content {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .settings-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(13, 13, 20, 0.65);
    z-index: 20;
  }
  .toasts {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    z-index: 30;
    pointer-events: none;
  }
  .toast {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--dim);
    font-size: 0.8rem;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    max-width: 22rem;
  }
  .toast.actionable {
    pointer-events: auto;
  }
  /* The action is the toast's own text with the accent — a word, not a
     button drawn as one. */
  .toast-action {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .toast-action:hover,
  .toast-action:focus-visible {
    text-decoration: underline;
    outline: none;
  }
</style>
