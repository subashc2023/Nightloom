import { describe, expect, it } from "vitest";
import {
  USAGE_PANE,
  canonicalPane,
  groupKey,
  readStamp,
  refreshUsageAndCost,
  settingsGroups,
} from "./settingsUsage";

describe("the merged Usage · Cost nav (backlog 153)", () => {
  const groups = settingsGroups(["anthropic", "openai"], ["brave"]);

  it("has one Usage · Cost group at the top and no Cost pane", () => {
    expect(groups[0]).toEqual({ title: "Usage · Cost", panes: [USAGE_PANE] });
    const all = groups.flatMap((g) => g.panes);
    expect(all).not.toContain("cost");
    expect(all.filter((p) => p === USAGE_PANE)).toHaveLength(1);
    expect(groups.map((g) => g.title)).not.toContain("Cost");
  });

  it("keeps his order after the merge, one ⌘-digit per group", () => {
    expect(groups.map((g) => g.title)).toEqual([
      "Usage · Cost",
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

  it("opens a remembered or requested Cost pane on the merged pane", () => {
    expect(canonicalPane("cost")).toBe(USAGE_PANE);
    expect(canonicalPane("usage")).toBe(USAGE_PANE);
    expect(canonicalPane("remote")).toBe("remote");
  });
});

describe("Refresh now refreshes both halves (backlog 153)", () => {
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
