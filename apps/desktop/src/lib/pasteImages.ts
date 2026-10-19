/**
 * Item 382: text copied with images in it pastes with every image, in place
 * (his ask, 2026-10-18: "pastes all of the images where exactly they are
 * within the text").
 *
 * What the clipboard holds was measured (nightshift
 * `notes/runner-design/wave11-b-report.md`): a copy from Safari or any WebKit
 * page, and a selection from Chrome, reach the composer's paste event as
 * `text/html` + `text/plain` and no files; the HTML keeps each `<img>` where
 * it stood, its src `http(s)://…` or `data:` (WebKit turns a `blob:` image
 * into `data:` on the way). So the paste is the HTML as text (`mathPaste.ts`'s
 * walker, math converted as item 348 does) with `[image N]` where each image
 * was, and each image becomes an image chip, in marker order:
 *
 * - `data:` is decoded here, at once;
 * - `http(s)` is a chip waiting (`pending`, Send waits as for an office
 *   conversion) while the backend gets it — from Safari's web archive on the
 *   pasteboard when it holds that URL, else by a cookie-less fetch with a
 *   size cap and a timeout (`paste_images.rs`);
 * - one that cannot be had loses its chip and its marker reads
 *   `[image N: could not be fetched]` (or says why it could not be
 *   attached) — never a silent loss.
 *
 * The order reaches the model as it is (read 2026-10-18,
 * `protocol::user_content`): a turn's content is its text, then its images in
 * chip order, so `[image N]` is the Nth image the model sees — N counts from
 * the images already in the box. Chips are added in marker order at paste
 * time, so a slow fetch cannot reorder them.
 *
 * Pure parts are tested in node; `attachPastedImages` takes its effects as
 * arguments.
 */
import { invoke } from "@tauri-apps/api/core";
import { htmlPasteText, type El } from "./mathPaste";
import type { Attachment } from "./types";

/** At most this many images attach from one paste; the rest keep a marker
 *  saying so. Anthropic's own chat takes 20 images a message. */
export const MAX_PASTE_IMAGES = 20;

/** The media types the model takes as an image. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PastedImage {
  /** Its number in the box: the marker reads `[image n]`. */
  n: number;
  src: string;
}

export interface ImagePaste {
  text: string;
  images: PastedImage[];
}

export const marker = (n: number) => `[image ${n}]`;
export const failedMarker = (n: number, why = "could not be fetched") => `[image ${n}: ${why}]`;

const px = (v: string | undefined) => (v === undefined || v === "" ? null : Number.parseFloat(v));

/** The URL an `<img>` shows: its src, or a lazy loader's real one. */
export function imageSrc(img: El): string {
  const a = img.attrs;
  const src = (a.src ?? "").trim();
  const lazy = (a["data-src"] ?? a["data-original"] ?? a["data-lazy-src"] ?? "").trim();
  if (/^https?:/i.test(lazy) && (!src || /^data:image\/gif/i.test(src))) return lazy;
  if (!src && a.srcset) return a.srcset.trim().split(/\s+/)[0] ?? "";
  return src;
}

/** What an `<img>` is: nothing (a tracking pixel, no src), its alt text (an
 *  emoji drawn as a picture), or an image to attach. */
export function classify(img: El): { kind: "none" } | { kind: "text"; text: string } | { kind: "image"; src: string } {
  const a = img.attrs;
  const w = px(a.width);
  const h = px(a.height);
  if ((w !== null && w <= 2) || (h !== null && h <= 2)) return { kind: "none" };
  const alt = (a.alt ?? "").trim();
  const small = (w !== null && w <= 32) || (h !== null && h <= 32);
  if (alt && (/\b(emoji|wp-smiley|emoticon)\b/i.test(a.class ?? "") || (small && [...alt].length <= 4))) {
    return { kind: "text", text: alt };
  }
  const src = imageSrc(img);
  if (!src) return { kind: "none" };
  return { kind: "image", src };
}

/**
 * The paste's text with a marker per image, and the images in order —
 * numbered from `first` (the box's image count + 1). Null when the HTML
 * holds no image to attach, so every other paste goes on as before.
 */
export function htmlImagePaste(html: string, first = 1, max = MAX_PASTE_IMAGES): ImagePaste | null {
  if (!html || !/<img\b/i.test(html)) return null;
  const images: PastedImage[] = [];
  let n = first;
  let over = false;
  const text = htmlPasteText(html, (img) => {
    const c = classify(img);
    if (c.kind === "none") return null;
    if (c.kind === "text") return c.text;
    const k = n++;
    if (images.length >= max) {
      over = true;
      return failedMarker(k, `not attached, over ${max} images in one paste`);
    }
    images.push({ n: k, src: c.src });
    return marker(k);
  });
  if (text === null || (images.length === 0 && !over)) return null;
  return { text, images };
}

