/**
 * Tabs and panes (nightshift backlog 099, 2026-09-17; boards 9a–9e, his
 * blockers 140 and 142): the centre of the window is one or two **panes**
 * side by side, each with a strip of **tabs**, each tab a chat or a note.
 * The editor idiom — one strip per pane, tabs drag between them, at most
 * two panes.
 *
 * This module is the model alone: plain objects and the operations on
 * them, with no Svelte and no backend, so the suite can pin every rule.
 * `state.svelte.ts` holds the one workspace (`app.tabs`) and does the
 * showing — a tab activated there opens its chat or note the way the
 * sidebar always has — and `App.svelte` draws the panes.
 *
 * The rules, in one place:
 * - A pane never has zero tabs. The last tab of a pane closes the pane
 *   when there is another; the last tab of the last pane becomes a fresh
 *   new-chat tab.
 * - A chat tab with `session: null` is a chat not yet sent — the Welcome
 *   page. There is at most one such tab per pane: a second New chat
 *   activates it rather than adding another.
 * - Landing content in a pane (`land`) prefers an existing tab of that
 *   content, then — `"replace"` — takes over the active tab, or —
 *   `"new"` — inserts after it. Replace is the plain click's behaviour
 *   (blocker 140), new is ⌘-click's and ⌘T's.
 * - Stepping (`step`) walks every tab of every pane in order, wrapping.
 * - A split moves a tab out of its pane into a new pane on the given
 *   side; it needs another tab left behind, and there are never more than
 *   two panes. Dropping a tab on a pane's strip moves it there.
 *
 * Since nightshift backlog 140 (2026-09-17, his walk of `b6a9c07`) tabs
 * sit above everything: the Nightshift page, the link graph and the New
 * project form are tab contents like a chat or a note, so the strip stays
 * drawn whatever is in front. Those three are **singletons** — one tab in
 * the whole workspace; a second request activates the one there is,
 * wherever it sits. A project (a card naming it, with the switch as its
 * button — blocker 193) and an aside thread (backlog 130 part 2: a
 * chat's side conversation, viewed in a tab of its own — blocker 194)
 * are contents too, one per project and one per chat.
 */
import type { NoteScope } from "./types";
import type { IconName } from "./icons";

export type TabContent =
  | { kind: "chat"; session: string | null }
  | { kind: "note"; scope: NoteScope; name: string }
  | { kind: "nightshift" }
  | { kind: "graph" }
  | { kind: "new-project" }
  | { kind: "project"; id: string }
  | { kind: "aside"; session: string };

export type TabKind = TabContent["kind"];

/** The kinds of which the workspace holds one tab at most. */
export const SINGLETON_KINDS: ReadonlySet<TabKind> = new Set(["nightshift", "graph", "new-project"]);

export function isSingleton(content: TabContent): boolean {
  return SINGLETON_KINDS.has(content.kind);
}

export interface Tab {
  id: string;
  content: TabContent;
}

export interface Pane {
  id: string;
  tabs: Tab[];
  /** The id of the tab this pane shows. Always one of `tabs`. */
  active: string;
}

export interface Workspace {
  /** One or two, left to right. */
  panes: Pane[];
  /** The pane the sidebar and the keys act on. Always one of `panes`. */
  focused: string;
}

export const MAX_PANES = 2;
/** The drag's own data type: a tab carries its id under it, so a file or
 *  text dragged over a strip or a pane's half is not mistaken for a tab. */
export const TAB_DRAG = "application/x-nightloom-tab";
/**
 * A drag from outside the strips (backlog 140 pass 2): a sidebar chat row,
 * a note row, the Nightshift or Graph button, a project row, the aside
 * card's head. It carries a content descriptor as JSON under this type;
 * a strip makes a new tab of it at the drop's index, a pane's half opens
 * it beside (`openBeside`). `app.draggingContent` mirrors it while the
 * drag lasts, since `dataTransfer` is unreadable during `dragover`.
 */
export const CONTENT_DRAG = "application/x-nightloom-content";
/**
 * The terminal dock dragged between panes (backlog 113's 12b, blocker
 * 189: one dock, under the pane it opened from — the drag moves which).
 * The dock's own module sets and reads `term.pane`; the model only names
 * the type so the strips and halves can tell it from a tab.
 */
export const TERM_DRAG = "application/x-nightloom-terminal";

