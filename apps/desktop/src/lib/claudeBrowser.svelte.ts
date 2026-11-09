/**
 * Claude's browser (nightshift item 508): the chats' browsers as the window
 * knows them — the last status of each (kept by `claude-browser-status`
 * events), the newest picture (`claude-browser-frame`, only while a tab
 * watches), the last dialog the page raised (`claude-browser-dialog`), and
 * who is watching. The pure half is `claudeBrowser.ts`.
 *
 * Watching is counted per chat: a tab that is in front (or in the other
 * pane) and in a window that is not hidden counts once; frames are asked
 * for while the count is above zero and stopped when it drops to zero.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { BrowserDialogEvent, BrowserFrameEvent, BrowserStatus, BrowserStatusEvent } from "./api";
import * as tabs from "./tabs";
import { app, activateTab } from "./state.svelte";
import { phaseOf, type BrowserPhase } from "./claudeBrowser";

export interface BrowserFrame {
  seq: number;
  /** A `data:` URL of the JPEG. */
  src: string;
  w: number;
  h: number;
}

export const browsers = $state({
  /** The last status per chat; absent = none known. */
  byChat: {} as Record<string, BrowserStatus>,
  /** Chats whose browser this run has seen live (so a stop reads as ended). */
  seenLive: {} as Record<string, boolean>,
  /** Each time a chat's browser goes live counts one: the chip's offer is
   *  per browser, so one dismissed comes back for the next browser. */
  episode: {} as Record<string, number>,
  /** The episode whose chip he dismissed, per chat. */
  chipDismissed: {} as Record<string, number>,
  /** The page's last dialog per chat, for the tab's one-line notice. */
  dialog: {} as Record<string, { kind: BrowserDialogEvent["kind"]; message: string; at: number } | null>,
});

/** The newest picture per chat. A plain `$state` map of small records:
 *  the template reads `frames[chat]`, which is replaced, never mutated. */
export const frames = $state({} as Record<string, BrowserFrame>);

export function phase(session: string): BrowserPhase {
  return phaseOf(browsers.byChat[session], !!browsers.seenLive[session]);
}

/** A status for `session` (an event, a read, a hold's answer) taken in. */
export function applyStatus(session: string, s: BrowserStatus | null): void {
  if (!s) {
    if (session in browsers.byChat) {
      const next = { ...browsers.byChat };
      delete next[session];
      browsers.byChat = next;
    }
    return;
  }
  const was = browsers.byChat[session];
  browsers.byChat = { ...browsers.byChat, [session]: s };
  if (s.live && !browsers.seenLive[session]) browsers.seenLive = { ...browsers.seenLive, [session]: true };
  if (s.live && !was?.live) browsers.episode = { ...browsers.episode, [session]: (browsers.episode[session] ?? 0) + 1 };
}

/** Whether the chip offers `session`'s browser: from the first time its
 *  status reports live (then live, or ended this run), until he dismisses
 *  this browser's offer. */
export function chipShown(session: string): boolean {
  if (!browsers.seenLive[session]) return false;
  return browsers.chipDismissed[session] !== (browsers.episode[session] ?? 0);
}

export function dismissChip(session: string): void {
  browsers.chipDismissed = { ...browsers.chipDismissed, [session]: browsers.episode[session] ?? 0 };
}

/** A frame taken in: only newer than the one shown. */
export function applyFrame(f: BrowserFrameEvent): void {
  const cur = frames[f.session];
  if (cur && f.seq <= cur.seq) return;
  frames[f.session] = { seq: f.seq, src: `data:image/jpeg;base64,${f.jpeg}`, w: f.w, h: f.h };
}

export function applyDialog(d: BrowserDialogEvent): void {
  browsers.dialog = { ...browsers.dialog, [d.session]: { kind: d.kind, message: d.message, at: Date.now() } };
}

export function dismissDialog(session: string): void {
  browsers.dialog = { ...browsers.dialog, [session]: null };
}

let started = false;

/** Listen to the three events; every caller after the first is a no-op. */
export async function startBrowsers(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await listen<BrowserStatusEvent>("claude-browser-status", (e) => {
      const { session, ...status } = e.payload;
      applyStatus(session, status);
    });
    await listen<BrowserFrameEvent>("claude-browser-frame", (e) => applyFrame(e.payload));
    await listen<BrowserDialogEvent>("claude-browser-dialog", (e) => applyDialog(e.payload));
  } catch {
    // Outside the app (the suite, a harness without its stub): no events.
  }
}

/** Read one chat's status (a tab or chip drawn for a chat not yet heard from). */
export async function readStatus(session: string): Promise<void> {
  try {
    applyStatus(session, await api.claudeBrowserStatus(session));
  } catch {
    // Kept as it was; the next event says.
  }
}

const watchers = new Map<string, number>();

/** How many views watch `session` now (for the suite). */
export function watchCount(session: string): number {
  return watchers.get(session) ?? 0;
}

/**
 * One view starts (`on`) or stops watching `session`. The backend hears
 * only the edges: the first watcher turns frames on, the last one gone
 * turns them off.
 */
export function watch(session: string, on: boolean): void {
  const n = watchers.get(session) ?? 0;
  const next = on ? n + 1 : Math.max(0, n - 1);
  if (next === 0) watchers.delete(session);
  else watchers.set(session, next);
  if ((n === 0) !== (next === 0)) {
    api.claudeBrowserWatch(session, next > 0).catch(() => {});
  }
}

/** For the suite. */
export function resetBrowsers(): void {
  watchers.clear();
  browsers.byChat = {};
  browsers.seenLive = {};
  browsers.chipDismissed = {};
  browsers.episode = {};
  browsers.dialog = {};
  for (const k of Object.keys(frames)) delete frames[k];
}

/** Take over (`true`) or give back (`false`); the answer is the new status. */
export async function setHold(session: string, held: boolean): Promise<void> {
  const s = await api.claudeBrowserHold(session, held);
  applyStatus(session, s);
}

/** The tab's content for `session`'s browser. */
export function browserContent(session: string): tabs.TabContent {
  return { kind: "browser", session };
}

/**
 * Open the chat's browser tab: the one already open anywhere is brought
 * forward; else a new tab beside the chat in the focused pane — never over
 * it, and only on his click (the chip offers; it never pulls him away).
 */
export async function openBrowserTab(session: string): Promise<void> {
  const content = browserContent(session);
  const found = tabs.findAnywhere(app.tabs, content);
  if (found) {
    await activateTab(found.id);
    return;
  }
  const t = tabs.land(app.tabs, tabs.focusedPane(app.tabs), content, "new");
  await activateTab(t.id);
}

/** Whether `session` has a browser tab open anywhere. */
export function browserTabOpen(session: string): boolean {
  return !!tabs.findAnywhere(app.tabs, browserContent(session));
}
