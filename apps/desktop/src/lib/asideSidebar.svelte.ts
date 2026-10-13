/**
 * A chat's asides in the sidebar and in its row menu (item 265,
 * 2026-09-29), and the close on the aside's own tab (item 266).
 *
 * His words: asides "shown in kind of the same way that forks are shown…
 * a slightly different signal… or two buttons: one for showing the asides,
 * one for showing the forks". Taken: **both a toggle of their own and a
 * mark of their own** — a row with asides gets a second disclosure (the
 * asides glyph and a count) beside the forks' chevron, opened and closed
 * apart and remembered the same way (`nightloom.asidesOpen`); when open,
 * the chat's open asides are listed right under it, indented like forks,
 * each with the asides glyph and "aside" on its second line, so with both
 * groups open the two kinds never read as one. Past (closed) asides are
 * not rows — they are in the row menu and the chat's asides list.
 *
 * A stashed chat's threads live in a plain map, so what reads them here
 * also reads `asideTick`, which a rename or a close bumps.
 */
import { activateTab, app, asideOf, asideTabThread, asidesOf, onAsideClosed, openContent, requestDismissAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import * as tabs from "./tabs";
import { ASIDES_OPEN_KEY, loadOpen, saveOpen, toggled } from "./forkTree";
import { asideTick } from "./asides.svelte";
import { asideLabel } from "./asides";

export const asidesShown = $state({
  open: (typeof localStorage === "undefined" ? new Set<string>() : loadOpen(ASIDES_OPEN_KEY)) as Set<string>,
});

/** Open or close the list of a chat's asides under its row. */
export function toggleAsidesOf(session: string): void {
  asidesShown.open = toggled(asidesShown.open, session);
  saveOpen(asidesShown.open, ASIDES_OPEN_KEY);
}

/** Whether a thread is worth a row: anything but a draft with nothing
 *  typed (a card just opened on a selection holds nothing of his). */
export function listedAside(a: Aside): boolean {
  return !a.draft || !!(a.unsent ?? "").trim();
}

/** A chat's open asides as the sidebar and the row menu list them,
 *  oldest first. Reactive for the open chat and, through the tick, for a
 *  stashed one. */
export function asidesListedOf(session: string): Aside[] {
  void asideTick.n;
  void app.activeSessionId;
  return asidesOf(session).filter(listedAside);
}

/** The name an aside tab shows (item 265): the thread's own, or null
 *  when it has none (the tab keeps "Aside · <chat>"). */
export function asideTabName(session: string, thread: number | undefined): string | null {
  void asideTick.n;
  void app.activeSessionId;
  const a = asideOf(session, thread ?? null);
  return a?.name ? asideLabel(a, 40) : null;
}

/** The tab showing thread `id` of `session`, if one does. */
export function asideTabOf(session: string, id: number): tabs.Tab | undefined {
  return tabs
    .allTabs(app.tabs)
    .find((t) => t.content.kind === "aside" && t.content.session === session && asideTabThread(t.content) === id);
}

/** Show a thread in a tab: the one already showing it, else a new tab
 *  beside the active one (a plain click keeps the chat's own tab). */
export async function openAsideTab(session: string, id: number): Promise<void> {
  const there = asideTabOf(session, id);
  if (there) {
    await activateTab(there.id);
    return;
  }
  await openContent({ kind: "aside", session, thread: id }, "new");
}

/**
 * Back to the chat an aside came from (item 266), from the aside's tab:
 * the chat's own tab when one is open anywhere — the aside's tab closes —
 * else the aside's tab becomes the chat's.
 */
export async function returnToChat(session: string, id: number, fromTab: string | null = null): Promise<void> {
  const ws = app.tabs;
  const asideTab = (fromTab ? tabs.tabById(ws, fromTab) : undefined) ?? asideTabOf(session, id);
  const chatTab = tabs.allTabs(ws).find((t) => t.content.kind === "chat" && t.content.session === session);
  if (chatTab) {
    if (asideTab) tabs.close(ws, asideTab.id);
    await activateTab(chatTab.id);
    return;
  }
  if (asideTab) tabs.activate(ws, asideTab.id);
  await openContent({ kind: "chat", session }, "replace");
}

/** A close from the tab waiting on the discard question (unsent text,
 *  backlog 228): the return runs when that close lands. */
let pendingReturn: { session: string; id: number; tab: string | null } | null = null;

/**
 * The aside tab's Close (item 266; blocker 640: "permanently close meant
 * that chat's past list"): the thread closes the way its × closes it —
 * into the chat's Past list, reopenable — and the view goes back to the
 * chat. Unsent text in its box asks first (practices §7); Keep leaves
 * both the thread and the tab where they are.
 */
export function closeAsideToChat(session: string, a: Aside, fromTab: string | null = null): void {
  const id = a.id;
  pendingReturn = { session, id, tab: fromTab };
  requestDismissAside(a);
  if (app.asideDiscard !== null && app.asideDiscard.id === id) return; // asking first
  if (asidesOf(session).some((b) => b.id === id)) {
    // Not closed (nothing to close it from): stay put.
    pendingReturn = null;
    return;
  }
  // Closed at once; the listener below has already taken the return.
}

onAsideClosed((chat, a) => {
  asideTick.n++;
  const want = pendingReturn;
  if (!want || want.session !== chat || want.id !== a.id) return;
  pendingReturn = null;
  void returnToChat(want.session, want.id, want.tab);
});

if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      // The discard question answered Keep: the close did not happen, so
      // no return is owed. (Discard closes synchronously inside the
      // answer, so the listener has run before this effect does.)
      if (app.asideDiscard === null) pendingReturn = null;
    });
  });
}
