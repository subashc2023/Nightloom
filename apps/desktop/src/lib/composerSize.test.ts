import { describe, expect, it } from "vitest";
import { growHeight } from "./boxGrow";
import { SentSinceDrag } from "./composerSize";

describe("a dragged composer height after a send (backlog 254)", () => {
  it("holds the empty box open until a send, then only caps it", () => {
    const s = new SentSinceDrag();
    s.sized("c1");
    s.sized("c2");
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

describe("an empty box after leaving the chat it was dragged in (item 849)", () => {
  const dragged = 300;
  const cap = Math.max(160, dragged);
  const oneLine = 26;

  it("a chat switch or hand-off ends the hold: back, the empty box is one line", () => {
    const s = new SentSinceDrag();
    s.sized("c1");
    expect(growHeight(oneLine, s.floor("c1", dragged) ?? 0, cap)).toBe(300);
    s.left("c1"); // switched away, or handed off to the next chat
    expect(s.floor("c1", dragged)).toBeNull();
    expect(growHeight(oneLine, s.floor("c1", dragged) ?? 0, cap)).toBe(oneLine);
  });

  it("a relaunch holds nothing open: an unknown key is no floor", () => {
    const s = new SentSinceDrag();
    expect(s.floor("c1", dragged)).toBeNull();
    expect(growHeight(oneLine, s.floor("c1", dragged) ?? 0, cap)).toBe(oneLine);
  });

  it("a draft keeps its height, up to the dragged ceiling", () => {
    const s = new SentSinceDrag();
    s.sized("c1");
    s.left("c1");
    const min = s.floor("c1", dragged) ?? 0;
    expect(growHeight(250, min, cap)).toBe(250);
    expect(growHeight(900, min, cap)).toBe(300);
  });

  it("leaving one chat leaves another's hold alone, and a new drag holds again", () => {
    const s = new SentSinceDrag();
    s.sized("c1");
    s.sized("aside:a1");
    s.left("c1");
    expect(s.floor("aside:a1", 120)).toBe(120);
    s.sized("c1");
    expect(s.floor("c1", dragged)).toBe(dragged);
  });
});
