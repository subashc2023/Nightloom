import { describe, expect, it } from "vitest";
import { ASIDE_SEG_MAX, loadAsides, serializeAsides } from "./asides";
import { asideEvents } from "./asideTranscript";
import type { Aside, AsideTurn, Segment } from "./state.svelte";

/**
 * Item 674 step 6: an aside answer's thinking and calls survive a
 * relaunch — the store keeps the turn's segments (trimmed), and an entry
 * written before reads as its text.
 */
const turn = (segments: Segment[] | undefined, answer: string): AsideTurn => ({
  seq: 1,
  question: "Why only on success?",
  partial: answer,
  answer,
  error: null,
  cancelled: false,
  cacheRead: 0,
  ...(segments ? { segments } : {}),
});
const aside = (t: AsideTurn): Aside => ({ id: 1, quote: null, draft: false, turns: [t], anchor: null });
const roundTrip = (a: Aside): Aside => loadAsides({ getItem: () => serializeAsides(new Map([["c", [a]]])) }).get("c")![0]!;

describe("674: an aside's stored segments", () => {
  const segs: Segment[] = [
    { kind: "thinking", text: "The unit lands or it does not.", done: true, ms: 4200 },
    { kind: "text", text: "First, " },
    { kind: "tool", call: { id: "t1", name: "Read", input: { file_path: "state/watermark.json" }, result: { content: '{"unit": 41}', is_error: false } } } as Segment,
    { kind: "text", text: "then the answer." },
  ];

  it("come back in order after a relaunch, the text cut from the answer", () => {
    const back = roundTrip(aside(turn(segs, "First, then the answer."))).turns[0]!;
    expect(back.partial).toBe("First, then the answer.");
    expect(back.segments?.map((s) => s.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(back.segments?.[0]).toMatchObject({ kind: "thinking", text: "The unit lands or it does not.", done: true, ms: 4200 });
    expect(back.segments?.[1]).toEqual({ kind: "text", text: "First, " });
    expect(back.segments?.[2]).toMatchObject({ kind: "tool", call: { id: "t1", name: "Read", input: { file_path: "state/watermark.json" }, result: { content: '{"unit": 41}', is_error: false } } });
    expect(back.segments?.[3]).toEqual({ kind: "text", text: "then the answer." });
    // And the transcript draws them: a thinking block, a call with its result.
    const ev = asideEvents({ turns: [back] });
    const reply = ev.events.find((e) => e.event === "assistant_message");
    expect(reply?.event === "assistant_message" && reply.blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "text"]);
    expect(ev.events.some((e) => e.event === "tool_result")).toBe(true);
  });

  it("keep the answer whole when the text segments are not the answer", () => {
    const back = roundTrip(aside(turn([segs[0]!, { kind: "text", text: "a lost delta" }], "The whole answer."))).turns[0]!;
    expect(back.segments).toEqual([{ kind: "thinking", text: "The unit lands or it does not.", done: true, ms: 4200 }, { kind: "text", text: "The whole answer." }]);
  });

  it("are trimmed past a size, never the answer", () => {
    const big: Segment[] = [
      { kind: "thinking", text: "t".repeat(ASIDE_SEG_MAX.thinking * 2), done: true },
      { kind: "tool", call: { id: "t2", name: "Bash", input: { command: "x".repeat(ASIDE_SEG_MAX.input * 2) }, result: { content: "r".repeat(ASIDE_SEG_MAX.result * 2), is_error: false } } } as Segment,
      { kind: "text", text: "Done." },
    ];
    const back = roundTrip(aside(turn(big, "Done."))).turns[0]!;
    const [th, tl, tx] = back.segments!;
    expect(th!.kind === "thinking" && th.text.length).toBe(ASIDE_SEG_MAX.thinking);
    expect(tl!.kind === "tool" && tl.call.input).toEqual({});
    expect(tl!.kind === "tool" && tl.call.result?.content.length).toBe(ASIDE_SEG_MAX.result);
    expect(tx).toEqual({ kind: "text", text: "Done." });
  });

  it("a text-only turn, and an entry stored before, read as their text", () => {
    expect(roundTrip(aside(turn([{ kind: "text", text: "Plain." }], "Plain."))).turns[0]!.segments).toBeUndefined();
    expect(serializeAsides(new Map([["c", [aside(turn(undefined, "Plain."))]]]))).not.toContain('"segs"');
    const old = JSON.parse(serializeAsides(new Map([["c", [aside(turn(segs, "First, then the answer."))]]])));
    const strip = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(strip);
      else if (v && typeof v === "object") {
        delete (v as Record<string, unknown>).segs;
        Object.values(v).forEach(strip);
      }
    };
    strip(old);
    const back = loadAsides({ getItem: () => JSON.stringify(old) }).get("c")![0]!.turns[0]!;
    expect(back.segments).toBeUndefined();
    expect(back.partial).toBe("First, then the answer.");
  });
});
