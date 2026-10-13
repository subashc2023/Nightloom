// Backlog 342 — the streaming motion ("Loom + fade-in"): the arrival log that
// decides which words are wrapped while they animate, the rows born live, the
// reduced-motion switch, and the component's wiring. The DOM side (wrapping,
// the shuttle, the transitions) is proven in WebKit (notes/runner-design/342-report.md);
// the suite runs without a DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
import src from "./AssistantMessage.svelte?raw";
import {
  arrive,
  Births,
  motionOff,
  pieces,
  settlesAt,
  STAGGER_CAP_MS,
  STAGGER_MS,
  WORD_MS,
  type Track,
} from "./replyMotion";

const track = (): Track => ({ len: 0, live: [] });

describe("arrive — which words animate", () => {
  it("logs each new word with a stagger, and a word is live until its animation ends", () => {
    const s = track();
    expect(arrive(s, "Hello there world", 1000)).toBe(true);
    expect(s.live).toEqual([
      { from: 0, to: 5, start: 1000 },
      { from: 6, to: 11, start: 1000 + STAGGER_MS },
      { from: 12, to: 17, start: 1000 + 2 * STAGGER_MS },
    ]);
    // Mid-animation: still wrapped.
    arrive(s, "Hello there world", 1000 + WORD_MS - 1);
    expect(s.live.length).toBe(3);
    // After: the first word is done (unwrapped), the staggered ones finish after it.
    arrive(s, "Hello there world", 1000 + WORD_MS);
    expect(s.live.map((r) => r.from)).toEqual([6, 12]);
    arrive(s, "Hello there world", 1000 + WORD_MS + 2 * STAGGER_MS);
    expect(s.live).toEqual([]);
  });

  it("caps the stagger of a long delta", () => {
    const s = track();
    arrive(s, Array.from({ length: 30 }, (_, k) => `w${k}`).join(" "), 0);
    expect(Math.max(...s.live.map((r) => r.start))).toBe(STAGGER_CAP_MS);
  });

  it("only what is new arrives; the trailing newlines of rendered blocks are not counted", () => {
    const s = track();
    arrive(s, "One two\n", 0);
    expect(s.len).toBe(7);
    expect(arrive(s, "One two\n\n", 50)).toBe(false);
    arrive(s, "One two three\n", 100);
    expect(s.live.at(-1)).toEqual({ from: 8, to: 13, start: 100 });
  });

  it("the rest of a word split across deltas keeps its first piece's timing", () => {
    const s = track();
    arrive(s, "anim", 0);
    arrive(s, "animation done", 40);
    expect(s.live).toEqual([
      { from: 0, to: 4, start: 0 },
      { from: 4, to: 9, start: 0 },
      { from: 10, to: 14, start: 40 + STAGGER_MS },
    ]);
  });

  it("a word whose first piece already finished simply shows", () => {
    const s = track();
    arrive(s, "anim", 0);
    arrive(s, "animation", 2000);
    expect(s.live).toEqual([]);
  });

  it("text that shrinks (an edit, a retry) drops what is gone", () => {
    const s = track();
    arrive(s, "alpha beta gamma", 0);
    arrive(s, "alpha", 10);
    expect(s.len).toBe(5);
    expect(s.live.map((r) => r.from)).toEqual([0]);
  });
});

describe("pieces — one text node split into plain and animating stretches", () => {
  const live = [
    { from: 6, to: 11, start: 900 },
    { from: 12, to: 17, start: 1022 },
  ];
  it("wraps the live words with a negative delay equal to their age", () => {
    expect(pieces(0, "Hello there world", live, 1000)).toEqual([
      "Hello ",
      { text: "there", delay: -100 },
      " ",
      { text: "world", delay: 22 },
    ]);
  });
  it("respects the node's own offset in the block", () => {
    expect(pieces(9, "re world!", live, 1000)).toEqual([{ text: "re", delay: -100 }, " ", { text: "world", delay: 22 }, "!"]);
  });
  it("a node with nothing animating is left alone", () => {
    expect(pieces(0, "Hello ", live, 1000)).toBeNull();
  });
  it("settles when the last word's animation ends", () => {
    expect(settlesAt(live)).toBe(1022 + WORD_MS);
    expect(settlesAt([])).toBeNull();
  });
});

describe("Births — the rows that get the needle and the weft", () => {
  it("rows on screen at the first render stay still; a row first seen running mid-turn is born live, once", () => {
    const b = new Births();
    expect(b.of("t1", true, false)).toBe(false);
    b.settled = true;
    expect(b.of("t1", true, true)).toBe(false);
    expect(b.of("t2", true, false)).toBe(true);
    expect(b.of("t2", true, true)).toBe(true);
    expect(b.of("t3", true, true)).toBe(false);
    expect(b.of("t4", false, false)).toBe(false);
  });
});

describe("reduced motion", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is off with the OS setting", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    expect(motionOff()).toBe(true);
  });
  it("is on without it", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(motionOff()).toBe(false);
  });
});

describe("AssistantMessage wiring", () => {
  it("the reply's root runs the text motion while streaming", () => {
    expect(src).toMatch(/<div class="assistant" use:replyMotion=\{streaming\}>/);
  });
  it("thinking: the needle on open and close, the live thread, the turn on done", () => {
    expect(src).toMatch(/class:rm-live=\{streaming && !seg\.done\} class:rm-thought=\{bornT && seg\.done\}/);
    expect(src).toMatch(/in:needleIn\|global=\{\{ on: births\.settled \}\}/);
    expect(src).toMatch(/out:needleOut=\{\{ on: births\.settled \}\}/);
  });
  it("tool rows: the weft while the call runs, filled and faded on finish", () => {
    expect(src).toMatch(/class:rm-born=\{bornW\} class:rm-finished=\{bornW && !running\}/);
    expect(src).toMatch(/<span class="rm-weft" class:rm-done=\{!running\} aria-hidden="true"><\/span>/);
  });
  it("every animation sits under no-preference; the decorations are hidden under reduce", () => {
    const style = src.slice(src.indexOf("<style>"));
    const i = style.indexOf("@media (prefers-reduced-motion: no-preference)");
    const j = style.indexOf("@keyframes", i);
    const block = style.slice(i, j);
    const outside = style.slice(0, i) + style.slice(j);
    for (const name of ["rm-rise", "rm-weft-under", "rm-needle", "rm-label", "rm-turn", "rm-in", "rm-draw", "rm-shuttle-run", "rm-weft-done", "rm-flash"]) {
      expect(block).toMatch(new RegExp(`\\b${name}\\b`));
      expect(outside).not.toMatch(new RegExp(`animation[^;{}]*\\b${name}\\b`));
    }
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rm-weft,\s*\.assistant :global\(\.rm-shuttle\) \{\s*display: none;/);
  });
});
