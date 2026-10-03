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
export function budgetChip(b: TurnBudget | null, now = Date.now()): string {
  if (!b) return "";
  const spent = spentPct(b);
  if (heldNow(b, now)) return `held at ${b.stop_at}% · waiting for you`;
  if (b.stopped) return `stopped · ${spent ?? "?"}% of ${b.budget_pct}%`;
  if (b.wrap_at_ms) return `wrapping up · spent ${spent ?? "?"}% of ${b.budget_pct}%`;
  if (b.override_at_ms) return `past ${b.stop_at}% on your word · spent ${spent ?? "?"}% of ${b.budget_pct}%`;
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
  if (heldNow(b)) lines.push(`Held: a call past the ${b.stop_at}% stop line is waiting for your answer in the chat.`);
  if (b.wrap_at_ms) lines.push(`You pressed Wrap up: the model was told to finish and write its hand-off; no new subagents.`);
  // ~~to the end of the turn~~ — since backlog 192 the chat's, while he stays.
  if (b.override_at_ms) lines.push(`You pressed Continue anyway: this chat's calls run past the ${b.stop_at}% line while you are at the Mac — it ends after 10 minutes away.`);
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

/** The card at the stop line (nightshift backlog 189): shown while the
 *  ledger holds a call for his answer. */
export function stopCard(b: TurnBudget | null, now = Date.now()): { title: string; detail: string } | null {
  if (!b || !heldNow(b, now)) return null;
  const spent = spentPct(b);
  const at = b.latest_pct == null ? "" : `the window is at ${b.latest_pct}%`;
  const share = spent == null ? "" : `this message has spent ${spent}% of its ${b.budget_pct}%`;
  const resets = b.resets_at
    ? `it resets at ${new Date(b.resets_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return {
    title: `Stopped at ${b.stop_at}% of the 5-hour window`,
    detail: [at, share, resets].filter(Boolean).join(" · "),
  };
}

/** A call is held right now (backlog 192): the ledger's pending mark, and
 *  — when the ledger lists its holds' deadlines — one not yet past, so a
 *  hook killed mid-hold does not leave the card up. A ledger from before
 *  the list reads by the mark alone. */
export function heldNow(b: TurnBudget | null, now = Date.now()): boolean {
  if (!b || !b.pending_since_ms) return false;
  const holds = b.holds ?? [];
  return holds.length === 0 || holds.some((d) => d > now);
}

/** The first line of 086's default wrap-up, which speaks of a full
 *  context window; at the usage line it says why instead (backlog 192). */
const CONTEXT_OPENER = "This chat's context window is nearly full, so let's hand off to a new chat.";
const USAGE_OPENER = "The 5-hour usage window is near its stop line, so let's wrap up here and hand off.";

/** The wrap-up the usage line's *Wrap up* sends (backlog 192, blocker 311):
 *  the chat's own 086 wrap-up message (his edit, else the default), its
 *  context-window opener swapped for the usage one when it is there. */
export function usageWrapUp(message: string): string {
  const m = message.trim();
  return m.startsWith(CONTEXT_OPENER) ? USAGE_OPENER + m.slice(CONTEXT_OPENER.length) : m;
}
