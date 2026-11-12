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
  /** The switch as it acts: his choice for the chat, else the default. */
  mode: KeepWarmMode;
  /** The chat has his own choice (item 608); else `mode` is the default's. */
  chosen?: boolean;
  /** His Settings default, "Keep chats' caches warm automatically". */
  default_on?: boolean;
  /** A ping is scheduled or running. */
  scheduled: boolean;
  /** When the cache goes cold if the schedule runs, ms epoch. */
  warm_until_ms: number | null;
  /** When a ping last read the cache, ms epoch. */
  touched_ms: number | null;
  next_ping_ms: number | null;
  why: KeepWarmWhy | null;
  spent: { pings: number; cache_read: number; cache_write: number; output: number; cost_usd: number };
  /** The policy's own numbers; `cap_ms` here is the default cap. */
  policy: { every_ms: number; cap_ms: number; min_context: number };
  /** Item 643: the cap in force for this chat (a hold's, else the policy's). */
  cap_ms?: number;
  /** Item 643: the chat's hold longer, 12 or 24 h; null on the default cap. */
  hold_hours?: number | null;
  /** Item 643: when the hold runs out (the newest reply's send plus it), ms epoch. */
  hold_until_ms?: number | null;
}

/** The cap in force for the chat: its hold's, else the policy's (an
 *  older backend sends no `cap_ms`). */
export function capOf(s: KeepWarmStatus): number {
  return s.cap_ms ?? s.policy.cap_ms;
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
      return `ended — ${span(capOf(s))} since the last reply`;
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
  const cap = s ? span(capOf(s)) : "6 h";
  const floor = s ? k(s.policy.min_context) : "50k";
  const what =
    `Keep this chat's prompt cache warm: a small hidden request every ${every} after the last reply, for up to ${cap}, ` +
    `so your next message reads the context from the cache instead of paying to rebuild it. Only for contexts of ${floor} tokens or more. ` +
    `It stops when you send, close the tab or delete the chat. The requests never appear in the chat or the chat list.`;
  if (!s || s.mode === "off") return `${what} ${offWhy(s)} — click to switch on for this chat.${HOLD_HINT}`;
  const state = isKeeping(s, now)
    ? `On${s.mode === "once" ? " until your next message" : ""}: warm until about ${clockTime(s.warm_until_ms as number)}` +
      (s.next_ping_ms != null ? `, next request ${clockTime(s.next_ping_ms)}.` : ".")
    : `On${s.mode === "once" ? " until your next message" : ""}, not running: ${idleWords(s) ?? "waiting"}.`;
  return `${what} ${state}${onWhy(s)}${holdWords(s, now)}${spentWords(s)} Click to switch off for this chat.${HOLD_HINT}`;
}

/** Item 643: how to find the hold, at the end of every tooltip. */
const HOLD_HINT = " Right-click or press and hold to keep it warm for 12 h or 24 h.";

/** One ping ≈ 0.02 points of the 5-hour window: item 643's figure from
 *  item 541's numbers (`notes/runner-design/541-report-2026-11-10.md` in
 *  nightshift-code: a ping reads a ~100k context from the cache for about
 *  $0.02 at Opus 5.5's $0.20/M, and the plan charges ~1.3 five-hour points
 *  per list dollar — cache reads, by its weak fit, less). A rough upper
 *  figure, not a measurement. */
export const POINTS_PER_PING = 0.02;

/** The holds the menu offers beside the default, in hours (the service's `HOLD_HOURS`). */
export const HOLD_HOURS = [12, 24] as const;

/** Pings a run makes under a cap: one every `every`, none past `cap`. */
export function pingsUnder(capMs: number, everyMs: number): number {
  return everyMs > 0 ? Math.floor(capMs / everyMs) : 0;
}

/** "0.14" — a points figure, two places, never "-0". */
const pts = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

export interface HoldRow {
  /** 6 (the default), 12 or 24. */
  hours: number;
  label: string;
  /** What it costs beyond the default, or what the default is. */
  detail: string;
  /** The chat's current pick. */
  on: boolean;
}

