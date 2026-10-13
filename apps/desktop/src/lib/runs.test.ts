import { describe, expect, it } from "vitest";
import { continuedFlags, type RunItem } from "./runs";

// Runs of replies (nightshift backlog 121): his screenshot — three OPUS
// replies in a row, one tool call each, no user turn between — draws as
// one reply; anything between them, or a different model, starts a new one.

const user = (): RunItem => ({ kind: "user", superseded: false });
const reply = (model = "claude-opus-5", superseded = false): RunItem => ({ kind: "assistant", model, superseded });

describe("continuedFlags", () => {
  it("merges three same-model replies with no user turn between", () => {
    expect(continuedFlags([user(), reply(), reply(), reply(), reply()])).toEqual([
      false, false, true, true, true,
    ]);
  });
  it("starts a new run at a user message", () => {
    expect(continuedFlags([user(), reply(), user(), reply()])).toEqual([false, false, false, false]);
  });
  it("starts a new run when the model changes", () => {
    expect(continuedFlags([user(), reply("claude-opus-5"), reply("claude-sonnet-5"), reply("claude-sonnet-5")])).toEqual([
      false, false, false, true,
    ]);
  });
  it("starts a new run at a compaction", () => {
    expect(continuedFlags([reply(), { kind: "compaction", superseded: false }, reply()])).toEqual([false, false, false]);
  });
  it("does not merge across a rewind's superseded boundary", () => {
    expect(continuedFlags([reply(), reply(), reply("claude-opus-5", true), reply("claude-opus-5", true)])).toEqual([
      false, true, false, true,
    ]);
  });
  it("is all false for an empty or single list", () => {
    expect(continuedFlags([])).toEqual([]);
    expect(continuedFlags([reply()])).toEqual([false]);
  });
});
