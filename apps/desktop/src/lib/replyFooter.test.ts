import { describe, expect, it } from "vitest";
import { hasUsage, isStandIn, stopNote } from "./replyFooter";

describe("reply footer (backlog 332)", () => {
  it("shows no figure for a reply with no usage", () => {
    expect(hasUsage({ input_tokens: 0, output_tokens: 0 } as never)).toBe(false);
    expect(hasUsage(null)).toBe(false);
    expect(hasUsage({ input_tokens: 0, output_tokens: 12 } as never)).toBe(true);
  });
  it("says a cut-off reply was cut off, and why", () => {
    expect(stopNote("cut off: Claude Code's output ended before the reply finished (exit status: 0)")).toBe(
      "cut off · Claude Code's output ended before the reply finished (exit status: 0)",
    );
  });
  it("keeps the API error note and says nothing for a normal end", () => {
    expect(stopNote("error: Output blocked")).toBe("stopped · Output blocked");
    expect(stopNote("end_turn")).toBeNull();
    expect(stopNote(null)).toBeNull();
  });
  it("names a turn stopped before any reply (backlog 361)", () => {
    expect(stopNote("stopped")).toBe("stopped before a reply");
  });
  it("knows Nightloom's own stand-in from the model's words (backlog 407)", () => {
    expect(isStandIn(["Stopped before any reply arrived."], "stopped")).toBe(true);
    expect(isStandIn(["No reply: the CLI exited"], "error: exit 1")).toBe(true);
    // The model saying the same words in a reply that ended normally is its own.
    expect(isStandIn(["Stopped before any reply arrived."], "end_turn")).toBe(false);
    expect(isStandIn(["Stopped before any reply arrived.", "more"], "stopped")).toBe(false);
    expect(isStandIn(["Something else"], "stopped")).toBe(false);
  });
});
