// Item 300, wave 8B F1: the drawer follows the finger (A8) and lists Recents
// and Projects in a stable order (A4, A23, A28).
import { describe, expect, it } from "vitest";
import { EDGE, FLICK, dragAxis, drawerX, fingerSpeed, settleOpen, type ChatRow, type ProjectRow } from "./client";
import { UNFILED, chatCount, lastActive, projectSummaries, recentRows } from "./recents";

const W = 340;

describe("the drawer follows the finger (A8)", () => {
  it("catches a thumb a little in from the edge", () => {
    expect(EDGE).toBeGreaterThanOrEqual(28);
  });

  it("decides the axis only past the slop, and by the larger move", () => {
    expect(dragAxis(3, 2)).toBeNull();
    expect(dragAxis(12, 4)).toBe("x");
    expect(dragAxis(-12, 4)).toBe("x");
    expect(dragAxis(4, 12)).toBe("y");
  });

  it("moves 1:1 with the finger from the first point, clamped to its travel", () => {
    expect(drawerX(0, W, false)).toBe(-W);
    expect(drawerX(12, W, false)).toBe(-W + 12);
    expect(drawerX(170, W, false)).toBe(-170);
    expect(drawerX(500, W, false)).toBe(0);
    expect(drawerX(-30, W, false)).toBe(-W);
    expect(drawerX(-60, W, true)).toBe(-60);
    expect(drawerX(40, W, true)).toBe(0);
    expect(drawerX(-900, W, true)).toBe(-W);
  });

  it("settles by position when slow, by direction when flicked", () => {
    expect(settleOpen(-W + 100, W, 0)).toBe(false);
    expect(settleOpen(-W + 200, W, 0)).toBe(true);
    // A short fast flick right opens; a fast flick left closes from anywhere.
    expect(settleOpen(-W + 40, W, FLICK + 0.1)).toBe(true);
    expect(settleOpen(-20, W, -FLICK - 0.1)).toBe(false);
    // Slow drift does not count as a flick.
    expect(settleOpen(-W + 40, W, 0.1)).toBe(false);
  });

  it("reads the finger's speed over its last samples", () => {
    expect(fingerSpeed([])).toBe(0);
    expect(fingerSpeed([{ t: 0, x: 0 }])).toBe(0);
    expect(fingerSpeed([{ t: 0, x: 0 }, { t: 50, x: 50 }, { t: 100, x: 100 }])).toBeCloseTo(1);
    // Only the last ~100 ms count: a long slow drag ending in a flick.
    const s = [{ t: 0, x: 0 }, { t: 1000, x: 48 }, { t: 1040, x: 88 }, { t: 1080, x: 128 }];
    expect(fingerSpeed(s)).toBeGreaterThan(0.5);
    // A slow drag whose finger stops before letting go.
    expect(fingerSpeed([{ t: 0, x: 0 }, { t: 250, x: 12 }, { t: 500, x: 24 }])).toBeLessThan(FLICK);
  });
});

const chat = (id: string, label: string, modified: string): ChatRow => ({ id, label, modified, user_turns: 1, kind: "build", mode: "normal" });
const projects: ProjectRow[] = [
  { id: UNFILED, name: "No project", active: true },
  { id: "t", name: "Thesis", active: false },
  { id: "g", name: "Garden Planner", active: false },
];

describe("Recents (A23, A28)", () => {
  it("lists every chat newest first with its project, whatever project the host has open", () => {
    const by = {
      [UNFILED]: [chat("u1", "Unfiled 1", "2026-10-04T19:00:00Z"), chat("u2", "Unfiled 2", "2026-10-04T10:00:00Z")],
      g: [chat("g1", "Tomato spacing", "2026-10-04T18:00:00Z")],
      t: [chat("t1", "Lit review", "2026-10-04T19:30:00Z")],
    };
    const rows = recentRows(projects, by);
    expect(rows.map((r) => r.chat.id)).toEqual(["t1", "u1", "g1", "u2"]);
    expect(rows.map((r) => r.project)).toEqual(["Thesis", null, "Garden Planner", null]);
    // The same list when the host's open project changes.
    const moved = projects.map((p) => ({ ...p, active: p.id === "g" }));
    expect(recentRows(moved, by).map((r) => r.chat.id)).toEqual(["t1", "u1", "g1", "u2"]);
  });

  it("a rename does not move a chat: Recents orders by his last message (300 B8)", () => {
    // Tomato spacing was renamed at 20:33 (the file's time) but last written in at 19:52.
    const renamed = { ...chat("g1", "Tomato rows", "2026-10-04T20:33:00Z"), last_message: "2026-10-04T19:52:00Z" };
    const by = { g: [renamed], t: [{ ...chat("t1", "Lit review", "2026-10-04T20:00:00Z"), last_message: "2026-10-04T20:00:00Z" }] };
    expect(recentRows(projects, by).map((r) => r.chat.id)).toEqual(["t1", "g1"]);
    expect(lastActive(renamed)).toBe("2026-10-04T19:52:00Z");
    // An older host sends no message time: the file's time, as before.
    expect(lastActive(chat("o", "old", "2026-10-04T18:00:00Z"))).toBe("2026-10-04T18:00:00Z");
  });

  it("drops a forgotten project's chats and keeps an old host's open list", () => {
    const by = { gone: [chat("x", "x", "2026-10-04T20:00:00Z")], g: [chat("g1", "a", "2026-10-04T18:00:00Z")] };
    expect(recentRows(projects, by).map((r) => r.chat.id)).toEqual(["g1"]);
    expect(recentRows([], { "": [chat("o", "old", "2026-10-04T18:00:00Z")] }).map((r) => r.pid)).toEqual([""]);
  });

  it("lists a chat once even when two keys hold it", () => {
    const c = chat("u1", "a", "2026-10-04T18:00:00Z");
    expect(recentRows(projects, { "": [c], [UNFILED]: [c] })).toHaveLength(1);
  });
});

describe("the Projects list (A4)", () => {
  it("has no No-project row, puts the most recently used first, and counts chats", () => {
    const by = { g: [chat("g1", "a", "2026-10-04T18:00:00Z"), chat("g2", "b", "2026-10-04T19:00:00Z")], t: [] };
    const s = projectSummaries(projects, by);
    expect(s.map((p) => p.id)).toEqual(["g", "t"]);
    expect(s[0]).toMatchObject({ chats: 2, last: "2026-10-04T19:00:00Z" });
    expect(s[1]).toMatchObject({ chats: 0, last: null });
    expect(projectSummaries(projects, {}).map((p) => p.chats)).toEqual([null, null]);
  });

  it("says 1 chat, not 1 chats", () => {
    expect(chatCount(1)).toBe("1 chat");
    expect(chatCount(0)).toBe("0 chats");
    expect(chatCount(3)).toBe("3 chats");
  });
});
