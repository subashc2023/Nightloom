// Item 871: unsaved note edits survive a quit — the drafts (every scope)
// and the text each was typed against (as a hash) go to localStorage, as
// the composer's drafts do, and come back at launch; a torn or foreign
// entry never throws or drops what is readable.
import { describe, expect, it } from "vitest";
import { NOTE_DRAFTS_KEY, hashText, loadNoteDrafts, noteDraftsWriter, serializeNoteDrafts } from "./noteDraftStore";
import stateSrc from "./state.svelte?raw";

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("871: note drafts survive a relaunch", () => {
  it("every scope's draft and its baseline come back as written", () => {
    const s = mem();
    const drafts = {
      "p1:project:files/plan.md": "my half-typed plan",
      "knowledge:people/ana.md": "vault note",
      "p1:instructions:AGENTS.md": "agents edit",
      "memory:MEMORY.md": "memory edit",
      "models:opus.md": "model edit",
    };
    const bases = { "p1:project:files/plan.md": { draft: hashText("my half-typed plan"), base: hashText("old plan") } };
    s.setItem(NOTE_DRAFTS_KEY, serializeNoteDrafts(drafts, bases));
    const back = loadNoteDrafts(s);
    expect(back.drafts).toEqual(drafts);
    expect(back.bases).toEqual(bases);
  });
  it("nothing stored, a torn write or a foreign shape: empty, never a throw", () => {
    expect(loadNoteDrafts(mem())).toEqual({ drafts: {}, bases: {} });
    const s = mem();
    s.setItem(NOTE_DRAFTS_KEY, '{"v":1,"drafts":{"a":"x"');
    expect(loadNoteDrafts(s)).toEqual({ drafts: {}, bases: {} });
    s.setItem(NOTE_DRAFTS_KEY, '{"v":1,"drafts":{"a":"kept","b":7},"bases":{"a":{"draft":1}}}');
    expect(loadNoteDrafts(s)).toEqual({ drafts: { a: "kept" }, bases: {} });
  });
  it("the hash tells texts apart and is stable", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("")).not.toBe(hashText(" "));
  });
});

import { vi } from "vitest";

describe("871: at launch the drafts are back, and 870's check runs on them", () => {
  it("a restored draft is in app state, marked unsaved, with its baseline", async () => {
    localStorage.setItem(
      NOTE_DRAFTS_KEY,
      serializeNoteDrafts(
        { "p1:project:plan.md": "mine", "knowledge:gone.md": "draft of a note deleted meanwhile" },
        { "p1:project:plan.md": { draft: hashText("mine"), base: hashText("as loaded") } },
      ),
    );
    vi.resetModules();
    const { app } = await import("./state.svelte");
    const { baseDiffers } = await import("./state/notes.svelte");
    const { isUnsaved } = await import("./unsavedCue");
    expect(app.noteDrafts["p1:project:plan.md"]).toBe("mine");
    // A note deleted meanwhile: its draft is kept, never dropped.
    expect(app.noteDrafts["knowledge:gone.md"]).toBe("draft of a note deleted meanwhile");
    expect(isUnsaved(app.noteDrafts, "p1:project:plan.md")).toBe(true);
    expect(baseDiffers("p1:project:plan.md", "as loaded")).toBe(false);
    expect(baseDiffers("p1:project:plan.md", "changed outside while quit")).toBe(true);
    localStorage.removeItem(NOTE_DRAFTS_KEY);
  }, 30000);
});

describe("871: every change is written, debounced, and on the page going away", () => {
  it("a typed draft reaches the store after the debounce; flush writes at once", () => {
    vi.useFakeTimers();
    const s = mem();
    const maps = { drafts: {} as Record<string, string>, bases: {} };
    const w = noteDraftsWriter(() => maps, () => 400, s);
    maps.drafts["p1:project:plan.md"] = "half-typed";
    w.changed();
    expect(s.getItem(NOTE_DRAFTS_KEY)).toBeNull();
    vi.advanceTimersByTime(400);
    expect(loadNoteDrafts(s).drafts["p1:project:plan.md"]).toBe("half-typed");
    delete maps.drafts["p1:project:plan.md"];
    w.changed();
    w.flush();
    expect(loadNoteDrafts(s).drafts["p1:project:plan.md"]).toBeUndefined();
    vi.useRealTimers();
  });
  it("the app wires it: init persists, the effect reads both maps, pagehide flushes", () => {
    expect(stateSrc).toMatch(/initialized = true;\n\s*persistNoteDrafts\(\);/);
    expect(stateSrc).toMatch(/JSON\.stringify\(app\.noteDrafts\);\s*JSON\.stringify\(app\.noteDraftBases\);/);
    expect(stateSrc).toContain('addEventListener("pagehide", writer.flush)');
    expect(stateSrc).toContain("noteDrafts: restoredNoteDrafts.drafts");
  });
});