/** The hold menu's rows: the default cap, then 12 h and 24 h, each with
 *  its extra pings and their cost in the 5-hour window (item 643). */
export function holdRows(s: KeepWarmStatus | null | undefined): HoldRow[] {
  const every = s?.policy.every_ms ?? 55 * 60_000;
  const baseMs = s?.policy.cap_ms ?? 6 * 3_600_000;
  const baseH = Math.round(baseMs / 3_600_000);
  const held = s?.hold_hours ?? null;
  const base = pingsUnder(baseMs, every);
  const rows: HoldRow[] = [
    { hours: baseH, label: `${baseH} h (default)`, detail: `${base} pings at most`, on: held == null },
  ];
  for (const h of HOLD_HOURS) {
    if (h * 3_600_000 <= baseMs) continue;
    const extra = pingsUnder(h * 3_600_000, every) - base;
    rows.push({ hours: h, label: `${h} h`, detail: `+${extra} pings ≈ ${pts(extra * POINTS_PER_PING)} pts`, on: held === h });
  }
  return rows;
}

/** The cost per extra hour, for the menu's foot: pings an hour × the figure. */
export function perHourWords(s: KeepWarmStatus | null | undefined): string {
  const every = s?.policy.every_ms ?? 55 * 60_000;
  return `≈ ${pts((3_600_000 / every) * POINTS_PER_PING)} points of the 5-hour window per extra hour (item 541's estimate: ~${POINTS_PER_PING} a ping)`;
}

/** "Thu 9:40 PM", or "9:40 PM" today. */
function dayClock(ms: number, now: number): string {
  const d = new Date(ms);
  const same = d.toDateString() === new Date(now).toDateString();
  return same ? clockTime(ms) : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clockTime(ms)}`;
}

/** The tooltip's words for a held chat; "" on the default cap. */
export function holdWords(s: KeepWarmStatus, now: number): string {
  if (s.hold_hours == null) return "";
  const until = s.hold_until_ms != null ? ` (until ~${dayClock(s.hold_until_ms, now)} unless you reply again)` : "";
  return ` Held ${s.hold_hours} h for this chat${until}, then back to ${span(s.policy.cap_ms)}.`;
}

const SETTING = "Settings → Subscription → Keeping caches warm";

/** Item 608: whose off it is — his for this chat, or the default's. */
function offWhy(s: KeepWarmStatus | null | undefined): string {
  if (!s || s.default_on === undefined) return "Off";
  if (s.chosen && s.default_on) return `Off for this chat — you switched it off; every other chat is kept warm by default (${SETTING})`;
  if (!s.chosen && !s.default_on) return `Off — the default is off (${SETTING})`;
  return "Off";
}

/** Item 608: on by the default, or by his click. */
function onWhy(s: KeepWarmStatus): string {
  if (s.default_on === undefined || s.mode === "once") return "";
  return s.chosen ? " (switched on for this chat.)" : ` (on by default for every chat — ${SETTING}.)`;
}

/**
 * Svelte action (item 643): a right-click, or a press held 500 ms, on the
 * keep-warm switch calls `open` — the hold menu — and the click that ends
 * a long press is swallowed, so the switch does not also flip. A plain
 * click is untouched.
 */
export function holdPress(node: HTMLElement, open: () => void): { update(f: () => void): void; destroy(): void } {
  let cb = open;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const clear = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    fired = false;
    clear();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      cb();
    }, HOLD_PRESS_MS);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    clear();
    cb();
  };
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointerleave", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("contextmenu", menu);
  node.addEventListener("click", click, true);
  return {
    update(f) {
      cb = f;
    },
    destroy() {
      clear();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", clear);
      node.removeEventListener("pointerleave", clear);
      node.removeEventListener("pointercancel", clear);
      node.removeEventListener("contextmenu", menu);
      node.removeEventListener("click", click, true);
    },
  };
}

/** How long a press opens the hold menu. */
export const HOLD_PRESS_MS = 500;

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
