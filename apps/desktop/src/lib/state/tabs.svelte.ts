// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { asideKept, isPrivateChat, markChatMode } from "../asides";
import * as tabs from "../tabs";
import type { TabContent } from "../tabs";
import { stopKeepWarm } from "../keepWarm.svelte";
import { UNFILED_TABS, saveNewProject, saveWorkspaceFor, snapshot } from "../tabsStore";
import type { NoteScope } from "../types";
import { asidesOf, type Aside } from "./asides.svelte";
import { showNightshift } from "./nightshift.svelte";
import { showNote, showGraph, leaveNote } from "./notes.svelte";
import { app, showNewProject, activating, activateTab, tabsOwner, newSession, chatMode, backToNewChat, canLeaveRunning, openSession, addToast } from "../state.svelte";

// ---- tabs and panes (nightshift backlog 099) ----

/**
 * What the centre shows now, as tab content: the open note when the view
 * is the note, the open chat (null while it is a new, unsent one) when it
 * is the chat, and — since nightshift backlog 140 — the Nightshift page,
 * the graph or the New project form as the singleton tab each is.
 * ~~Null on the views that are not tabs — the graph, Nightshift, the New
 * project form — which take the whole centre as they always have.~~
 * (2026-09-17: tabs sit above everything now; nothing takes the whole
 * centre.) Null only for a note view with no note.
 */
export function shownContent(): TabContent | null {
  switch (app.view) {
    case "note":
      return app.openNote ? { kind: "note", ...app.openNote } : null;
    case "chat":
      return { kind: "chat", session: app.activeSessionId };
    case "nightshift":
      return { kind: "nightshift" };
    case "graph":
      return { kind: "graph" };
    case "new-project":
      return { kind: "new-project" };
  }
}
export function reflectTabs(): void {
  // A tab being activated is already in front; the changes its opener
  // makes on the way are not a new landing.
  if (activating > 0) return;
  const content = shownContent();
  if (!content) return;
  const how = app.openNext;
  app.openNext = "replace";
  const ws = app.tabs;
  if (how === "beside") {
    tabs.openBeside(ws, content, "new");
    return;
  }
  tabs.land(ws, tabs.focusedPane(ws), content, how);
}

/**
 * Bring the open chat's tab forward when an opener asked for the chat
 * already open (backlog 297). A thread, file, aside, subagent, attachment,
 * project or web tab in front changes nothing global, so the chat behind
 * it is still `app.activeSessionId` with the view "chat": opening it again
 * changes nothing, the reflection never runs, and the click did nothing.
 * Its tab in the focused pane, else in the other pane (focused there, as
 * the thread's own tab is), comes forward; with none, one lands as the
 * reflection would (⌘ beside, else in place) and the modifier is handed
 * back.
 */
export function frontOpenChat(): void {
  if (activating > 0 || app.view !== "chat") return;
  const content: TabContent = { kind: "chat", session: app.activeSessionId };
  const ws = app.tabs;
  const pane = tabs.focusedPane(ws);
  const now = tabs.activeTab(pane)?.content;
  if (!now || tabs.sameContent(now, content)) return;
  const held = tabs.findTab(pane, content) ?? tabs.findAnywhere(ws, content);
  if (held) {
    tabs.activate(ws, held.id);
    app.openNext = "replace";
    return;
  }
  reflectTabs();
}

/**
 * Show a tab's content: the activation half. A chat tab opens its chat
 * (or the new-chat state), a note tab its note; a chat other than the open
 * one is refused while a turn runs — the backend holds one session, and
 * `openSession` says no (blocker 182) — so the click lands nothing and a
 * toast says why. The tab is made active first, so the reflection finds
 * it in front and has nothing to change.
 */
/**
 * The chat a tab click is opening (item 454). The tab comes forward before
 * the chat's log arrives, so for that moment the pane draws it as a chat
 * that is not the open one — and that transcript read the same log a second
 * time (`loadPaneLog`), a whole extra read of the file and trip over IPC on
 * every switch, for a view replaced the moment `openSession` returns. While
 * this names the chat the pane waits; cleared when the open settles, so a
 * failed open still reads it.
 */
export const tabOpening = $state<{ chat: string | null }>({ chat: null });

