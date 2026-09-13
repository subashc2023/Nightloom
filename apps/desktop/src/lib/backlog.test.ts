import { describe, expect, it } from "vitest";
import { clockLabel, itemStatusPill, orderedBacklog, parseClockTime, untilFromTime } from "./nightshift";
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

  it("takes later today when the time is still ahead", () => {
    const now = new Date(2026, 8, 11, 22, 0, 0);
    expect(untilFromTime("23:30", now)).toBe("2026-09-11T23:30:00");
    expect(untilFromTime("22:00", now)).toBe("2026-09-12T22:00:00"); // not ahead: tomorrow
  });

  it("is the next occurrence after the START when a launch is held (review F7)", () => {
    // Typed at 06:00 for a launch held until 23:00 the same day: "7am" is
    // tomorrow's, sixteen hours after the launch -- not today's, before it.
    const start = new Date(2026, 8, 13, 23, 0, 0);
    expect(untilFromTime("7am", start)).toBe("2026-09-14T07:00:00");
  });

  it("reads typed times", () => {
    const now = new Date(2026, 8, 11, 23, 0, 0);
    expect(untilFromTime("7am", now)).toBe("2026-09-12T07:00:00");
    expect(untilFromTime("7:30 pm", now)).toBe("2026-09-12T19:30:00");
    expect(untilFromTime("0930", now)).toBe("2026-09-12T09:30:00");
  });
});

describe("parseClockTime", () => {
  it("reads the common spellings", () => {
    expect(parseClockTime("7am")).toEqual({ hh: 7, mm: 0 });
    expect(parseClockTime("12am")).toEqual({ hh: 0, mm: 0 });
    expect(parseClockTime("12pm")).toEqual({ hh: 12, mm: 0 });
    expect(parseClockTime("7:30pm")).toEqual({ hh: 19, mm: 30 });
    expect(parseClockTime("930")).toEqual({ hh: 9, mm: 30 });
    expect(parseClockTime("19")).toEqual({ hh: 19, mm: 0 });
    expect(parseClockTime("noon")).toEqual({ hh: 12, mm: 0 });
  });
  it("rejects what is not a time", () => {
    expect(parseClockTime("25")).toBeNull();
    expect(parseClockTime("13pm")).toBeNull();
    expect(parseClockTime("9:75")).toBeNull();
    expect(parseClockTime("soon")).toBeNull();
  });
  it("labels", () => {
    expect(clockLabel({ hh: 0, mm: 0 })).toBe("12am");
    expect(clockLabel({ hh: 19, mm: 30 })).toBe("7:30pm");
  });
});
