import { describe, expect, it } from "vitest";
import { asideEvents, asideLive, askingOf, segsOfTurn } from "./asideTranscript";
import type { AsideTurn, Segment } from "./state.svelte";

const turn = (over: Partial<AsideTurn>): AsideTurn => ({
  seq: 1,
  question: "q",
  partial: "",
  answer: null,
  error: null,
  cancelled: false,
  cacheRead: 0,
  ...over,
});
const segs: Segment[] = [
  { kind: "thinking", text: "hm", done: true, ms: 1200 },
  { kind: "text", text: "First." },
  { kind: "tool", call: { id: "t1", name: "Read", input: { path: "a" }, result: { content: "ok", is_error: false } } },
  { kind: "text", text: "Then." },
];

describe("674: an aside's exchanges as the chat's events", () => {
  it("a settled exchange is his message, then the reply with its thinking, text and calls in order", () => {
    const t = turn({ seq: 7, question: "why?", partial: "First.Then.", answer: "First.Then.", segments: segs, model: "opus", usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 8 }, at: "2026-11-12T01:00:10.000Z", tookMs: 10_000 });
    const ev = asideEvents({ turns: [t] });
    expect(ev.events.map((e) => e.event)).toEqual(["user_message", "assistant_message", "tool_result"]);
    const [u, a, r] = ev.events;
    expect(u).toMatchObject({ event: "user_message", text: "why?", at: "2026-11-12T01:00:00.000Z" });
    expect(a).toMatchObject({ event: "assistant_message", model: "opus", usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 8 } });
    if (a?.event !== "assistant_message") throw new Error("not a reply");
    expect(a.blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "text"]);
    expect(r).toMatchObject({ event: "tool_result", tool_use_id: "t1", content: "ok", is_error: false });
    expect(ev.turnOf).toEqual([0, 0, 0]);
    expect(ev.seqOf).toEqual([7, 7, 7]);
    expect(ev.bare.size).toBe(0);
    expect(ev.notes.size).toBe(0);
  });

  it("a stored exchange (no segments) is its text alone, with a bare footer", () => {
    const ev = asideEvents({ turns: [turn({ partial: "The answer.", answer: "The answer." })] });
    const a = ev.events[1];
    if (a?.event !== "assistant_message") throw new Error("not a reply");
    expect(a.blocks).toEqual([{ type: "text", text: "The answer." }]);
    expect(a.model).toBe("aside");
    expect([...ev.bare]).toEqual([1]);
  });

  it("the asking exchange is his question only; its answer is the live turn", () => {
    const done = turn({ seq: 1, partial: "A.", answer: "A." });
    const live = turn({ seq: 2, question: "next", partial: "so f", startedAt: 1_700_000_000_000, segments: [{ kind: "text", text: "so f" }] });
    const a = { turns: [done, live] };
    const ev = asideEvents(a);
    expect(ev.events.map((e) => e.event)).toEqual(["user_message", "assistant_message", "user_message"]);
    expect(ev.turnOf).toEqual([0, 0, 1]);
    expect(askingOf(a)).toBe(live);
    expect(asideLive(a)).toEqual({ segments: live.segments, since: 1_700_000_000_000 });
    // The same segments object: the reply is not rebuilt per delta.
    expect(asideLive(a)!.segments).toBe(live.segments);
  });

  it("an asking exchange with nothing yet is live with no segments (the waiting moon)", () => {
    const a = { turns: [turn({ startedAt: 5 })] };
    expect(asideLive(a)).toEqual({ segments: [], since: 5 });
    expect(asideEvents(a).events).toHaveLength(1);
  });

  it("stopped: what arrived stays, marked under the reply", () => {
    const ev = asideEvents({ turns: [turn({ partial: "half", cancelled: true })] });
    expect(ev.events.map((e) => e.event)).toEqual(["user_message", "assistant_message"]);
    expect(ev.notes.get(1)).toEqual([{ kind: "stopped", text: "stopped here" }]);
    expect(asideLive({ turns: [turn({ partial: "half", cancelled: true })] })).toBeNull();
  });

  it("an error with no answer is noted under his question", () => {
    const ev = asideEvents({ turns: [turn({ error: "usage limit reached" })] });
    expect(ev.events).toHaveLength(1);
    expect(ev.notes.get(0)).toEqual([{ kind: "error", text: "usage limit reached" }]);
  });

  it("his attachments: images with bytes in the bubble, the rest as chips", () => {
    const ev = asideEvents({
      turns: [
        turn({
          partial: "x",
          answer: "x",
          attachments: [
            { id: 1, kind: "image", media_type: "image/png", name: "a.png", data: "AAAA" },
            { id: 2, kind: "image", media_type: "image/png", name: "stored.png", data: "" },
            { id: 3, kind: "document", media_type: "application/pdf", name: "p.pdf", data: "BBBB" },
          ],
        }),
      ],
    });
    const u = ev.events[0];
    if (u?.event !== "user_message") throw new Error("not his message");
    expect(u.images).toEqual([{ media_type: "image/png", data: "AAAA" }]);
    expect(u.documents?.map((d) => d.name)).toEqual(["stored.png", "p.pdf"]);
  });

  it("segsOfTurn falls back to the text", () => {
    expect(segsOfTurn(turn({ partial: "t" }))).toEqual([{ kind: "text", text: "t" }]);
    expect(segsOfTurn(turn({}))).toEqual([]);
  });
});
