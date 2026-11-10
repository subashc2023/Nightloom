import { describe, expect, it } from "vitest";
import { approxTokens, blendSizes, drawnGroups, easeOut, startArcs, startGroups, startSummary } from "./startDial";
import type { StartContext } from "./api";

const ctx: StartContext = {
  total: 34_000,
  parts: [
    { name: "Claude Code's prompt and tools", kind: "claude_code", tokens: 27_000, approx: true },
    { name: "Memory", kind: "layer", layer: "user_memory", tokens: 1_200, approx: true },
    { name: "Engine note", kind: "layer", layer: "engine_note", tokens: 2_100, approx: true },
    { name: "Notes index", kind: "layer", layer: "project_notes", tokens: 0, approx: true },
    { name: "Folder's CLAUDE.md / AGENTS.md", kind: "instructions", tokens: 700, approx: true },
    { name: "Your CLAUDE.md", kind: "instructions", tokens: 300, approx: true },
  ],
};

describe("the new-chat dial's starting context (item 574)", () => {
  it("gathers the parts into groups in drawing order, naming the members on hover", () => {
    const g = startGroups(ctx);
    expect(g.map((x) => x.tone)).toEqual(["claude_code", "layer", "instructions"]);
    expect(g.map((x) => x.tokens)).toEqual([27_000, 3_300, 1_000]);
    expect(g[1].tip).toBe("Nightloom's prompt layers ≈ 3.3k — Memory 1.2k · Engine note 2.1k");
    expect(g[0].tip).toContain("measured from your last chat");
    expect(startSummary(g).split("\n")).toHaveLength(3);
    expect(startGroups(null)).toEqual([]);
  });

  it("lays the groups end to end as shares of the window", () => {
    const g = startGroups(ctx);
    const a = startArcs(g, [27_000, 3_300, 1_000], 1_000_000);
    expect(a[0]).toMatchObject({ from: 0, share: 0.027 });
    expect(a[1].from).toBeCloseTo(0.027);
    expect(a[2].from).toBeCloseTo(0.0303);
    expect(startArcs(g, [1, 2, 3], null)).toEqual([]);
  });

  it("tweens: a new group grows from nothing and a leaving one closes up", () => {
    const g = startGroups(ctx);
    const from = new Map([["claude_code", 27_000], ["memory", 400]] as const);
    const mid = blendSizes(from, g, 0.5);
    expect(mid.get("layer")).toBe(1_650);
    expect(mid.get("memory")).toBe(200);
    const end = blendSizes(from, g, 1);
    expect(end.get("memory")).toBe(0);
    const leaving = [{ tone: "memory" as const, name: "Claude Code memory", tokens: 400, tip: "" }];
    expect(drawnGroups(mid, g, leaving).groups.map((x) => x.tone)).toContain("memory");
    expect(drawnGroups(end, g, leaving).groups.map((x) => x.tone)).not.toContain("memory");
  });

  it("eases out and says every figure is an estimate", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(approxTokens(34_200)).toBe("≈ 34k");
  });
});
