import { describe, expect, it } from "vitest";
import { STUCK_TOOL, isStuck, stuckView } from "./stuck";
import { lastText, type Job } from "../remote/jobs";

// Item 784: the runaway guard's card, as the backend's `Trip::card_input` sends it.
const repeat = {
  why: "repeat",
  tool: "Bash",
  shown: "cargo test",
  count: 3,
  result: "error[E0425]: cannot find value",
  error: true,
  sentence: "Looks stuck: ran `cargo test` 3 times, same result",
  job: "Check CI",
};

describe("the stuck card", () => {
  it("is known by its name alone", () => {
    expect(isStuck(STUCK_TOOL)).toBe(true);
    expect(isStuck("Bash")).toBe(false);
  });

  it("says what ran, what came back, and what Continue does", () => {
    const v = stuckView(repeat);
    expect(v.sentence).toBe("Looks stuck: ran `cargo test` 3 times, same result");
    expect(v.job).toBe("Check CI");
    expect(v.ran).toBe("cargo test");
    expect(v.result).toContain("E0425");
    expect(v.error).toBe(true);
    expect(v.then).toContain("6 more");
  });

  it("the calls ceiling has no command to show", () => {
    const v = stuckView({ why: "calls", made: 201, ceiling: 200, usual: null, sentence: "Looks stuck: 201 tool calls in one run" });
    expect(v.ran).toBeNull();
    expect(v.result).toBeNull();
    expect(v.job).toBeNull();
    expect(v.sentence).toBe("Looks stuck: 201 tool calls in one run");
  });

  it("falls back to the reason on a torn input", () => {
    expect(stuckView(null, "Looks stuck: x").sentence).toBe("Looks stuck: x");
  });

  it("a stopped job run is listed as stopped", () => {
    const now = new Date("2026-11-17T09:00:00");
    const job = {
      last: { started: "2026-11-17T08:00:00", ended: "2026-11-17T08:05:00", outcome: "stopped", summary: "", week_points: 1, week_after: 40 },
    } as unknown as Job;
    expect(lastText(job, now)).toContain("stopped, looked stuck");
  });
});
