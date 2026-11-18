import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 839 (his bug: the stored zoom level drifted to 90 % on its own).
// The menu channel is a fake: `emit` hands a payload to every listener
// registered, as Tauri's `listen` does.
const listeners = new Set<(e: { payload: string }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, cb: (e: { payload: string }) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));
const setZoom = vi.fn(async (_f: number) => {});
vi.mock("./api", () => ({ setZoom: (f: number) => setZoom(f) }));

import { ZOOM_LEVEL_KEY, ZOOM_LOG_KEY, appendZoomLog, initZoom, migrateZoom, runZoom } from "./zoom";
import { zoomNow } from "./zoomLevel.svelte";

const emit = (payload: string) => listeners.forEach((l) => l({ payload }));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  localStorage.clear();
  listeners.clear();
  setZoom.mockClear();
  await runZoom("zoom_reset", "key");
  localStorage.clear();
});

describe("839: what can lower the stored level", () => {
  it("the one-time migration never yields 90 % from an old 100 % or none", () => {
    // His keys: level 0.9, factor 0.99 — exactly one Zoom Out from 100 %
    // as `saveZoom` writes it (0.9 × 1.1). The migration gives 91 %, not 90 %.
    expect(migrateZoom(null, "1", true)).toBeCloseTo(0.9091, 3);
    expect(migrateZoom(null, null, true)).toBeCloseTo(0.9091, 3);
    expect(migrateZoom(null, "1.1", true)).toBe(1);
    expect(migrateZoom("1", "0.99", true)).toBe(1); // the level wins once it exists
  });

  it("a second initZoom does not make one ⌘− step twice", async () => {
    await initZoom();
    await initZoom();
    expect(listeners.size).toBe(1);
    emit("zoom_out");
    await settle();
    await settle();
    expect(localStorage.getItem(ZOOM_LEVEL_KEY)).toBe("0.9");
  });

  it("presses in a row each step from the level the last one left", async () => {
    await Promise.all([runZoom("zoom_out", "key"), runZoom("zoom_out", "key"), runZoom("zoom_in", "key")]);
    expect(zoomNow.level).toBe(0.9);
    expect(localStorage.getItem(ZOOM_LEVEL_KEY)).toBe("0.9");
  });

  it("every change is logged with what asked, and the chip state follows", async () => {
    await runZoom("zoom_out", "menu");
    expect(zoomNow.level).toBe(0.9);
    await runZoom("zoom_reset", "chip");
    expect(zoomNow.level).toBe(1);
    const log = JSON.parse(localStorage.getItem(ZOOM_LOG_KEY)!);
    expect(log.map((e: { from: number; to: number; via: string }) => [e.from, e.to, e.via])).toEqual([
      [1, 0.9, "menu"],
      [0.9, 1, "chip"],
    ]);
  });

  it("the log keeps the last 20 and survives junk", () => {
    let raw: string | null = "not json";
    for (let i = 0; i < 25; i++) raw = JSON.stringify(appendZoomLog(raw, { at: String(i), from: 1, to: 0.9, via: "key" }));
    const log = JSON.parse(raw!);
    expect(log).toHaveLength(20);
    expect(log[0].at).toBe("5");
  });
});
