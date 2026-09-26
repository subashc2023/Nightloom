import { describe, expect, it } from "vitest";
import { routeNote } from "./askNote";

// The note on an interruption card (nightshift backlog 084 pass 2): with a
// refusing button it is the deny reason the model reads now; with an
// accepting one it is held as his next message. These pin that split and
// the two edges — the refusal's fallback sentence, and that an accepting
// decision never puts anything in `reason`.

describe("routeNote", () => {
  it("a refusing decision carries the note as the reason", () => {
    expect(routeNote("deny", "  not now  ")).toEqual({ reason: "not now" });
  });

  it("a refusal with no note takes the card's fallback sentence", () => {
    expect(routeNote("deny", "", "the user skipped the question; decide yourself")).toEqual({
      reason: "the user skipped the question; decide yourself",
    });
    expect(routeNote("deny", "   ")).toEqual({});
  });

  it("an accepting decision holds the note as the next message, never as a reason", () => {
    expect(routeNote("allow", "keep the wording identical")).toEqual({
      enqueue: "keep the wording identical",
    });
    expect(routeNote("always", "and log it")).toEqual({ enqueue: "and log it" });
    expect(routeNote("allow", "x").reason).toBeUndefined();
  });

  it("an accepting decision with an empty note sends nothing", () => {
    expect(routeNote("allow", "")).toEqual({});
    expect(routeNote("allow", "  ", "unused fallback")).toEqual({});
  });
});
