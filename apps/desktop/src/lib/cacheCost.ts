import type { SessionEvent, Usage } from "./types";
import { liveFlags } from "./state.svelte";
import { fmtEstimate } from "./replyUsage";
// Wave O: the pure price helpers live in `cachePrice.ts` (the phone imports
// them without this file's app state); every name stays exported from here.
import { chipNextLine, nextSendCost, nextTitle, usd, type ChipRates } from "./cachePrice";
export { chipNextLine, nextLine, nextSendCost, nextTitle, ratesFromWire, usd } from "./cachePrice";
export type { CacheRatesWire, ChipRates } from "./cachePrice";

/**
 * What a cache hit or miss costs (item 699, blocker 1995: a toast plus the
 * chip's estimate, nothing in the thinking block).
 *
 * **The miss test** is `bin/cachecheck.py`'s (items 697/698): an event
 * missed when its *first* round read under 80% of the context it resumed
 * from the cache. The first round, because a later round reads back what
 * the first one wrote, so the newest round's read hides a miss. For a turn
 * (and the first turn after a rewind) and an aside the context is the
 * previous live reply's prompt — what that request left in the cache; for
 * a keep-warm ping it is the context its line records (the reply's input
 * plus output), as cachecheck reads it.
 *
 * **The estimate** is what the next send costs at API prices: warm, the
 * reply's prompt read back plus its output written (the next request
 * caches it); cold, the reply's whole context written afresh. Rates are
 * USD per million tokens (`usage-rates.json`'s row, else a fit to the
 * CLI's own cost of the project's keep-warm pings, `usage::cache_rates`;
 * on the API engine the connection's price). Never a bill on the Max plan.
 */

/** Under this share of its context read back, an event missed. */
export const MISS_BELOW = 0.8;

export function isMiss(read: number, context: number): boolean {
  return context > 0 && read < MISS_BELOW * context;
}

/** A first round's read against the context it resumed. */
export interface RoundRead {
  read: number;
  write: number;
  context: number;
  /** A rewind stands between the previous reply and this turn. */
  rewound: boolean;
  /** He chose the miss: the history was edited, a layer or the kind
   *  changed, or a setting that loses the cache (the composer's "cache
   *  will be lost" chip, backlog 408) differs from what built it. */
  chosen: boolean;
}

/** Markers between two replies that change the prefix the next request
 *  sends — each a change he made, warned or held for the cold moment. */
const CHOSEN = new Set(["edit", "elide", "unelide", "compaction", "prompt_layers", "kind"]);

/** The cache-relevant settings two keys are compared on. */
const KEY_FIELDS = ["engine", "model", "tools", "safe_mode", "plan", "tools_switch", "thinking"] as const;

type Reply = Extract<SessionEvent, { event: "assistant_message" }>;

/**
 * The turn's first round, read off the log: `before` is how many
 * assistant messages the log held when the turn was sent, so the turn's
 * first round is the next one (the log is append-only; indexes hold).
 * Null on the chat's first-ever turn (nothing to read), when the turn
 * wrote no round or that round is not live, or on a host that reports no
 * cache read.
 */
export function turnRead(events: SessionEvent[], before: number): RoundRead | null {
  let n = 0;
  let at = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].event !== "assistant_message") continue;
    if (n === before) {
      at = i;
      break;
    }
    n++;
  }
  if (at < 0) return null;
  const live = liveFlags(events);
  if (!live[at]) return null;
  const first = events[at] as Reply;
  if (first.usage?.cache_read_tokens == null) return null;
  let prev = -1;
  for (let i = at - 1; i >= 0; i--) {
    if (live[i] && events[i].event === "assistant_message") {
      prev = i;
      break;
    }
  }
  if (prev < 0) return null;
  const was = events[prev] as Reply;
  if (!was.usage) return null;
  let rewound = false;
  let chosen = false;
  for (let i = prev + 1; i < at; i++) {
    const e = events[i];
    if (e.event === "rewind") rewound = true;
    else if (live[i] && CHOSEN.has(e.event)) chosen = true;
  }
  if (was.cache_key && first.cache_key) {
    const a = was.cache_key as unknown as Record<string, unknown>;
    const b = first.cache_key as unknown as Record<string, unknown>;
    if (KEY_FIELDS.some((k) => (a[k] ?? null) !== (b[k] ?? null))) chosen = true;
  }
  return {
    read: first.usage.cache_read_tokens ?? 0,
    write: first.usage.cache_write_tokens ?? 0,
    context: was.usage.input_tokens,
    rewound,
    chosen,
  };
}

/** The context an aside resumes: the newest live reply's prompt (an aside
 *  forks the chat's session), 0 before the first reply. */
export function lastPrompt(events: SessionEvent[]): number {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (live[i] && e.event === "assistant_message") return e.usage?.input_tokens ?? 0;
  }
  return 0;
}

