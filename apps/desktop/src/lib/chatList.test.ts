import { describe, expect, it } from "vitest";
import { clock12, ctxLook, ctxText, dayOf, daySections, liveClock, rowClock, toolCount } from "./chatList";
import { chatContext, contextOf, noteChatContext, parseReadings, writeReadings } from "./chatContext.svelte";
import type { SidebarRow } from "./forkTree";
import type { SessionMeta } from "./types";

// Item 534: the chat list's dated sections, row clock, context reading, live line.
const NOW = new Date(2026, 10, 9, 21, 30).getTime(); // Mon Nov 9 2026, 9:30 PM local
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
const row = (id: string, modified: string, depth = 0): SidebarRow => ({
  meta: { id, path: "", modified, user_turns: 1, first_user: null, title: id } as SessionMeta,
  depth,
  forks: 0,
  expanded: false,
});

describe("dayOf", () => {
  it("puts a time under today, yesterday, the previous 7 days or earlier", () => {
    expect(dayOf(at(2026, 10, 9, 0, 1), NOW)).toBe("today");
    expect(dayOf(at(2026, 10, 8, 23, 59), NOW)).toBe("yesterday");
    expect(dayOf(at(2026, 10, 8, 0, 0), NOW)).toBe("yesterday");
    expect(dayOf(at(2026, 10, 3), NOW)).toBe("week");
    expect(dayOf(at(2026, 10, 1), NOW)).toBe("earlier");
  });
  it("counts an unreadable or future time as today", () => {
    expect(dayOf("nonsense", NOW)).toBe("today");
    expect(dayOf(at(2026, 10, 12), NOW)).toBe("today");
  });
});

describe("daySections", () => {
  it("cuts the list in day order, counts top-level chats, keeps a fork under its origin", () => {
    const rows = [
      row("a", at(2026, 10, 9, 20)),
      row("b", at(2026, 10, 8, 10)),
      // A fork touched today under an origin from yesterday: stays with it.
      row("b1", at(2026, 10, 9, 21), 1),
      row("c", at(2026, 9, 1)),
      row("d", at(2026, 10, 9, 8)),
    ];
    const s = daySections(rows, NOW);
    expect(s.map((x) => [x.label, x.count, x.rows.map((r) => r.meta.id).join(",")])).toEqual([
      ["Today", 2, "a,d"],
      ["Yesterday", 1, "b,b1"],
      ["Earlier", 1, "c"],
    ]);
  });
  it("is empty for no rows", () => {
    expect(daySections([], NOW)).toEqual([]);
  });
});

describe("clocks", () => {
  it("always writes the 12-hour clock", () => {
    expect(clock12(new Date(2026, 0, 1, 0, 5).getTime())).toBe("12:05 AM");
    expect(clock12(new Date(2026, 0, 1, 12, 0).getTime())).toBe("12:00 PM");
    expect(clock12(new Date(2026, 0, 1, 14, 10).getTime())).toBe("2:10 PM");
  });
  it("shortens a row's time to its heading", () => {
    expect(rowClock(at(2026, 10, 9, 14, 10), NOW)).toBe("2:10 PM");
    expect(rowClock(at(2026, 10, 8, 9, 20), NOW)).toBe("9:20 AM");
    expect(rowClock(at(2026, 10, 5, 18, 5), NOW)).toBe("Thu 6:05 PM");
    expect(rowClock(at(2026, 9, 3), NOW)).toBe("Oct 3");
    expect(rowClock(at(2025, 9, 3), NOW)).toBe("Oct 3, 2025");
    expect(rowClock("x", NOW)).toBe("");
  });
  it("writes the live timer as m:ss or h:mm:ss", () => {
    expect(liveClock(41_000)).toBe("0:41");
    expect(liveClock(725_000)).toBe("12:05");
    expect(liveClock(3_729_000)).toBe("1:02:09");
    expect(liveClock(-5)).toBe("0:00");
  });
});

describe("context reading", () => {
  it("writes the size as the mockup does", () => {
    expect(ctxText(840)).toBe("840");
    expect(ctxText(84_400)).toBe("84k");
    expect(ctxText(212_000)).toBe("212k");
    expect(ctxText(1_200_000)).toBe("1.2M");
  });
  it("says the share and whether it is past the hand-off mark", () => {
    expect(ctxLook(402_000, 1_000_000, 0.3)).toEqual({ fill: 0.402, past: true });
    expect(ctxLook(84_000, 1_000_000, 0.3)).toEqual({ fill: 0.084, past: false });
    expect(ctxLook(84_000, 0, 0.3)).toBeNull();
    expect(ctxLook(2_000_000, 1_000_000, 0.7)).toEqual({ fill: 1, past: true });
  });
  it("counts the live reply's tool calls", () => {
    expect(toolCount([{ kind: "tool" }, { kind: "text" }, { kind: "tool" }])).toBe(2);
    expect(toolCount(null)).toBe(0);
  });
});

describe("chatContext", () => {
  it("reads back what it wrote and drops malformed entries", () => {
    const raw = writeReadings({ a: { used: 5, limit: 10 }, b: { used: 7, limit: 0 } });
    expect(parseReadings(raw)).toEqual({ a: { used: 5, limit: 10 }, b: { used: 7, limit: 0 } });
    expect(parseReadings('{"a":[1,2],"b":"x","c":[-1,2],"d":[3]}')).toEqual({ a: { used: 1, limit: 2 } });
    expect(parseReadings("not json")).toEqual({});
    expect(parseReadings(null)).toEqual({});
  });
  it("keeps the newest readings under the cap", () => {
    const raw = writeReadings({ a: { used: 1, limit: 1 }, b: { used: 2, limit: 1 }, c: { used: 3, limit: 1 } }, 2);
    expect(Object.keys(parseReadings(raw))).toEqual(["b", "c"]);
  });
  it("notes a reading, keeps a known window when a reading brings none, ignores no reading", () => {
    noteChatContext("x1", 1000, 200_000);
    expect(contextOf("x1")).toEqual({ used: 1000, limit: 200_000 });
    noteChatContext("x1", 5000, 0);
    expect(contextOf("x1")).toEqual({ used: 5000, limit: 200_000 });
    noteChatContext("x1", null, 200_000);
    noteChatContext(null, 10, 10);
    expect(contextOf("x1")).toEqual({ used: 5000, limit: 200_000 });
    expect(Object.keys(chatContext)).toContain("x1");
    expect(contextOf("nope")).toBeNull();
  });
});
