import { describe, expect, it } from "vitest";
import { pruneRouteDrafts, readRouteDrafts, routeChoices, routeText, routeWhere, routeWhy, withRouteDraft, type HomeRoute } from "./homeRoutes";

const route = (over: Partial<HomeRoute> = {}): HomeRoute => ({
  id: "r1",
  at: "2026-11-18T12:00:00Z",
  kind: "start",
  project: "p1",
  project_name: "Nightloom",
  chat: null,
  label: null,
  prompt: "Fix the tab-drag bug.",
  write: true,
  state: "waiting",
  hold: "write",
  cold: null,
  note: null,
  ...over,
});

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("item 763 H5: Start cards", () => {
  it("says which project and chat the work goes to", () => {
    expect(routeWhere(route())).toBe("a new chat in Nightloom");
    expect(routeWhere(route({ kind: "send", label: "778 fix", project_name: "Nightshift" }))).toBe("“778 fix” in Nightshift");
  });

  it("a write-capable start has one Start button and says why it waits", () => {
    expect(routeChoices(route())).toEqual([{ pick: null, label: "Start" }]);
    expect(routeWhy(route())).toContain("starts only when you tap");
    expect(routeChoices(route({ kind: "send" }))[0].label).toBe("Send");
  });

  it("a cold card offers the two picks with their costs, the new chat first, and no plain Start", () => {
    const cold = route({ kind: "send", hold: "cold", write: false, label: "778 fix", cold: { tokens: 300_100, into_usd: 2.4008, new_usd: 0.256 } });
    expect(routeChoices(cold)).toEqual([
      { pick: "new", label: "New chat in Nightloom ≈ $0.26" },
      { pick: "into", label: "Send into it anyway ≈ $2.4" },
    ]);
    expect(routeWhy(cold)).toBe("300k and its cache is cold — sending re-writes all of it");
    const unpriced = route({ hold: "cold", cold: { tokens: 200_000, into_usd: null, new_usd: null } });
    expect(routeChoices(unpriced).map((c) => c.label)).toEqual(["New chat in Nightloom", "Send into it anyway"]);
  });

  it("his edit is a draft kept per card across a restart, dropped only when he asks or the card is gone", () => {
    const s = mem();
    let d = withRouteDraft({}, "r1", "Fix it, and run the tests.", s);
    expect(routeText(route(), d)).toBe("Fix it, and run the tests.");
    expect(readRouteDrafts(s)).toEqual({ r1: "Fix it, and run the tests." });
    d = withRouteDraft(d, "r2", "other", s);
    // r2's card was answered on the phone: its draft goes; r1's stays.
    d = pruneRouteDrafts(d, [route()], s);
    expect(readRouteDrafts(s)).toEqual({ r1: "Fix it, and run the tests." });
    d = withRouteDraft(d, "r1", null, s);
    expect(routeText(route(), d)).toBe("Fix the tab-drag bug.");
    expect(s.m.size).toBe(0);
    s.m.set("nightloom.home.routeDrafts", "not json");
    expect(readRouteDrafts(s)).toEqual({});
  });
});
