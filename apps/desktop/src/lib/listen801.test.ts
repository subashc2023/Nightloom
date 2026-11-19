// Item 801: Listen's kept place and speed, and its words.
import { describe, expect, it } from "vitest";
import { MAX_PLACES, clock, listenKey, loadPlace, loadRate, nextSpeed, savePlace, saveRate, speedWords, textId } from "./listen";

function mem() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("item 801: Listen", () => {
  it("cycles the speed and keeps it", () => {
    expect(nextSpeed(1)).toBe(1.25);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(7)).toBe(1);
    const s = mem();
    expect(loadRate(s)).toBe(1);
    saveRate(s, 1.5);
    expect(loadRate(s)).toBe(1.5);
    expect(speedWords(1.25)).toBe("1.25×");
    expect(speedWords(1.5)).toBe("1.5×");
    expect(speedWords(2)).toBe("2×");
  });

  it("keeps a place per thing, and forgets it at the end", () => {
    const s = mem();
    const k = listenKey("note", "project:todo.md", false);
    savePlace(s, k, 42.5, 120);
    expect(loadPlace(s, k)).toBe(42.5);
    expect(loadPlace(s, listenKey("note", "project:todo.md", true))).toBe(0);
    savePlace(s, k, 119, 120);
    expect(loadPlace(s, k)).toBe(0);
  });

  it("keeps at most MAX_PLACES places, dropping the oldest", () => {
    const s = mem();
    for (let i = 0; i <= MAX_PLACES; i++) savePlace(s, `reply:${i}`, 5, 100, i);
    expect(loadPlace(s, "reply:0")).toBe(0);
    expect(loadPlace(s, `reply:${MAX_PLACES}`)).toBe(5);
  });

  it("says time as m:ss and gives words a stable id", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(75.9)).toBe("1:15");
    expect(clock(NaN)).toBe("0:00");
    expect(textId("a reply")).toBe(textId("a reply"));
    expect(textId("a reply")).not.toBe(textId("another"));
  });
});
