import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DownloadTally,
  failureNote,
  fmtBytes,
  fmtMs,
  framesToFloat,
  LibraryLoadError,
  PIPER_URL,
  type Playable,
  playCapped,
  retryable,
  STALL_MS,
  StallError,
  stallTimer,
  TRANSFORMERS_URL,
} from "./speechTest";

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

describe("speech test review fixes (item 334, w5-review findings 3 and 5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed library load is not remembered: the next tap tries again", async () => {
    let calls = 0;
    const lib = retryable(() => {
      calls++;
      return calls === 1 ? Promise.reject(new LibraryLoadError("offline")) : Promise.resolve("module");
    });
    await expect(lib.get()).rejects.toThrow("offline");
    await expect(lib.get()).resolves.toBe("module");
    // …and a success is kept: no third load.
    await expect(lib.get()).resolves.toBe("module");
    expect(calls).toBe(2);
  });

  it("a stalled load can be dropped by hand so the next tap does not wait on it", () => {
    let calls = 0;
    const lib = retryable(() => {
      calls++;
      return new Promise<string>(() => {});
    });
    const first = lib.get();
    expect(lib.get()).toBe(first);
    lib.reset();
    expect(lib.get()).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("a download with no progress for 60 s gives up with a message; progress keeps it alive", async () => {
    vi.useFakeTimers();
    const stall = stallTimer(STALL_MS, "the download stalled (nothing arrived for 60 s)");
    const outcome = stall.race(new Promise<string>(() => {})).catch((e) => e);
    vi.advanceTimersByTime(STALL_MS - 1000);
    stall.kick(); // a progress event
    vi.advanceTimersByTime(STALL_MS - 1000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1000);
    const e = await outcome;
    expect(e).toBeInstanceOf(StallError);
    expect(failureNote(e)).toBe("gave up: the download stalled (nothing arrived for 60 s); tap again to retry");
  });

  it("a finished download stops the watchdog", async () => {
    vi.useFakeTimers();
    const stall = stallTimer(STALL_MS, "stalled");
    await expect(stall.race(Promise.resolve(7))).resolves.toBe(7);
    stall.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a library that failed to load says to reload the page; an engine error does not", () => {
    expect(failureNote(new LibraryLoadError("could not load transformers.js: Load failed"))).toBe(
      "failed: could not load transformers.js: Load failed — reload the page and try again",
    );
    expect(failureNote(new Error("Missing required scale"))).toBe("failed: Missing required scale");
  });

  function fakeAudio(): Playable & { paused: boolean; fire(ev: "onplaying" | "onended" | "onerror"): void } {
    const a = {
      onplaying: null as unknown,
      onended: null as unknown,
      onerror: null as unknown,
      paused: false,
      play: () => Promise.resolve(),
      pause() {
        a.paused = true;
      },
      fire(ev: "onplaying" | "onended" | "onerror") {
        (a[ev] as () => void)();
      },
    };
    return a;
  }

  it("Piper playback whose end never comes gives up after 60 s", async () => {
    vi.useFakeTimers();
    const audio = fakeAudio();
    let started = false;
    const ended = playCapped(audio, STALL_MS, () => (started = true));
    audio.fire("onplaying");
    vi.advanceTimersByTime(STALL_MS);
    await expect(ended).resolves.toBe(false);
    expect(started).toBe(true);
    expect(audio.paused).toBe(true);
  });

  it("Piper playback that ends is reported as ended and leaves no timer", async () => {
    vi.useFakeTimers();
    const audio = fakeAudio();
    const ended = playCapped(audio, STALL_MS, () => {});
    audio.fire("onplaying");
    audio.fire("onended");
    await expect(ended).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(audio.paused).toBe(false);
  });

  it("a playback error is an error, not a hang", async () => {
    vi.useFakeTimers();
    const audio = fakeAudio();
    const ended = playCapped(audio, STALL_MS, () => {});
    audio.fire("onerror");
    await expect(ended).rejects.toThrow("playback failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
