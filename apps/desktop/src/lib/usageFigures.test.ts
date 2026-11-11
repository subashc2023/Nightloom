import { describe, expect, it } from "vitest";
import { compactCount, duration, modelName, modelSplit, resetClock, spenderName, stackParts, usd } from "./usageFigures";

describe("item 569: /usage figures for the column", () => {
  it("prints durations the way /usage does", () => {
    expect(duration(2 * 3600_000 + 3 * 60_000 + 40_000)).toBe("2h 3m");
    expect(duration(22 * 60_000 + 26_000)).toBe("22m 26s");
    expect(duration(41_000)).toBe("41s");
    expect(duration(-5)).toBe("0s");
  });

  it("prints dollars to the cent", () => {
    expect(usd(64.031)).toBe("$64.03");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.001)).toBe("<$0.01");
  });

  it("names models as /usage does", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelName("other")).toBe("other");
  });

  it("splits the cost by model in whole percent", () => {
    const m = (model: string, cost_usd: number) => ({ model, cost_usd, input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(modelSplit([m("claude-opus-5-5", 9.96), m("claude-haiku-5-5", 0.04)])).toEqual([
      { name: "Opus 5.5", pct: 100 },
      { name: "Haiku 5.5", pct: 0 },
    ]);
    expect(modelSplit([m("claude-opus-5-5", 0)])).toEqual([]);
  });

  it("gives reset times in 12-hour form: today bare, this week with the day", () => {
    const now = new Date(2026, 10, 10, 13, 0).getTime();
    expect(resetClock(new Date(2026, 10, 10, 16, 30).toISOString(), now)).toBe("4:30 PM");
    expect(resetClock(new Date(2026, 10, 11, 2, 0).toISOString(), now)).toBe("Wed 2:00 AM");
    expect(resetClock(new Date(2026, 10, 20, 2, 0).toISOString(), now)).toBe("Nov 20 2:00 AM");
    expect(resetClock(null, now)).toBeNull();
    expect(resetClock("not a date", now)).toBeNull();
  });

  it("names spenders", () => {
    expect(spenderName({ who: "main", agents: 0 })).toBe("Main chat");
    expect(spenderName({ who: "general-purpose", agents: 3 })).toBe("general-purpose ×3");
    expect(spenderName({ who: "reusable", agents: 1 })).toBe("reusable");
  });
});

describe("compactCount (item 584)", () => {
  it("keeps every count to five characters at most", () => {
    expect(compactCount(206)).toBe("206");
    expect(compactCount(6_600)).toBe("6.6k");
    expect(compactCount(110_000)).toBe("110k");
    expect(compactCount(999_400)).toBe("999k");
    expect(compactCount(999_600)).toBe("1M");
    expect(compactCount(10_490_000)).toBe("10.5M");
    expect(compactCount(1_730_000)).toBe("1.7M");
    expect(compactCount(153_523_170)).toBe("154M");
    expect(compactCount(-3)).toBe("0");
    for (const n of [0, 999, 1_234, 99_949, 123_456_789, 9_999_999_999]) expect(compactCount(n).length).toBeLessThanOrEqual(5);
  });
});

describe("stackParts (item 584)", () => {
  it("splits by value, widths summing to one", () => {
    const p = stackParts([{ name: "Opus 5.5", value: 17.46 }, { name: "Haiku 5.5", value: 0.18 }]);
    expect(p.map((x) => x.pct)).toEqual([99, 1]);
    expect(p[0].share + p[1].share).toBeCloseTo(1);
  });
  it("is empty when nothing was spent", () => {
    expect(stackParts([{ name: "a", value: 0 }])).toEqual([]);
    expect(stackParts([])).toEqual([]);
  });
});
