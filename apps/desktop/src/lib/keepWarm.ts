/**
 * Keep a chat's 1-hour prompt cache warm (nightshift backlog 582): the
 * words for the per-chat switch and the notice under his latest message.
 * The schedule is the backend's (`nightloom_service::keep_warm` has the
 * policy and the why); this file only reads its `KeepWarmStatus`.
 */

export type KeepWarmMode = "off" | "on" | "once";
export type KeepWarmWhy = "off" | "noreply" | "small" | "notonehour" | "cap" | "cold" | "missed" | "busy";

export interface KeepWarmStatus {
  chat: string;
  mode: KeepWarmMode;
  /** A ping is scheduled or running. */
  scheduled: boolean;
  /** When the cache goes cold if the schedule runs, ms epoch. */
  warm_until_ms: number | null;
  /** When a ping last read the cache, ms epoch. */
  touched_ms: number | null;
  next_ping_ms: number | null;
  why: KeepWarmWhy | null;
  spent: { pings: number; cache_read: number; cache_write: number; output: number; cost_usd: number };
  policy: { every_ms: number; cap_ms: number; min_context: number };
}

/** "11:40 PM" — his clock, 12-hour. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** 6 → "6 h", 0.5 → "30 min". */
function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = ms / 3_600_000;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Whether the switch is on in either form. */
export function isOn(s: KeepWarmStatus | null | undefined): boolean {
  return !!s && s.mode !== "off";
}

/** Whether pings are keeping the cache warm now (scheduled, with an end). */
export function isKeeping(s: KeepWarmStatus | null | undefined, now: number): boolean {
  return !!s && s.mode !== "off" && s.scheduled && s.warm_until_ms != null && s.warm_until_ms > now;
}

/** Why an on switch is not pinging, as a few words; null while it is. */
export function idleWords(s: KeepWarmStatus): string | null {
  switch (s.why) {
    case "noreply":
      return "starts after the next reply";
    case "small":
      return `starts at ${k(s.policy.min_context)} tokens`;
    case "notonehour":
      return "this engine's cache is not the 1-hour kind";
    case "cap":
      return `ended — ${span(s.policy.cap_ms)} since the last reply`;
    case "cold":
      return "ended — the cache went cold while the Mac slept";
    case "missed":
      return "ended — a ping missed the cache";
    default:
      return null;
  }
}

/** The switch's label: `keep warm` off, `warm until 11:40 PM` while it
 *  runs, `keep warm · <why not>` on but idle. */
export function switchLabel(s: KeepWarmStatus | null | undefined, now: number): string {
  if (!s || s.mode === "off") return "keep warm";
  if (isKeeping(s, now)) return `warm until ${clockTime(s.warm_until_ms as number)}`;
  const idle = idleWords(s);
  return idle ? `keep warm · ${idle}` : "keep warm on";
}

/** What the pings have spent so far, or nothing before the first. */
export function spentWords(s: KeepWarmStatus): string {
  const p = s.spent;
  if (p.pings === 0) return "";
  const cost = p.cost_usd > 0 ? `, about $${p.cost_usd.toFixed(2)} at API prices (not charged on the plan)` : "";
  return ` So far: ${p.pings} ping${p.pings === 1 ? "" : "s"}, ${k(p.cache_read)} tokens read from the cache, ${k(p.cache_write)} written${cost}.`;
}

/** The switch's tooltip: what it does, in his numbers, and what it spent. */
export function switchTitle(s: KeepWarmStatus | null | undefined, now: number): string {
  const every = s ? span(s.policy.every_ms) : "55 min";
  const cap = s ? span(s.policy.cap_ms) : "6 h";
  const floor = s ? k(s.policy.min_context) : "50k";
  const what =
    `Keep this chat's prompt cache warm: a small hidden request every ${every} after the last reply, for up to ${cap}, ` +
    `so your next message reads the context from the cache instead of paying to rebuild it. Only for contexts of ${floor} tokens or more. ` +
    `It stops when you send, close the tab or delete the chat. The requests never appear in the chat or the chat list.`;
  if (!s || s.mode === "off") return `${what} Off — click to switch on for this chat.`;
  const state = isKeeping(s, now)
    ? `On${s.mode === "once" ? " until your next message" : ""}: warm until about ${clockTime(s.warm_until_ms as number)}` +
      (s.next_ping_ms != null ? `, next request ${clockTime(s.next_ping_ms)}.` : ".")
    : `On${s.mode === "once" ? " until your next message" : ""}, not running: ${idleWords(s) ?? "waiting"}.`;
  return `${what} ${state}${spentWords(s)} Click to switch off.`;
}

/** The notice under his latest message; null when nothing is being kept. */
export function noticeLine(s: KeepWarmStatus | null | undefined, now: number): string | null {
  if (!s || !isKeeping(s, now) || s.warm_until_ms == null) return null;
  return `Keeping warm until ~${clockTime(s.warm_until_ms)}`;
}

/** When the next ping-kept reading of the cache ends: a ping's read
 *  restarts the hour. Null without one. */
export function touchedUntil(s: KeepWarmStatus | null | undefined): number | null {
  return s && s.mode !== "off" && s.touched_ms != null ? s.touched_ms + 3_600_000 : null;
}
