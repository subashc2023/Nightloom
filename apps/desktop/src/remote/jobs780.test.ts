// Item 780: the job's approval card words, the badge, and the zone line.
import { describe, expect, it } from "vitest";
import { answerPatch, approvalAsk, approvalBadge, everyText, zoneWords, type Job } from "./jobs";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  title: "Check CI",
  text: "check CI",
  every_words: "Every day at 8:00 AM",
  read_only: true,
  project: null,
  chat: "c1",
  paused: false,
  next_run: "2026-11-18T16:00:00Z",
  running: null,
  last: null,
  week: { points: 0, runs: 0 },
  note: null,
  runs: 0,
  tz: "America/Los_Angeles",
  approval: "ask",
  wanted: null,
  ...over,
});

describe("the job approval card (780)", () => {
  it("says what a refused run wanted, in his words, and that approving runs it again", () => {
    const a = approvalAsk(job({ wanted: { at: "x", what: ["run commands", "edit files"] } }));
    expect(a.title).toBe("This job wants to make changes");
    expect(a.body).toBe("Its last run tried to run commands and edit files and was stopped, because it is read-only. Approving runs it again now.");
  });
  it("ahead of time, says what approving allows and where", () => {
    expect(approvalAsk(job(), "Nightloom").body).toContain("in Nightloom while you are away");
  });
  it("sends one patch per answer", () => {
    expect(answerPatch("once")).toEqual({ approve: "once" });
    expect(answerPatch("always")).toEqual({ approve: "always" });
    expect(answerPatch("keep")).toEqual({ dismiss_wanted: true });
  });
  it("badges what its next runs may do; an older host's read_only still reads", () => {
    expect(approvalBadge(job())).toBe("Read-only");
    expect(approvalBadge(job({ approval: "once", read_only: false }))).toBe("Next run may make changes");
    expect(approvalBadge(job({ approval: "always", read_only: false }))).toBe("Always may make changes");
    expect(approvalBadge(job({ approval: undefined, read_only: false }))).toBe("Always may make changes");
  });
});

describe("the job's zone (780)", () => {
  it("names the job's clock only when the phone is in another zone", () => {
    expect(everyText(job(), "America/Los_Angeles")).toBe("Every day at 8:00 AM");
    expect(everyText(job(), "Asia/Tokyo")).toBe("Every day at 8:00 AM, Los Angeles time");
    expect(everyText(job({ tz: null }), "Asia/Tokyo")).toBe("Every day at 8:00 AM");
    expect(zoneWords("UTC")).toBe("UTC");
  });
});
