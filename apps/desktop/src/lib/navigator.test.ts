import { describe, expect, it } from "vitest";
import {
  FULL_WEIGHT_CHARS,
  MIN_WEIGHT,
  activeTick,
  firstLine,
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
