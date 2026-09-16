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
