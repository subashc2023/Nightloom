/**
 * An aside's own figures (item 605, 2026-11-11 — his "shouldn't asides
 * still have cost, context, all of the stuff in the side bar?"): what the
 * top bar's gauge and the right column read for a chat, read instead from
 * an aside thread's turns, so `TopBar` and `RightRail` draw an aside tab
 * as they draw the chat. Pure; the suite pins it.
 *
 * - **Context** is the newest answered request's input plus output — the
 *   chat's prefix the aside forked from, the thread so far, and its answer:
 *   what the next follow-up carries (the chat's gauge's rule, `contextUsed`).
 * - **Cost** is what the aside has **added on top of the chat** (item 675,
 *   2026-11-12; his "asides should show the cost as the added cost
 *   compared to the regular chat"): the sum of each answer's own spend
 *   (`added` — the CLI's API-price estimate less the chat's running cost
 *   its fork restored; not a bill under a subscription). Until 675 it
 *   summed `cost`, the CLI's `total_cost_usd`, which on a fork is the
 *   whole chat's cost so far plus the answer's — each easy answer on a
 *   $12 chat added $12 and change. `complete` is false when some answered
 *   turn carried no `added` (none came, or it was answered before 675),
 *   so the sum is a floor.
 * - **Cache hit** is the newest answer's input read back from the cache.
 * - **This turn** is the newest exchange: its fresh input, output, clock.
 *
 * Item 639 (2026-11-11, his "why does an aside not get context info?"):
 * an aside answered before 605 kept no tokens, so its dial read "—". With
 * no turn's usage the context is now **estimated** — the chat's last
 * context reading (`chatBase`, the prefix every aside forks from) plus the
 * thread as the next follow-up frames it (characters ÷ 4) — and marked so;
 * with no chat reading either, the thread alone, marked a floor. The
 * newest answer's output is estimated the same way, and its clock comes
 * from the store (`tookMs`) after a relaunch.
 */
import type { Aside, AsideTurn } from "./state.svelte";
import { asideFollowUp } from "./asideQuote";
import { estimateTokens, type TurnSize } from "./tokens";

export interface AsideFigures {
  /** Tokens the next follow-up carries as its prefix; null before any answer. */
  used: number | null;
  /** The thread's summed cost estimate; null when no answer carried one. */
  cost: { usd: number; complete: boolean } | null;
  /** The newest answer's share of input read from cache; null if unknown. */
  cacheHit: number | null;
  /** The newest exchange, live or ended; null before the first question. */
  turn: {
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number } | null;
    /** Item 639: with no usage, the answer's output estimated from its text. */
    estOut?: number;
    /** Milliseconds from the question to the answer's end (or now, while asking). */
    ms: number | null;
    live: boolean;
  } | null;
  /** The model that answered last, if the backend named it. */
  model: string | null;
  /**
   * Item 639: how `used` was reached when no turn carried usage — `chat`:
   * the chat's context reading plus the thread's text, estimated; `thread`:
   * the thread's text alone (no chat reading), a floor. Null: exact.
   */
  estimated: "chat" | "thread" | null;
  /** Item 639: questions asked in the thread (answered or not). */
  exchanges: number;
}

function answered(t: AsideTurn): boolean {
  return t.answer !== null || t.cancelled || t.error !== null;
}

/**
 * Item 639: the thread as the next follow-up carries it, estimated — the
 * framing `asideFollowUp` sends with every exchange (and the passage), plus
 * a live turn's partial answer.
 */
export function threadTokens(a: Aside): number {
  const prior = a.turns.filter(answered).map((t) => ({ question: t.question, answer: t.answer ?? t.partial }));
  const last = a.turns[a.turns.length - 1];
  const asking = last && !answered(last) ? last : null;
  return estimateTokens(asideFollowUp(a.quote, prior, asking?.question ?? "")) + (asking ? estimateTokens(asking.partial) : 0);
}

