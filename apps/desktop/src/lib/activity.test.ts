import { describe, expect, it } from "vitest";
import type { Segment, ToolCallView } from "./state.svelte";
import {
  activitySummary,
  countActivity,
  groupSegments,
  modelOmitsThinking,
  resolveFolded,
  shortToolName,
  thinkingHidden,
  thinkingState,
  thinkingToggleDead,
  workingLabel,
} from "./activity";
import { segmentIds } from "./transcriptPrefs.svelte";

// The activity block (nightshift backlog 096): the "mock" the item asks
// for is this fixture — the five-row reply from his screenshot, projected
// into one block with the rows the component draws — since the suite has
// no DOM to render into.

function call(over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "toolu_1", name: "Bash", input: {}, result: null, ...over };
}

/** His screenshot: thinking, Bash, thinking, ToolSearch, an MCP call, thinking. */
const screenshot: Segment[] = [
  { kind: "thinking", text: "Let me look.", done: true },
  {
    kind: "tool",
    call: call({
      id: "toolu_1",
      name: "Bash",
      input: { command: "grep -r algorithmic", description: "Read project vault note" },
      result: { content: "x".repeat(8122), is_error: false },
    }),
  },
  { kind: "thinking", text: "Now search.", done: true },
  {
    kind: "tool",
    call: call({
      id: "toolu_2",
      name: "ToolSearch",
      input: { query: "select:mcp__nightloom__search_chats" },
      result: { content: "x".repeat(16), is_error: false },
    }),
  },
  {
    kind: "tool",
    call: call({
      id: "toolu_3",
      name: "mcp__nightloom__search_chats",
      input: { query: "algorithmic diversity toy model" },
      result: null,
    }),
  },
  { kind: "thinking", text: "", done: false },
];

