import { describe, expect, it } from "vitest";
import transcriptSrc from "./Transcript.svelte?raw";
import {
  FULL_WEIGHT_CHARS,
  MIN_TICKS,
  MIN_WEIGHT,
  RIB_CURRENT,
  RIB_END,
  RIB_GAP,
  RIB_MESSAGE,
  RIB_ROW,
  activeTick,
  anchorSelector,
  animateScroll,
  columnFollow,
  easeOutCubic,
  firstLine,
  inViewRange,
  liveTick,
  magnified,
  magnifyFalloff,
  nextTarget,
  prevTarget,
  previewOf,
  previewText,
  ribBox,
  ribDims,
  snapPx,
  snapScroll,
  stepTick,
  ticks,
  weightOf,
} from "./navigator";
import { liveFlags } from "./state.svelte";
import type { SessionEvent } from "./types";

// The navigator's model (nightshift backlog 065): one tick per live
// message, width from length on a log scale, the first line for the
// bubble, and which one counts as "being read".

const at = "2026-09-15T10:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (text: string, tool = false): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks: [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...(tool ? [{ type: "tool_use" as const, id: "c1", name: "read_file", input: {} }] : []),
  ],
  stop_reason: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  at,
});

describe("ticks", () => {
  it("gives one tick per user or assistant message and nothing for the rest", () => {
    const log: SessionEvent[] = [
      { event: "session_created", id: "s", at },
      user("hi"),
      reply("hello", true),
      { event: "tool_result", tool_use_id: "c1", name: "read_file", content: "x", at },
      { event: "compaction", summary: "…", at } as SessionEvent,
      user("more"),
    ];
    const t = ticks(log, liveFlags(log));
    expect(t.map((x) => [x.index, x.role])).toEqual([
      [1, "user"],
      [2, "assistant"],
      [5, "user"],
    ]);
  });

  it("excludes rewound turns", () => {
    const log: SessionEvent[] = [
      { event: "session_created", id: "s", at },
      user("first"),
      reply("one"),
      user("second"),
      reply("two"),
      { event: "rewind", to: 3, at },
      user("third"),
    ];
    const t = ticks(log, liveFlags(log));
    expect(t.map((x) => x.index)).toEqual([1, 2, 6]);
  });

  it("weights by length on a log scale, clamped to [0.25, 1]", () => {
    const log: SessionEvent[] = [user(""), user("x".repeat(40)), user("x".repeat(FULL_WEIGHT_CHARS * 10))];
    const [a, b, c] = ticks(log, liveFlags(log));
    expect(a.weight).toBe(MIN_WEIGHT);
    expect(b.weight).toBeGreaterThan(MIN_WEIGHT);
    expect(b.weight).toBeLessThan(1);
    expect(c.weight).toBe(1);
    expect(weightOf(FULL_WEIGHT_CHARS)).toBeCloseTo(1, 6);
    // Log, not linear: ten times the text is not ten times the width.
    expect(weightOf(400) - weightOf(40)).toBeLessThan(weightOf(40) - weightOf(4) + 0.05);
  });

  it("takes the first non-empty line for the bubble and cuts a long one", () => {
    const log: SessionEvent[] = [user("\n\n  Okay   honestly I'm confused.\nSecond line"), reply("y".repeat(300))];
    const [a, b] = ticks(log, liveFlags(log));
    expect(a.first_line).toBe("Okay honestly I'm confused.");
    expect(b.first_line.endsWith("…")).toBe(true);
    expect(b.first_line.length).toBeLessThanOrEqual(140);
    expect(firstLine("")).toBe("");
  });

  it("names a tool-only reply rather than showing nothing", () => {
    const log: SessionEvent[] = [reply("", true)];
    expect(ticks(log, liveFlags(log))[0].first_line).toBe("(1 tool call)");
  });

  it("prefers the edited wording when given one", () => {
    const log: SessionEvent[] = [user("old words"), reply("old reply")];
    const t = ticks(log, liveFlags(log), ["new words", null]);
    expect(t[0].first_line).toBe("new words");
    expect(t[1].first_line).toBe("old reply");
  });
});

describe("activeTick", () => {
  it("is the last tick whose top is at or above the reading line", () => {
    // Viewport 600 tall, scrolled to 1000: the line is 48 under the edge.
    expect(activeTick([0, 500, 1040, 1900], 1000, 600, 5000)).toBe(2);
    expect(activeTick([0, 500, 1060, 1900], 1000, 600, 5000)).toBe(1);
    // At the top of a chat the first message is the one being read.
    expect(activeTick([28, 500, 1150, 1900], 0, 600, 5000)).toBe(0);
    expect(activeTick([], 0, 600)).toBeNull();
  });

  it("is the last message at the foot, however short it is", () => {
    expect(activeTick([0, 500, 1150, 1900], 1400, 600, 2000)).toBe(3);
  });

  it("uses a third of a short viewport when that is less than the line", () => {
    // 90 tall: the line is 30 under the edge, not 48.
    expect(activeTick([0, 40], 0, 90, 5000)).toBe(0);
  });
});