/**
 * Make the globals show `c` — the view, the open chat, the open note —
 * without touching the workspace: the tab is already in front. A chat
 * opens as the sidebar opens it; a note as the Notes list does; the
 * three whole-centre pages through their own openers (backlog 140). A
 * project card and an aside tab are drawn by the pane from the tab
 * alone and change nothing global.
 */
export async function showContentOf(c: TabContent): Promise<void> {
  switch (c.kind) {
    case "note":
      if (app.view !== "note" || app.openNote?.scope !== c.scope || app.openNote?.name !== c.name) {
        showNote(c.scope, c.name);
      }
      return;
    case "chat":
      if (c.session === app.activeSessionId) {
        if (app.view !== "chat") leaveNote();
        return;
      }
      if (c.session === null) await backToNewChat();
      else await openSession(c.session);
      return;
    case "nightshift":
      if (app.view !== "nightshift") showNightshift();
      return;
    case "graph":
      if (app.view !== "graph") showGraph();
      return;
    case "new-project":
      if (app.view !== "new-project") showNewProject();
      return;
    case "project":
    case "aside":
    case "attachment":
    case "subagent":
    case "file":
    case "thread":
    case "browser":
      return;
  }
}

/**
 * Open `content` in the focused pane the way the sidebar would (backlog
 * 140: the + chooser, a drop on a strip's far end): `new` a tab beside
 * the active one, `replace` in its place. The globals are shown through
 * the same openers the sidebar calls and the reflection lands the tab;
 * the two kinds nothing global describes — a project card, an aside —
 * are landed here directly. A chat other than the open one is refused
 * while a turn runs, with the toast (blocker 182).
 */
export async function openContent(content: TabContent, how: tabs.LandHow = "new"): Promise<void> {
  if (
    content.kind === "project" ||
    content.kind === "aside" ||
    content.kind === "attachment" ||
    content.kind === "subagent" ||
    content.kind === "file" ||
    content.kind === "thread" ||
    content.kind === "browser"
  ) {
    const t = tabs.land(app.tabs, tabs.focusedPane(app.tabs), content, how);
    await activateTab(t.id);
    return;
  }
  // ~~A chat other than the open one is refused while a turn runs~~ —
  // since backlog 159 (2026-09-18) it opens as a view of its log, the
  // running chat parked (`peekSession`); only New chat during the pending
  // chat's own first turn is refused, in `newSession`.
  app.openNext = how;
  await showContentOf(content);
  // The reflection is idempotent; run it here too so an opener that
  // changed nothing visible (the page already in front) still lands the
  // tab and hands the modifier back (review E's rule, generalised).
  reflectTabs();
  app.openNext = "replace";
}

/**
 * A content descriptor dropped on a strip (a new tab at `index` in that
 * pane) or on a pane's half (a second pane holding it when there is one
 * pane; the pane it was dropped on when there are two) — backlog 140
 * pass 2. The tab is made first and then activated, so the reflection
 * finds it in front.
 */
export async function dropContent(
  content: TabContent,
  target: { pane: string; index: number } | { side: "left" | "right"; pane: string },
): Promise<void> {
  const ws = app.tabs;
  let tab: tabs.Tab;
  // The floating tab dropped (backlog 145 pass 2): kept where it lands —
  // the same tab moves into the strip or a new pane, and the slot
  // empties — rather than a second tab made beside it.
  const floating = ws.floating;
  if (floating && tabs.sameContent(floating.content, content)) {
    let kept: tabs.Tab | null;
    if ("index" in target) {
      const pane = tabs.paneById(ws, target.pane);
      if (!pane) return;
      kept = tabs.keepFloating(ws, pane, target.index);
    } else if (ws.panes.length < tabs.MAX_PANES) {
      kept = tabs.keepFloatingBeside(ws, target.side);
    } else {
      const pane = tabs.paneById(ws, target.pane);
      if (!pane) return;
      kept = tabs.keepFloating(ws, pane, pane.tabs.length);
    }
    if (kept) await activateTab(kept.id);
    return;
  }
  if ("index" in target) {
    const pane = tabs.paneById(ws, target.pane);
    if (!pane) return;
    tab = tabs.insertAt(ws, pane, content, target.index);
  } else if (ws.panes.length < tabs.MAX_PANES) {
    const existing = tabs.isSingleton(content) ? tabs.findAnywhere(ws, content) : undefined;
    if (existing) {
      tab = existing;
    } else {
      const pane = tabs.makePane([tabs.makeTab(content)]);
      if (target.side === "left") ws.panes.unshift(pane);
      else ws.panes.push(pane);
      tab = pane.tabs[0];
    }
  } else {
    const pane = tabs.paneById(ws, target.pane);
    if (!pane) return;
    tab = tabs.insertAt(ws, pane, content, pane.tabs.length);
  }
  await activateTab(tab.id);
}