export function asideFigures(a: Aside | null, now: number = Date.now(), chatBase: number | null = null): AsideFigures {
  const out: AsideFigures = { used: null, cost: null, cacheHit: null, turn: null, model: null, estimated: null, exchanges: 0 };
  if (!a) return out;
  out.exchanges = a.turns.length;
  if (a.turns.length === 0) {
    // A draft with nothing asked: the chat's prefix is what its first question will carry.
    if (chatBase != null) {
      out.used = chatBase + threadTokens(a);
      out.estimated = "chat";
    }
    return out;
  }
  // The newest turn with usage stands for the context (a turn still asking has none yet).
  for (let i = a.turns.length - 1; i >= 0; i--) {
    const u = a.turns[i]!.usage;
    if (u) {
      // Item 675: the last round's own reading when the turn kept one —
      // `usage` sums the answer's rounds, each carrying the prefix again.
      out.used = a.turns[i]!.context ?? u.input_tokens + u.output_tokens;
      out.cacheHit = u.cache_read_tokens != null && u.input_tokens > 0 ? Math.min(1, u.cache_read_tokens / u.input_tokens) : null;
      break;
    }
  }
  if (out.used == null) {
    // Item 639: no turn kept its tokens (answered before 605, or still asking).
    const thread = threadTokens(a);
    out.used = (chatBase ?? 0) + thread;
    out.estimated = chatBase != null ? "chat" : "thread";
  }
  let usd = 0;
  let any = false;
  let complete = true;
  for (const t of a.turns) {
    if (!answered(t)) continue;
    // Item 675: `added` only — a turn's old `cost` is the chat's total.
    if (typeof t.added === "number") {
      usd += t.added;
      any = true;
    } else complete = false;
  }
  if (any) out.cost = { usd, complete };
  const last = a.turns[a.turns.length - 1]!;
  const live = !answered(last);
  const end = last.at ? Date.parse(last.at) : NaN;
  const ms =
    last.startedAt != null
      ? live
        ? now - last.startedAt
        : Number.isFinite(end)
          ? Math.max(0, end - last.startedAt)
          : null
      : typeof last.tookMs === "number"
        ? last.tookMs
        : null;
  out.turn = { usage: last.usage ?? null, ms, live };
  if (!last.usage) {
    const text = last.answer ?? last.partial;
    if (text) out.turn.estOut = estimateTokens(text);
  }
  for (let i = a.turns.length - 1; i >= 0; i--) {
    const m = a.turns[i]!.model;
    if (m) {
      out.model = m;
      break;
    }
  }
  return out;
}

/** The spend as the bar writes it: four decimals under a cent, else two.
 *  Item 675: with a plus — it is what the aside added over the chat. */
export function asideSpendText(c: AsideFigures["cost"]): string | null {
  if (!c) return null;
  if (c.usd === 0 && c.complete) return null;
  const digits = c.usd > 0 && c.usd < 0.01 ? 4 : 2;
  return `+$${c.usd.toFixed(digits)}`;
}

/**
 * Item 674 (2026-11-12): each exchange's figures for the transcript's
 * per-turn row — what `turnSizes` gives a chat's turns, read from an
 * aside's own usage, so the shared Transcript draws the share bar under
 * his question and the size in the reply's footer as it does in the chat.
 *
 * An aside's follow-up is a fresh fork that carries the chat's prefix and
 * the thread so far as text, so what one exchange added is measured the
 * chat's way, between two answers: this answer's prompt (its context less
 * its output) less the context the previous answer left. That holds only
 * where the two are comparable, and nothing is guessed elsewhere:
 *
 * - the first exchange's prompt holds the chat's whole context too —
 *   flagged `preamble` + `forked`, so the question shows its estimate and
 *   the exact figure in the title (`userFigure`), as a chat's first message does;
 * - after an answer that thought (its thinking is output, not carried
 *   into the next follow-up), one with no usage (stored before 605, an
 *   error, a stop) or a growth that comes out negative: no figure, the
 *   question's estimate stands in;
 * - an answer that used tools: its rounds' results cannot be told from
 *   the question in the sums, so the question gets no figure.
 *
 * The reply's figure is its output, as a chat reply's is. Pure.
 */
export function exchangeSizes(a: Pick<Aside, "turns">): { question: TurnSize | null; answer: TurnSize | null }[] {
  let prev: number | null | undefined = undefined; // undefined: no exchange before
  return a.turns.map((t) => {
    const u = t.usage;
    const before = prev;
    if (!u || (u.input_tokens === 0 && u.output_tokens === 0)) {
      prev = null;
      return { question: null, answer: null };
    }
    const ctx = t.context ?? u.input_tokens + u.output_tokens;
    const prompt = ctx - u.output_tokens;
    const segs = t.segments ?? [];
    const thought = segs.some((s) => s.kind === "thinking" || s.kind === "redacted");
    const tools = segs.some((s) => s.kind === "tool");
    prev = thought ? null : ctx;
    const answer: TurnSize = { tokens: u.output_tokens, out: u.output_tokens };
    if (before === undefined) return { question: { tokens: prompt, preamble: true, forked: true }, answer };
    if (before === null || tools) return { question: null, answer };
    const growth = prompt - before;
    return { question: growth >= 0 ? { tokens: growth } : null, answer };
  });
}
