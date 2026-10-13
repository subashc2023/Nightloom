import { describe, expect, it } from "vitest";
import { checkpointLine, checkpointOwner } from "./checkpoint";
import type { Checkpoint } from "./types";

// The checkpoint's marker (nightshift backlog 104, pass 3).
const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  index: 2,
  uuid: "063ced21",
  resolved_in: "sess-1",
  set_by: "auto",
  at_ms: 1,
  ...over,
});

describe("checkpointOwner", () => {
  it("is the last user message at or before the checkpoint's event", () => {
    // Log: 0 created, 1 user, 2 reply, 3 user, 4 reply.
    expect(checkpointOwner([1, 3], cp({ index: 2 }))).toBe(1);
    expect(checkpointOwner([1, 3], cp({ index: 1 }))).toBe(1);
    expect(checkpointOwner([1, 3], cp({ index: 3 }))).toBe(3);
    expect(checkpointOwner([1, 3], cp({ index: 9 }))).toBe(3);
  });
  it("is null without a checkpoint or before the first message", () => {
    expect(checkpointOwner([1, 3], null)).toBeNull();
    expect(checkpointOwner([1, 3], cp({ index: 0 }))).toBeNull();
    expect(checkpointOwner([], cp())).toBeNull();
  });
});

describe("checkpointLine", () => {
  it("says who set it and whether the CLI's history has it yet", () => {
    expect(checkpointLine(cp(), false)).toBe("helpers fork from here");
    expect(checkpointLine(cp({ uuid: null }), false)).toBe("helpers fork from here · pending");
    expect(checkpointLine(cp(), true)).toContain("set at the first exchange");
    expect(checkpointLine(cp({ set_by: "user" }), true)).toContain("moved here by you");
    expect(checkpointLine(cp({ uuid: null }), true)).toContain("not yet in Claude Code's history");
    expect(checkpointLine(cp(), true)).not.toContain("not yet");
  });
});
