/**
 * A half-typed prompt-layer edit, per chat and layer (nightshift backlog
 * 243, 2026-09-29). The Context page's *Edit for this chat* textarea held
 * its text in the page's own state, so the ×, a click outside the page and
 * a relaunch all dropped what he had typed. His standing rule (practices
 * §7): drafts live in app state and are offered back; only an explicit
 * Save or Discard drops one, and Discard confirms.
 *
 * So the editor's text is written here as he types, keyed by
 * `<chat key>\u0000<layer>` (the chat key is the composer's `draftKey`),
 * with `base` — the text the editor opened with — so the page can tell a
 * real change from an untouched editor. Persisted to localStorage the way
 * the composer's drafts are: one key, debounced, flushed on `pagehide`,
 * every access in try/catch. Cleared by Save (once it lands) and by a
 * confirmed Discard; nothing else.
 */
import type { EditableLayer } from "./types";

export interface LayerDraft {
  text: string;
  /** What the editor was seeded with; equal to `text` means untouched. */
  base: string;
}

const KEY = "nightloom.layer-drafts";
const SAVE_DELAY_MS = 400;
const SEP = "\u0000";

export function layerDraftKey(chat: string, layer: EditableLayer): string {
  return chat + SEP + layer;
}

/** Whether a draft holds anything worth keeping. Pure. */
export function changed(d: LayerDraft | null | undefined): boolean {
  return !!d && d.text !== d.base;
}

/** Read the store. A malformed entry costs that entry. Pure over `storage`. */
export function loadLayerDrafts(storage: Pick<Storage, "getItem">): Record<string, LayerDraft> {
  const out: Record<string, LayerDraft> = {};
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object") return out;
    for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
      if (d === null || typeof d !== "object") continue;
      const m = d as Record<string, unknown>;
      if (typeof m.text === "string" && typeof m.base === "string") out[k] = { text: m.text, base: m.base };
    }
  } catch {
    // unreadable: start empty; the next write replaces it
  }
  return out;
}

/** Write the store: only drafts that differ from their seed. Pure over `storage`. */
export function saveLayerDrafts(map: Record<string, LayerDraft>, storage: Pick<Storage, "setItem">): void {
  const kept: Record<string, LayerDraft> = {};
  for (const [k, d] of Object.entries(map)) if (changed(d)) kept[k] = { text: d.text, base: d.base };
  try {
    storage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // best-effort
  }
}

export const layerDrafts: Record<string, LayerDraft> = $state(
  typeof localStorage === "undefined" ? {} : loadLayerDrafts(localStorage),
);

let timer: ReturnType<typeof setTimeout> | null = null;

export function flushLayerDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  saveLayerDrafts($state.snapshot(layerDrafts) as Record<string, LayerDraft>, localStorage);
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushLayerDrafts, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushLayerDrafts);

/** The held draft for a chat's layer, if one differs from its seed. */
export function heldLayerDraft(chat: string, layer: EditableLayer): LayerDraft | null {
  const d = layerDrafts[layerDraftKey(chat, layer)];
  return changed(d) ? d! : null;
}

/** The first layer of `chat` with a held draft, in `order`. */
export function firstHeldLayer(chat: string, order: readonly EditableLayer[]): EditableLayer | null {
  return order.find((l) => heldLayerDraft(chat, l) !== null) ?? null;
}

/** Keep what the editor holds now. */
export function holdLayerDraft(chat: string, layer: EditableLayer, text: string, base: string): void {
  const k = layerDraftKey(chat, layer);
  const d = layerDrafts[k];
  if (d && d.text === text && d.base === base) return;
  layerDrafts[k] = { text, base };
  schedule();
}

/** Forget it: after a Save that landed, or a Discard he confirmed. */
export function dropLayerDraft(chat: string, layer: EditableLayer): void {
  const k = layerDraftKey(chat, layer);
  if (!(k in layerDrafts)) return;
  delete layerDrafts[k];
  schedule();
}
