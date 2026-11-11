/**
 * Item 590 (his "calculate context like in the middle of a reply … and like
 * take estimates"): the context a running reply has built so far. The
 * backend's `context_live` event carries the last exact figure — a round's
 * prompt at its start, prompt plus output at its end — and an estimate of
 * what has streamed since, by characters. Shown as an estimate (`~`) while
 * the estimate is non-zero; the turn's logged figure is the final word.
 */
export interface LiveContext {
  exact: number;
  estimate: number;
  rough: boolean;
  steps: number;
  /** When it arrived (ms), so a reading from an earlier turn is never shown. */
  at: number;
}

/** The reading for a turn that started at `since` (ms), else null. */
export function liveFor(r: LiveContext | null | undefined, since: number | null | undefined): LiveContext | null {
  if (!r) return null;
  if (since != null && Number.isFinite(since) && r.at < since) return null;
  return r;
}

/** Tokens the reading stands for: exact plus estimate. */
export function liveTokens(r: LiveContext): number {
  return r.exact + r.estimate;
}

/** The dial's figure: `~123k` while estimating, the exact figure's own text at a step. */
export function liveValue(r: LiveContext, short: (n: number) => string): string {
  return r.estimate > 0 ? `~${short(liveTokens(r))}` : short(r.exact);
}

/** The legend's line: `+3.4k est.` (or `+3.4k rough` with thinking in it), `exact` at a step. */
export function liveLegend(r: LiveContext, short: (n: number) => string): string {
  if (r.estimate <= 0) return "exact";
  return `+${short(r.estimate)} ${r.rough ? "rough" : "est."}`;
}

/** The legend's tip, in words. */
export function liveTip(r: LiveContext): string {
  const exact = `${r.exact.toLocaleString()} tokens exact at the last step`;
  if (r.estimate <= 0) return `Live during the reply: ${exact} (step ${r.steps}); it moves as the reply streams and lands on the logged figure at the end`;
  return `Live during the reply: ${exact}, plus about ${r.estimate.toLocaleString()} estimated from what has streamed since — text and tool calls by characters${r.rough ? "; thinking counted roughly, since Claude Code streams only a summary of it" : ""}. Corrected at each step and at the end`;
}
