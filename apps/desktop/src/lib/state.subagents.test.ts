import { beforeEach, describe, expect, it } from "vitest";
import { app, applyTurnEvent, subagentsOfTurn } from "./state.svelte";
import type { SubagentStatus, TurnEvent } from "./types";

/**
 * The Running-tasks rows (nightshift backlog 152): the translator's
 * `subagent_status` event replaces a row whole, the child's own events
 * land in the row's segments as well as under the live call, and the
 * latest turn's rows are what the chip and the gauge's line read.
 */
const status = (over: Partial<SubagentStatus> = {}): TurnEvent => ({
  type: "subagent_status",
  tool_use_id: "toolu_p",
  task_id: "a1",
  subagent_type: "general-purpose",
  description: "Survey the crate",
  prompt: "Survey the crate and report.",
  status: "running",
  background: false,
  tokens: 0,
  tool_uses: 0,
  duration_ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  rounds: 0,
  ...over,
});

describe("the subagent rows", () => {
  beforeEach(() => {
    app.subagents = [];
    app.turnSeq = 7;
    app.live = {
      segments: [{ kind: "tool", call: { id: "toolu_p", name: "Agent", input: {}, result: null } }],
    };
  });

  it("one row per spawning call, replaced whole on each status, the window's fields kept", () => {
    applyTurnEvent(status());
    expect(app.subagents).toHaveLength(1);
    const first = app.subagents[0];
    expect(first.turn).toBe(7);
    expect(first.segments).toEqual([]);
    const started = first.startedAt;
    applyTurnEvent(status({ tokens: 26271, tool_uses: 1, model: "claude-haiku-4-5-20251001", rounds: 1 }));
    expect(app.subagents).toHaveLength(1);
    expect(app.subagents[0].tokens).toBe(26271);
    expect(app.subagents[0].model).toBe("claude-haiku-4-5-20251001");
    expect(app.subagents[0].startedAt).toBe(started);
    applyTurnEvent(status({ tool_use_id: "toolu_q", description: "Second" }));
    expect(app.subagents.map((r) => r.tool_use_id)).toEqual(["toolu_p", "toolu_q"]);
  });

  it("the child's events fill the row's own segments and the live call's children alike", () => {
    applyTurnEvent(status());
    const call: TurnEvent = { type: "tool_call", id: "toolu_c", name: "Read", input: { file_path: "a.rs" } };
    applyTurnEvent({ type: "subagent", parent_tool_use_id: "toolu_p", event: call });
    applyTurnEvent({
      type: "subagent",
      parent_tool_use_id: "toolu_p",
      event: { type: "tool_result", tool_use_id: "toolu_c", name: "Read", content: "fn main() {}", is_error: false },
    });
    applyTurnEvent({ type: "subagent", parent_tool_use_id: "toolu_p", event: { type: "text_delta", text: "Done." } });
    const row = app.subagents[0];
    expect(row.segments).toHaveLength(2);
    expect(row.segments[0].kind === "tool" && row.segments[0].call.result?.content).toBe("fn main() {}");
    expect(row.segments[1]).toEqual({ kind: "text", text: "Done." });
    const live = app.live!.segments[0];
    expect(live.kind === "tool" && live.call.children?.length).toBe(2);
    // A child's event before any status still reaches the live call; the
    // row appears with the CLI's first task line.
    applyTurnEvent({ type: "subagent", parent_tool_use_id: "toolu_x", event: { type: "text_delta", text: "?" } });
    expect(app.subagents).toHaveLength(1);
  });

  it("the chip reads the latest turn's rows: count, running, the CLI's tokens summed", () => {
    applyTurnEvent(status({ tokens: 8_785, status: "completed" }));
    app.turnSeq = 8;
    applyTurnEvent(status({ tool_use_id: "toolu_q", tokens: 26_271 }));
    applyTurnEvent(status({ tool_use_id: "toolu_r", tokens: 7_629, status: "completed" }));
    const t = subagentsOfTurn();
    expect(t.rows.map((r) => r.tool_use_id)).toEqual(["toolu_q", "toolu_r"]);
    expect(t.running).toBe(1);
    expect(t.tokens).toBe(26_271 + 7_629);
    expect(app.subagents).toHaveLength(3);
  });
});
