import { describe, expect, it } from "vitest";
import { SILENT_MS, restartNote, silentFor, silentLabel } from "./silentHelper";
import { helperRows } from "./railTasks";

const MIN = 60_000;
const row = (over: Partial<{ status: string; restored: boolean; startedAt: number; updatedAt: number; heardAt: number }> = {}) => ({
  status: "running",
  startedAt: 0,
  updatedAt: 0,
  ...over,
});

describe("a silent helper (item 752, blocker 2345)", () => {
  it("is silent from 15 min after the last thing it streamed, not before", () => {
    expect(SILENT_MS).toBe(15 * MIN);
    expect(silentFor(row({ heardAt: 0 }), 15 * MIN - 1)).toBeNull();
    expect(silentFor(row({ heardAt: 0 }), 15 * MIN)).toBe(15 * MIN);
    // It spoke at minute 10: the clock starts again from there.
    expect(silentFor(row({ heardAt: 10 * MIN }), 20 * MIN)).toBeNull();
    expect(silentFor(row({ heardAt: 10 * MIN }), 25 * MIN)).toBe(15 * MIN);
  });

  it("never draws for a helper that ended, or one rebuilt from the log", () => {
    for (const status of ["completed", "failed", "stopped", "launched"]) expect(silentFor(row({ status }), 60 * MIN)).toBeNull();
    expect(silentFor(row({ restored: true }), 60 * MIN)).toBeNull();
  });

  it("counts from the row's last change when it has no heard clock", () => {
    expect(silentFor(row({ updatedAt: 5 * MIN }), 20 * MIN)).toBe(15 * MIN);
  });

  it("says the silence in minutes, then hours", () => {
    expect(silentLabel(15 * MIN + 59_000)).toBe("No output for 15 min");
    expect(silentLabel(60 * MIN)).toBe("No output for 1 h");
    expect(silentLabel(65 * MIN)).toBe("No output for 1 h 5 min");
  });

  it("asks the main agent to launch it again with the same call and prompt", () => {
    const r = { tool_use_id: "toolu_1", task_id: "a8bb", description: "scan the logs", subagent_type: "general-purpose", model: "sonnet" };
    const n = restartNote(r, "Read the logs and report.", 17 * MIN);
    expect(n).toContain("restarted your subagent “scan the logs” (agent a8bb, your Agent call toolu_1)");
    expect(n).toContain("no output for 17 min");
    expect(n).toContain('subagent_type "general-purpose", model "sonnet", description "scan the logs"');
    expect(n).toContain("exactly the same prompt");
    expect(n.endsWith("Read the logs and report.")).toBe(true);
    // No prompt found: the note still names the call to repeat.
    expect(restartNote(r, null, 15 * MIN)).not.toContain("The prompt, as that call gave it");
  });

  it("marks a silent helper in the right column's list", () => {
    const sub = { tool_use_id: "x", description: "d", subagent_type: "general-purpose", status: "running", background: false, turn: 1, startedAt: 0, updatedAt: 0, heardAt: 0 };
    expect(helperRows([sub], [], "s1", 16 * MIN).rows[0]!.silent).toBe(16 * MIN);
    expect(helperRows([sub], [], "s1", 5 * MIN).rows[0]!.silent).toBeNull();
    expect(helperRows([sub], [], "s1").rows[0]!.silent).toBeNull();
  });
});
