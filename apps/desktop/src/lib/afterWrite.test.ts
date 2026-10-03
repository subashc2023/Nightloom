import { afterEach, describe, expect, it, vi } from "vitest";
import { madeChatRow, refreshWithin, withNote, withoutNote } from "./afterWrite";
import type { Note, SessionMeta } from "./types";

const note = (name: string, bytes = 1): Note => ({ name, bytes, modified: "2026-09-25T20:05:00Z", summary: null });

describe("refreshWithin (backlog 211)", () => {
  afterEach(() => vi.useRealTimers());

  it("is done when every step finishes", async () => {
    const log = vi.fn();
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    expect(await refreshWithin("saving x", [a, b], 1000, log)).toBe("done");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("settles at the limit when a step hangs, and logs it", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const hung = () => new Promise<void>(() => {});
    const end = refreshWithin("saving opus.md", [hung], 10_000, log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await end).toBe("timed-out");
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("saving opus.md");
  });

  it("logs a failed step rather than throwing", async () => {
    const log = vi.fn();
    const bad = async () => {
      throw new Error("iCloud said no");
    };
    expect(await refreshWithin("deleting x", [bad], 1000, log)).toBe("failed");
    expect(log.mock.calls[0][0]).toContain("iCloud said no");
  });

  it("a step that throws synchronously is a failure too", async () => {
    const log = vi.fn();
    const bad = (): Promise<void> => {
      throw new Error("sync");
    };
    expect(await refreshWithin("x", [bad], 1000, log)).toBe("failed");
  });
});

describe("the lists a write patches", () => {
  it("withNote replaces a note of that name in place, else adds it first", () => {
    const list = [note("a.md"), note("b.md")];
    expect(withNote(list, note("b.md", 9)).map((n) => [n.name, n.bytes])).toEqual([
      ["a.md", 1],
      ["b.md", 9],
    ]);
    expect(withNote(list, note("c.md")).map((n) => n.name)).toEqual(["c.md", "a.md", "b.md"]);
    expect(list.length).toBe(2); // not mutated
  });

  it("withoutNote drops only that name", () => {
    expect(withoutNote([note("a.md"), note("b.md")], "a.md").map((n) => n.name)).toEqual(["b.md"]);
  });

  it("madeChatRow builds a New chat's row from what was sent", () => {
    const now = new Date("2026-09-25T20:20:00Z");
    const row = madeChatRow([], "162d1dc8", "What is value generalization?", "normal", "build", now);
    expect(row).toEqual({
      id: "162d1dc8",
      path: "",
      modified: "2026-09-25T20:20:00.000Z",
      user_turns: 1,
      first_user: "What is value generalization?",
      title: null,
    });
    expect(madeChatRow([], "x", "hi", "incognito", "chat", now)).toMatchObject({ mode: "incognito", kind: "chat" });
  });

  it("madeChatRow adds nothing for a listed chat, an ephemeral one, or no id", () => {
    const listed = [{ id: "x" } as SessionMeta];
    expect(madeChatRow(listed, "x", "hi", "normal", "build")).toBeNull();
    expect(madeChatRow([], "y", "hi", "ephemeral", "build")).toBeNull();
    expect(madeChatRow([], "", "hi", "normal", "build")).toBeNull();
  });
});
