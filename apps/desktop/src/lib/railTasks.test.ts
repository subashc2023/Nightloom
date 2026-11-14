import { describe, expect, it } from "vitest";
import { FINISHED_SHOWN, helperRows } from "./railTasks";

const sub = (id: string, status: string, turn: number, extra: Partial<{ background: boolean; subagent_type: string; description: string }> = {}) => ({
  tool_use_id: id,
  description: extra.description ?? `task ${id}`,
  subagent_type: extra.subagent_type ?? "general-purpose",
  status,
  background: extra.background ?? false,
  turn,
  startedAt: turn * 10,
});

describe("the right column's helpers (item 600)", () => {
  it("is empty with no helpers, so the section explains itself", () => {
    expect(helperRows([], [], "s1")).toEqual({ rows: [], running: 0, more: 0 });
  });

  it("lists every running helper first, then the latest send's finished ones", () => {
    const out = helperRows([sub("a", "completed", 1), sub("b", "running", 1), sub("c", "completed", 2), sub("d", "failed", 2)], [], "s1");
    expect(out.rows.map((r) => [r.id, r.state])).toEqual([
      ["b", "running"],
      ["d", "failed"],
      ["c", "done"],
    ]);
    expect(out.running).toBe(1);
  });

  it("marks background subagents and council seats, and opens the panel on a subagent", () => {
    const out = helperRows([sub("a", "running", 1, { background: true }), sub("b", "running", 1, { subagent_type: "council seat" })], [], "s1");
    expect(out.rows.map((r) => r.kind).sort()).toEqual(["background", "council seat"]);
    expect(out.rows.every((r) => r.focus === r.id)).toBe(true);
  });

  it("adds this chat's running asides, not another chat's", () => {
    const runs = [
      { id: "x", kind: "aside", session: "s1", doing: "why is it slow" },
      { id: "y", kind: "aside", session: "s2", doing: "other" },
      { id: "z", kind: "turn", session: "s1", doing: "Read" },
    ];
    const out = helperRows([], runs, "s1");
    expect(out.rows).toEqual([{ id: "x", label: "why is it slow", kind: "aside", state: "running", focus: null }]);
    expect(out.running).toBe(1);
  });

  it("caps the finished rows and counts the rest", () => {
    const many = Array.from({ length: FINISHED_SHOWN + 3 }, (_, i) => sub(`f${i}`, "completed", 1));
    const out = helperRows(many, [], "s1");
    expect(out.rows.length).toBe(FINISHED_SHOWN);
    expect(out.more).toBe(3);
  });
});
