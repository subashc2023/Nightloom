import { describe, expect, it } from "vitest";
import { SpeedMeter, TraceBook, barOf, fmtSecs, sparkPoints, stepKeys, type TraceRecord } from "./turnTiming";

// Item 564: the turn trace's clock and the stream speed.
const tool = (id: string, done = false) => ({ kind: "tool", call: { id, result: done ? { content: "", is_error: false } : null } });
const think = (done = false) => ({ kind: "thinking", done, text: "" });
const text = () => ({ kind: "text", text: "hi" });
const rec = (t0 = 0): TraceRecord => ({ t0, t1: null, steps: {}, tps: null });

describe("stepKeys", () => {
  it("keys a call by its id and a thinking block by the call after it", () => {
    expect(stepKeys([think(), think(), tool("a"), text(), think(), tool("b"), think()])).toEqual([
      "k:a:1", "k:a:0", "t:a", null, "k:b:0", "t:b", "k:$:0",
    ]);
  });
  it("gives a recorded reply split per API call the same keys as the live turn", () => {
    const live = stepKeys([think(), tool("a"), think(), tool("b")]);
    const r1 = stepKeys([think(), tool("a")]);
    const r2 = stepKeys([think(), tool("b")]);
    expect([...r1, ...r2]).toEqual(live);
  });
});

describe("TraceBook", () => {
  it("stamps a step when first seen and again when done; a recorded reply finds them", () => {
    const b = new TraceBook();
    const r = rec(1000);
    const th = think();
    const segs: object[] = [th];
    b.observe(r, segs as never, 1000);
    expect(r.steps["k:$:0"]).toEqual({ start: 1000, end: null });
    th.done = true;
    const a = tool("a");
    segs.push(a);
    b.observe(r, segs as never, 4000);
    // The thinking block re-anchored to the call after it, its times kept.
    expect(r.steps).toEqual({ "k:a:0": { start: 1000, end: 4000 }, "t:a": { start: 4000, end: null } });
    a.call.result = { content: "", is_error: false };
    b.observe(r, segs as never, 6000);
    b.close(r, 7000);
    expect(r.steps["t:a"]).toEqual({ start: 4000, end: 6000 });
    expect(r.t1).toBe(7000);
    expect(b.find([think(true), tool("a", true)] as never)).toBe(r);
    expect(b.find([text()] as never)).toBeNull();
  });
  it("gives no stamp to a step already done at the first look at a turn under way", () => {
    const b = new TraceBook();
    const r = rec(0);
    b.observe(r, [tool("x", true), tool("y")] as never, 500, true);
    expect(r.steps["t:x"]).toBeUndefined();
    expect(r.steps["t:y"]).toEqual({ start: 500, end: null });
  });
  it("closes steps still open with the turn", () => {
    const b = new TraceBook();
    const r = rec(0);
    b.observe(r, [tool("z")] as never, 100);
    b.close(r, 900);
    expect(r.steps["t:z"].end).toBe(900);
  });
});

describe("barOf and fmtSecs", () => {
  it("places a bar as shares of the turn, with a minimum tick", () => {
    expect(barOf({ start: 2000, end: 4000 }, 0, 10000)).toEqual({ left: 0.2, width: 0.2 });
    expect(barOf({ start: 5000, end: null }, 0, 10000)).toEqual({ left: 0.5, width: 0.5 });
    expect(barOf({ start: 9999, end: 9999 }, 0, 10000)!.width).toBe(0.015);
    expect(barOf({ start: 9999, end: 9999 }, 0, 10000)!.left).toBeCloseTo(0.985);
    expect(barOf(undefined, 0, 1)).toBeNull();
  });
  it("says seconds to a tenth, minutes past sixty", () => {
    expect(fmtSecs(11800)).toBe("11.8 s");
    expect(fmtSecs(123400)).toBe("2 min 3 s");
  });
});

describe("SpeedMeter", () => {
  it("averages tokens a second over the seconds that streamed, at four characters a token", () => {
    const m = new SpeedMeter();
    expect(m.rate()).toBeNull();
    m.sample(0, 0);
    m.sample(160, 1000); // 40 tok/s
    m.sample(160, 2000); // a pause: not in the average
    m.sample(320, 3000); // 40 tok/s
    expect(m.samples).toEqual([40, 0, 40]);
    expect(m.rate()).toBe(40);
  });
  it("keeps only the newest samples", () => {
    const m = new SpeedMeter(3);
    for (let i = 0; i <= 5; i++) m.sample(i * 4, i * 1000);
    expect(m.samples.length).toBe(3);
  });
  it("draws the sparkline right-aligned, empty under two samples", () => {
    expect(sparkPoints([5], 60, 12)).toBe("");
    const pts = sparkPoints([0, 10], 60, 12, 4).split(" ");
    expect(pts).toEqual(["40.0,11.0", "60.0,1.0"]);
  });
});