describe("groupSegments", () => {
  it("makes his five rows one block, keyed by its first row", () => {
    const groups = groupSegments(screenshot, segmentIds(screenshot));
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe("activity");
    if (g.kind !== "activity") return;
    expect(g.rows.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(g.key).toBe("block:thinking:0");
  });

  it("a text segment ends a block and the next call starts another", () => {
    const segs: Segment[] = [
      { kind: "tool", call: call({ id: "a" }) },
      { kind: "text", text: "Found it." },
      { kind: "tool", call: call({ id: "b" }) },
      { kind: "thinking", text: "hm", done: true },
      { kind: "text", text: "Done." },
    ];
    const groups = groupSegments(segs, segmentIds(segs));
    expect(groups.map((g) => g.kind)).toEqual(["activity", "one", "activity", "one"]);
    const second = groups[2];
    if (second.kind !== "activity") throw new Error("expected a block");
    expect(second.key).toBe("block:tool:b");
    expect(second.rows).toHaveLength(2);
  });

  it("removed blocks and notices stand outside any block", () => {
    const segs: Segment[] = [
      { kind: "tool", call: call({ id: "a" }) },
      { kind: "removed_tool", block: 1, call: call({ id: "b" }) },
      { kind: "tool", call: call({ id: "c" }) },
      { kind: "notice", text: "context compacted" },
    ];
    const groups = groupSegments(segs, segmentIds(segs));
    expect(groups.map((g) => g.kind)).toEqual(["activity", "one", "activity", "one"]);
  });

  it("a reply with no activity is all standalone segments", () => {
    const segs: Segment[] = [{ kind: "text", text: "Hello." }];
    expect(groupSegments(segs, segmentIds(segs))).toEqual([{ kind: "one", seg: segs[0], i: 0 }]);
  });
});

describe("shortToolName", () => {
  it("says an MCP tool by its short name and leaves the rest alone", () => {
    expect(shortToolName("mcp__nightloom__search_chats")).toBe("search chats");
    expect(shortToolName("mcp__my_server__list_things")).toBe("list things");
    expect(shortToolName("Bash")).toBe("Bash");
    expect(shortToolName("ToolSearch")).toBe("ToolSearch");
    expect(shortToolName("mcp__odd")).toBe("mcp__odd");
  });
});

describe("activitySummary", () => {
  it("counts the screenshot as three calls and three thinking", () => {
    const g = groupSegments(screenshot, segmentIds(screenshot))[0];
    if (g.kind !== "activity") throw new Error("expected a block");
    expect(countActivity(g.rows)).toEqual({ tools: 3, thinking: 3, errors: 0, denied: 0 });
    expect(activitySummary(g.rows)).toBe("3 tool calls · 3 thinking");
    expect(activitySummary(g.rows, true)).toBe("3 tool calls · 3 thinking · working");
  });

  it("uses the singular, and names errors and denials", () => {
    const rows = [
      { seg: { kind: "tool", call: call({ id: "a", result: { content: "boom", is_error: true } }) } as Segment, i: 0 },
      { seg: { kind: "thinking", text: "x", done: true } as Segment, i: 1 },
    ];
    expect(activitySummary(rows)).toBe("1 tool call · 1 thinking · 1 error");
    const denied = [
      {
        seg: {
          kind: "tool",
          call: call({ id: "a", denied: true, result: { content: "no", is_error: true } }),
        } as Segment,
        i: 0,
      },
    ];
    // A denial is a decision, not a failure: counted once, as denied.
    expect(activitySummary(denied)).toBe("1 tool call · 1 denied");
    const redacted = [{ seg: { kind: "redacted" } as Segment, i: 0 }];
    expect(activitySummary(redacted)).toBe("1 thinking");
  });
});

describe("resolveFolded", () => {
  const prefs = (tools: boolean, rev = 0) => ({ tools, rev: { tool: rev } });

  it("folds only once the reply is done and the tools toggle is off", () => {
    expect(resolveFolded("block:x", true, {}, prefs(false))).toBe(false);
    expect(resolveFolded("block:x", false, {}, prefs(false))).toBe(true);
    expect(resolveFolded("block:x", false, {}, prefs(true))).toBe(false);
  });

  it("a click on the fold line wins until the toggle is flipped", () => {
    const o = { "block:x": { open: true, rev: 0 } };
    expect(resolveFolded("block:x", false, o, prefs(false))).toBe(false);
    // The toggle bumped its revision: the click no longer counts.
    expect(resolveFolded("block:x", false, o, prefs(false, 1))).toBe(true);
  });
});

// Thinking the model kept to itself (nightshift backlog 097): an empty
// finished block is a marker, not a button, and the chip reads the chat.
describe("thinkingHidden", () => {
  it("is a finished thinking block with no text, and nothing else", () => {
    expect(thinkingHidden({ kind: "thinking", text: "", done: true })).toBe(true);
    expect(thinkingHidden({ kind: "thinking", text: "  \n", done: true })).toBe(true);
    // Still streaming: early, not hidden.
    expect(thinkingHidden({ kind: "thinking", text: "", done: false })).toBe(false);
    expect(thinkingHidden({ kind: "thinking", text: "hm", done: true })).toBe(false);
    expect(thinkingHidden({ kind: "redacted" })).toBe(false);
    expect(thinkingHidden({ kind: "text", text: "" })).toBe(false);
  });
});

describe("thinkingState", () => {
  const reply = (...blocks: { type: string; text?: string }[]) => ({
    event: "assistant_message",
    blocks,
  });
  it("is none before any reply has thought", () => {
    expect(thinkingState([])).toBe("none");
    expect(thinkingState([reply({ type: "text", text: "hi" })])).toBe("none");
    expect(thinkingState([{ event: "user_message" }])).toBe("none");
  });
  it("is hidden when every thinking block is empty or redacted", () => {
    expect(thinkingState([reply({ type: "thinking", text: "" }, { type: "text", text: "hi" })])).toBe(
      "hidden",
    );
    expect(thinkingState([reply({ type: "redacted_thinking" })])).toBe("hidden");
  });
  it("is shown once one block has text", () => {
    expect(
      thinkingState([reply({ type: "thinking", text: "" }), reply({ type: "thinking", text: "so" })]),
    ).toBe("shown");
  });
});

describe("thinkingToggleDead", () => {
  const reply = (...blocks: { type: string; text?: string }[]) => ({
    event: "assistant_message",
    blocks,
  });
  const cc = (model: string) => ({ engine: "claude-code", model });
  it("is dead when every recorded thinking block is empty, on any engine", () => {
    const log = [reply({ type: "thinking", text: "" }, { type: "text", text: "hi" })];
    expect(thinkingToggleDead(log, cc("claude-haiku-4-5"))).toBe(true);
    expect(thinkingToggleDead(log, { engine: "api", model: "claude-opus-5" })).toBe(true);
  });
  it("is dead before the first reply only on Claude Code with an omitting model", () => {
    expect(thinkingToggleDead([], cc("claude-opus-5"))).toBe(true);
    expect(thinkingToggleDead([], cc("claude-haiku-4-5"))).toBe(false);
    expect(thinkingToggleDead([], { engine: "api", model: "claude-opus-5" })).toBe(false);
    expect(thinkingToggleDead([], null)).toBe(false);
  });
  it("is live once one block has text, whatever the model", () => {
    expect(thinkingToggleDead([reply({ type: "thinking", text: "so" })], cc("claude-opus-5"))).toBe(
      false,
    );
  });
});

describe("modelOmitsThinking", () => {
  it("names the families that omit by default and leaves the rest", () => {
    expect(modelOmitsThinking("claude-opus-5")).toBe(true);
    expect(modelOmitsThinking("claude-opus-4-8-20260501")).toBe(true);
    expect(modelOmitsThinking("claude-opus-4-7")).toBe(true);
    expect(modelOmitsThinking("claude-sonnet-5-20260301")).toBe(true);
    expect(modelOmitsThinking("claude-fable-5-1")).toBe(true);
    expect(modelOmitsThinking("claude-haiku-4-5-20251001")).toBe(false);
    expect(modelOmitsThinking("claude-opus-4-1")).toBe(false);
    // A bare alias says nothing about the family: not a guess.
    expect(modelOmitsThinking("opus")).toBe(false);
    expect(modelOmitsThinking(null)).toBe(false);
  });
});

describe("workingLabel", () => {
  it("counts seconds, then minutes and seconds", () => {
    expect(workingLabel(0)).toBe("working · 0 s");
    expect(workingLabel(41_400)).toBe("working · 41 s");
    expect(workingLabel(123_000)).toBe("working · 2 min 3 s");
    expect(workingLabel(-5)).toBe("working · 0 s");
  });
});