describe("stepTick", () => {
  it("steps within bounds and lands from nowhere on the ends", () => {
    expect(stepTick(1, 1, 4)).toBe(2);
    expect(stepTick(3, 1, 4)).toBe(3);
    expect(stepTick(0, -1, 4)).toBe(0);
    expect(stepTick(null, 1, 4)).toBe(0);
    expect(stepTick(null, -1, 4)).toBe(3);
    expect(stepTick(null, 1, 0)).toBeNull();
  });
});

// Item 359: LibreChat's rail (MessageNav.tsx, main as read 2026-10-15),
// ported. Their numbers are pinned here so a later "tweak" is a decision.
describe("LibreChat's rail, ported (item 359)", () => {
  it("keeps their sizes: 12×3 ribs, 21×3 current, 39×6 peak, 3×3 dots, 6 px rows 6 px apart", () => {
    expect(RIB_MESSAGE).toEqual({ baseW: 12, baseH: 3, peakW: 39, peakH: 6 });
    expect(RIB_CURRENT).toEqual({ baseW: 21, baseH: 3, peakW: 39, peakH: 6 });
    expect(RIB_END).toEqual({ baseW: 3, baseH: 3, peakW: 4.5, peakH: 4.5 });
    expect([RIB_ROW, RIB_GAP]).toEqual([6, 6]);
    // The peak never exceeds the row, so magnifying never reflows the rail.
    expect(RIB_MESSAGE.peakH).toBeLessThanOrEqual(RIB_ROW);
    expect(ribDims(false, true)).toBe(RIB_CURRENT);
    expect(ribDims(true, true)).toBe(RIB_END);
    expect(MIN_TICKS).toBe(3);
  });

  it("magnifies along a cosine bell 50 px each way", () => {
    expect(magnifyFalloff(0, 50)).toBe(1);
    expect(magnifyFalloff(25, 50)).toBeCloseTo(0.5, 10);
    expect(magnifyFalloff(50, 50)).toBe(0);
    expect(magnifyFalloff(80, 50)).toBe(0);
    expect(magnified(RIB_MESSAGE, 1)).toEqual({ w: 39, h: 6 });
    expect(magnified(RIB_MESSAGE, 0.5)).toEqual({ w: 25.5, h: 4.5 });
  });

  it("eases out cubically", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
  });

  it("previews 80 characters and a '...', whitespace collapsed; Generating for the empty live reply", () => {
    expect(previewOf("a\n\n  b")).toBe("a b");
    const long = "x".repeat(100);
    expect(previewOf(long)).toBe("x".repeat(80) + "...");
    expect(previewOf("x".repeat(80))).toBe("x".repeat(80));
    const live = liveTick("");
    expect(live.pending).toBe(true);
    expect(previewText(live)).toBe("Generating");
    expect(previewText(liveTick("Sure — here"))).toBe("Sure — here");
    const log: SessionEvent[] = [reply("", true)];
    expect(previewText(ticks(log, liveFlags(log))[0])).toBe("(1 tool call)");
    expect(anchorSelector(-1)).toBe("[data-nav-live]");
    expect(anchorSelector(7)).toBe('[data-turn="7"]');
  });

  it("steps the chevrons their way: the start of the message being read, then the one before", () => {
    // Tops at 0, 500, 1200; viewport can scroll to 2000; landing is top − 12.
    const tops = [0, 500, 1200];
    // Partway into message 1 (scrolled to 700): ⌃ goes to its own start.
    expect(prevTarget(tops, 700, 2000)).toBe(1);
    // At message 1's landing (488): ⌃ goes to message 0.
    expect(prevTarget(tops, 488, 2000)).toBe(0);
    // At the top: nowhere to go.
    expect(prevTarget(tops, 0, 2000)).toBeNull();
    expect(nextTarget(tops, 488, 2000)).toBe(2);
    // Within 4 px of a landing counts as on it.
    expect(nextTarget(tops, 1186, 2000)).toBeNull();
    // A landing past the end of the scroll is clamped to it.
    expect(nextTarget(tops, 900, 1000)).toBe(2);
    expect(nextTarget(tops, 1000, 1000)).toBeNull();
  });

  it("finds the messages on screen", () => {
    expect(inViewRange([0, 500, 1200], [480, 1180, 1500], 600, 400)).toEqual([1, 1]);
    expect(inViewRange([0, 500, 1200], [480, 1180, 1500], 400, 900)).toEqual([0, 2]);
    expect(inViewRange([], [], 0, 400)).toBeNull();
  });

  it("follows the rail's column: centred on the on-screen ribs, at its foot at the chat's foot", () => {
    const top = (i: number) => i * 12;
    const bottom = (i: number) => i * 12 + 6;
    // 100 ribs (1194 px) in a 300 px column; ribs 40–44 on screen: centre 507.
    expect(columnFollow([40, 44], 100, false, top, bottom, 300, 1194)).toBe(507 - 150);
    expect(columnFollow([0, 1], 100, false, top, bottom, 300, 1194)).toBe(0);
    expect(columnFollow([90, 99], 100, false, top, bottom, 300, 1194)).toBe(894);
    expect(columnFollow([10, 12], 100, true, top, bottom, 300, 1194)).toBe(894);
    expect(columnFollow(null, 100, false, top, bottom, 300, 1194)).toBeNull();
  });

  it("snaps lengths to whole device pixels at every zoom", () => {
    // 90 %, 100 %, 125 % of a 2× display.
    for (const dpr of [1.8, 2, 2.5]) {
      for (const css of [3, 6, 12, 21, 4.5]) {
        const dev = snapPx(css, dpr) * dpr;
        expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-9);
        expect(Math.abs(snapPx(css, dpr) - css)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      }
    }
    expect(snapPx(0.1, 2)).toBe(0.5);
    // A line's top in its row lands on a device pixel too (125 %: row 15, line 8 → inset 3).
    for (const dpr of [1.8, 2, 2.5]) {
      for (const [w, h] of [[12, 3], [21, 3], [39, 6], [25.5, 4.5], [3, 3]]) {
        const b = ribBox(w, h, RIB_ROW, dpr);
        const top = b.top * dpr;
        expect(Math.abs(top - Math.round(top))).toBeLessThan(1e-9);
        expect(b.top + b.h).toBeLessThanOrEqual(snapPx(RIB_ROW, dpr) + 1e-9);
      }
    }
    expect(ribBox(12, 3, 6, 2.5).top * 2.5).toBeCloseTo(3, 9);
    // The rail column's scroll: whole CSS px that are whole device px.
    expect(snapScroll(357, 1.8, 900)).toBe(355);
    expect(snapScroll(357.4, 2, 900)).toBe(357);
    expect(snapScroll(357, 2.5, 900)).toBe(356);
    expect(snapScroll(950, 1.8, 900)).toBe(900);
    expect(snapScroll(-3, 1.8, 900)).toBe(0);
    expect(snapPx(3, 0)).toBe(3);
  });

  it("scrolls in 400 ms, re-aims every frame, and a new scroll cancels the old", () => {
    const frames: ((t: number) => void)[] = [];
    const raf = (cb: (t: number) => void) => frames.push(cb);
    const el = { scrollTop: 0 } as HTMLElement;
    let target = 1000;
    animateScroll(el, () => target, 400, raf, () => 0);
    frames.shift()!(200);
    expect(el.scrollTop).toBeCloseTo(1000 * easeOutCubic(0.5), 6);
    target = 1200; // the message moved
    frames.shift()!(400);
    expect(el.scrollTop).toBe(1200);
    expect(frames.length).toBe(0);
    // Two at once: the first stops at its next frame.
    animateScroll(el, () => 0, 400, raf, () => 0);
    const first = frames.shift()!;
    animateScroll(el, () => 600, 400, raf, () => 0);
    first(400);
    expect(el.scrollTop).toBe(1200);
    frames.shift()!(400);
    expect(el.scrollTop).toBe(600);
  });
});

describe("359 review: the eased jump stops when it should", () => {
  it("a chat switch cancels a jump still easing in the chat just left", () => {
    expect(transcriptSrc).toMatch(/lastKey = key;[^]*?if \(from !== null && from !== key\) cancelScroll\(\);/);
  });
  it("his own wheel, touch and scroll keys cancel it; the alt-arrow steps do not", () => {
    const intent = transcriptSrc.slice(transcriptSrc.indexOf("function scrollIntent"));
    const body = intent.slice(0, intent.indexOf("node.addEventListener"));
    expect(body).toMatch(/const wheel = \(e: WheelEvent\) => \{\s*cancelScroll\(\);/);
    expect(body).toMatch(/const touchmove = \(e: TouchEvent\) => \{\s*cancelScroll\(\);/);
    expect(body).toMatch(/if \(!e\.altKey && \[[^\]]*"ArrowDown"[^\]]*\]\.includes\(e\.key\)\)\s*cancelScroll\(\);/);
  });
});
