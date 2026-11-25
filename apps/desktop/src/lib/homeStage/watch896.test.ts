// Item 896: Watch's Handled list keys every row uniquely, even two identical feed rows in one millisecond.
import { describe, expect, it } from "vitest";
import { feedKeys } from "./watch";
// Item 946: the Handled list moved from Watch's column to the bar's Handled button; its keys are `handledRows`'s
// (feedKeys over the rows oldest first).
import { handledRows } from "./watch";
import handledSrc from "./HandledMenu.svelte?raw";

describe("896 Handled keys", () => {
  it("two identical rows get two keys; the first keeps its own", () => {
    const row = { at: "2026-11-19T16:00:00.000Z", line: "the run failed" };
    const keys = feedKeys([row, { ...row }, { at: row.at, line: "other" }, { ...row }]);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe(row.at + row.line);
  });
  it("the Handled list keys its rows by feedKeys, not at + line", () => {
    expect(handledSrc).toContain("(r.key)");
    expect(handledSrc).not.toContain("(f.at + f.line)");
    const row = { at: "2026-11-19T16:00:00.000Z", line: "the run failed" };
    expect(new Set(handledRows([row, { ...row }, { ...row }], null, {}).list.map((r) => r.key)).size).toBe(3);
  });
});
