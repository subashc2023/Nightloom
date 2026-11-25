// Item 910: a scheduled skip's card — its words on every surface (Home's Brief on the Mac, the phone's Needs you,
// the phone's Jobs list, the job's chat, Settings → Home), its buttons, and the Mac's Run now tip while it asks.
import { describe, expect, it } from "vitest";
import { confirmAsk, confirmPatch, type Job, type RunConfirm } from "./jobs";
import { needRows } from "./homeFirst";
import { runNowButton } from "../lib/homeJobs";

const confirm = (over: Partial<RunConfirm> = {}): RunConfirm => ({
  at: "2026-11-25T16:00:30Z",
  why: "the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)",
  est_week: 2,
  est_five: null,
  est_runs: 3,
  five_hour: 12,
  week: 91,
  stale: false,
  scheduled: true,
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "home-morning-scan",
  title: "Morning scan",
  text: "scan",
  every_words: "Every day at 8:00 AM",
  read_only: true,
  project: "home-p",
  chat: "c1",
  paused: false,
  next_run: "2026-11-26T16:00:00Z",
  running: null,
  last: null,
  week: { points: 0, runs: 0 },
  note: null,
  runs: 0,
  ...over,
});

describe("the scheduled skip's card (910)", () => {
  it("says the scan skipped itself this morning, Home's estimate, where he is, and why", () => {
    const morning = new Date(2026, 10, 25, 9, 0);
    const at = new Date(2026, 10, 25, 8, 0).toISOString();
    const a = confirmAsk(job({ confirm: confirm({ at }) }), morning)!;
    expect(a.title).toBe("Skipped this morning's scan to save your limits — run it now?");
    expect(a.body).toBe("Home estimates ~2% of the week; you're at 12% / 91%.");
    expect(a.reason).toBe("Skipped because the weekly window was at 91% at 7:55 AM (Claude Code's usage cache).");
    expect([a.run, a.keep]).toEqual(["Run it now", "Keep skipping"]);
    expect(a.keepTip.split("\n")).toHaveLength(2);
  });
  it("names the day when the card is from an earlier one, and another job by name", () => {
    const at = new Date(2026, 10, 24, 8, 0).toISOString();
    const a = confirmAsk(job({ id: "ci", title: "CI check", confirm: confirm({ at }) }), new Date(2026, 10, 25, 6, 0))!;
    expect(a.title).toBe("Skipped Tuesday's CI check run to save your limits — run it now?");
  });
  it("keeps the 812 card's words for a pressed Run now", () => {
    const a = confirmAsk(job({ confirm: confirm({ scheduled: false }) }))!;
    expect(a.title).toBe("Run Morning scan anyway?");
    expect([a.run, a.keep]).toEqual(["Run anyway", "Cancel"]);
  });
  it("answers with the same patches: Run it now runs once, Keep skipping dismisses", () => {
    expect(confirmPatch(true)).toEqual({ run_anyway: true });
    expect(confirmPatch(false)).toEqual({ dismiss_confirm: true });
  });
  it("is a Needs-you row on the phone's Home with its own line", () => {
    const rows = needRows([], [job({ confirm: confirm() })], [], { chat: null, label: null, pending: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "run:home-morning-scan", confirm: true, line: "Skipped itself to save your limits — run it now?" });
  });
  it("the Mac's Run now says to answer the card", () => {
    expect(runNowButton(job({ confirm: confirm() }), false)).toEqual({ disabled: true, tip: "Skipped to save your limits\nAnswer the card below" });
  });
});
