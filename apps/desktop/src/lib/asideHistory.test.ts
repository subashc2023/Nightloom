import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAST_CAP,
  PAST_KEY,
  deletePast,
  loadPast,
  quoteSnippet,
  recordPast,
  savePast,
  takePast,
  type PastMap,
} from "./asideHistory";
import { app, asideStash, dismissAside, draftAside, switchAside } from "./state.svelte";
import type { Aside, AsideTurn } from "./state.svelte";
import { pastAsides, pastOf, reopenPast } from "./asideHistory.svelte";

/**
 * The past asides (nightshift item 229, night batch B): a closed thread is
 * kept per chat instead of deleted, reopens whole, is capped, is deleted
 * only after a confirm, and a private chat's are never written.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cancelAside: vi.fn(async () => null),
}));

const turn = (over: Partial<AsideTurn> = {}): AsideTurn => ({
  seq: 3,
  question: "why",
  partial: "because",
  answer: "because",
  error: null,
  cancelled: false,
  cacheRead: 0,
  ...over,
});
const thread = (id: number, over: Partial<Aside> = {}): Aside => ({
  id,
  quote: { text: `passage ${id}`, role: "assistant", ordinal: id },
  draft: false,
  turns: [turn(), turn({ seq: 4, question: "and then?", partial: "so", answer: "so" })],
  anchor: { turn: 2, block: 0, start: 4, end: 20, side: "below" },
  ...over,
});

class Mem {
  map = new Map<string, string>();
  writes = 0;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.writes++;
    this.map.set(k, v);
  }
}

describe("the past asides store (item 229)", () => {
  it("a closed thread is kept whole and reopens with its thread intact", () => {
    const map: PastMap = {};
    expect(recordPast(map, "c", thread(1), 1000)).toBe(0);
    const s = new Mem();
    savePast(map, s);
    const back = loadPast(s);
    expect(back.c!.length).toBe(1);
    expect(back.c![0]!.closedAt).toBe(1000);
    const a = takePast(back, "c", back.c![0]!.key)!;
    expect(a.quote?.text).toBe("passage 1");
    expect(a.anchor).toEqual({ turn: 2, block: 0, start: 4, end: 20, side: "below" });
    expect(a.turns.map((t) => [t.question, t.answer])).toEqual([
      ["why", "because"],
      ["and then?", "so"],
    ]);
    // Taken out of Past: it is open again, not in both places.
    expect(back.c).toBeUndefined();
  });

  it("a draft with nothing asked is not kept", () => {
    const map: PastMap = {};
    expect(recordPast(map, "c", thread(1, { draft: true, turns: [] }))).toBeNull();
    expect(map).toEqual({});
  });

  it("keeps 50 per chat, the oldest going, and says how many went", () => {
    const map: PastMap = {};
    let pruned = 0;
    for (let i = 0; i < PAST_CAP + 3; i++) pruned += recordPast(map, "c", thread(i + 1), i) ?? 0;
    expect(map.c!.length).toBe(PAST_CAP);
    expect(pruned).toBe(3);
    expect(map.c![0]!.thread.quote?.text).toBe("passage 4");
  });

  it("Delete removes one only when the confirm says yes", () => {
    const map: PastMap = {};
    recordPast(map, "c", thread(1));
    recordPast(map, "c", thread(2));
    const key = map.c![0]!.key;
    expect(deletePast(map, "c", key, () => false)).toBe(false);
    expect(map.c!.length).toBe(2);
    const asked = vi.fn(() => true);
    expect(deletePast(map, "c", key, asked)).toBe(true);
    expect(asked).toHaveBeenCalledOnce();
    expect(map.c!.map((p) => p.thread.quote?.text)).toEqual(["passage 2"]);
    // An unknown key asks nothing.
    const never = vi.fn(() => true);
    expect(deletePast(map, "c", "nope", never)).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it("an incognito or ephemeral chat's past asides are never written", () => {
    const map: PastMap = {};
    recordPast(map, "normal", thread(1));
    recordPast(map, "secret", thread(2, { turns: [turn({ answer: "the incognito answer", partial: "the incognito answer" })] }));
    const s = new Mem();
    savePast(map, s, (c) => c === "secret");
    expect(s.getItem(PAST_KEY)).not.toContain("the incognito answer");
    expect(Object.keys(loadPast(s))).toEqual(["normal"]);
  });

  it("a broken store reads as no history", () => {
    const s = new Mem();
    s.setItem(PAST_KEY, "{not json");
    expect(loadPast(s)).toEqual({});
    s.setItem(PAST_KEY, JSON.stringify({ c: [{ key: 1 }, "x"] }));
    expect(loadPast(s)).toEqual({});
  });

  it("a row's quote snippet is one line, shortened", () => {
    expect(quoteSnippet(null)).toBe("From the composer");
    expect(quoteSnippet("a\n  b")).toBe("a b");
    expect(quoteSnippet("x".repeat(80), 10)).toBe("xxxxxxxxx…");
  });
});

describe("closing a card keeps it under Past; reopening brings it back (item 229)", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
    for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
    app.connection = { engine: "claude-code" } as typeof app.connection;
  });

  it("× on an answered card moves it to the chat's Past; reopen restores it as a card", () => {
    app.activeSessionId = "chat-1";
    app.asides = [thread(1), thread(2)];
    dismissAside(app.asides[0]!);
    expect(app.asides.map((a) => a.quote?.text)).toEqual(["passage 2"]);
    const past = pastOf("chat-1");
    expect(past.length).toBe(1);
    expect(past[0]!.thread.quote?.text).toBe("passage 1");

    const back = reopenPast(past[0]!.key)!;
    expect(back.quote?.text).toBe("passage 1");
    expect(back.turns.map((t) => t.question)).toEqual(["why", "and then?"]);
    expect(app.asides.map((a) => a.quote?.text)).toEqual(["passage 2", "passage 1"]);
    expect(pastOf("chat-1").length).toBe(0);
  });

  it("× on a draft keeps nothing", () => {
    app.activeSessionId = "chat-2";
    const d = draftAside({ text: "p", role: "assistant", ordinal: 1 })!;
    dismissAside(d);
    expect(pastOf("chat-2").length).toBe(0);
  });

  it("closing a stashed chat's thread (its tab's ×) files it under that chat", () => {
    app.activeSessionId = "chat-3";
    app.asides = [thread(7)];
    switchAside("chat-4");
    app.activeSessionId = "chat-4";
    // chat-3's thread is in the stash now; its tab's × dismisses it there.
    const stashed = asideStash.get("chat-3")![0]!;
    dismissAside(stashed);
    expect(asideStash.has("chat-3")).toBe(false);
    expect(pastOf("chat-3").map((p) => p.thread.quote?.text)).toEqual(["passage 7"]);
    expect(pastOf("chat-4").length).toBe(0);
  });
});
