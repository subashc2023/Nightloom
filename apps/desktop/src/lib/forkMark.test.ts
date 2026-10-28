import { describe, expect, it } from "vitest";
import { FORK_GLYPH, forkMark } from "./forkMark";
import type { ForkedFrom, SessionMeta } from "./types";
import { tabFork } from "./tabs";
import { sidebarSessions } from "./versions";

function meta(id: string, title: string | null, from?: ForkedFrom): SessionMeta {
  return {
    id,
    path: `/x/${id}.jsonl`,
    modified: "2026-10-18T00:00:00Z",
    user_turns: 1,
    first_user: `opening of ${id}`,
    title,
    ...(from ? { forked_from: from } : {}),
  };
}

describe("forkMark (backlog 379)", () => {
  it("is the fork glyph", () => {
    expect(FORK_GLYPH).toBe("⑂");
  });

  it("marks an edit-and-send or Retry fork and names its parent", () => {
    const parent = meta("6be24d46", "I want you to do a pretty long thing");
    const fork = meta("c1033f28", "I want you to do a pretty long thing", { session: "6be24d46", index: 4 });
    expect(forkMark(fork, [fork, parent])).toEqual({
      parent: "I want you to do a pretty long thing",
      tip: "Fork of I want you to do a pretty long thing",
    });
  });

  it("names an untitled parent by its opening message, as its row does", () => {
    const parent = meta("p", null);
    const fork = meta("f", null, { session: "p", index: 2 });
    expect(forkMark(fork, [fork, parent])?.tip).toBe("Fork of opening of p");
  });

  it("shortens a long parent name", () => {
    const parent = meta("p", "x".repeat(100));
    const fork = meta("f", null, { session: "p", index: 2 });
    const m = forkMark(fork, [fork, parent], 20)!;
    expect(m.parent).toHaveLength(20);
    expect(m.parent!.endsWith("…")).toBe(true);
  });

  it("gives a top-level chat no mark", () => {
    const top = meta("a", "A chat");
    expect(forkMark(top, [top])).toBeNull();
    expect(forkMark(undefined, [top])).toBeNull();
  });

  it("gives a hand-off continuation no mark", () => {
    const full = meta("full", "A long chat");
    const cont = meta("cont", null, { session: "full", index: 40, reason: "handoff" });
    expect(forkMark(cont, [cont, full])).toBeNull();
  });

  it("keeps the mark but no name when the parent is deleted", () => {
    const fork = meta("f", "Mine", { session: "gone", index: 2 });
    expect(forkMark(fork, [fork])).toEqual({ parent: null, tip: "Fork of a deleted chat" });
  });

  it("gives a version made main over a top-level original no mark on its row", () => {
    const orig = meta("o", "Q");
    const edit = meta("e", "Q", { session: "o", index: 2 });
    const drawn = sidebarSessions([edit, orig], { o: "e" });
    expect(drawn.map((s) => s.id)).toEqual(["e"]);
    expect(forkMark(drawn[0], [edit, orig])).toBeNull();
    // Its tab shows the chat as it is: still a fork of the original.
    expect(forkMark(edit, [edit, orig])?.tip).toBe("Fork of Q");
  });
});

describe("tabFork (backlog 379)", () => {
  const parent = meta("p", "Same title");
  const fork = meta("f", "Same title", { session: "p", index: 4 });
  const cont = meta("c", null, { session: "p", index: 9, reason: "handoff" });
  const list = [fork, parent, cont];

  it("marks a fork's chat tab with its parent's name", () => {
    expect(tabFork({ kind: "chat", session: "f" }, list)?.tip).toBe("Fork of Same title");
  });

  it("leaves the parent's tab, a hand-off's and a new chat's unmarked", () => {
    expect(tabFork({ kind: "chat", session: "p" }, list)).toBeNull();
    expect(tabFork({ kind: "chat", session: "c" }, list)).toBeNull();
    expect(tabFork({ kind: "chat", session: null }, list)).toBeNull();
  });

  it("marks a fork whose parent was deleted, with no name", () => {
    expect(tabFork({ kind: "chat", session: "f" }, [fork])).toEqual({ parent: null, tip: "Fork of a deleted chat" });
  });

  it("never marks a tab that is not a chat", () => {
    expect(tabFork({ kind: "aside", session: "f" }, list)).toBeNull();
    expect(tabFork({ kind: "nightshift" }, list)).toBeNull();
  });
});
