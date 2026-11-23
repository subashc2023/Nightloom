import { describe, expect, it } from "vitest";
import { backfillSentence } from "./backfill";
import { parseBackfillCap, parseDreamPrefs, DEFAULT_BACKFILL_CAP } from "./state/prefs.svelte";

describe("backfillSentence (item 779)", () => {
  const s = (total: number, pending: number, today: number, cap = 30) => ({ total, pending, today, cap });

  it("says read, left and today's calls against the cap", () => {
    expect(backfillSentence(s(590, 278, 12), true, false)).toBe(
      "312 of 590 older sessions read, 278 left · 12 of 30 calls today",
    );
  });

  it("says when the cap is spent, when it runs, and when it is off", () => {
    expect(backfillSentence(s(590, 278, 30), true, false)).toMatch(/resumes tomorrow$/);
    expect(backfillSentence(s(590, 278, 3), true, true)).toMatch(/reading now$/);
    expect(backfillSentence(s(590, 278, 3), false, false)).toMatch(/ · off$/);
  });

  it("says when every older session is read, or there are none", () => {
    expect(backfillSentence(s(590, 0, 4), true, false)).toBe("All 590 older sessions read · 4 of 30 calls today");
    expect(backfillSentence(s(0, 0, 0), true, false)).toMatch(/^No older Claude Code sessions/);
    expect(backfillSentence(null, true, false)).toMatch(/not counted yet/);
  });
});

describe("the test sessions skipped (item 900)", () => {
  const t = (total: number, pending: number, tests: number) => ({ total, pending, today: 2, cap: 30, tests, tagged: 0 });

  it("names how many test sessions capture skips, before the run state", () => {
    expect(backfillSentence(t(290, 100, 300), true, false)).toBe(
      "190 of 290 older sessions read, 100 left · 2 of 30 calls today · 300 test sessions skipped",
    );
    expect(backfillSentence(t(290, 100, 1), true, true)).toBe(
      "190 of 290 older sessions read, 100 left · 2 of 30 calls today · 1 test session skipped · reading now",
    );
  });

  it("says nothing of tests when none are skipped or an older backend sends no count", () => {
    expect(backfillSentence(t(590, 0, 0), true, false)).toBe("All 590 older sessions read · 2 of 30 calls today");
    expect(backfillSentence({ total: 5, pending: 0, today: 0, cap: 30 }, true, false)).not.toMatch(/test/);
  });

  it("still names them when no older session is left to read", () => {
    expect(backfillSentence(t(0, 0, 12), true, false)).toMatch(/each capture\. 12 test sessions skipped\.$/);
  });
});

describe("the backfill's prefs (item 779)", () => {
  it("default on, 30 a day; a stored choice is kept", () => {
    const d = parseDreamPrefs(null);
    expect([d.backfill, d.backfillCap]).toEqual([true, DEFAULT_BACKFILL_CAP]);
    const kept = parseDreamPrefs(JSON.stringify({ v: 2, auto: true, backfill: false, backfillCap: 12 }));
    expect([kept.backfill, kept.backfillCap]).toEqual([false, 12]);
    const older = parseDreamPrefs(JSON.stringify({ v: 2, auto: false }));
    expect([older.backfill, older.backfillCap]).toEqual([true, 30]);
  });

  it("a cap out of range or not a number reads as the default", () => {
    for (const bad of [0, -3, 501, NaN, "12", null]) expect(parseBackfillCap(bad)).toBe(30);
    expect(parseBackfillCap(7.4)).toBe(7);
  });
});
