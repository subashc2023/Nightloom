import { describe, expect, it } from "vitest";
import {
  ASIDES_KEY,
  ASIDES_MAX_CHARS,
  isPrivateChat,
  loadAsides,
  markChatMode,
  resetPrivateChats,
  saveAsides,
  serializeAsides,
} from "./asides";
import type { Aside, AsideTurn } from "./state.svelte";

const turn = (over: Partial<AsideTurn>): AsideTurn => ({
  seq: 3,
  question: "why",
  partial: "because",
  answer: "because",
  error: null,
  cancelled: false,
  cacheRead: 100,
  ...over,
});

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("the aside threads across a relaunch (backlog 137)", () => {
  it("keeps each chat's thread — questions, answers, the quote — and drops a draft", () => {
    const map = new Map<string, Aside[]>([
      [
        "a",
        [
          {
            id: 1,
            quote: { text: "the passage", role: "assistant", ordinal: 2 },
            draft: false,
            turns: [turn({}), turn({ seq: 4, question: "and?", partial: "so", answer: "so" })],
            anchor: { turn: 3, block: 0, start: 12, end: 40, side: "below" },
          },
        ],
      ],
      ["b", [{ id: 2, quote: null, draft: true, turns: [], anchor: null }]],
    ]);
    const s = new Mem();
    saveAsides(map, s);
    const back = loadAsides(s);
    expect([...back.keys()]).toEqual(["a"]);
    const a = back.get("a")![0]!;
    expect(a.quote).toEqual({ text: "the passage", role: "assistant", ordinal: 2 });
    expect(a.draft).toBe(false);
    // The passage's place (backlog 141) comes back with the thread, so the
    // card opens under it again; a stored thread without one reads as null.
    expect(a.anchor).toEqual({ turn: 3, block: 0, start: 12, end: 40, side: "below" });
    expect(a.turns.map((t) => [t.question, t.answer])).toEqual([
      ["why", "because"],
      ["and?", "so"],
    ]);
    // Loaded turns carry negative, distinct seqs: the card keys on them,
    // and no live exchange (positive) can match one.
    expect(a.turns.map((t) => t.seq < 0)).toEqual([true, true]);
    expect(a.turns[0]!.seq).not.toBe(a.turns[1]!.seq);
  });

  it("a turn still asking comes back cut short with what had arrived, or not at all", () => {
    const map = new Map<string, Aside[]>([
      [
        "a",
        [
          {
            id: 1,
            quote: null,
            draft: false,
            turns: [turn({ partial: "half an", answer: null }), turn({ question: "empty", partial: "", answer: null })],
            anchor: null,
          },
        ],
      ],
    ]);
    const s = new Mem();
    saveAsides(map, s);
    const a = loadAsides(s).get("a")![0]!;
    expect(a.turns.length).toBe(1);
    expect(a.turns[0]!.answer).toBe("half an");
    expect(a.turns[0]!.cancelled).toBe(true);
  });

  it("trims the oldest threads past the cap and survives a broken store", () => {
    const map = new Map<string, Aside[]>();
    for (let i = 0; i < 6; i++) {
      map.set(`c${i}`, [{ id: i, quote: null, draft: false, turns: [turn({ answer: "x".repeat(200 * 1024), partial: "" })], anchor: null }]);
    }
    const out = serializeAsides(map);
    expect(out.length).toBeLessThanOrEqual(ASIDES_MAX_CHARS);
    const kept = Object.keys(JSON.parse(out) as object);
    expect(kept).toEqual(["c4", "c5"]);
    const s = new Mem();
    s.setItem("nightloom.asides", "{not json");
    expect(loadAsides(s).size).toBe(0);
  });

  it("keeps every open thread of a chat, in order, each with its own id (backlog 176)", () => {
    const two: Aside[] = [
      { id: 1, quote: { text: "first", role: "assistant", ordinal: 1 }, draft: false, turns: [turn({})], anchor: null },
      { id: 2, quote: { text: "second", role: "user", ordinal: 2 }, draft: false, turns: [turn({ question: "how" })], anchor: null },
    ];
    const s = new Mem();
    saveAsides(new Map([["a", two]]), s);
    const back = loadAsides(s).get("a")!;
    expect(back.map((a) => a.quote?.text)).toEqual(["first", "second"]);
    expect(back.map((a) => a.turns[0]!.question)).toEqual(["why", "how"]);
    expect(new Set(back.map((a) => a.id)).size).toBe(2);
  });

  it("reads a store written before, one thread per chat, as a list of one", () => {
    const s = new Mem();
    s.setItem(
      "nightloom.asides",
      JSON.stringify({ a: { quote: null, turns: [{ question: "old", answer: "kept", error: null, cancelled: false }] } }),
    );
    const back = loadAsides(s).get("a")!;
    expect(back.length).toBe(1);
    expect(back[0]!.turns[0]!.answer).toBe("kept");
  });
});

describe("an incognito or ephemeral chat's threads stay off disk (blocker 217)", () => {
  const thread = (id: number, answer: string): Aside => ({
    id,
    quote: null,
    draft: false,
    turns: [turn({ answer, partial: answer })],
    anchor: null,
  });

  it("writes a normal chat's thread and leaves a private one out", () => {
    const map = new Map<string, Aside[]>([
      ["normal", [thread(1, "kept")]],
      ["secret", [thread(2, "the incognito answer")]],
    ]);
    const out = serializeAsides(map, (c) => c === "secret");
    expect(out).toContain("kept");
    expect(out).not.toContain("the incognito answer");
    expect(Object.keys(JSON.parse(out) as object)).toEqual(["normal"]);
  });

  it("drops a private chat's thread stored before the rule at the next save", () => {
    const s = new Mem();
    saveAsides(new Map([["secret", [thread(1, "old")]], ["normal", [thread(2, "mine")]]]), s);
    const loaded = loadAsides(s);
    expect([...loaded.keys()]).toEqual(["secret", "normal"]);
    saveAsides(loaded, s, (c) => c === "secret");
    expect(s.getItem(ASIDES_KEY)).not.toContain("old");
    expect([...loadAsides(s).keys()]).toEqual(["normal"]);
  });

  it("reads a chat's privacy from its listing row, else from what was seen open", () => {
    resetPrivateChats();
    const sessions = [{ id: "n" }, { id: "i", mode: "incognito" as const }, { id: "x", mode: "normal" as const }];
    expect(isPrivateChat("n", sessions)).toBe(false);
    expect(isPrivateChat("i", sessions)).toBe(true);
    // An ephemeral chat is never listed: only its being seen open marks it.
    expect(isPrivateChat("e", sessions)).toBe(false);
    markChatMode("e", "ephemeral");
    markChatMode("n2", "normal");
    expect(isPrivateChat("e", sessions)).toBe(true);
    expect(isPrivateChat("n2", sessions)).toBe(false);
    // A listed row is the authority: a mode is fixed at birth.
    markChatMode("x", "incognito");
    expect(isPrivateChat("x", sessions)).toBe(false);
    resetPrivateChats();
    expect(isPrivateChat("e", sessions)).toBe(false);
  });
});
