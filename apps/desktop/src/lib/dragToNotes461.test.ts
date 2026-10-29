import { describe, expect, it } from "vitest";
import { DragToNotes, SWITCH_MS } from "./dragToNotes";
import { carriesFiles } from "./dropLook";

// Item 461: a file held over the sidebar's Chats switches it to Notes after
// ~300 ms; leaving without a drop puts Chats back; a drop there keeps Notes.

describe("item 461: drag a file over Chats", () => {
  it("switches to Notes once held for 300 ms, not before", () => {
    const d = new DragToNotes();
    d.enter(0);
    expect(d.tick(100, "chats")).toBeNull();
    d.over(250);
    expect(d.tick(SWITCH_MS - 1, "chats")).toBeNull();
    expect(d.tick(SWITCH_MS, "chats")).toBe("notes");
    // Once: the next ticks leave it.
    expect(d.tick(SWITCH_MS + 50, "notes")).toBeNull();
  });

  it("goes back to Chats when the drag leaves without dropping", () => {
    const d = new DragToNotes();
    d.enter(0);
    expect(d.tick(320, "chats")).toBe("notes");
    d.over(400);
    d.leave();
    expect(d.tick(410, "notes")).toBe("chats");
  });

  it("stays on Notes when the file is dropped in the sidebar", () => {
    const d = new DragToNotes();
    d.enter(0);
    expect(d.tick(320, "chats")).toBe("notes");
    d.end(true);
    expect(d.tick(330, "notes")).toBeNull();
    expect(d.tick(5000, "notes")).toBeNull();
  });

  it("goes back when the file is dropped elsewhere, or the drag goes stale", () => {
    const a = new DragToNotes();
    a.enter(0);
    a.tick(320, "chats");
    a.end(false);
    expect(a.tick(330, "notes")).toBe("chats");
    const b = new DragToNotes();
    b.enter(0);
    b.tick(320, "chats");
    // No event for 1.5 s (Escape over the sidebar, or rows swapped out
    // under the pointer that never sent their leave).
    expect(b.tick(2000, "notes")).toBe("chats");
  });

  it("a drag that leaves before 300 ms switches nothing", () => {
    const d = new DragToNotes();
    d.enter(0);
    d.leave();
    expect(d.tick(400, "chats")).toBeNull();
  });

  it("never switches from Nightshift, and never undoes a switch it did not make", () => {
    const d = new DragToNotes();
    d.enter(0);
    expect(d.tick(400, "nightshift")).toBeNull();
    d.leave();
    expect(d.tick(410, "nightshift")).toBeNull();
    const e = new DragToNotes();
    e.enter(0);
    expect(e.tick(400, "notes")).toBeNull(); // already on Notes
    e.leave();
    expect(e.tick(410, "notes")).toBeNull();
  });

  it("only real files count: chats, tabs and notes dragged inside the app do not", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["application/x-nightloom-tab-content"] })).toBe(false);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});
