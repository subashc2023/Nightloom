import { describe, expect, it } from "vitest";
import {
  COST_PANE,
  USAGE_COST_GROUP,
  USAGE_PANE,
  canonicalPane,
  groupKey,
  openingPane,
  readStamp,
  refreshUsageAndCost,
  settingsGroups,
} from "./settingsUsage";

describe("Usage & Cost: two tabs under one category (backlog 206)", () => {
  const groups = settingsGroups(["anthropic", "openai"], ["brave"]);

  it("has one Usage & Cost category at the top with a Usage tab and a Cost tab", () => {
    expect(groups[0]).toEqual({ title: USAGE_COST_GROUP, panes: [USAGE_PANE, COST_PANE] });
    expect(USAGE_COST_GROUP).toBe("Usage & Cost");
    const all = groups.flatMap((g) => g.panes);
    expect(all.filter((p) => p === USAGE_PANE)).toHaveLength(1);
    expect(all.filter((p) => p === COST_PANE)).toHaveLength(1);
    // Neither tab is a category of its own (127's shape), nor one page (153's).
    expect(groups.map((g) => g.title)).not.toContain("Cost");
    expect(groups.map((g) => g.title)).not.toContain("Usage");
    expect(groups.map((g) => g.title)).not.toContain("Usage · Cost");
  });

  it("keeps his order, one ⌘-digit per category", () => {
    expect(groups.map((g) => g.title)).toEqual([
      "Usage & Cost",
      "Subscription",
      "Knowledge",
      "Projects",
      "Providers",
      "Web search",
      "Appearance",
      "Remote",
    ]);
    expect(groups.map((g) => groupKey(groups, g.title))).toEqual(["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘6", "⌘7", "⌘8"]);
    expect(groupKey(groups, "Cost")).toBe("");
  });

  it("carries the providers and backends as panes", () => {
    expect(groups[4].panes).toEqual(["anthropic", "openai"]);
    expect(groups[5].panes).toEqual(["search:brave"]);
  });

  it("opens on the top pane when nothing was asked or left within two minutes (backlog 109)", () => {
    // The walk of 2026-09-25 saw Providers → Anthropic here: the fallback
    // was the rail's provider. It is the nav's first row.
    expect(openingPane(null, null)).toBe(groups[0].panes[0]);
    expect(openingPane(undefined, null)).toBe(USAGE_PANE);
    expect(openingPane(null, "knowledge")).toBe("knowledge");
    expect(openingPane("models", "knowledge")).toBe("models");
    expect(openingPane(null, "cost")).toBe(COST_PANE);
  });

  it("reopens a remembered Cost tab on the Cost tab, not on Usage", () => {
    expect(canonicalPane("cost")).toBe(COST_PANE);
    expect(canonicalPane("usage")).toBe(USAGE_PANE);
    expect(canonicalPane("remote")).toBe("remote");
  });
});

describe("Refresh now refreshes both tabs (backlog 153, kept by 206)", () => {
  const at = new Date(2026, 8, 24, 14, 5);

  it("runs the collector, the plan and the credits once each, and stamps the read", async () => {
    const calls: string[] = [];
    const r = await refreshUsageAndCost({
      ledger: async () => {
        calls.push("ledger");
        return { available: true };
      },
      plan: async () => {
        calls.push("plan");
      },
      credits: async () => {
        calls.push("credits");
      },
      now: () => at,
    });
    expect(calls.sort()).toEqual(["credits", "ledger", "plan"]);
    expect(r.usage).toEqual({ available: true });
    expect(r.error).toBeNull();
    expect(r.ledgerReadAt).toBe(at);
    expect(r.readAt).toBe(at);
  });

  it("a failed collector keeps the gauges' and credits' refresh and reports the error", async () => {
    const calls: string[] = [];
    const r = await refreshUsageAndCost({
      ledger: async () => {
        throw new Error("collector exited 1");
      },
      plan: async () => {
        calls.push("plan");
      },
      credits: async () => {
        calls.push("credits");
      },
      now: () => at,
    });
    expect(calls.sort()).toEqual(["credits", "plan"]);
    expect(r.usage).toBeNull();
    expect(r.error).toContain("collector exited 1");
    expect(r.ledgerReadAt).toBeNull();
    expect(r.readAt).toBe(at);
  });

  it("says when nothing has been read yet", () => {
    expect(readStamp(null)).toBe("not read yet");
    expect(readStamp(at)).toMatch(/^read /);
  });
});
