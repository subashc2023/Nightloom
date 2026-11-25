/**
 * Each chat's keep-warm status as the window holds it (nightshift backlog
 * 582): read when a chat is shown, replaced whenever the backend says it
 * changed (`keep-warm`). In memory only — the switch itself lives in the
 * chat's folder on disk, the schedule in the backend.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { KeepWarmMode, KeepWarmStatus } from "./keepWarm";
import { app } from "./state.svelte";
import { addToast } from "./state/toasts.svelte";
import { missToastFor, type PlanEst } from "./cacheCost";
import { nameIn, overtakeToast } from "./holdRule";

/** One ping's read and spend (item 699, the backend's `keep-warm-ping`). */
export interface PingHeard {
  chat: string;
  sent_ms: number;
  context: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  plan_est: PlanEst | null;
  model: string | null;
}

/** The cache-miss toast for a ping (item 699), or null on a hit. The chat
 *  is named: a ping runs in whichever chat is held, on screen or not. */
export function pingMissToast(p: PingHeard, chatName: string | null): string | null {
  return missToastFor({
    what: "ping",
    chat: chatName,
    read: p.cache_read,
    context: p.context,
    written: p.cache_write,
    costUsd: p.cost_usd,
    est: p.plan_est,
  });
}

export const keepWarm = $state<{ byChat: Record<string, KeepWarmStatus>; defaultOn: boolean | null; hold: api.HoldView | null }>({
  byChat: {},
  // His Settings default (item 608); null until read.
  defaultOn: null,
  // Item 878: the hold rule, his sleep and the scoreboard; null until read.
  hold: null,
});

let listening = false;

/** Start hearing the backend's changes; once. */
export function watchKeepWarm(): void {
  if (listening) return;
  listening = true;
  void listen<KeepWarmStatus>("keep-warm", (e) => {
    if (e.payload?.chat) keepWarm.byChat[e.payload.chat] = e.payload;
  }).catch(() => {
    listening = false;
  });
  // Item 878: the scoreboard found a rule beating the one in force — a
  // notice, never a switch (he decides; Settings has the one click).
  void listen<api.HoldOvertake>("keep-warm-overtake", (e) => {
    const o = e.payload;
    if (!o?.challenger) return;
    void loadHold().then(() => addToast(overtakeToast(o, nameIn(keepWarm.hold))));
  }).catch(() => {});
  void listen("keep-warm-board", () => {
    void loadHold();
  }).catch(() => {});
  // Item 699: a ping that missed the cache says what it cost.
  void listen<PingHeard>("keep-warm-ping", (e) => {
    const p = e.payload;
    if (!p?.chat) return;
    const name = app.sessions.find((s) => s.id === p.chat)?.title ?? null;
    const text = pingMissToast(p, name);
    if (text) addToast(text);
  }).catch(() => {});
}

/** Read a chat's status (a chat just shown). Quiet on failure: the
 *  switch then reads off, and a click says what is wrong. */
export async function loadKeepWarm(chat: string): Promise<void> {
  watchKeepWarm();
  try {
    const s = await api.keepWarmStatus(chat);
    if (s) keepWarm.byChat[chat] = s;
  } catch {
    // Not a chat with a folder yet.
  }
}

