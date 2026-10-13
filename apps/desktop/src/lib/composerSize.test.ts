import { describe, expect, it } from "vitest";
import { growHeight } from "./boxGrow";
import { SentSinceDrag } from "./composerSize";

describe("a dragged composer height after a send (backlog 254)", () => {
  it("holds the empty box open until a send, then only caps it", () => {
    const s = new SentSinceDrag();
    expect(s.floor("c1", 300)).toBe(300);
    s.sent("c1");
    expect(s.floor("c1", 300)).toBeNull();
    // Another chat's floor is its own.
    expect(s.floor("c2", 200)).toBe(200);
  });

  it("a new drag makes it a floor again", () => {
    const s = new SentSinceDrag();
    s.sent("c1");
    s.sized("c1");
    expect(s.floor("c1", 300)).toBe(300);
  });

  it("the box shrinks to its text after a send but still grows up to the dragged height", () => {
    const s = new SentSinceDrag();
    const dragged = 300;
    const cap = Math.max(160, dragged); // the composer's cap never sits under the drag
    s.sent("c1");
    const min = s.floor("c1", dragged) ?? 0;
    expect(growHeight(26, min, cap)).toBe(26); // empty: one line
    expect(growHeight(250, min, cap)).toBe(250); // typing grows it
    expect(growHeight(900, min, cap)).toBe(300); // up to his size, then scrolls
  });
});
