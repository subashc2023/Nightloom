/**
 * The message's budget meter (nightshift backlog 165, pass 2, 2026-09-22):
 * one ledger (`TurnBudget`, the hook's `turn-budget.json`) phrased for
 * three places — the top bar's agents chip, the composer's busy row, the
 * Running-tasks header — and the budget line the council popover shows
 * before *Send to the council*. Pure over its inputs so the suite pins
 * the words.
 */
import type { TurnBudget } from "./types";

/** Window percent this message has spent: latest minus start, never
 *  negative; null until both readings exist. */
export function spentPct(b: TurnBudget | null): number | null {
  if (!b || b.start_pct == null || b.latest_pct == null) return null;
  return Math.max(0, b.latest_pct - b.start_pct);
}

/** The short form for a chip: `spent 4% of 35%`, or `budget 35%` before a
 *  reading, or `stopped at 35%` once the hook has refused. */
export function budgetChip(b: TurnBudget | null): string {
  if (!b) return "";
  const spent = spentPct(b);
  if (b.stopped) return `stopped · ${spent ?? "?"}% of ${b.budget_pct}%`;
  if (spent == null) return `budget ${b.budget_pct}%`;
  return `spent ${spent}% of ${b.budget_pct}%`;
}

/** The long form for a hover or a header: what the numbers are. */
export function budgetTitle(b: TurnBudget | null): string {
  if (!b) return "";
  const spent = spentPct(b);
  const lines = [
    `This message's share of the 5-hour window: ${spent == null ? "no reading yet" : `${spent}% spent`} of a ${b.budget_pct}% budget` +
      (b.start_pct != null && b.latest_pct != null ? ` (window ${b.start_pct}% → ${b.latest_pct}%)` : ""),
    `Counts the main thread, every subagent and every council seat; past the budget, or past the ${b.stop_at}% stop line, every further tool call is refused with "stop and report". Account-wide: another chat's spend shows here too.`,
  ];
  if (b.stopped) lines.push(`Stopped: ${b.stopped}`);
  return lines.join("\n");
}

/** The council popover's line: the budget the seats and the chair share,
 *  and where the window is now. */
export function councilBudgetLine(budgetPct: number, windowPct: number | null, stopAt: number): string {
  const now = windowPct == null ? "" : ` · window now ${windowPct}%`;
  const room = windowPct == null ? "" : `, ${Math.max(0, Math.min(budgetPct, stopAt - windowPct))}% before the ${stopAt}% stop line`;
  return `Budget: ${budgetPct}% of the 5-hour window for this message — the seats and the chair together${now}${room}`;
}