/** Set a chat's switch. Resolves to the error's words when refused. */
export async function setKeepWarm(chat: string, mode: KeepWarmMode): Promise<string | null> {
  watchKeepWarm();
  try {
    const s = await api.keepWarmSet(chat, mode);
    if (s) keepWarm.byChat[chat] = s;
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Item 643: hold a chat warm for 12 or 24 h (6 back to the default).
 *  Resolves to the error's words when refused. */
export async function holdKeepWarm(chat: string, hours: number): Promise<string | null> {
  watchKeepWarm();
  try {
    const s = await api.keepWarmHold(chat, hours);
    if (s) keepWarm.byChat[chat] = s;
    return null;
  } catch (e) {
    return String(e);
  }
}

/** A chat's tab was closed: its keep-warm run ends. The switch stays as
 *  he set it (item 608), but "until I'm back" ends, as at a send. */
export function stopKeepWarm(chat: string): void {
  const s = keepWarm.byChat[chat];
  if (!s || s.mode === "off") return;
  void api.keepWarmStop(chat).catch(() => {});
  const mode = s.mode === "once" ? "off" : s.mode;
  keepWarm.byChat[chat] = { ...s, mode, scheduled: false, why: mode === "off" ? "off" : "noreply", next_ping_ms: null };
}

/** Item 913: read every chat's status the backend holds (Settings' "Chats
 *  kept warm now"); the `keep-warm` events keep the rows current after. */
export async function loadAllKeepWarm(): Promise<void> {
  watchKeepWarm();
  try {
    for (const s of await api.keepWarmList()) if (s?.chat) keepWarm.byChat[s.chat] = s;
  } catch {
    // An older backend without the list: the rows are the chats read so far.
  }
}

/** Item 913: Stop from the list — the run ends now and stays stopped
 *  until the chat's next send or reply, even when he opens the chat
 *  (blocker 2282); the chat's switch stays as he set it. */
export async function stopKeeper(chat: string): Promise<void> {
  const s = keepWarm.byChat[chat];
  if (!s || s.mode === "off") return;
  const mode = s.mode === "once" ? "off" : s.mode;
  keepWarm.byChat[chat] = { ...s, mode, scheduled: false, why: mode === "off" ? "off" : "stopped", next_ping_ms: null };
  // Not `loadKeepWarm` after: `keep_warm_stop_until_next` sends the new
  // status as a `keep-warm` event itself.
  try {
    await api.keepWarmStopUntilNext(chat);
  } catch {
    // An older backend: the tab-close stop, which lasts until the chat is shown.
    void api.keepWarmStop(chat).catch(() => {});
  }
}

/** Read his Settings default, "Keep chats' caches warm automatically". */
export async function loadKeepWarmDefault(): Promise<void> {
  try {
    keepWarm.defaultOn = await api.keepWarmDefault();
  } catch {
    // An older backend: the switch stays unknown and the field disabled.
  }
}

/** Set the default; every chat shown re-reads its switch, since those
 *  without a choice of their own follow it. Resolves to the error's
 *  words when refused. */
export async function setKeepWarmDefault(on: boolean): Promise<string | null> {
  watchKeepWarm();
  try {
    keepWarm.defaultOn = await api.keepWarmSetDefault(on);
  } catch (e) {
    return String(e);
  }
  await Promise.all(Object.keys(keepWarm.byChat).map((c) => loadKeepWarm(c)));
  return null;
}

/** Item 878: read the hold rule, his sleep and the scoreboard. */
export async function loadHold(): Promise<void> {
  try {
    keepWarm.hold = await api.keepWarmBoard();
  } catch {
    // An older backend: Settings shows nothing of it.
  }
}

/** Item 878: his click switches the rule. Resolves to the error's words when refused. */
export async function setHoldRule(id: string): Promise<string | null> {
  try {
    keepWarm.hold = await api.keepWarmSetRule(id);
  } catch (e) {
    return String(e);
  }
  await Promise.all(Object.keys(keepWarm.byChat).map((c) => loadKeepWarm(c)));
  return null;
}

/** Item 878: his sleep by hand, or (both null) back to the learned one. */
export async function setHoldSleep(start: number | null, end: number | null): Promise<string | null> {
  try {
    keepWarm.hold = await api.keepWarmSetSleep(start, end);
  } catch (e) {
    return String(e);
  }
  await Promise.all(Object.keys(keepWarm.byChat).map((c) => loadKeepWarm(c)));
  return null;
}

/** Item 878: re-run the scoreboard now; the board reloads when it is done. */
export async function rescoreHold(): Promise<void> {
  watchKeepWarm();
  try {
    if (await api.keepWarmRescore() && keepWarm.hold) keepWarm.hold = { ...keepWarm.hold, scoring: true };
  } catch {
    // An older backend.
  }
}
