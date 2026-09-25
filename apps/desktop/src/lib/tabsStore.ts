/**
 * The tab workspace across a quit (nightshift backlog 201, 2026-09-24):
 * every pane, its tabs in order, the active tab of each, the focused pane
 * and the shells of each pane's terminal dock — per project, written to
 * localStorage and read back when the project opens, launch included.
 * Before this a relaunch opened one New chat tab (`emptyWorkspace`).
 *
 * This module is the pure part, like `asides.ts` to `asides.svelte.ts`:
 * the stored shape, its parse and its rebuild. `state.svelte.ts` restores
 * (`restoreTabs`) and saves (`flushTabs`); `tabsKeeper.svelte.ts` debounces
 * the save and flushes it on `pagehide`.
 *
 * The rules:
 * - Stored by position, not by id: tab and pane ids are a window's counter
 *   (`tabs.nextId`), so a rebuilt workspace mints fresh ones.
 * - Every tab's content is re-read through `parseContentDrag`, the one
 *   validator of a content descriptor; a tab it refuses is dropped.
 * - A tab whose target is gone (a deleted chat or note, a forgotten
 *   project, an aside thread no longer in the stash) is dropped — the
 *   caller resolves each stored content (`rebuild`'s `resolve`). A pane left with no tabs goes; a workspace
 *   left with none is null and the caller opens the empty one.
 * - The floating slot (an attachment zoomed over the panes) is transient
 *   and never stored.
 * - A malformed stored value costs the layout, never the launch: every
 *   read is guarded and falls back to nothing stored.
 */
import * as tabs from "./tabs";
import type { Pane, Tab, TabContent, Workspace } from "./tabs";

export const TABS_KEY = "nightloom.tabs";
/** The key of the workspace with no project open (an unfiled chat). */
export const UNFILED_TABS = "\u0000unfiled";

export interface SavedPane {
  tabs: TabContent[];
  /** Index into `tabs` of the pane's active tab. */
  active: number;
  /** Shells open in this pane's terminal dock (reopened fresh, in the
   *  project's folder). Absent or 0 when the pane had no dock. */
  shells?: number;
}

export interface SavedWorkspace {
  panes: SavedPane[];
  /** Index into `panes` of the focused pane. */
  focused: number;
}

/** Every project's saved workspace, by project id (`UNFILED_TABS` for none). */
export type SavedWorkspaces = Record<string, SavedWorkspace>;

/**
 * The workspace as stored. `shellsIn` counts a pane's dock's shells;
 * `store` turns a live content into its stored form (an aside tab's
 * thread id, which is per window, into the thread's place in its chat's
 * list — see `state.svelte.ts`).
 */
export function snapshot(
  ws: Workspace,
  shellsIn: (paneId: string) => number = () => 0,
  store: (c: TabContent) => TabContent = (c) => c,
): SavedWorkspace {
  const panes = ws.panes.map((p): SavedPane => {
    const active = Math.max(
      0,
      p.tabs.findIndex((t) => t.id === p.active),
    );
    const out: SavedPane = { tabs: p.tabs.map((t) => store(structuredCloneContent(t.content))), active };
    const n = shellsIn(p.id);
    if (n > 0) out.shells = n;
    return out;
  });
  return { panes, focused: Math.max(0, ws.panes.findIndex((p) => p.id === ws.focused)) };
}

/** A plain copy of a content descriptor (the live one may be a Svelte proxy). */
function structuredCloneContent(c: TabContent): TabContent {
  return JSON.parse(JSON.stringify(c)) as TabContent;
}

