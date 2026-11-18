/**
 * The pictures and videos drawn under replies (item 820): one read per
 * file per window life, kept as a blob URL so a long transcript holds the
 * bytes once, not as a data URL in every remount. Re-read from disk on
 * first sight — never stored in the chat's log — so a reload or a rewind
 * draws the file as it is now, and a deleted one says so.
 *
 * The loader is swappable: the Mac reads through `read_reply_media`, the
 * phone through `/api/chats/{id}/media`.
 */
import type { MediaKind } from "./replyMedia";

export type MediaState =
  | { status: "loading" }
  | { status: "done"; kind: MediaKind; url: string; size: number }
  /** Past the reply's size limit: the size, no bytes. */
  | { status: "big"; kind: MediaKind; size: number }
  /** Not drawn: the sentence why (gone, refused). */
  | { status: "failed"; message: string };

/** What a loader answers: bytes and their type, or no bytes past the limit. */
export type Loaded = { kind: MediaKind; mediaType: string; size: number; bytes: Blob | null };
export type Loader = (path: string, chat: string | null) => Promise<Loaded>;

/** The most files kept at once; the oldest blob URL is let go past it. */
export const MAX_KEPT = 60;

const cache = $state<Record<string, MediaState>>({});
const order: string[] = [];
let loader: Loader | null = null;

/** Which loader this window uses (set once by the Mac's or the phone's code). */
export function setMediaLoader(l: Loader): void {
  loader = l;
}

/** Tests: clear everything and swap the loader. */
export function _resetMedia(l?: Loader): void {
  for (const k of Object.keys(cache)) {
    const s = cache[k];
    if (s.status === "done" && s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
    delete cache[k];
  }
  order.length = 0;
  loader = l ?? null;
}

const keyOf = (path: string, chat: string | null) => `${chat ?? ""}\0${path}`;

/** The state of one file, asking for it on first sight. */
export function mediaState(path: string, chat: string | null): MediaState {
  const key = keyOf(path, chat);
  const known = cache[key];
  if (known) return known;
  // Written outside the reactive read that called us (as toolImages does).
  queueMicrotask(() => {
    if (cache[key]) return;
    cache[key] = { status: "loading" };
    void load(key, path, chat);
  });
  return { status: "loading" };
}

/** Forget one file, so the next draw reads it again (the strip's Retry). */
export function forgetMedia(path: string, chat: string | null): void {
  const key = keyOf(path, chat);
  const s = cache[key];
  if (s?.status === "done" && s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
  delete cache[key];
}

async function load(key: string, path: string, chat: string | null): Promise<void> {
  if (!loader) {
    cache[key] = { status: "failed", message: "Pictures are not available here" };
    return;
  }
  try {
    const got = await loader(path, chat);
    if (!got.bytes) {
      cache[key] = { status: "big", kind: got.kind, size: got.size };
      return;
    }
    // The blob carries the real type: an SVG drawn by `<img>` must be
    // `image/svg+xml`, and as an image it runs no script whatever it holds.
    const typed = got.bytes.type === got.mediaType ? got.bytes : new Blob([got.bytes], { type: got.mediaType });
    // Review (merge round V): an SVG is drawn from a `data:` URL, not a
    // `blob:` one. A blob URL has the page's own origin, so an SVG opened
    // from it as a document (a context menu's "open image", a drag to a
    // window) would run its script with the page's storage and bridge; a
    // `data:` document is opaque and a top-level one is refused outright.
    const url = isSvg(got.mediaType) ? await dataUrlOf(typed, got.mediaType) : URL.createObjectURL(typed);
    cache[key] = { status: "done", kind: got.kind, url, size: got.size };
    order.push(key);
    while (order.length > MAX_KEPT) {
      const old = order.shift()!;
      const s = cache[old];
      if (s?.status === "done" && s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
      delete cache[old];
    }
  } catch (e) {
    cache[key] = { status: "failed", message: String(e instanceof Error ? e.message : e) };
  }
}

const isSvg = (type: string) => /^image\/svg\+xml\b/i.test(type);

/** A blob as a `data:` URL of `type` (an SVG's, see `load`). */
export async function dataUrlOf(blob: Blob, type: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** Base64 to a typed blob (the Mac's command answers base64). */
export function blobOf(base64: string, type: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
