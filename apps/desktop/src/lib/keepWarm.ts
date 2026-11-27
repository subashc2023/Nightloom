/**
 * Keep a chat's 1-hour prompt cache warm (nightshift backlog 582): the
 * words for the per-chat switch and the notice under his latest message.
 * The schedule is the backend's (`nightloom_service::keep_warm` has the
 * policy and the why); this file only reads its `KeepWarmStatus`.
 */

export type KeepWarmMode = "off" | "on" | "once";
/** `handedoff` (item 728): off because the chat was handed off, once. */
/** `sleep` (item 878): the next ping would fall in his sleep; the run ended at its start. */
export type KeepWarmWhy = "off" | "handedoff" | "noreply" | "small" | "notonehour" | "cap" | "cold" | "missed" | "busy" | "sleep" | "stopped";

/** His sleep, local whole hours (item 878); it may wrap midnight. */
export interface SleepWindow {
  start: number;
  end: number;
}

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
  /** Item 878: the run ends early because the next ping would fall in his sleep. */
  sleep_cut?: boolean;
  /** Item 878: his sleep as the rule in force uses it; null without one. */
  sleep?: SleepWindow | null;
}

/** "2 AM", "12 PM" — a whole local hour, 12-hour. */
export function hourWords(h: number): string {
  const n = ((h % 24) + 24) % 24;
  const t = n % 12 === 0 ? 12 : n % 12;
  return `${t} ${n < 12 ? "AM" : "PM"}`;
}

/** "2–9 AM", "11 PM–6 AM" — his sleep window. */
export function sleepWords(w: SleepWindow): string {
  const a = hourWords(w.start);
  const b = hourWords(w.end);
  const same = a.slice(-2) === b.slice(-2);
  return same ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** Item 878: the words the chip adds when the run stops for his sleep. */
export const ASLEEP = "you're usually asleep";

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

/** Item 728: the words for a switch the chat's hand-off turned off. */
const HANDED_OFF = "off — chat handed off";

/** Item 728: the switch is off because the chat was handed off (the
 *  backend switches it off once at the hand-off; his on clears it). */
export function handedOffOff(s: KeepWarmStatus | null | undefined): boolean {
  return !!s && s.mode === "off" && s.why === "handedoff";
}

/** Whether the switch is on in either form. */
export function isOn(s: KeepWarmStatus | null | undefined): boolean {
  return !!s && s.mode !== "off";
}

/** Whether pings are keeping the cache warm now (scheduled, with an end). */
export function isKeeping(s: KeepWarmStatus | null | undefined, now: number): boolean {
  return !!s && s.mode !== "off" && s.scheduled && s.warm_until_ms != null && s.warm_until_ms > now;
}

/**
 * Item 1006: the pings have ended — the next would fall in his sleep, or
 * the cap passed — but the cache's last hour still runs (a reply at 1:07 AM
 * under "stop at your sleep, 2–9 AM" is warm to 2:07 AM with no ping). The
 * list, the switch and the notice say it is warm, not stopped.
 */
export function isWarmEnding(s: KeepWarmStatus | null | undefined, now: number): boolean {
  return !!s && s.mode !== "off" && !s.scheduled && (s.why === "sleep" || s.why === "cap") && s.warm_until_ms != null && s.warm_until_ms > now;
}

/** Item 1006: the pings ended for his sleep — at the reply itself when its
 *  first ping would fall in it — while the cache still runs its hour. The
 *  switch, its tooltip and the notice say warm; the cap's last hour keeps
 *  its "ended" words there (items 582/681), and only the list shows it. */
function sleepEnding(s: KeepWarmStatus | null | undefined, now: number): boolean {
  return isWarmEnding(s, now) && s?.why === "sleep";
}

/** Item 1006: the cache is warm and the chat's switch is on — pings
 *  running, or its last hour after they ended. */
export function isWarm(s: KeepWarmStatus | null | undefined, now: number): boolean {
  return isKeeping(s, now) || isWarmEnding(s, now);
}

/** Item 1006: why no more pings come while the cache's last hour runs. */
export function endingWords(s: KeepWarmStatus): string {
  if (s.why === "sleep") return `no pings in your sleep${s.sleep ? ` (${sleepWords(s.sleep)})` : ""}`;
  return `no more pings — ${span(capOf(s))} since the last reply`;
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
      return "stopped — a ping had to rebuild the cache";
    case "stopped":
      return "stopped — starts again at the next message";
    case "sleep":
      // Item 1006: "stopped" is his Stop's word; his sleep only ends the pings.
      return `ended — no pings in your sleep${s.sleep ? ` (${sleepWords(s.sleep)})` : ""}`;
    default:
      return null;
  }
}

