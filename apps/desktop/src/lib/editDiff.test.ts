import { describe, expect, it } from "vitest";
import { EDIT_DIFF_FOLD, editDiffOf, foldDiff, shortPath } from "./editDiff";

// Backlog 433: file-editing calls drawn as diffs in the transcript.
describe("editDiffOf", () => {
  it("diffs an Edit's old and new strings by line", () => {
    const d = editDiffOf("Edit", {
      file_path: "/repo/src/a.ts",
      old_string: "one\ntwo\nthree",
      new_string: "one\nTWO\nthree\nfour",
    })!;
    expect(d.verb).toBe("Edit");
    expect(d.path).toBe("/repo/src/a.ts");
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:one",
      "del:two",
      "add:TWO",
      "ctx:three",
      "add:four",
    ]);
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.whole).toBe(false);
  });

  it("marks replace_all", () => {
    expect(editDiffOf("Edit", { file_path: "a", old_string: "x", new_string: "y", replace_all: true })!.everyMatch).toBe(
      true,
    );
  });

  it("joins a MultiEdit's edits with a divider and counts across them", () => {
    const d = editDiffOf("MultiEdit", {
      file_path: "/r/b.rs",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "" },
      ],
    })!;
    expect(d.lines.map((l) => (l.sep ? "sep" : `${l.kind}:${l.text}`))).toEqual(["del:a", "add:b", "sep", "del:c"]);
    expect([d.added, d.removed]).toEqual([1, 2]);
  });

  it("draws a Write as every line added, a whole file", () => {
    const d = editDiffOf("Write", { file_path: "/r/new.md", content: "# Title\n\nbody\n" })!;
    expect(d.verb).toBe("Write");
    expect(d.whole).toBe(true);
    expect(d.lines.every((l) => l.kind === "add")).toBe(true);
    expect(d.added).toBe(3);
  });

  it("reads the provider engine's edit_file and write_file (path, not file_path)", () => {
    expect(editDiffOf("edit_file", { path: "x.txt", old_string: "a", new_string: "b" })!.path).toBe("x.txt");
    expect(editDiffOf("write_file", { path: "y.txt", content: "z" })!.added).toBe(1);
  });

  it("is null for other tools and for inputs it cannot read", () => {
    expect(editDiffOf("Bash", { command: "ls" })).toBeNull();
    expect(editDiffOf("Edit", { file_path: "a" })).toBeNull();
    expect(editDiffOf("Edit", null)).toBeNull();
    expect(editDiffOf("Write", { content: "no path" })).toBeNull();
    expect(editDiffOf("MultiEdit", { file_path: "a", edits: [{ old_string: 1 }] })).toBeNull();
  });
});

describe("foldDiff", () => {
  const lines = Array.from({ length: EDIT_DIFF_FOLD + 5 }, (_, i) => ({ kind: "add" as const, text: String(i) }));
  it("shows the first lines and counts the rest past the fold", () => {
    const f = foldDiff(lines, false);
    expect(f.shown.length).toBe(EDIT_DIFF_FOLD);
    expect(f.hidden).toBe(5);
  });
  it("shows every line when asked, or when short", () => {
    expect(foldDiff(lines, true).hidden).toBe(0);
    expect(foldDiff(lines.slice(0, 3), false).shown.length).toBe(3);
  });
});

describe("shortPath", () => {
  it("splits the folder from the name", () => {
    expect(shortPath("/a/b/c.ts")).toEqual({ dir: "/a/b/", name: "c.ts" });
    expect(shortPath("c.ts")).toEqual({ dir: "", name: "c.ts" });
  });
});
