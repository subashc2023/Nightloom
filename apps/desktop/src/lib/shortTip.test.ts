import { describe, expect, it } from "vitest";
import { fit, gaugeChipTip, lossClick, lossTipText, planReadingTip, TIP_MAX, windowTip } from "./shortTip";
import type { CacheChange } from "./cache";
import type { PlanPace, WindowPace } from "./types";

const NOW = new Date(2026, 10, 16, 23, 47).getTime();
const H = 3_600_000;
const bt = { err_pts: 8.7, linear_err_pts: 11.2, checks: 148 };
const win = (window: WindowPace["window"], pct: number, o: Partial<WindowPace> = {}): WindowPace => ({
  window, pct, at_ms: NOW, resets_at_ms: NOW + 2.5 * H, ready: true, at80_ms: null, at100_ms: null, end_pct: 58,
  horizon_hours: window === "five_hour" ? 1 : 24, backtest: bt, readings: 2964, history_hours: 170, ...o,
});
const pace = (fh: WindowPace | null, sd: WindowPace | null): PlanPace => ({ five_hour: fh, seven_day: sd, computed_at_ms: NOW });
const lines = (s: string) => s.split("\n");
const short = (s: string) => {
  for (const l of lines(s)) expect(l.length, l).toBeLessThanOrEqual(TIP_MAX);
};

describe("post-install 16c8e01: every cache/cost/plan tip is two lines of ≤ 44 characters", () => {
  it("fit keeps the first part and adds the rest while they fit", () => {
    expect(fit(["a", "b", null, "c"])).toBe("a · b · c");
    expect(fit(["x".repeat(40), "yyyy", "z"])).toBe("x".repeat(40));
    expect(fit(["x".repeat(38), "y", "zzzzz"])).toBe(`${"x".repeat(38)} · y`);
  });

  it("the plan reading: one line per window, numbers first, the 80% line as 'wrap up'", () => {
    const cases: [number, number, PlanPace | null][] = [
      [62, 84, pace(win("five_hour", 62, { at80_ms: NOW + 50 * 60_000, at100_ms: NOW + 110 * 60_000 }), win("seven_day", 84, { at100_ms: NOW + 30 * H }))],
      [100, 100, pace(win("five_hour", 100, { at100_ms: NOW }), win("seven_day", 100, { at100_ms: NOW + 50 * H }))],
      [9, 39, pace(win("five_hour", 9), win("seven_day", 39, { at80_ms: NOW + 40 * H, at100_ms: NOW + 60 * H }))],
      [9, 39, pace(win("five_hour", 9, { ready: false }), win("seven_day", 39, { ready: false }))],
      [9, 39, null],
    ];
    for (const [fh, sd, p] of cases) {
      const t = planReadingTip({ five_hour: fh, seven_day: sd }, p, NOW);
      expect(lines(t)).toHaveLength(2);
      short(t);
      expect(lines(t)[0]).toMatch(new RegExp(`^5-hour ${fh}%`));
      expect(lines(t)[1]).toMatch(new RegExp(`^Week ${sd}%`));
    }
    const hot = planReadingTip({ five_hour: 62, seven_day: 84 }, cases[0][2], NOW);
    expect(lines(hot)[0]).toMatch(/^5-hour 62% · 80% \d+:\d\d [AP]M · empty \d+:\d\d [AP]M$/);
    expect(lines(hot)[1]).toMatch(/^Week 84%: wrap up · empty /);
    expect(planReadingTip({ five_hour: 62, seven_day: null }, null, NOW)).toBe("5-hour 62%");
    expect(windowTip("Week", 39, win("seven_day", 39, { ready: false }), NOW)).toBe("Week 39% · learning pace (148 checks)");
  });

  it("the gauge chip: context and spend, then the plan's figures", () => {
    const variants = [
      gaugeChipTip({ context: "Context 270k of 1M (27%)", spend: "$4.10", plan: { five_hour: 62, seven_day: 84 } }),
      gaugeChipTip({ context: "About 1.0M of 1.0M (100%)", spend: "≥ $1,234.56", plan: { five_hour: 100, seven_day: 100 } }),
      gaugeChipTip({ context: "Context 12k · window unknown", spend: null, plan: null }),
      gaugeChipTip({ context: null, plan: { five_hour: 3, seven_day: null } }),
    ];
    for (const v of variants) {
      expect(lines(v)).toHaveLength(2);
      short(v);
    }
    expect(variants[0]).toBe("Context 270k of 1M (27%) · spent $4.10\n5-hour 62% · week 84% · wrap up");
    expect(lines(gaugeChipTip({ context: "Context 270k of 1M (27%)", plan: { five_hour: 9, seven_day: 39 } }))[1]).toBe("5-hour 9% · week 39% · click for figures");
    expect(lines(variants[2])[1]).toBe("Click for the figures · ⌘⇧C itemises them");
  });

  const model: CacheChange = { what: "model", text: "model fable → claude-opus-5-5", whole: true };
  const tools: CacheChange = { what: "tools", text: "tools off", whole: false };
  const kind: CacheChange = { what: "kind", text: "Chat → Claude Code", whole: true, restorable: false };

  it("the cache-lost bar's click line never promises an undo the click cannot do", () => {
    expect(lossClick([model], false)).toBe("Click to put it back");
    expect(lossClick([model, tools], false)).toBe("Click to put them back");
    expect(lossClick([model], true)).toBe("Click undoes the settings, not the layers");
    expect(lossClick([], true)).toBe("The Context page puts them back");
    expect(lossClick([kind], false)).toBe("Nothing to click: Chat → Claude Code stays");
    expect(lossClick([kind], true)).toBe("Nothing to click; layers: the Context page");
    expect(lossClick([model, kind], false)).toBe("Click undoes all but Chat → Claude Code");
    expect(lossClick([model, kind], true)).toBe("Click undoes some settings, not the layers");
    for (const c of [[model], [model, tools], [kind], [model, kind], []] as CacheChange[][])
      for (const layer of [false, true]) if (c.length || layer) expect(lossClick(c, layer).length).toBeLessThanOrEqual(TIP_MAX);
  });

  it("the cache-lost bar's tip: the price first, two short lines, priced or not", () => {
    expect(lossTipText({ changes: [model], layer: true, cachedTokens: 270_000, priceLine: "next ≈ $2.70 (vs $0.37 warm)" })).toBe(
      "Next ≈ $2.70 (vs $0.37 warm)\nClick undoes the settings, not the layers",
    );
    const all = [
      lossTipText({ changes: [model, tools], layer: true, cachedTokens: 999_000, priceLine: "next ≈ $12.40 (vs $1.20 warm)" }),
      lossTipText({ changes: [tools], layer: false, cachedTokens: 270_000, resendUsd: 4.32 }),
      lossTipText({ changes: [], layer: true, cachedTokens: 1_000_000, resendUsd: 123.45 }),
      lossTipText({ changes: [model], layer: false, cachedTokens: 270_000, priceLine: "re-writes 270k · no price for the new model" }),
    ];
    for (const t of all) {
      expect(lines(t)).toHaveLength(2);
      short(t);
    }
    expect(lines(all[1])[0]).toBe("Next send re-sends up to 270k (≈ $4.32)");
  });
});
