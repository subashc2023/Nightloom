import { describe, expect, it } from "vitest";
import { TurnClock, hasText, type WindowMarks } from "./turnTiming";

// The window's half of the timing line (nightshift item 256): one report
// per turn, at the first paint or at the turn's end, never both.
function clock() {
  const sent: WindowMarks[] = [];
  return { c: new TurnClock((m) => sent.push(m)), sent };
}

describe("TurnClock", () => {
  it("reports Send, the call and the first paint once, at the paint", () => {
    const { c, sent } = clock();
    c.sent(1000);
    c.invoked("k1", 1007);
    expect(c.waitingForPaint()).toBe(true);
    c.painted(2500);
    c.painted(2600);
    c.ended("k1");
    expect(sent).toEqual([{ key: "k1", sent: 1000, invoked: 1007, painted: 2500 }]);
    expect(c.waitingForPaint()).toBe(false);
  });

  it("reports at the end with no paint when no text was drawn", () => {
    const { c, sent } = clock();
    c.sent(10);
    c.invoked("k2", 12);
    c.ended("k2");
    expect(sent).toEqual([{ key: "k2", sent: 10, invoked: 12, painted: null }]);
  });

  it("a paint belongs to the latest turn on screen, not an earlier one", () => {
    const { c, sent } = clock();
    c.sent(1);
    c.invoked("a", 2);
    c.sent(5);
    c.invoked("b", 6);
    c.painted(9);
    c.ended("a");
    c.ended("b");
    expect(sent).toEqual([
      { key: "b", sent: 5, invoked: 6, painted: 9 },
      { key: "a", sent: 1, invoked: 2, painted: null },
    ]);
  });

  it("without a Send mark the call stands in for it, and a paint with no turn is ignored", () => {
    const { c, sent } = clock();
    c.painted(3);
    c.invoked("q", 40);
    c.ended("q");
    expect(sent).toEqual([{ key: "q", sent: 40, invoked: 40, painted: null }]);
  });
});

describe("hasText", () => {
  it("is true only once a text segment has words", () => {
    expect(hasText(null)).toBe(false);
    expect(hasText([{ kind: "notice", text: "Council" }])).toBe(false);
    expect(hasText([{ kind: "text", text: "" }])).toBe(false);
    expect(hasText([{ kind: "thinking", text: "hm" }, { kind: "text", text: "Hi" }])).toBe(true);
  });
});
