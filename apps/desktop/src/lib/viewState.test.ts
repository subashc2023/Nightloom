import { beforeEach, describe, expect, it } from "vitest";
import { MAX_KEYS, VIEW_STATE_KEY, resetViewState, textKey, viewGet, viewRenameKeys, viewSet } from "./viewState";
import { NOTE_PREVIEW_KEY, loadNotePreview, saveNotePreview } from "./noteMode";

// Item 495: every view keeps its state when he leaves and comes back.

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("the kept switches of a view", () => {
  let disk: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    disk = fakeStorage();
    resetViewState(disk);
  });

  it("a switch set, its view gone and drawn again, reads what he left", () => {
    expect(viewGet("file.plain:/a.md", false)).toBe(false);
    viewSet("file.plain:/a.md", true, false);
    // The view is destroyed; a new one asks.
    expect(viewGet("file.plain:/a.md", false)).toBe(true);
    expect(viewGet("file.plain:/b.md", false)).toBe(false);
  });

  it("a persisted one is back after a relaunch, a session one is not", () => {
    viewSet("runs.drawer", false, true);
    viewSet("notes.query", "draft", "", { session: true });
    resetViewState(disk); // a relaunch: memory gone, disk kept
    expect(viewGet("runs.drawer", true)).toBe(false);
    expect(viewGet("notes.query", "")).toBe("");
  });

  it("the default is not stored, and setting it back drops the key", () => {
    viewSet("asides.list", false, false);
    expect(disk.m.get(VIEW_STATE_KEY) ?? "{}").toBe("{}");
    viewSet("asides.list", true, false);
    expect(JSON.parse(disk.m.get(VIEW_STATE_KEY)!)).toEqual({ "asides.list": true });
    viewSet("asides.list", false, false);
    expect(JSON.parse(disk.m.get(VIEW_STATE_KEY)!)).toEqual({});
  });

  it("a value of the wrong type, or a broken store, falls back", () => {
    disk.m.set(VIEW_STATE_KEY, JSON.stringify({ "ctx.mode": 3, "rail.exact": true }));
    resetViewState(disk);
    expect(viewGet("ctx.mode", "layers")).toBe("layers");
    expect(viewGet("rail.exact", false)).toBe(true);
    disk.m.set(VIEW_STATE_KEY, "{nope");
    resetViewState(disk);
    expect(viewGet("rail.exact", false)).toBe(false);
  });

  it("is bounded: the least recently set key goes first", () => {
    for (let i = 0; i <= MAX_KEYS; i++) viewSet(`k${i}`, true, false);
    expect(viewGet("k0", false)).toBe(false);
    expect(viewGet(`k${MAX_KEYS}`, false)).toBe(true);
    expect(Object.keys(JSON.parse(disk.m.get(VIEW_STATE_KEY)!)).length).toBe(MAX_KEYS);
  });

  it("a per-note switch follows the note's move", () => {
    viewSet("noteMedia.full:inbox/pic.png", true, false);
    viewSet("noteMedia.full:other.png", true, false);
    viewRenameKeys("noteMedia.full:", (rest) => (rest.startsWith("inbox/") ? "kept/" + rest.slice(6) : null));
    expect(viewGet("noteMedia.full:kept/pic.png", false)).toBe(true);
    expect(viewGet("noteMedia.full:inbox/pic.png", false)).toBe(false);
    expect(viewGet("noteMedia.full:other.png", false)).toBe(true);
    resetViewState(disk);
    expect(viewGet("noteMedia.full:kept/pic.png", false)).toBe(true);
  });

  it("textKey is stable and tells texts apart", () => {
    expect(textKey("a\nb")).toBe(textKey("a\nb"));
    expect(textKey("a\nb")).not.toBe(textKey("a\nc"));
  });
});

describe("a note's Preview is one remembered setting beside Plain/Formatted", () => {
  it("off until picked, then kept", () => {
    const disk = fakeStorage();
    expect(loadNotePreview(disk)).toBe(false);
    saveNotePreview(true, disk);
    expect(disk.m.get(NOTE_PREVIEW_KEY)).toBe("1");
    expect(loadNotePreview(disk)).toBe(true);
    saveNotePreview(false, disk);
    expect(loadNotePreview(disk)).toBe(false);
  });

  it("a storage that throws costs only the memory", () => {
    const broken = {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
    };
    expect(loadNotePreview(broken)).toBe(false);
    expect(() => saveNotePreview(true, broken)).not.toThrow();
  });
});
