import { describe, it, expect, vi, beforeEach } from "vitest";
import { skippedScanToday, type FeedRow } from "./home";
import { lastText, nextText, type Job } from "../remote/jobs";

const row = (at: string, line: string, kind: FeedRow["kind"] = "scan"): FeedRow => ({ at, kind, label: "Home", chat: null, project: null, line });

describe("a skipped scan on the desktop (item 947)", () => {
  const now = new Date(2026, 10, 25, 9, 0);
  it("finds today's skipped row and strips its prefix", () => {
    const rows = [
      row(new Date(2026, 10, 24, 8, 0).toISOString(), "Morning scan skipped — yesterday's"),
      row(new Date(2026, 10, 25, 8, 0).toISOString(), "Morning scan skipped — the weekly window was at 91% at 7:55 AM (a /usage run)"),
    ];
    expect(skippedScanToday(rows, now)?.why).toBe("the weekly window was at 91% at 7:55 AM (a /usage run)");
  });
  it("is null when the scan ran, or the skip was another day", () => {
    expect(skippedScanToday([row(new Date(2026, 10, 25, 8, 0).toISOString(), "Morning scan · 2 waiting")], now)).toBeNull();
    expect(skippedScanToday([row(new Date(2026, 10, 24, 8, 0).toISOString(), "Morning scan skipped — x")], now)).toBeNull();
    expect(skippedScanToday([], now)).toBeNull();
  });
});

describe("the next line of a skipped row (item 947)", () => {
  const skipped = (note: string | null) =>
    ({ running: null, paused: false, note, next_run: "2026-11-26T16:00:00Z", tz: "UTC", last: { outcome: "skipped", summary: "skipped — why", ended: "2026-11-25T16:00:00Z" } }) as unknown as Job;
  it("shows the next run, not the reason again", () => {
    expect(nextText(skipped("skipped — why"), new Date("2026-11-25T17:00:00Z"))).toMatch(/^Next run: /);
  });
  it("still shows a waiting note", () => {
    expect(nextText(skipped("waiting — no chat"), new Date("2026-11-25T17:00:00Z"))).toBe("Waiting — no chat");
  });
});

describe("the job row after a run with no usage reading (item 947)", () => {
  const job = (reading: { source: string } | null): Job =>
    ({ last: { started: "2026-11-25T14:00:00Z", ended: "2026-11-25T14:02:00Z", outcome: "done", summary: "x", week_points: null, week_after: null, reading } }) as unknown as Job;
  it("says the 80% stop was not checked only when the reading was none", () => {
    expect(lastText(job({ source: "none" }), new Date("2026-11-25T15:00:00Z"))).toContain("80% stop not checked");
    expect(lastText(job({ source: "cli-usage" }), new Date("2026-11-25T15:00:00Z"))).not.toContain("not checked");
    expect(lastText(job(null), new Date("2026-11-25T15:00:00Z"))).not.toContain("not checked");
  });
});

const api = vi.hoisted(() => ({
  homeReach: vi.fn(),
  homeReachCheck: vi.fn(),
  homeSources: vi.fn(),
}));
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), ...api }));

describe("Watching checks (item 947)", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(api).forEach((f) => f.mockReset());
  });
  it("tries the first-ever reach check once per session, not at every open", async () => {
    api.homeReach.mockResolvedValue({ checked_at: null, connectors: [] });
    api.homeReachCheck.mockRejectedValue(new Error("claude not found"));
    const h = await import("./home.svelte");
    await h.refreshReach();
    await h.refreshReach();
    expect(api.homeReachCheck).toHaveBeenCalledTimes(1);
  }, 30000);
  it("shows a Mac source read error instead of swallowing it", async () => {
    api.homeSources.mockRejectedValue(new Error("service down"));
    const h = await import("./home.svelte");
    const st = await import("./state.svelte");
    await h.checkSource("m:messages");
    expect(st.app.toasts.some((t) => t.text.includes("Could not check it — Error: service down"))).toBe(true);
    expect(api.homeSources).toHaveBeenCalledTimes(1);
  });
});
