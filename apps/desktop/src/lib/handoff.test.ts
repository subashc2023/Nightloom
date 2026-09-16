import { describe, expect, it } from "vitest";
import { RE_ASK, WRAP_UP, nextStage } from "./handoff.svelte";

// The context-full hand-off (nightshift backlog 086): the stage machine
// that decides when the wrap-up is asked, tested as the pure function it
// is — the running app could not be driven the night it was built.

describe("nextStage", () => {
  it("arms once the fill crosses the chat's threshold, and not before", () => {
    expect(nextStage("idle", 0.69, 0.7, 0)).toBe("idle");
    expect(nextStage("idle", 0.7, 0.7, 0)).toBe("due");
    expect(nextStage("idle", 0.95, 0.7, 0)).toBe("due");
  });

  it("holds due until a message carries the wrap-up, then wrapped after that turn", () => {
    expect(nextStage("due", 0.99, 0.7, 0)).toBe("due");
    expect(nextStage("wrapping", 0.8, 0.7, 0)).toBe("wrapped");
    expect(nextStage("wrapped", 0.8, 0.7, 0)).toBe("wrapped");
  });

  it("after Stay here, asks again only past the re-ask mark and higher than where it was dismissed", () => {
    // Dismissed at 72%: the same fill, and anything under 85%, is quiet.
    expect(nextStage("idle", 0.72, 0.7, 0.72)).toBe("idle");
    expect(nextStage("idle", 0.8, 0.7, 0.72)).toBe("idle");
    expect(nextStage("idle", RE_ASK, 0.7, 0.72)).toBe("due");
    // Dismissed at 90%: 88% does not re-ask, 91% does.
    expect(nextStage("idle", 0.88, 0.7, 0.9)).toBe("idle");
    expect(nextStage("idle", 0.91, 0.7, 0.9)).toBe("due");
  });

  it("respects a per-chat threshold lower or higher than the default", () => {
    expect(nextStage("idle", 0.05, 0.03, 0)).toBe("due");
    expect(nextStage("idle", 0.8, 0.9, 0)).toBe("idle");
  });
});

describe("the wrap-up text", () => {
  it("names the file, its contents and the stop, and says who added it", () => {
    expect(WRAP_UP).toContain("HANDOFF.md");
    expect(WRAP_UP).toContain("Added by Nightloom");
    for (const part of ["what we were doing", "what is done", "what is next", "files that matter"]) {
      expect(WRAP_UP).toContain(part);
    }
    expect(WRAP_UP).toMatch(/Then stop/);
  });
});
