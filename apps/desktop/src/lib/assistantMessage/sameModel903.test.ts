import { describe, expect, it } from "vitest";
import { sameModelId } from "./logic.svelte";

describe("item 903 — the header compares the CLI's model with the pick", () => {
  it("same model by case or a context tag; another model is not", () => {
    expect(sameModelId("claude-fable-5-2", "claude-fable-5-2[1m]")).toBe(true);
    expect(sameModelId("Claude-Opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(sameModelId("claude-fable-5-2", "claude-opus-5-5")).toBe(false);
  });
});
