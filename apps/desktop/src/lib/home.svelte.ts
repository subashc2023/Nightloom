/**
 * Home's store (nightshift item 763, H1–H2): what the backend says Home is,
 * its feed and seen time, and his half-typed brief. Opening Home opens
 * today's chat; opening the Needs-you view never marks the feed seen — only
 * "Mark all seen" does. The brief's draft is kept in localStorage until he
 * saves or discards it, so leaving the Settings tab half-typed loses nothing.
 */
import * as api from "./api";
import { app, addToast, canLeaveProject, openRun, useProject } from "./state.svelte";
import { doneSince, isHome, type FeedRow, type HomeInfo, type HomeReach } from "./home";
import type { HomeSource, SourceId } from "./homeSources";

export const BRIEF_DRAFT_KEY = "nightloom.home.briefDraft";

function readDraft(): string | null {
  try {
    const raw = localStorage.getItem(BRIEF_DRAFT_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export const home = $state({
  info: null as HomeInfo | null,
  rows: [] as FeedRow[],
  seenAt: null as string | null,
  loading: false,
  /** Why the last read failed, in words; null when it did not. */
  problem: null as string | null,
  /** His half-typed brief; null when he has not changed it. */
  briefDraft: readDraft(),
  saving: false,
  marking: false,
  /** Item 804: what Home can reach, from the last check; null before it is read. */
  reach: null as HomeReach | null,
  /** A check is running (it asks Claude Code; no model request). */
  checking: false,
  /** The connector whose switch is being saved. */
  switching: null as string | null,
  /** Item 808: Messages, Contacts, Reminders, Calendar app; null before read. */
  sources: null as HomeSource[] | null,
  /** The source whose Allow or switch is being sent. */
  sourceBusy: null as SourceId | null,
  /** The row the phone asked for (highlighted until he acts or leaves). */
  sourceAsked: null as SourceId | null,
  /** Messages' Allow was pressed: the one line of what to do in System Settings shows. */
  messagesOpened: false,
});

/** The Home project in the list, when the backend has made one. */
export function homeProject() {
  return app.projects.find(isHome) ?? null;
}

/** Re-read Home's info and feed. A backend without Home leaves both empty, quietly. */
export async function refreshHome(): Promise<void> {
  if (home.loading) return;
  home.loading = true;
  try {
    const [info, feed] = await Promise.allSettled([api.homeInfo(), api.homeFeed(200)]);
    if (info.status === "fulfilled") home.info = info.value;
    if (feed.status === "fulfilled") {
      home.rows = feed.value.rows ?? [];
      home.seenAt = feed.value.seen_at ?? null;
    }
    const bad = [info, feed].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    home.problem = bad ? String(bad.reason) : null;
  } finally {
    home.loading = false;
  }
}

/** The rows "Done since you looked" shows. */
export function homeDone(): FeedRow[] {
  return doneSince(home.rows, home.seenAt);
}

/** Open Home: today's chat, else the project with no chat open. */
export async function openHome(): Promise<void> {
  if (!canLeaveProject()) return;
  let info = home.info;
  try {
    info = await api.homeInfo();
    home.info = info;
  } catch {
    // An older backend: fall back to the project in the list.
  }
  const id = info?.project_id ?? homeProject()?.id ?? null;
  if (!id) {
    addToast("Home is not set up on this Mac yet");
    return;
  }
  if (info?.chat_id) await openRun({ session: info.chat_id, project: id, onScreen: false });
  else if (app.project?.id !== id) await useProject(id);
}

/** "Mark all seen": the feed's seen time moves to now. */
export async function markHomeSeen(): Promise<void> {
  if (home.marking) return;
  home.marking = true;
  try {
    home.seenAt = await api.homeMarkSeen();
  } catch (e) {
    addToast(`Could not mark the feed seen — ${String(e)}`);
  } finally {
    home.marking = false;
  }
}

/** Keep his half-typed brief (null drops the draft). */
export function setBriefDraft(text: string | null): void {
  home.briefDraft = text;
  try {
    if (text === null) localStorage.removeItem(BRIEF_DRAFT_KEY);
    else localStorage.setItem(BRIEF_DRAFT_KEY, JSON.stringify(text));
  } catch {
    // best-effort
  }
}

/** Save the draft as Home's brief; the draft goes only once the save lands. */
export async function saveBrief(): Promise<boolean> {
  const text = home.briefDraft;
  if (text === null || home.saving) return false;
  home.saving = true;
  try {
    await api.homeSaveBrief(text);
    if (home.info) home.info = { ...home.info, brief: text };
    setBriefDraft(null);
    return true;
  } catch (e) {
    addToast(`Could not save the brief — ${String(e)}`);
    return false;
  } finally {
    home.saving = false;
  }
}

// ---- Item 804: what Home can reach ----

/** Read the last check; the first time ever, run one. */
export async function refreshReach(): Promise<void> {
  try {
    home.reach = await api.homeReach();
  } catch {
    // An older backend: the panel says it is not available.
    return;
  }
  if (home.reach.checked_at === null) await checkReach();
}

/** Ask Claude Code what it reaches now. */
export async function checkReach(): Promise<void> {
  if (home.checking) return;
  home.checking = true;
  try {
    home.reach = await api.homeReachCheck(app.draft.agentBinary.trim() || undefined);
  } catch (e) {
    addToast(`Could not check what Home can reach — ${String(e)}`);
  } finally {
    home.checking = false;
  }
}

/** Turn one connector on or off for Home. */
export async function setReach(connector: string, on: boolean): Promise<void> {
  if (home.switching) return;
  home.switching = connector;
  try {
    home.reach = await api.homeReachSet(connector, on);
  } catch (e) {
    addToast(`Could not change that — ${String(e)}`);
  } finally {
    home.switching = null;
  }
}

// ---- Item 808: what macOS keeps on this Mac ----

/** Re-read the four rows (status only; never a dialog). */
export async function refreshSources(): Promise<void> {
  try {
    home.sources = await api.homeSources();
  } catch {
    // An older backend: the group says it is not available.
  }
}

/** His Allow: macOS asks (Contacts, Reminders, Calendar app) or System
 *  Settings opens (Messages, or one he turned down before). */
export async function allowSource(id: SourceId): Promise<void> {
  if (home.sourceBusy) return;
  home.sourceBusy = id;
  try {
    home.sources = await api.homeSourceAllow(id);
    if (id === "messages") home.messagesOpened = true;
  } catch (e) {
    addToast(`Could not ask for that — ${String(e)}`);
  } finally {
    home.sourceBusy = null;
  }
}

/** His On/Off switch on an allowed source. */
export async function setSource(id: SourceId, on: boolean): Promise<void> {
  if (home.sourceBusy) return;
  home.sourceBusy = id;
  try {
    home.sources = await api.homeSourceSet(id, on);
  } catch (e) {
    addToast(`Could not change that — ${String(e)}`);
  } finally {
    home.sourceBusy = null;
  }
}

/** The Mac's two events (item 808): the phone asked for `id` — Settings
 *  opens on Home with the row marked; macOS answered an Allow — re-read. */
export async function listenSources(): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("home-source-asked", (e) => {
    home.sourceAsked = e.payload as SourceId;
    app.settingsOpenOn = "home";
    app.showSettings = true;
    void refreshSources();
  });
  await listen("home-sources-changed", () => void refreshSources());
}
