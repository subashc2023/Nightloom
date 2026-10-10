import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerAsideDiscard,
  app,
  draftAside,
  requestDismissAside,
  setAsideUnsent,
  switchAside,
} from "./state.svelte";
import type { Aside } from "./state.svelte";
import { pastAsides, pastOf, reopenPast } from "./asideHistory.svelte";

/**
 * The night merge (2026-09-26) of AS's 228 (a close with unsent text asks
 * first; Discard drops the text) and B's 229 (a closed thread goes to the
 * chat's Past): the Discard path ends at the same close listener, so a
 * discarded thread with exchanges lands in Past — without the discarded
 * text, which must not come back when it reopens.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cancelAside: vi.fn(async () => null),
}));

const answered = (id: number): Aside => ({
  id,
  quote: { text: `passage ${id}`, role: "assistant", ordinal: id },
  draft: false,
  turns: [
    { seq: id, question: "why", partial: "because", answer: "because", error: null, cancelled: false, cacheRead: 0 },
  ],
  anchor: { turn: 2, block: 0, start: 4, end: 20, side: "below" },
});

describe("Discard on an aside with unsent text, then Past (merge of 228 and 229)", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
    app.asideDiscard = null;
    for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
    app.connection = { engine: "claude-code" } as typeof app.connection;
  });

  it("a discarded thread with exchanges lands in Past, and reopens without the discarded text", () => {
    app.activeSessionId = "chat-m1";
    app.asides = [answered(1)];
    setAsideUnsent(app.asides[0]!, "a follow-up I threw away");
    requestDismissAside(app.asides[0]!);
    // The confirmation is up; nothing closed yet.
    expect(app.asideDiscard).not.toBeNull();
    expect(app.asides.length).toBe(1);
    expect(pastOf("chat-m1").length).toBe(0);

    answerAsideDiscard(true);
    expect(app.asides.length).toBe(0);
    const past = pastOf("chat-m1");
    expect(past.length).toBe(1);
    expect(past[0]!.thread.unsent).toBeUndefined();

    const back = reopenPast(past[0]!.key)!;
    expect(back.turns.map((t) => t.question)).toEqual(["why"]);
    expect((back.unsent ?? "").trim()).toBe("");
  });

  it("Cancel in the confirmation keeps the thread open and puts nothing in Past", () => {
    app.activeSessionId = "chat-m2";
    app.asides = [answered(2)];
    setAsideUnsent(app.asides[0]!, "still typing");
    requestDismissAside(app.asides[0]!);
    answerAsideDiscard(false);
    expect(app.asides.length).toBe(1);
    expect(app.asides[0]!.unsent).toBe("still typing");
    expect(pastOf("chat-m2").length).toBe(0);
  });

  it("a discarded draft (text, nothing asked) keeps nothing in Past", () => {
    app.activeSessionId = "chat-m3";
    const d = draftAside({ text: "p", role: "assistant", ordinal: 1 })!;
    setAsideUnsent(d, "a question never asked");
    requestDismissAside(d);
    answerAsideDiscard(true);
    expect(app.asides.length).toBe(0);
    expect(pastOf("chat-m3").length).toBe(0);
  });
});
