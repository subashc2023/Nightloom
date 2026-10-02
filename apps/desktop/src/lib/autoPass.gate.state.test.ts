import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { DREAM_ENGINE, app, maybeDailyPass, maybeHandoffPass, runDailyPass } from "./state.svelte";
import type { PlanUsage } from "./types";

/**
 * The usage gate wired into the automatic passes (nightshift item 279),
 * against a stubbed backend: whether a pass reaches `api.dream` is the
 * whole question. A hand-off or nightly pass with the plan over a limit
 * does not; the next trigger under both does; *Run now* never asks.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  planUsage: vi.fn(),
  planUsageRefresh: vi.fn(),
  captureStatus: vi.fn(async () => 0),
  dreamStatus: vi.fn(async () => 3),
  capture: vi.fn(async () => ({})),
  dream: vi.fn(async () => ({ filed: [] })),
  macIdleMs: vi.fn(async () => 60 * 60_000),
  tidyMemory: vi.fn(async () => []),
  tidyThreads: vi.fn(async () => []),
  listNotes: vi.fn(async () => []),
  centreProposals: vi.fn(async () => []),
  centreDreamCommits: vi.fn(async () => []),
  nightshiftProjects: vi.fn(async () => []),
  buildStamp: vi.fn(async () => null),
}));

const dream = vi.mocked(api.dream);
const refresh = vi.mocked(api.planUsageRefresh);

// Only the clock is faked, so promises and the backend stubs run as they
// would; each test starts well past the hand-off spacing of the last.
vi.useFakeTimers({ toFake: ["Date"] });
let clock = Date.parse("2026-10-02T22:00:00Z");
afterAll(() => vi.useRealTimers());

function usage(five: number | null, week: number | null, over: Partial<PlanUsage> = {}): PlanUsage {
  return {
    five_hour: five,
    seven_day: week,
    sampled_at_ms: Date.now(),
    age_seconds: 0,
    stale: false,
    five_hour_resets_at: null,
    seven_day_resets_at: null,
    source: "turn",
    ...over,
  };
}

/** Let the stubbed pass run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  dream.mockClear();
  refresh.mockReset();
  app.dreamPrefs = { auto: true, provider: DREAM_ENGINE, model: "", limitFiveHour: 50, limitWeek: 80 };
  app.dreaming = false;
  app.capturing = false;
  app.centre.dailyRunning = false;
  app.autoPassNote = "";
});

describe("automatic passes wait for usage headroom (item 279)", () => {
  it("a hand-off with the five-hour window over its limit does not dream, and says why", async () => {
    app.planUsage = usage(63, 20);
    maybeHandoffPass();
    await settle();
    expect(dream).not.toHaveBeenCalled();
    expect(app.autoPassNote).toMatch(/deferred .* — usage 5h 63 % \(limit 50 %\)/);
  });

  it("a hand-off with the week over its limit does not dream", async () => {
    app.planUsage = usage(10, 85);
    maybeHandoffPass();
    await settle();
    expect(dream).not.toHaveBeenCalled();
    expect(app.autoPassNote).toContain("week 85 % (limit 80 %)");
  });

  it("deferred, then runs at the next trigger under both — the Continue minutes later", async () => {
    app.planUsage = usage(63, 20);
    maybeHandoffPass();
    await settle();
    expect(dream).not.toHaveBeenCalled();
    // Two minutes on, inside the hand-off spacing: the held pass did not
    // count against it, so the Continue asks again.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    app.planUsage = usage(40, 20);
    maybeHandoffPass();
    await settle();
    expect(dream).toHaveBeenCalledTimes(1);
    expect(app.autoPassNote).toMatch(/ran .*, usage under the limits \(deferred since/);
  });

  it("both under: the hand-off dreams", async () => {
    app.planUsage = usage(20, 30);
    maybeHandoffPass();
    await settle();
    expect(dream).toHaveBeenCalledTimes(1);
  });

  it("unreadable usage: the pass runs, and the line says why", async () => {
    app.planUsage = null;
    refresh.mockResolvedValue(usage(null, null, { source: "none", sampled_at_ms: null, stale: true }));
    maybeHandoffPass();
    await settle();
    expect(refresh).toHaveBeenCalled();
    expect(dream).toHaveBeenCalledTimes(1);
    expect(app.autoPassNote).toContain("ran without a usage check — the plan's usage could not be read");
  });

  it("a pass on an API provider is not held by the plan's figure", async () => {
    app.dreamPrefs.provider = "anthropic";
    app.planUsage = usage(95, 95);
    maybeHandoffPass();
    await settle();
    expect(dream).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the nightly pass is held over a limit, the day left owed, and runs once under", async () => {
    app.centre.daily = { ...app.centre.daily, on: true, hour: 0 };
    app.centre.lastDaily = null;
    app.planUsage = usage(70, 20);
    await maybeDailyPass();
    expect(dream).not.toHaveBeenCalled();
    expect(app.centre.lastDaily).toBeNull();
    app.planUsage = usage(30, 20);
    await maybeDailyPass();
    expect(dream).toHaveBeenCalledTimes(1);
    expect(app.centre.lastDaily).not.toBeNull();
  });

  it("Run now ignores the gate", async () => {
    app.planUsage = usage(99, 99);
    await runDailyPass();
    expect(dream).toHaveBeenCalledTimes(1);
  });
});
