<script lang="ts">
  import { tip } from "./lib/tip";
  import { onMount, untrack } from "svelte";
  import {
    activateTab,
    browseFree,
    app,
    asideOf,
    asideTabThread,
    closePrompts,
    dropContent,
    droppedContent,
    focusPane,
    init,
    inTextField,
    moveTab,
    paneWidth,
    reflectTabs,
    runMenuCommand,
    runToastAction,
    answerAsideDiscard,
    setPaneWidth,
    splitTab,
    syncUndoMenu,
    setSidebarWidth,
    sidebarColumn,
    syncPromptLayers,
    toggleSidebar,
    useProject,
    SIDEBAR_MAX,
    SIDEBAR_MIN,
  } from "./lib/state.svelte";
  import * as tabs from "./lib/tabs";
  import { draggedShell, dropLabel } from "./lib/terminal.svelte";
  import "./lib/tabsKeeper.svelte";
  import TabStrip from "./lib/TabStrip.svelte";
  import { tabDrag } from "./lib/tabDrag.svelte";
  import { halfLabel } from "./lib/tabDrag";
  import AsideView from "./lib/AsideView.svelte";
  import AsideCard from "./lib/AsideCard.svelte";
  import ConfirmDialog from "./lib/ConfirmDialog.svelte";
  import { quoteLabel } from "./lib/asideQuote";
  import AttachmentLayer from "./lib/AttachmentLayer.svelte";
  import AttachmentView from "./lib/AttachmentView.svelte";
  import SubagentView from "./lib/SubagentView.svelte";
  import { agentAsk, deliverDue } from "./lib/subagentAsk.svelte";
  import FileView from "./lib/FileView.svelte";
  import WebView from "./lib/WebView.svelte";
  import { closeOrphans, initWebTabs, routeLink } from "./lib/webtabs.svelte";
  import RunningTasks from "./lib/RunningTasks.svelte";
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
  import { externalHref } from "./lib/extlink";

  onMount(() => {
    void init();
    // The stored zoom back on the window, and the View menu's zoom items
    // (nightshift backlog 108).
    void initZoom();
    // ~~Every outside link in rendered text opens in the system browser~~
    // (his report, 2026-09-18: a reply's link took over the whole window
    // with no way back). Capture phase, so it runs before any renderer's
    // own handler and before the webview navigates. Since backlog 172
    // (2026-09-23) this is the router: a web tab beside the chat or the
    // browser, by the Settings row, ⌘ sending it to the other place.
    void initWebTabs();
    const onLink = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      const url = externalHref(a?.getAttribute("href") ?? null, window.location.origin);
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      routeLink(url, isMac ? e.metaKey : e.ctrlKey);
    };
    document.addEventListener("click", onLink, true);
    return () => document.removeEventListener("click", onLink, true);
  });

  // A web tab's page dies with its tab (backlog 172): any tab change —
  // ⌘W, ×, a pane closing, a project switch — closes the orphans.
  $effect(() => {
    void tabs.allTabs(app.tabs).map((t) => t.id);
    untrack(() => closeOrphans());
  });

  // A note held under a running subagent's tab (backlog 157) goes once the
  // agent has finished and nothing runs on screen — whether or not its tab
  // is still open. Re-checked when a turn ends or an agent's status moves.
  $effect(() => {
    void app.busy;
    void app.subagents.map((r) => r.status);
    void Object.keys(app.background).length;
    void Object.keys(agentAsk.notes).length;
    untrack(() => void deliverDue());
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
   * ~~The views that are tabs — a chat, a note — against the ones that
   * take the whole centre as they always have: the graph, Nightshift,
   * the New project form.~~ Since nightshift backlog 140 (2026-09-17)
   * the panes always draw: those three pages are tab contents, so the
   * strip stays whatever is in front.
   */
  /** The tab whose chat is the open one; its pane draws the transcript. */
  const liveTab = $derived(tabs.liveTab(app.tabs, app.activeSessionId));
  /**
   * The pane that carries the top bar: the bar describes the open chat, so
   * it sits over the pane whose *active* tab is that chat, and over the
   * focused pane when no pane shows it but a note is in front there (the
   * chat is open underneath). Over the Nightshift page, the graph, the
   * New project form, a project card or an aside it is absent — the bar
   * is a chat's (backlog 140).
   */
  const barPane = $derived.by(() => {
    if (liveTab) {
      const p = tabs.paneOf(app.tabs, liveTab.id);
      if (p && p.active === liveTab.id) return p.id;
    }
    const focused = tabs.focusedPane(app.tabs);
    return tabs.activeTab(focused).content.kind === "note" ? focused.id : null;
  });
  /** The split's geometry: the left pane's width, saved as a pane pref. */
  let splitWidth = $state(0);
  const SPLIT_MIN = 280;
  /**
   * The aside side panel (nightshift backlog 141 pass 2): the floating
   * card dragged to the window's right edge lands here, a third column
   * beside the panes — not a pane (no strip, never focused, outside the
   * tab model's walks), the same card drawn static with a thin head of
   * its own. It shows the thread of `app.asidePanel`'s chat from where
   * it lives (`asideOf`), and closes itself when that thread ends (its
   * ×), when a tab opens for the same thread (one second view at a time),
   * or when the chat is deleted; *back* puts the card under the passage.
   */
  const PANEL_W = 360;
  const panelPx = $derived(app.asidePanel ? PANEL_W : 0);
  const leftPx = $derived(
    Math.max(
      SPLIT_MIN,
      Math.min(splitWidth - panelPx - SPLIT_MIN, paneWidth("split", Math.round((splitWidth - panelPx) / 2))),
    ),
  );
  // The thread the panel was given (backlog 176), else the chat's front.
  const panelAside = $derived(app.asidePanel ? asideOf(app.asidePanel, app.asidePanelThread) : null);
  const panelChat = $derived.by(() => {
    const id = app.asidePanel;
    if (!id) return "";
    const s = app.sessions.find((x) => x.id === id);
    return s?.title ?? s?.first_user ?? id.slice(0, 8);
  });
  $effect(() => {
    const id = app.asidePanel;
    if (!id) return;
    const thread = app.asidePanelThread;
    const gone = !asideOf(id, thread) || (app.sessions.length > 0 && !app.sessions.some((x) => x.id === id));
    // A tab for the same thread closes the panel (backlog 176: that
    // thread's tab, not any aside tab of the chat).
    const shownId = asideOf(id, thread)?.id;
    const inTab = tabs
      .allTabs(app.tabs)
      .some(
        (t) =>
          t.content.kind === "aside" &&
          t.content.session === id &&
          (asideTabThread(t.content) ?? asideOf(id)?.id) === shownId,
      );
    if (gone || inTab) {
      app.asidePanel = null;
      app.asidePanelThread = null;
    }
  });
  /** The right edge lights while an aside's card is dragged: the drop
   *  makes the panel. Above the panes' halves, so it wins there. */
  const asideDragging = $derived(app.draggingContent?.kind === "aside");
  let overEdge = $state(false);
  function onEdgeDragOver(e: DragEvent) {
    if (!asideDragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    overEdge = true;
  }
  function onEdgeDrop(e: DragEvent) {
    overEdge = false;
    const content = droppedContent(e);
    if (!content || content.kind !== "aside") return;
    e.preventDefault();
    e.stopPropagation();
    app.draggingContent = null;
    dropHalf = null;
    app.asidePanel = content.session;
    app.asidePanelThread = asideTabThread(content) ?? null;
  }

  /**
   * A tab dragged over a pane's content: which half, for the *open beside*
   * zone (board 9e). The strip takes drops of its own; this is the rest of
   * the pane.
   */
  let dropHalf = $state<{ pane: string; side: "left" | "right" } | null>(null);
  /** Something a pane's half takes: a tab, a content descriptor from
   *  outside (backlog 140 pass 2), or the terminal dock (113's 12b). */
  const dragging = $derived(!!app.draggingTab || !!app.draggingContent || app.draggingTerm);
  // A drop on the strip (inside the pane) is the strip's, so the pane's
  // drop handler never ran and the zone drawn on the way there stayed
  // (his report, 2026-09-17 16:40 on 5847cca). Whatever ends the drag —
  // a drop anywhere, Escape, a drag out of the window — clears the flags
  // above, and the zone follows them.
  $effect(() => {
    if (!dragging) dropHalf = null;
  });
  /** A tab's pointer drag over a pane's half (backlog 195): the zone its
   *  release would split to or move into — none when it would snap back. */
  const tabHalf = $derived.by(() => {
    const t = tabDrag.target;
    if (!tabDrag.id || t?.kind !== "half" || !tabDrag.plan) return null;
    const label = halfLabel(tabDrag.plan);
    return label ? { pane: t.pane, side: t.side, label } : null;
  });
  /** The zone's caption: what the drop will do here. */
  function zoneLabel(paneId: string): string {
    if (app.draggingTerm) return dropLabel(paneId);
    if (app.draggingContent) return app.tabs.panes.length > 1 ? "open here" : "open beside";
    return app.tabs.panes.length > 1 ? "move here" : "open beside";
  }
  function onPaneDragOver(e: DragEvent, paneId: string) {
    if (!dragging) return;
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
    const half = dropHalf;
    dropHalf = null;
    if (e.target instanceof Element && e.target.closest(".tab-strip")) return;
    // A terminal's shell (backlog 113's 12b; blocker 155, 2026-09-22):
    // into this pane's dock — a second dock if it has none, the dock
    // itself if it was its only shell; the shells run on.
    if (e.dataTransfer?.types.includes(tabs.TERM_DRAG) || app.draggingTerm) {
      e.preventDefault();
      app.draggingTerm = false;
      draggedShell(e, paneId);
      return;
    }
    // Content from outside the strips (backlog 140 pass 2): a second pane
    // holding it, or — with two panes — a tab in this one.
    const content = droppedContent(e);
    if (content) {
      e.preventDefault();
      app.draggingContent = null;
      void dropContent(content, { pane: paneId, side: half?.side ?? "right" });
      return;
    }
    const id = e.dataTransfer?.getData(tabs.TAB_DRAG) || app.draggingTab;
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
      <button class="side-expand" use:tip={"Show sidebar (⌘\\)"} onclick={() => toggleSidebar()}>
        <Icon name="chevr" size={12} />
      </button>
    {:else}
      <!-- The sidebar's collapse button and resize grip sit on its edge,
           drawn here because the sidebar clips its own overflow. -->
      <button
        class="side-toggle"
        style:left="{sidebarColumn() - 11}px"
        use:tip={"Collapse sidebar (⌘\\)"}
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
      <!-- The panes (nightshift backlog 099): one or two, each with its
           strip of tabs; a chat or a note per tab — and since backlog
           140 the Nightshift page, the graph, the New project form, a
           project card and an aside thread too, so the strip is always
           drawn. A pane draws by its own active tab — a note live in
           either pane, the open chat where its tab is, any other chat
           as a card — and the focused pane (the accent rule on its
           active tab) is what the sidebar and the keys act on. The
           composer's grip is the divider. -->
      <div
        class="split"
        class:two={app.tabs.panes.length > 1}
        bind:clientWidth={splitWidth}
        style:grid-template-columns={(app.tabs.panes.length > 1 ? `${leftPx}px minmax(0, 1fr)` : "minmax(0, 1fr)") +
          (app.asidePanel ? ` ${PANEL_W}px` : "")}
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
            {:else if t.content.kind === "nightshift"}
              <!-- The whole-centre pages as tabs (backlog 140): the
                   strip stays, the chat's top bar does not. Nightshift
                   keeps its own header inside. -->
              <div class="content">
                <NightshiftSurface />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "graph"}
              <div class="content">
                <GraphView />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "new-project"}
              <div class="content">
                <NewProject />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "project"}
              {@const p = app.projects.find((x) => x.id === (t.content as { id: string }).id)}
              <!-- A project as a tab (backlog 140, blocker 193): a card
                   naming it; the switch is its button, and switching
                   resets the workspace as it always has — a workspace
                   is a project's. -->
              <div class="content">
                <div class="tab-card">
                  <div class="tab-card-title">{p?.name ?? "Project"}</div>
                  {#if p}
                    <p class="tab-card-path">{p.root ?? "No folder — notes and chats only"}</p>
                    <p>
                      {p.chats} chat{p.chats === 1 ? "" : "s"} · {p.notes} note{p.notes === 1 ? "" : "s"}{#if !p.exists} · folder missing{/if}
                    </p>
                    {#if app.project?.id === p.id}
                      <p>This is the open project.</p>
                    {:else}
                      <button class="ns-btn small" onclick={() => void useProject(p.id)} disabled={app.busy}
                        >{app.busy ? "Opens when the running turn ends" : "Open this project"}</button
                      >
                      <p class="tab-card-hint">Opening it closes these tabs — a workspace is a project's.</p>
                    {/if}
                  {:else}
                    <p>This project is no longer on the list.</p>
                  {/if}
                </div>
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "aside"}
              <div class="content">
                <AsideView session={t.content.session} thread={asideTabThread(t.content) ?? null} />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "attachment"}
              <!-- An attachment kept as a tab (backlog 145 pass 2): the
                   floating tab dropped on a strip or a half. -->
              <div class="content">
                <AttachmentView content={t.content} />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "subagent"}
              <!-- A subagent's transcript (backlog 152): the Running-tasks
                   panel's View transcript, drawn from the chat's row. -->
              <div class="content">
                <SubagentView content={t.content} />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "file"}
              <!-- A file a reply named (backlog 161): the file card's
                   Open, read-only. -->
              <div class="content">
                <FileView content={t.content} />
                {#if focused}<FindBar bind:this={findBar} />{/if}
              </div>
            {:else if t.content.kind === "web"}
              <!-- A page he clicked a link to (backlog 172): the bar and
                   the box its child webview is laid over. Keyed by the
                   tab so a retargeted tab never inherits another's page. -->
              <div class="content">
                {#key t.id}
                  <WebView tabId={t.id} content={t.content} />
                {/key}
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
                  <!-- On the Claude Code engine the running chat goes to the
                       background and this opens at once (backlog 159, A2). -->
                  <button class="ns-btn small" onclick={() => void activateTab(t.id)} disabled={app.busy && !browseFree()}
                    >{app.busy && !browseFree() ? "Opens when the running turn ends" : "Open here"}</button
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
              <div class="split-zone {dropHalf.side}" class:whole={app.draggingTerm} aria-hidden="true">
                <span>{zoneLabel(pane.id)}</span>
              </div>
            {:else if tabHalf?.pane === pane.id}
              <div class="split-zone {tabHalf.side}" aria-hidden="true">
                <span>{tabHalf.label}</span>
              </div>
            {/if}
          </section>
        {/each}
        {#if app.asidePanel && panelAside}
          <!-- The aside side panel (backlog 141 pass 2): the card, static,
               beside the panes; its head is the panel's chrome. -->
          <aside class="aside-panel" aria-label="aside side panel">
            <div class="aside-panel-head">
              <span class="aside-panel-title" use:tip={"The chat this side conversation is beside"}>Aside · {panelChat}</span>
              <span class="spacer"></span>
              <button
                class="ns-btn ghost small"
                use:tip={"Put the card back in the chat, under its passage (Escape in the panel does the same); the thread stays"}
                onclick={() => {
                  app.asidePanel = null;
                  app.asidePanelThread = null;
                }}>back</button
              >
            </div>
            <AsideCard aside={panelAside} placement={null} panel session={app.asidePanel} />
          </aside>
        {/if}
        {#if asideDragging}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="aside-edge"
            class:over={overEdge}
            ondragover={onEdgeDragOver}
            ondragleave={() => (overEdge = false)}
            ondrop={onEdgeDrop}
          >
            <span>side panel</span>
          </div>
        {/if}
      </div>
      <!-- The floating attachment tab (backlog 145): over the panes,
           under the dialogs. -->
      <AttachmentLayer />
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
    <!-- Running tasks (nightshift backlog 152): the open chat's subagents,
         on the same overlay, from the top bar's agents chip. -->
    {#if app.showTasks}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) app.showTasks = false; }}><RunningTasks /></div>
    {/if}
    <Palette />
    <!-- Closing an aside with unsent text (backlog 228, practices §7):
         only an explicit, confirmed Discard drops what he typed. -->
    {#if app.asideDiscard}
      {@const d = app.asideDiscard}
      <ConfirmDialog
        title="Discard the unsent aside text?"
        lead={d.draft
          ? "The question typed in this aside has not been asked. Closing the card drops it."
          : "The follow-up typed under this aside has not been sent. Closing the thread drops it and the thread."}
        facts={[
          ["typed", (d.unsent ?? "").trim().slice(0, 160) + ((d.unsent ?? "").trim().length > 160 ? "…" : "")],
          ...(d.quote ? [["about", quoteLabel(d.quote, "card")] as [string, string]] : []),
        ]}
        confirmLabel="Discard"
        onconfirm={() => answerAsideDiscard(true)}
        onclose={() => answerAsideDiscard(false)}
      />
    {/if}
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
    /* The aside side panel and the right-edge drop zone (backlog 141
       pass 2) are placed in this frame. */
    position: relative;
  }
  .aside-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--sheet);
  }
  .aside-panel-head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--dim);
  }
  .aside-panel-head .spacer {
    flex: 1;
  }
  .aside-panel-title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* The drop zone at the window's right edge while an aside's card is
     dragged: a narrow strip, lit as the halves are, over the panes. */
  .aside-edge {
    position: absolute;
    top: 36px;
    right: 0;
    bottom: 0;
    width: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(224, 164, 88, 0.12);
    border: 1px dashed var(--accent);
    color: var(--accent);
    font-size: 12px;
    writing-mode: vertical-rl;
    z-index: 9;
  }
  .aside-edge.over {
    background: rgba(224, 164, 88, 0.24);
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
  .tab-card-path {
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .tab-card-hint {
    margin-top: 10px;
    font-size: 12px;
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
  /* The terminal dock's drop (backlog 113's 12b): the whole pane, not a
     half — the dock goes under the pane, it does not split it. */
  .split-zone.whole {
    width: 100%;
    left: 0;
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
