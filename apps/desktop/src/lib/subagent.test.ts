import { describe, expect, it } from "vitest";
import { parseSubagentBlock, subagentCalls } from "./subagent";

// The recorder's shape, verbatim from `agent/record.rs`'s test
// (`a_subagents_turn_is_recorded_as_a_marked_block_against_its_parent`).
const BLOCK =
  '<subagent parent="p1">\n▸ Read a.txt\n  ↳ 1\tdef add(a, b):\n## Summary\n\nAdds numbers.\n</subagent>';

describe("parseSubagentBlock", () => {
  it("reads the parent id and the narrative between the markers", () => {
    const b = parseSubagentBlock(BLOCK);
    expect(b).not.toBeNull();
    expect(b!.parent).toBe("p1");
    expect(b!.body).toBe("▸ Read a.txt\n  ↳ 1\tdef add(a, b):\n## Summary\n\nAdds numbers.");
    expect(subagentCalls(b!.body)).toBe(1);
  });

  it("leaves ordinary prose alone, markers inside it included", () => {
    expect(parseSubagentBlock("hello")).toBeNull();
    expect(parseSubagentBlock('see <subagent parent="x"> later')).toBeNull();
    expect(parseSubagentBlock('<subagent parent="">\nx\n</subagent>')).toBeNull();
  });

  it("survives a block the recorder clipped before its close marker", () => {
    const b = parseSubagentBlock('<subagent parent="p9">\n▸ Read a\n\n[truncated: 70000 bytes of output, 65536 kept]');
    expect(b!.parent).toBe("p9");
    expect(b!.body.startsWith("▸ Read a")).toBe(true);
  });
});

// Backlog 330: the stream shapes of the 10/8 chat (synthetic text) — a
// background agent's block landing past his next message, and a block whose
// spawning call was a subagent's own — go in an agent box, never prose.
import { placeSubagentBlock, UNKNOWN_PARENT_TASK } from "./subagent";
import type { Segment } from "./state.svelte";

describe("placeSubagentBlock (backlog 330)", () => {
  const STEP_LOG = "▸ WebSearch grants 2026\n  ↳ Web search results for query: \"grants 2026\"\n▸ SubagentHandback\n  ↳ {\"success\":true}";
  const call = (id: string): Segment => ({ kind: "tool", call: { id, name: "Agent", input: { description: "sweep" }, result: null } });

  it("nests under its call in an earlier reply, past a message of his", () => {
    const earlier: Segment[] = [call("toolu_a")];
    const segs: Segment[] = [{ kind: "text", text: "Here is the summary." }];
    placeSubagentBlock({ parent: "toolu_a", body: STEP_LOG }, segs, [earlier]);
    expect(segs).toHaveLength(1);
    const c = earlier[0].kind === "tool" ? earlier[0].call : null;
    expect(c?.children).toEqual([{ kind: "text", text: STEP_LOG }]);
  });

  it("nests under a call inside another subagent's box", () => {
    const outer = call("toolu_outer");
    if (outer.kind === "tool") outer.call.children = [call("toolu_inner")];
    const segs: Segment[] = [outer];
    placeSubagentBlock({ parent: "toolu_inner", body: STEP_LOG }, segs, []);
    expect(segs).toHaveLength(1);
  });

  it("with no call in the log, draws its own agent box after the reply — not prose", () => {
    const segs: Segment[] = [{ kind: "text", text: "Here is the summary." }];
    placeSubagentBlock({ parent: "toolu_nested", body: STEP_LOG }, segs, [[call("toolu_other")]]);
    expect(segs.filter((s) => s.kind === "text")).toEqual([{ kind: "text", text: "Here is the summary." }]);
    const box = segs[1];
    expect(box.kind).toBe("tool");
    if (box.kind !== "tool") return;
    expect(box.call).toMatchObject({ id: "toolu_nested", name: "Agent", input: { description: UNKNOWN_PARENT_TASK } });
    expect(box.call.children).toEqual([{ kind: "text", text: STEP_LOG }]);
    // A second block of the same agent joins the same box.
    placeSubagentBlock({ parent: "toolu_nested", body: "▸ Read x" }, segs, []);
    expect(segs).toHaveLength(2);
    expect(box.call.children).toHaveLength(2);
  });
});