/**
 * Focus a pane without changing its tab (a click inside it). A note in
 * front becomes the open note, so the Notes list and ⌘S follow it; ~~a chat
 * in front that is not the open one stays a card — focus alone must not
 * swap the backend's session under a running turn~~. Since backlog 159
 * piece 5 (2026-09-30) both panes are live and focus decides where the
 * composer types: a chat in front that is not the open one opens, as its
 * tab's click opens it — a turn on screen goes to the background (A2) and
 * keeps streaming in the pane it is in, and one running off screen comes
 * back on screen. The backend's session per chat (A1) is what made the
 * old rule unnecessary.
 */
export function focusPane(paneId: string): void {
  const ws = app.tabs;
  if (ws.focused === paneId) return;
  const pane = tabs.paneById(ws, paneId);
  if (!pane) return;
  ws.focused = paneId;
  const c = tabs.activeTab(pane).content;
  if (c.kind === "chat") {
    // The live chat in front: the view follows it. ~~A card stays a
    // card.~~ Another chat opens here (piece 5), through its tab.
    if (c.session === app.activeSessionId) {
      if (app.view !== "chat") leaveNote();
    } else {
      void activateTab(tabs.activeTab(pane).id);
    }
  } else if (c.kind !== "project" && c.kind !== "aside" && c.kind !== "attachment") {
    // A note or one of the whole-centre pages (backlog 140): the view
    // follows the pane, as it did for a note. A project card, an aside
    // and an attachment (backlog 145) are drawn from the tab alone;
    // nothing global follows them.
    void showContentOf(c);
  }
}

/** ⌘T: a new chat in a new tab beside the active one. */
export async function newTab(): Promise<void> {
  // ~~Refused while a turn runs~~ — since backlog 159 New chat opens as a
  // view, the running chat parked; the one refusal is the pending
  // chat's own first turn (one pending slot per project and kind).
  // Lifted once the turn can go to the background (backlog 159, A2).
  if (app.busy && !app.parked && app.activeSessionId === null && !canLeaveRunning()) {
    addToast("This chat is having its first turn — New chat opens when it ends");
    return;
  }
  app.openNext = "new";
  const front = tabs.activeTab(tabs.focusedPane(app.tabs));
  // Already on the new-chat page: the reflection would find the same
  // content and do nothing, and the key would seem dead. Open a second
  // pane's worth of nothing? No — the one new chat is the one new chat.
  if (front.content.kind === "chat" && front.content.session === null && app.view === "chat") {
    app.openNext = "replace";
    return;
  }
  await newSession();
  if (app.error) app.openNext = "replace";
}

/**
 * ⌘W: close a tab — the focused pane's active one when none is named.
 * A running turn's chat cannot be left (the neighbour could not be
 * opened under it), so that one tab waits; every other closes at once,
 * and a background chat's turn keeps running. The neighbour that lands
 * is shown through `activateTab`.
 */
export async function closeTab(tabId?: string): Promise<void> {
  const ws = app.tabs;
  const id = tabId ?? tabs.activeTab(tabs.focusedPane(ws)).id;
  const tab = tabs.tabById(ws, id);
  if (!tab) return;
  const live = tabs.liveTab(ws, app.activeSessionId);
  if (app.busy && live?.id === id) {
    addToast("This chat's turn is running — stop it or wait, then close the tab");
    return;
  }
  // The sole tab, already the new-chat page (backlog 140 — the × he
  // found dead on `b6a9c07`): the model would swap it for an identical
  // one and nothing would show. Say so instead; the window closes from
  // its red light (blocker 183).
  const pane = tabs.paneOf(ws, id);
  if (
    ws.panes.length === 1 &&
    pane?.tabs.length === 1 &&
    tab.content.kind === "chat" &&
    tab.content.session === null &&
    app.view === "chat"
  ) {
    addToast("This is the last tab and it is already a new chat — the window closes from its red light");
    return;
  }
  // Its × closes the New project form (backlog 394); the draft stays.
  if (tab.content.kind === "new-project") app.newProjectOpen = false;
  const r = tabs.close(ws, id);
  // Its keep-warm ends with its last tab (backlog 582).
  if (tab.content.kind === "chat" && tab.content.session) {
    const chat = tab.content.session;
    const still = ws.panes.some((p) => p.tabs.some((t) => t.content.kind === "chat" && t.content.session === chat));
    if (!still) stopKeepWarm(chat);
  }
  if (r.show) await activateTab(r.show.id);
}

