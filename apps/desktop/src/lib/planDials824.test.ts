import { describe, expect, it } from "vitest";
import topBar from "./TopBar.svelte?raw";
import topBarClassic from "./TopBarClassic.svelte?raw";
import planDialsSrc from "./PlanDials.svelte?raw";
import remote from "../remote/Remote.svelte?raw";
import { contextPct, dialWindow, pastStop, projected, resetShort, ringArcs, staleTag, stopLine, tickAt, tokens } from "./planDials";
import type { WindowPace } from "./types";

/**
 * Item 824 (blocker 2123: B Dials; 2136: the whole popover): the Context
 * and Plan card is three dials with no sentence — the projected percent at
 * the reset a ghost arc, his stop line a tick from his setting.
 */
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
const pace = (over: Partial<WindowPace> = {}): WindowPace => ({
  window: "five_hour",
  pct: 82,
  at_ms: NOW,
  resets_at_ms: null,
  ready: true,
  at80_ms: null,
  at100_ms: null,
  end_pct: 91.4,
  horizon_hours: 1,
  backtest: { err_pts: 10, linear_err_pts: 12, checks: 189 },
  readings: 400,
  history_hours: 300,
  ...over,
});

describe("824: the dials' figures", () => {
  it("reads the stop line from his setting, none when switched off", () => {
    expect(stopLine({ stop_at: 95, off: { stop_at: false } })).toBe(95);
    expect(stopLine({ stop_at: 85 })).toBe(85);
    expect(stopLine({ stop_at: 95, off: { stop_at: true } })).toBeNull();
    expect(stopLine(null)).toBeNull();
    expect(stopLine({ stop_at: 255 })).toBeNull();
  });

  it("projects the reset only from a ready pace, and only above now", () => {
    expect(projected(pace(), 82)).toBe(91);
    expect(projected(pace({ end_pct: 140 }), 82)).toBe(100);
    expect(projected(pace({ ready: false }), 82)).toBeNull();
    expect(projected(pace({ end_pct: 80 }), 82)).toBeNull();
    expect(projected(null, 82)).toBeNull();
  });

  it("shortens the reset to a time, a day and time, or a dash", () => {
    const today = new Date(2026, 10, 18, 16, 29).toISOString();
    const wed = new Date(2026, 10, 25, 1, 59).toISOString();
    expect(resetShort(today, NOW)).toBe("4:29 PM");
    expect(resetShort(wed, NOW)).toBe("Wed 1:59 AM");
    expect(resetShort(null, NOW)).toBe("—");
  });

  it("builds a window's dial; none without a reading", () => {
    expect(dialWindow(82, null, pace(), NOW)).toEqual({ pct: 82, proj: 91, reset: "—" });
    expect(dialWindow(null, null, pace(), NOW)).toBeNull();
  });

  it("tags a stale reading with its age, nothing while fresh", () => {
    expect(staleTag({ stale: true, sampled_at_ms: NOW - 34 * 60_000, age_seconds: null }, NOW)).toBe("34m old");
    expect(staleTag({ stale: true, sampled_at_ms: null, age_seconds: 7200 }, NOW)).toBe("2h old");
    expect(staleTag({ stale: false, sampled_at_ms: NOW - 60_000, age_seconds: null }, NOW)).toBeNull();
    expect(staleTag(null, NOW)).toBeNull();
  });

  it("draws the arcs: used, then the projected ghost after it", () => {
    const a = ringArcs(50, 75);
    const C = 2 * Math.PI * 30;
    expect(a.now).toBe(`${(C / 2).toFixed(2)} ${C.toFixed(2)}`);
    expect(a.ghost).toBe(`0 ${(C / 2).toFixed(2)} ${(C / 4).toFixed(2)} ${C.toFixed(2)}`);
    expect(ringArcs(0, null)).toEqual({ now: null, ghost: null });
    expect(ringArcs(60, 40).ghost).toBeNull();
  });

  it("puts the tick at the stop line, clockwise from the top", () => {
    expect(tickAt(0)).toEqual({ x1: 37, y1: 13, x2: 37, y2: 1 });
    expect(tickAt(25)).toEqual({ x1: 61, y1: 37, x2: 73, y2: 37 });
  });

  it("formats tokens and the context percent; unknown window is no percent", () => {
    expect(tokens(172_431)).toBe("172k");
    expect(tokens(1_000_000)).toBe("1M");
    expect(tokens(840)).toBe("840");
    expect(contextPct({ used: 172_431, limit: 1_000_000, estimated: false, agents: 0 })).toBe(17);
    expect(contextPct({ used: 5, limit: null, estimated: false, agents: 0 })).toBeNull();
    expect(pastStop(96, 95)).toBe(true);
    expect(pastStop(96, null)).toBe(false);
  });
});

describe("824: every surface shows the dials", () => {
  it("the Jarvis bar's card (main chat and asides) is PlanDials, no pace sentence or source foot", () => {
    expect(topBar).toMatch(/<PlanDials\s+figures=\{dialFigures\}/);
    expect(topBar).not.toMatch(/paceCardLine\(|\{planWhere\}|class="gc-foot"/);
    expect(topBar).toMatch(/stop: stopLine\(app\.draft\.agentLimits\)/);
    expect(topBar).toMatch(/label: "Itemise chat", onclick: \(\) => void itemiseChat\(\)/);
  });

  it("Classic's card is PlanDials too", () => {
    expect(topBarClassic).toMatch(/<PlanDials figures=\{dialFigures\}/);
    expect(topBarClassic).not.toMatch(/paceCardLine\(|\{planWhere\}|class="gc-foot"/);
    expect(topBarClassic).toMatch(/stop: stopLine\(app\.draft\.agentLimits\)/);
  });

  it("the phone opens the dials as a sheet from the header's dial and the context row", () => {
    expect(remote).toMatch(/\| "dials"/);
    expect(remote).toMatch(/<button class="hdr-dial" onclick=\{openDials\}/);
    expect(remote).toMatch(/else openDials\(\);/);
    expect(remote).toMatch(/\{:else if sheet === "dials"\}\s*<PlanDials/);
    expect(remote).toMatch(/stop: stopLine\(rail\?\.limits\)/);
  });

  it("the card's template carries labels only: no text run longer than four words", () => {
    const template = planDialsSrc.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const runs = [...template.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean);
    for (const r of runs) expect(r.split(/\s+/).length, r).toBeLessThanOrEqual(4);
  });
});
