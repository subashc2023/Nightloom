/** Item 763 H6: the spend guard's words — the Mac's Home row and the phone's Jobs list. */
import { describe, expect, it } from "vitest";
import { homeTip, todayFigure } from "./home";
import { homeTodayText, lastText, type Job } from "../remote/jobs";

describe("Home's spend today", () => {
  it("the Home row shows the percent once anything is spent, and paused when stopped", () => {
    expect(todayFigure(null)).toEqual({ text: "", paused: false });
    expect(todayFigure({ points: 0, stop: null })).toEqual({ text: "", paused: false });
    expect(todayFigure({ points: 0.34, stop: null })).toEqual({ text: "0.3%", paused: false });
    expect(todayFigure({ points: 1, stop: "the weekly window is at 82%" }).paused).toBe(true);
  });

  it("the tooltip is two short lines", () => {
    const t = homeTip("every day at 8:00 AM", { points: 0.3, cap: 1, stop: null });
    expect(t).toBe("Morning scan every day at 8:00 AM\nToday 0.3% of the week, cap 1%");
    expect(homeTip(null, { points: 1, cap: 1, stop: "Home has used today's 1% of the week" }).split("\n")).toHaveLength(2);
    expect(homeTip("x", null)).toBe("Morning scan x");
  });

  it("the Jobs list says Home's spend and why its runs are paused", () => {
    expect(homeTodayText(null)).toBe("");
    expect(homeTodayText({ points: 0.3, cap: 1, stop: null })).toBe("Home today: 0.3% of the week, of its 1% a day");
    expect(homeTodayText({ points: 0, cap: 1, stop: "the 5-hour window is at 81%" })).toBe(
      "Home today: 0% of the week, of its 1% a day · paused: the 5-hour window is at 81%",
    );
  });

  it("a skipped run's row says why, with no cost", () => {
    const job = {
      last: {
        started: "2026-11-17T16:00:00Z",
        ended: "2026-11-17T16:00:00Z",
        outcome: "skipped",
        summary: "skipped — the weekly window is at 80%",
        week_points: null,
        week_after: null,
      },
    } as unknown as Job;
    const line = lastText(job, new Date("2026-11-17T16:05:00Z"));
    expect(line.startsWith("Skipped ")).toBe(true);
    expect(line.endsWith("— the weekly window is at 80%")).toBe(true);
    expect(line).not.toContain("of the week");
  });
});
