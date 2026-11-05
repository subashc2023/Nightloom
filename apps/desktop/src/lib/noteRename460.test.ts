import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 460 (his bug: no way to rename a note, and "the little claude cant do
// it either"): the rename rule the title and the panel share, and the window
// following the note editor's `rename_note` — thread, tabs, open note, draft.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  editNoteByPrompt: vi.fn(),
  moveNote: vi.fn(async (_s: string, _f: string, to: string) => to),
  saveNote: vi.fn(async () => null),
  listNotes: vi.fn(async () => []),
  listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
  listProjects: vi.fn(async () => []),
  listProposals: vi.fn(async () => []),
}));

import * as api from "./api";
import * as tabs from "./tabs";
import { app, moveNoteTo, noteDraftKey } from "./state.svelte";
import { noteEdits, runNoteEdit, setRequestDraft } from "./noteEdit.svelte";
import { renamedTo } from "./notesTree";

const OLD = "files/Pasted text (2).md";
const NEW = "files/module_2_overview.md";

beforeEach(() => {
  app.project = null;
  app.vault = [{ name: OLD, bytes: 1, modified: "2026-10-28T00:00:00Z", summary: null }];
  app.noteFolders = { project: [], knowledge: ["files"] };
  app.noteDrafts = {};
  app.openNote = null;
  app.tabs = tabs.emptyWorkspace();
  for (const k of Object.keys(noteEdits)) delete noteEdits[k];
  vi.mocked(api.editNoteByPrompt).mockReset();
});

describe("item 460: the rename rule", () => {
  it("renames in the same folder and keeps the extension", () => {
    expect(renamedTo(OLD, "module_2_overview")).toBe(NEW);
    expect(renamedTo(OLD, "module_2_overview.txt")).toBe("files/module_2_overview.txt");
    expect(renamedTo("people", "crm", true)).toBe("crm");
    expect(renamedTo(OLD, "  ")).toBeNull();
    expect(renamedTo(OLD, "Pasted text (2)")).toBeNull();
  });
});

describe("item 460: the title's rename", () => {
  it("moves the file, and the tab and the unsaved draft follow it", async () => {
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "note", scope: "knowledge", name: OLD }, "new");
    app.openNote = { scope: "knowledge", name: OLD };
    app.noteDrafts[noteDraftKey("knowledge", OLD)] = "unsaved words";
    const to = renamedTo(OLD, "module_2_overview")!;
    expect(await moveNoteTo("knowledge", OLD, to)).toBe(NEW);
    expect(api.moveNote).toHaveBeenCalledWith("knowledge", OLD, NEW);
    expect(app.openNote).toEqual({ scope: "knowledge", name: NEW });
    expect(app.noteDrafts[noteDraftKey("knowledge", NEW)]).toBe("unsaved words");
    expect(tabs.allTabs(app.tabs).flatMap((t) => (t.content.kind === "note" ? [t.content.name] : []))).toEqual([NEW]);
  });
});

describe("item 460: Edit with a prompt renames with its tool", () => {
  it("follows the model's rename: thread, tab and open note move to the new name", async () => {
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "note", scope: "knowledge", name: OLD }, "new");
    app.openNote = { scope: "knowledge", name: OLD };
    const key = noteDraftKey("knowledge", OLD);
    setRequestDraft(key, "change the name to module_2_overview");
    vi.mocked(api.editNoteByPrompt).mockResolvedValueOnce({
      text: "body",
      summary: "Renamed the note to module_2_overview.md.",
      edits: 0,
      interrupted: false,
      error: null,
      was_on_disk: null,
      cost_usd: null,
      notices: [],
      renamed_to: NEW,
    });
    await runNoteEdit("knowledge", OLD, "body");
    const moved = noteDraftKey("knowledge", NEW);
    expect(noteEdits[key]).toBeUndefined();
    expect(noteEdits[moved].turns.at(-1)?.summary).toContain("module_2_overview");
    expect(app.openNote).toEqual({ scope: "knowledge", name: NEW });
    expect(tabs.allTabs(app.tabs).flatMap((t) => (t.content.kind === "note" ? [t.content.name] : []))).toEqual([NEW]);
    expect(app.vault.map((n) => n.name)).toEqual([NEW]);
  });

  it("a turn that renamed nothing leaves the names alone", async () => {
    app.openNote = { scope: "knowledge", name: OLD };
    setRequestDraft(noteDraftKey("knowledge", OLD), "fix a typo");
    vi.mocked(api.editNoteByPrompt).mockResolvedValueOnce({
      text: "body!", summary: "Fixed.", edits: 1, interrupted: false, error: null, was_on_disk: null, cost_usd: null, notices: [],
    });
    await runNoteEdit("knowledge", OLD, "body");
    expect(app.openNote).toEqual({ scope: "knowledge", name: OLD });
    expect(noteEdits[noteDraftKey("knowledge", OLD)]).toBeDefined();
  });
});
