/**
 * Each reply's share of the plan's five-hour window and week (nightshift
 * item 323): "5h +2% · week +1%" in the reply's footer row, beside Copy and
 * the token count. The backend records one line per turn
 * (`crates/nightloom-service/src/turn_usage.rs`): the turn's own
 * `rate_limit_event` is its start reading, the next reading the app takes
 * after the turn ended is its end, and `shared` says another chat's turn
 * ran in between. Whole-percent readings make most replies +0% or +1%, so
 * a reply also carries an estimate from its API-equivalent cost at a rate
 * fitted over replies that ran alone (his 10/7 question; blocker 1271).
 * Pure: the store is `replyUsage.svelte.ts`.
 */

export interface UsageSpan {
  start: number;
  end: number;
}

export interface TurnUsageLine {
  /** Index of the turn's last reply in the chat's log. */
  target: number;
  started_at_ms: number;
  ended_at_ms: number;
  five_hour: UsageSpan | null;
  seven_day: UsageSpan | null;
  shared: boolean;
  cost_usd: number | null;
  est?: { five_hour: number | null; seven_day: number | null; replies: number } | null;
  start_at_ms: number;
  end_at_ms: number;
}

export interface ReplyUsageView {
  text: string;
  title: string;
}

/** An estimate's percent: a tenth under 10, whole above, "<0.1" below. */
export function fmtEstimate(p: number): string {
  if (p < 0.05) return "<0.1";
  if (p < 10) return (Math.round(p * 10) / 10).toFixed(1);
  return String(Math.round(p));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * One window's part: the measured rise, or `≈` the estimate when the
 * measured one says nothing (0 at whole percents) or is shared with
 * another chat; nothing without readings.
 */
function part(span: UsageSpan | null, est: number | null | undefined, shared: boolean): string | null {
  if (!span) return null;
  const d = Math.max(0, Math.round(span.end - span.start));
  if (est != null && (shared || d === 0)) return est < 0.05 ? "≈<0.1%" : `≈+${fmtEstimate(est)}%`;
  return `+${d}%`;
}

/** The footer's figure and its hover text; null when there is nothing to say. */
export function replyUsageView(line: TurnUsageLine | null | undefined): ReplyUsageView | null {
  if (!line) return null;
  const fh = part(line.five_hour, line.est?.five_hour, line.shared);
  const wk = part(line.seven_day, line.est?.seven_day, line.shared);
  if (!fh && !wk) return null;
  const parts = [fh && `5h ${fh}`, wk && `week ${wk}`].filter(Boolean) as string[];
  const usedEst = [fh, wk].some((p) => p?.startsWith("≈"));
  const text = parts.join(" · ") + (line.shared && !usedEst ? " (shared)" : "");

  const measured = (name: string, s: UsageSpan | null) =>
    s ? `${name} ${Math.round(s.start)}% → ${Math.round(s.end)}% (+${Math.max(0, Math.round(s.end - s.start))}%)` : null;
  const m = [measured("5-hour window", line.five_hour), measured("week", line.seven_day)].filter(Boolean);
  const lines: string[] = [
    `This reply's share of the plan, measured: ${m.join(", ")}.`,
    `Readings are whole percents, account-wide: at the reply's first response (${clock(line.start_at_ms)}) and the next reading after it ended (${clock(line.end_at_ms)}).`,
  ];
  if (line.est && line.cost_usd != null) {
    const e = [
      line.est.five_hour != null ? `5h ≈${fmtEstimate(line.est.five_hour)}%` : null,
      line.est.seven_day != null ? `week ≈${fmtEstimate(line.est.seven_day)}%` : null,
    ].filter(Boolean);
    if (e.length > 0)
      lines.push(
        `Estimate from this reply's API-equivalent cost ($${line.cost_usd.toFixed(2)}) at the rate fitted over ${line.est.replies} replies that ran alone: ${e.join(", ")}.`,
      );
  }
  if (line.shared)
    lines.push("Shared: another chat's turn ran in between; its use is in the measured figure and cannot be separated.");
  lines.push("Use outside Nightloom (the terminal's Claude Code, a night run, the Claude app) is in it too and is not flagged.");
  return { text, title: lines.join("\n") };
}

/** The lines by the reply they belong to; the latest wins on a repeat. */
export function byTarget(lines: TurnUsageLine[]): Map<number, TurnUsageLine> {
  const m = new Map<number, TurnUsageLine>();
  for (const l of lines) m.set(l.target, l);
  return m;
}
