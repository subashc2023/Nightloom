import { beforeEach, describe, expect, it } from "vitest";
import { app, applyTurnEvent } from "./state.svelte";
import { lineText, lineView, matchTasks, type StillRunningSegment } from "./stillRunning";
import { openTasksOn, tasksFocus } from "./tasksFocus.svelte";
import lineSrc from "./StillRunningLine.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";
import tasksSrc from "./RunningTasks.svelte?raw";
import type { SubagentStatus, TurnEvent } from "./types";

/**
 * Nightshift backlog 357 (2026-10-13, his screenshot): the line a reply
 * ends with while its subagents still run reads as status, not a question;
 * Stop is on it; each name opens the Running-tasks panel on its row; and it
 * turns to done or stopped as the rows end.
 */
const row = (id: string, description: string, status = "running") => ({ tool_use_id: id, description, status });
const seg = (over: Partial<StillRunningSegment> = {}): StillRunningSegment => ({
  kind: "still_running",
  tasks: ["Research a16z speedrun and Fareed Mosavat"],
  ids: ["toolu_a"],
  turn: "turn-1",
  ...over,
});

describe("357: the still-running line, pure", () => {
  it("names each task's row, a running one first, never one row twice", () => {
    const rows = [row("t1", "Survey", "completed"), row("t2", "Survey"), row("t3", "Other")];
    expect(matchTasks(["Survey", "Survey", "Other", "Gone"], rows)).toEqual(["t2", "t1", "t3", null]);
  });

  it("reads as status while running — his wording, singular and plural", () => {
    const v = lineView(seg(), [row("toolu_a", "Research a16z speedrun and Fareed Mosavat")]);
    expect(v.state).toBe("running");
    expect(lineText(v)).toBe("Still working: 1 subagent (“Research a16z speedrun and Fareed Mosavat”) — the reply continues when it reports");
    expect(lineText(v)).not.toContain("?");
    const two = lineView(seg({ tasks: ["A", "B"], ids: ["a", "b"] }), [row("a", "A"), row("b", "B", "completed")]);
    expect(lineText(two)).toBe("Still working: 2 subagents (“A”, “B”) — the reply continues when they report");
    expect(two.names.map((n) => n.state)).toEqual(["running", "done"]);
  });

  it("turns to done when every row completed", () => {
    const v = lineView(seg(), [row("toolu_a", "R", "completed")]);
    expect(v.state).toBe("done");
    expect(v.head).toBe("Done:");
  });

  it("turns to stopped when he pressed Stop, or the CLI reports a stop", () => {
    expect(lineView(seg({ stopped: true }), [row("toolu_a", "R")]).state).toBe("stopped");
    expect(lineView(seg({ stopped: true, ids: [null] }), []).state).toBe("stopped");
    expect(lineView(seg(), [row("toolu_a", "R", "stopped")]).state).toBe("stopped");
    // A completed one stays done under a Stop.
    const mixed = lineView(seg({ tasks: ["A", "B"], ids: ["a", "b"], stopped: true }), [row("a", "A", "completed"), row("b", "B")]);
    expect(mixed.names.map((n) => n.state)).toEqual(["done", "stopped"]);
    expect(mixed.state).toBe("stopped");
  });

  it("a name with no row reads as running until stopped", () => {
    expect(lineView(seg({ ids: [null] }), []).state).toBe("running");
  });

  it("a name opens the Running-tasks panel on its row", () => {
    app.showTasks = false;
    openTasksOn("toolu_a");
    expect(app.showTasks).toBe(true);
    expect(tasksFocus.id).toBe("toolu_a");
  });
});

const status = (over: Partial<SubagentStatus> = {}): TurnEvent => ({
  type: "subagent_status",
  tool_use_id: "toolu_a",
  task_id: "a1",
  subagent_type: "general-purpose",
  description: "Research a16z speedrun and Fareed Mosavat",
  prompt: "Research.",
  status: "running",
  background: false,
  tokens: 0,
  tool_uses: 0,
  duration_ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  rounds: 0,
  ...over,
});

describe("357: the still_running event", () => {
  beforeEach(() => {
    app.subagents = [];
    app.toasts = [];
    app.activeSessionId = null;
    app.live = { segments: [{ kind: "tool", call: { id: "toolu_a", name: "Agent", input: {}, result: null } }] };
  });

  it("pushes a still_running segment with the task's row — not a notice — and no toast on screen", () => {
    applyTurnEvent(status());
    applyTurnEvent({ type: "still_running", tasks: ["Research a16z speedrun and Fareed Mosavat"] });
    const segs = app.live!.segments;
    const last = segs[segs.length - 1] as StillRunningSegment;
    expect(last.kind).toBe("still_running");
    expect(last.ids).toEqual(["toolu_a"]);
    expect(segs.some((s) => s.kind === "notice")).toBe(false);
    expect(app.toasts).toHaveLength(0);
    // The row ends: the same segment now reads as done.
    applyTurnEvent(status({ status: "completed" }));
    expect(lineView(last, app.subagents).state).toBe("done");
  });
});

describe("357: the wiring the markup holds", () => {
  it("the reply draws the segment with the line component", () => {
    expect(messageSrc).toContain('{:else if g.seg.kind === "still_running"}');
    expect(messageSrc).toContain("<StillRunningLine seg={g.seg} />");
  });
  it("the line has Stop, calling the turn's stop_subagents, and names that open the panel", () => {
    expect(lineSrc).toContain("api.stopSubagents(seg.turn)");
    expect(lineSrc).toMatch(/>Stop<\/button/);
    expect(lineSrc).toContain("onclick={() => openTasksOn(n.id)}");
  });
  it("the panel marks the row it was opened on and clears the mark when it closes", () => {
    expect(tasksSrc).toContain("class:focus={tasksFocus.id === r.tool_use_id}");
    expect(tasksSrc).toContain("onDestroy(() => (tasksFocus.id = null))");
  });
});
