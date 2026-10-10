import { describe, expect, it } from "vitest";
import { capsLine, fmtElapsed, groupAgents, rowElapsedMs, rowState, stateLabel, summaryLine } from "./taskGroups";

type R = { id: string; status: string; turn: number; startedAt: number };
const r = (id: string, status: string, turn: number, startedAt: number): R => ({ id, status, turn, startedAt });

// The fixture he described (267): 18 rows over three sends, the chip's send
// (turn 3) with 3 running and 3 done, one failed earlier.
function fixture(): R[] {
  const out: R[] = [];
  let t = 0;
  for (let turn = 1; turn <= 3; turn++) {
    for (let i = 0; i < 6; i++) {
      const status = turn === 3 && i % 2 === 0 ? "running" : turn === 1 && i === 4 ? "failed" : "completed";
      out.push(r(`${turn}-${i}`, status, turn, (t += 10)));
    }
  }
  return out;
}

describe("groupAgents (267)", () => {
  it("puts every row in exactly one group and the counts add up", () => {
    const g = groupAgents(fixture());
    const placed = [...g.running, ...g.latest.rows, ...g.earlier.flatMap((b) => b.rows)];
    expect(placed).toHaveLength(18);
    expect(new Set(placed.map((x) => x.id)).size).toBe(18);
    expect(g.counts).toEqual({ total: 18, running: 3, finished: 15, failed: 1, earlier: 12 });
    expect(g.running.length + g.latest.rows.length + g.counts.earlier).toBe(g.counts.total);
  });

  it("the latest send's groups make the chip's count", () => {
    const g = groupAgents(fixture());
    expect(g.latest.turn).toBe(3);
    expect(g.latest.total).toBe(6);
    expect(g.running.length + g.latest.rows.length).toBe(g.latest.total);
  });

  it("orders newest first, and earlier sends one block each, newest send first", () => {
    const g = groupAgents(fixture());
    expect(g.running.map((x) => x.id)).toEqual(["3-4", "3-2", "3-0"]);
    expect(g.latest.rows.map((x) => x.id)).toEqual(["3-5", "3-3", "3-1"]);
    expect(g.earlier.map((b) => b.turn)).toEqual([2, 1]);
    expect(g.earlier[1].rows[0].id).toBe("1-5");
  });

  it("an agent still running from an older send is under Running, not Earlier", () => {
    const g = groupAgents([r("a", "running", 1, 1), r("b", "completed", 2, 2)]);
    expect(g.running.map((x) => x.id)).toEqual(["a"]);
    expect(g.latest.rows.map((x) => x.id)).toEqual(["b"]);
    expect(g.earlier).toEqual([]);
  });

  it("log-rebuilt turns (far negative) order among themselves", () => {
    const g = groupAgents([r("old", "completed", -999_999, 5), r("older", "completed", -1_000_000, 9)]);
    expect(g.latest.turn).toBe(-999_999);
    expect(g.earlier.map((b) => b.turn)).toEqual([-1_000_000]);
  });

  it("no rows: empty groups", () => {
    const g = groupAgents([]);
    expect(g.latest).toEqual({ turn: null, rows: [], total: 0 });
    expect(g.counts.total).toBe(0);
  });
});

describe("states and words", () => {
  it("maps the CLI's statuses", () => {
    expect(rowState({ status: "running" })).toBe("running");
    expect(rowState({ status: "completed" })).toBe("done");
    expect(rowState({ status: "no result" })).toBe("failed");
    expect(stateLabel({ status: "no result" })).toBe("no result");
    expect(stateLabel({ status: "completed" })).toBe("done");
  });

  it("summary line says what the groups say", () => {
    const g = groupAgents(fixture());
    expect(summaryLine(g.counts, 2)).toBe("2 chats running · 18 agents · 3 running · 15 finished (1 failed)");
    expect(summaryLine(groupAgents([]).counts, 0)).toBe("no subagents in this chat yet");
    expect(summaryLine(groupAgents([r("a", "completed", 1, 1)]).counts, 1)).toBe("1 chat running · 1 agent · none running · 1 finished");
  });
});

describe("elapsed", () => {
  it("is short and never wraps", () => {
    expect(fmtElapsed(12_400)).toBe("12s");
    expect(fmtElapsed(242_000)).toBe("4m 02s");
    expect(fmtElapsed(3_780_000)).toBe("1h 03m");
    expect(fmtElapsed(-5)).toBe("0s");
  });
  it("uses the CLI's duration, else the clock", () => {
    const base = { startedAt: 1_000, updatedAt: 5_000 };
    expect(rowElapsedMs({ ...base, status: "completed", duration_ms: 700 }, 99_000)).toBe(700);
    expect(rowElapsedMs({ ...base, status: "running", duration_ms: 0 }, 9_000)).toBe(8_000);
    expect(rowElapsedMs({ ...base, status: "completed", duration_ms: 0 }, 9_000)).toBe(4_000);
  });
});

describe("capsLine (267: this send's spawns, not every send's)", () => {
  const off = { per_turn: false, slow: false, stop_at: false };
  const l = { per_turn: 8, slow_at: 60, slow_to: 3, stop_at: 90, off };
  it("counts this send against the per-send cap", () => {
    expect(capsLine(l, 41, 6, null)).toBe("this send 6 of 8 spawns · window 41%");
  });
  it("slowed and refused", () => {
    expect(capsLine(l, 70, 2, "spent 4% of 35%")).toBe("this send 2 of 3 spawns · window 70% · slowed · spent 4% of 35%");
    expect(capsLine(l, 95, 2, null)).toBe("this send 2 of 3 spawns · window 95% · spawns refused");
  });
  it("cap off and window unknown", () => {
    expect(capsLine({ ...l, off: { ...off, per_turn: true } }, null, 4, null)).toBe("this send spawned 4");
  });
});
