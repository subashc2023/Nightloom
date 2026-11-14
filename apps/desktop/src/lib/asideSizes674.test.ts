import { describe, expect, it } from "vitest";
import { exchangeSizes } from "./asideFigures";
import { asideEvents } from "./asideTranscript";
import { userFigure } from "./tokens";
import type { AsideTurn } from "./state.svelte";

/** Item 674 follow-up: an aside's per-turn figures, for the shared share bar. */
const turn = (seq: number, over: Partial<AsideTurn> = {}): AsideTurn => ({
  seq,
  question: `question ${seq}`,
  partial: `answer ${seq}`,
  answer: `answer ${seq}`,
  error: null,
  cancelled: false,
  cacheRead: 0,
  ...over,
});

describe("674: exchangeSizes", () => {
  it("the first question holds the chat's prefix (forked preamble); later ones grow from the last answer's context", () => {
    const s = exchangeSizes({
      turns: [
        turn(1, { usage: { input_tokens: 50_000, output_tokens: 400 }, context: 50_400 }),
        turn(2, { usage: { input_tokens: 51_000, output_tokens: 300 }, context: 51_300 }),
      ],
    });
    expect(s[0]!.question).toEqual({ tokens: 50_000, preamble: true, forked: true });
    expect(s[0]!.answer).toEqual({ tokens: 400, out: 400 });
    expect(s[1]!.question).toEqual({ tokens: 600 });
    expect(s[1]!.answer).toEqual({ tokens: 300, out: 300 });
  });

  it("guesses nothing: no usage, thinking before, tools, a shrink", () => {
    const s = exchangeSizes({
      turns: [
        turn(1, { usage: { input_tokens: 10_000, output_tokens: 900 }, context: 10_900, segments: [{ kind: "thinking", text: "hm" } as never] }),
        turn(2, { usage: { input_tokens: 11_000, output_tokens: 100 }, context: 11_100 }),
        turn(3, { usage: { input_tokens: 30_000, output_tokens: 100 }, context: 12_000, segments: [{ kind: "tool", call: { id: "c", name: "Read", input: {} } } as never] }),
        turn(4),
        turn(5, { usage: { input_tokens: 12_000, output_tokens: 50 }, context: 12_050 }),
        turn(6, { usage: { input_tokens: 9_000, output_tokens: 50 }, context: 9_050 }),
      ],
    });
    expect(s[1]!.question).toBeNull(); // after an answer that thought
    expect(s[2]!.question).toBeNull(); // used tools
    expect(s[2]!.answer).toEqual({ tokens: 100, out: 100 });
    expect(s[3]).toEqual({ question: null, answer: null }); // no usage
    expect(s[4]!.question).toBeNull(); // after one with no usage
    expect(s[5]!.question).toBeNull(); // shrank
  });

  it("asideEvents carries them per event index; the first question shows its estimate with the forked title", () => {
    const ev = asideEvents({
      turns: [
        turn(1, { usage: { input_tokens: 50_000, output_tokens: 400 }, context: 50_400 }),
        turn(2, { usage: { input_tokens: 51_000, output_tokens: 300 }, context: 51_300 }),
      ],
    });
    expect(ev.sizes.length).toBe(ev.events.length);
    expect(ev.sizes.map((x) => x?.tokens ?? null)).toEqual([50_000, 400, 600, 300]);
    const first = userFigure(ev.sizes[0] ?? null, "question 1", 200_000)!;
    expect(first.exact).toBe(false);
    expect(first.title).toMatch(/the chat's context the aside forked from/);
    const second = userFigure(ev.sizes[2] ?? null, "question 2", 200_000)!;
    expect(second).toMatchObject({ exact: true, tokens: 600, label: "600 tokens" });
  });
});
