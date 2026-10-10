import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_LIMITS,
  HANDOFF_PASS_GAP_MS,
  NIGHTLY_IDLE_MS,
  NIGHTLY_STALE_MS,
  USAGE_STALE_MS,
  deferredRecheckAt,
  handoffPassDue,
  nightlyReady,
  turnWroteHandoff,
  usageGate,
} from "./autoPass";
import type { PlanUsage, SessionEvent } from "./types";

// Nightshift item 278: memory upkeep runs at a hand-off and nightly when
// the Mac is idle, not only after a compaction he never makes.

const at = "2026-10-02T00:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const tool = (name: string, input: unknown): SessionEvent => ({
  event: "assistant_message",
  model: "opus",
  blocks: [{ type: "tool_use", id: "t", name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 0, output_tokens: 0 } as never,
  at,
});

describe("a hand-off turn", () => {
  it("is one whose last turn wrote HANDOFF.md, by either engine's tools", () => {
    expect(turnWroteHandoff([user("wrap up"), tool("Edit", { file_path: "/p/HANDOFF.md" })])).toBe(true);
    expect(turnWroteHandoff([user("wrap up"), tool("write_file", { path: "HANDOFF.md" })])).toBe(true);
    expect(turnWroteHandoff([user("x"), tool("MultiEdit", { file_path: "C:\\p\\HANDOFF.md" })])).toBe(true);
  });

  it("is not a read of it, another file, or an earlier turn's write", () => {
    expect(turnWroteHandoff([user("x"), tool("Read", { file_path: "/p/HANDOFF.md" })])).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", { file_path: "/p/HANDOFF.md.bak" })])).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", { file_path: "/p/NOT-HANDOFF.md" })])).toBe(false);
    expect(
      turnWroteHandoff([user("a"), tool("Write", { file_path: "/p/HANDOFF.md" }), user("b"), tool("Read", {})]),
    ).toBe(false);
    expect(turnWroteHandoff([])).toBe(false);
    expect(turnWroteHandoff(null)).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", null)])).toBe(false);
  });

  it("starts at most one pass per gap", () => {
    expect(handoffPassDue(null, 1_000)).toBe(true);
    expect(handoffPassDue(1_000, 1_000 + HANDOFF_PASS_GAP_MS - 1)).toBe(false);
    expect(handoffPassDue(1_000, 1_000 + HANDOFF_PASS_GAP_MS)).toBe(true);
  });
});

describe("the nightly pass", () => {
  const now = 100 * 60 * 60_000;
  const recent = now - 20 * 60 * 60_000;
  it("waits for an idle Mac after a recent pass", () => {
    expect(nightlyReady(0, recent, now)).toBe(false);
    expect(nightlyReady(NIGHTLY_IDLE_MS - 1, recent, now)).toBe(false);
    expect(nightlyReady(NIGHTLY_IDLE_MS, recent, now)).toBe(true);
    // Unreadable is not idle.
    expect(nightlyReady(null, recent, now)).toBe(false);
  });

  it("runs anyway when the last pass is stale or there was none", () => {
    expect(nightlyReady(0, now - NIGHTLY_STALE_MS, now)).toBe(true);
    expect(nightlyReady(null, null, now)).toBe(true);
  });
});

// Nightshift item 279: an automatic pass waits for usage headroom.
describe("the usage gate", () => {
  const now = Date.parse("2026-10-02T22:00:00Z");
  const reading = (five: number | null, week: number | null, over: Partial<PlanUsage> = {}): PlanUsage => ({
    five_hour: five,
    seven_day: week,
    sampled_at_ms: now - 60_000,
    age_seconds: 60,
    stale: false,
    five_hour_resets_at: "2026-10-02T23:30:00Z",
    seven_day_resets_at: "2026-10-06T04:00:00Z",
    source: "cli-usage",
    ...over,
  });
  const L = DEFAULT_USAGE_LIMITS;

  it("defaults to 50 % of the five-hour window and 80 % of the week", () => {
    expect(L).toEqual({ fiveHour: 50, week: 80 });
  });

  it("holds a pass with the five-hour window over its limit, and says why", () => {
    expect(usageGate(reading(63, 20), L, true, now)).toEqual({ run: false, why: "usage 5h 63 % (limit 50 %)" });
  });

  it("holds a pass with the week over its limit", () => {
    expect(usageGate(reading(10, 85), L, true, now)).toEqual({ run: false, why: "usage week 85 % (limit 80 %)" });
    expect(usageGate(reading(70, 85), L, true, now).why).toBe("usage 5h 70 % (limit 50 %), week 85 % (limit 80 %)");
  });

  it("lets a pass run with both under (the limit itself is under)", () => {
    expect(usageGate(reading(50, 80), L, true, now)).toEqual({ run: true, why: null });
    expect(usageGate(reading(12, null), L, true, now)).toEqual({ run: true, why: null });
  });

  it("lets a pass run when usage cannot be read, with the reason", () => {
    for (const u of [null, reading(90, 90, { source: "none" }), reading(null, null)]) {
      const v = usageGate(u, L, true, now);
      expect(v.run).toBe(true);
      expect(v.why).toMatch(/could not be read|no figures/);
    }
    const stale = usageGate(reading(90, 90, { sampled_at_ms: now - USAGE_STALE_MS - 60_000 }), L, true, now);
    expect(stale).toEqual({ run: true, why: "the plan's usage reading is 21 min old" });
    expect(usageGate(reading(90, 90, { stale: true }), L, true, now).run).toBe(true);
  });

  it("does not hold a pass that bills an API provider", () => {
    expect(usageGate(reading(99, 99), L, false, now)).toEqual({
      run: true,
      why: "the pass bills an API provider, not the plan",
    });
  });

  it("follows his limits", () => {
    expect(usageGate(reading(63, 20), { fiveHour: 70, week: 80 }, true, now).run).toBe(true);
    expect(usageGate(reading(30, 20), { fiveHour: 25, week: 80 }, true, now).run).toBe(false);
  });

  it("re-checks a held pass a minute after the window that holds it resets", () => {
    expect(deferredRecheckAt(reading(63, 20), L)).toBe(Date.parse("2026-10-02T23:31:00Z"));
    expect(deferredRecheckAt(reading(10, 85), L)).toBe(Date.parse("2026-10-06T04:01:00Z"));
    // Both over: both must reset, so the later one.
    expect(deferredRecheckAt(reading(63, 85), L)).toBe(Date.parse("2026-10-06T04:01:00Z"));
    expect(deferredRecheckAt(reading(63, 20, { five_hour_resets_at: null }), L)).toBeNull();
    expect(deferredRecheckAt(reading(10, 20), L)).toBeNull();
  });
});
