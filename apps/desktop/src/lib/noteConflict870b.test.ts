// Item 870, second pass: Take theirs is undoable (as Revert has no
// confirm, it gets an Undo that gives his text back, nothing lost); Undo
// of a prompt edit and Accept on a proposal go through the outside-change
// check before they write.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptBlocked, bothText, undoTake, undoEditBlocked } from "./noteConflict";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  saveNote: vi.fn(async () => null),
  readNote: vi.fn(),
  listNotes: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
}));
import * as api from "./api";
import { app, noteDraftKey } from "./state.svelte";
import { noteEdits, undoNoteEdit } from "./noteEdit.svelte";

describe("870: Take theirs can be undone, his text back", () => {
  it("nothing typed since: exactly as before the pick", () => {
    expect(undoTake({ mine: "mine", before: "base", theirs: "theirs", now: "theirs" })).toEqual({
      text: "mine",
      saved: "base",
      theirs: "theirs",
    });
  });
  it("typed since: both his set-aside text and the new typing, nothing dropped", () => {
    const r = undoTake({ mine: "mine", before: "base", theirs: "theirs", now: "theirs+typed" });
    expect(r).toEqual({ text: bothText("mine", "theirs+typed"), saved: "theirs", theirs: null });
    expect(r.text).toContain("mine");
    expect(r.text).toContain("theirs+typed");
  });
});

describe("870: Accept on a proposal checks the file first", () => {
  it("the file as loaded, or already the proposal: accept", () => {
    expect(acceptBlocked({ disk: "a", saved: "a", next: "b" })).toBe(false);
    expect(acceptBlocked({ disk: "b", saved: "a", next: "b" })).toBe(false);
  });
  it("changed outside since it was loaded: not accepted", () => {
    expect(acceptBlocked({ disk: "outside", saved: "a", next: "b" })).toBe(true);
  });
});

describe("870: Undo of a prompt edit checks the file first", () => {
  it("as the edit left it, or as he saved it since: undo", () => {
    expect(undoEditBlocked({ disk: "after", after: "after", current: "typed" })).toBe(false);
    expect(undoEditBlocked({ disk: "typed", after: "after", current: "typed" })).toBe(false);
  });
  it("changed outside since the edit: not undone", () => {
    expect(undoEditBlocked({ disk: "outside", after: "after", current: "after" })).toBe(true);
  });

  const key = noteDraftKey("knowledge", "plan870.md");
  beforeEach(() => {
    vi.mocked(api.saveNote).mockClear();
    app.noteDrafts = {};
    noteEdits[key] = {
      turns: [{ id: 1, request: "x", strike: false, at: "", status: "applied", before: "before", after: "after", summary: "" }],
      strike: false,
      touched: "",
    } as never;
  });
  it("the store's Undo writes nothing over an outside change", async () => {
    vi.mocked(api.readNote).mockResolvedValueOnce("outside");
    await undoNoteEdit("knowledge", "plan870.md", "after");
    expect(api.saveNote).not.toHaveBeenCalled();
  });
  it("the store's Undo still writes when the file is as the edit left it", async () => {
    vi.mocked(api.readNote).mockResolvedValueOnce("after");
    await undoNoteEdit("knowledge", "plan870.md", "after");
    expect(vi.mocked(api.saveNote).mock.calls).toEqual([["knowledge", "plan870.md", "before"]]);
  });
});
