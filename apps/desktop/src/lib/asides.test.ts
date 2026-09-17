import { describe, expect, it } from "vitest";
import { ASIDES_MAX_CHARS, loadAsides, saveAsides, serializeAsides } from "./asides";
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
    const map = new Map<string, Aside>([
      [
        "a",
        {
          quote: { text: "the passage", role: "assistant", ordinal: 2 },
          draft: false,
          turns: [turn({}), turn({ seq: 4, question: "and?", partial: "so", answer: "so" })],
        },
      ],
      ["b", { quote: null, draft: true, turns: [] }],
    ]);
    const s = new Mem();
    saveAsides(map, s);
    const back = loadAsides(s);
    expect([...back.keys()]).toEqual(["a"]);
    const a = back.get("a")!;
    expect(a.quote).toEqual({ text: "the passage", role: "assistant", ordinal: 2 });
    expect(a.draft).toBe(false);
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
    const map = new Map<string, Aside>([
      [
        "a",
        {
          quote: null,
          draft: false,
          turns: [turn({ partial: "half an", answer: null }), turn({ question: "empty", partial: "", answer: null })],
        },
      ],
    ]);
    const s = new Mem();
    saveAsides(map, s);
    const a = loadAsides(s).get("a")!;
    expect(a.turns.length).toBe(1);
    expect(a.turns[0]!.answer).toBe("half an");
    expect(a.turns[0]!.cancelled).toBe(true);
  });

  it("trims the oldest threads past the cap and survives a broken store", () => {
    const map = new Map<string, Aside>();
    for (let i = 0; i < 6; i++) {
      map.set(`c${i}`, { quote: null, draft: false, turns: [turn({ answer: "x".repeat(200 * 1024), partial: "" })] });
    }
    const out = serializeAsides(map);
    expect(out.length).toBeLessThanOrEqual(ASIDES_MAX_CHARS);
    const kept = Object.keys(JSON.parse(out) as object);
    expect(kept).toEqual(["c4", "c5"]);
    const s = new Mem();
    s.setItem("nightloom.asides", "{not json");
    expect(loadAsides(s).size).toBe(0);
  });
});
