import { describe, expect, it } from "vitest";
import { handoffChildren, handoffCue, handoffCueTip, pastByTokens, type SessionMetaLike } from "./chatList";

// Item 597: the chat row's left-edge cue — handed off vs needs a hand-off.
const NEVER = 2;
const chat = (id: string, over: Partial<SessionMetaLike> = {}): SessionMetaLike => ({
  id,
  title: id,
  first_user: null,
  ...over,
});

describe("handoffCue", () => {
  const sessions = [
    chat("a"),
    chat("a2", { title: "A, part two", forked_from: { session: "a", index: 40, reason: "handoff" } }),
    chat("a3", { title: "A, part three", forked_from: { session: "a", index: 60, reason: "handoff" } }),
    chat("b"),
    chat("bfork", { forked_from: { session: "b", index: 3 } }),
  ];
  const kids = handoffChildren(sessions);

  it("marks a chat a next chat continues as handed off, naming the newest one", () => {
    const cue = handoffCue("a", kids, false, false);
    expect(cue?.kind).toBe("handed");
    expect(cue && cue.kind === "handed" ? cue.next.id : null).toBe("a3");
    expect(handoffCueTip(cue!)).toBe("Handed off: its next chat, “A, part three”, has started from it.");
  });

  it("handed off wins over past the mark", () => {
    expect(handoffCue("a", kids, true, false)?.kind).toBe("handed");
  });

  it("marks a chat past its mark and not handed off as needing one", () => {
    const cue = handoffCue("b", kids, true, false);
    expect(cue).toEqual({ kind: "needs" });
    expect(handoffCueTip(cue!)).toContain("past its hand-off mark");
  });

  it("an edit-and-send fork is not a hand-off; under the mark, or never, there is no cue", () => {
    expect(handoffCue("b", kids, false, false)).toBeNull();
    expect(handoffCue("b", kids, true, true)).toBeNull();
    expect(handoffCue("x", kids, false, false)).toBeNull();
  });
});

describe("pastByTokens", () => {
  it("compares the listing's fill with the cap when the chat has no mark of its own", () => {
    expect(pastByTokens(310_000, null, 300_000, NEVER)).toBe(true);
    expect(pastByTokens(299_999, null, 300_000, NEVER)).toBe(false);
    expect(pastByTokens(900_000, null, 0, NEVER)).toBe(false); // cap off: needs the window, not guessed
  });
  it("uses the chat's own mark when it is a token count, and never guesses a share", () => {
    expect(pastByTokens(150_000, 120_000, 300_000, NEVER)).toBe(true);
    expect(pastByTokens(150_000, 0.5, 300_000, NEVER)).toBe(false);
    expect(pastByTokens(999_999, NEVER, 300_000, NEVER)).toBe(false);
  });
  it("is false with no reply yet", () => {
    expect(pastByTokens(undefined, null, 300_000, NEVER)).toBe(false);
  });
});
