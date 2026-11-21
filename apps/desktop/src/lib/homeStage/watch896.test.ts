// Item 896: Watch's Handled list keys every row uniquely, even two identical feed rows in one millisecond.
import { describe, expect, it } from "vitest";
import { feedKeys } from "./watch";
import watchSrc from "./views/Watch.svelte?raw";

describe("896 Handled keys", () => {
  it("two identical rows get two keys; the first keeps its own", () => {
    const row = { at: "2026-11-19T16:00:00.000Z", line: "the run failed" };
    const keys = feedKeys([row, { ...row }, { at: row.at, line: "other" }, { ...row }]);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe(row.at + row.line);
  });
  it("Watch keys the Handled list by feedKeys, not at + line", () => {
    expect(watchSrc).toContain("(handledKeys[i])");
    expect(watchSrc).not.toContain("(f.at + f.line)");
  });
});