/** The newest live reply's usage and model — what the chip prices. */
export function lastReply(events: SessionEvent[]): { usage: Usage; model: string } | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (live[i] && e.event === "assistant_message" && e.usage) return { usage: e.usage, model: e.model };
  }
  return null;
}

export interface PlanEst {
  five_hour: number | null;
  seven_day: number | null;
  replies?: number;
}

/** What missed and what it cost, for the toast. */
export interface MissFacts {
  what: "turn" | "rewind" | "ping" | "aside";
  /** The chat's name, for a ping (it may run in a chat not on screen). */
  chat?: string | null;
  read: number;
  context: number;
  written: number;
  costUsd: number | null | undefined;
  est: PlanEst | null | undefined;
}

/** Tokens as the toast says them: `270k`, `1.2M`, `850`. */
export function tokensShort(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function whatWords(f: MissFacts): string {
  if (f.what === "rewind") return "the first turn after the rewind";
  if (f.what === "aside") return "this aside";
  if (f.what === "ping") return f.chat ? `the keep-warm ping in “${f.chat}”` : "a keep-warm ping";
  return "this turn";
}

/**
 * The toast: `Cache missed on this turn (read 5%) — re-wrote 270k ·
 * ≈ $4.32 API · ≈ 6.5% of 5 h`. The cost is the one Claude Code reported
 * for the run (an API-price figure, not a bill); the plan share is
 * Nightloom's estimate from it at the rates fitted over lone replies.
 */
export function missToast(f: MissFacts): string {
  const pct = f.context > 0 ? Math.round((f.read / f.context) * 100) : 0;
  const parts = [`re-wrote ${tokensShort(f.written)}`];
  if (typeof f.costUsd === "number") parts.push(`≈ ${usd(f.costUsd)} API`);
  const e = f.est;
  if (e?.five_hour != null) parts.push(`≈ ${fmtEstimate(e.five_hour)}% of 5 h`);
  else if (e?.seven_day != null) parts.push(`≈ ${fmtEstimate(e.seven_day)}% of the week`);
  return `Cache missed on ${whatWords(f)} (read ${pct}%) — ${parts.join(" · ")}`;
}

/** The toast's text when `f` missed and he did not choose it; else null. */
export function missToastFor(f: MissFacts, chosen = false): string | null {
  if (chosen || !isMiss(f.read, f.context)) return null;
  return missToast(f);
}

/** Read and write rates, USD per MTok, and where they came from. */
/** The API engine's connection price (5-minute writes); a missing cache
 *  rate is the input rate, which overstates rather than understates. */
export function ratesFromPrice(
  p: { input: number; cache_read?: number | null; cache_write?: number | null } | null | undefined,
): ChipRates | null {
  if (!p) return null;
  return { read: p.cache_read ?? p.input, write: p.cache_write ?? p.input, from: "Nightloom's price table for the connected model" };
}

/** The chip's estimate for the open chat (item 699): its line and its
 *  tooltip, or null with no reply or no rates — no figure, never a guess. */
export function cacheEstimate(
  events: SessionEvent[],
  rates: ChipRates | null | undefined,
  warm: boolean,
): { line: string; title: string; usd: number; warm: number; cold: number } | null {
  const last = lastReply(events);
  if (!last || !rates) return null;
  const c = nextSendCost(last.usage, rates);
  const n = warm ? c.warm : c.cold;
  return { line: chipNextLine(c, warm), title: nextTitle(last.usage, rates, warm), usd: n, warm: c.warm, cold: c.cold };
}

/** The toast on the crossing to cold (item 605), with what the next send
 *  now costs (item 699's price fix, 2026-11-16: "it doesnt say like what
 *  the price of cache is"): `Prompt cache cold — edits to the history now
 *  cost nothing extra · the next send re-writes 270k ≈ $4.32 API`. Without
 *  rates it is the old words alone. */
export function coldToast(events: SessionEvent[], rates: ChipRates | null | undefined): string {
  const base = "Prompt cache cold — edits to the history now cost nothing extra";
  const last = lastReply(events);
  if (!last || !rates) return base;
  const ctx = last.usage.input_tokens + last.usage.output_tokens;
  return `${base} · the next send re-writes ${tokensShort(ctx)} ≈ ${usd(nextSendCost(last.usage, rates).cold)} API`;
}

/** The toast for a turn that just ended (item 699), or null: `before` is
 *  how many assistant messages the log held at the send; `costUsd` and
 *  `est` are the turn result's (`AgentTurnResult`). */
export function turnMissToast(
  events: SessionEvent[],
  before: number,
  costUsd: number | null | undefined,
  est: PlanEst | null | undefined,
): string | null {
  const r = turnRead(events, before);
  if (!r) return null;
  return missToastFor(
    { what: r.rewound ? "rewind" : "turn", read: r.read, context: r.context, written: r.write, costUsd, est },
    r.chosen,
  );
}
