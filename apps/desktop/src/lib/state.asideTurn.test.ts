import { describe, expect, it } from "vitest";
import { asidePhase, asideTurnEvent, settleAsideSegments, type AsideTurn } from "./state.svelte";

/**
 * Item 403: an aside's stream builds the same segments the chat's live
 * reply is made of, so `AssistantMessage` draws its thinking block (and
 * the arrival), its calls and its text as the chat's.
 */
const turn = (): AsideTurn => ({ seq: 1, question: "why", partial: "", answer: null, error: null, cancelled: false, cacheRead: 0, startedAt: 0 });

describe("an aside's turn as segments (item 403)", () => {
  it("thinking, then a call, then text, in order, with the text on partial too", () => {
    const t = turn();
    asideTurnEvent(t, { type: "thinking_delta", text: "Let me " }, 10);
    asideTurnEvent(t, { type: "thinking_delta", text: "look." }, 20);
    asideTurnEvent(t, { type: "tool_call", id: "c1", name: "Read", input: { file_path: "/w/a" } }, 30);
    asideTurnEvent(t, { type: "tool_result", tool_use_id: "c1", name: "Read", content: "x", is_error: false }, 40);
    asideTurnEvent(t, { type: "text_delta", text: "Because" }, 50);
    asideTurnEvent(t, { type: "text_delta", text: " so." }, 60);
    const kinds = t.segments!.map((s) => s.kind);
    expect(kinds).toEqual(["thinking", "tool", "text"]);
    const th = t.segments![0] as { text: string; done: boolean; at?: number };
    expect(th.text).toBe("Let me look.");
    expect(th.done).toBe(true); // closed by the call, as the chat's is
    expect(t.partial).toBe("Because so.");
    expect(t.heardAt).toBe(60);
    expect(t.phase).toBe("running");
  });
  it("a live thinking segment carries the clock its arrival keys on", () => {
    const t = turn();
    asideTurnEvent(t, { type: "thinking_delta", text: "hm" });
    const th = t.segments![0] as { done: boolean; at?: number };
    expect(th.done).toBe(false);
    expect(typeof th.at).toBe("number");
  });
  it("takes nothing once stopped or answered", () => {
    const t = turn();
    t.cancelled = true;
    asideTurnEvent(t, { type: "text_delta", text: "late" });
    expect(t.segments).toBeUndefined();
    expect(t.partial).toBe("");
  });
  it("the result's text stands in where a delta was lost; the thinking stays and closes", () => {
    const t = turn();
    asideTurnEvent(t, { type: "thinking_delta", text: "hm" });
    asideTurnEvent(t, { type: "text_delta", text: "Becau" });
    settleAsideSegments(t, "Because.");
    expect(t.segments!.map((s) => s.kind)).toEqual(["thinking", "text"]);
    expect((t.segments![1] as { text: string }).text).toBe("Because.");
    const u = turn();
    asideTurnEvent(u, { type: "thinking_delta", text: "hm" });
    settleAsideSegments(u, "Only in the result.");
    expect((u.segments![0] as { done: boolean }).done).toBe(true);
    expect((u.segments![1] as { text: string }).text).toBe("Only in the result.");
  });
});

describe("an aside's phase (item 404)", () => {
  it("queued, then running starts the stall clock", () => {
    const t = turn();
    asidePhase(t, "queued", 100);
    expect(t.phase).toBe("queued");
    expect(t.heardAt).toBeUndefined();
    asidePhase(t, "running", 5000);
    expect(t.phase).toBe("running");
    expect(t.heardAt).toBe(5000);
  });
});
