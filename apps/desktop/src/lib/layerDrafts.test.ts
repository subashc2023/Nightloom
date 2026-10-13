import { describe, expect, it } from "vitest";
import {
  changed,
  dropLayerDraft,
  firstHeldLayer,
  flushLayerDrafts,
  heldLayerDraft,
  holdLayerDraft,
  layerDraftKey,
  loadLayerDrafts,
  saveLayerDrafts,
} from "./layerDrafts.svelte";
import type { EditableLayer } from "./types";

function memory(): Storage {
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

const L: EditableLayer = "user_memory";

describe("a half-typed layer edit (backlog 243)", () => {
  it("is held per chat and layer until dropped", () => {
    expect(heldLayerDraft("c1", L)).toBeNull();
    holdLayerDraft("c1", L, "seed plus typing", "seed");
    expect(heldLayerDraft("c1", L)).toEqual({ text: "seed plus typing", base: "seed" });
    expect(heldLayerDraft("c2", L)).toBeNull();
    expect(firstHeldLayer("c1", [L])).toBe(L);
    dropLayerDraft("c1", L);
    expect(heldLayerDraft("c1", L)).toBeNull();
  });

  it("an untouched editor holds nothing", () => {
    holdLayerDraft("c3", L, "seed", "seed");
    expect(heldLayerDraft("c3", L)).toBeNull();
    expect(changed({ text: "a", base: "a" })).toBe(false);
    expect(changed({ text: "", base: "a" })).toBe(true); // emptied is a change
  });

  it("survives a relaunch: written and read back, untouched ones left out", () => {
    const s = memory();
    saveLayerDrafts(
      {
        [layerDraftKey("c1", L)]: { text: "typed", base: "seed" },
        [layerDraftKey("c2", L)]: { text: "same", base: "same" },
      },
      s,
    );
    expect(loadLayerDrafts(s)).toEqual({ [layerDraftKey("c1", L)]: { text: "typed", base: "seed" } });
  });

  it("a malformed store costs the bad entry, not the rest", () => {
    const s = memory();
    s.setItem(
      "nightloom.layer-drafts",
      JSON.stringify({ a: { text: "ok", base: "" }, b: { text: 3 }, c: null }),
    );
    expect(loadLayerDrafts(s)).toEqual({ a: { text: "ok", base: "" } });
    s.setItem("nightloom.layer-drafts", "{not json");
    expect(loadLayerDrafts(s)).toEqual({});
  });

  it("flushes without a localStorage (node) without throwing", () => {
    expect(() => flushLayerDrafts()).not.toThrow();
  });
});
