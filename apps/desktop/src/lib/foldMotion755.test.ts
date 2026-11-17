// Item 755: one short fold motion for an aside's card and the hand-off card; none under reduce motion.
import { describe, expect, it, vi } from "vitest";
import { drawnRadius, FOLD_MS, foldKeyframes, foldMotion } from "./foldMotion";
import cardSrc from "./AsideCard.svelte?raw";
import buttonSrc from "./handoffButton.ts?raw";

describe("755: the keyframes", () => {
  it("are short: at most 250 ms", () => {
    expect(FOLD_MS).toBeGreaterThan(0);
    expect(FOLD_MS).toBeLessThanOrEqual(250);
  });
  it("tween height only when the width holds (the hand-off card)", () => {
    const k = foldKeyframes({ width: 760, height: 396 }, { width: 760, height: 31 })!;
    expect(k[0]).toMatchObject({ height: "396px", overflow: "hidden", maxHeight: "none" });
    expect(k[1]).toMatchObject({ height: "31px" });
    expect(k[0]).not.toHaveProperty("width");
  });
  it("folding to a narrower line: tween both, the card's width cap lifted", () => {
    const k = foldKeyframes({ width: 600, height: 300 }, { width: 280, height: 30 })!;
    expect(k[0]).toMatchObject({ width: "600px", maxWidth: "none", minWidth: "0px" });
    expect(k[1]).toMatchObject({ width: "280px", height: "30px" });
    expect(k[0]).not.toHaveProperty("clipPath");
  });
  it("opening to a wider card: the width is laid out at once and a clip opens it, never a narrow layout", () => {
    const k = foldKeyframes({ width: 280, height: 30, radius: 10 }, { width: 440, height: 419, radius: 10 })!;
    expect(k[0]).not.toHaveProperty("width");
    expect(k[0]).toMatchObject({ height: "30px", clipPath: "inset(0px 160px 0px 0px round 10px)" });
    expect(k[1]).toMatchObject({ height: "419px", clipPath: "inset(0px 0px 0px 0px round 10px)" });
  });
  it("tween the corners from the radius drawn before to the one after (Jarvis's pill)", () => {
    const from = { width: 440, height: 419, radius: drawnRadius("10px", { width: 440, height: 419 }) };
    const to = { width: 282, height: 30, radius: drawnRadius("999px", { width: 282, height: 30 }) };
    const k = foldKeyframes(from, to)!;
    expect(k[0]).toMatchObject({ borderRadius: "10px" });
    expect(k[1]).toMatchObject({ borderRadius: "15px" });
    expect(foldKeyframes({ width: 760, height: 396, radius: 8 }, { width: 760, height: 31, radius: 8 })![0]).not.toHaveProperty("borderRadius");
  });
  it("are none when nothing moved", () => {
    expect(foldKeyframes({ width: 100, height: 20 }, { width: 100.2, height: 20.3 })).toBeNull();
  });
});

describe("755: foldMotion", () => {
  const fakeEl = (sizes: { width: number; height: number }[]) => {
    let i = 0;
    const animate = vi.fn();
    (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({ borderTopLeftRadius: "8px" });
    const el = {
      isConnected: true,
      getBoundingClientRect: () => sizes[Math.min(i++, sizes.length - 1)],
      getAnimations: () => [],
      animate,
    };
    return { el: el as unknown as HTMLElement, animate };
  };
  it("makes the change, then tweens from the old size to the new", async () => {
    const { el, animate } = fakeEl([{ width: 760, height: 396 }, { width: 760, height: 31 }]);
    const change = vi.fn();
    await foldMotion(el, change);
    expect(change).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: FOLD_MS });
  });
  it("only makes the change under reduce motion", async () => {
    (globalThis as unknown as { window: unknown }).window = { __sendMotionReduce: true };
    try {
      const { el, animate } = fakeEl([{ width: 760, height: 396 }, { width: 760, height: 31 }]);
      const change = vi.fn();
      await foldMotion(el, change);
      expect(change).toHaveBeenCalledOnce();
      expect(animate).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
  it("without an element, only makes the change", async () => {
    const change = vi.fn();
    await foldMotion(null, change);
    expect(change).toHaveBeenCalledOnce();
  });
});

describe("755: both cards use it", () => {
  it("the aside's minimize and expand", () => {
    expect(cardSrc).toContain('import { foldMotion } from "./foldMotion"');
    expect(cardSrc).toContain("onclick={() => minimizeMoving()}");
    expect(cardSrc).toContain("onclick={() => expandMoving()}");
  });
  it("the hand-off card's fold", () => {
    expect(buttonSrc).toContain("void foldMotion(card, () => paintCard(card, on))");
  });
});