/** The switch's label: `keep warm` off, `warm until 11:40 PM` while it
 *  runs, `keep warm · <why not>` on but idle. */
export function switchLabel(s: KeepWarmStatus | null | undefined, now: number): string {
  if (handedOffOff(s)) return `keep warm · ${HANDED_OFF}`;
  if (!s || s.mode === "off") return "keep warm";
  if (isKeeping(s, now)) return `warm until ${clockTime(s.warm_until_ms as number)}${s.sleep_cut ? ` · ${ASLEEP}` : ""}`;
  if (sleepEnding(s, now)) return `warm until ${clockTime(s.warm_until_ms as number)} · ${endingWords(s)}`;
  const idle = idleWords(s);
  return idle ? `keep warm · ${idle}` : "keep warm on";
}

/** The switch's hold tail, "· 12 h"; "" without a hold, and none on a
 *  stopped chat (item 1006: Stop drops the hold; an older backend may still
 *  send one, which the stopped chat does not have). */
export function holdTail(s: KeepWarmStatus | null | undefined): string {
  return s?.hold_hours && s.why !== "stopped" ? `· ${s.hold_hours} h` : "";
}

/** What the pings have spent so far, or nothing before the first. */
export function spentWords(s: KeepWarmStatus): string {
  const p = s.spent;
  if (p.pings === 0) return "";
  const cost = p.cost_usd > 0 ? `, about $${p.cost_usd.toFixed(2)} at API prices (not charged on the plan)` : "";
  return ` So far: ${p.pings} ping${p.pings === 1 ? "" : "s"}, ${k(p.cache_read)} tokens read from the cache, ${k(p.cache_write)} written${cost}.`;
}

/** The switch's tooltip: two short lines, the state and what a click does
 *  (item 697, his "im not reading allat"). The rule itself — every 55 min,
 *  up to 6 h, from 50k tokens, never in the chat — is told in Settings →
 *  Subscription → Keeping caches warm. ~~The whole rule, his numbers and the
 *  spend, here~~ (cut 2026-11-15; `spentWords` and `holdWords` stay for the
 *  other places that say them). */
export function switchTitle(s: KeepWarmStatus | null | undefined, now: number, coldUsd?: number | null): string {
  // Item 776: two lines, the state then what a click does; the price of
  // letting it go cold where he decides to keep it — off or idle. While it
  // is keeping, the state line is full and the chip beside shows the price.
  const cold = coldUsd != null && !isKeeping(s, now) ? ` · cold ≈ $${coldUsd.toFixed(2)}` : "";
  if (handedOffOff(s)) return `Keep warm ${HANDED_OFF}${cold}.\nClick to switch on;${HOLD_HINT}`;
  if (!s || s.mode === "off") return `Keep warm off${offShort(s)}${cold}.\nClick to switch on;${HOLD_HINT}`;
  const once = s.mode === "once" ? " until your next message" : "";
  const state = isKeeping(s, now)
    ? `Warm${once} until ${clockTime(s.warm_until_ms as number)}` +
      (s.sleep_cut ? ` — ${ASLEEP}${s.sleep ? ` ${sleepWords(s.sleep)}` : ""}` : "") +
      (s.next_ping_ms != null ? `, next ping ${clockTime(s.next_ping_ms)}` : "")
    : sleepEnding(s, now)
      ? `Warm${once} until ${clockTime(s.warm_until_ms as number)} — ${endingWords(s)}; they start again at the next reply`
      : `Keep warm on${once}, not running: ${idleWords(s) ?? "waiting"}`;
  const held = s.hold_hours != null ? ` · held ${s.hold_hours} h` : "";
  const p = s.spent;
  const pings = p.pings > 0 ? ` · ${p.pings} ping${p.pings === 1 ? "" : "s"} so far` : "";
  return `${state}${held}${pings}${cold}.\nClick to switch off;${HOLD_HINT}`;
}

/** Whose off it is, in a few words (item 608's distinction, shortened). */
function offShort(s: KeepWarmStatus | null | undefined): string {
  if (!s || s.default_on === undefined) return "";
  if (s.chosen && s.default_on) return " for this chat";
  if (!s.chosen && !s.default_on) return " (the default is off)";
  return "";
}

