import { describe, expect, it } from "vitest";
import { baseName, loadSeen, newestAt, projectKey, saveSeen, SEEN_KEY, unseenCount, type ForYouRow } from "./forYou";

/** Files for him (nightshift backlog 377): the dot's arithmetic and its memory. */
const row = (rel: string, at: string, folder = false): ForYouRow => ({ path: `/p/${rel}`, rel, folder, title: null, at });

describe("the folder button's dot", () => {
  const rows = [row("b.md", "2026-10-18T12:00:05Z"), row("a.md", "2026-10-18T11:00:00Z")];

  it("counts what was marked after he last looked, all of it when he never has", () => {
    expect(unseenCount(rows, undefined)).toBe(2);
    expect(unseenCount(rows, "2026-10-18T11:30:00Z")).toBe(1);
    expect(unseenCount(rows, "2026-10-18T12:00:05Z")).toBe(0);
    expect(unseenCount([], undefined)).toBe(0);
  });

  it("opening the list marks the newest row seen", () => {
    expect(newestAt(rows)).toBe("2026-10-18T12:00:05Z");
    expect(newestAt([])).toBeNull();
    expect(unseenCount(rows, newestAt(rows)!)).toBe(0);
  });

  it("keeps last-looked per project, unfiled chats under one key, and survives junk", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadSeen(store)).toEqual({});
    saveSeen(store, { [projectKey("p1")]: "x", [projectKey(null)]: "y" });
    expect(loadSeen(store)).toEqual({ p1: "x", "(unfiled)": "y" });
    mem.set(SEEN_KEY, "not json");
    expect(loadSeen(store)).toEqual({});
    mem.set(SEEN_KEY, "[1]");
    expect(loadSeen(store)).toEqual({});
    expect(loadSeen(undefined)).toEqual({});
  });

  it("names a row by its last segment", () => {
    expect(baseName("/a/b/report.md")).toBe("report.md");
    expect(baseName("/a/b/results/")).toBe("results");
    expect(baseName("C:\\x\\y.txt")).toBe("y.txt");
  });
});
