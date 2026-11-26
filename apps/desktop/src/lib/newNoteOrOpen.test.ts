// Item 1018: /note opens the note in a new tab; the chat's tab stays; a tab already showing it is focused.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, openSession, reflectTabs } from "./state.svelte";
import * as tabs from "./tabs";
import { newNoteOrOpen } from "./newNoteOrOpen";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async () => [{ event: "session_created", at: "2026-01-01T00:00:00Z", kind: "build", mode: "normal" }]),
  readNote: vi.fn(async () => {
    throw new Error("cannot read x (os error 2)");
  }),
  saveNote: vi.fn(async (_scope: string, name: string) => ({ name, content: "", mtime: 1 })),
  listSessions: vi.fn(async () => []),
}));

const label = (c: tabs.TabContent) => (c.kind === "chat" ? (c.session ?? "new") : c.kind === "note" ? c.name : c.kind);
const all = () => app.tabs.panes.map((p) => p.tabs.map((t) => label(t.content)));

beforeEach(async () => {
  app.tabs = tabs.emptyWorkspace();
  app.openNext = "replace";
  app.activeSessionId = null;
  app.events = [];
  app.view = "chat";
  app.openNote = null;
  app.notes = [];
  app.toasts = [];
  await openSession("a");
  reflectTabs();
});

describe("/note opens a new tab", () => {
  it("a new note opens beside the chat, which stays", async () => {
    await newNoteOrOpen("project", "plan.md");
    expect(all()).toEqual([["a", "plan.md"]]);
    expect(app.openNext).toBe("replace");
  });

  it("an existing note opens in a new tab too", async () => {
    app.notes = [{ name: "old.md", content: "x", mtime: 1 }] as never;
    await newNoteOrOpen("project", "OLD.md");
    expect(all()).toEqual([["a", "old.md"]]);
  });

  it("a tab already showing the note is focused, not duplicated", async () => {
    await newNoteOrOpen("project", "plan.md");
    await openSession("a");
    reflectTabs();
    await newNoteOrOpen("project", "plan.md");
    expect(all()).toEqual([["a", "plan.md"]]);
    expect(tabs.activeTab(tabs.focusedPane(app.tabs)).content.kind).toBe("note");
  });
});
