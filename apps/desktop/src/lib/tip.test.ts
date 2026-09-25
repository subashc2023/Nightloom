import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import topBarSrc from "./TopBar.svelte?raw";
import composerSrc from "./Composer.svelte?raw";
import { coolTips, placeTip, TIP_DELAY_MS, TIP_WARM_MS, tipTimer } from "./tip";

// Nightshift backlog 171 pass 1: the pill's placement and its timing.

const VW = 1200;
const VH = 800;
const box = (left: number, top: number, w = 40, h = 24) => ({ left, top, right: left + w, bottom: top + h });

describe("placeTip", () => {
  it("sits above the anchor, centred, when there is room", () => {
    const p = placeTip(box(500, 400), 200, 30, VW, VH);
    expect(p.side).toBe("above");
    expect(p.top).toBe(400 - 6 - 30);
    expect(p.left).toBe(520 - 100);
  });

  it("goes below an anchor at the top of the window (the top bar)", () => {
    const p = placeTip(box(500, 10), 200, 30, VW, VH);
    expect(p.side).toBe("below");
    expect(p.top).toBe(34 + 6);
  });

  it("stays above an anchor at the bottom of the window (the composer)", () => {
    const p = placeTip(box(500, VH - 30), 200, 60, VW, VH);
    expect(p.side).toBe("above");
    expect(p.top + 60).toBeLessThanOrEqual(VH - 30);
  });

  it("is clamped inside either edge", () => {
    expect(placeTip(box(2, 400), 300, 30, VW, VH).left).toBe(8);
    const right = placeTip(box(VW - 20, 400, 18), 300, 30, VW, VH);
    expect(right.left + 300).toBeLessThanOrEqual(VW - 8);
  });

  it("starts at the margin when wider than the window", () => {
    expect(placeTip(box(100, 400), 2000, 30, VW, VH).left).toBe(8);
  });

  it("with no room either side, takes the roomier one and keeps its top on screen", () => {
    const tall = placeTip(box(500, 300), 200, 700, VW, VH);
    expect(tall.side).toBe("below");
    expect(tall.top).toBeGreaterThanOrEqual(8);
    expect(tall.top + 700).toBeLessThanOrEqual(VH - 8);
  });
});

describe("tipTimer", () => {
  let t = 0;
  const now = () => t;
  beforeEach(() => {
    vi.useFakeTimers();
    coolTips();
    t = 10_000;
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    const log: string[] = [];
    const timer = tipTimer({ show: () => log.push("show"), hide: () => log.push("hide"), now });
    return { timer, log };
  }
  const advance = (ms: number) => {
    t += ms;
    vi.advanceTimersByTime(ms);
  };

  it("hover shows after the delay, not before", () => {
    const { timer, log } = make();
    timer.enter();
    advance(TIP_DELAY_MS - 1);
    expect(log).toEqual([]);
    advance(1);
    expect(log).toEqual(["show"]);
    expect(timer.shown).toBe(true);
  });

  it("the delay is well under the OS's second", () => {
    expect(TIP_DELAY_MS).toBeLessThanOrEqual(350);
  });

  it("leaving before the delay shows nothing", () => {
    const { timer, log } = make();
    timer.enter();
    advance(50);
    timer.leave();
    advance(1000);
    expect(log).toEqual([]);
  });

  it("keyboard focus shows at once", () => {
    const { timer, log } = make();
    timer.focus();
    expect(log).toEqual(["show"]);
  });

  it("a press hides it and cancels a pending show", () => {
    const { timer, log } = make();
    timer.enter();
    advance(TIP_DELAY_MS);
    timer.dismiss();
    expect(log).toEqual(["show", "hide"]);
    timer.enter();
    timer.dismiss();
    advance(1000);
    expect(log).toEqual(["show", "hide"]);
  });

  it("the next control within the warm window shows at once", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.leave();
    advance(TIP_WARM_MS - 10);
    b.timer.enter();
    expect(b.log).toEqual(["show"]);
  });

  it("after the warm window, the next waits the delay again", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.leave();
    advance(TIP_WARM_MS + 10);
    b.timer.enter();
    expect(b.log).toEqual([]);
    advance(TIP_DELAY_MS);
    expect(b.log).toEqual(["show"]);
  });

  it("a press cools the run", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.dismiss();
    b.timer.enter();
    expect(b.log).toEqual([]);
  });
});

describe("the top bar and the composer", () => {
  // Pass 1's surfaces carry no native `title=` (the OS box would double
  // the pill); pass 2 extends this to every file.
  for (const [file, src] of [
    ["TopBar.svelte", topBarSrc],
    ["Composer.svelte", composerSrc],
  ] as const) {
    it(`${file} has no title= attribute`, () => {
      expect(src.match(/\stitle=["{]/g) ?? []).toEqual([]);
      expect(src).toContain("use:tip=");
    });
  }
});
