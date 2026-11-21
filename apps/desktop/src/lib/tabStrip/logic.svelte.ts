// Item 856 (2026-11-19): the behaviour of TabStrip, once. `TabStrip.svelte` (Jarvis) and
// `TabStripClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from TabStrip.svelte's script.
import { app, asideAsking, asideOf, asideTabThread, closeTab, dropContent, droppedContent, moveTab, noteDraftKey, renameSession, splitTab } from "../state.svelte";
import { renamedTo } from "../renameField";
import { hasBoxDraft, newDraftKey } from "../drafts.svelte";
import * as tabs from "../tabs";
import { TAB_DRAG, TERM_DRAG, type Pane } from "../tabs";
import { type ForkMark } from "../forkMark";
import { draggedShell } from "../terminal.svelte";
import { TabFreeze } from "../tabFreeze";
import { isMac } from "../platform";
import { plan, startTabDrag } from "../tabDrag";
import { tabDrag } from "../tabDrag.svelte";
import { asideTabName } from "../asideSidebar.svelte";
// Item 477: the tab menu fits the window (item 425's placement).
import { placeMenu } from "../menuPlace";

export type TabStripLogicProps = { pane: Pane };



export function tabStripLogic(props: () => TabStripLogicProps) {
  /**
   * One pane's strip of tabs (nightshift backlog 099, boards 9a and 9d):
   * a glyph for the kind, the title, a pulsing dot while the chat's turn
   * runs, the needs-you dot when it waits on him, ~~✎~~ a hollow accent
   * ring for a draft (backlog 221, blocker 480's mark A), × on
   * hover. ~~`+` opens a new chat in a new tab (⌘T).~~ Since nightshift
   * backlog 140 (2026-09-17) `+` opens a chooser under the strip
   * (`TabChooser.svelte`) — New chat and its kinds, a new note, the
   * notes, Nightshift, the graph, the projects — and the new tab is what
   * he picks; ⌘T stays the one-key new chat. The active tab is the
   * sheet; the focused pane's active tab carries the accent rule on top,
   * so with two panes one strip says which the keys act on.
   *
   * Tabs drag: within the strip to reorder, onto the other pane's strip
   * to move, onto a pane's half to split — the halves are `App.svelte`'s
   * drop zones; this strip owns the reorder and the move. The drag carries
   * the tab's id under its own type, so a file or text dropped here is
   * nothing to it. Content from outside (backlog 140 pass 2: a sidebar
   * chat row, a note row, the Nightshift and Graph buttons, a project
   * row, the aside card) drops here as a new tab at the slot; the
   * terminal dock's strip (backlog 113's 12b) drops here to move the dock
   * under this pane.
   */
  const pane = $derived(props().pane);
  const focused = $derived(app.tabs.focused === pane.id);
  const live = $derived(tabs.liveTab(app.tabs, app.activeSessionId));

  function title(t: tabs.Tab): string {
    // A named aside is called by its name (item 265).
    const named = t.content.kind === "aside" ? asideTabName(t.content.session, t.content.thread) : null;
    if (named) return `Aside · ${named}`;
    return tabs.tabTitle(t.content, app.sessions, app.projects);
  }

  function draft(t: tabs.Tab): boolean {
    const c = t.content;
    if (c.kind === "note") {
      // The draft's key carries the project for per-project files
      // (backlog 133); `noteDraftKey` is the one place it is spelled.
      return app.noteDrafts[noteDraftKey(c.scope, c.name)] !== undefined;
    }
    if (c.kind !== "chat") return false;
    return hasBoxDraft(c.session ?? newDraftKey(app.project?.id, app.pendingMode, app.pendingThread));
  }

  /** The chat's turn runs, or waits on him. ~~Only the live tab can~~ —
   *  since backlog 159 the running chat may be parked behind another on
   *  screen, and its tab keeps the mark. */
  function running(t: tabs.Tab): boolean {
    // A chat running in the background (backlog 159, A2) keeps its mark.
    if (t.content.kind === "chat" && t.content.session && app.background[t.content.session]) return true;
    // Item 886: an aside's tab carries the dot while its thread asks — the
    // same mark as a chat's, from the same state its card and bar read.
    if (t.content.kind === "aside") return asideAsking(asideOf(t.content.session, asideTabThread(t.content) ?? null)) !== null;
    if (!app.busy) return false;
    if (app.parked) return t.content.kind === "chat" && t.content.session === app.parked.session;
    return live?.id === t.id;
  }
  function needsYou(t: tabs.Tab): boolean {
    // A background chat's prompt waits in its own tab (A2, guess pass 5).
    const bg = t.content.kind === "chat" && t.content.session ? app.background[t.content.session] : undefined;
    // A4: or a budget stop the hook holds for his answer (backlog 189).
    if (bg) return bg.approvals.length > 0 || !!bg.budget?.pending_since_ms;
    return live?.id === t.id && app.pendingApprovals.length > 0;
  }

  /** A chat tab's short id and mode, for its hover (board d, nightshift
   *  backlog 175 pass 2): the top bar's title row and id went, so the tab
   *  that names the chat carries them. */
  function chatTail(c: tabs.TabContent): string {
    if (c.kind !== "chat" || !c.session) return "";
    const meta = app.sessions.find((s) => s.id === c.session);
    const mode = meta?.mode === "incognito" ? " · incognito" : "";
    return ` · ${c.session.slice(0, 8)}${mode}`;
  }

  /** A fork's tab (backlog 379): the mark before its title, and the
   *  chat it came from named on hover — of the mark and of the tab. */
  function fork(t: tabs.Tab): ForkMark | null {
    return tabs.tabFork(t.content, app.sessions);
  }
  function forkTail(t: tabs.Tab): string {
    const f = fork(t);
    return f ? ` · ${f.tip}` : "";
  }

  function hint(t: tabs.Tab): string {
    const c = t.content;
    const base =
      c.kind === "note"
        ? `${c.name} — a note`
        : c.kind === "project"
          ? `${title(t)} — a project`
          : c.kind === "aside"
            ? `${title(t)} — a side conversation, not in the chat`
            : c.kind === "attachment"
              ? `${title(t)} — an attachment of a message, kept as a tab`
              : c.kind === "subagent"
                ? `${title(t)} — a subagent's transcript: its calls, results and words`
                : c.kind === "file"
                  ? `${c.path} — a file a reply named, read-only`
                  : c.kind === "thread"
                    ? `${title(t)} — what the thread stores (.agents/threads/${c.slug}/), read-only`
                    : title(t) + chatTail(c) + forkTail(t);
    const state = needsYou(t) ? " · waiting on you" : running(t) ? " · a turn is running" : "";
    return `${base}${state} — ${isMac ? "⌘W" : "Ctrl+W"} closes`;
  }

  /** The + chooser (backlog 140): open under this strip's + button. */
  let chooser = $state(false);

  // ---- drag and drop ----

  /** Where a dragged tab would land in this strip, as an index; null when
   *  nothing is over it. */
  let dropAt = $state<number | null>(null);
  let stripEl = $state<HTMLElement | null>(null);
  /** Item 877 (2026-11-19): a band under the strip that takes a drop as the
   *  strip does. macOS opens Mission Control when a drag (any drag, not only
   *  a window's) is pushed against the top of the screen, and a zoomed or
   *  full-screen window's strip sits at or near that edge: aimed at the
   *  strip, the pointer overshoots into the system's title bar and the menu
   *  bar, gets no drop marker there, and is pushed on into the edge. The
   *  band shows the strip's marker a hand's width before the strip, so the
   *  drop is caught well short of the edge. Only for the drags the system
   *  carries (a note, a thread, a chat; a terminal's shell) — a tab's own
   *  drag is a pointer drag and never reaches the OS. */
  const BAND_PX = 56;
  let catchEl = $state<HTMLElement | null>(null);
  const catching = $derived(!!app.draggingContent || app.draggingTerm);
  /** The band's top: the strip's foot, in the pane's box (the pane is the
   *  strip's offset parent). */
  function catchTop(): number {
    return stripEl ? stripEl.offsetTop + stripEl.offsetHeight : 0;
  }

  // ---- item 603: closing tabs as Chrome does (`tabFreeze.ts`) ----
  // A close from the strip holds every tab at the width it had, so the next
  // close button slides in under the pointer; the strip re-fits when the
  // pointer leaves it or rests a few seconds. ⌘W (pointer elsewhere) does not
  // freeze: nothing is under the pointer to keep in place.
  let frozenW = $state<number | null>(null);
  const freeze = new TabFreeze((w) => (frozenW = w));
  $effect(() => () => freeze.thaw());
  function closeFromStrip(e: MouseEvent, t: tabs.Tab): void {
    const el = (e.currentTarget as Element | null)?.closest<HTMLElement>(".tab");
    freeze.closed(el?.getBoundingClientRect().width ?? 0);
    void closeTab(t.id);
  }

  // ---- a tab dragged: pointer events (nightshift backlog 195) ----
  //
  // ~~The tab was `draggable` and moved by WebKit's native drag~~ — since
  // 195 (2026-09-25) a press past `DRAG_SLOP` px drags a ghost of the tab
  // (`tabDrag.ts`); a press that never travels is the click it was. The
  // release reorders (the active tab stays active), moves into the other
  // pane (the focus follows), splits — or snaps the ghost back, visibly.
  // The strip's native handlers below stay for what still drags natively
  // into it: a sidebar row, a note, the aside card, the terminal dock.

  /** The ghost under the pointer: the tab's look, where it was grabbed. */
  let ghost = $state<{
    tab: tabs.Tab;
    width: number;
    dx: number;
    dy: number;
    /** Set while it flies home after a drag that did nothing. */
    home: { left: number; top: number } | null;
  } | null>(null);
  const SNAP_MS = 160;

  /** The slot marker for a tab drag over this strip, when the release
   *  would land there — none over its own slot, which is a snap. */
  const dragMark = $derived(
    tabDrag.id &&
      tabDrag.target?.kind === "strip" &&
      tabDrag.target.pane === pane.id &&
      (tabDrag.plan?.kind === "reorder" || tabDrag.plan?.kind === "move")
      ? tabDrag.target.index
      : null,
  );

  function onTabPointerDown(e: PointerEvent, t: tabs.Tab) {
    // The × is a button of its own; its click must stay a click.
    if (e.target instanceof Element && e.target.closest(".close")) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    startTabDrag(e, {
      onStart() {
        ghost = { tab: t, width: r.width, ...grab, home: null };
        tabDrag.id = t.id;
        app.draggingTab = t.id;
      },
      onMove(p, target) {
        tabDrag.x = p.x;
        tabDrag.y = p.y;
        tabDrag.target = target;
        tabDrag.plan = plan(app.tabs, t.id, target);
      },
      onDrop(target) {
        const p = plan(app.tabs, t.id, target);
        endDrag();
        if (p.kind === "snap") return snapHome(t.id);
        ghost = null;
        if (p.kind === "reorder") tabs.reorder(app.tabs, t.id, p.index);
        else if (p.kind === "move") void moveTab(t.id, p.pane, p.index);
        else void splitTab(t.id, p.side);
      },
      onCancel() {
        endDrag();
        snapHome(t.id);
      },
    });
  }
  function endDrag() {
    tabDrag.id = null;
    tabDrag.target = null;
    tabDrag.plan = null;
    app.draggingTab = null;
  }
  /** Fly the ghost back to the tab it came from, then drop it. */
  function snapHome(id: string) {
    const el = stripEl?.querySelector<HTMLElement>(`[data-tab="${id}"]`);
    if (!ghost || !el) {
      ghost = null;
      return;
    }
    const r = el.getBoundingClientRect();
    ghost.home = { left: r.left, top: r.top };
    setTimeout(() => (ghost = null), SNAP_MS);
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
    if (!app.draggingTab && !app.draggingContent && !app.draggingTerm) return;
    e.preventDefault();
    // The strip's drop is the strip's: the pane behind it draws the
    // *open beside* halves for a drag over its content, not over its tabs.
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = app.draggingContent ? "copy" : "move";
    // The dock has no slot in the strip: dropping it anywhere here docks
    // it under this pane, so no accent bar.
    dropAt = app.draggingTerm ? null : indexAt(e);
  }
  function onDragLeave(e: DragEvent) {
    const to = e.relatedTarget;
    if (to instanceof Node && (stripEl?.contains(to) || catchEl?.contains(to))) return;
    dropAt = null;
  }
  /** Item 877: the band's dragover is the strip's, except that it bubbles —
   *  the pane sees a target in `.strip-catch` and takes down its *open
   *  beside* half, which a drag coming up from the content had drawn. */
  function onCatchDragOver(e: DragEvent) {
    if (!catching) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = app.draggingContent ? "copy" : "move";
    dropAt = app.draggingTerm ? null : indexAt(e);
  }
  function onDrop(e: DragEvent) {
    const at = dropAt ?? indexAt(e);
    dropAt = null;
    // A terminal's shell (backlog 113's 12b; blocker 155): into this
    // pane's dock — a second dock if it has none.
    if (e.dataTransfer?.types.includes(TERM_DRAG) || app.draggingTerm) {
      e.preventDefault();
      e.stopPropagation();
      app.draggingTerm = false;
      draggedShell(e, pane.id);
      return;
    }
    // Content from outside (backlog 140 pass 2): a new tab at the slot.
    const content = droppedContent(e);
    if (content) {
      e.preventDefault();
      e.stopPropagation();
      app.draggingContent = null;
      void dropContent(content, { pane: pane.id, index: at });
      return;
    }
    const id = e.dataTransfer?.getData(TAB_DRAG) || app.draggingTab;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
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
  /**
   * Item 477: the menu fits the window at every edge, as the sidebar's
   * does (`placeMenu`, item 425) — measured once drawn, so a tab near the
   * right edge opens it leftward and a short window lifts it. Placed again
   * when its size or the window's changes.
   */
  function placeTabMenu(el: HTMLElement, at: { x: number; y: number }) {
    let anchor = at;
    const place = () => {
      const size = { w: el.offsetWidth, h: el.scrollHeight + (el.offsetHeight - el.clientHeight) };
      const p = placeMenu({ x: anchor.x, below: anchor.y, above: anchor.y }, size, { w: window.innerWidth, h: window.innerHeight });
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxHeight = p.maxHeight === undefined ? "" : `${p.maxHeight}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return {
      update(next: { x: number; y: number }) {
        anchor = next;
        place();
      },
      destroy() {
        ro.disconnect();
        window.removeEventListener("resize", place);
      },
    };
  }
  /**
   * A menu item's action on the tab the menu is for, the menu closed.
   * The tab is read **before** `menuFor` clears (found by backlog 376's
   * harness, 2026-10-18): the markup's `{@const t}` re-derives from
   * `menuFor`, so read after the clear it was `undefined` and every item
   * guarded by `if (t)` did nothing.
   */
  function menuAct(f: (t: tabs.Tab) => void) {
    const t = pane.tabs.find((x) => x.id === menuFor);
    menuFor = null;
    if (t) f(t);
  }
  function closeOthers(id: string) {
    for (const t of [...pane.tabs]) if (t.id !== id) void closeTab(t.id);
  }
  const canSplit = $derived(app.tabs.panes.length < tabs.MAX_PANES && pane.tabs.length > 1);

  // ---- a chat tab renamed in place (backlog 376) ----
  //
  // The menu's Rename turns the tab's title into a field with the whole
  // name selected: typing replaces it, ↵ or a click away keeps it, Esc
  // leaves the name as it was. The same rename as the sidebar row's
  // (`renameSession`, on the list's undo stack).
  let renamingTab = $state<string | null>(null);
  let tabDraft = $state("");
  let tabRenameFrom = "";
  function chatName(session: string): string {
    const meta = app.sessions.find((s) => s.id === session);
    return meta?.title ?? meta?.first_user ?? "";
  }
  function startTabRename(t: tabs.Tab) {
    if (t.content.kind !== "chat" || !t.content.session) return;
    tabRenameFrom = chatName(t.content.session) || title(t);
    tabDraft = tabRenameFrom;
    renamingTab = t.id;
  }
  async function commitTabRename(t: tabs.Tab) {
    // Only the tab still being renamed commits: Esc clears `renamingTab`
    // first, and the blur the field's removal fires must not undo that.
    if (renamingTab !== t.id) return;
    renamingTab = null;
    const name = renamedTo(tabDraft, tabRenameFrom);
    if (name && t.content.kind === "chat" && t.content.session) await renameSession(t.content.session, name);
  }
  const other = $derived(tabs.otherPane(app.tabs, pane.id));
  /** The running badge (backlog 309) sits once, at the window's right:
   *  the last pane's strip. */
  const lastPane = $derived(app.tabs.panes[app.tabs.panes.length - 1]?.id === pane.id);

  return {
    get SNAP_MS() {
      return SNAP_MS;
    },
    get canSplit() {
      return canSplit;
    },
    get chooser() {
      return chooser;
    },
    set chooser(v) {
      chooser = v;
    },
    BAND_PX,
    get catchEl() {
      return catchEl;
    },
    set catchEl(v) {
      catchEl = v;
    },
    catchTop,
    get catching() {
      return catching;
    },
    closeFromStrip,
    closeOthers,
    commitTabRename,
    draft,
    get dragMark() {
      return dragMark;
    },
    get dropAt() {
      return dropAt;
    },
    set dropAt(v) {
      dropAt = v;
    },
    get focused() {
      return focused;
    },
    fork,
    get freeze() {
      return freeze;
    },
    get frozenW() {
      return frozenW;
    },
    set frozenW(v) {
      frozenW = v;
    },
    get ghost() {
      return ghost;
    },
    set ghost(v) {
      ghost = v;
    },
    hint,
    get lastPane() {
      return lastPane;
    },
    menuAct,
    get menuAt() {
      return menuAt;
    },
    set menuAt(v) {
      menuAt = v;
    },
    get menuFor() {
      return menuFor;
    },
    set menuFor(v) {
      menuFor = v;
    },
    needsYou,
    onCatchDragOver,
    onDragLeave,
    onDragOver,
    onDrop,
    onTabPointerDown,
    openMenu,
    get other() {
      return other;
    },
    get pane() {
      return pane;
    },
    placeTabMenu,
    get renamingTab() {
      return renamingTab;
    },
    set renamingTab(v) {
      renamingTab = v;
    },
    running,
    startTabRename,
    get stripEl() {
      return stripEl;
    },
    set stripEl(v) {
      stripEl = v;
    },
    get tabDraft() {
      return tabDraft;
    },
    set tabDraft(v) {
      tabDraft = v;
    },
    title,
  };
}
