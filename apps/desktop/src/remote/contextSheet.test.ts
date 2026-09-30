// Wave 2B (item 246): the Context page's pure half and the layer editor's
// draft store — a half-typed layer survives a reload (the store is
// localStorage) and a dismissal (only Save and Discard drop it).
import { describe, expect, it } from "vitest";
import type { WireSegment, WireView } from "../lib/types";
import {
  elidedTargets,
  layerSeed,
  layerSize,
  offAfter,
  pendingChoices,
  pendingLine,
  reconnectDue,
  shownLayers,
  sizeLabel,
  unwrapSegment,
} from "./ContextSheet.svelte";
import { LAYER_DRAFTS_KEY, dropLayerDraft, heldLayerDraft, heldLayerKinds, holdLayerDraft } from "./LayerEditor.svelte";

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

const seg = (kind: string, text: string, tokens: number | null = 10): WireSegment => ({
  kind,
  name: kind,
  preview: text.slice(0, 20),
  truncated: false,
  text,
  size: { tokens, bytes: text.length },
  cache_anchor: false,
});

function view(system: WireSegment[] = [], blocks: { index: number; elided: boolean }[] = []): WireView {
  return {
    system,
    system_text: null,
    messages: [
      {
        role: "user",
        totals: { tokens: 0, bytes: 0, unestimated: 0 },
        blocks: blocks.map((b) => ({
          kind: "text",
          preview: "p",
          truncated: false,
          size: { tokens: 1, bytes: 4 },
          source: { from: "event", index: b.index },
          elided: b.elided,
          elidable: true,
        })),
      },
    ],
    totals: { tokens: 0, bytes: 0, unestimated: 0 },
    context_limit: null,
  };
}

describe("layer drafts (practices §7)", () => {
  it("keeps a draft across a 'reload' (a fresh read of the same storage)", () => {
    const s = new MemStorage();
    expect(holdLayerDraft("c1", "user_memory", "half typed", "the file", 1000, s)).toBe(true);
    // A reload is a new page reading the same localStorage.
    const again = heldLayerDraft("c1", "user_memory", s);
    expect(again).toEqual({ text: "half typed", base: "the file", at: 1000 });
    expect(JSON.parse(s.getItem(LAYER_DRAFTS_KEY)!)).toHaveProperty("c1\nuser_memory");
  });

  it("an untouched editor keeps nothing, and going back to the base drops the draft", () => {
    const s = new MemStorage();
    holdLayerDraft("c1", "user_memory", "same", "same", 1, s);
    expect(heldLayerDraft("c1", "user_memory", s)).toBeNull();
    holdLayerDraft("c1", "user_memory", "changed", "same", 2, s);
    holdLayerDraft("c1", "user_memory", "same", "same", 3, s);
    expect(heldLayerDraft("c1", "user_memory", s)).toBeNull();
    expect(s.getItem(LAYER_DRAFTS_KEY)).toBeNull();
  });

  it("drafts are per chat and per layer; only an explicit drop removes one", () => {
    const s = new MemStorage();
    holdLayerDraft("c1", "project_instructions", "b", "", 20, s);
    holdLayerDraft("c1", "user_memory", "a", "", 10, s);
    holdLayerDraft("c2", "user_memory", "other chat", "", 5, s);
    expect(heldLayerKinds("c1", s)).toEqual(["user_memory", "project_instructions"]);
    expect(heldLayerDraft("c2", "project_instructions", s)).toBeNull();
    dropLayerDraft("c1", "user_memory", s);
    expect(heldLayerKinds("c1", s)).toEqual(["project_instructions"]);
    expect(heldLayerDraft("c2", "user_memory", s)?.text).toBe("other chat");
  });

  it("says so when the phone will not store it, and survives garbage in storage", () => {
    const broken = new MemStorage();
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(holdLayerDraft("c1", "user_memory", "x", "", 1, broken)).toBe(false);
    expect(holdLayerDraft("c1", "user_memory", "x", "", 1, null)).toBe(false);
    const junk = new MemStorage();
    junk.setItem(LAYER_DRAFTS_KEY, "not json");
    expect(heldLayerDraft("c1", "user_memory", junk)).toBeNull();
    expect(heldLayerKinds("c1", junk)).toEqual([]);
  });
});

