import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnBudget, TurnCap } from "./types";
import chipSrc from "./TurnCapChip.svelte?raw";
import composerSrc from "./Composer.svelte?raw";

// Item 538, part 2: the cap chip's states and its call, against a stand-in
// for the app's state and the backend.
const fake = vi.hoisted(() => ({
  app: {
    busy: true,
    parked: null as unknown,
    budgetSession: "c1" as string | null,
    activeSessionId: "c1" as string | null,
    connection: { engine: "claude-code" } as { engine: string } | null,
    turnBudget: null as TurnBudget | null,
  },
  calls: [] as unknown[][],
  toasts: [] as string[],
  fail: null as string | null,
}));
vi.mock("./state.svelte", () => ({
  app: fake.app,
  addToast: (t: string) => fake.toasts.push(t),
}));
vi.mock("./api", () => ({
  setTurnCap: async (session: string, capPercent: number | null, mode: string | null) => {
    fake.calls.push([session, capPercent, mode]);
    if (fake.fail) throw fake.fail;
    return { ...ledger(), cap: capPercent === null && mode === null ? null : cap({ source: "user", percent: capPercent ?? 50 }), cap_locked: true };
  },
}));
import { capChipChat, capView, clampCap, correctCap, otherMode } from "./turnCap";
import { wakeNotice } from "./capWake";

function cap(over: Partial<TurnCap> = {}): TurnCap {
  return { percent: 50, mode: "work_to_cap_then_continue", source: "model", reason: "he said up to 50%", set_at_ms: 1, ...over };
}
function ledger(over: Partial<TurnBudget> = {}): TurnBudget {
  return {
    started_at_ms: 1,
    budget_pct: 0,
    stop_at: 50,
    start_pct: 26,
    latest_pct: 32,
    latest_at_ms: 2,
    resets_at: null,
    phase: "turn",
    stopped: null,
    calls: 4,
    ...over,
  };
}

beforeEach(() => {
  Object.assign(fake.app, { busy: true, parked: null, budgetSession: "c1", activeSessionId: "c1", connection: { engine: "claude-code" }, turnBudget: null });
  fake.calls.length = 0;
  fake.toasts.length = 0;
  fake.fail = null;
});

describe("capView: what the chip shows", () => {
  it("draws nothing with no cap declared", () => {
    expect(capView(null)).toBeNull();
    expect(capView(ledger())).toBeNull();
    expect(capView(ledger({ cap: null }))).toBeNull();
  });

  it("a model-set cap: percent, mode, who, and spent against the allowance", () => {
    const v = capView(ledger({ cap: cap() }))!;
    expect(v.phase).toBe("set");
    expect([v.percent, v.modeShort, v.sourceWords, v.locked]).toEqual([50, "then continue", "set by Claude", false]);
    expect([v.spent, v.allowance]).toEqual([6, 24]);
    expect(v.fill).toBeCloseTo(0.25);
    expect(v.tip).toContain("Claude's reason: he said up to 50%");
  });

  it("a cap from his message, and one he corrected", () => {
    expect(capView(ledger({ cap: cap({ source: "message" }) }))!.sourceWords).toBe("from your message");
    const mine = capView(ledger({ cap: cap({ source: "user", mode: "finish_within" }), cap_locked: true }))!;
    expect([mine.sourceWords, mine.locked, mine.modeShort]).toEqual(["you set it", true, "finish within"]);
    expect(mine.tip).toContain("You corrected it");
  });

  it("turns near five points under the cap, and at it past", () => {
    expect(capView(ledger({ cap: cap(), latest_pct: 44 }))!.phase).toBe("set");
    expect(capView(ledger({ cap: cap(), latest_pct: 45 }))!.phase).toBe("near");
    const at = capView(ledger({ cap: cap(), latest_pct: 53 }))!;
    expect([at.phase, at.fill]).toEqual(["at", 1]);
  });

  it("with no reading yet it shows the cap alone", () => {
    const v = capView(ledger({ cap: cap(), latest_pct: null, start_pct: null }))!;
    expect([v.phase, v.spent, v.latest, v.fill]).toEqual(["set", null, null, 0]);
  });
});

describe("capChipChat: only the chat on screen whose message runs", () => {
  it("shows for the running chat on screen", () => {
    expect(capChipChat()).toBe("c1");
  });
  it("not when idle, parked, another chat's, or another engine", () => {
    for (const over of [{ busy: false }, { parked: {} }, { budgetSession: "c2" }, { connection: { engine: "anthropic" } }]) {
      Object.assign(fake.app, { busy: true, parked: null, budgetSession: "c1", connection: { engine: "claude-code" } }, over);
      expect(capChipChat()).toBeNull();
    }
  });
});

describe("correctCap: the call through set_turn_cap", () => {
  it("changes the percent (mode kept), flips the mode, or removes the cap", async () => {
    expect(await correctCap("c1", 60, null)).toBe(true);
    expect(fake.app.turnBudget?.cap?.percent).toBe(60);
    expect(fake.app.turnBudget?.cap_locked).toBe(true);
    await correctCap("c1", null, otherMode("work_to_cap_then_continue"));
    await correctCap("c1", null, null);
    expect(fake.calls).toEqual([
      ["c1", 60, null],
      ["c1", null, "finish_within"],
      ["c1", null, null],
    ]);
    expect(fake.app.turnBudget?.cap).toBeNull();
  });

  it("clamps the percent to 1–100 and whole points", async () => {
    await correctCap("c1", 140, null);
    await correctCap("c1", 0, null);
    await correctCap("c1", 37.6, null);
    expect(fake.calls.map((c) => c[1])).toEqual([100, 1, 38]);
    expect(clampCap(Number.NaN)).toBe(1);
  });

  it("an error is a toast and leaves the ledger alone", async () => {
    fake.fail = "no budget ledger for this chat";
    fake.app.turnBudget = ledger({ cap: cap() });
    expect(await correctCap("c1", 60, null)).toBe(false);
    expect(fake.app.turnBudget.cap?.percent).toBe(50);
    expect(fake.toasts[0]).toContain("no budget ledger");
  });

  it("does not write another chat's ledger over the one on screen", async () => {
    Object.assign(fake.app, { budgetSession: "c1", activeSessionId: "c1", turnBudget: ledger({ cap: cap() }) });
    await correctCap("other", 70, null);
    expect(fake.app.turnBudget?.cap?.percent).toBe(50);
  });
});

describe("the wake notice and the composer's slot", () => {
  it("says what Nightloom told the main agent, in his terms", () => {
    expect(wakeNotice(["near"], 46, 50)).toBe("usage at 46% is near the 50% cap — Nightloom told the main agent to have its helpers wrap up");
    expect(wakeNotice(["near", "at_cap"], 51, 50)).toContain("usage at 51% reached the 50% cap");
    expect(wakeNotice(["reserved"], 30, 50)).toContain("launch no more");
    expect(wakeNotice(["hard"], 96, null)).toContain("plan's limit");
  });

  it("the chip sits beside the browser chip, plain under Classic, and Classic draws no ring or motion", () => {
    expect(composerSrc).toMatch(/<BrowserChip chat=\{app\.activeSessionId\} \/>\s*<!--[^>]*-->\s*<TurnCapChip plain=\{classic\(\)\} \/>/);
    expect(chipSrc).toMatch(/\{#if !plain\}\s*<svg class="ring"/);
    expect(chipSrc).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(chipSrc).toMatch(/\.plain \.cap-chip \{[^}]*transition: none;/);
  });
});
