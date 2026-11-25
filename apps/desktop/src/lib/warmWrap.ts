import type { Usage } from "./types";
import { nextSendCost, tokensShort, usd, type ChipRates } from "./cacheCost";

/**
 * Wrap up while the cache is warm; on return to a cold big chat, one chip
 * (item 768, from item 762's survey §4 draft 5; his "768 sounds great",
 * 2026-11-16). Never compacts: both paths are the hand-off he already
 * uses (`handoff.svelte.ts`), sent at a cheaper moment or offered with
 * its price.
 *
 * **Why the moment matters.** The wrap-up is one more turn on the whole
 * history. While the cache is warm its first request reads that history
 * back (Opus 5.5: $0.20/MTok, so 300k ≈ $0.06); once cold it writes it
 * afresh ($8/MTok on the CLI's 1-hour cache, 300k ≈ $2.40) — forty times
 * as much, for the same wrap-up. The note in the item's report measures
 * it on his own hand-offs.
 *
 * 1. **Warm, about to lapse** (`warmWrapAct`): a chat over the size he
 *    sets, idle, no keep-warm pinging, inside `LEAD_MS` of its cache's
 *    end. Settings → Subscription → Hand-off: *off* does nothing; *offer*
 *    (the default) shows a line over the box with *Wrap up now*; *do it*
 *    sends the wrap-up then — only when he is away (`awayNow`), else it
 *    offers, so nothing goes out under his hands.
 * 2. **Cold, on return** (`coldChipShows`): the same size, cache cold, no
 *    hand-off notice already up: one chip — *Hand off* (the wrap-up at its
 *    cold price, then a fresh small chat) or *Keep* (the next send re-writes
 *    the history, then each turn reads it back). *Keep* is remembered per
 *    chat until its next reply, across restarts.
 */

export type WarmWrapMode = "off" | "offer" | "do";
export const MODES: readonly WarmWrapMode[] = ["off", "offer", "do"];
export const DEFAULT_MODE: WarmWrapMode = "offer";
/** Chats under this context (tokens) are left alone; 0: never. */
export const DEFAULT_MIN_TOKENS = 150_000;
/** How long before the cache's end the warm wrap-up is offered or sent. */
export const LEAD_MS = 5 * 60_000;

export function isMode(v: unknown): v is WarmWrapMode {
  return v === "off" || v === "offer" || v === "do";
}

/** The context the next request carries: the newest reply's prompt and output. */
export function contextOf(usage: Usage | null | undefined): number {
  return usage ? usage.input_tokens + usage.output_tokens : 0;
}

export function bigEnough(context: number, minTokens: number): boolean {
  return minTokens > 0 && context >= minTokens;
}

export interface WarmFacts {
  mode: WarmWrapMode;
  minTokens: number;
  context: number;
  /** The cache's end, ms epoch; null with no reply that recorded one. */
  warmUntil: number | null;
  now: number;
  /** Keep-warm pings are scheduled for this chat: they will refresh it. */
  keeping: boolean;
  /** A turn runs, or a message waits in the queue. */
  busy: boolean;
  /** The hand-off is already under way here (wrapping, wrapped, handed off). */
  handingOff: boolean;
  /** The chat is never handed off by itself (a "never" mark, item 545), or
   *  he chose *Stay here* on its notice: offer, never send. */
  never: boolean;
  away: boolean;
}

/**
 * What the warm moment does now: `"do"` sends the wrap-up, `"offer"` shows
 * the line, null nothing. Inside the lead only, while still warm.
 */
export function warmWrapAct(f: WarmFacts): "offer" | "do" | null {
  if (f.mode === "off" || f.warmUntil == null) return null;
  if (!bigEnough(f.context, f.minTokens) || f.keeping || f.busy || f.handingOff) return null;
  const left = f.warmUntil - f.now;
  if (left <= 0 || left > LEAD_MS) return null;
  // A "never" chat and a present user get the offer, never a send.
  return f.mode === "do" && f.away && !f.never ? "do" : "offer";
}

export interface ColdFacts {
  minTokens: number;
  context: number;
  /** null: no cache recorded (no reply yet, or a log older than the fields). */
  warm: boolean | null;
  busy: boolean;
  handingOff: boolean;
  /** The hand-off notice is up (past the mark): it carries the way on. */
  noticeUp: boolean;
  /** He chose Keep for this chat since its newest reply. */
  kept: boolean;
}

