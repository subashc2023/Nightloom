import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 483: a chat's `move_notes` (item 472) moves notes on the backend;
// the window follows from the tool's answer — an open tab, the open note,
// an unsaved draft and the note editor's thread go to the new name, and a
// part-way failure's moves that landed are followed too.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  moveNote: vi.fn(async (_s: string, _f: string, to: string) => to),
  listNotes: vi.fn(async () => []),
  listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
  listProjects: vi.fn(async () => []),
  listProposals: vi.fn(async () => []),
  trashNoteDrafts: vi.fn(async () => []),
}));

import * as tabs from "./tabs";
import { app, applyTurnEventTo, moveNoteTo, noteDraftKey } from "./state.svelte";
import { noteEdits, setRequestDraft } from "./noteEdit.svelte";
import { isMoveNotesTool, movesInAnswer } from "./notesMoved";
import type { TurnEvent } from "./types";

const note = (name: string) => ({ name, bytes: 1, modified: "2026-11-02T00:00:00Z", summary: null });
const host = () => ({ state: { live: null, liveUsage: null }, approvals: [], chat: "c1", bg: null });
const noteTabs = () => tabs.allTabs(app.tabs).flatMap((t) => (t.content.kind === "note" ? [t.content.name] : []));
const result = (name: string, content: string, is_error = false): TurnEvent => ({
  type: "tool_result",
  tool_use_id: "toolu_1",
  name,
  content,
  is_error,
});

beforeEach(() => {
  app.project = null;
  app.vault = ["alice.md", "bob.md", "carol.md", "inbox/dan.md"].map(note);
  app.noteFolders = { project: [], knowledge: ["inbox"] };
  app.noteDrafts = {};
  app.openNote = null;
  app.tabs = tabs.emptyWorkspace();
  for (const k of Object.keys(noteEdits)) delete noteEdits[k];
});

describe("item 483: reading move_notes' answer", () => {
  it("knows the tool on both engines", () => {
    expect(isMoveNotesTool("move_notes")).toBe(true);
    expect(isMoveNotesTool("mcp__nightloom__move_notes")).toBe(true);
    expect(isMoveNotesTool("rename_note")).toBe(false);
    expect(isMoveNotesTool("Bash")).toBe(false);
  });
  it("reads every move of a whole batch", () => {
    expect(movesInAnswer("moved 2:\nalice.md → people/alice.md\ninbox → archive/inbox")).toEqual([
      ["alice.md", "people/alice.md"],
      ["inbox", "archive/inbox"],
    ]);
  });
  it("reads the moves that landed before a part-way failure", () => {
    const text = "stopped at bob.md: disk full\nmoved before it:\nalice.md → people/alice.md";
    expect(movesInAnswer(text)).toEqual([["alice.md", "people/alice.md"]]);
    expect(movesInAnswer(`<tool_use_error>${text}</tool_use_error>`)).toEqual([["alice.md", "people/alice.md"]]);
    expect(movesInAnswer("stopped at alice.md: disk full\nmoved before it:\n(none)")).toEqual([]);
  });
  it("never reads a refused batch's problem lines as moves", () => {
    expect(movesInAnswer("nothing was moved:\n- alice.md → .trash/a.md: a hidden name (the trash, a dot-folder) is not moved from or to")).toEqual([]);
    expect(movesInAnswer("people/bob.md is taken")).toEqual([]);
  });
});

