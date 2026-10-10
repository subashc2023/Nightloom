import { describe, expect, it } from "vitest";
import { DownloadTally, fmtBytes, fmtMs, framesToFloat, PIPER_URL, TRANSFORMERS_URL } from "./speechTest";

describe("speech test (item 334)", () => {
  it("counts only files fetched over the network as downloaded", () => {
    const t = new DownloadTally();
    t.on({ status: "initiate", name: "m", file: "a.onnx" });
    t.on({ status: "download", name: "m", file: "a.onnx" });
    t.on({ status: "progress", name: "m", file: "a.onnx", loaded: 5, total: 100 });
    t.on({ status: "progress", name: "m", file: "a.onnx", loaded: 100, total: 100 });
    // b came from the cache: progress but no download event.
    t.on({ status: "progress", name: "m", file: "b.onnx", loaded: 40, total: 40 });
    expect(t.downloaded).toBe(100);
    expect(t.size).toBe(140);
  });

  it("formats sizes and times for the panel", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(41 * 1024 * 1024)).toBe("41.0 MB");
    expect(fmtMs(380.4)).toBe("380 ms");
    expect(fmtMs(1240)).toBe("1.24 s");
  });

  it("turns 16-bit mic frames into one float clip", () => {
    const f = framesToFloat([Int16Array.from([0, 16384]), Int16Array.from([-32768])]);
    expect(Array.from(f)).toEqual([0, 0.5, -1]);
  });

  it("pins every library version", () => {
    for (const u of [TRANSFORMERS_URL, PIPER_URL]) expect(u).toMatch(/@\d+\.\d+\.\d+\//);
  });
});
