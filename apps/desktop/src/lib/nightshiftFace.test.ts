import { describe, expect, it } from "vitest";
import { clock12, passLength, passTrace, planRun, spanWords, tally } from "./nightshiftFace";
import type { Item, UnitStatus } from "./types";

const unit = (n: number, started: string | null, ended: string | null, outcome: string | null): UnitStatus => ({
  n, item_id: `i${n}`, pass: 1, started, ended, outcome, commit: null, cost_usd: null, turns: null, continuation_commit: null, landing: false,
});

describe("clock12", () => {
  const now = new Date(2026, 10, 10, 20, 14);
  it("prints the 12-hour clock today", () => {
    expect(clock12(new Date(2026, 10, 10, 23, 0).getTime(), now)).toBe("11:00 PM");
    expect(clock12(new Date(2026, 10, 10, 0, 5).getTime(), now)).toBe("12:05 AM");
  });
  it("says tomorrow, then a date", () => {
    expect(clock12(new Date(2026, 10, 11, 7, 0).getTime(), now)).toBe("7:00 AM tomorrow");
    expect(clock12(new Date(2026, 10, 13, 12, 30).getTime(), now)).toBe("12:30 PM Nov 13");
  });
});

describe("spans", () => {
  it("words a wait", () => {
    expect(spanWords(2 * 3600_000 + 46 * 60_000 + 20_000)).toBe("2 h 46 min");
    expect(spanWords(46 * 60_000)).toBe("46 min");
    expect(spanWords(10_000)).toBe("under a minute");
    expect(spanWords(-5)).toBe("under a minute");
  });
  it("prints a pass length", () => {
    expect(passLength(62 * 60_000)).toBe("1 h 02");
    expect(passLength(44 * 60_000)).toBe("0 h 44");
  });
});

describe("tally", () => {
  it("counts outcomes in a fixed order", () => {
    expect(tally([unit(1, null, null, "partial"), unit(2, null, null, "done"), unit(3, null, null, "done")])).toBe("2 done, 1 partial");
    expect(tally([unit(1, null, null, null)])).toBe("1 running");
    expect(tally([])).toBe("");
  });
});

describe("passTrace", () => {
  it("places each pass on the shift's span", () => {
    const { rows, start, end } = passTrace([
      unit(1, "2026-11-09T23:00:00Z", "2026-11-10T00:00:00Z", "done"),
      unit(2, "2026-11-10T00:00:00Z", "2026-11-10T01:00:00Z", "partial"),
    ]);
    expect(end! - start!).toBe(2 * 3600_000);
    expect(rows[0]).toMatchObject({ n: "01", left: 0, width: 50, length: "1 h 00", outcome: "done" });
    expect(rows[1]).toMatchObject({ left: 50, width: 50, outcome: "partial" });
  });
  it("runs a live pass to now and draws no bar without a start", () => {
    const now = Date.parse("2026-11-10T01:00:00Z");
    const { rows } = passTrace([unit(1, "2026-11-10T00:00:00Z", null, null), unit(2, null, null, null)], now);
    expect(rows[0]).toMatchObject({ left: 0, width: 100, outcome: "running", length: "1 h 00" });
    expect(rows[1]).toMatchObject({ width: 0, length: "—" });
  });
});

describe("planRun", () => {
  it("keeps the plan's order and only the selected items", () => {
    const it = (id: string, kind: string, max_passes: number) => ({ id, kind, max_passes, title: id }) as Item;
    const out = planRun(
      [{ id: "b", selected: true }, { id: "a", selected: true }, { id: "c", selected: false }, { id: "gone", selected: true }],
      [it("a", "build", 2), it("b", "research", 3), it("c", "build", 1)],
    );
    expect(out.map((x) => `${x.id}·${x.kind}·${x.passes}`)).toEqual(["b·research·3", "a·build·2"]);
  });
});
