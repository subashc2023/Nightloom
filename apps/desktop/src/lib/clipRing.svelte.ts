/**
 * The in-app clipboard history (nightshift backlog 173, 2026-09-22): a
 * ring of the last `CLIP_MAX` things that passed through Nightloom's own
 * clipboard, newest first, for ⌘⇧V in the composer to paste one again.
 *
 * What goes in, and only this:
 *
 * - **copied** — every Copy button (they call `copyText` here) and every
 *   ⌘C / ⌘X in the window (the document's `copy` and `cut` events: the
 *   selected text of a field, or of the page).
 * - **pasted** — a paste into the composer: its text, and each image it
 *   attached (the bytes, as the chip holds them).
 * - **sent** — the text of a message sent from the composer (blocker 282's
 *   default: the item's test lists a sent text beside the copy and the
 *   paste).
 *
 * Never the system clipboard's other contents, and nothing read on a
 * timer: macOS keeps no clipboard history, and this is only what Nightloom
 * itself saw. An incognito or ephemeral chat contributes nothing.
 *
 * A store of its own, beside 158's draft history (the long texts that
 * left a box, per chat): the two overlap on a pasted-then-sent text, which
 * is fine. Persisted to localStorage like the drafts — one key, written
 * debounced, read at load, every access in try/catch. An image over
 * `CLIP_IMAGE_PERSIST_MAX` base64 characters, or past `CLIP_TOTAL_MAX` for
 * the whole store, is kept in memory only, so a relaunch drops that row.
 */
import { app, chatMode } from "./state.svelte";

export type ClipSource = "copied" | "pasted" | "sent";

export type ClipEntry =
  | { kind: "text"; text: string; source: ClipSource; at: string }
  | { kind: "image"; media_type: string; data: string; name: string; source: ClipSource; at: string };

/** How many the ring keeps. */
export const CLIP_MAX = 20;
/** A longer text is kept whole in memory and cut to this in the store. */
export const CLIP_TEXT_PERSIST_MAX = 50_000;
/** An image's base64 past this is not written to the store (kept in memory
 *  until relaunch). ~~512 KB~~ — 128 KB since the review of 2026-09-22: a
 *  pasted screenshot is also a draft chip, and the two stores share one
 *  ~5 MB localStorage quota; the drafts must never be the ones that fail. */
export const CLIP_IMAGE_PERSIST_MAX = 128 * 1024;
/** The whole store's budget; past it the oldest rows are left out. ~~3 MB~~ —
 *  512 KB since the same review, for the same reason. */
export const CLIP_TOTAL_MAX = 512 * 1024;

const STORE_KEY = "nightloom.clip-ring";
const SAVE_DELAY_MS = 400;

/** Whether two entries are the same thing (same text, or same bytes). */
function same(a: ClipEntry, b: ClipEntry): boolean {
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "image" && b.kind === "image") return a.data === b.data;
  return false;
}

/**
 * One entry onto the ring, newest first. A copy of what is already there
 * moves to the top rather than showing twice; past `max` the oldest go.
 * Blank text is not an entry. Pure: returns the new ring.
 */
export function pushClip(ring: readonly ClipEntry[], entry: ClipEntry, max = CLIP_MAX): ClipEntry[] {
  if (entry.kind === "text" && !entry.text.trim()) return ring.slice();
  const out = [entry, ...ring.filter((e) => !same(e, entry))];
  return out.slice(0, max);
}

/** The ring as it is written: small images and texts cut to size,
 *  newest first, until the budget runs out. Pure. */
export function serializeClips(ring: readonly ClipEntry[]): string {
  const kept: ClipEntry[] = [];
  let budget = CLIP_TOTAL_MAX;
  for (const e of ring) {
    let row: ClipEntry = e;
    if (e.kind === "image" && e.data.length > CLIP_IMAGE_PERSIST_MAX) continue;
    if (e.kind === "text" && e.text.length > CLIP_TEXT_PERSIST_MAX) row = { ...e, text: e.text.slice(0, CLIP_TEXT_PERSIST_MAX) };
    const size = JSON.stringify(row).length;
    if (size > budget) break;
    budget -= size;
    kept.push(row);
  }
  return JSON.stringify(kept);
}

/** Read the store back. A malformed row costs that row. */
export function loadClips(storage: Pick<Storage, "getItem"> = localStorage): ClipEntry[] {
  try {
    const raw = storage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ClipEntry[] = [];
    for (const v of parsed) {
      if (v === null || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      const source = r.source === "copied" || r.source === "pasted" || r.source === "sent" ? r.source : null;
      const at = typeof r.at === "string" ? r.at : null;
      if (!source || !at) continue;
      if (r.kind === "text" && typeof r.text === "string") out.push({ kind: "text", text: r.text, source, at });
      else if (
        r.kind === "image" &&
        typeof r.data === "string" &&
        typeof r.media_type === "string" &&
        typeof r.name === "string"
      )
        out.push({ kind: "image", data: r.data, media_type: r.media_type, name: r.name, source, at });
    }
    return out.slice(0, CLIP_MAX);
  } catch {
    return [];
  }
}

export function saveClips(ring: readonly ClipEntry[], storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(STORE_KEY, serializeClips(ring));
  } catch {
    // best-effort, as the drafts are
  }
}

/** The ring, newest first. Reassigned whole on each change. */
export const clips = $state({
  ring: (typeof localStorage === "undefined" ? [] : loadClips()) as ClipEntry[],
});

let timer: ReturnType<typeof setTimeout> | null = null;
export function flushClips(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  saveClips(clips.ring);
}
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushClips, SAVE_DELAY_MS);
}

/** Whether the open chat keeps nothing of its own (incognito, ephemeral):
 *  such a chat's copies, pastes and sends are not recorded. */
export function privateChat(): boolean {
  return chatMode(app.events) !== "normal";
}

/** A text into the ring, unless the open chat is private. */
export function recordText(source: ClipSource, text: string): void {
  if (privateChat() || !text.trim()) return;
  clips.ring = pushClip(clips.ring, { kind: "text", text, source, at: new Date().toISOString() });
  schedule();
}

/** An image into the ring (a pasted chip), unless the chat is private. */
export function recordImage(source: ClipSource, img: { media_type: string; data: string; name: string }): void {
  if (privateChat() || !img.data) return;
  clips.ring = pushClip(clips.ring, { kind: "image", ...img, source, at: new Date().toISOString() });
  schedule();
}

/** Every Copy button's path to the clipboard: write, then remember. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  recordText("copied", text);
}

/** What a ⌘C / ⌘X has selected: a field's selection, else the page's. */
function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text")) {
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    return e > s ? el.value.slice(s, e) : "";
  }
  return window.getSelection()?.toString() ?? "";
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushClips);
  const onCopy = () => recordText("copied", selectedText());
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
}
