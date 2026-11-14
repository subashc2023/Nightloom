// Item 667: a running step's motion eases in over its first 5 s.
import { describe, expect, it } from "vitest";
import { RAMP_MS, RAMP_START, rampOrigin, rampRate } from "./stepRamp";
import messageSrc from "./AssistantMessage.svelte?raw";
import previewSrc from "./StepMotionPreview.svelte?raw";

describe("the ramp's rate curve", () => {
  it("starts at RAMP_START and reaches today's pace at RAMP_MS (3.5 s)", () => {
    expect(RAMP_MS).toBe(3500);
    expect(rampRate(0)).toBe(RAMP_START);
    expect(rampRate(-50)).toBe(RAMP_START);
    expect(rampRate(RAMP_MS)).toBe(1);
    expect(rampRate(12_000)).toBe(1);
  });

  it("eases in: rises the whole way, slow first, quickest at the end", () => {
    for (const s of [0, 0.1, 0.2, 0.4]) {
      let last = -1;
      for (let t = 0; t <= RAMP_MS; t += 250) {
        const r = rampRate(t, s);
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
      // Ease-in: the first half gains a quarter of the way, the second three quarters.
      expect(rampRate(RAMP_MS / 2, s) - s).toBeCloseTo((1 - s) * 0.25, 6);
      expect(rampRate(1000, s) - rampRate(0, s)).toBeLessThan(rampRate(RAMP_MS, s) - rampRate(RAMP_MS - 1000, s));
    }
  });

  it("from still (0) is still at the first frame and at today's pace at the end", () => {
    expect(rampRate(0, 0)).toBe(0);
    expect(rampRate(4999, 0)).toBeGreaterThan(0.99);
  });
});

describe("which steps ramp", () => {
  it("a step that began in view ramps from its first sight; a remount goes on where it was", () => {
    const book = new Map<string, number | null>();
    expect(rampOrigin(book, "tool:a", true, 1000)).toBe(1000);
    // The empty Thinking row turning into the button, or a re-render: same origin, not now.
    expect(rampOrigin(book, "tool:a", true, 3000)).toBe(1000);
  });

  it("a step already running when the chat opens starts at 1×, and stays so", () => {
    const book = new Map<string, number | null>();
    expect(rampOrigin(book, "think:5", false, 1000)).toBeNull();
    expect(rampOrigin(book, "think:5", true, 1100)).toBeNull();
  });

  it("the book stays small", () => {
    const book = new Map<string, number | null>();
    for (let i = 0; i < 1000; i++) rampOrigin(book, `tool:${i}`, true, i);
    expect(book.size).toBeLessThanOrEqual(400);
    expect(book.has("tool:999")).toBe(true);
  });
});

describe("where the ramp is applied", () => {
  it("every running row (the empty Thinking row, a thinking block, a call) and the Settings preview", () => {
    expect(messageSrc.match(/use:stepRamp=\{rampThink\(/g)?.length).toBe(2);
    expect(messageSrc).toMatch(/use:stepRamp=\{rampTool\(seg\.call\.id, bornW, running\)\}/);
    expect(previewSrc).toMatch(/data-ramp-start=\{rampStart \?\? undefined\}/);
  });
});

describe("the action on a row (mock animations)", () => {
  it("ramps the row's looping animations, leaves one-shots alone, catches late joiners, ends at 1×", async () => {
    const { vi } = await import("vitest");
    const { stepRamp } = await import("./stepRamp");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const hadRaf = "requestAnimationFrame" in g;
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
    try {
      const anim = (iterations: number) => {
        const a = { playbackRate: 1, effect: { getTiming: () => ({ iterations }) }, updatePlaybackRate(r: number) { a.playbackRate = r; } };
        return a;
      };
      const loop = anim(Infinity);
      const once = anim(1);
      const anims = [loop, once];
      const node = { getAnimations: () => anims, closest: () => null } as unknown as HTMLElement;
      const act = stepRamp(node, { key: "tool:mock-1", fresh: true, live: true });
      expect(loop.playbackRate).toBeCloseTo(RAMP_START, 2);
      expect(once.playbackRate).toBe(1);
      vi.advanceTimersByTime(2500);
      expect(loop.playbackRate).toBeCloseTo(rampRate(2500), 1);
      const late = anim(Infinity);
      anims.push(late);
      vi.advanceTimersByTime(32);
      expect(late.playbackRate).toBeCloseTo(loop.playbackRate, 2);
      vi.advanceTimersByTime(3000);
      expect(loop.playbackRate).toBe(1);
      expect(late.playbackRate).toBe(1);
      act.destroy();

      // Already running when the chat opened: untouched, 1× throughout.
      const old = anim(Infinity);
      const node2 = { getAnimations: () => [old], closest: () => null } as unknown as HTMLElement;
      let asked = 0;
      old.updatePlaybackRate = () => void asked++;
      const act2 = stepRamp(node2, { key: "tool:mock-2", fresh: false, live: true });
      vi.advanceTimersByTime(1000);
      expect(asked).toBe(0);
      expect(old.playbackRate).toBe(1);
      act2.destroy();
    } finally {
      vi.useRealTimers();
      if (!hadRaf) delete g.requestAnimationFrame;
    }
  });
});
