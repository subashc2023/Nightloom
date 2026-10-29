import { describe, expect, it } from "vitest";
import { pressStop, releaseStop, SLOW_STOP_MS, slowDueIn, slowStopLine, stopPhase, type StopClock } from "./stopState";

describe("the Stop's pressed state (item 466)", () => {
  it("walks running → stopping → slow → idle", () => {
    const c: StopClock = { since: null };
    expect(stopPhase(false, c, 0)).toBe("idle");
    expect(stopPhase(true, c, 0)).toBe("running");
    expect(pressStop(c, 1000)).toBe(true);
    expect(stopPhase(true, c, 1000)).toBe("stopping");
    expect(stopPhase(true, c, 1000 + SLOW_STOP_MS - 1)).toBe("stopping");
    expect(stopPhase(true, c, 1000 + SLOW_STOP_MS)).toBe("slow");
    // The turn ended: idle whatever the clock says, and Stop again after release.
    expect(stopPhase(false, c, 1000 + SLOW_STOP_MS)).toBe("idle");
    releaseStop(c);
    expect(stopPhase(true, c, 9999)).toBe("running");
  });

  it("ignores a repeat press while it is stopping", () => {
    const c: StopClock = { since: null };
    expect(pressStop(c, 10)).toBe(true);
    expect(pressStop(c, 20)).toBe(false);
    expect(c.since).toBe(10);
  });

  it("holds until the turn has ended, not until a timer", () => {
    const c: StopClock = { since: null };
    pressStop(c, 0);
    expect(stopPhase(true, c, 60_000)).toBe("slow");
  });

  it("schedules one redraw at the slow mark", () => {
    const c: StopClock = { since: null };
    expect(slowDueIn(c, 0)).toBeNull();
    pressStop(c, 100);
    expect(slowDueIn(c, 600)).toBe(SLOW_STOP_MS - 500);
    expect(slowDueIn(c, 100 + SLOW_STOP_MS + 50)).toBe(0);
  });

  it("names the engine it waits on", () => {
    expect(slowStopLine("claude-code")).toBe("waiting for Claude Code to stop — the connection is slow");
    expect(slowStopLine("api")).toContain("connection is slow");
  });
});
