import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 876 (his words, 2026-11-19: 90 % "is kind of my default zoom"): a
// default he sets; ⌘0 returns to it; the chip is quiet at it. Same fakes as
// zoomRun.test.ts: the menu channel and the webview's set_zoom.
const listeners = new Set<(e: { payload: string }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, cb: (e: { payload: string }) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));
const setZoom = vi.fn(async (_f: number) => {});
vi.mock("./api", () => ({ setZoom: (f: number) => setZoom(f) }));

import {
  ZOOM_DEFAULT_KEY,
  ZOOM_LEVEL_KEY,
  initZoom,
  parseZoomDefault,
  runZoom,
  setZoomDefault,
  zoomOffDefault,
} from "./zoom";
import { zoomNow } from "./zoomLevel.svelte";
import chipSrc from "./ZoomChip.svelte?raw";

const emit = (payload: string) => listeners.forEach((l) => l({ payload }));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  localStorage.clear();
  listeners.clear();
  zoomNow.def = 1;
  await runZoom("zoom_reset", "key");
  localStorage.clear();
});

describe("876: his default zoom", () => {
  it("a fresh install's default is 100 %", async () => {
    expect(parseZoomDefault(null)).toBe(1);
    expect(parseZoomDefault("junk")).toBe(1);
    await initZoom();
    expect(zoomNow.def).toBe(1);
    expect(zoomOffDefault(zoomNow.level, zoomNow.def)).toBe(false);
  });

  it("⌘0 returns to the stored default, not 100 %", async () => {
    localStorage.setItem(ZOOM_DEFAULT_KEY, "0.9");
    localStorage.setItem(ZOOM_LEVEL_KEY, "1.25");
    await initZoom();
    expect(zoomNow.def).toBe(0.9);
    expect(zoomNow.level).toBe(1.25);
    expect(zoomOffDefault(zoomNow.level, zoomNow.def)).toBe(true); // the chip shows
    emit("zoom_reset"); // the View menu's ⌘0
    await settle();
    await settle();
    expect(zoomNow.level).toBe(0.9);
    expect(localStorage.getItem(ZOOM_LEVEL_KEY)).toBe("0.9");
    expect(zoomOffDefault(zoomNow.level, zoomNow.def)).toBe(false); // the chip hides its "· ⌘0"
    await runZoom("zoom_in", "key");
    await runZoom("zoom_reset", "chip");
    expect(zoomNow.level).toBe(0.9);
  });

  it("the chip's Make N% default stores it and quiets the chip", async () => {
    await runZoom("zoom_out", "key");
    expect(zoomNow.level).toBe(0.9);
    expect(zoomOffDefault(zoomNow.level, zoomNow.def)).toBe(true);
    await setZoomDefault(0.9, "chip");
    expect(localStorage.getItem(ZOOM_DEFAULT_KEY)).toBe("0.9");
    expect(zoomNow.def).toBe(0.9);
    expect(zoomNow.level).toBe(0.9); // nothing moved
    expect(zoomOffDefault(zoomNow.level, zoomNow.def)).toBe(false);
  });

  it("Settings' pick moves a window at the old default, and leaves one zoomed elsewhere", async () => {
    await setZoomDefault(0.9, "settings"); // at 100 % = the old default: follows
    expect(zoomNow.level).toBe(0.9);
    await runZoom("zoom_in", "key"); // 100 %, off the default
    await setZoomDefault(0.75, "settings");
    expect(zoomNow.level).toBe(1);
    expect(zoomNow.def).toBe(0.75);
  });

  it("the chip renders only off the default, and offers Make N% default", () => {
    const src = chipSrc;
    expect(src).toContain("{#if zoomOffDefault(zoomNow.level, zoomNow.def)}");
    expect(src).toContain("setZoomDefault(zoomNow.level");
    expect(src).toContain("Make {zoomLabel(zoomNow.level)} default");
  });
});