/** Item 643: how to find the hold, at the end of every tooltip. */
const HOLD_HINT = " right-click to hold 12 or 24 h.";

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
  // Item 878: the default stops at his sleep; a hold runs through it.
  const asleep = s?.sleep ? `, none ${sleepWords(s.sleep)}` : "";
  const held = s?.hold_hours ?? null;
  const base = pingsUnder(baseMs, every);
  const rows: HoldRow[] = [
    { hours: baseH, label: `${baseH} h (default)`, detail: `${base} pings at most${asleep}`, on: held == null },
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

/**
 * The keep-warm row after a reply (item 681, his "should be like a toggle
 * … on the left side … the entire thing should be clickable"): on while
 * the cache is being kept, with its end; off once he switched the chat off
 * while its reply is held and its cache is still warm, so a click can
 * still keep it. Null otherwise (nothing to keep, the cap passed, the
 * chat's turn running, the cache cold) — as `noticeLine` was.
 */
export interface NoticeRow {
  on: boolean;
  text: string;
}
export function noticeRow(s: KeepWarmStatus | null | undefined, now: number): NoticeRow | null {
  if (!s) return null;
  if (isKeeping(s, now)) {
    const once = s.mode === "once" ? " or your next message" : "";
    const asleep = s.sleep_cut ? ` — ${ASLEEP} then` : "";
    return { on: true, text: `Keeping warm until ~${clockTime(s.warm_until_ms as number)}${once}${asleep}` };
  }
  if (sleepEnding(s, now)) return { on: true, text: `Warm until ~${clockTime(s.warm_until_ms as number)} — ${endingWords(s)}` };
  if (s.mode === "off" && s.warm_until_ms != null && s.warm_until_ms > now) {
    return { on: false, text: `Not keeping warm — warm until ~${clockTime(s.warm_until_ms)}; click to keep it` };
  }
  return null;
}

/** What a click on the row sends (item 681): off while on, else on — the
 *  composer's keep-warm switch's own two modes. */
export function rowToggle(row: NoticeRow): "on" | "off" {
  return row.on ? "off" : "on";
}

/** When the next ping-kept reading of the cache ends: a ping's read
 *  restarts the hour. Null without one. */
export function touchedUntil(s: KeepWarmStatus | null | undefined): number | null {
  return s && s.mode !== "off" && s.touched_ms != null ? s.touched_ms + 3_600_000 : null;
}

/**
 * Item 913: the rows of Settings' "Chats kept warm now" — every chat whose
 * cache the pings are keeping warm right now, soonest to go cold first. Pure.
 * Item 1006: and every on chat whose pings ended (his sleep, the cap) while
 * its cache still runs its last hour — the list's "from its reply until its
 * cache would go cold". A Stop forgets the reply, so a stopped chat leaves.
 */
export function keeperRows(byChat: Record<string, KeepWarmStatus>, now: number): KeepWarmStatus[] {
  return Object.values(byChat)
    .filter((s) => isWarm(s, now))
    .sort((a, b) => (a.warm_until_ms as number) - (b.warm_until_ms as number));
}

/** Item 913: the hold one Extend press gives — the next of 12 h, 24 h past
 *  the chat's current cap; null when it already holds the longest. */
export function nextHold(s: KeepWarmStatus): number | null {
  const cur = s.hold_hours ?? 0;
  const base = s.policy.cap_ms / 3_600_000;
  for (const h of HOLD_HOURS) if (h > cur && h > base) return h;
  return null;
}

/** Item 913: one row's figures — "warm until 3:40 AM · next ping 2:55 AM ·
 *  held 12 h · 4 pings ≈ $0.31". */
export function keeperLine(s: KeepWarmStatus, now: number): string {
  const parts = [`warm until ${clockTime(s.warm_until_ms as number)}`];
  if (s.next_ping_ms != null && s.next_ping_ms > now) parts.push(`next ping ${clockTime(s.next_ping_ms)}`);
  if (s.hold_hours != null) parts.push(`held ${s.hold_hours} h`);
  if (isWarmEnding(s, now)) parts.push(endingWords(s));
  else if (s.sleep_cut) parts.push(ASLEEP);
  const p = s.spent;
  if (p.pings > 0) parts.push(`${p.pings} ping${p.pings === 1 ? "" : "s"}${p.cost_usd > 0 ? ` ≈ $${p.cost_usd.toFixed(2)}` : ""}`);
  return parts.join(" · ");
}
