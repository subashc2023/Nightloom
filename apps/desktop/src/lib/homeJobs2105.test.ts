// Item 2105: the Mac's Run now on Home's job rows — when it is off, what it says, and the row's state line.
import { describe, expect, it } from "vitest";
import type { Job } from "../remote/jobs";
import { rowState, runNowButton } from "./homeJobs";

const job = (over: Partial<Job> = {}): Job => ({
  id: "home-morning-scan",
  title: "Morning scan",
  text: "scan",
  every_words: "Every day at 8:00 AM",
  read_only: true,
  project: "home-p",
  chat: "c1",
  paused: false,
  next_run: "2026-11-18T16:00:00Z",
  running: null,
  last: null,
  week: { points: 0, runs: 0 },
  note: null,
  runs: 0,
  ...over,
});

describe("the Mac's Run now (2105)", () => {
  it("is on for a job that is idle, never run, or paused", () => {
    expect(runNowButton(job(), false).disabled).toBe(false);
    expect(runNowButton(job({ paused: true }), false).disabled).toBe(false);
    expect(runNowButton(job(), false).tip.split("\n")).toHaveLength(2);
  });
  it("is off while running, while its card asks, while a press waits to start, and while a press is on its way", () => {
    expect(runNowButton(job({ running: { started: "2026-11-17T23:00:00Z" } }), false)).toMatchObject({ disabled: true, tip: expect.stringMatching(/^It is running now/) });
    const confirm = { at: "x", why: "the 5-hour window is at 82%", est_week: 2, est_five: 5, est_runs: 1, five_hour: 82, week: 42, stale: false };
    expect(runNowButton(job({ confirm }), false)).toMatchObject({ disabled: true, tip: expect.stringMatching(/Answer the card below/) });
    expect(runNowButton(job({ run_now: true }), false)).toMatchObject({ disabled: true, tip: expect.stringMatching(/next tick/) });
    expect(runNowButton(job({ force_once: true }), false).disabled).toBe(true);
    expect(runNowButton(job(), true).disabled).toBe(true);
  });
  it("says what state the row is in", () => {
    expect(rowState(job({ running: { started: "x" } }), "Has not run yet")).toBe("Running now");
    expect(rowState(job({ run_now: true }), "Has not run yet")).toBe("Starting within 30 s");
    expect(rowState(job({ paused: true }), "Has not run yet")).toBe("Paused · Has not run yet");
    expect(rowState(job(), "Has not run yet")).toBe("Has not run yet");
  });
});
