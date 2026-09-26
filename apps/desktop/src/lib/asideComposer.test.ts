import { describe, expect, it } from "vitest";
import { asideComposer } from "./asideComposer";
import type { Aside, AsideTurn } from "./state.svelte";

/** Backlog 238: the aside tab's composer is there in every state; Send waits. */
const turn = (seq: number, answered: boolean): AsideTurn => ({
  seq,
  question: `q${seq}`,
  partial: answered ? `a${seq}` : "",
  answer: answered ? `a${seq}` : null,
  error: null,
  cancelled: false,
  cacheRead: 0,
});
const thread = (turns: AsideTurn[], draft = false): Aside => ({ id: 1, quote: null, draft, turns, anchor: null });
const base = { open: true, asking: false, claudeCode: true, text: "why?" };

describe("aside tab composer (backlog 238)", () => {
  it("is shown on first open, after 1, 2 and 3 exchanges, and while an answer streams", () => {
    expect(asideComposer(thread([], true), base).shown).toBe(true);
    for (const n of [1, 2, 3]) {
      const turns = Array.from({ length: n }, (_, i) => turn(i + 1, true));
      expect(asideComposer(thread(turns), base)).toEqual({ shown: true, canSend: true, note: "ready" });
    }
    const streaming = asideComposer(thread([turn(1, true), turn(2, false)]), { ...base, asking: true });
    expect(streaming).toEqual({ shown: true, canSend: false, note: "answering" });
  });

  it("is shown on a chat that is not the open one — the old Follow-up box was not", () => {
    expect(asideComposer(thread([turn(1, true), turn(2, true)]), { ...base, open: false })).toEqual({
      shown: true,
      canSend: false,
      note: "not-open",
    });
  });

  it("sends only with text, on the Claude Code engine", () => {
    expect(asideComposer(thread([turn(1, true)]), { ...base, text: "  " }).canSend).toBe(false);
    expect(asideComposer(thread([turn(1, true)]), { ...base, claudeCode: false })).toEqual({
      shown: true,
      canSend: false,
      note: "engine",
    });
    expect(asideComposer(null, base).shown).toBe(false);
  });

  // Backlog 240: full-screen aside tab → Open the chat → back to the tab. The chat is now the open one; the bar
  // keeps a line (the ready one) rather than going bare, and Send is live. Before 240 the note was null here.
  it("keeps a line after Open the chat makes the tab's chat the open one", () => {
    const t = thread([turn(1, true)]);
    const before = asideComposer(t, { ...base, open: false });
    expect(before.note).toBe("not-open");
    const back = asideComposer(t, { ...base, open: true });
    expect(back).toEqual({ shown: true, canSend: true, note: "ready" });
    expect(asideComposer(t, { ...base, open: true, text: "" })).toEqual({ shown: true, canSend: false, note: "ready" });
  });
});
