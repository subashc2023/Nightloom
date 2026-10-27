import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshNotes } = vi.hoisted(() => ({ refreshNotes: vi.fn(async () => {}) }));
vi.mock("./state.svelte", () => ({ addToast: vi.fn(), projectFilesChanged: vi.fn(), refreshNotes }));
vi.mock("./api", () => ({ keepAttachment: vi.fn(async () => ({ path: "/p/.agents/files/a.pdf", rel: "files/a.pdf", already: false })) }));

import { keepNow, keepStateOf } from "./keep.svelte";

// Item 392 (his bug): a kept file shows in Notes at once.
describe("keepNow", () => {
  beforeEach(() => refreshNotes.mockClear());
  it("refreshes the Notes list when the file is kept", async () => {
    await keepNow("k1", "a.pdf", "application/pdf", { data: "QUJD" });
    expect(keepStateOf("k1")).toEqual({ phase: "kept", rel: "files/a.pdf" });
    expect(refreshNotes).toHaveBeenCalledTimes(1);
  });
});

// Item 416: the kept file is announced to the Notes panel after the list refreshed.
describe("kept notices", () => {
  it("announces a keep after the refresh, one batch for a held drop", async () => {
    const { keptNotices, takeKeptNotices, holdKeptNotices, releaseKeptNotices } = await import("./keep.svelte");
    takeKeptNotices();
    let refreshedFirst = false;
    refreshNotes.mockImplementationOnce(async () => void (refreshedFirst = keptNotices.list.length === 0));
    const seq = keptNotices.seq;
    await keepNow("k2", "a.pdf", "application/pdf", { data: "QUJE" });
    expect(refreshedFirst).toBe(true);
    expect(keptNotices.seq).toBe(seq + 1);
    expect(takeKeptNotices().map((n) => n.rel)).toEqual(["files/a.pdf"]);

    holdKeptNotices();
    await keepNow("k3", "a.pdf", "application/pdf", { data: "QUJF" });
    await keepNow("k4", "a.pdf", "application/pdf", { data: "QUJG" });
    expect(keptNotices.seq).toBe(seq + 1);
    releaseKeptNotices();
    expect(keptNotices.seq).toBe(seq + 2);
    expect(takeKeptNotices()).toHaveLength(2);
  });
});
