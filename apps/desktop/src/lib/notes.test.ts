import { describe, expect, it } from "vitest";
import { modelInstructionFile, modelOfInstructionFile } from "./catalog";
import { notesTree } from "./nightshift";
import type { NoteEntry, NoteScope } from "./types";

function entry(path: string, is_dir: boolean, size = 0, modified = ""): NoteEntry {
  const idx = path.lastIndexOf("/");
  const name = idx === -1 ? path : path.slice(idx + 1);
  return { path, name, is_dir, size, modified };
}

describe("notesTree", () => {
  it("nests file paths under synthesized ancestor directories", () => {
    const tree = notesTree([
      entry("notes/runner-design/a.md", false, 100, "2026-09-11T00:00:00Z"),
      entry("notes/runner-design/b.md", false, 50, "2026-09-10T00:00:00Z"),
      entry("notes/top.md", false, 10, "2026-09-09T00:00:00Z"),
    ]);

    expect(tree.map((n) => n.name)).toEqual(["notes"]);
    const notesDir = tree[0];
    expect(notesDir.is_dir).toBe(true);
    // dirs sort before files: runner-design before top.md
    expect(notesDir.children.map((n) => n.name)).toEqual(["runner-design", "top.md"]);
    const sub = notesDir.children[0];
    expect(sub.is_dir).toBe(true);
    expect(sub.children.map((n) => n.name)).toEqual(["a.md", "b.md"]);
    expect(sub.children[0].size).toBe(100);
    expect(sub.children[0].path).toBe("notes/runner-design/a.md");
  });

  it("fills in real metadata when a directory is listed explicitly", () => {
    const tree = notesTree([
      entry("notes", true, 0, "2026-09-11T12:00:00Z"),
      entry("notes/a.md", false, 20, "2026-09-11T12:00:00Z"),
    ]);
    expect(tree[0].modified).toBe("2026-09-11T12:00:00Z");
    expect(tree[0].is_dir).toBe(true);
  });

  it("sorts directories before files, then alphabetically within each group", () => {
    const tree = notesTree([
      entry("notes/z.md", false),
      entry("notes/a.md", false),
      entry("notes/mid/x.md", false),
    ]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["mid", "a.md", "z.md"]);
  });

  it("returns an empty tree for no entries", () => {
    expect(notesTree([])).toEqual([]);
  });
});

describe("the models note scope", () => {
  it("names a model's file after its id, with a slash written as __", () => {
    expect(modelInstructionFile("claude-opus-5")).toBe("claude-opus-5.md");
    expect(modelInstructionFile("deepseek/deepseek-v4-flash")).toBe(
      "deepseek__deepseek-v4-flash.md",
    );
    // A `:` is a legal file name and is kept; whitespace is not part of an id.
    expect(modelInstructionFile(" openrouter:a/b ")).toBe("openrouter:a__b.md");
    expect(modelOfInstructionFile("deepseek__deepseek-v4-flash.md")).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(modelOfInstructionFile(modelInstructionFile("x/y/z"))).toBe("x/y/z");
  });

  it("is one of the scopes a note call accepts", () => {
    // The union is what the backend's `NoteScope` deserializes; a value
    // missing here cannot be sent, and one missing there is an error.
    const scopes: NoteScope[] = ["project", "knowledge", "instructions", "memory", "models"];
    expect(scopes).toContain("models");
  });
});
