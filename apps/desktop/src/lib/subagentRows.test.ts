import { describe, expect, it } from "vitest";
import type { SubagentRow } from "./state.svelte";
import type { SessionEvent } from "./types";
import * as tabs from "./tabs";
import {
  LOG_TURN_BASE,
  adoptPending,
  agentCallContent,
  agentRowLine,
  isAgentCall,
  latestAgents,
  mergeRows,
  rowsFromLog,
  rowsOf,
} from "./subagentRows";

/**
 * The Running-tasks rows across chats (nightshift backlog 160): the Agent
 * row's tab descriptor, the chip's "latest turn that had agents", the
 * rows rebuilt from a reopened chat's log, and the merge that keeps the
 * live row.
 */
function row(over: Partial<SubagentRow>): SubagentRow {
  return {
    tool_use_id: "toolu_p",
    task_id: "a1",
    subagent_type: "general-purpose",
    description: "Read and summarize ACE paper",
    prompt: "Read it.",
    status: "running",
    background: false,
    tokens: 0,
    tool_uses: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    rounds: 0,
    session: "c1",
    turn: 1,
    startedAt: 0,
    updatedAt: 0,
    segments: [],
    ...over,
  };
}

describe("the Agent row's tab (backlog 160)", () => {
  it("names the subagent kind a strip opens, and round-trips as a content drag", () => {
    const c = agentCallContent("c1", { id: "toolu_p", input: { description: "Read and summarize ACE paper", model: "sonnet" } });
    expect(c).toEqual({ kind: "subagent", session: "c1", toolUseId: "toolu_p", name: "Read and summarize ACE paper" });
    expect(tabs.parseContentDrag(JSON.stringify(c))).toEqual(c);
    expect(tabs.tabTitle(c, [])).toBe("Agent · Read and summarize ACE paper");
    // No description: the type, then the word.
    expect(agentCallContent("c1", { id: "x", input: { subagent_type: "Explore" } }).name).toBe("Explore");
    expect(agentCallContent("c1", { id: "x", input: null }).name).toBe("subagent");
    expect(isAgentCall("Agent") && isAgentCall("Task") && !isAgentCall("Read")).toBe(true);
  });

  it("the row's line says model, state, tokens and calls once the panel knows them", () => {
    expect(agentRowLine(row({ model: "claude-sonnet-4-5-20250929", status: "completed", tokens: 31_000, tool_uses: 6 }))).toBe(
      "sonnet 4.5 · done · 31k · 6 calls",
    );
    expect(agentRowLine(row({}))).toBe("running");
  });
});

describe("the chip's rows (backlog 160)", () => {
  it("are the chat's latest turn that had agents, and stay after they finish and after later turns", () => {
    const rows = [
      row({ tool_use_id: "a", turn: 3, status: "completed", tokens: 10 }),
      row({ tool_use_id: "b", turn: 5, status: "completed", tokens: 31_000 }),
      row({ tool_use_id: "c", turn: 9, session: "other", status: "running" }),
    ];
    const t = latestAgents(rows, "c1");
    expect(t.rows.map((r) => r.tool_use_id)).toEqual(["b"]);
    expect(t.running).toBe(0);
    expect(t.tokens).toBe(31_000);
    expect(latestAgents(rows, "other").running).toBe(1);
    expect(latestAgents(rows, "none").rows).toEqual([]);
    expect(rowsOf(rows, "c1").map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  it("a New chat's rows take the id its first turn made", () => {
    const rows = [row({ session: null }), row({ tool_use_id: "q", session: "c2" })];
    adoptPending(rows, "c9");
    expect(rows.map((r) => r.session)).toEqual(["c9", "c2"]);
  });
});

describe("rows rebuilt from a reopened chat's log (backlog 160)", () => {
  const events = [
    { event: "user_message", text: "hi", at: "2026-09-25T00:00:00Z" },
    {
      event: "assistant_message",
      model: "m",
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      at: "2026-09-25T00:00:01Z",
      blocks: [
        {
          type: "tool_use",
          id: "toolu_p",
          name: "Agent",
          input: { description: "Read and summarize ACE paper", subagent_type: "general-purpose", prompt: "Read it.", model: "sonnet" },
        },
        { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/a" } },
      ],
    },
    {
      event: "tool_result",
      tool_use_id: "toolu_p",
      name: "Agent",
      content: "Summary.\n<usage>total_tokens: 28127\ntool_uses: 3\nduration_ms: 8767</usage>",
      at: "2026-09-25T00:00:02Z",
    },
    { event: "user_message", text: "again", at: "2026-09-25T00:01:00Z" },
    {
      event: "assistant_message",
      model: "m",
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      at: "2026-09-25T00:01:01Z",
      blocks: [
        { type: "tool_use", id: "toolu_q", name: "Agent", input: { description: "Second" } },
        { type: "text", text: '<subagent parent="toolu_p">\n▸ Read acepaper.txt\n## Summary\n</subagent>' },
      ],
    },
    { event: "tool_result", tool_use_id: "toolu_q", name: "Agent", content: "boom", is_error: true, at: "2026-09-25T00:01:02Z" },
  ] as unknown as SessionEvent[];

  it("one row per Agent call: task from the input, state from the result, figures the CLI appended, the narrative as its transcript", () => {
    const rows = rowsFromLog(events, "c1");
    expect(rows.map((r) => r.tool_use_id)).toEqual(["toolu_p", "toolu_q"]);
    const [p, q] = rows;
    expect(p).toMatchObject({
      session: "c1",
      restored: true,
      description: "Read and summarize ACE paper",
      model: "sonnet",
      status: "completed",
      tokens: 28127,
      tool_uses: 3,
      duration_ms: 8767,
      turn: LOG_TURN_BASE + 1,
    });
    expect(p.segments).toEqual([{ kind: "text", text: "▸ Read acepaper.txt\n## Summary" }]);
    expect(q).toMatchObject({ status: "failed", tokens: 0, turn: LOG_TURN_BASE + 2, segments: [] });
    // The chip after a reopen: the log's latest turn with agents; any live
    // turn in this window is later than every log turn.
    expect(latestAgents(rows, "c1").rows.map((r) => r.tool_use_id)).toEqual(["toolu_q"]);
    expect(LOG_TURN_BASE + 10_000).toBeLessThan(0);
  });

  it("merging keeps the row the window holds, with its live figures, and adds the rest", () => {
    const live = row({ tool_use_id: "toolu_p", tokens: 99, status: "completed" });
    const merged = mergeRows([live], rowsFromLog(events, "c1"));
    expect(merged.map((r) => r.tool_use_id)).toEqual(["toolu_p", "toolu_q"]);
    expect(merged[0]).toBe(live);
    const same = [live];
    expect(mergeRows(same, [])).toBe(same);
  });
});
