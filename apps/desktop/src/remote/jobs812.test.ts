// Item 812: the Run anyway card's words, its patches, the row's "run anyway" mark and Home's Needs-you row.
import { describe, expect, it } from "vitest";
import { confirmAsk, confirmPatch, lastText, type Job, type RunConfirm } from "./jobs";
import { needRows } from "./homeFirst";

const confirm = (over: Partial<RunConfirm> = {}): RunConfirm => ({
  at: "2026-11-17T23:40:00Z",
  why: "Home has used today's 1% of the week",
  est_week: 2,
  est_five: 5,
  est_runs: 3,
  five_hour: 15,
  week: 42,
  stale: false,
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
  next_run: "2026-11-18T16:00:00Z",
  running: null,
  last: null,
  week: { points: 0, runs: 0 },
  note: null,
  runs: 0,
  ...over,
});

describe("the Run anyway card (812)", () => {
  it("names the job, Home's estimate and where his windows are, then the guard's reason", () => {
    const a = confirmAsk(job({ confirm: confirm() }))!;
    expect(a.title).toBe("Run Morning scan anyway?");
    expect(a.body).toBe("Home estimates ~5% of your 5h window (~2% of the week); you're at 15% / 42%.");
    expect(a.reason).toBe("Stopped because Home has used today's 1% of the week.");
  });

  it("says when there is no estimate yet, and when the usage reading is old", () => {
    expect(confirmAsk(job({ confirm: confirm({ why: "the weekly window is at 91%" }) }))!.reason).toBe("Stopped because the weekly window is at 91%.");
    expect(confirmAsk(job({ confirm: confirm({ est_week: null, est_five: null, est_runs: 0 }) }))!.body).toBe(
      "No estimate yet — first run; you're at 15% / 42%.",
    );
    expect(confirmAsk(job({ confirm: confirm({ est_five: null, est_week: 0.3, stale: true }) }))!.body).toBe(
      "Home estimates under 1% of the week; your usage reading is out of date.",
    );
  });

  it("is absent with no refused press, and its buttons send Run anyway or Cancel", () => {
    expect(confirmAsk(job())).toBeNull();
    expect(confirmPatch(true)).toEqual({ run_anyway: true });
    expect(confirmPatch(false)).toEqual({ dismiss_confirm: true });
  });

  it("marks a forced run on the row's last line", () => {
    const last = { started: "2026-11-17T23:41:00Z", ended: "2026-11-17T23:45:00Z", outcome: "done" as const, summary: "ok", week_points: 2, week_after: 44, forced: true };
    expect(lastText(job({ last }), new Date("2026-11-17T23:50:00Z"))).toMatch(/finished \(run anyway\) · 2% of the week$/);
  });

  it("puts the card in Home's Needs you, beside an approval the same job waits on", () => {
    const rows = needRows([], [job({ confirm: confirm(), wanted: { at: "2026-11-17T22:00:00Z", what: ["edit files"] } })], [], { chat: null, label: null, pending: 0 });
    expect(rows.map((r) => [r.key, r.confirm ?? false])).toEqual([
      ["run:home-morning-scan", true],
      ["job:home-morning-scan", false],
    ]);
  });
});
