import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 471: the four judgement calls of the 452–465 merge review.
// (1) a deleted note's or folder's unsaved drafts go to the notes trash,
// (2) a folder delete is refused while a prompt edit runs inside it,
// (3) a moved draft never writes over a draft already under the new name,
// (4) the sidebar's file-drag switch sets a timer only while a drag is held.
// The api is stubbed: nothing here touches a disk.
vi.mock("./api", async (original) => {
  const real = await original<typeof import("./api")>();
  return {
    ...real,
    moveNote: vi.fn(async (_s: string, _f: string, to: string) => to),
    deleteNote: vi.fn(async (_s: string, name: string) => name),
    trashNoteDrafts: vi.fn(async (_s: string, drafts: [string, string][]) =>
      drafts.map(([n]) => n.replace(/\.md$/, " (unsaved draft).md")),
    ),
    listNoteTree: vi.fn(async () => ({ notes: [], folders: [], complete: true })),
    listNotes: vi.fn(async () => []),
    listProposals: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  };
});

import * as api from "./api";
import * as tabs from "./tabs";
import { DragToNotes, SWITCH_MS } from "./dragToNotes";
import { app, deleteNote, deleteNoteFolder, followNoteMove, moveNoteTo, noteDraftKey } from "./state.svelte";
import type { Note } from "./types";

const note = (name: string): Note => ({ name, bytes: 1, modified: "2026-10-29T00:00:00Z", summary: null });
const key = (n: string) => noteDraftKey("knowledge", n);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  app.project = null;
  app.vault = [note("alice.md"), note("people/bob.md"), note("people/eng/carol.md"), note("todo.md")];
  app.noteFolders = { project: [], knowledge: ["people", "people/eng"] };
  app.noteDrafts = {};
  app.openNote = null;
  app.tabs = tabs.emptyWorkspace();
  app.toasts = [];
  vi.mocked(api.deleteNote).mockClear();
  vi.mocked(api.trashNoteDrafts).mockClear();
});

describe("item 471 (1): drafts of deleted notes go to the trash", () => {
  it("a deleted note's draft lands beside it in the trash, and leaves app state", async () => {
    app.noteDrafts[key("alice.md")] = "half-typed";
    await deleteNote("knowledge", "alice.md");
    await settle();
    expect(api.trashNoteDrafts).toHaveBeenCalledWith("knowledge", [["alice.md", "half-typed"]]);
    expect(app.noteDrafts[key("alice.md")]).toBeUndefined();
    expect(app.toasts.some((t) => t.text.includes(".trash/notes/alice (unsaved draft).md"))).toBe(true);
  });

  it("a deleted folder's drafts follow the folder to its trash name (`people 2`)", async () => {
    vi.mocked(api.deleteNote).mockResolvedValueOnce("people 2");
    app.noteDrafts[key("people/bob.md")] = "b";
    app.noteDrafts[key("people/eng/carol.md")] = "c";
    app.noteDrafts[key("alice.md")] = "outside, untouched";
    await deleteNoteFolder("knowledge", "people");
    await settle();
    expect(api.trashNoteDrafts).toHaveBeenCalledWith("knowledge", [
      ["people 2/bob.md", "b"],
      ["people 2/eng/carol.md", "c"],
    ]);
    expect(Object.keys(app.noteDrafts)).toEqual([key("alice.md")]);
  });

  it("a draft stays in app state when the trash write fails", async () => {
    vi.mocked(api.trashNoteDrafts).mockRejectedValueOnce("disk full");
    app.noteDrafts[key("todo.md")] = "keep me";
    await deleteNote("knowledge", "todo.md");
    await settle();
    expect(app.noteDrafts[key("todo.md")]).toBe("keep me");
    expect(app.toasts.some((t) => t.text.includes("Kept an unsaved draft in the app"))).toBe(true);
  });

  it("a delete without drafts writes nothing to the trash", async () => {
    await deleteNote("knowledge", "todo.md");
    await settle();
    expect(api.trashNoteDrafts).not.toHaveBeenCalled();
  });
});

