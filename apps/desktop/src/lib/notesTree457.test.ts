import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildTree,
  cleanName,
  dropTarget,
  fileIcon,
  loadOpen,
  movedName,
  openKey,
  renamedOpen,
  saveOpen,
  visibleRows,
} from "./notesTree";
import type { Note } from "./types";

const note = (name: string, kind?: string): Note => ({ name, bytes: 1, modified: "2026-10-28T00:00:00Z", summary: null, kind });
const labels = (rows: ReturnType<typeof visibleRows>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? `${r.open ? "v" : ">"} ${r.name} (${r.count})` : r.label}`);

describe("item 457: the notes tree", () => {
  const notes = [note("todo.md"), note("people/alice.md"), note("people/bob.md"), note("people/eng/n10.md"), note("people/eng/n2.md"), note("a.md")];

  it("nests by folder, folders first, natural order, counts below", () => {
    const tree = buildTree(notes, ["empty"]);
    expect(labels(visibleRows(tree, new Set(["people", "people/eng"])))).toEqual([
      "> empty (0)",
      "v people (4)",
      "  v eng (2)",
      "    n2.md",
      "    n10.md",
      "  alice.md",
      "  bob.md",
      "a.md",
      "todo.md",
    ]);
  });

  it("shows a closed folder's row and none of its contents", () => {
    expect(labels(visibleRows(buildTree(notes), new Set()))).toEqual(["> people (4)", "a.md", "todo.md"]);
  });

  it("opens every folder for a search", () => {
    const rows = visibleRows(buildTree([note("people/eng/n2.md")]), new Set(), true);
    expect(labels(rows)).toEqual(["v people (1)", "  v eng (1)", "    n2.md"]);
  });

  it("renders 500 notes in nested folders, every one reachable", () => {
    const many = Array.from({ length: 500 }, (_, i) => note(`f${i % 10}/g${i % 3}/n${i}.md`));
    const tree = buildTree(many);
    const all = visibleRows(tree, new Set(), true).filter((r) => r.kind === "note");
    expect(all).toHaveLength(500);
    expect(tree.count).toBe(500);
  });

  it("renames what sits under a moved folder, and nothing else", () => {
    expect(movedName("people/alice.md", "people", "crm")).toBe("crm/alice.md");
    expect(movedName("people", "people", "crm")).toBe("crm");
    expect(movedName("peoplex/a.md", "people", "crm")).toBeNull();
    expect([...renamedOpen(new Set(["people", "people/eng", "x"]), "people", "crm")].sort()).toEqual(["crm", "crm/eng", "x"]);
  });

  it("drops onto a folder, never into itself or where it already is", () => {
    expect(dropTarget("alice.md", "people")).toBe("people/alice.md");
    expect(dropTarget("people/alice.md", "")).toBe("alice.md");
    expect(dropTarget("people/alice.md", "people")).toBeNull();
    expect(dropTarget("people", "people/eng")).toBeNull();
    expect(dropTarget("people", "people")).toBeNull();
    expect(dropTarget("people/eng", "archive")).toBe("archive/eng");
  });

  it("cleans a typed name and lists ancestors", () => {
    expect(cleanName(" /a// b /c.md/ ")).toBe("a/b/c.md");
    expect(cleanName("  ")).toBe("");
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
  });

  it("gives a file row an icon by what it is", () => {
    expect(fileIcon(note("x.md"))).toBe("text");
    expect(fileIcon(note("x.pdf", "PDF"))).toBe("pdf");
    expect(fileIcon(note("x.png", "PNG image"))).toBe("image");
    expect(fileIcon(note("x.pptx", "slide deck"))).toBe("deck");
    expect(fileIcon(note("x.zip", "archive"))).toBe("file");
  });

  it("remembers open folders per project and for the vault", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveOpen(store, openKey("project", "p1"), new Set(["b", "a"]));
    expect([...loadOpen(store, openKey("project", "p1"))]).toEqual(["a", "b"]);
    expect(loadOpen(store, openKey("project", "p2")).size).toBe(0);
    expect(openKey("knowledge", "p1")).toBe(openKey("knowledge", null));
    mem.set(openKey("knowledge", null), "not json");
    expect(loadOpen(store, openKey("knowledge", null)).size).toBe(0);
  });
});
