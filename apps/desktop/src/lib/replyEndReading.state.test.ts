import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, readPlanAtReplyEnd, refreshPlanUsage } from "./state.svelte";
import type { PlanUsage } from "./types";

/**
 * The plan reading at a reply's end (item 323 review; his answer on
 * blocker 1270, 2026-10-08): taken at once with the reply's end time, so
 * the backend runs `/usage` for a sample after it and the reply's usage
 * line closes now — even when the turn's own figure is under a minute old
 * (which `refreshPlanUsage(true)` stands on); skipped while a reading is in
 * flight.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  planUsage: vi.fn(),
  planUsageRefresh: vi.fn(),
}));

const refresh = vi.mocked(api.planUsageRefresh);

function usage(five: number, sampled: number, source = "cli-usage"): PlanUsage {
  return {
    five_hour: five,
    seven_day: 10,
    sampled_at_ms: sampled,
    age_seconds: 0,
    stale: false,
    five_hour_resets_at: null,
    seven_day_resets_at: null,
    source,
  } as PlanUsage;
}

describe("readPlanAtReplyEnd", () => {
  beforeEach(() => {
    refresh.mockReset();
    app.planUsage = null;
  });

  it("asks for a sample after the reply's end even when the turn's own figure is fresh", async () => {
    const now = Date.now();
    app.planUsage = usage(41, now - 5_000, "turn");
    refresh.mockResolvedValue(usage(43, now + 10));
    // The old turn-end call stands on the turn's figure and reads nothing.
    await refreshPlanUsage(true);
    expect(refresh).not.toHaveBeenCalled();
    // The reply-end reading does read, with the end time.
    expect(await readPlanAtReplyEnd(now)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(now);
    expect(app.planUsage?.five_hour).toBe(43);
  });

  it("is skipped while another reading is in flight", async () => {
    let release: (u: PlanUsage) => void = () => {};
    refresh.mockImplementationOnce(() => new Promise<PlanUsage>((r) => (release = r)));
    const first = readPlanAtReplyEnd(1_000);
    expect(await readPlanAtReplyEnd(2_000)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    release(usage(50, 3_000));
    expect(await first).toBe(true);
    // Once it lands, the next reply's end reads again.
    refresh.mockResolvedValueOnce(usage(51, 4_000));
    expect(await readPlanAtReplyEnd(3_500)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never puts an older sample over a newer one", async () => {
    app.planUsage = usage(60, 9_000, "turn");
    refresh.mockResolvedValue(usage(55, 8_000));
    await readPlanAtReplyEnd(7_000);
    expect(app.planUsage?.five_hour).toBe(60);
  });
});
