import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 867 (his words: "A dot or something on notes files that have unsaved
// changes still pending"): every surface that shows a note carries the cue
// exactly while its edits are not on disk — on when the draft mirror holds
// the note, off the moment a Save lands, and still on when a Save fails.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  saveNote: vi.fn(async (_s: string, name: string) => ({ name, bytes: 1, modified: "2026-11-19T00:00:00Z", summary: null })),
  listNotes: vi.fn(async () => []),
  listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
  listProjects: vi.fn(async () => []),
  listProposals: vi.fn(async () => []),
}));

import * as api from "./api";
import { app, mirrorDraft, noteDraftKey, saveNote } from "./state.svelte";
import { UNSAVED_IN_FOLDER_TIP, UNSAVED_TIP, folderUnsaved, isUnsaved } from "./unsavedCue";
import notesPanel from "./NotesPanel.svelte?raw";
import tabStrip from "./TabStrip.svelte?raw";
import tabStripClassic from "./TabStripClassic.svelte?raw";
import notesSheet from "../remote/NotesSheet.svelte?raw";

const NOTE = "research/plan.md";

beforeEach(() => {
  app.project = null;
  app.noteDrafts = {};
  vi.mocked(api.saveNote).mockClear();
});

describe("item 867: the cue follows the draft mirror", () => {
  it("is on while the buffer differs from the file, off once it matches", () => {
    const key = noteDraftKey("knowledge", NOTE);
    expect(isUnsaved(app.noteDrafts, key)).toBe(false);
    mirrorDraft(key, "typed", "saved");
    expect(isUnsaved(app.noteDrafts, key)).toBe(true);
    // Typed back to the saved text (or Revert): no cue.
    mirrorDraft(key, "saved", "saved");
    expect(isUnsaved(app.noteDrafts, key)).toBe(false);
  });

  it("goes off when a Save lands, and stays on when a Save fails", async () => {
    const key = noteDraftKey("knowledge", NOTE);
    mirrorDraft(key, "typed", "saved");
    // A failed write: saveNote answers false and the draft is untouched.
    vi.mocked(api.saveNote).mockRejectedValueOnce(new Error("disk full"));
    expect(await saveNote("knowledge", NOTE, "typed")).toBe(false);
    expect(isUnsaved(app.noteDrafts, key)).toBe(true);
    // A write that lands: the editor's baseline becomes the text, and the
    // mirror drops the draft (NoteView's commit, then its effect).
    expect(await saveNote("knowledge", NOTE, "typed")).toBe(true);
    mirrorDraft(key, "typed", "typed");
    expect(isUnsaved(app.noteDrafts, key)).toBe(false);
  });

  it("a shut folder is cued for a note at any depth inside it, and only its own", () => {
    mirrorDraft(noteDraftKey("knowledge", "a/b/c.md"), "x", "");
    expect(folderUnsaved(app.noteDrafts, noteDraftKey("knowledge", "a/"))).toBe(true);
    expect(folderUnsaved(app.noteDrafts, noteDraftKey("knowledge", "a/b"))).toBe(true);
    expect(folderUnsaved(app.noteDrafts, noteDraftKey("knowledge", "ab/"))).toBe(false);
    expect(folderUnsaved(app.noteDrafts, noteDraftKey("project", "a/"))).toBe(false);
    mirrorDraft(noteDraftKey("knowledge", "a/b/c.md"), "", "");
    expect(folderUnsaved(app.noteDrafts, noteDraftKey("knowledge", "a/"))).toBe(false);
  });

  it("project notes are keyed by their project, so another project's draft cues nothing", () => {
    mirrorDraft(noteDraftKey("project", "x.md", "p1"), "typed", "");
    expect(isUnsaved(app.noteDrafts, noteDraftKey("project", "x.md", "p1"))).toBe(true);
    expect(isUnsaved(app.noteDrafts, noteDraftKey("project", "x.md", "p2"))).toBe(false);
  });
});

describe("item 867: every surface draws the cue on that state", () => {
  it("Notes list: note rows, the pinned files and shut folders", () => {
    expect(notesPanel).toContain("{#if unsaved}{@render unsavedCue(UNSAVED_TIP)}{/if}");
    expect(notesPanel).toContain("isUnsaved(app.noteDrafts, noteDraftKey(scope, n.name))");
    expect(notesPanel).toContain(
      "{#if isUnsaved(app.noteDrafts, noteDraftKey(scope, AGENTS_MD))}{@render unsavedCue(UNSAVED_TIP)}{/if}",
    );
    expect(notesPanel).toContain("!r.open && folderUnsaved(app.noteDrafts, noteDraftKey(scope, `${r.path}/`))");
    expect(notesPanel).toContain("{#if dirUnsaved}{@render unsavedCue(UNSAVED_IN_FOLDER_TIP)}{/if}");
    // Hover words, on the mark itself.
    expect(notesPanel).toMatch(/class="unsaved" role="img" aria-label=\{words\} use:tip=\{words\}/);
    // Lit only under Jarvis (gated); plain ring otherwise.
    expect(notesPanel).toContain(
      ':global(:where(:root:not([data-layout="classic"]))) .unsaved {\n    width: 7px;\n    height: 7px;\n    box-shadow: var(--glow-accent, none);',
    );
  });

  for (const [name, src] of [
    ["TabStrip (Jarvis)", tabStrip],
    ["TabStripClassic", tabStripClassic],
  ] as const) {
    it(`${name}: a note tab's ring says "Unsaved changes"; a chat draft keeps its words`, () => {
      expect(src).toContain('{@const words = t.content.kind === "note" ? UNSAVED_TIP : "has a draft"}');
      expect(src).toContain('class:unsaved={t.content.kind === "note"}');
      expect(src).toContain("return app.noteDrafts[noteDraftKey(c.scope, c.name)] !== undefined;");
    });
  }

  it("TabStrip (Jarvis) lights the note tab's ring", () => {
    expect(tabStrip).toContain(".mark.unsaved {\n    width: 7px;\n    height: 7px;\n    box-shadow: var(--glow-accent, none);");
  });

  it("phone Notes sheet: the ring beside a note with a kept draft", () => {
    expect(notesSheet).toContain("{#if mark(scope, n.name)}{@render unsavedCue()}{/if}");
    expect(notesSheet).toContain("{#if mark(f.scope, FIXED_NOTES[f.scope]!)}{@render unsavedCue()}{/if}");
    expect(notesSheet).toContain('aria-label="Unsaved changes" title="Unsaved changes"');
  });

  it("the hover words", () => {
    expect(UNSAVED_TIP).toBe("Unsaved changes");
    expect(UNSAVED_IN_FOLDER_TIP).toBe("Unsaved changes in this folder");
  });
});