/** ⌘⇧] / ⌘⇧[: the next or previous tab, across both panes, wrapping. */
export async function stepTab(dir: 1 | -1): Promise<void> {
  const next = tabs.step(app.tabs, dir);
  if (next) await activateTab(next.id);
}

/** A tab dropped on a strip: reorder, or move into the other pane. */
export async function moveTab(tabId: string, toPaneId: string, index: number): Promise<void> {
  if (!tabs.move(app.tabs, tabId, toPaneId, index)) return;
  await activateTab(tabId);
}

/**
 * Open beside: a second pane holding the tab (a drag to a pane's half,
 * or the menu item on the active tab). With two panes already the tab
 * moves to the other one. A pane's only tab cannot be split off — the
 * model refuses — and the toast says so.
 */
export async function splitTab(tabId: string, side: "left" | "right" = "right"): Promise<void> {
  const ws = app.tabs;
  if (ws.panes.length >= tabs.MAX_PANES) {
    const from = tabs.paneOf(ws, tabId);
    const other = from ? tabs.otherPane(ws, from.id) : undefined;
    if (other) await moveTab(tabId, other.id, other.tabs.length);
    return;
  }
  if (!tabs.split(ws, tabId, side)) {
    addToast("A pane keeps at least one tab — open something else here first");
    return;
  }
  await activateTab(tabId);
}

export async function splitActiveTab(): Promise<void> {
  await splitTab(tabs.activeTab(tabs.focusedPane(app.tabs)).id);
}

/** A deleted chat's tabs go with it; the focused pane lands its neighbour. */
export function dropChatTabs(session: string): void {
  for (const r of tabs.dropChat(app.tabs, session)) {
    if (r.show) void activateTab(r.show.id);
  }
  // And its Running-tasks rows (backlog 160: kept until the chat goes).
  app.subagents = app.subagents.filter((r) => r.session !== session);
}

/** A deleted note's tabs, or every vault note's when the vault moves. */
export function dropNoteTabs(scope: NoteScope, name?: string): void {
  const gone = tabs
    .allTabs(app.tabs)
    .filter((t) => t.content.kind === "note" && t.content.scope === scope && (name === undefined || t.content.name === name));
  for (const t of gone) {
    const r = tabs.close(app.tabs, t.id);
    if (r.show) void activateTab(r.show.id);
  }
}

/** A forgotten project's card goes (backlog 140). */
export function dropProjectTabs(id: string): void {
  for (const r of tabs.dropProject(app.tabs, id)) {
    if (r.show) void activateTab(r.show.id);
  }
}

/** The key of the open project's workspace. */
export function tabsKeyNow(): string {
  return app.project?.id ?? UNFILED_TABS;
}

/**
 * The terminal docks' part (`terminal.svelte.ts` registers it; this file
 * cannot import that one, which imports this): how many shells a pane's
 * dock holds, whether any shell is open, and opening fresh ones.
 */
interface TerminalHooks {
  count(pane: string): number;
  any(): boolean;
  open(pane: string, n: number): Promise<void>;
}
export let terminalHooks: TerminalHooks | null = null;
export function registerTerminalHooks(h: TerminalHooks): void {
  terminalHooks = h;
}

/** Write the New project form — open, in front, its draft — for a
 *  relaunch (backlog 394). Called from the keeper's effect; removes the
 *  key once the form is closed with nothing typed. Best-effort. */
export function flushNewProject(): void {
  if (typeof localStorage === "undefined") return;
  saveNewProject(localStorage, {
    open: app.newProjectOpen,
    front: app.view === "new-project",
    draft: app.newProjectDraft,
  });
}

