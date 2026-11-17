import { describe, expect, it } from "vitest";
import { paceCardLine, paceLine, paceText, paceWarn, tighterFirst } from "./pace";
import type { PlanPace, WindowPace } from "./types";

// Mon Nov 16 2026, 1:00 PM local.
const NOW = new Date(2026, 10, 16, 13, 0).getTime();
const at = (h: number, m = 0, day = 16) => new Date(2026, 10, day, h, m).getTime();

function w(over: Partial<WindowPace> = {}): WindowPace {
  return {
    window: "five_hour",
    pct: 45,
    at_ms: NOW,
    resets_at_ms: at(16),
    ready: true,
    at80_ms: at(14, 10),
    at100_ms: at(14, 50),
    end_pct: 100,
    horizon_hours: 1,
    backtest: { err_pts: 3.6, linear_err_pts: 7.2, checks: 212 },
    readings: 4000,
    history_hours: 300,
    ...over,
  };
}

describe("the plan's pace (item 769)", () => {
  it("names the 80% and empty times and its own measured miss", () => {
    expect(paceLine(w(), NOW)).toBe(
      "5-hour: at your pace, empty at 2:50 PM, 80% at 2:10 PM (off by ~4 pts an hour ahead on 212 past checks; a straight line was off by ~7)",
    );
  });

  it("says where the window ends when it will not empty before the reset", () => {
    expect(paceLine(w({ at100_ms: null, at80_ms: null, end_pct: 61.6 }), NOW)).toBe(
      "5-hour: at your pace, near 62% at the reset (off by ~4 pts an hour ahead on 212 past checks; a straight line was off by ~7)",
    );
  });

  it("says past the stop line once there, and names another day's time with its day", () => {
    const week = w({
      window: "seven_day",
      pct: 82,
      at80_ms: NOW,
      at100_ms: at(9, 0, 18),
      horizon_hours: 24,
      backtest: { err_pts: 5, linear_err_pts: null, checks: 30 },
    });
    expect(paceLine(week, NOW)).toBe(
      "Week: at your pace, empty at Wed 9:00 AM, past 80%, your stop line (off by ~5 pts a day ahead on 30 past checks)",
    );
  });

  it("shows no time while it is still learning", () => {
    const l = paceLine(w({ ready: false, backtest: { err_pts: null, linear_err_pts: null, checks: 4 }, readings: 90 }), NOW);
    expect(l).toBe("5-hour: learning your pace — 4 of 20 past checks so far (90 readings logged)");
    expect(l).not.toMatch(/empty at/);
  });

  it("lists the tighter window first", () => {
    const fh = w({ at100_ms: null, at80_ms: null, end_pct: 60 });
    const week = w({ window: "seven_day", pct: 76, at80_ms: at(20), at100_ms: at(23) });
    const p: PlanPace = { five_hour: fh, seven_day: week, computed_at_ms: NOW };
    expect(tighterFirst(p).map((x) => x.window)).toEqual(["seven_day", "five_hour"]);
    expect(paceText(p, NOW).split("\n")[0]).toMatch(/^Week:/);
    // Neither empties: the one past 80% first, then the fuller.
    const a = w({ at100_ms: null, at80_ms: null, pct: 50 });
    const b = w({ window: "seven_day", at100_ms: null, at80_ms: NOW, pct: 85 });
    expect(tighterFirst({ five_hour: a, seven_day: b, computed_at_ms: NOW })[0].window).toBe("seven_day");
    expect(paceText(null, NOW)).toBe("");
  });

  it("warns at 80% of either window, fuller first, and not below", () => {
    expect(paceWarn({ five_hour: 79, seven_day: 50 })).toBeNull();
    expect(paceWarn({ five_hour: 80, seven_day: 50 })).toBe("5-hour window 80% — past your 80% stop line: wrap up");
    expect(paceWarn({ five_hour: 81, seven_day: 90 })).toBe(
      "weekly window 90%, 5-hour window 81% — past your 80% stop line: wrap up",
    );
    expect(paceWarn(null)).toBeNull();
  });

  it("drops the window's name on the gauge card", () => {
    expect(paceCardLine(w(), NOW)).toMatch(/^at your pace, empty at 2:50 PM/);
    expect(paceCardLine(null, NOW)).toBeNull();
  });
});