/** The descriptor a `CONTENT_DRAG` carries, or null for anything else. */
export function parseContentDrag(json: string | null | undefined): TabContent | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as Partial<TabContent> & { kind?: string };
    switch (c.kind) {
      case "chat":
        return { kind: "chat", session: typeof (c as { session?: unknown }).session === "string" ? (c as { session: string }).session : null };
      case "note": {
        const n = c as { scope?: unknown; name?: unknown };
        if (typeof n.scope !== "string" || typeof n.name !== "string") return null;
        return { kind: "note", scope: n.scope as NoteScope, name: n.name };
      }
      case "nightshift":
      case "graph":
      case "new-project":
        return { kind: c.kind };
      case "project": {
        const p = c as { id?: unknown };
        return typeof p.id === "string" ? { kind: "project", id: p.id } : null;
      }
      case "aside": {
        const a = c as { session?: unknown };
        return typeof a.session === "string" ? { kind: "aside", session: a.session } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

let seq = 0;
/** Ids are only ever compared, never shown; a counter is enough and keeps
 *  the suite's expectations readable. */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function newChatContent(): TabContent {
  return { kind: "chat", session: null };
}

export function sameContent(a: TabContent, b: TabContent): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "chat" && b.kind === "chat") return a.session === b.session;
  if (a.kind === "note" && b.kind === "note") return a.scope === b.scope && a.name === b.name;
  if (a.kind === "project" && b.kind === "project") return a.id === b.id;
  if (a.kind === "aside" && b.kind === "aside") return a.session === b.session;
  // The singletons carry nothing but their kind.
  return isSingleton(a);
}

export function makeTab(content: TabContent): Tab {
  return { id: nextId("t"), content };
}

export function makePane(tabs: Tab[]): Pane {
  const list = tabs.length > 0 ? tabs : [makeTab(newChatContent())];
  return { id: nextId("p"), tabs: list, active: list[0].id };
}

/** One pane, one new-chat tab: what the app opens with. */
export function emptyWorkspace(): Workspace {
  const pane = makePane([]);
  return { panes: [pane], focused: pane.id };
}

export function paneById(ws: Workspace, id: string): Pane | undefined {
  return ws.panes.find((p) => p.id === id);
}

export function focusedPane(ws: Workspace): Pane {
  return paneById(ws, ws.focused) ?? ws.panes[0];
}

export function paneOf(ws: Workspace, tabId: string): Pane | undefined {
  return ws.panes.find((p) => p.tabs.some((t) => t.id === tabId));
}

export function tabById(ws: Workspace, tabId: string): Tab | undefined {
  for (const p of ws.panes) {
    const t = p.tabs.find((x) => x.id === tabId);
    if (t) return t;
  }
  return undefined;
}

export function activeTab(pane: Pane): Tab {
  return pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
}

export function findTab(pane: Pane, content: TabContent): Tab | undefined {
  return pane.tabs.find((t) => sameContent(t.content, content));
}

/** The tab holding `content` in either pane, left pane first. */
export function findAnywhere(ws: Workspace, content: TabContent): Tab | undefined {
  for (const p of ws.panes) {
    const t = findTab(p, content);
    if (t) return t;
  }
  return undefined;
}

/** Every tab, left pane first, in strip order. */
export function allTabs(ws: Workspace): Tab[] {
  return ws.panes.flatMap((p) => p.tabs);
}

/** The other pane, when there is one. */
export function otherPane(ws: Workspace, paneId: string): Pane | undefined {
  return ws.panes.find((p) => p.id !== paneId);
}

/**
 * Make `tabId` its pane's active tab and its pane the focused one. The
 * caller shows the content.
 */
export function activate(ws: Workspace, tabId: string): Tab | undefined {
  const pane = paneOf(ws, tabId);
  if (!pane) return undefined;
  pane.active = tabId;
  ws.focused = pane.id;
  return activeTab(pane);
}

export type LandHow = "replace" | "new";

/**
 * Put `content` in front in `pane`: the tab already holding it, else the
 * active tab retargeted (`replace`) or a new tab after it (`new`). Returns
 * the tab that now holds the content. The pane becomes the focused one.
 * A singleton (Nightshift, the graph, the New project form) already open
 * in the *other* pane is activated there instead — one such tab in the
 * workspace, wherever it sits (backlog 140).
 */
