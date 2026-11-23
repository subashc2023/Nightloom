/**
 * Item 878: the words Settings → Keeping caches warm says about the hold
 * rule — which rule runs, his sleep, how it scores against the others on
 * his own past, and an overtake when one has happened. The scoreboard is
 * the backend's (`nightloom_service::hold_policy`); it never switches the
 * rule itself (his "we can make that change tgt", 2026-11-23).
 */
import type { HoldOvertake, HoldView } from "./api";
import { sleepWords } from "./keepWarm";

const usd = (n: number): string => `$${n.toFixed(2)}`;

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Stop at your sleep, up to 8 h awake · your sleep 2–9 AM" — the rule in force. */
export function ruleWords(v: HoldView): string {
  const sleep = v.active.startsWith("sleep") || v.active === "hybrid" ? ` · your sleep ${sleepWords(v.sleep)}` : "";
  return `${cap(v.active_name)}${sleep}`;
}

/** Where the sleep comes from: learned, or set by him. */
export function sleepSource(v: HoldView): string {
  if (v.sleep_manual) {
    return v.learned_sleep ? `set by you (your replies say ${sleepWords(v.learned_sleep)})` : "set by you";
  }
  return "learned from when you reply and come back";
}

/** The scoreboard's line: the rule's place among the others over the
 *  window, the ceiling beside it. Null before the first run. */
export function boardWords(v: HoldView): string | null {
  const b = v.board;
  if (!b || b.table.length === 0 || b.weeks.length === 0) return null;
  const weeks = Math.min(4, b.weeks.length);
  const active = b.table.find((l) => l.id === v.active);
  const ranked = b.table.filter((l) => l.selectable).sort((x, y) => y.window.half - x.window.half);
  const place = active ? ranked.findIndex((l) => l.id === active.id) + 1 : 0;
  const ceiling = b.table.find((l) => !l.selectable);
  const head = active
    ? `${place === 1 ? "Best" : `#${place}`} of ${ranked.length} rules on your last ${weeks} week${weeks === 1 ? "" : "s"}: ${usd(active.window.half)} saved`
    : `Scored ${ranked.length} rules on your last ${weeks} weeks`;
  const ceil = ceiling ? ` (perfect foresight: ${usd(ceiling.window.half)})` : "";
  return `${head}${ceil}. Re-scored daily, ${b.moments} idle moments.`;
}

/** The overtake against the rule in force, if the last run found one. */
export function liveOvertake(v: HoldView): HoldOvertake | null {
  const o = v.board?.overtake ?? null;
  return o && o.active === v.active ? o : null;
}

/** "“flat 8 h” now beats it: $80.10 vs $77.35 over your last 4 weeks." */
export function overtakeWords(o: HoldOvertake, nameOf: (id: string) => string): string {
  return `“${nameOf(o.challenger)}” now beats it: ${usd(o.challenger_usd)} vs ${usd(o.active_usd)} over your last ${o.weeks} weeks.`;
}

/** The notice when the scoreboard finds a new overtake. */
export function overtakeToast(o: HoldOvertake, nameOf: (id: string) => string): string {
  return `Keep-warm: “${nameOf(o.challenger)}” now beats “${nameOf(o.active)}” on your last ${o.weeks} weeks (${usd(o.challenger_usd)} vs ${usd(o.active_usd)}). Switch in Settings → Keeping caches warm.`;
}

/** A rule's label from the board, else its id. */
export function nameIn(v: HoldView | null): (id: string) => string {
  return (id) => v?.board?.table.find((l) => l.id === id)?.name ?? id;
}
