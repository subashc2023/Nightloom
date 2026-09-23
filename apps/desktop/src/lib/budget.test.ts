import { describe, expect, it } from "vitest";
import { budgetChip, budgetTitle, councilBudgetLine, spentPct, stopCard } from "./budget";
import type { TurnBudget } from "./types";

// The message's budget meter (nightshift backlog 165, pass 2).
const ledger = (over: Partial<TurnBudget> = {}): TurnBudget => ({
  started_at_ms: 1,
  budget_pct: 35,
  stop_at: 85,
  start_pct: 21,
  latest_pct: 25,
  latest_at_ms: 2,
  resets_at: null,
  phase: "turn",
  stopped: null,
  calls: 3,
  ...over,
});

describe("the budget meter", () => {
  it("phrases spent-of-budget, the wait for a reading, and the stop", () => {
    expect(spentPct(ledger())).toBe(4);
    expect(spentPct(ledger({ start_pct: null }))).toBeNull();
    // A window that reset mid-message reads as nothing spent, not negative.
    expect(spentPct(ledger({ latest_pct: 3 }))).toBe(0);
    expect(budgetChip(null)).toBe("");
    expect(budgetChip(ledger())).toBe("spent 4% of 35%");
    expect(budgetChip(ledger({ start_pct: null, latest_pct: null }))).toBe("budget 35%");
    expect(budgetChip(ledger({ latest_pct: 56, stopped: "Nightloom refuses further tool calls: …" }))).toBe("stopped · 35% of 35%");
    const title = budgetTitle(ledger());
    expect(title).toContain("4% spent of a 35% budget (window 21% → 25%)");
    expect(title).toContain("85% stop line");
    expect(budgetTitle(ledger({ stopped: "why" }))).toContain("Stopped: why");
  });

  // The override when he is present (nightshift backlog 189).
  it("says when a call is held for him, and when he let the message past the line", () => {
    const held = ledger({ latest_pct: 90, start_pct: 70, pending_since_ms: 5 });
    expect(budgetChip(held)).toBe("held at 85% · waiting for you");
    expect(budgetTitle(held)).toContain("waiting for your answer in the chat");
    const card = stopCard(held);
    expect(card?.title).toBe("Stopped at 85% of the 5-hour window");
    expect(card?.detail).toBe("the window is at 90% · this message has spent 20% of its 35%");
    expect(stopCard(ledger())).toBeNull();
    expect(stopCard(null)).toBeNull();
    const over = ledger({ latest_pct: 90, start_pct: 70, override_at_ms: 6 });
    expect(budgetChip(over)).toBe("past 85% on your word · spent 20% of 35%");
    expect(budgetTitle(over)).toContain("Continue anyway");
  });

  it("the council line names the shared budget and the room left", () => {
    expect(councilBudgetLine(35, 21, 85)).toBe(
      "Budget: 35% of the 5-hour window for this message — the seats and the chair together · window now 21%, 35% before the 85% stop line",
    );
    expect(councilBudgetLine(35, 60, 85)).toContain("25% before the 85% stop line");
    expect(councilBudgetLine(35, null, 85)).toBe("Budget: 35% of the 5-hour window for this message — the seats and the chair together");
  });
});