export function land(ws: Workspace, pane: Pane, content: TabContent, how: LandHow): Tab {
  if (isSingleton(content)) {
    const anywhere = findAnywhere(ws, content);
    if (anywhere) return activate(ws, anywhere.id) as Tab;
  }
  ws.focused = pane.id;
  const existing = findTab(pane, content);
  if (existing) {
    pane.active = existing.id;
    return existing;
  }
  const current = activeTab(pane);
  if (how === "replace") {
    current.content = content;
    return current;
  }
  const tab = makeTab(content);
  const at = pane.tabs.findIndex((t) => t.id === current.id);
  pane.tabs.splice(at + 1, 0, tab);
  pane.active = tab.id;
  return tab;
}

/**
 * A content descriptor dropped on a strip (backlog 140 pass 2): a new tab
 * of it at `index`, unless the pane already holds one — then that tab is
 * activated — or the content is a singleton open elsewhere. Returns the
 * tab that holds it; the caller shows it.
 */
export function insertAt(ws: Workspace, pane: Pane, content: TabContent, index: number): Tab {
  if (isSingleton(content)) {
    const anywhere = findAnywhere(ws, content);
    if (anywhere) return activate(ws, anywhere.id) as Tab;
  }
  const existing = findTab(pane, content);
  if (existing) {
    ws.focused = pane.id;
    pane.active = existing.id;
    return existing;
  }
  const tab = makeTab(content);
  pane.tabs.splice(Math.max(0, Math.min(index, pane.tabs.length)), 0, tab);
  pane.active = tab.id;
  ws.focused = pane.id;
  return tab;
}

export interface Closed {
  /** The tab removed; undefined when `tabId` was not found. */
  removed?: Tab;
  /** The pane removed with its last tab, when there was another pane. */
  paneRemoved?: Pane;
  /**
   * The tab now in front of the focused pane, when the close changed what
   * the focused pane shows — the caller opens its content. Undefined when
   * the closed tab was neither active nor in the focused pane.
   */
  show?: Tab;
}

/**
 * Remove a tab. Its pane's next active is the neighbour to the right,
 * else the left (a browser's rule); an emptied pane goes when there is
 * another and is refilled with a new-chat tab when there is not.
 */
export function close(ws: Workspace, tabId: string): Closed {
  const pane = paneOf(ws, tabId);
  if (!pane) return {};
  const at = pane.tabs.findIndex((t) => t.id === tabId);
  const removed = pane.tabs[at];
  const wasActive = pane.active === tabId;
  const wasFocused = ws.focused === pane.id;
  pane.tabs.splice(at, 1);
  if (pane.tabs.length === 0) {
    const other = otherPane(ws, pane.id);
    if (other) {
      ws.panes = ws.panes.filter((p) => p.id !== pane.id);
      ws.focused = other.id;
      return { removed, paneRemoved: pane, show: wasFocused ? activeTab(other) : undefined };
    }
    const fresh = makeTab(newChatContent());
    pane.tabs.push(fresh);
    pane.active = fresh.id;
    return { removed, show: fresh };
  }
  if (wasActive) {
    pane.active = pane.tabs[Math.min(at, pane.tabs.length - 1)].id;
    return { removed, show: wasFocused ? activeTab(pane) : undefined };
  }
  return { removed };
}

/**
 * The tab `dir` steps from the focused pane's active one, across both
 * panes, wrapping (⌘⇧] / ⌘⇧[). Null when there is only one tab.
 */
export function step(ws: Workspace, dir: 1 | -1): Tab | null {
  const list = allTabs(ws);
  if (list.length < 2) return null;
  const current = activeTab(focusedPane(ws));
  const at = list.findIndex((t) => t.id === current.id);
  return list[(at + dir + list.length) % list.length];
}

/**
 * Move a tab to `index` in `toPane` — a reorder within its strip or a move
 * into the other pane's. A pane emptied by the move goes (the mover's tab
 * was its last). Returns false when nothing moved.
 */
export function move(ws: Workspace, tabId: string, toPaneId: string, index: number): boolean {
  const from = paneOf(ws, tabId);
  const to = paneById(ws, toPaneId);
  if (!from || !to) return false;
  const at = from.tabs.findIndex((t) => t.id === tabId);
  const tab = from.tabs[at];
  from.tabs.splice(at, 1);
  // A drop past the tab's own old place counts from the shortened list.
  let dest = Math.max(0, Math.min(index, to.tabs.length));
  if (from === to && index > at) dest = Math.max(0, Math.min(index - 1, to.tabs.length));
  to.tabs.splice(dest, 0, tab);
  to.active = tab.id;
  ws.focused = to.id;
  if (from !== to) {
    if (from.tabs.length === 0) {
      ws.panes = ws.panes.filter((p) => p.id !== from.id);
    } else if (from.active === tabId) {
      from.active = from.tabs[Math.min(at, from.tabs.length - 1)].id;
    }
  }
  return true;
}