/** A `data:` URL's image as the chip holds it (raw base64), or why not. */
export function decodeDataUrl(src: string): { media_type: string; data: string } | { error: string } {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return { error: "could not be read" };
  const type = (m[1] || "text/plain").toLowerCase();
  if (!IMAGE_TYPES.has(type)) return { error: `could not be attached (${type || "unknown type"})` };
  const base64 = /;base64/i.test(m[2]);
  let data: string;
  try {
    data = base64 ? m[3].replace(/\s+/g, "") : btoa(decodeURIComponent(m[3]));
  } catch {
    return { error: "could not be read" };
  }
  if (!data) return { error: "could not be read" };
  return { media_type: type, data };
}

/** `text` with the first `[image n]` read as `replacement`; unchanged when
 *  he has deleted the marker meanwhile. */
export function replaceMarker(text: string, n: number, replacement: string): string {
  const m = marker(n);
  const at = text.indexOf(m);
  return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + m.length);
}

/** What the backend's `fetch_paste_image` returns. */
export interface FetchedImage {
  media_type: string;
  data: string;
}

/** An `http(s)` image of a paste, from the pasteboard's web archive or the
 *  network (`paste_images.rs`); rejects with the reason. */
export function fetchPasteImage(url: string): Promise<FetchedImage> {
  return invoke("fetch_paste_image", { url });
}

/** One image of a paste, settled as far as can be without the network. */
export type PreparedImage =
  | { n: number; image: FetchedImage }
  | { n: number; url: string };

/**
 * What can be settled at once: `data:` images decoded, each one that cannot
 * be attached already reading its reason in the text. The text is what goes
 * in the box; the images are what become chips, in order.
 */
export function preparePaste(paste: ImagePaste, cap: number): { text: string; images: PreparedImage[]; failed: number[] } {
  let text = paste.text;
  const images: PreparedImage[] = [];
  const failed: number[] = [];
  const fail = (n: number, why?: string) => {
    failed.push(n);
    text = replaceMarker(text, n, failedMarker(n, why));
  };
  for (const img of paste.images) {
    if (/^data:/i.test(img.src)) {
      const d = decodeDataUrl(img.src);
      if ("error" in d) fail(img.n, d.error);
      else if (d.data.length > cap) fail(img.n, TOO_BIG);
      else images.push({ n: img.n, image: d });
    } else if (/^https?:\/\//i.test(img.src)) images.push({ n: img.n, url: img.src });
    else fail(img.n);
  }
  return { text, images, failed };
}

const TOO_BIG = "could not be attached (over the image size limit)";

export interface PasteImageEffects {
  nextId: () => number;
  add: (chip: Attachment) => void;
  update: (id: number, patch: Partial<Attachment>) => void;
  remove: (id: number) => void;
  /** The box's text now, and setting it (a failed image's marker). */
  readText: () => string;
  setText: (text: string) => void;
  fetch: (url: string) => Promise<FetchedImage>;
  /** A fetch in flight, so Send waits for it. */
  track: (id: number, job: Promise<void>) => void;
  /** An image chip with its data in hand (for the clipboard ring). */
  record: (chip: Attachment) => void;
  /** The base64 cap for an image. */
  cap: number;
  toast: (msg: string) => void;
}

/**
 * The prepared images into chips, in marker order — decoded ones whole,
 * fetched ones as waiting chips filled when the backend answers. `failed`
 * are the numbers `preparePaste` already marked, for the one toast. The
 * promise settles when every fetch has.
 */
export function attachPastedImages(images: PreparedImage[], failed: number[], fx: PasteImageEffects): Promise<void> {
  const lost = failed.slice();
  const jobs: Promise<void>[] = [];
  for (const img of images) {
    const name = `image ${img.n}`;
    if ("image" in img) {
      const chip: Attachment = { id: fx.nextId(), kind: "image", name, media_type: img.image.media_type, data: img.image.data };
      fx.add(chip);
      fx.record(chip);
      continue;
    }
    const id = fx.nextId();
    fx.add({ id, kind: "image", name, media_type: "image/png", data: "", label: "fetching", pending: true });
    const fail = (why?: string) => {
      fx.remove(id);
      lost.push(img.n);
      fx.setText(replaceMarker(fx.readText(), img.n, failedMarker(img.n, why)));
    };
    const job = fx.fetch(img.url).then(
      (got) => {
        if (!IMAGE_TYPES.has(got.media_type)) return fail(`could not be attached (${got.media_type})`);
        if (got.data.length > fx.cap) return fail(TOO_BIG);
        fx.update(id, { media_type: got.media_type, data: got.data, label: undefined, pending: false });
        fx.record({ id, kind: "image", name, media_type: got.media_type, data: got.data });
      },
      () => fail(),
    );
    fx.track(id, job);
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => {
    if (lost.length === 0) return;
    lost.sort((a, b) => a - b);
    fx.toast(
      lost.length === 1
        ? `Image ${lost[0]} from the paste could not be attached; its place in the text says so`
        : `${lost.length} images from the paste could not be attached (${lost.join(", ")}); their places in the text say so`,
    );
  });
}
