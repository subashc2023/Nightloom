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
});
