import { describe, expect, it } from "vitest";
import { hasUsage, stopNote } from "./replyFooter";

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
});