export function coldChipShows(f: ColdFacts): boolean {
  return f.warm === false && bigEnough(f.context, f.minTokens) && !f.busy && !f.handingOff && !f.noticeUp && !f.kept;
}

export interface ChipCosts {
  context: number;
  /** The cold re-write the next send pays, either way (the wrap-up's). */
  cold: number;
  /** Item 904: Keep's next send — the re-write plus the box's draft, which
   *  goes with it (a hand-off's wrap-up does not carry it). */
  next: number;
  /** What each later turn on this history costs once warm again. */
  perTurn: number;
  /** The same wrap-up sent while warm, for the warm offer. */
  warm: number;
}

/** The chip's figures from the newest reply's usage; null without rates. */
export function chipCosts(
  usage: Usage | null | undefined,
  rates: ChipRates | null | undefined,
  /** Item 902: the next send goes to another model, which has no cache of
   *  this chat — `rates` are that model's, and even the warm wrap-up writes. */
  switched = false,
  /** Item 904: the draft's tokens — Keep's send carries them (`next`); the
   *  wrap-up and later turns do not. */
  draft = 0,
): ChipCosts | null {
  if (!usage || !rates) return null;
  const c = nextSendCost(usage, rates);
  const next = nextSendCost(usage, rates, draft).cold;
  return { context: contextOf(usage), cold: c.cold, next, perTurn: c.warm, warm: switched ? c.cold : c.warm };
}

/** The cold chip's two buttons, as they read. */
export function coldButtons(c: ChipCosts | null): { handoff: string; keep: string } {
  if (!c) return { handoff: "Hand off", keep: "Keep" };
  return { handoff: `Hand off (≈ ${usd(c.cold)})`, keep: `Keep (re-writes ${tokensShort(c.context)} ≈ ${usd(c.next)})` };
}

export function coldTitle(context: number, newModel?: string | null): string {
  // Item 902: a model switch pending — the new model has no cache at all.
  const switched = newModel ? ` · ${newModel} has no cache of it` : "";
  return `Cache cold — this chat is ${tokensShort(context)}${switched}`;
}

/** The chip's tooltip: what each choice costs and what it leaves — two
 *  short lines, numbers first (item 776's rule). `rates` stays in the
 *  signature: without them there are no figures. */
export function coldTip(c: ChipCosts | null, rates: ChipRates | null | undefined): string {
  // Post-install 16c8e01: both lines wrapped to 4 in the 320 px pill
  // (measured); each line now fits one (≤ 44 chars at $12.40-sized figures).
  const how = "Hand off: that send is the wrap-up";
  if (!c || !rates) return `The next send re-writes the whole history\n${how}`;
  // Item 904: Keep's send carries the draft (`next`).
  return `Next send ≈ ${usd(c.next)} · then ≈ ${usd(c.perTurn)} a turn\n${how}`;
}

/** The warm offer's line: `Cache cold in 4 min — this chat is 180k`. */
export function warmTitle(remainingMs: number, context: number, newModel?: string | null): string {
  const min = Math.max(1, Math.ceil(remainingMs / 60_000));
  const switched = newModel ? ` · ${newModel} has no cache of it` : "";
  return `Cache cold in ${min} min — this chat is ${tokensShort(context)}${switched}`;
}

export function warmDetail(c: ChipCosts | null): string {
  if (!c) return "wrapping up now reads the history back; after it lapses the wrap-up re-writes it";
  return `wrap up now ≈ ${usd(c.warm)} · after it lapses ≈ ${usd(c.cold)}`;
}

/** The toast as Nightloom sends the wrap-up at the warm moment ("do it"). */
export function sentToast(c: ChipCosts | null): string {
  const price = c ? ` (≈ ${usd(c.warm)} warm, against ≈ ${usd(c.cold)} once cold)` : "";
  return `Wrapping up while the cache is warm${price} — Settings → Subscription → Hand-off turns this off`;
}

/** The setting's words, for the Settings control. */
export function modeLabel(m: WarmWrapMode): string {
  return m === "off" ? "Off" : m === "offer" ? "Offer" : "Do it";
}
