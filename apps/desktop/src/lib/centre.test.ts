import { describe, expect, it } from "vitest";
import { buildNotices, countsOf, dailyDue, parseDailyPrefs, type NoticeSources } from "./centre";
import type { NightshiftRow } from "./types";

const at = (h: number, m = 0, day = 16) => new Date(2026, 8, day, h, m);

describe("the daily switch", () => {
  it("defaults off at 4 with no banner, and survives a malformed preference", () => {
    expect(parseDailyPrefs(null)).toEqual({ on: false, hour: 4, notifyMac: false });
    expect(parseDailyPrefs("{nope")).toEqual({ on: false, hour: 4, notifyMac: false });
    expect(parseDailyPrefs(JSON.stringify({ on: true, hour: 27 }))).toEqual({ on: true, hour: 4, notifyMac: false });
    expect(parseDailyPrefs(JSON.stringify({ on: true, hour: 9.7, notifyMac: true }))).toEqual({
      on: true,
      hour: 9,
      notifyMac: true,
    });
  });

  it("is due at the hour, once, and on a late launch after a missed hour", () => {
    const on = { on: true, hour: 9, notifyMac: false };
    expect(dailyDue({ ...on, on: false }, null, at(10))).toBe(false);
    // Before the hour: wait, even when it never ran.
    expect(dailyDue(on, null, at(8, 59))).toBe(false);
    // At the hour, never run: due.
    expect(dailyDue(on, null, at(9))).toBe(true);
    // Ran at 9:01 today: not due again today.
    expect(dailyDue(on, at(9, 1).getTime(), at(15))).toBe(false);
    // Opened at 15:00 with the last run yesterday (the app was closed at 9): due now.
    expect(dailyDue(on, at(9, 1, 15).getTime(), at(15))).toBe(true);
    // Opened at 7:00 the next day with the last run yesterday: waits for 9.
    expect(dailyDue(on, at(9, 1, 15).getTime(), at(7, 0, 16))).toBe(false);
    // Three days since: due as soon as the hour is reached.
    expect(dailyDue(on, at(9, 1, 12).getTime(), at(9, 0, 16))).toBe(true);
  });
});

function row(id: string, name: string, newest: string | null, open: number): NightshiftRow {
  return {
    id,
    name,
    workspace: null,
    exists: true,
    disabled: null,
    nightshift: { newest_morning: newest, open_blockers: open } as NightshiftRow["nightshift"],
  };
}

const base: NoticeSources = {
  proposals: [
    {
      project: null,
      entry: {
        id: "2026-09-16T01",
        proposal: { v: 1, at: "2026-09-16T01:00:00Z", target: { kind: "user" }, why: "one", text: "x", from_dream: true },
      },
    },
    {
      project: { id: "p1", name: "Lanternfish" },
      entry: {
        id: "2026-09-16T02",
        proposal: {
          v: 1,
          at: "2026-09-16T02:00:00Z",
          target: { kind: "project", id: "p1", name: "Lanternfish" },
          why: "two",
          text: "y",
          from_dream: true,
        },
      },
    },
  ],
  commits: [
    {
      project: null,
      repo: "/v",
      hash: "abc",
      at: "2026-09-16T03:00:00-07:00",
      subject: "nightloom: dream — consolidated 2 observations",
      files: [
        { path: "profile.md", added: 3, removed: 1 },
        { path: "topics/x.md", added: 1, removed: 0 },
      ],
    },
  ],
  rows: [row("p1", "Lanternfish", "2026-09-16.md", 2), row("p2", "Other", "2026-09-10.md", 0), { ...row("p3", "Plain", null, 0), nightshift: null }],
  read: { p2: ["2026-09-10.md"] },
  stamp: { version: "0.1.0", exe_modified: "2026-09-16T20:00:00+00:00" },
  seenStamp: "2026-09-15T20:00:00+00:00",
  dismissed: [],
};

describe("the notices", () => {
  it("lists the five kinds in order, newest first within a kind", () => {
    const n = buildNotices(base);
    expect(n.map((x) => x.kind)).toEqual(["proposal", "proposal", "dream", "morning", "blocker", "release"]);
    expect(n[0].title).toBe("A change to Lanternfish's instructions");
    expect(n[1].title).toBe("A change to your memory");
    expect(n[2].title).toBe("A dream changed 2 notes in the vault");
    expect(n[3].id).toBe("morning:p1:2026-09-16.md");
    expect(n[4].id).toBe("blocker:p1:2");
    expect(n[5].title).toBe("A release was installed (0.1.0)");
    expect(countsOf(n)).toEqual({ proposal: 2, dream: 1, morning: 1, blocker: 1, release: 1 });
  });

  it("leaves out dismissed ids, read pages, and a release on a first run", () => {
    const n = buildNotices({
      ...base,
      dismissed: ["dream:abc", "blocker:p1:2", "proposal:user:2026-09-16T01"],
      seenStamp: null,
    });
    expect(n.map((x) => x.id)).toEqual(["proposal:p1:2026-09-16T02", "morning:p1:2026-09-16.md"]);
    // One more blocker raised: the dismissed "2 open" comes back as "3 open".
    const more = buildNotices({ ...base, rows: [row("p1", "Lanternfish", null, 3)], dismissed: ["blocker:p1:2"] });
    expect(more.some((x) => x.id === "blocker:p1:3")).toBe(true);
    // The same stamp as seen: no release notice.
    expect(buildNotices({ ...base, seenStamp: base.stamp!.exe_modified }).some((x) => x.kind === "release")).toBe(false);
  });
});
