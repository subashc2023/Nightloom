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
  /** Item 829: tool-call arguments streamed this round, in characters. */
  writing?: number;
  /** Item 829: when this round's first reading (its exact figure) arrived. */
  roundAt?: number;
}

/**
 * Item 829 (his "not sure what's going on in this period"): what the model
 * is doing in the gap between two steps, from the stream. Measured on 4,649
 * of his rounds (Claude Code logs, 2026-11-15 to 18): the API request goes
 * out 0.2 s after a tool's result; the model's first block lands a median
 * 2.5 s later (p90 4 s) — it reads the whole chat before its first word —
 * and a call with a long body (over 3,000 characters) takes a median 14.6 s
 * (p90 23 s) to write, all of it invisible until the call is whole.
 *
 * - `reading`: the turn was sent or a result came back, and no round has
 *   started since — the model is reading the chat (`tokens`: its size).
 * - `writing`: this round has streamed tool arguments and no call has
 *   landed since — `chars` of the next call written so far.
 * - null: anything else (a running tool, prose, thinking — each has its row).
 */
export type GapPhase = { kind: "reading"; tokens: number | null } | { kind: "writing"; chars: number } | null;
export function gapPhase(
  r: LiveContext | null,
  marks: { sentAt: number | null; resultAt: number | null; callAt: number | null },
): GapPhase {
  const waitFrom = Math.max(marks.sentAt ?? 0, marks.resultAt ?? 0);
  const roundAt = r?.roundAt ?? r?.at ?? null;
  if (waitFrom > 0 && (roundAt == null || roundAt < waitFrom)) {
    return { kind: "reading", tokens: r ? liveTokens(r) : null };
  }
  if (r && (r.writing ?? 0) > 0 && r.at > (marks.callAt ?? 0)) return { kind: "writing", chars: r.writing ?? 0 };
  return null;
}

/** The phase as the working line's lead: "reading the chat (210k)", "writing a call · 3.1k chars". */
export function gapLead(p: GapPhase, short: (n: number) => string): string | null {
  if (!p) return null;
  if (p.kind === "reading") return p.tokens ? `reading the chat (${short(p.tokens)})` : "reading the chat";
  return `writing a call · ${p.chars >= 1000 ? `${(p.chars / 1000).toFixed(1)}k` : p.chars} chars`;
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