describe("the Context page's rules", () => {
  it("shows each engine's layers, and on an unknown engine only what is there", () => {
    const agent = shownLayers("claude-code", null, []).map((l) => l.kind);
    expect(agent).toContain("engine_note");
    expect(agent).toContain("cli_memory");
    expect(agent).not.toContain("identity");
    const provider = shownLayers("provider", null, []).map((l) => l.kind);
    expect(provider).toContain("identity");
    expect(provider).not.toContain("pacing");
    const unknown = shownLayers(null, view([seg("identity", "x")]), ["pacing"]).map((l) => l.kind);
    expect(unknown).toContain("identity");
    expect(unknown).toContain("pacing");
    expect(unknown).not.toContain("environment");
    expect(unknown).toContain("user_memory");
  });

  it("flips one layer in the switched-off set and leaves the rest", () => {
    expect(offAfter(["knowledge"], "identity", false)).toEqual(["knowledge", "identity"]);
    expect(offAfter(["knowledge", "identity"], "identity", true)).toEqual(["knowledge"]);
    expect(offAfter([], "identity", true)).toEqual([]);
  });

  it("sizes: tokens when estimated, bytes otherwise; the walk adds up", () => {
    expect(sizeLabel({ tokens: 12345, bytes: 1 })).toBe("12,345 tok");
    expect(sizeLabel({ tokens: null, bytes: 300 })).toBe("1 KB");
    expect(sizeLabel({ tokens: null, bytes: 3 * 1024 * 1024 })).toBe("3.0 MB");
    expect(layerSize([seg("p", "a", 5), seg("p", "b", 7)])).toEqual({ tokens: 12, bytes: 2 });
    expect(layerSize([seg("p", "a", 5), seg("p", "b", null)]).tokens).toBeNull();
  });

  it("seeds the editor from the chat's own text, then the file, then the prompt unwrapped", () => {
    const segs = [seg("user_memory", "<user-instructions>\nbe brief\n</user-instructions>")];
    expect(layerSeed("user_memory", { off: [], edits: { user_memory: "mine" } }, segs).text).toBe("mine");
    expect(layerSeed("user_memory", { off: [], sources: { user_memory: "from file" } }, segs).text).toBe("from file");
    expect(layerSeed("user_memory", { off: [], sources: { user_memory: null } }, segs).text).toBe("");
    expect(layerSeed("user_memory", { off: [] }, segs).text).toBe("be brief");
    expect(unwrapSegment('<model-instructions model="opus">\nline 1\nline 2\n</model-instructions>')).toBe("line 1\nline 2");
    expect(unwrapSegment("no wrapper")).toBe("no wrapper");
    const walk = [seg("project_instructions", "<project-instructions>\nouter\n</project-instructions>"), seg("project_instructions", "<project-instructions>\ninner\n</project-instructions>")];
    expect(layerSeed("project_instructions", null, walk).text).toBe("outer\n\ninner");
  });

  it("lists every removed item once for Restore all", () => {
    expect(elidedTargets(view([], [{ index: 3, elided: true }, { index: 3, elided: true }, { index: 5, elided: false }, { index: 7, elided: true }]))).toEqual([3, 7]);
    expect(elidedTargets(null)).toEqual([]);
  });

  it("the newer-version mark offers keep, and after keep, update", () => {
    const p = { kind: "user_memory", held: "a", newer: "b", choice: "auto" as const };
    expect(pendingChoices(p).map((c) => c.choice)).toEqual(["keep"]);
    expect(pendingChoices({ ...p, choice: "keep" }).map((c) => c.choice)).toEqual(["auto"]);
    expect(pendingLine({ ...p, newer: "" })).toMatch(/^The file is gone/);
    expect(pendingLine({ ...p, choice: "keep" })).toMatch(/^Keeping/);
  });

  it("a change the engine has not taken yet is said", () => {
    expect(reconnectDue(null)).toBe(false);
    expect(reconnectDue({ off: ["a"], built: ["a"], edits: {}, built_edits: {} })).toBe(false);
    expect(reconnectDue({ off: ["a"], built: [], edits: {}, built_edits: {} })).toBe(true);
    expect(reconnectDue({ off: [], built: [], edits: { user_memory: "x" }, built_edits: {} })).toBe(true);
  });
});
