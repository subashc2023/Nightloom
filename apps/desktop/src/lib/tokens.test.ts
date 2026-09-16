import { describe, expect, it } from "vitest";
import type { SessionEvent, Usage } from "./types";
import { liveFlags } from "./state.svelte";
import { SHARE_BAR_FROM, fmtShare, fmtTokens, shareOf, sizeTitle, turnSizes } from "./tokens";

// Per-message sizes (nightshift backlog 090): the delta projection over a
// fixture log, and the reconciliation — every turn's figure sums to the
// last reply's `in + out`, which is what the top-bar gauge shows.

const at = "2026-09-16T00:00:00Z";
function user(text = "hi"): SessionEvent {
  return { event: "user_message", text, at };
}
function reply(input: number, output: number, extra: Partial<Usage> = {}): SessionEvent {
  return {
    event: "assistant_message",
    model: "m",
    blocks: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: input, output_tokens: output, ...extra },
    at,
  };
}
function result(): SessionEvent {
  return { event: "tool_result", tool_use_id: "t", content: "x", at } as SessionEvent;
}
function sizesOf(events: SessionEvent[]) {
  return turnSizes(events, liveFlags(events));
}

describe("turnSizes", () => {
  it("a plain exchange: the first turn holds the preamble, the reply is its output", () => {
    const events = [user(), reply(12_000, 300)];
    const s = sizesOf(events);
    expect(s[0]).toEqual({ tokens: 12_000, preamble: true });
    expect(s[1]).toEqual({ tokens: 300, out: 300 });
  });

  it("a later user turn is the growth of the whole prompt since the last reply", () => {
    // Context after reply 1: 12,000 + 300 = 12,300. The second prompt is
    // 12,300 + the new message (450) = 12,750; its input is inclusive of
    // cache reads, which is what makes this a subtraction and not a guess.
    const events = [user(), reply(12_000, 300), user("more"), reply(12_750, 90, { cache_read_tokens: 12_300 })];
    const s = sizesOf(events);
    expect(s[2]).toEqual({ tokens: 450 });
    expect(s[3]).toEqual({ tokens: 90, out: 90 });
  });

  it("tool results are charged to the reply that called for them", () => {
    // Reply 1 calls a tool (out 40); the round's results (2,000 tokens) are
    // in reply 2's input; reply 2 answers (out 200).
    const events = [user(), reply(10_000, 40), result(), reply(12_040, 200), user("next"), reply(12_540, 10)];
    const s = sizesOf(events);
    expect(s[1]).toEqual({ tokens: 2_040, out: 40, results: 2_000 });
    expect(s[2]).toBeNull();
    expect(s[3]).toEqual({ tokens: 200, out: 200 });
    expect(s[4]).toEqual({ tokens: 300 });
  });

  it("reconciles: the turns sum to the last reply's in + out, the gauge's figure", () => {
    const events = [
      user(),
      reply(10_000, 40),
      result(),
      reply(12_040, 200),
      user("next"),
      reply(12_540, 10),
      user("again"),
      reply(13_000, 500),
    ];
    const s = sizesOf(events);
    const sum = s.reduce((n, x) => n + (x?.tokens ?? 0), 0);
    expect(sum).toBe(13_000 + 500);
  });

  it("a rewound turn shows nothing and the chain runs over the live replies", () => {
    const events: SessionEvent[] = [
      user(),
      reply(10_000, 100),
      user("undone"),
      reply(10_600, 50),
      { event: "rewind", to: 2, at },
      user("instead"),
      reply(10_400, 20),
    ];
    const s = sizesOf(events);
    expect(s[2]).toBeNull();
    expect(s[3]).toBeNull();
    // Measured from reply 1's 10,100, not the rewound reply's context.
    expect(s[5]).toEqual({ tokens: 300 });
    expect(s[6]).toEqual({ tokens: 20, out: 20 });
  });

  it("a context that shrank between replies (compaction, an edit) shows nothing for that turn", () => {
    const events = [user(), reply(50_000, 100), user("after compaction"), reply(8_000, 30)];
    const s = sizesOf(events);
    expect(s[2]).toBeNull();
    expect(s[3]).toEqual({ tokens: 30, out: 30 });
  });

  it("an unrecorded usage shows nothing and breaks the chain for the turn after it", () => {
    const events = [user(), reply(0, 0), user("second"), reply(9_000, 40), user("third"), reply(9_100, 5)];
    const s = sizesOf(events);
    expect(s[0]).toBeNull();
    expect(s[1]).toBeNull();
    expect(s[2]).toBeNull();
    expect(s[3]).toEqual({ tokens: 40, out: 40 });
    expect(s[4]).toEqual({ tokens: 60 });
  });
});

describe("fmtTokens / shareOf / fmtShare", () => {
  it("spells the figure the gauge's way, with a decimal under ten thousand", () => {
    expect(fmtTokens(812)).toBe("812");
    expect(fmtTokens(1_234)).toBe("1.2k");
    expect(fmtTokens(9_960)).toBe("10k");
    expect(fmtTokens(48_200)).toBe("48k");
    expect(fmtTokens(1_180_000)).toBe("1.2M");
  });
  it("shares against the window, nothing without one, the bar from five percent", () => {
    expect(shareOf(48_000, 200_000)).toBeCloseTo(0.24);
    expect(shareOf(48_000, null)).toBeNull();
    expect(shareOf(300_000, 200_000)).toBe(1);
    expect(fmtShare(0.24)).toBe("24%");
    expect(fmtShare(SHARE_BAR_FROM - 0.001)).toBe("");
    expect(fmtShare(null)).toBe("");
  });
});

describe("sizeTitle", () => {
  it("says what the figure is, and names the preamble on the first turn", () => {
    expect(sizeTitle({ tokens: 450 }, "user", 200_000)).toBe(
      "450 tokens this message added to the context — 0% of the 200,000-token window",
    );
    expect(sizeTitle({ tokens: 12_000, preamble: true }, "user", null)).toBe(
      "12,000 tokens: this message and the system prompt together — the log does not separate them",
    );
    expect(sizeTitle({ tokens: 2_040, out: 40, results: 2_000 }, "assistant", null)).toBe(
      "2,040 tokens this reply added to the context: 40 out · 2,000 from its tool results",
    );
  });
});
