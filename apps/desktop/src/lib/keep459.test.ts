import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 459: a kept file's chip, clicked, opens Notes at that file by item 416's notice path.
const { app, toggleSidebar } = vi.hoisted(() => {
  const app = { leftTab: "chats" as string, layout: { sidebarCollapsed: false } };
  return { app, toggleSidebar: vi.fn(() => void (app.layout.sidebarCollapsed = !app.layout.sidebarCollapsed)) };
});
vi.mock("./state.svelte", () => ({ addToast: vi.fn(), projectFilesChanged: vi.fn(), refreshNotes: vi.fn(async () => {}), app, toggleSidebar }));
vi.mock("./api", () => ({ keepAttachment: vi.fn(async () => ({ path: "/p/.agents/files/notes.pdf", rel: "files/notes.pdf", already: false })) }));

import { keepNow, keeps, keptNotices, revealKept, takeKeptNotices } from "./keep.svelte";

describe("revealKept (item 459)", () => {
  beforeEach(() => {
    app.leftTab = "chats";
    app.layout.sidebarCollapsed = false;
    toggleSidebar.mockClear();
    takeKeptNotices();
  });
  it("a kept file: Notes opens and the file is announced for the flash", async () => {
    await keepNow("chip-1", "notes.pdf", "application/pdf", { data: "QUJD" });
    takeKeptNotices(); // the keep's own notice
    const seq = keptNotices.seq;
    expect(revealKept("chip-1")).toBe(true);
    expect(app.leftTab).toBe("notes");
    expect(keptNotices.seq).toBe(seq + 1);
    expect(takeKeptNotices().map((n) => n.rel)).toEqual(["files/notes.pdf"]);
  });
  it("brings a folded sidebar back", () => {
    keeps["chip-2"] = { phase: "kept", rel: "files/b.md" };
    app.layout.sidebarCollapsed = true;
    revealKept("chip-2");
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    expect(app.layout.sidebarCollapsed).toBe(false);
  });
  it("leaves an open sidebar alone", () => {
    keeps["chip-3"] = { phase: "kept", rel: "files/c.md" };
    revealKept("chip-3");
    expect(toggleSidebar).not.toHaveBeenCalled();
  });
  it("a file not kept (or still keeping) does nothing new", () => {
    const seq = keptNotices.seq;
    expect(revealKept("never-kept")).toBe(false);
    keeps["chip-4"] = { phase: "keeping" };
    expect(revealKept("chip-4")).toBe(false);
    expect(app.leftTab).toBe("chats");
    expect(keptNotices.seq).toBe(seq);
    expect(takeKeptNotices()).toEqual([]);
  });
});
