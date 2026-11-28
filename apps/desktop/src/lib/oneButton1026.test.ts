/**
 * Item 1026 (his pick B): the bell and the Needs-you pill as one button — the face, and which mode a click opens.
 */
import { describe, expect, it } from "vitest";
import { faceOf, openingMode } from "./oneButton";

describe("1026: the one button", () => {
  it("the number always wins; else the bell with its dot; else the bell alone", () => {
    expect(faceOf({ n: 3, word: "need you", waiting: true }, true)).toEqual({ kind: "needs", n: 3, word: "need you" });
    expect(faceOf(null, true)).toEqual({ kind: "bell", fresh: true, review: false });
    expect(faceOf(null, false)).toEqual({ kind: "bell", fresh: false, review: false });
    // 968: only reviews left — no number, the words ride beside the bell.
    expect(faceOf({ n: 0, word: "to review", waiting: false }, false)).toEqual({ kind: "bell", fresh: false, review: true });
  });

  it("opens on the mode he last used, unless the number grew since he looked", () => {
    expect(openingMode("digest", 2, 2)).toBe("digest");
    expect(openingMode("digest", 3, 2)).toBe("needs");
    expect(openingMode("needs", 0, 4)).toBe("needs");
    expect(openingMode("digest", 1, 4)).toBe("digest");
  });
});
