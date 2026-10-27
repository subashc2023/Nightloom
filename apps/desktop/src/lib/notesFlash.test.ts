import { describe, expect, it } from "vitest";
import { NOTICE_MS, centredScrollTop, flashPlan } from "./notesDrop";

// Item 416: after a keep, scroll to the kept row and flash it.
describe("flashPlan", () => {
  const names = ["a.md", "files/x.pdf", "files/y.pdf", "z.md"];
  it("scrolls to and flashes one kept file", () => {
    expect(flashPlan([{ rel: "files/y.pdf", at: 100 }], names, 200)).toEqual({ scrollTo: "files/y.pdf", flash: ["files/y.pdf"] });
  });
  it("flashes every kept file and scrolls to the top-most", () => {
    const n = [{ rel: "files/y.pdf", at: 0 }, { rel: "files/x.pdf", at: 0 }];
    expect(flashPlan(n, names, 10)).toEqual({ scrollTo: "files/x.pdf", flash: ["files/x.pdf", "files/y.pdf"] });
  });
  it("flashes a file kept twice (already there) once", () => {
    const n = [{ rel: "files/x.pdf", at: 0 }, { rel: "files/x.pdf", at: 5 }];
    expect(flashPlan(n, names, 10).flash).toEqual(["files/x.pdf"]);
  });
  it("skips a file not in the list and a stale notice", () => {
    expect(flashPlan([{ rel: "files/gone.pdf", at: 0 }], names, 1)).toEqual({ scrollTo: null, flash: [] });
    expect(flashPlan([{ rel: "files/x.pdf", at: 0 }], names, NOTICE_MS + 1)).toEqual({ scrollTo: null, flash: [] });
  });
});

describe("centredScrollTop", () => {
  it("puts the row's middle at the box's middle", () => {
    // row 1000 px below the box top, 40 tall, box 400: top 1000 - 180
    expect(centredScrollTop(0, 1000, 40, 400, 3000)).toBe(820);
    expect(centredScrollTop(500, 500, 40, 400, 3000)).toBe(820);
  });
  it("clamps at the top and the bottom", () => {
    expect(centredScrollTop(0, 20, 40, 400, 3000)).toBe(0);
    expect(centredScrollTop(0, 2950, 40, 400, 3000)).toBe(2600);
  });
});
