import { describe, expect, it } from "vitest";
import { LIST_SCOPE, UndoHistory } from "./undo";

/** An entry that appends to `trail` so the order of calls can be read back. */
function entry(trail: string[], label: string) {
  return {
    label,
    undo: () => {
      trail.push(`undo ${label}`);
    },
    redo: () => {
      trail.push(`redo ${label}`);
    },
  };
}

describe("UndoHistory", () => {
  it("undoes newest first and redoes in the order undone", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    h.push("a", entry(trail, "rewind"));
    h.push("a", entry(trail, "remove"));
    expect(h.undoLabel(["a"])).toBe("remove");
    expect(h.redoLabel(["a"])).toBeNull();

    expect(await h.undo(["a"])).toEqual({ label: "remove" });
    expect(await h.undo(["a"])).toEqual({ label: "rewind" });
    expect(await h.undo(["a"])).toBeNull();
    expect(h.undoLabel(["a"])).toBeNull();
    expect(h.redoLabel(["a"])).toBe("rewind");

    expect(await h.redo(["a"])).toEqual({ label: "rewind" });
    expect(await h.redo(["a"])).toEqual({ label: "remove" });
    expect(await h.redo(["a"])).toBeNull();
    expect(trail).toEqual(["undo remove", "undo rewind", "redo rewind", "redo remove"]);
  });

  it("clears the redo tail on a new push", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    h.push("a", entry(trail, "one"));
    h.push("a", entry(trail, "two"));
    await h.undo(["a"]);
    expect(h.redoLabel(["a"])).toBe("two");
    h.push("a", entry(trail, "three"));
    expect(h.redoLabel(["a"])).toBeNull();
    expect(h.undoLabel(["a"])).toBe("three");
    await h.undo(["a"]);
    await h.undo(["a"]);
    expect(trail).toEqual(["undo two", "undo three", "undo one"]);
  });

  it("keeps one chat's history out of another's", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    h.push("a", entry(trail, "rewind in a"));
    h.push("b", entry(trail, "edit in b"));
    expect(h.undoLabel(["a"])).toBe("rewind in a");
    expect(h.undoLabel(["b"])).toBe("edit in b");
    expect(await h.undo(["b"])).toEqual({ label: "edit in b" });
    expect(h.undoLabel(["a"])).toBe("rewind in a");
    expect(h.redoLabel(["a"])).toBeNull();
    expect(h.redoLabel(["b"])).toBe("edit in b");
    expect(await h.undo(["b"])).toBeNull();
    h.clear("a");
    expect(h.undoLabel(["a"])).toBeNull();
    expect(h.redoLabel(["b"])).toBe("edit in b");
  });

  it("takes the list's entries beside the open chat's, by recency", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    h.push("a", entry(trail, "rewind"));
    h.push(LIST_SCOPE, entry(trail, "rename"));
    h.push("a", entry(trail, "remove"));
    // Newest first across the two scopes.
    expect(await h.undo(["a", LIST_SCOPE])).toEqual({ label: "remove" });
    expect(await h.undo(["a", LIST_SCOPE])).toEqual({ label: "rename" });
    expect(await h.undo(["a", LIST_SCOPE])).toEqual({ label: "rewind" });
    // Redo goes back the way it came.
    expect(await h.redo(["a", LIST_SCOPE])).toEqual({ label: "rewind" });
    expect(await h.redo(["a", LIST_SCOPE])).toEqual({ label: "rename" });
    expect(await h.redo(["a", LIST_SCOPE])).toEqual({ label: "remove" });
    // From another chat, only the list's entry is reachable.
    expect(h.undoLabel(["b", LIST_SCOPE])).toBe("rename");
  });

  it("does nothing while a turn is running", async () => {
    let busy = true;
    const h = new UndoHistory(() => busy);
    const trail: string[] = [];
    h.push("a", entry(trail, "rewind"));
    expect(await h.undo(["a"])).toBeNull();
    expect(trail).toEqual([]);
    busy = false;
    expect(await h.undo(["a"])).toEqual({ label: "rewind" });
    busy = true;
    expect(await h.redo(["a"])).toBeNull();
    expect(trail).toEqual(["undo rewind"]);
  });

  it("leaves the cursor alone when a closure rejects", async () => {
    const h = new UndoHistory();
    h.push("a", {
      label: "rewind",
      undo: () => Promise.reject(new Error("refused")),
      redo: () => {},
    });
    await expect(h.undo(["a"])).rejects.toThrow("refused");
    expect(h.undoLabel(["a"])).toBe("rewind");
    expect(h.redoLabel(["a"])).toBeNull();
  });

  // The toast's Undo (nightshift backlog 066): one entry, by handle, only
  // while it is still the one an undo would take.
  it("undoIf reverses the handled entry only while it is next", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    const first = h.push("a", entry(trail, "remove"));
    const second = h.push("a", entry(trail, "edit"));
    expect(await h.undoIf(["a"], first)).toBeNull();
    expect(trail).toEqual([]);
    expect(await h.undoIf(["a"], second)).toEqual({ label: "edit" });
    expect(await h.undoIf(["a"], first)).toEqual({ label: "remove" });
    expect(await h.undoIf(["a"], first)).toBeNull();
    expect(trail).toEqual(["undo edit", "undo remove"]);
    // A list entry pushed later outranks the chat's for the same handle.
    const third = h.push("a", entry(trail, "rewind"));
    h.push(LIST_SCOPE, entry(trail, "rename"));
    expect(await h.undoIf(["a", LIST_SCOPE], third)).toBeNull();
  });

  // A held ⌘Z (review E, 2026-09-17): the second call arrives while the
  // first closure is still awaiting its IPC. It must not run the same
  // closure again nor move the cursor twice — before the guard, N calls in
  // flight ran the top entry N times and drove the cursor to -(N-1).
  it("a second undo or redo while one is in flight is a no-op", async () => {
    const h = new UndoHistory();
    const trail: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    h.push("a", entry(trail, "rewind"));
    h.push("a", {
      label: "edit",
      undo: async () => {
        trail.push("undo edit");
        await gate;
      },
      redo: async () => {
        trail.push("redo edit");
        await gate;
      },
    });
    const first = h.undo(["a"]);
    const second = h.undo(["a"]);
    expect(await second).toBeNull();
    release();
    expect(await first).toEqual({ label: "edit" });
    expect(trail).toEqual(["undo edit"]);
    // The stack is intact: the older entry is still next, and the undone
    // one is the one redo takes.
    expect(h.undoLabel(["a"])).toBe("rewind");
    expect(h.redoLabel(["a"])).toBe("edit");

    const r1 = h.redo(["a"]);
    const r2 = h.redo(["a"]);
    expect(await r2).toBeNull();
    expect(await r1).toEqual({ label: "edit" });
    expect(trail).toEqual(["undo edit", "redo edit"]);
    expect(h.undoLabel(["a"])).toBe("edit");
    expect(h.redoLabel(["a"])).toBeNull();
  });
});
