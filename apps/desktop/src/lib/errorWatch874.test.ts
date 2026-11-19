// Item 874: what an uncaught error writes to logs/frontend-errors.log.
import { describe, expect, it } from "vitest";
import { errorLine } from "./errorWatch.svelte";

describe("errorLine (874)", () => {
  it("an Error gives its message and the top of its stack", () => {
    const e = new Error("effect_update_depth_exceeded");
    const line = errorLine("svelte", e);
    expect(line.startsWith("svelte: effect_update_depth_exceeded\n")).toBe(true);
    expect(line.split("\n").length).toBeLessThanOrEqual(9);
  });
  it("a bare reason is written as it is", () => {
    expect(errorLine("rejection", "no backend")).toBe("rejection: no backend");
    expect(errorLine("rejection", null)).toBe("rejection: null");
  });
});
