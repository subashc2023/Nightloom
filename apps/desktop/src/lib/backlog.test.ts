import { describe, expect, it } from "vitest";
import { itemStatusPill, orderedBacklog, untilFromTime } from "./nightshift";
import type { Item } from "./types";

function item(id: string, status = "todo"): Item {
  return {
    id,
    file: `backlog/${id}.md`,
    path: `backlog/${id}.md`,
    title: `Item ${id}`,
    kind: "research",
    status,
    created: "",
    source: "manual",
    max_passes: 3,
    model: null,
    fields: {},
    preface: "",
    sections: [],
    progress: [],
    order: null,
  };
}

describe("orderedBacklog", () => {
  it("lists items in order.json's order, then unlisted ones after", () => {
    const items = [item("003"), item("001"), item("002")];
    const rows = orderedBacklog(items, ["002", "001"]);
    expect(rows.map((r) => r.item.id)).toEqual(["002", "001", "003"]);
    expect(rows.map((r) => r.order)).toEqual([1, 2, null]);
    expect(rows.map((r) => r.unlisted)).toEqual([false, false, true]);
  });

  it("skips an order.json id with no matching item", () => {
    const items = [item("001")];
    const rows = orderedBacklog(items, ["999", "001"]);
    expect(rows.map((r) => r.item.id)).toEqual(["001"]);
    expect(rows[0].order).toBe(2);
  });

  it("returns unlisted-only rows when order is empty", () => {
    const items = [item("001"), item("002")];
    const rows = orderedBacklog(items, []);
    expect(rows.every((r) => r.unlisted)).toBe(true);
    expect(rows.every((r) => r.order === null)).toBe(true);
  });
});

describe("itemStatusPill", () => {
  it("maps each backlog status to its pill class", () => {
    expect(itemStatusPill("done")).toBe("done");
    expect(itemStatusPill("in-progress")).toBe("live");
    expect(itemStatusPill("killed")).toBe("failed");
    expect(itemStatusPill("deferred")).toBe("grey");
    expect(itemStatusPill("todo")).toBe("grey");
    expect(itemStatusPill("")).toBe("grey");
  });
});

describe("untilFromTime", () => {
  it("returns tomorrow at the given time as YYYY-MM-DDTHH:MM:SS", () => {
    const now = new Date(2026, 8, 11, 23, 0, 0); // 2026-09-11 23:00 local
    expect(untilFromTime("10:00", now)).toBe("2026-09-12T10:00:00");
  });

  it("rolls the month/year over correctly", () => {
    const now = new Date(2026, 11, 31, 23, 0, 0); // 2026-12-31
    expect(untilFromTime("06:30", now)).toBe("2027-01-01T06:30:00");
  });

  it("returns null for an empty or unparseable time", () => {
    expect(untilFromTime("", new Date())).toBeNull();
    expect(untilFromTime("not-a-time", new Date())).toBeNull();
  });
});
