import { describe, expect, it } from "vitest";
import { budgetChip, budgetTitle, councilBudgetLine, heldNow, spentPct, stopCard, usageWrapUp } from "./budget";
import { WRAP_UP } from "./handoff.svelte";
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

  // Pass 2 (nightshift backlog 192).
  it("takes the card down once every hold's deadline has passed, and names the wrap-up", () => {
    const held = ledger({ latest_pct: 90, start_pct: 70, pending_since_ms: 5, holds: [1_000, 3_000] });
    expect(heldNow(held, 2_000)).toBe(true);
    expect(stopCard(held, 2_999)).not.toBeNull();
    // A hook killed mid-hold leaves its deadline: past it, no card, no "held".
    expect(heldNow(held, 3_000)).toBe(false);
    expect(stopCard(held, 3_000)).toBeNull();
    expect(budgetChip(held, 3_000)).toBe("spent 20% of 35%");
    // A ledger from before the list reads by the mark alone.
    expect(heldNow(ledger({ pending_since_ms: 5 }), 1e15)).toBe(true);
    expect(heldNow(ledger({ holds: [9e15] }), 1)).toBe(false);
    const wrapping = ledger({ latest_pct: 90, start_pct: 70, wrap_at_ms: 7 });
    expect(budgetChip(wrapping)).toBe("wrapping up · spent 20% of 35%");
    expect(budgetTitle(wrapping)).toContain("Wrap up");
    expect(budgetTitle(ledger({ override_at_ms: 6 }))).toContain("ends after 10 minutes away");
  });

  it("the usage line's wrap-up is the chat's 086 message with the usage reason", () => {
    const w = usageWrapUp(WRAP_UP);
    expect(w.startsWith("The 5-hour usage window is near its stop line")).toBe(true);
    expect(w).not.toContain("context window is nearly full");
    expect(w).toContain("HANDOFF.md");
    // His own edit goes as he wrote it.
    expect(usageWrapUp("  Save and stop.  ")).toBe("Save and stop.");
  });

  it("the council line names the shared budget and the room left", () => {
    expect(councilBudgetLine(35, 21, 85)).toBe(
      "Budget: 35% of the 5-hour window for this message — the seats and the chair together · window now 21%, 35% before the 85% stop line",
    );
    expect(councilBudgetLine(35, 60, 85)).toContain("25% before the 85% stop line");
    expect(councilBudgetLine(35, null, 85)).toBe("Budget: 35% of the 5-hour window for this message — the seats and the chair together");
  });
});
