import { describe, expect, it } from "vitest";
import {
  HOME_SOURCE,
  SCAN_LINE,
  clock,
  dateLabel,
  doneSince,
  factsWords,
  handOffLine,
  handOffTip,
  handOffsOf,
  homeCount,
  homeFirst,
  isHome,
  isScanMessage,
  kTokens,
  placeDividers,
  scanFacts,
  type FeedRow,
} from "./home";
import type { SessionEvent } from "./types";

// Local times, so the days are the reader's own whatever zone the run is in.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe("Home in the project list (item 763, H1)", () => {
  it("knows Home by its source, never its name", () => {
    expect(isHome({ source: HOME_SOURCE })).toBe(true);
    expect(isHome({ source: null })).toBe(false);
    expect(isHome({})).toBe(false);
    expect(isHome(null)).toBe(false);
  });
  it("puts Home first and keeps the rest in their order", () => {
    const ps: { id: string; source?: string | null }[] = [{ id: "a" }, { id: "h", source: HOME_SOURCE }, { id: "b" }];
    expect(homeFirst(ps).map((p) => p.id)).toEqual(["h", "a", "b"]);
    expect(homeFirst(ps.filter((p) => p.id !== "h")).map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("says the count only when something waits", () => {
    expect(homeCount(0)).toBe("");
    expect(homeCount(1)).toBe("1 needs you");
    expect(homeCount(3)).toBe("3 need you");
  });
});

describe("the date divider (H3)", () => {
  it("names the day as he reads it", () => {
    const now = new Date(2026, 10, 17, 9);
    expect(dateLabel(at(2026, 11, 17, 4), now)).toBe("Tuesday, November 17");
    expect(dateLabel(at(2025, 12, 31, 23), now)).toBe("Wednesday, December 31, 2025");
    expect(clock(at(2026, 11, 17, 4, 12))).toBe("4:12 AM");
    expect(clock(at(2026, 11, 17, 0, 5))).toBe("12:05 AM");
    expect(clock(at(2026, 11, 17, 12, 0))).toBe("12:00 PM");
  });
  it("draws one between two messages whose local days differ, never before the first", () => {
    const items = [
      { index: 1, at: at(2026, 11, 16, 22) },
      { index: 2, at: at(2026, 11, 16, 23) },
      { index: 3, at: at(2026, 11, 17, 8) },
      { index: 4, at: at(2026, 11, 17, 9) },
    ];
    const p = placeDividers(items, []);
    expect([...p.before.keys()]).toEqual([2]);
    expect(p.before.get(2)).toEqual([{ kind: "date", day: "2026-11-17", label: dateLabel(items[2].at) }]);
    expect(p.tail).toEqual([]);
  });
  it("skips undated items (a rewound turn) when comparing days", () => {
    const p = placeDividers(
      [
        { index: 1, at: at(2026, 11, 16, 9) },
        { index: 2, at: null },
        { index: 3, at: at(2026, 11, 16, 10) },
      ],
      [],
    );
    expect(p.before.size).toBe(0);
  });
});

describe("the hand-off divider (H3)", () => {
  const evs = [
    { event: "user_message", text: "hi", at: at(2026, 11, 16, 23) },
    { event: "auto_hand_off", soft: 200000, hard: 330000, at: at(2026, 11, 16, 23) },
    { event: "hand_off", brief: "Carry on with the scan.", context: 212345, reason: "soft", at: at(2026, 11, 17, 4, 12) },
    { event: "user_message", text: "morning", at: at(2026, 11, 17, 8) },
  ] as SessionEvent[];

  it("reads the hand-offs and their places from the log, and never the metadata event", () => {
    const hs = handOffsOf(evs);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ index: 2, context: 212345, reason: "soft", brief: "Carry on with the scan." });
  });
  it("says what happened in one line, and a two-line tooltip", () => {
    expect(handOffLine({ context: 212345, at: at(2026, 11, 17, 4, 12) })).toBe("Handed off in place · 212k → fresh · 4:12 AM");
    const t = handOffTip({ context: 212345, reason: "hard" });
    expect(t.split("\n")).toHaveLength(2);
    expect(t.startsWith("212k")).toBe(true);
  });
  it("sits before the first item logged after it, after the day's date line", () => {
    const items = [
      { index: 0, at: at(2026, 11, 16, 23) },
      { index: 3, at: at(2026, 11, 17, 8) },
    ];
    const p = placeDividers(items, handOffsOf(evs));
    const before = p.before.get(1) ?? [];
    expect(before.map((d) => d.kind)).toEqual(["date", "hand_off"]);
  });
  it("goes to the tail when nothing follows it", () => {
    const p = placeDividers([{ index: 0, at: at(2026, 11, 17, 3) }], handOffsOf(evs));
    expect(p.tail.map((d) => d.kind)).toEqual(["hand_off"]);
  });
  it("sizes in k and M", () => {
    expect(kTokens(212345)).toBe("212k");
    expect(kTokens(999)).toBe("999");
    expect(kTokens(1_200_000)).toBe("1.2M");
  });
});

describe("the scan card (H3)", () => {
  const scan = `${SCAN_LINE}\n\n- Nightloom: CI green\n- Nightshift: 2 blockers held\n`;
  it("knows the scan by its first line only", () => {
    expect(isScanMessage(scan)).toBe(true);
    expect(isScanMessage(`  ${scan}`)).toBe(true);
    expect(isScanMessage(`Please do a ${SCAN_LINE}`)).toBe(false);
    expect(isScanMessage("Morning scan")).toBe(false);
    expect(isScanMessage("")).toBe(false);
  });
  it("folds the facts under the line", () => {
    expect(scanFacts(scan)).toBe("- Nightloom: CI green\n- Nightshift: 2 blockers held");
    expect(factsWords(scanFacts(scan))).toBe("2 lines of facts");
    expect(factsWords(scanFacts(SCAN_LINE))).toBe("no facts");
  });
});

describe("Done since you looked (H2)", () => {
  const row = (iso: string, line: string): FeedRow => ({ at: iso, kind: "done", label: null, chat: "c", project: "p", line });
  it("lists rows newer than the seen time, newest first", () => {
    const rows = [row("2026-11-17T08:00:00Z", "a"), row("2026-11-17T10:00:00Z", "b"), row("2026-11-17T06:00:00Z", "old")];
    expect(doneSince(rows, "2026-11-17T07:00:00Z").map((r) => r.line)).toEqual(["b", "a"]);
  });
  it("lists everything when he has never looked", () => {
    expect(doneSince([row("2026-11-17T08:00:00Z", "a")], null)).toHaveLength(1);
  });
});
