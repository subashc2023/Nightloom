// Item 856 (2026-11-19): the behaviour of Sidebar, once. `Sidebar.svelte` (Jarvis) and
// `SidebarClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from Sidebar.svelte's script.
import { blockerCounts } from "../needsYou";
import { refreshDoorStarted } from "../door.svelte";
import { refreshRoutes } from "../home.svelte";
import { saveMemoryFromChat, app, addToast, deleteSession, endContentDrag, droppedContent, moveChatToThread, moveSession, newChatInThread, enableNightshift, chatSelected, newSession, openSession, refreshNightshift, renameSession, toggleSidebar, contextUsed, connectionWindowFor, liveChats, backFromNightshift } from "../state.svelte";
import { renamedTo } from "../renameField";
// Item 534 (Filament IV stage 3): the dated sections, the two-line row's
// clock and context reading, the live row's line.
import { ctxLook, daySections, handoffChildren, handoffCue, pastByTokens, toolCount } from "../chatList";
import { contextOf, noteChatContext } from "../chatContext.svelte";
import { mark as handoffMark, cap as handoffCap, NEVER, neverHandsOff, ownMark } from "../handoff.svelte";
import * as api from "../api";
import { THREADS_CLOSED_KEY, loadThreadOrder, orderedThreads, reordered, saveThreadOrder, threadGroups, threadKey, type ThreadGroup } from "../thread";
import { deleteThread, refreshThreadList, renameThread, threadList } from "../threadPanel.svelte";
import { sidebarRows, loadOpen as loadForksOpen, saveOpen as saveForksOpen, toggled as toggledForks } from "../forkTree";
// Edits as versions (item 299): Make main, and the chat made main in
// its original's row.
import { mainOf, sidebarSessions } from "../versions";
import { makeMainChat, versions } from "../versions.svelte";
import { aimsAt, placeMenu, placeSubmenu, type Placed, type Point } from "../menuPlace";
import { findChord } from "../find";
import { findBar } from "../search";
import { isMac } from "../platform";
import { onMount, tick, untrack } from "svelte";
import { carriesFiles } from "../dropLook";
import { DragToNotes } from "../dragToNotes";
import { type ChatKind, type ChatMode, type NightshiftInfo, type NightshiftRow, type SessionMeta } from "../types";
import { exactTime, relativeTime } from "../time";
import { sameMorning } from "../nightshift";

export type SidebarLogicProps = Record<string, never>;

// The row menu's *Move to thread ▸* (the project's threads; one click
// binds) and *Move to project ▸* (backlog 370: every other project, and
// No project when one is open; one click moves). Since item 425 both are
// flyout submenus to the right of the menu — opened on hover, click, → or
// ↵ — instead of lists unfolding inside it (his "when you highlight over
// that line, it opens up to the right, cause that's how the arrow makes
// it look").
export type RowSub = "thread" | "project";
/** Places the menu from its drawn size, and again whenever that size changes (the asides load late). */
export type MenuAnchor = { x: number; below: number; above: number; alignRight?: boolean };