describe("item 483: a chat's move_notes is followed", () => {
  it("the harness case: open a note, type unsaved text, a chat moves it — the tab shows the new name with the text", () => {
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "note", scope: "knowledge", name: "alice.md" }, "new");
    app.openNote = { scope: "knowledge", name: "alice.md" };
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "half-typed words";
    applyTurnEventTo(host(), result("mcp__nightloom__move_notes", "moved 1:\nalice.md → people/alice.md"));
    expect(noteTabs()).toEqual(["people/alice.md"]);
    expect(app.openNote).toEqual({ scope: "knowledge", name: "people/alice.md" });
    expect(app.noteDrafts[noteDraftKey("knowledge", "people/alice.md")]).toBe("half-typed words");
    expect(app.noteDrafts[noteDraftKey("knowledge", "alice.md")]).toBeUndefined();
    expect(app.vault.map((n) => n.name)).toContain("people/alice.md");
  });

  it("follows a batch in order, a folder's notes too, on the API engine's name", () => {
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "note", scope: "knowledge", name: "inbox/dan.md" }, "new");
    app.noteDrafts[noteDraftKey("knowledge", "inbox/dan.md")] = "dan draft";
    app.noteDrafts[noteDraftKey("knowledge", "bob.md")] = "bob draft";
    applyTurnEventTo(host(), result("move_notes", "moved 3:\nbob.md → people/bob.md\npeople/bob.md → crm/bob.md\ninbox → archive/inbox"));
    expect(noteTabs()).toEqual(["archive/inbox/dan.md"]);
    expect(app.noteDrafts[noteDraftKey("knowledge", "archive/inbox/dan.md")]).toBe("dan draft");
    expect(app.noteDrafts[noteDraftKey("knowledge", "crm/bob.md")]).toBe("bob draft");
    expect(app.noteFolders.knowledge).toEqual(["archive/inbox"]);
  });

  it("a part-way failure: what moved is followed, what did not stays", () => {
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "a";
    app.noteDrafts[noteDraftKey("knowledge", "bob.md")] = "b";
    applyTurnEventTo(host(), result("move_notes", "stopped at bob.md: disk full\nmoved before it:\nalice.md → people/alice.md", true));
    expect(app.noteDrafts[noteDraftKey("knowledge", "people/alice.md")]).toBe("a");
    expect(app.noteDrafts[noteDraftKey("knowledge", "bob.md")]).toBe("b");
  });

  it("a refused batch moves nothing in the window", () => {
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "a";
    applyTurnEventTo(host(), result("move_notes", "nothing was moved:\n- alice.md → bob.md: bob.md is taken", true));
    expect(app.noteDrafts[noteDraftKey("knowledge", "alice.md")]).toBe("a");
    expect(app.vault.map((n) => n.name)).toContain("alice.md");
  });

  it("a subagent's move_notes is followed too", () => {
    app.noteDrafts[noteDraftKey("knowledge", "carol.md")] = "c";
    applyTurnEventTo(host(), {
      type: "subagent",
      parent_tool_use_id: "toolu_p",
      event: result("move_notes", "moved 1:\ncarol.md → people/carol.md"),
    } as TurnEvent);
    expect(app.noteDrafts[noteDraftKey("knowledge", "people/carol.md")]).toBe("c");
  });

  it("another tool's result with arrows is never read", () => {
    app.noteDrafts[noteDraftKey("knowledge", "alice.md")] = "a";
    applyTurnEventTo(host(), result("Bash", "moved 1:\nalice.md → people/alice.md"));
    expect(app.noteDrafts[noteDraftKey("knowledge", "alice.md")]).toBe("a");
  });
});

describe("item 483: the note editor's thread follows every move", () => {
  it("a chat's move carries the side chat and his half-typed request", () => {
    setRequestDraft(noteDraftKey("knowledge", "alice.md"), "make it shorter");
    applyTurnEventTo(host(), result("move_notes", "moved 1:\nalice.md → people/alice.md"));
    expect(noteEdits[noteDraftKey("knowledge", "people/alice.md")]?.draft).toBe("make it shorter");
    expect(noteEdits[noteDraftKey("knowledge", "alice.md")]).toBeUndefined();
  });
  it("the panel's own move carries it too", async () => {
    setRequestDraft(noteDraftKey("knowledge", "bob.md"), "add a date");
    expect(await moveNoteTo("knowledge", "bob.md", "people/bob.md")).toBe("people/bob.md");
    expect(noteEdits[noteDraftKey("knowledge", "people/bob.md")]?.draft).toBe("add a date");
  });
  it("never writes over a thread already under the new name", () => {
    setRequestDraft(noteDraftKey("knowledge", "alice.md"), "old name's");
    setRequestDraft(noteDraftKey("knowledge", "people/alice.md"), "new name's");
    applyTurnEventTo(host(), result("move_notes", "moved 1:\nalice.md → people/alice.md"));
    expect(noteEdits[noteDraftKey("knowledge", "people/alice.md")]?.draft).toBe("new name's");
    expect(noteEdits[noteDraftKey("knowledge", "alice.md")]?.draft).toBe("old name's");
  });
});