/**
 * Open a second pane on `side` holding `tabId`, moved out of its pane.
 * Refused (false) with two panes already, or when the tab is its pane's
 * only one — a split that emptied the source would be a move.
 */
export function split(ws: Workspace, tabId: string, side: "left" | "right"): boolean {
  if (ws.panes.length >= MAX_PANES) return false;
  const from = paneOf(ws, tabId);
  if (!from || from.tabs.length < 2) return false;
  const at = from.tabs.findIndex((t) => t.id === tabId);
  const [tab] = from.tabs.splice(at, 1);
  if (from.active === tabId) from.active = from.tabs[Math.min(at, from.tabs.length - 1)].id;
  const pane = makePane([tab]);
  if (side === "left") ws.panes.unshift(pane);
  else ws.panes.push(pane);
  ws.focused = pane.id;
  return true;
}

/**
 * Open `content` beside the focused pane: in the other pane when there is
 * one (landed as `how`), else in a new pane on the right. Returns the tab.
 */
export function openBeside(ws: Workspace, content: TabContent, how: LandHow = "new"): Tab {
  if (isSingleton(content)) {
    const anywhere = findAnywhere(ws, content);
    if (anywhere) return activate(ws, anywhere.id) as Tab;
  }
  const here = focusedPane(ws);
  const other = otherPane(ws, here.id);
  if (other) return land(ws, other, content, how);
  const tab = makeTab(content);
  const pane = makePane([tab]);
  ws.panes.push(pane);
  ws.focused = pane.id;
  return tab;
}

/** Drop every tab holding a chat that no longer exists (a deleted chat) —
 *  and its aside's tab, which was that chat's side conversation. */
export function dropChat(ws: Workspace, session: string): Closed[] {
  const out: Closed[] = [];
  for (const t of allTabs(ws)) {
    const c = t.content;
    if ((c.kind === "chat" || c.kind === "aside") && c.session === session) out.push(close(ws, t.id));
  }
  return out;
}

/** Drop every tab of `kind` (a project forgotten: its card goes). */
export function dropProject(ws: Workspace, id: string): Closed[] {
  const out: Closed[] = [];
  for (const t of allTabs(ws)) {
    if (t.content.kind === "project" && t.content.id === id) out.push(close(ws, t.id));
  }
  return out;
}

/** Drop every tab holding a note (a deleted note, a vault moved away). */
export function dropNote(ws: Workspace, scope: NoteScope, name: string): Closed[] {
  const out: Closed[] = [];
  for (const t of allTabs(ws)) {
    if (t.content.kind === "note" && t.content.scope === scope && t.content.name === name) {
      out.push(close(ws, t.id));
    }
  }
  return out;
}

/**
 * The tab whose chat is the open one: the focused pane's active tab when
 * it holds `session`, else the first tab anywhere that does. The pane
 * holding it draws the transcript; every other chat tab is a card.
 */
export function liveTab(ws: Workspace, session: string | null): Tab | undefined {
  const front = activeTab(focusedPane(ws));
  if (front.content.kind === "chat" && front.content.session === session) return front;
  return allTabs(ws).find((t) => t.content.kind === "chat" && t.content.session === session);
}

/** What a tab is called on its strip. */
export function tabTitle(
  content: TabContent,
  sessions: { id: string; title?: string | null; first_user?: string | null }[],
  projects: { id: string; name: string }[] = [],
): string {
  switch (content.kind) {
    case "note":
      return content.name;
    case "nightshift":
      return "Nightshift";
    case "graph":
      return "Graph";
    case "new-project":
      return "New project";
    case "project":
      return projects.find((p) => p.id === content.id)?.name ?? "Project";
    case "aside": {
      const s = sessions.find((x) => x.id === content.session);
      return `Aside · ${s?.title ?? s?.first_user ?? content.session.slice(0, 8)}`;
    }
    case "chat": {
      if (content.session === null) return "New chat";
      const s = sessions.find((x) => x.id === content.session);
      return s?.title ?? s?.first_user ?? content.session.slice(0, 8);
    }
  }
}

/** The strip's glyph for a kind — an `Icon` name. */
export function tabGlyph(content: TabContent): IconName {
  switch (content.kind) {
    case "note":
      return "note";
    case "nightshift":
      return "moon";
    case "graph":
      return "link";
    case "new-project":
    case "project":
      return "folder";
    case "aside":
      return "think";
    case "chat":
      return "chat";
  }
}
