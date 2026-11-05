import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 457: a move carries tabs, the open note and an unsaved draft along.
// The api is stubbed: nothing here touches a disk.
vi.mock("./api", async (original) => {
  const real = await original<typeof import("./api")>();
  return {
    ...real,
    moveNote: vi.fn(async (_s: string, _f: string, to: string) => to),
    newNoteFolder: vi.fn(async (_s: string, name: string) => name),
    deleteNote: vi.fn(async () => null),
    listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
    listNotes: vi.fn(async () => []),
    listProposals: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  };
});

import * as api from "./api";
import * as tabs from "./tabs";
import { app, deleteNoteFolder, moveNoteTo, newNoteFolder, noteDraftKey } from "./state.svelte";
import type { Note } from "./types";

const note = (name: string): Note => ({ name, bytes: 1, modified: "2026-10-28T00:00:00Z", summary: null });

beforeEach(() => {
  app.project = null;
  app.vault = [note("alice.md"), note("people/bob.md"), note("people/eng/carol.md"), note("todo.md")];
  app.noteFolders = { project: [], knowledge: ["people", "people/eng"] };
  app.noteDrafts = {};
  app.openNote = null;
  app.tabs = tabs.emptyWorkspace();
  vi.mocked(api.moveNote).mockClear();
});

describe("item 457: moving notes", () => {
  it("moves a note into a folder and keeps its unsaved draft", async () => {
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "half-typed";
    const pane = tabs.focusedPane(app.tabs);
    tabs.land(app.tabs, pane, { kind: "note", scope: "knowledge", name: "alice.md" }, "new");
    app.openNote = { scope: "knowledge", name: "alice.md" };

    expect(await moveNoteTo("knowledge", "alice.md", "people/alice.md")).toBe("people/alice.md");

    expect(app.noteDrafts[noteDraftKey("knowledge", "people/alice.md")]).toBe("half-typed");
    expect(app.noteDrafts[noteDraftKey("knowledge", "alice.md")]).toBeUndefined();
    expect(app.openNote).toEqual({ scope: "knowledge", name: "people/alice.md" });
    const names = tabs.allTabs(app.tabs).flatMap((t) => (t.content.kind === "note" ? [t.content.name] : []));
    expect(names).toEqual(["people/alice.md"]);
    expect(app.vault.map((n) => n.name)).toContain("people/alice.md");
  });

  it("renames a folder and everything under it follows", async () => {
    app.noteDrafts[noteDraftKey("knowledge", "people/eng/carol.md")] = "draft";
    expect(await moveNoteTo("knowledge", "people", "crm")).toBe("crm");
    expect(app.vault.map((n) => n.name).sort()).toEqual(["alice.md", "crm/bob.md", "crm/eng/carol.md", "todo.md"]);
    expect(app.noteDrafts[noteDraftKey("knowledge", "crm/eng/carol.md")]).toBe("draft");
    expect(app.noteFolders.knowledge).toEqual(["crm", "crm/eng"]);
  });

  it("refuses a move while a prompt edit runs on the note", async () => {
    const busy = (k: string) => k === noteDraftKey("knowledge", "todo.md");
    expect(await moveNoteTo("knowledge", "todo.md", "people/todo.md", busy)).toBeNull();
    expect(api.moveNote).not.toHaveBeenCalled();
  });

  it("leaves everything as it was when the backend refuses", async () => {
    vi.mocked(api.moveNote).mockRejectedValueOnce("people/bob.md already exists");
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "keep me";
    expect(await moveNoteTo("knowledge", "alice.md", "people/bob.md")).toBeNull();
    expect(app.noteDrafts[noteDraftKey("knowledge", "alice.md")]).toBe("keep me");
    expect(app.vault.map((n) => n.name)).toContain("alice.md");
  });

  it("makes a folder", async () => {
    expect(await newNoteFolder("knowledge", "archive")).toBe("archive");
    expect(app.noteFolders.knowledge).toContain("archive");
  });

  it("deletes a folder with its notes, and its notes' tabs close", async () => {
    const pane = tabs.focusedPane(app.tabs);
    tabs.land(app.tabs, pane, { kind: "note", scope: "knowledge", name: "people/bob.md" }, "new");
    await deleteNoteFolder("knowledge", "people");
    expect(api.deleteNote).toHaveBeenCalledWith("knowledge", "people");
    expect(app.vault.map((n) => n.name)).toEqual(["alice.md", "todo.md"]);
    expect(app.noteFolders.knowledge).toEqual([]);
    expect(tabs.allTabs(app.tabs).some((t) => t.content.kind === "note")).toBe(false);
  });
});
