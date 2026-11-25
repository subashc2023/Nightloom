import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, PLAN_USAGE_LIVE_EVERY_MS } from "./state.svelte";
import { startPlanUsageClock } from "./state/usage.svelte";
import type { PlanUsage } from "./types";

/**
 * Item 956: the plan's five-minute `/usage` poll keeps running while a turn
 * runs, so the CLI's cache (what Home's guard, the phone and `usagectl.py`
 * read) stays within about five minutes through a long turn. It skipped
 * while `app.busy` before.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  planUsage: vi.fn(),
  planUsageRefresh: vi.fn(),
  planPace: vi.fn(async () => null),
}));

const refresh = vi.mocked(api.planUsageRefresh);

describe("the plan usage clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockReset();
    refresh.mockImplementation(
      async () =>
        ({
          five_hour: 40,
          seven_day: 90,
          sampled_at_ms: Date.now(),
          age_seconds: 0,
          stale: false,
          five_hour_resets_at: null,
          seven_day_resets_at: null,
          source: "cli-usage",
        }) as PlanUsage,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    app.busy = false;
  });

  it("refreshes every five minutes through a 20-minute busy turn", async () => {
    app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
    app.busy = true;
    startPlanUsageClock();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(PLAN_USAGE_LIVE_EVERY_MS).toBe(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    // The newest reading is never older than one tick.
    expect(Date.now() - (app.planUsage?.sampled_at_ms ?? 0)).toBeLessThanOrEqual(
      PLAN_USAGE_LIVE_EVERY_MS,
    );
    // On a provider connection the same clock reads nothing.
    app.connection = { engine: "anthropic" } as unknown as typeof app.connection;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