/** Write the workspace now, under the project it belongs to. Called on
 *  the keeper's debounce (`tabsKeeper.svelte.ts`), on `pagehide` and
 *  before a project switch replaces it. Best-effort. */
export function flushTabs(): void {
  if (tabsOwner === null || typeof localStorage === "undefined") return;
  // An ephemeral chat still open at the window's close is recorded as
  // private before its tabs are stored (blocker 217, batch D's patch note).
  if (app.activeSessionId !== null) markChatMode(app.activeSessionId, chatMode(app.events));
  const counter = terminalHooks;
  saveWorkspaceFor(
    localStorage,
    tabsOwner,
    snapshot(app.tabs, counter ? (p) => counter.count(p) : undefined, storeTabContent),
  );
}

/**
 * The threads of a chat the aside store writes (`asides.ts`: a draft is
 * not kept, nor a turn still asking with nothing arrived), in its order.
 * An aside thread's id is per window — a relaunch numbers them again —
 * so an aside tab is stored by its thread's place in this list.
 */
function storedThreads(session: string): Aside[] {
  // The store's own rule (`asideKept`), since backlog 228 kept a draft
  // with unsent text — one rule, so a tab's place cannot disagree.
  return asidesOf(session).filter(asideKept);
}

/** A tab's content as the store keeps it: an aside tab's thread id as the
 *  thread's place (`storedThreads`); -1 for a thread the store will not
 *  keep, which then does not come back. Everything else as it is. */
function storeTabContent(c: TabContent): TabContent | null {
  if (c.kind !== "aside") return c;
  if (isPrivateChat(c.session, app.sessions)) return null; // blocker 217
  if (c.thread === undefined) return c;
  const at = storedThreads(c.session).findIndex((a) => a.id === c.thread);
  return { kind: "aside", session: c.session, thread: at };
}

/**
 * A stored tab's content made live, or null when its target is gone: a
 * chat not on the list, a project or vault note that no longer lists, a
 * forgotten project, an aside thread not in the stash (its place mapped
 * back to this window's id). A web tab reopens at its address; the
 * singletons and the note scopes no list covers are kept.
 */
export function resolveTabContent(c: TabContent): TabContent | null {
  const chat = (id: string) => app.sessions.some((s) => s.id === id);
  switch (c.kind) {
    case "chat":
      return c.session === null || chat(c.session) ? c : null;
    case "note":
      if (c.scope === "project") return app.notes.some((n) => n.name === c.name) ? c : null;
      if (c.scope === "knowledge") return app.vault.some((n) => n.name === c.name) ? c : null;
      return c;
    case "project":
      return app.projects.some((p) => p.id === c.id) ? c : null;
    case "aside": {
      if (!chat(c.session)) return null;
      const list = asidesOf(c.session);
      if (c.thread === undefined) return list.length > 0 ? c : null;
      const a = list[c.thread];
      return a ? { kind: "aside", session: c.session, thread: a.id } : null;
    }
    case "attachment":
    case "subagent":
    // Claude's browser (item 508) comes back with its chat; the browser
    // itself ended with the app, and the tab says so.
    case "browser":
      return chat(c.session) ? c : null;
    case "web":
    case "nightshift":
    case "graph":
    case "new-project":
    // A file tab comes back like the rest (guess pass 2026-09-25, question
    // 20); a file gone since says so in its tab, which reads it again.
    case "file":
    // A thread tab (backlog 292) likewise: a thread gone says so in its tab.
    case "thread":
      return c;
  }
}

/**
 * A drag source outside the strips (backlog 140 pass 2): the row or
 * button calls this from `dragstart` with what it stands for, and
 * `endContentDrag` from `dragend`. The descriptor rides in the drag
 * under `CONTENT_DRAG` and is mirrored in `app.draggingContent` for the
 * strips' and halves' `dragover`, which cannot read the data.
 */
export function startContentDrag(e: DragEvent, content: TabContent): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(tabs.CONTENT_DRAG, JSON.stringify(content));
  e.dataTransfer.effectAllowed = "copy";
  app.draggingContent = content;
}

export function endContentDrag(): void {
  app.draggingContent = null;
}

/** The content a drop carries: the drag's data, else the mirror. */
export function droppedContent(e: DragEvent): TabContent | null {
  return tabs.parseContentDrag(e.dataTransfer?.getData(tabs.CONTENT_DRAG)) ?? app.draggingContent;
}
