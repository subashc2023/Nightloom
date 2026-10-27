import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResultImages } from "./api";
import { RETRIES, RETRY_MS, _reset, imageSrc, namesImage, toolImages } from "./toolImages.svelte";

// Backlog 434: a tool result's images, read once per call from the CLI's
// session file, batched per render, a miss retried while the CLI writes.
describe("toolImages", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    _reset();
    vi.useRealTimers();
  });

  it("knows a result that names an image", () => {
    expect(namesImage("Took a screenshot\n[image]")).toBe(true);
    expect(namesImage("plain text")).toBe(false);
    expect(namesImage(null)).toBe(false);
  });

  it("asks once for every id one render names, then answers from the cache", async () => {
    const fetch = vi.fn(async (_s: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { images: [{ media_type: "image/png", data: id }], skipped: 0 }])),
    );
    _reset(fetch);
    expect(toolImages("sess", "a").status).toBe("loading");
    expect(toolImages("sess", "b").status).toBe("loading");
    await vi.advanceTimersByTimeAsync(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(["sess", ["a", "b"]]);
    const a = toolImages("sess", "a");
    expect(a.status === "done" && a.images[0].data).toBe("a");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a miss, then settles on none", async () => {
    const fetch = vi.fn(async () => ({}));
    _reset(fetch);
    toolImages("sess", "late");
    await vi.advanceTimersByTimeAsync(50 + (RETRIES + 1) * (RETRY_MS + 50));
    expect(fetch).toHaveBeenCalledTimes(RETRIES + 1);
    expect(toolImages("sess", "late").status).toBe("none");
  });

  it("finds a result the CLI wrote a moment later", async () => {
    let calls = 0;
    _reset(async (): Promise<Record<string, ToolResultImages>> =>
      ++calls < 2 ? {} : { late: { images: [{ media_type: "image/jpeg", data: "QQ" }], skipped: 1 } },
    );
    toolImages("sess", "late");
    await vi.advanceTimersByTimeAsync(50 + RETRY_MS + 50);
    const s = toolImages("sess", "late");
    expect(s.status).toBe("done");
    expect(s.status === "done" && s.skipped).toBe(1);
  });

  it("draws nothing without a session", () => {
    _reset(vi.fn());
    expect(toolImages(null, "x").status).toBe("none");
  });

  it("builds a data URL", () => {
    expect(imageSrc({ media_type: "image/png", data: "AAAA" })).toBe("data:image/png;base64,AAAA");
  });
});
