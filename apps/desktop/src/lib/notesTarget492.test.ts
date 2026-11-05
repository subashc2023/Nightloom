import { beforeEach, describe, expect, it, vi } from "vitest";

const { keepInFolder, refreshNotes } = vi.hoisted(() => ({
  keepInFolder: vi.fn(),
  refreshNotes: vi.fn(async () => {}),
}));
vi.mock("./state.svelte", () => ({ addToast: vi.fn(), projectFilesChanged: vi.fn(), refreshNotes }));
vi.mock("./api", () => ({ keepAttachment: vi.fn(), keepInFolder }));

import { clashWords, holdWords, landingFolder, pointedFolder, ROOT_FOLDER, safeFolder } from "./notesTarget";
import { keepInto } from "./keep.svelte";
import { zipToast } from "./notesDrop";

// Item 492: a file lands in the folder he points at.
describe("which folder a drop points at", () => {
  it("a folder row is that folder, nested or not", () => {
    expect(pointedFolder({ folder: "project:people" })).toBe("people");
    expect(pointedFolder({ folder: "project:people/friends/old" })).toBe("people/friends/old");
  });
  it("a note row is the folder the note is in", () => {
    expect(pointedFolder({ note: "project:people/alice.md" })).toBe("people");
    expect(pointedFolder({ note: "project:a/b/c.pdf" })).toBe("a/b");
  });
  it("a top-level note, the head and empty space are the root", () => {
    expect(pointedFolder({ note: "project:todo.md" })).toBe("");
    expect(pointedFolder({})).toBe("");
    expect(pointedFolder({ folder: null, note: null })).toBe("");
  });
  it("a folder row wins over a note row; another section's row is the root", () => {
    expect(pointedFolder({ folder: "project:x", note: "project:y/z.md" })).toBe("x");
    expect(pointedFolder({ folder: "knowledge:people" })).toBe("");
  });
  it("the root lands in files/, as a drop always did; a folder in itself", () => {
    expect(landingFolder("")).toBe(ROOT_FOLDER);
    expect(ROOT_FOLDER).toBe("files");
    expect(landingFolder("people")).toBe("people");
    expect(landingFolder("files/bundle")).toBe("files/bundle");
  });
  it("says where while held", () => {
    expect(holdWords("")).toBe("Drop to keep in files/");
    expect(holdWords("people/old")).toBe("Drop into people/old/");
  });
});

describe("paths stay inside the notes", () => {
  it("cleans a plain path", () => {
    expect(safeFolder("people")).toBe("people");
    expect(safeFolder(" people//friends/ ")).toBe("people/friends");
    expect(safeFolder("./a/./b")).toBe("a/b");
    expect(safeFolder("a\\b")).toBe("a/b");
  });
  it("refuses .., absolute, hidden and drive paths", () => {
    for (const bad of ["..", "../x", "a/../../x", "/etc", "/", ".trash/notes", "people/.git", "C:/x", "a/b:c"])
      expect(safeFolder(bad), bad).toBeNull();
  });
});

describe("the clash question", () => {
  it("names the numbered name Keep both would use", () => {
    const w = clashWords("people/a.txt", "people/a (2).txt");
    expect(w.question).toBe("people/a.txt is there already, with other contents.");
    expect(w.both).toBe("Keep both (as a (2).txt)");
    expect(w.sure).toMatch(/trash/);
  });
  it("a zip's toast names the folder it went in", () => {
    expect(zipToast("b.zip", "b", 2, [], "people")).toBe("Kept 2 files from b.zip in people/b/");
    expect(zipToast("b.zip", "b", 1, [])).toBe("Kept 1 file from b.zip in files/b/");
  });
});

describe("keepInto", () => {
  const kept = (rel: string, extra: object = {}) => ({ kind: "kept", path: `/p/.agents/${rel}`, rel, already: false, ...extra });
  beforeEach(() => keepInFolder.mockReset());

  it("keeps into the folder, asking nothing when the name is free", async () => {
    keepInFolder.mockResolvedValueOnce(kept("people/a.txt"));
    const ask = vi.fn();
    const toast = vi.fn();
    expect(await keepInto("people", "a.txt", "text/plain", "QQ==", { toast, ask })).toBe(true);
    expect(keepInFolder).toHaveBeenCalledWith("a.txt", "text/plain", "QQ==", "people", "ask", undefined);
    expect(ask).not.toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toMatch(/as people\/a\.txt/);
  });

  it("a clash asks; Keep both keeps a numbered copy", async () => {
    keepInFolder
      .mockResolvedValueOnce({ kind: "taken", rel: "people/a.txt", both: "people/a (2).txt" })
      .mockResolvedValueOnce(kept("people/a (2).txt"));
    const ask = vi.fn(async () => "both" as const);
    expect(await keepInto("people", "a.txt", "text/plain", "QQ==", { toast: vi.fn(), ask })).toBe(true);
    expect(ask).toHaveBeenCalledWith("people/a.txt", "people/a (2).txt");
    expect(keepInFolder.mock.calls[1][4]).toBe("both");
  });

  it("Replace says the old one is in the trash", async () => {
    keepInFolder
      .mockResolvedValueOnce({ kind: "taken", rel: "people/a.txt", both: "people/a (2).txt" })
      .mockResolvedValueOnce(kept("people/a.txt", { replaced: "people/a.txt" }));
    const toast = vi.fn();
    await keepInto("people", "a.txt", "text/plain", "QQ==", { toast, ask: async () => "replace" });
    expect(keepInFolder.mock.calls[1][4]).toBe("replace");
    expect(toast.mock.calls[0][0]).toMatch(/notes trash/);
  });

  it("Cancel writes nothing and says so", async () => {
    keepInFolder.mockResolvedValueOnce({ kind: "taken", rel: "people/a.txt", both: "people/a (2).txt" });
    const toast = vi.fn();
    expect(await keepInto("people", "a.txt", "text/plain", "QQ==", { toast, ask: async () => "cancel" })).toBe(false);
    expect(keepInFolder).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatch(/Did not keep a\.txt/);
  });

  it("a refusal from the backend is a toast, not a throw", async () => {
    keepInFolder.mockRejectedValueOnce("../x: not a folder in these notes");
    const toast = vi.fn();
    expect(await keepInto("../x", "a.txt", "text/plain", "QQ==", { toast, ask: vi.fn() })).toBe(false);
    expect(toast.mock.calls[0][0]).toMatch(/Could not keep a\.txt/);
  });
});
