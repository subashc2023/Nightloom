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
