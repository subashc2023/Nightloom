// Item 617 — Line reveal: the edge's motion (an eased speed ~0.2 s behind the stream, never ahead of it), a burst
// showing but its tail, the mask's geometry, the setting, and the wiring of the theme's motion colour. The DOM side
// (the mask on screen, the shuttle on the edge, frame cost) is measured in WebKit (notes/runner-design/617-report-2026-11-11.md).
import { describe, expect, it } from "vitest";
import am from "./AssistantMessage.svelte?raw";
import amc from "./AssistantMessageClassic.svelte?raw";
import {
  currentReplyLook,
  LINE_BURST_CHARS,
  LINE_LAG_S,
  LINE_STEP_MS,
  lineMask,
  parseReplyLook,
  retarget,
  stepReveal,
  type Reveal,
} from "./replyMotion";

const fresh = (): Reveal => ({ r: 0, v: 0, target: 0 });

/** A stream of `cps` characters a second in deltas every `every` ms, frames every 16.7 ms, for `ms`; returns the reveal and its log. */
function stream(cps: number, every: number, ms: number) {
  const st = fresh();
  const log: { t: number; r: number; target: number }[] = [];
  let sent = 0;
  for (let t = 0; t <= ms; t += 16.7) {
    const due = Math.floor(t / every) * every;
    const n = Math.floor((due / 1000) * cps);
    if (n > sent) {
      sent = n;
      retarget(st, n);
    }
    stepReveal(st, 16.7);
    log.push({ t, r: st.r, target: st.target });
  }
  return { st, log };
}

describe("stepReveal — the edge", () => {
  it("never runs ahead of the text that has arrived", () => {
    const { log } = stream(80, 40, 3000);
    for (const x of log) expect(x.r).toBeLessThanOrEqual(x.target + 1e-9);
  });
  it("trails a steady stream by about LINE_LAG_S", () => {
    const { st } = stream(80, 40, 3000);
    const lagS = (st.target - st.r) / 80;
    expect(lagS).toBeGreaterThan(LINE_LAG_S * 0.4);
    expect(lagS).toBeLessThan(LINE_LAG_S * 2.5);
  });
  it("moves at an even speed, not in token-shaped jumps", () => {
    // Deltas of 12 characters every 150 ms (bursty tokens): per-frame steps stay smooth.
    const { log } = stream(80, 150, 4000);
    const steps = log.slice(60).map((x, i, a) => (i ? x.r - a[i - 1].r : 0)).slice(1);
    const max = Math.max(...steps);
    // A delta is 12 characters; no frame shows more than a third of one.
    expect(max).toBeLessThan(4);
  });
  it("lands on the end once the stream stops", () => {
    const st = fresh();
    retarget(st, 200);
    for (let t = 0; t < 3000; t += LINE_STEP_MS) stepReveal(st, LINE_STEP_MS);
    expect(st.r).toBe(200);
  });
  it("a long frame is integrated in steps, capped (a hidden window coming back does not jump the speed)", () => {
    const a = fresh();
    retarget(a, 100);
    stepReveal(a, 5000);
    const b = fresh();
    retarget(b, 100);
    for (let t = 0; t < 200; t += LINE_STEP_MS) stepReveal(b, Math.min(LINE_STEP_MS, 200 - t));
    expect(a.r).toBeCloseTo(b.r, 0);
  });
});

describe("retarget", () => {
  it("shrinks with text the markdown rewrote shorter (a closed **bold**)", () => {
    const st: Reveal = { r: 50, v: 100, target: 52 };
    retarget(st, 48);
    expect(st.r).toBe(48);
    expect(st.target).toBe(48);
  });
  it("a burst (text after thinking) shows at once but for its last LINE_BURST_CHARS", () => {
    const st = fresh();
    retarget(st, 2400);
    expect(st.r).toBe(2400 - LINE_BURST_CHARS);
  });
  it("an ordinary delta does not skip", () => {
    const st: Reveal = { r: 100, v: 0, target: 110 };
    retarget(st, 130);
    expect(st.r).toBe(100);
  });
});

describe("lineMask", () => {
  it("shows everything above the edge's line, the line up to x behind a soft edge, nothing after", () => {
    const m = lineMask(40, 20, 300);
    expect(m).toContain("0 0 / 100% 40.0px no-repeat");
    // The soft edge is 3 line heights: 70 % before x, 30 % after.
    expect(m).toContain("#000 258.0px, transparent 318.0px) 0 40.0px / 100% 20.0px no-repeat");
  });
  it("never a negative band", () => {
    expect(lineMask(-3, 20, 10)).toContain("100% 0.0px");
  });
});

describe("the setting", () => {
  it("defaults to Line reveal; only 'words' picks the word rise", () => {
    expect(parseReplyLook(null)).toBe("line");
    expect(parseReplyLook("bogus")).toBe("line");
    expect(parseReplyLook("words")).toBe("words");
    expect(currentReplyLook()).toBe("line"); // no document, no storage
  });
});

describe("wiring", () => {
  it("the reply's shuttle and marks take the theme's motion colour (item 627)", () => {
    const rule = am.slice(am.indexOf(".assistant :global(.rm-shuttle) {"), am.indexOf("}", am.indexOf(".assistant :global(.rm-shuttle) {")));
    expect(rule).toContain("var(--motion-ink, var(--accent))");
    expect(rule).toContain("var(--motion-ink-hi");
    expect(rule).not.toMatch(/[^(]var\(--accent\) 70%/);
  });
  it("Classic's copies of the shared keyframes fall back to its accent, so they never paint amber over Filament", () => {
    for (const kf of ["rm-weft-under", "rm-needle", "rm-flash"]) {
      const i = amc.indexOf(`@keyframes -global-${kf}`);
      const blk = amc.slice(i, amc.indexOf("\n  }\n", i));
      expect(blk).toContain("var(--motion-ink, var(--accent))");
    }
  });
});
