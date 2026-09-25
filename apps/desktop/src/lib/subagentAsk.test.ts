import { describe, expect, it } from "vitest";
import type { Segment } from "./state.svelte";
import {
  ADOPT_CLOSE,
  ADOPT_OPEN,
  RESULT_CARRY,
  adoptedChatOf,
  adoptedPrompt,
  adoptedTitle,
  carryOfSubagent,
  followUpsOf,
  splitAdopted,
  type AdoptSource,
} from "./subagentAsk";

/**
 * Talking to a subagent (nightshift backlog 157): what an adopted chat is
 * sent, how its first message folds back, and how the tab reads its
 * exchanges.
 */
function source(over: Partial<AdoptSource> = {}): AdoptSource {
  const segments: Segment[] = [
    { kind: "thinking", text: "private scratch", done: true },
    { kind: "text", text: "Reading the file." },
    {
      kind: "tool",
      call: {
        id: "t1",
        name: "Read",
        input: { file_path: "/p/a.md" },
        result: { content: "x".repeat(RESULT_CARRY + 50), is_error: false },
        children: [{ kind: "text", text: "nested words" }],
      },
    },
    { kind: "text", text: "The colour is TEAL." },
  ];
  return {
    tool_use_id: "toolu_abc",
    description: "Memory task",
    subagent_type: "general-purpose",
    model: "haiku",
    prompt: "Remember TEAL.",
    segments,
    ...over,
  };
}

describe("carryOfSubagent", () => {
  it("carries the task, every call with its cut result, nested words and its own words, not its thinking", () => {
    const c = carryOfSubagent(source(), "parent-1");
    expect(c.startsWith(`${ADOPT_OPEN} call="toolu_abc"`)).toBe(true);
    expect(c.endsWith(ADOPT_CLOSE)).toBe(true);
    expect(c).toContain('parent_chat="parent-1"');
    expect(c).toContain("## Task\nRemember TEAL.");
    expect(c).toContain('[call Read] {"file_path":"/p/a.md"}');
    expect(c).toContain("[result] " + "x".repeat(RESULT_CARRY));
    expect(c).toContain("[50 more characters cut]");
    expect(c).toContain("  [said] nested words");
    expect(c).toContain("[said] The colour is TEAL.");
    expect(c).not.toContain("private scratch");
  });

  it("says when a call had no result and when the run sent nothing", () => {
    const open = carryOfSubagent(
      source({ segments: [{ kind: "tool", call: { id: "t", name: "Bash", input: {}, result: null } }] }),
      null,
    );
    expect(open).toContain("[no result");
    expect(open).not.toContain("parent_chat");
    expect(carryOfSubagent(source({ segments: [] }), null)).toContain("(it sent nothing back)");
  });

  it("keeps the most recent part of a run past the limit, and says so", () => {
    const many: Segment[] = Array.from({ length: 80 }, (_, i) => ({
      kind: "tool" as const,
      call: { id: `t${i}`, name: "Read", input: { i }, result: { content: `r${i} ` + "y".repeat(3900), is_error: false } },
    }));
    const c = carryOfSubagent(source({ segments: many }), null);
    expect(c).toContain("The earliest part of the run was cut to fit.");
    expect(c).toContain("r79 ");
    expect(c).not.toContain("r0 ");
    expect(c).toContain("## Task\nRemember TEAL.");
  });
});

describe("splitAdopted", () => {
  it("takes the carried block, the agent and the call off the first message", () => {
    const text = adoptedPrompt(carryOfSubagent(source(), "p"), "What colour?");
    const s = splitAdopted(text);
    expect(s.carried?.startsWith(ADOPT_OPEN)).toBe(true);
    expect(s.agent).toBe("Memory task");
    expect(s.call).toBe("toolu_abc");
    expect(s.said).toBe("What colour?");
  });

  it("leaves every other message alone, an unclosed block included", () => {
    expect(splitAdopted("hello")).toEqual({ carried: null, agent: null, call: null, said: "hello" });
    expect(splitAdopted(`${ADOPT_OPEN} call="x">`).carried).toBeNull();
  });
});

describe("adoptedChatOf and adoptedTitle", () => {
  it("finds the chat whose first message carries this call, and no other", () => {
    const first = adoptedPrompt(carryOfSubagent(source(), "p"), "q");
    const sessions = [
      { id: "a", first_user: "plain" },
      { id: "b", first_user: first },
      { id: "c", first_user: null },
    ];
    expect(adoptedChatOf(sessions, "toolu_abc")).toBe("b");
    expect(adoptedChatOf(sessions, "toolu_other")).toBeNull();
  });

  it("names the chat after the agent's first line, kept short", () => {
    expect(adoptedTitle(source())).toBe("↳ agent: Memory task");
    const long = adoptedTitle(source({ description: "", prompt: "z".repeat(90) + "\nsecond" }));
    expect(long.startsWith("↳ agent: zzz")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(75);
  });
});

describe("followUpsOf", () => {
  it("pairs each question with the text of the replies after it, the carry left out", () => {
    const events = [
      { event: "session_created" },
      { event: "user_message", text: adoptedPrompt(carryOfSubagent(source(), "p"), "What colour?") },
      {
        event: "assistant_message",
        blocks: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "TEAL." },
        ],
      },
      { event: "user_message", text: "And the animal?" },
      { event: "assistant_message", blocks: [{ type: "tool_use" }] },
      { event: "assistant_message", blocks: [{ type: "text", text: "PELICAN." }] },
      { event: "user_message", text: "Still there?" },
    ];
    expect(followUpsOf(events)).toEqual([
      { asked: "What colour?", answer: "TEAL." },
      { asked: "And the animal?", answer: "PELICAN." },
      { asked: "Still there?", answer: "" },
    ]);
  });
});