describe("item 471 (2): a delete is refused while a prompt edit runs", () => {
  it("refuses a folder delete while a note inside it is being edited", async () => {
    const busy = (k: string) => k === key("people/eng/carol.md");
    await deleteNoteFolder("knowledge", "people", busy);
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(app.vault.map((n) => n.name)).toContain("people/eng/carol.md");
  });

  it("refuses a note delete while it is being edited, and allows the others", async () => {
    const busy = (k: string) => k === key("todo.md");
    await deleteNote("knowledge", "todo.md", busy);
    expect(api.deleteNote).not.toHaveBeenCalled();
    await deleteNoteFolder("knowledge", "people", busy);
    expect(api.deleteNote).toHaveBeenCalledWith("knowledge", "people");
  });
});

describe("item 471 (3): a moved draft never writes over another", () => {
  it("keeps both: the moved draft takes the name, the older one goes to the trash", async () => {
    app.noteDrafts[key("alice.md")] = "moving";
    app.noteDrafts[key("people/alice.md")] = "stale, of a note long gone";
    expect(await moveNoteTo("knowledge", "alice.md", "people/alice.md")).toBe("people/alice.md");
    expect(app.noteDrafts[key("people/alice.md")]).toBe("moving");
    await settle();
    expect(api.trashNoteDrafts).toHaveBeenCalledWith("knowledge", [["people/alice.md", "stale, of a note long gone"]]);
    expect(Object.values(app.noteDrafts)).toEqual(["moving"]);
  });

  it("parks the older draft in app state when the trash write fails", async () => {
    vi.mocked(api.trashNoteDrafts).mockRejectedValueOnce("nope");
    app.noteDrafts[key("todo.md")] = "new";
    app.noteDrafts[key("done.md")] = "old";
    followNoteMove("knowledge", "todo.md", "done.md");
    await settle();
    expect(app.noteDrafts[key("done.md")]).toBe("new");
    expect(app.noteDrafts[key("done.md (older draft)")]).toBe("old");
  });
});

describe("item 471 (4): the drag switch wakes only while a drag is held", () => {
  it("has no wake time when idle, and one at 300 ms then at the staleness edge", () => {
    const d = new DragToNotes();
    expect(d.wakeAt(0)).toBeNull();
    d.enter(0);
    expect(d.wakeAt(0)).toBe(SWITCH_MS);
    expect(d.tick(SWITCH_MS, "chats")).toBe("notes");
    // Switched: the next answer can change only when the hold goes stale.
    expect(d.wakeAt(SWITCH_MS)).toBe(SWITCH_MS + 1501);
    expect(d.tick(SWITCH_MS + 1501, "notes")).toBe("chats");
    expect(d.wakeAt(SWITCH_MS + 1501)).toBeNull();
  });

  it("a scheduler driven by wakeAt switches like the 100 ms poll did, with a handful of timers", () => {
    // The Sidebar's loop, on a fake clock: one timer at a time, re-set
    // after each tick, none once idle.
    const d = new DragToNotes();
    let tab = "chats";
    const switches: [number, string][] = [];
    let timer: number | null = null;
    let set = 0;
    const tick = (now: number) => {
      const want = d.tick(now, tab);
      if (want) {
        tab = want;
        switches.push([now, want]);
      }
      const at = d.wakeAt(now);
      timer = at;
      if (at !== null) set++;
    };
    d.enter(0);
    tick(0);
    // The pointer held still: no events, only the timers.
    for (let guard = 0; timer !== null && guard < 50; guard++) tick(timer);
    expect(switches).toEqual([
      [SWITCH_MS, "notes"],
      [SWITCH_MS + 1501, "chats"],
    ]);
    expect(timer).toBeNull();
    expect(set).toBe(2);
  });

  it("a switch time already past (the tab was not Chats) sets no busy timer", () => {
    const d = new DragToNotes();
    d.enter(0);
    expect(d.tick(400, "notes")).toBeNull();
    expect(d.wakeAt(400)).toBe(1501);
  });
});
