import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, noteDraftKey } from "./state.svelte";
import {
  noteEdits,
  onLanded,
  onNoteEditDelta,
  onNoteEditLanded,
  runNoteEdit,
  runningTurn,
  setRequestDraft,
  undoNoteEdit,
  type Landed,
} from "./noteEdit.svelte";

// Edit a note by prompt (nightshift backlog 151, pass 2), the live part:
// the model edits the file; each landed Edit shows while the turn runs;
// the window never writes the note except for Undo; a stop or a failure
// keeps the edits that landed and Undo puts the note back in one step;
// Undo keeps text it would overwrite; the saved text a sent draft replaced
// is kept; the half-typed request is kept.

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
const result = (text: string, extra: Partial<api.NoteEditResult> = {}): api.NoteEditResult => ({
  text,
  summary: "Struck the neutral folder.",
  edits: 1,
  interrupted: false,
  error: null,
  was_on_disk: null,
  cost_usd: null,
  notices: [],
  ...extra,
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

  it("sends the buffer and the request for this note, never writes the note itself, and marks what changed", async () => {
    edit.mockResolvedValueOnce(result(AFTER));
    setRequestDraft(key, "we dropped the neutral folder");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][0]).toMatchObject({
      scope: "knowledge",
      name: "plan.md",
      text: BEFORE,
      request: "we dropped the neutral folder",
      strike: true,
    });
    // The model wrote the file; the window did not.
    expect(save).not.toHaveBeenCalled();
    expect(landed).toEqual([{ text: AFTER, saved: true, marks: [1, 2] }]);
    const t = noteEdits[key].turns[0];
    expect(t).toMatchObject({ status: "applied", before: BEFORE, after: AFTER, edits: 1, summary: "Struck the neutral folder." });
    expect(t.current).toBeUndefined();
    // The box empties once sent; the request lives in the exchange.
    expect(noteEdits[key].draft).toBe("");
  });

  it("shows each Edit as it lands, and the model's text, while the turn runs", async () => {
    let seq = 0;
    let resolve!: (r: api.NoteEditResult) => void;
    edit.mockImplementationOnce((args) => {
      seq = args.seq;
      return new Promise((r) => (resolve = r));
    });
    setRequestDraft(key, "x");
    const running = runNoteEdit("knowledge", "plan.md", BEFORE);
    const mid = "# Plan\n- ~~use the neutral folder~~ (2026-09-25)\n";
    onNoteEditLanded(seq, mid, 1);
    onNoteEditDelta(seq, "Struck ");
    expect(runningTurn(key)).toMatchObject({ current: mid, edits: 1, partial: "Struck " });
    // A landed event for another exchange is not this one's.
    onNoteEditLanded(seq + 999, "other", 5);
    expect(runningTurn(key)?.current).toBe(mid);
    onNoteEditLanded(seq, AFTER, 2);
    expect(runningTurn(key)?.current).toBe(AFTER);
    resolve(result(AFTER, { edits: 2 }));
    await running;
    expect(runningTurn(key)).toBeNull();
    expect(noteEdits[key].turns[0]).toMatchObject({ status: "applied", edits: 2 });
  });

  it("does nothing with an empty request", async () => {
    setRequestDraft(key, "   ");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(edit).not.toHaveBeenCalled();
  });

  it("a stop before any edit leaves the note as it was", async () => {
    edit.mockResolvedValueOnce(result(BEFORE, { interrupted: true, edits: 0 }));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
    expect(noteEdits[key].turns[0].status).toBe("stopped");
  });

  it("a stop after an edit keeps it, says so, and Undo puts the note back", async () => {
    const half = "# Plan\n- ~~use the neutral folder~~ (2026-09-25)\n";
    edit.mockResolvedValueOnce(result(half, { interrupted: true, edits: 1 }));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    const t = noteEdits[key].turns[0];
    expect(t).toMatchObject({ status: "applied", after: half });
    expect(t.error).toContain("stopped after 1 edit");
    await undoNoteEdit("knowledge", "plan.md", half);
    expect(save.mock.calls).toEqual([["knowledge", "plan.md", BEFORE]]);
  });

  it("a turn refused before it ran leaves the note untouched and says why", async () => {
    edit.mockRejectedValueOnce("no project is open, so there is no shared notes folder");
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(noteEdits[key].turns[0]).toMatchObject({ status: "failed" });
    expect(noteEdits[key].turns[0].error).toContain("no project");
  });

  it("a CLI failure with nothing landed is a failure; with edits landed they stay", async () => {
    edit.mockResolvedValueOnce(result(BEFORE, { error: "the note editor's Claude Code turn failed: boom", edits: 0 }));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(noteEdits[key].turns[0]).toMatchObject({ status: "failed" });
    expect(noteEdits[key].turns[0].error).toContain("boom");

    edit.mockResolvedValueOnce(result(AFTER, { error: "stopped: the model called Write" }));
    setRequestDraft(key, "y");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(noteEdits[key].turns[1]).toMatchObject({ status: "applied", after: AFTER });
    expect(noteEdits[key].turns[1].error).toContain("Write");
  });

  it("an unchanged note is not written", async () => {
    edit.mockResolvedValueOnce(result(BEFORE, { summary: "Nothing needed to change.", edits: 0 }));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    expect(save).not.toHaveBeenCalled();
    expect(noteEdits[key].turns[0].status).toBe("unchanged");
  });

  it("an unsaved draft he sent from: the saved text it replaced is kept, and the stale draft is dropped", async () => {
    const draft = `${BEFORE}- a line he had not saved\n`;
    app.noteDrafts[key] = draft;
    edit.mockResolvedValueOnce(result(AFTER, { was_on_disk: BEFORE }));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", draft);
    const turns = noteEdits[key].turns;
    expect(turns.map((t) => t.status)).toEqual(["kept", "applied"]);
    expect(turns[0].before).toBe(BEFORE);
    expect(turns[1].before).toBe(draft);
    expect(app.noteDrafts[key]).toBeUndefined();
  });

  it("Undo restores the text before the turn in one step, saved", async () => {
    edit.mockResolvedValueOnce(result(AFTER));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    landed = [];
    await undoNoteEdit("knowledge", "plan.md", AFTER);
    expect(save.mock.calls).toEqual([["knowledge", "plan.md", BEFORE]]);
    expect(landed[0]).toMatchObject({ text: BEFORE, saved: true });
    expect(noteEdits[key].turns.map((t) => t.status)).toEqual(["undone"]);
  });

  it("Undo over text he typed since keeps that text first", async () => {
    edit.mockResolvedValueOnce(result(AFTER));
    setRequestDraft(key, "x");
    await runNoteEdit("knowledge", "plan.md", BEFORE);
    const typed = `${AFTER}- and a line he added\n`;
    await undoNoteEdit("knowledge", "plan.md", typed);
    const turns = noteEdits[key].turns;
    expect(turns.map((t) => t.status)).toEqual(["undone", "kept"]);
    expect(turns[1].before).toBe(typed);
  });
});