/** One stored workspace, validated; null when it is not one. */
export function parseSaved(raw: unknown): SavedWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { panes?: unknown; focused?: unknown };
  if (!Array.isArray(r.panes)) return null;
  const panes: SavedPane[] = [];
  for (const p of r.panes.slice(0, tabs.MAX_PANES)) {
    if (!p || typeof p !== "object") continue;
    const q = p as { tabs?: unknown; active?: unknown; shells?: unknown };
    if (!Array.isArray(q.tabs)) continue;
    const list: TabContent[] = [];
    for (const c of q.tabs) {
      let parsed: TabContent | null = null;
      try {
        parsed = tabs.parseContentDrag(JSON.stringify(c));
      } catch {
        parsed = null;
      }
      if (parsed) list.push(parsed);
    }
    const active = typeof q.active === "number" && Number.isInteger(q.active) ? q.active : 0;
    const shells = typeof q.shells === "number" && Number.isInteger(q.shells) && q.shells > 0 ? Math.min(q.shells, 8) : 0;
    const pane: SavedPane = { tabs: list, active };
    if (shells > 0) pane.shells = shells;
    panes.push(pane);
  }
  const focused = typeof r.focused === "number" && Number.isInteger(r.focused) ? r.focused : 0;
  return { panes, focused };
}

/** Every stored workspace; an empty map when there is none or it is malformed. */
export function loadSavedWorkspaces(storage: Pick<Storage, "getItem">): SavedWorkspaces {
  try {
    const raw = storage.getItem(TABS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SavedWorkspaces = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const w = parseSaved(v);
      if (w) out[k] = w;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write one project's workspace, keeping every other project's. Best-effort. */
export function saveWorkspaceFor(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  saved: SavedWorkspace,
): void {
  try {
    const all = loadSavedWorkspaces(storage);
    all[key] = saved;
    storage.setItem(TABS_KEY, JSON.stringify(all));
  } catch {
    // best-effort: a full store costs the layout, not the app
  }
}

export interface Rebuilt {
  ws: Workspace;
  /** The panes whose docks had shells: the new pane id and how many. */
  shells: { pane: string; count: number }[];
}

/**
 * The live workspace a stored one describes. `resolve` turns each stored
 * content back into a live one, or null when its target is gone — that
 * tab is dropped. Null when no tab survives — the caller opens the empty
 * workspace. A pane's active tab that was dropped hands the front to its
 * neighbour on the right, else the left (the close rule); a focused pane
 * that went hands the focus to the one left.
 */
export function rebuild(saved: SavedWorkspace, resolve: (c: TabContent) => TabContent | null): Rebuilt | null {
  const panes: Pane[] = [];
  const shells: { pane: string; count: number }[] = [];
  let focused: Pane | undefined;
  saved.panes.forEach((sp, pi) => {
    const kept: { at: number; tab: Tab }[] = [];
    sp.tabs.forEach((stored, at) => {
      let c: TabContent | null = null;
      try {
        c = resolve(stored);
      } catch {
        c = null;
      }
      if (!c) return;
      // One tab per content in a pane (the model's rule): a duplicate
      // stored by an older build is dropped.
      const live = c;
      if (kept.some((k) => tabs.sameContent(k.tab.content, live))) return;
      kept.push({ at, tab: tabs.makeTab(live) });
    });
    if (kept.length === 0) return;
    // The stored active tab; when it was dropped, its right neighbour,
    // else its left (the close rule).
    const front =
      kept.find((k) => k.at === sp.active) ??
      kept.find((k) => k.at > sp.active) ??
      kept[kept.length - 1];
    const pane: Pane = { id: tabs.nextId("p"), tabs: kept.map((k) => k.tab), active: front.tab.id };
    panes.push(pane);
    if (pi === saved.focused) focused = pane;
    if (sp.shells && sp.shells > 0) shells.push({ pane: pane.id, count: sp.shells });
  });
  if (panes.length === 0) return null;
  // Singletons (the Nightshift page, the graph, New project) are one in
  // the workspace: a second, in the other pane, is dropped.
  if (panes.length > 1) {
    const [left, right] = panes;
    right.tabs = right.tabs.filter((t) => !(tabs.isSingleton(t.content) && tabs.findTab(left, t.content)));
    if (right.tabs.length === 0) {
      panes.pop();
      if (focused === right) focused = left;
    } else if (!right.tabs.some((t) => t.id === right.active)) {
      right.active = right.tabs[0].id;
    }
  }
  const ws: Workspace = { panes, focused: (focused ?? panes[0]).id };
  return { ws, shells: shells.filter((s) => panes.some((p) => p.id === s.pane)) };
}
