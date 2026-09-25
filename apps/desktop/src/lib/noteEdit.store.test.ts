import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, noteDraftKey } from "./state.svelte";
import { END_MARKER } from "./noteEdit";
import {
  noteEdits,
  onLanded,
  runNoteEdit,
  setRequestDraft,
  undoNoteEdit,
  type Landed,
} from "./noteEdit.svelte";

// Edit a note by prompt (nightshift backlog 151), the live part: a whole
// reply is saved and handed to the view with its marks; nothing else ever
// writes the note; a stop, a failure, an empty or cut-off reply leave the
// note as it was (or as an unsaved draft); Undo restores in one step and
// keeps text it would overwrite; the half-typed request is kept.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  editNoteByPrompt: vi.fn(),
  cancelNoteEdit: vi.fn(async () => null),
  saveNote: vi.fn(async () => null),
  listNotes: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
}));

const edit = vi.mocked(api.editNoteByPrompt);
const save = vi.mocked(api.saveNote);
const BEFORE = "# Plan\n- use the neutral folder\n";
const AFTER = "# Plan\n- ~~use the neutral folder~~ (2026-09-25)\n- no neutral folder\n";
const reply = (note: string, summary = "Struck the neutral folder.") => ({
  reply: `${note}${END_MARKER}\n${summary}`,
  interrupted: false,
  cost_usd: null,
  notices: [],
});

describe("runNoteEdit", () => {
  let key: string;
  let landed: Landed[];
  beforeEach(() => {
    vi.clearAllMocks();
    app.project = null;
    app.connection = null;
    for (const k of Object.keys(noteEdits)) delete noteEdits[k];
    for (const k of Object.keys(app.noteDrafts)) delete app.noteDrafts[k];
    key = noteDraftKey("knowledge", "plan.md");
    landed = [];
    onLanded(key, (l) => landed.push(l));
  });

  it("saves the whole reply, once, to this note, and marks what changed", async () => {
    edit.mockResolvedValueOnce(reply(AFTER));
    setRequestDraft(key, "we dropped the neutral folder");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    // What the model was sent: the editor's text and the request.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][0]).toMatchObject({ name: "plan.md", text: BEFORE, request: "we dropped the neutral folder", strike: true });
    // Written once, this note only, with the model's text.
    expect(save.mock.calls).toEqual([["knowledge", "plan.md", AFTER]]);
    expect(landed).toEqual([{ text: AFTER, saved: true, marks: [1, 2] }]);
    const t = noteEdits[key].turns[0];
    expect(t).toMatchObject({ status: "applied", before: BEFORE, after: AFTER, summary: "Struck the neutral folder." });
    // The box empties once sent; the request lives in the exchange.
    expect(noteEdits[key].draft).toBe("");
  });

  it("does nothing with an empty request", async () => {
    setRequestDraft(key, "   ");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(edit).not.toHaveBeenCalled();
  });

  it("a stopped rewrite leaves the note untouched", async () => {
    edit.mockResolvedValueOnce({ ...reply("# Pl"), interrupted: true });
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
    expect(noteEdits[key].turns[0].status).toBe("stopped");
  });

  it("a failed rewrite leaves the note untouched and says why", async () => {
    edit.mockRejectedValueOnce("the note editor's Claude Code turn failed: boom");
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(noteEdits[key].turns[0]).toMatchObject({ status: "failed" });
    expect(noteEdits[key].turns[0].error).toContain("boom");
  });

  it("an empty note from the model is refused", async () => {
    edit.mockResolvedValueOnce(reply(""));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(noteEdits[key].turns[0].status).toBe("failed");
  });

  it("a reply with no end marker becomes an unsaved draft, not a save", async () => {
    edit.mockResolvedValueOnce({ reply: "# Plan\n- cut o", interrupted: false, cost_usd: null, notices: [] });
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(app.noteDrafts[key]).toBe("# Plan\n- cut o");
    expect(landed[0]).toMatchObject({ saved: false });
    expect(noteEdits[key].turns[0].status).toBe("draft");
  });

  it("an unchanged note is not written", async () => {
    edit.mockResolvedValueOnce(reply(BEFORE, "Nothing needed to change."));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(noteEdits[key].turns[0].status).toBe("unchanged");
  });

  it("Undo restores the text before the edit in one step, saved", async () => {
    edit.mockResolvedValueOnce(reply(AFTER));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    save.mockClear();
    landed = [];
    await undoNoteEdit("knowledge", "plan.md", AFTER);
    expect(save.mock.calls).toEqual([["knowledge", "plan.md", BEFORE]]);
    expect(landed[0]).toMatchObject({ text: BEFORE, saved: true });
    expect(noteEdits[key].turns.map((t) => t.status)).toEqual(["undone"]);
  });

  it("Undo over text he typed since keeps that text first", async () => {
    edit.mockResolvedValueOnce(reply(AFTER));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    const typed = `${AFTER}- and a line he added\n`;
    await undoNoteEdit("knowledge", "plan.md", typed);
    const turns = noteEdits[key].turns;
    expect(turns.map((t) => t.status)).toEqual(["undone", "kept"]);
    expect(turns[1].before).toBe(typed);
  });
});
