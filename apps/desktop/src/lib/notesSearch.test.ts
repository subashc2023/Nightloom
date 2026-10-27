import { describe, expect, it } from "vitest";
import { foldQuery, hitsByScope, narrowNotes } from "./notesSearch";
import type { Note, NoteGroup } from "./types";

const note = (name: string, summary: string | null = null): Note => ({ name, bytes: 1, modified: "2026-10-26T00:00:00Z", summary });
const NOTES = [note("alpha.md", "Plans for the cache"), note("beta.md", "Cache misses on CI"), note("cache.md"), note("files/deck.pdf")];
const names = (ns: Note[]) => ns.map((n) => n.name);

// Item 415: the Notes search box.
describe("narrowNotes", () => {
  it("shows every note for an empty or blank query", () => {
    expect(names(narrowNotes(NOTES, "", null))).toEqual(names(NOTES));
    expect(names(narrowNotes(NOTES, "   ", null))).toEqual(names(NOTES));
  });
  it("matches names case-insensitively", () => {
    expect(names(narrowNotes(NOTES, "DECK", null))).toEqual(["files/deck.pdf"]);
  });
  it("lists name matches before text-only matches, each in list order", () => {
    // cache.md by name; alpha and beta by summary
    expect(names(narrowNotes(NOTES, "Cache", null))).toEqual(["cache.md", "alpha.md", "beta.md"]);
  });
  it("counts the backend's text hits as text matches", () => {
    expect(names(narrowNotes(NOTES, "toolchain", new Set(["files/deck.pdf", "beta.md"])))).toEqual(["beta.md", "files/deck.pdf"]);
  });
  it("lists a note matching both ways once, with the name matches", () => {
    expect(names(narrowNotes(NOTES, "cache", new Set(["cache.md", "alpha.md"])))).toEqual(["cache.md", "alpha.md", "beta.md"]);
  });
  it("finds nothing when nothing matches", () => {
    expect(narrowNotes(NOTES, "zebra", new Set())).toEqual([]);
  });
  it("folds the query by trimming and lower-casing", () => {
    expect(foldQuery("  CaChe ")).toBe("cache");
  });
});

describe("hitsByScope", () => {
  it("splits the backend's note groups by section", () => {
    const g = (scope: string, name: string) => ({ scope, name, modified: "", hits: 1, rows: [] }) as unknown as NoteGroup;
    const h = hitsByScope([g("project", "a.md"), g("knowledge", "b.md"), g("project", "c.md")]);
    expect([...h.project]).toEqual(["a.md", "c.md"]);
    expect([...h.knowledge]).toEqual(["b.md"]);
  });
});