export function sidebarLogic(props: () => SidebarLogicProps) {

  // Delete confirms in a dialog and moves the log to a trash folder
  // (review round 1, 2026-09-13; memory never-lose-work). It replaced a ×
  // that turned into "sure?" on the first click — arming a button in place
  // is the pattern he called clunky, and it gave the row no way to say what
  // was about to happen to what.
  let deleting = $state<SessionMeta | null>(null);
  let menu = $state(false);
  // The New chat button's other half (nightshift backlog 059, 2026-09-15):
  // the kinds of chat, one line each, in the project menu's popover shape
  // — never a modal. Two axes since backlog 102 (2026-09-16, his review
  // of boards 8a/8b): the kind rows — Claude Code · Chat — each start a
  // chat of that kind, with a dot on the project's default; the privacy
  // rows below start one of the default kind. No row reads "New chat":
  // the wide button is that.
  let kinds = $state(false);
  const mod = isMac ? "⌘" : "Ctrl+";
  const alt = isMac ? "⌥⌘" : "Ctrl+Alt+";
  const KIND_ROWS: { kind: ChatKind; key: string }[] = [
    { kind: "build", key: `${mod}N` },
    { kind: "chat", key: `${alt}N` },
  ];
  const KINDS: { mode: ChatMode; label: string; key: string }[] = [
    { mode: "incognito", label: "Incognito", key: `${mod}⇧N` },
    { mode: "ephemeral", label: "Ephemeral", key: "" },
  ];
  /** The engine the kind is named for: the connection's, else the draft's. */
  const engine = $derived(app.connection?.engine ?? app.draft.engine);
  function startKind(mode: ChatMode) {
    kinds = false;
    void newSession(mode === "normal" ? undefined : mode);
  }
  function startOfKind(kind: ChatKind) {
    kinds = false;
    void newSession(undefined, kind);
  }

  // Forks under their origin (backlog 207): which origins are open is kept
  // across launches; a closed group holding the open chat shows anyway.
  let forksOpen = $state<Set<string>>(loadForksOpen());
  // ~~`sidebarRows(app.sessions, …)`~~ — since item 299 a chat made main
  // stands in its original's row and the versions it replaced are not
  // rows; the open chat, when it is such a version, lights its main's row.
  const listedIds = $derived(new Set(app.sessions.map((s) => s.id)));
  const activeMain = $derived(
    app.activeSessionId ? mainOf(app.activeSessionId, versions.map, listedIds) : null,
  );
  // Item 454: the open chat reaches the rows only when it is a fork (the
  // one case `sidebarRows` opens a path for) — a switch between two plain
  // chats then leaves `reveal` null, and the whole list (1,800 rows in his
  // main project) is not rebuilt on every tab click.
  const reveal = $derived(
    activeMain && app.sessions.some((s) => s.id === activeMain && !!s.forked_from) ? activeMain : null,
  );
  const rows = $derived(sidebarRows(sidebarSessions(app.sessions, versions.map), forksOpen, reveal));
  /** The row is lit: its chat is in front, or a version it replaced is. */
  function rowLit(id: string): boolean {
    if (chatSelected(id)) return true;
    const a = app.activeSessionId;
    return !!a && a !== id && activeMain === id && chatSelected(a);
  }
  function toggleForks(id: string) {
    forksOpen = toggledForks(forksOpen, id);
    saveForksOpen(forksOpen);
  }

  // ---- item 534: the ruled, dated list; two-line rows; the live row ----
  // Two clocks: the day's (a minute's step) for the headings and each row's
  // time, so the 1,800-row list is cut again once a minute at most; and the
  // live rows' (a second's step, only while a chat runs) for their timers.
  let dayNow = $state(Date.now());
  let liveNow = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (dayNow = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  /** Every chat whose turn runs now: on screen, parked or off screen. */
  const lives = $derived(liveChats());
  const liveBy = $derived(new Map(lives.flatMap((l) => (l.session ? [[l.session, l] as const] : []))));
  $effect(() => {
    if (lives.length === 0) return;
    liveNow = Date.now();
    const t = setInterval(() => (liveNow = Date.now()), 1000);
    return () => clearInterval(t);
  });
  /** The live reply's segments of a running chat, for its tool count. */
  function liveSegments(id: string): readonly { kind: string }[] | null {
    const b = app.background[id];
    if (b) return b.live?.segments ?? null;
    if (app.parked?.session === id) return app.parked.live?.segments ?? null;
    if (app.busy && !app.parked && app.activeSessionId === id) return app.live?.segments ?? null;
    return null;
  }
  // The rows' context readings (`chatContext.svelte.ts`): the open chat's
  // gauge, and each chat running off screen, kept under the chat's id.
  $effect(() => {
    const id = app.activeSessionId;
    const used = contextUsed();
    // Only a window known to be this chat's (559, 534-2): else the stored one stays.
    const limit = connectionWindowFor(id);
    untrack(() => noteChatContext(id, used, limit));
  });
  $effect(() => {
    for (const l of lives) {
      if (!l.session || l.onScreen || !l.usage) continue;
      const used = l.usage.input_tokens + l.usage.output_tokens;
      const id = l.session;
      untrack(() => noteChatContext(id, used, 0));
    }
  });
  /** `· 3 tools` for a running chat's row; empty before its first call. */
  function toolsText(id: string): string {
    const n = toolCount(liveSegments(id));
    return n > 0 ? `· ${n} tool${n === 1 ? "" : "s"}` : "";
  }
  /** A row's size and bar: the last reading, its share of the window, and
   *  whether that is past the chat's hand-off mark. */
  function rowCtx(id: string) {
    const r = contextOf(id);
    if (!r) return null;
    return { used: r.used, look: ctxLook(r.used, r.limit, handoffMark(id, r.limit || null)) };
  }
  /** Item 597: which chats a next chat continues, once per listing. */
  const handedTo = $derived(handoffChildren(app.sessions));
  /** The row's left-edge cue (item 597): handed off, or needs a hand-off —
   *  past its mark by the row's own reading, or with none, by the
   *  listing's newest reply against a mark in tokens (`pastByTokens`). */
  function rowCue(s: SessionMeta, ctx: ReturnType<typeof rowCtx>) {
    const past = ctx?.look
      ? ctx.look.past
      : pastByTokens(ctx?.used ?? s.context_used, ownMark(s.id)?.value ?? null, handoffCap(), NEVER);
    return handoffCue(s.id, handedTo, past, neverHandsOff(s.id));
  }
  /** The row's hover: its short id (it left the visible line) and the exact time. */
  function rowTip(s: SessionMeta): string {
    return `${s.id.slice(0, 8)} · last used ${exactTime(s.modified)} (${relativeTime(s.modified, dayNow)})`;
  }

  // Threads in the sidebar (nightshift backlog 288): under the project, a
  // group per research thread — its name and Start-here status line, its
  // bound chats inside, newest first — then the chats in no thread, as
  // before. Which groups are closed is kept per project and thread across
  // launches; a closed group holding the open chat shows anyway.
  // The listing is kept with the project it was read for (backlog 292,
  // `threadPanel.svelte.ts`), so a late answer never shows under another project.
  const threads = $derived(threadList.project === (app.project?.id ?? "") ? threadList.list : []);
  let threadsClosed = $state<Set<string>>(loadForksOpen(THREADS_CLOSED_KEY));
  const projectKey = $derived(app.project?.id ?? "");
  // His order of the threads (item 426): the backend's, most recently
  // touched first, until he drags one; then his, kept per project.
  let threadOrder = $state<string[] | undefined>(undefined);
  $effect(() => {
    threadOrder = loadThreadOrder(projectKey);
  });
  const ordered = $derived(orderedThreads(threads, threadOrder));
  // The groups without the open chat, then (item 454) a closed group that
  // holds it opened over them — the same object back when none does, so a
  // tab click between chats outside closed groups redraws no row.
  const split0 = $derived(
    app.project ? threadGroups(rows, ordered, threadsClosed, projectKey) : { groups: [], loose: rows },
  );
  const split = $derived.by(() => {
    const a = app.activeSessionId;
    const s = split0;
    const holds = (g: (typeof s.groups)[number]) => !g.open && g.rows.some((r) => r.meta.id === a);
    if (!a || !s.groups.some(holds)) return s;
    return { groups: s.groups.map((g) => (holds(g) ? { ...g, open: true } : g)), loose: s.loose };
  });
  const groups = $derived(split.groups);
  const loose = $derived(split.loose);
  /** Item 534: the chats in no thread, cut by day under ruled headings. */
  const sections = $derived(daySections(loose, dayNow));
  // Re-read the project's threads when the project changes and whenever
  // the listing does (a binding, a new thread from the picker, a wrap-up).
  $effect(() => {
    void projectKey;
    void app.sessions;
    if (!app.project) return;
    void refreshThreadList();
  });
  function toggleThread(slug: string) {
    threadsClosed = toggledForks(threadsClosed, threadKey(projectKey, slug));
    saveForksOpen(threadsClosed, THREADS_CLOSED_KEY);
  }

  // A chat row dragged onto a thread's group binds it there; onto "Not in
  // a thread", unbinds it — the same `thread` line the picker writes
  // (`moveChatToThread`). The drag is the tab drag's (`{kind: "chat"}`),
  // so it still opens a tab or a pane when dropped there instead. Only a
  // log line is written: a refused move leaves the chat where it was.
  let dropOn = $state<string | null>(null);
  function threadOfRow(id: string): string | null {
    return app.sessions.find((s) => s.id === id)?.thread ?? null;
  }
  function overDrop(e: DragEvent, slug: string | null) {
    const c = app.draggingContent;
    if (!app.project || c?.kind !== "chat" || !c.session) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const target = slug ?? "";
    const here = (threadOfRow(c.session) ?? "") === target;
    dropOn = here ? null : target;
  }
  function leaveDrop(e: DragEvent) {
    const el = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    dropOn = null;
  }
  function onDropChat(e: DragEvent, slug: string | null) {
    dropOn = null;
    const c = droppedContent(e);
    if (!app.project || c?.kind !== "chat" || !c.session) return;
    e.preventDefault();
    e.stopPropagation();
    endContentDrag();
    void moveChatToThread(c.session, slug);
  }
  $effect(() => {
    if (!app.draggingContent) {
      dropOn = null;
      insertBefore = undefined;
    }
  });

  // Drag a thread to reorder (item 426): its name row carries the tab
  // drag's `{kind: "thread"}` (so onto a strip or a pane it still opens
  // the thread's tab); over the Threads section a line shows where it
  // lands — above the group whose head the pointer is in the top half of,
  // else below it — and the drop keeps the new order for this project.
  /** Where a dragged thread would land: before that slug, `null` at the end; undefined when no thread is dragged here. */
  let insertBefore = $state<string | null | undefined>(undefined);
  const realSlugs = $derived(ordered.map((t) => t.slug));
  function draggedThread(): string | null {
    const c = app.draggingContent;
    return c?.kind === "thread" ? c.slug : null;
  }
  function overThread(e: DragEvent, g: ThreadGroup): boolean {
    if (!draggedThread()) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const head = (e.currentTarget as HTMLElement).querySelector(".tg-head") ?? (e.currentTarget as HTMLElement);
    const r = head.getBoundingClientRect();
    const i = realSlugs.indexOf(g.slug);
    if (i < 0) insertBefore = null;
    else if (e.clientY < r.top + r.height / 2) insertBefore = g.slug;
    else insertBefore = realSlugs[i + 1] ?? null;
    return true;
  }
  function overThreadsEnd(e: DragEvent): boolean {
    if (!draggedThread()) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    insertBefore = null;
    return true;
  }
  function dropThread(e: DragEvent): boolean {
    const c = droppedContent(e);
    if (c?.kind !== "thread") return false;
    e.preventDefault();
    e.stopPropagation();
    const before = insertBefore;
    insertBefore = undefined;
    endContentDrag();
    if (before === undefined || !realSlugs.includes(c.slug)) return true;
    const next = reordered(realSlugs, c.slug, before);
    if (next.join("/") === realSlugs.join("/")) return true;
    threadOrder = next;
    saveThreadOrder(projectKey, next);
    return true;
  }
  /** The group the insertion line is drawn on: above `before`, or below the last thread for the end. */
  function lineAt(g: ThreadGroup): "before" | "after" | null {
    if (insertBefore === undefined) return null;
    if (insertBefore === g.slug) return "before";
    if (insertBefore === null && realSlugs.at(-1) === g.slug) return "after";
    return null;
  }

  // The thread's right-click menu (item 424): Open · Open in a new tab ·
  // Open beside · New chat in this thread · Rename · Reveal in Finder ·
  // Delete thread…, placed as the chat menu is (`placeMenu`, item 425).
  let threadMenu = $state<{ g: ThreadGroup; x: number; below: number; above: number } | null>(null);
  function openThreadMenu(e: MouseEvent, g: ThreadGroup) {
    e.preventDefault();
    rowMenu = null;
    threadMenu = { g, x: e.clientX, below: e.clientY, above: e.clientY };
  }
  function threadPick<T>(run: (g: ThreadGroup) => T) {
    const g = threadMenu?.g;
    threadMenu = null;
    if (g) run(g);
  }
  let threadRenaming = $state<string | null>(null);
  let threadDraft = $state("");
  let threadRenameFrom = "";
  function startThreadRename(g: ThreadGroup) {
    threadRenaming = g.slug;
    threadDraft = g.title;
    threadRenameFrom = g.title;
  }
  async function commitThreadRename(slug: string) {
    // As a chat's rename: only the field still open commits; unchanged or
    // emptied is a cancel.
    if (threadRenaming !== slug) return;
    const name = renamedTo(threadDraft, threadRenameFrom);
    threadRenaming = null;
    if (!name) return;
    await renameThread(slug, name);
  }
  let deletingThread = $state<ThreadGroup | null>(null);
  function confirmDeleteThread() {
    const g = deletingThread;
    deletingThread = null;
    if (g) void deleteThread(g.slug);
  }
  let rowSub = $state<RowSub | null>(null);
  /** The row that opened the submenu: it places the submenu and takes focus back. */
  let rowSubFrom: HTMLElement | null = null;
  let rowSubEl = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!rowMenu) closeRowSub();
  });
  const rowOthers = $derived(threads.filter((t) => t.slug !== (rowMenu?.s.thread ?? null)));
  const moveTargets = $derived(app.projects.filter((p) => p.id !== app.project?.id));
  function rowMoveProject(to: string | null) {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) void moveSession(s.id, to);
  }
  function rowMove(slug: string | null) {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) void moveChatToThread(s.id, slug);
  }
  function startInThread(slug: string) {
    kinds = false;
    void newChatInThread(slug);
  }

  function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    deleting = null;
    void deleteSession(id);
  }

  // Inline rename. A name is generated once, from the first exchange, so a
  // long chat that has moved on keeps describing where it started; renaming
  // it automatically would mean guessing when a conversation has drifted,
  // which the user can see and the app cannot.

  // The row's ▭ tab glyph (backlog 099) was dropped in nightshift backlog
  // 239 (2026-09-26): a font drew it as a thin empty box nobody could read,
  // and the tab strip already shows which chats are open.

  /**
   * A chat row's right-click menu (backlog 099's leftover, board 9a):
   * Open · Open in a new tab (⌘-click) · Open beside (drag) · Rename ·
   * Delete…. The board's *Fork* is not here: only the open chat forks, at
   * a turn, and a whole-chat fork from a row needs the backend (blocker
   * 380). Each item does what the row's own gesture does.
   */
  /**
   * Where the menu opens (item 425): `x` its left edge (its right edge with
   * `alignRight`), `below` the top it takes dropping down, `above` the
   * bottom it takes flipping up. `placeMenu` picks, once the menu is drawn
   * and its size known, so it always fits the window.
   */
  let rowMenu = $state<{ s: SessionMeta; x: number; below: number; above: number; alignRight?: boolean } | null>(null);
  function openRowMenu(e: MouseEvent, s: SessionMeta) {
    e.preventDefault();
    threadMenu = null;
    rowMenu = { s, x: e.clientX, below: e.clientY, above: e.clientY };
  }
  /**
   * The row's one tool, ··· (backlog 208, design C, blocker 436: "the triple
   * dots thing might be the way to go"): the same menu as a right-click,
   * its right edge under the button's, dropped below it — or raised above
   * it when the row sits too near the window's foot for the menu to fit
   * (since item 425 measured, not guessed: `placeMenu`).
   */
  function openRowMenuFrom(e: MouseEvent, s: SessionMeta) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    threadMenu = null;
    rowMenu = { s, x: r.right, below: r.bottom + 4, above: r.top - 4, alignRight: true };
  }
  const viewSize = () => ({ w: window.innerWidth, h: window.innerHeight });
  /** A menu's natural size: its content's full height, not the capped box's (so a cap never feeds back). */
  const naturalSize = (el: HTMLElement) => ({ w: el.offsetWidth, h: el.scrollHeight + (el.offsetHeight - el.clientHeight) });
  function setPlaced(el: HTMLElement, p: Placed) {
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.maxHeight = p.maxHeight === undefined ? "" : `${p.maxHeight}px`;
  }
  /** The New chat menu stops 12 px above the window's bottom and scrolls inside (nightshift backlog 512):
   *  uncapped, it ran past the window and the sidebar's overflow cut it off. */
  function fitBelow(el: HTMLElement) {
    const cap = () => {
      el.style.maxHeight = `${Math.max(160, viewSize().h - el.getBoundingClientRect().top - 12)}px`;
    };
    cap();
    window.addEventListener("resize", cap);
    return { destroy: () => window.removeEventListener("resize", cap) };
  }
  function placeRowMenu(el: HTMLElement, at: MenuAnchor) {
    let anchor = at;
    const place = () => {
      setPlaced(el, placeMenu(anchor, naturalSize(el), viewSize()));
      if (rowSubEl) placeRowSub(rowSubEl);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return {
      update(next: MenuAnchor) {
        if (next.x === anchor.x && next.below === anchor.below && next.above === anchor.above) return;
        anchor = next;
        place();
      },
      destroy() {
        ro.disconnect();
        window.removeEventListener("resize", place);
      },
    };
  }
  let rowMenuEl = $state<HTMLElement | null>(null);
  function placeRowSub(el: HTMLElement) {
    if (!rowSubFrom || !rowMenuEl) return;
    setPlaced(el, placeSubmenu(rowSubFrom.getBoundingClientRect(), rowMenuEl.getBoundingClientRect(), naturalSize(el), viewSize()));
  }

  // Hover intent for the submenus (item 425): a submenu opens a beat after
  // the pointer rests on its row, and a move across the rows below toward
  // it — the diagonal into a flyout — does not close it (`aimsAt`, the
  // safe triangle); a move anywhere else switches at once.
  const SUB_OPEN_MS = 120;
  const SUB_AIM_MS = 300;
  let subTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPt: Point | null = null;
  function closeRowSub() {
    clearTimeout(subTimer);
    rowSub = null;
    rowSubFrom = null;
  }
  function openRowSub(k: RowSub, from: HTMLElement, focusFirst = false) {
    clearTimeout(subTimer);
    rowSubFrom = from;
    rowSub = k;
    if (focusFirst) {
      // After the flyout is drawn (`tick`, not a frame: a frame never comes in a hidden view).
      void tick().then(() => rowSubEl?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
    }
  }
  function rowMenuMove(e: PointerEvent) {
    const prev = lastPt;
    const now = { x: e.clientX, y: e.clientY };
    lastPt = now;
    const item = (e.target as Element).closest<HTMLElement>('[role="menuitem"]');
    const k = (item?.dataset.sub as RowSub | undefined) ?? null;
    if (k && (item as HTMLButtonElement).disabled) return;
    if (k && k === rowSub && item === rowSubFrom) {
      clearTimeout(subTimer);
      return;
    }
    const aiming = !!(rowSub && rowSubEl && prev && aimsAt(prev, now, rowSubEl.getBoundingClientRect()));
    clearTimeout(subTimer);
    const go = () => {
      if (k && item) openRowSub(k, item);
      else closeRowSub();
    };
    if (aiming) subTimer = setTimeout(go, SUB_AIM_MS);
    else if (k) subTimer = setTimeout(go, rowSub ? 0 : SUB_OPEN_MS);
    else if (rowSub) go();
  }
  /** The pointer reached the submenu: whatever was pending (a close while aiming) is off. */
  function rowSubMove(e: PointerEvent) {
    clearTimeout(subTimer);
    lastPt = { x: e.clientX, y: e.clientY };
  }
  function rowSubClick(e: MouseEvent, k: RowSub) {
    const from = e.currentTarget as HTMLElement;
    // A click (or ↵ / space, which click with detail 0) opens it; a second
    // click on its own row closes it, as the old toggles did.
    if (rowSub === k && rowSubFrom === from) closeRowSub();
    else openRowSub(k, from, e.detail === 0);
  }
  /** ↑ ↓ walk a menu's rows; → opens a submenu row's flyout, ← and esc go back to its row. */
  function menuKeys(e: KeyboardEvent, inSub: boolean) {
    const box = e.currentTarget as HTMLElement;
    const items = [...box.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      if (n === 0) return;
      const next = at < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (at + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      items[next].focus();
      return;
    }
    if (!inSub && e.key === "ArrowRight") {
      const el = document.activeElement as HTMLElement | null;
      const k = el?.dataset.sub as RowSub | undefined;
      if (k && el && !(el as HTMLButtonElement).disabled) {
        e.preventDefault();
        openRowSub(k, el, true);
      }
      return;
    }
    if (inSub && (e.key === "ArrowLeft" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      const from = rowSubFrom;
      closeRowSub();
      from?.focus();
    }
  }
  function rowOpen(how: "replace" | "new" | "beside") {
    const s = rowMenu?.s;
    rowMenu = null;
    if (!s) return;
    app.openNext = how;
    void openSession(s.id);
  }
  function rowRename() {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) startRename(s.id, s.title ?? s.first_user ?? "");
  }
  function rowMakeMain() {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) void makeMainChat(s.id);
  }
  // Backlog 371: the capture pass over this one chat, then Dream offered.
  function rowSaveMemory() {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) void saveMemoryFromChat(s.id);
  }
  function rowDelete() {
    const s = rowMenu?.s;
    rowMenu = null;
    if (s) deleting = s;
  }

  let renaming = $state<string | null>(null);
  let draft = $state("");
  /** The name the field opened with (backlog 376): unchanged is a cancel. */
  let renameFrom = "";

  function startRename(id: string, current: string) {
    renaming = id;
    draft = current;
    renameFrom = current;
  }

  async function commitRename(id: string) {
    // Only the row still being renamed commits (review 2026-09-17, agent
    // Q's FE12 patch note): Escape clears `renaming`, the input leaves the
    // DOM, and the blur that removal can fire must not turn the cancel
    // into a rename; Enter's own blur is the one commit.
    if (renaming !== id) return;
    // Unchanged or emptied is a cancel, not a rename: an empty name would
    // leave the row labelled by its opening message with no way back.
    const name = renamedTo(draft, renameFrom);
    renaming = null;
    if (!name) return;
    // Through the state's version, which puts the inverse on the undo
    // stack and toasts a failure itself (nightshift backlog 064).
    await renameSession(id, name);
  }

  // The search box (nightshift backlog 117, boards 11a–11c). ~~`query` is
  // what is typed and `hits` is what came back~~ — the box is now the search
  // panel's own field: focusing or typing in it opens the panel in this
  // column, which searches (`SearchPanel.svelte`, `app.search`) and lists
  // the matching messages; the box comes back on ↵ or esc holding the query,
  // with a `14 ▸` to reopen while an answer is kept. The old inline list of
  // matching chats, its 180 ms debounce and `search_sessions` call, is
  // retired here; the ⌘K palette still uses `search_sessions`.
  function openSearch() {
    if (app.layout.sidebarCollapsed) toggleSidebar();
    app.search.open = true;
  }

  /**
   * The panel's chord from anywhere: toggles it; from ⌘F's bar it carries
   * the bar's query (board 11c's "the query travels"). `SEARCH_KEY` in
   * `find.ts` is the one place the key is named (blocker 164).
   */
  function windowKeys(e: KeyboardEvent) {
    // The row menu is reachable from the keyboard now (the ··· button,
    // backlog 208), so Escape closes it.
    if (threadMenu && e.key === "Escape") {
      e.preventDefault();
      threadMenu = null;
      return;
    }
    if (rowMenu && e.key === "Escape") {
      e.preventDefault();
      // An open submenu goes first (item 425); the next esc closes the menu.
      if (rowSub) {
        const from = rowSubFrom;
        closeRowSub();
        from?.focus();
        return;
      }
      rowMenu = null;
      return;
    }
    if (findChord(e, isMac ? e.metaKey : e.ctrlKey) !== "everywhere") return;
    e.preventDefault();
    if (app.search.open) {
      app.search.open = false;
      return;
    }
    const fromBar = findBar()?.query() ?? "";
    if (fromBar && fromBar !== app.search.query) app.search.query = fromBar;
    openSearch();
  }

  /**
   * The path, shortened from the left. A project root is usually deep and the
   * distinguishing part is the tail — `…/dev/Nightloom` identifies it where
   * `C:\Users\someone\code\…` does not.
   */
  function shortPath(path: string): string {
    return path.length <= 34 ? path : `…${path.slice(-33)}`;
  }

  /**
   * Open blockers summed across every enabled project, not just the one
   * open — the badge is a signal to go look, and a blocker on a project
   * that is not the current one is exactly the kind of thing a per-project
   * count would hide.
   */
  /** The open project's Nightshift row, once the rows are read. */
  const openRow = $derived(
    app.project ? (app.nightshift.rows.find((r) => r.id === app.project?.id) ?? null) : null,
  );
  // Item 968: the badge counts the held blockers only (an older backend: every open one).
  const nightshiftBlockers = $derived(blockerCounts(null, openRow?.nightshift).held);
  /** A morning page this window has not opened, on the open project. */
  const nightshiftNewPage = $derived.by(() => {
    const r = openRow;
    const newest = r?.nightshift?.newest_morning;
    if (!r || !newest) return false;
    return !(app.nightshift.read[r.id] ?? []).some((n) => sameMorning(n, newest));
  });

  // The three modes. ~~Chats and Notes leave the Nightshift screens if
  // they were showing; Nightshift opens them.~~ Since nightshift backlog
  // 140 (2026-09-17) the Nightshift page is a tab, so the sidebar's mode
  // and the centre are decoupled: Chats and Notes change the list only,
  // and the Nightshift tab stays in front until another tab is clicked.
  // Item 874 (his blocker 2203): Nightshift takes the current tab over in place; Chats or Notes turn that tab back.
  function goChats() {
    app.leftTab = "chats";
    // The list stays the one he picked even when the tab turns back into a note (showNote picks Notes).
    void backFromNightshift().then((turned) => turned && (app.leftTab = "chats"));
  }
  function goNotes() {
    app.leftTab = "notes";
    void backFromNightshift().then((turned) => turned && (app.leftTab = "notes"));
  }

  /**
   * Item 461: a file from Finder held over the sidebar while it shows
   * Chats switches it to Notes after 300 ms, where the Project section's
   * drop box takes the file; a drag that leaves without dropping here
   * puts Chats back (`dragToNotes.ts`). Real files only — `carriesFiles`
   * — so a chat, a tab or a note dragged inside the app switches nothing.
   */
  const dragNotes = new DragToNotes();
  let asideEl = $state<HTMLElement | null>(null);
  /** Item 471: one timer, set only while a file drag is held, for the
   *  next moment the answer can change (`wakeAt`) — 461 polled every
   *  100 ms for the life of the window. */
  let dragWake: ReturnType<typeof setTimeout> | null = null;
  function dragTick() {
    const now = performance.now();
    const want = dragNotes.tick(now, app.leftTab);
    if (want) app.leftTab = want;
    if (dragWake !== null) clearTimeout(dragWake);
    const at = dragNotes.wakeAt(now);
    dragWake = at === null ? null : setTimeout(dragTick, Math.max(0, at - now));
  }
  function onAsideDragEnter(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    dragNotes.enter(performance.now());
    dragTick();
  }
  function onAsideDragOver(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    dragNotes.over(performance.now());
    dragTick();
  }
  function onAsideDragLeave(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    dragNotes.leave();
    dragTick();
  }
  onMount(() => {
    // The 300 ms passes with the pointer held still, and a drag that
    // vanished (Escape, a drop elsewhere) is noticed, between events:
    // `dragTick` sets its own timer for that while a drag is held.
    const ended = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer) && e.type !== "dragend") return;
      const inside = e.type === "drop" && !!asideEl && e.target instanceof Node && asideEl.contains(e.target);
      dragNotes.end(inside);
      dragTick();
    };
    window.addEventListener("drop", ended, true);
    window.addEventListener("dragend", ended, true);
    return () => {
      if (dragWake !== null) clearTimeout(dragWake);
      window.removeEventListener("drop", ended, true);
      window.removeEventListener("dragend", ended, true);
    };
  });

  // ---- Nightshift mode: the open project's card (round 2, point 12). The
  // page shows the project in the top-left chip — there is no second list
  // and no second selection — so this mode shows that one project: its row
  // when it has a contract, the Enable form when it has none.


  /** The two conditions worth a dim warning under a row, joined into one line. */
  function rowHints(info: NightshiftInfo): string {
    const h: string[] = [];
    if (!info.git) h.push("no git repo");
    if (!info.runner_present) h.push(`no runner at ${info.runner}`);
    return h.join(" · ");
  }

  /** `38 items · 3 open · 2026-09-11` */
  function rowMeta(info: NightshiftInfo): string {
    const page = info.newest_morning
      ? info.newest_morning.replace(/\.md$/, "")
      : "no page yet";
    const bc = blockerCounts(null, info);
    return `${info.items} items · ${bc.held} held · ${bc.decided} decided · ${page}`;
  }

  /**
   * The Enable form: which row it is open on and the runner path typed into
   * it. Prefilled with the one install a registered project shows (the
   * nightshift repo, when it is a project here); an empty path enables with
   * no `runner` key. Item 038 / blocker 024: one install, named by path.
   */
  let enabling = $state<string | null>(null);
  let runnerPath = $state("");

  function openEnable(id: string): void {
    enabling = id;
    runnerPath = app.nightshift.defaultRunner ?? "";
  }

  async function confirmEnable(): Promise<void> {
    const id = enabling;
    if (!id) return;
    enabling = null;
    await enableNightshift(id, runnerPath.trim() || undefined);
  }

  // The Enable form opens on the open project as soon as its row says it
  // has no contract — the card is the form; nothing to click first. The
  // default runner arrives after the rows do, so a form opened on an empty
  // default is filled in when it lands (and never refilled over a value the
  // user typed or cleared: `runnerPath` is read untracked).
  $effect(() => {
    const r = openRow;
    const d = app.nightshift.defaultRunner;
    if (!r || r.nightshift || r.disabled || !r.exists || r.workspace === null) return;
    if (enabling !== r.id) {
      openEnable(r.id);
    } else if (d && !untrack(() => runnerPath).trim()) {
      runnerPath = d;
    }
  });

  /**
   * Disable, behind the warning (item 037). The dialog is opened on a row;
   * confirming renames the config through the backend and re-reads the
   * list, which the project then leaves. If it was the selected project the
   * selection is dropped so the refresh picks another.
   */
  let disabling = $state<NightshiftRow | null>(null);
  let disableBusy = $state(false);

  async function confirmDisable(): Promise<void> {
    const row = disabling;
    if (!row) return;
    disableBusy = true;
    try {
      await api.nightshiftDisable(row.id);
    } catch (e) {
      addToast(String(e));
      disableBusy = false;
      return;
    }
    disableBusy = false;
    disabling = null;
    await refreshNightshift();
    addToast(`Nightshift disabled on ${row.name}; the files stay`);
  }
  // Item 763 H5: which chats Home started (read with the list, then each minute).
  $effect(() => {
    void app.project?.id;
    void refreshRoutes();
    // Item 767: and which were started from outside the app.
    void refreshDoorStarted();
    const t = setInterval(() => (void refreshRoutes(), void refreshDoorStarted()), 60_000);
    return () => clearInterval(t);
  });

  return {
    get KINDS() {
      return KINDS;
    },
    get KIND_ROWS() {
      return KIND_ROWS;
    },
    get asideEl() {
      return asideEl;
    },
    set asideEl(v) {
      asideEl = v;
    },
    commitRename,
    commitThreadRename,
    confirmDelete,
    confirmDeleteThread,
    confirmDisable,
    confirmEnable,
    get dayNow() {
      return dayNow;
    },
    set dayNow(v) {
      dayNow = v;
    },
    get deleting() {
      return deleting;
    },
    set deleting(v) {
      deleting = v;
    },
    get deletingThread() {
      return deletingThread;
    },
    set deletingThread(v) {
      deletingThread = v;
    },
    get disableBusy() {
      return disableBusy;
    },
    set disableBusy(v) {
      disableBusy = v;
    },
    get disabling() {
      return disabling;
    },
    set disabling(v) {
      disabling = v;
    },
    get draft() {
      return draft;
    },
    set draft(v) {
      draft = v;
    },
    draggedThread,
    get dropOn() {
      return dropOn;
    },
    set dropOn(v) {
      dropOn = v;
    },
    dropThread,
    get engine() {
      return engine;
    },
    fitBelow,
    goChats,
    goNotes,
    get groups() {
      return groups;
    },
    get kinds() {
      return kinds;
    },
    set kinds(v) {
      kinds = v;
    },
    leaveDrop,
    lineAt,
    get liveBy() {
      return liveBy;
    },
    get liveNow() {
      return liveNow;
    },
    set liveNow(v) {
      liveNow = v;
    },
    get loose() {
      return loose;
    },
    get menu() {
      return menu;
    },
    set menu(v) {
      menu = v;
    },
    menuKeys,
    get mod() {
      return mod;
    },
    get moveTargets() {
      return moveTargets;
    },
    get nightshiftBlockers() {
      return nightshiftBlockers;
    },
    get nightshiftNewPage() {
      return nightshiftNewPage;
    },
    onAsideDragEnter,
    onAsideDragLeave,
    onAsideDragOver,
    onDropChat,
    get openRow() {
      return openRow;
    },
    openRowMenu,
    openRowMenuFrom,
    openSearch,
    openThreadMenu,
    overDrop,
    overThread,
    overThreadsEnd,
    placeRowMenu,
    placeRowSub,
    get renaming() {
      return renaming;
    },
    set renaming(v) {
      renaming = v;
    },
    rowCtx,
    rowCue,
    rowDelete,
    rowHints,
    rowLit,
    rowMakeMain,
    get rowMenu() {
      return rowMenu;
    },
    set rowMenu(v) {
      rowMenu = v;
    },
    get rowMenuEl() {
      return rowMenuEl;
    },
    set rowMenuEl(v) {
      rowMenuEl = v;
    },
    rowMenuMove,
    rowMeta,
    rowMove,
    rowMoveProject,
    rowOpen,
    get rowOthers() {
      return rowOthers;
    },
    rowRename,
    rowSaveMemory,
    get rowSub() {
      return rowSub;
    },
    set rowSub(v) {
      rowSub = v;
    },
    rowSubClick,
    get rowSubEl() {
      return rowSubEl;
    },
    set rowSubEl(v) {
      rowSubEl = v;
    },
    rowSubMove,
    rowTip,
    get runnerPath() {
      return runnerPath;
    },
    set runnerPath(v) {
      runnerPath = v;
    },
    get sections() {
      return sections;
    },
    shortPath,
    startInThread,
    startKind,
    startOfKind,
    startRename,
    startThreadRename,
    get threadDraft() {
      return threadDraft;
    },
    set threadDraft(v) {
      threadDraft = v;
    },
    get threadMenu() {
      return threadMenu;
    },
    set threadMenu(v) {
      threadMenu = v;
    },
    threadPick,
    get threadRenaming() {
      return threadRenaming;
    },
    set threadRenaming(v) {
      threadRenaming = v;
    },
    get threads() {
      return threads;
    },
    toggleForks,
    toggleThread,
    toolsText,
    windowKeys,
  };
}
