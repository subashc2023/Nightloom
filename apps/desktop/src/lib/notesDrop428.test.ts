import { describe, expect, it, vi } from "vitest";

const { refreshNotes, windowToast, keepAttachment } = vi.hoisted(() => ({
  refreshNotes: vi.fn(async () => {}),
  windowToast: vi.fn(),
  keepAttachment: vi.fn(),
}));
vi.mock("./state.svelte", () => ({ addToast: windowToast, projectFilesChanged: vi.fn(), refreshNotes }));
vi.mock("./api", () => ({ keepAttachment }));

import { keepNow, takeKeptNotices } from "./keep.svelte";
import { keepDropped, type KeepDeps } from "./notesDrop";
import { keepKey } from "./keep";
import type { Attachment } from "./types";

const SRC = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

// Item 428 (his bug, 2026-10-27): the same .pptx dropped twice on Notes.
describe("an office file's own hash goes to Keep (item 428)", () => {
  it("passes the converted chip's source_sha256 to keep, and the panel's toast to attach", async () => {
    const boxes: Record<string, Attachment[]> = {};
    const toast = vi.fn();
    const d: KeepDeps = {
      project: () => ({}),
      toast,
      attach: vi.fn(async (key: string) => {
        const chip: Attachment = {
          id: 1,
          kind: "document",
          name: "deck.pptx",
          media_type: "application/pdf",
          data: "PDF1",
          source_sha256: SRC,
        };
        boxes[key] = [chip];
        return [chip];
      }),
      jobs: () => [],
      chips: (k) => boxes[k] ?? [],
      state: () => ({ phase: "idle" }),
      forget: vi.fn(),
      keep: vi.fn(async () => {}),
      discard: vi.fn(),
    };
    await keepDropped([new File(["x"], "deck.pptx")], d);
    expect(d.keep).toHaveBeenCalledWith(keepKey("deck.pptx", "PDF1"), "deck.pptx", "application/pdf", { data: "PDF1" }, SRC);
    // Refusals and failed conversions say so where he dropped.
    expect((d.attach as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(toast);
  });

  it("keepNow sends the source, and an `already` answer goes to the given toast, flashing the existing row", async () => {
    keepAttachment.mockResolvedValueOnce({ path: "/p/.agents/files/deck.pdf", rel: "files/deck.pdf", already: true });
    takeKeptNotices();
    const toast = vi.fn();
    await keepNow("k428a", "deck.pptx", "application/pdf", { data: "PDF2" }, { source: SRC, toast });
    expect(keepAttachment).toHaveBeenLastCalledWith("deck.pptx", "application/pdf", { data: "PDF2" }, undefined, SRC);
    expect(toast).toHaveBeenCalledWith("deck.pptx was already in this project's files, as files/deck.pdf");
    expect(windowToast).not.toHaveBeenCalled();
    expect(takeKeptNotices().map((n) => n.rel)).toEqual(["files/deck.pdf"]);
  });

  it("without a toast given, keepNow still uses the window's (the chip's Keep)", async () => {
    keepAttachment.mockResolvedValueOnce({ path: "/p/.agents/files/a.pdf", rel: "files/a.pdf", already: false });
    await keepNow("k428b", "a.pdf", "application/pdf", { data: "QQ" });
    expect(keepAttachment).toHaveBeenLastCalledWith("a.pdf", "application/pdf", { data: "QQ" }, undefined, undefined);
    expect(windowToast).toHaveBeenCalledWith("Kept a.pdf in this project's files, as files/a.pdf — new chats here can read it");
  });

  it("a failed keep is said in the given toast", async () => {
    keepAttachment.mockRejectedValueOnce("disk full");
    const toast = vi.fn();
    await keepNow("k428c", "b.pdf", "application/pdf", { data: "Qg" }, { toast });
    expect(toast).toHaveBeenCalledWith("Could not keep b.pdf: disk full");
  });
});
