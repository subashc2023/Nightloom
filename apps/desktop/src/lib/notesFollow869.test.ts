// Item 869: the Notes list follows its folders when they change outside
// Nightloom, and a note whose file vanished says so plainly.
import { describe, expect, it, vi } from "vitest";
import { coalesced, noteVanished, stillThere, touchesNote, vanishedMessage, watchWhenMoved } from "./notesFollow";

describe("869: following the notes folders", () => {
  it("a burst of changes is at most one re-read now and one after", async () => {
    let release: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const kick = coalesced(refresh);
    const first = kick();
    void kick();
    void kick();
    void kick();
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    release();
    await first;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a failed re-read does not stop the next one", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const kick = coalesced(refresh);
    await kick();
    await kick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("the watch is asked for again only when the folders moved", () => {
    const ask = vi.fn(() => Promise.resolve());
    const follow = watchWhenMoved(ask);
    follow("p1|/vault");
    follow("p1|/vault");
    follow("p2|/vault");
    follow("p2|/vault");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("a refused watch is asked for again at the next read", async () => {
    const ask = vi.fn().mockRejectedValueOnce(new Error("no folder")).mockResolvedValue(undefined);
    const follow = watchWhenMoved(ask);
    follow("p1|/vault");
    await Promise.resolve();
    await Promise.resolve();
    follow("p1|/vault");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("his error string reads as a vanished file, other failures do not", () => {
    expect(
      noteVanished("cannot read files/lectures/ICS51-MIPS-Architecture (1).txt: No such file or directory (os error 2)"),
    ).toBe(true);
    expect(noteVanished("cannot read a.md: Permission denied (os error 13)")).toBe(false);
    expect(noteVanished("stream did not contain valid UTF-8")).toBe(false);
  });

  it("an open note's file deleted outside reads as gone; there or unreadable does not", async () => {
    const gone = () =>
      Promise.reject("cannot read files/lectures/ICS51-MIPS-Architecture (1).txt: No such file or directory (os error 2)");
    expect(await stillThere(gone)).toBe(false);
    expect(await stillThere(() => Promise.resolve("text"))).toBe(true);
    expect(await stillThere(() => Promise.reject("Permission denied (os error 13)"))).toBe(null);
  });

  it("the message names the file and never the os error", () => {
    const m = vanishedMessage("files/lectures/ICS51-MIPS-Architecture (1).txt", false);
    expect(m).toContain("ICS51-MIPS-Architecture (1).txt");
    expect(m).toContain("moved or deleted outside Nightloom");
    expect(m).not.toMatch(/os error|No such file/);
    expect(vanishedMessage("a.md", true)).toContain("unsaved edits");
  });

  it("review: the open note re-reads only for its own file, a folder above it, or a rescan", () => {
    const name = "files/lectures/MIPS.pdf";
    const batch = (paths: string[], scope: "project" | "knowledge" = "project") => ({ scope, paths });
    // A sync landing hundreds of other files: no read of the open PDF.
    const others = Array.from({ length: 300 }, (_, i) => `files/other/${i}.md`);
    expect(touchesNote(batch(others), "project", name)).toBe(false);
    expect(touchesNote(batch([name]), "project", name)).toBe(true);
    expect(touchesNote(batch(["files/lectures"]), "project", name)).toBe(true);
    expect(touchesNote(batch(["files/lect"]), "project", name)).toBe(false);
    expect(touchesNote(batch([""]), "project", name)).toBe(true);
    expect(touchesNote(batch(["/Users/x/elsewhere/MIPS.pdf"]), "project", name)).toBe(true);
    // The other folder's batch never concerns this note.
    expect(touchesNote(batch([name], "knowledge"), "project", name)).toBe(false);
    // An older payload without paths: check, as before.
    expect(touchesNote(undefined, "project", name)).toBe(true);
  });
});
