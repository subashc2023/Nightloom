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
 * - an SVG or AVIF (the model takes neither) is drawn as a PNG by WebKit
 *   (item 385, `rasterize`);
 * - one that cannot be had loses its chip and its marker reads
 *   `[image: could not be fetched (why)]` — the backend's reason, e.g.
 *   that the site wants his sign-in (item 385: the reason was dropped and
 *   a Gradescope paste said only "could not be fetched") — or why it could
 *   not be attached; never a silent loss. Its number goes with it: every later
 *   `[image M]` in the box (and its chip's name) moves down one, so the
 *   numbers keep naming the images in the order the model sees them
 *   (review 2026-10-18: a lost image 1 left `[image 2]` naming the first
 *   image sent).
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
/** Item 385: types the model does not take that WebKit draws, so the
 *  composer converts them to PNG (`rasterize`) — a site's SVG logo, AVIF. */
export const CONVERTIBLE_TYPES = new Set(["image/svg+xml", "image/avif"]);

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
/** Where an image stood that is not attached. It has no number: numbers
 *  name only the images the model is sent, in its order. */
export const failedMarker = (why = "could not be fetched") => `[image: ${why}]`;
/** The longest a paste's image may stay waiting before it counts as lost,
 *  so a stuck backend call never holds Send (the backend's own budget is
 *  20 s for the network). */
export const FETCH_LIMIT_MS = 45_000;

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
  const base = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const images: PastedImage[] = [];
  let n = first;
  let over = false;
  const text = htmlPasteText(html, (img) => {
    const c = classify(img);
    if (c.kind === "none") return null;
    if (c.kind === "text") return c.text;
    if (images.length >= max) {
      over = true;
      return failedMarker(`not attached, over ${max} images in one paste`);
    }
    const k = n++;
    images.push({ n: k, src: resolveSrc(c.src, base) });
    return marker(k);
  });
  if (text === null || (images.length === 0 && !over)) return null;
  return { text, images };
}

/** Item 385: an image's address made whole — `//host/x` and, when the copy
 *  names its page (`<base href>`), `/x` or `x` — so it can be fetched; any
 *  other address is left as it is (and its marker says why). */
export function resolveSrc(src: string, base?: string): string {
  if (/^(data|https?|blob):/i.test(src)) return src;
  try {
    if (src.startsWith("//")) return new URL(src, base && /^https?:/i.test(base) ? base : "https://x.invalid").href;
    if (base && /^https?:/i.test(base)) return new URL(src, base).href;
  } catch {
    /* left as it is */
  }
  return src;
}

/** Why an image whose address is not a web address cannot be had. */
function unreachable(src: string): string {
  return /^blob:/i.test(src)
    ? "could not be fetched (the page kept it to itself; drag the image in)"
    : "could not be fetched (only part of its address came with the copy)";
}

/** The marker's words for a fetch that failed: the backend's reason (a
 *  string), the time limit's, or none. */
export function fetchFailure(e: unknown): string {
  const why = typeof e === "string" ? e : e instanceof Error && e.message === "timed out" ? "timed out" : "";
  return why ? `could not be fetched (${why})` : "could not be fetched";
}

/** A `data:` URL's image as the chip holds it (raw base64), or why not. */
export function decodeDataUrl(src: string): { media_type: string; data: string } | { error: string } {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return { error: "could not be read" };
  const type = (m[1] || "text/plain").toLowerCase();
  if (!IMAGE_TYPES.has(type) && !CONVERTIBLE_TYPES.has(type)) return { error: `could not be attached (${type || "unknown type"})` };
  const base64 = /;base64/i.test(m[2]);
  let data: string;
  try {
    data = base64
      ? m[3].replace(/\s+/g, "")
      : type === "image/svg+xml"
        ? utf8Base64(decodeURIComponent(m[3]))
        : btoa(decodeURIComponent(m[3]));
  } catch {
    return { error: "could not be read" };
  }
  if (!data) return { error: "could not be read" };
  return { media_type: type, data };
}

function utf8Base64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The longest side a converted image is drawn at; an SVG smaller than
 *  `SVG_MIN_SIDE` is drawn up to it, so a logo reads. */
const MAX_SIDE = 2048;
const SVG_MIN_SIDE = 1024;

/**
 * Item 385: an SVG or AVIF as a PNG, drawn by WebKit — the model takes
 * neither. Rejects when WebKit cannot draw it (or will not let the canvas
 * be read back).
 */
export async function rasterize(img: FetchedImage): Promise<FetchedImage> {
  const el = new Image();
  el.src = `data:${img.media_type};base64,${img.data}`;
  await el.decode();
  let w = el.naturalWidth || 300;
  let h = el.naturalHeight || 150;
  const long = Math.max(w, h);
  const scale = img.media_type === "image/svg+xml" && long < SVG_MIN_SIDE ? SVG_MIN_SIDE / long : Math.min(1, MAX_SIDE / long);
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(el, 0, 0, w, h);
  const url = canvas.toDataURL("image/png");
  const data = url.slice(url.indexOf(",") + 1);
  if (!data) throw new Error("empty");
  return { media_type: "image/png", data };
}

/** `text` with the first `[image n]` read as `replacement`; unchanged when
 *  he has deleted the marker meanwhile. */
export function replaceMarker(text: string, n: number, replacement: string): string {
  const m = marker(n);
  const at = text.indexOf(m);
  return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + m.length);
}

/** `text` with every `[image m]` past `lost` moved down one: image `lost`
 *  is gone, so each later image is now one earlier in what the model sees. */
export function shiftMarkersAfter(text: string, lost: number): string {
  return text.replace(/\[image (\d+)\]/g, (all, d: string) => {
    const m = Number(d);
    return m > lost ? marker(m - 1) : all;
  });
}

/** The number in a chip's `image N` name, or null for any other name. */
export function chipNumber(name: string): number | null {
  const m = /^image (\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
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
  // Images lost so far: each later one moves down this many.
  let lost = 0;
  const fail = (n: number, why?: string) => {
    failed.push(n);
    text = replaceMarker(text, n, failedMarker(why));
    lost++;
  };
  const keep = (n: number): number => {
    if (lost > 0) text = replaceMarker(text, n, marker(n - lost));
    return n - lost;
  };
  for (const img of paste.images) {
    if (/^data:/i.test(img.src)) {
      const d = decodeDataUrl(img.src);
      if ("error" in d) fail(img.n, d.error);
      else if (d.data.length > cap) fail(img.n, TOO_BIG);
      else images.push({ n: keep(img.n), image: d });
    } else if (/^https?:\/\//i.test(img.src)) images.push({ n: keep(img.n), url: img.src });
    else fail(img.n, unreachable(img.src));
  }
  return { text, images, failed };
}

const TOO_BIG = "could not be attached (over the image size limit)";

export interface PasteImageEffects {
  nextId: () => number;
  add: (chip: Attachment) => void;
  update: (id: number, patch: Partial<Attachment>) => void;
  remove: (id: number) => void;
  /** The box's chips now, in order (a lost image renumbers the later ones). */
  chips: () => Attachment[];
  /** The box's text now, and setting it (a failed image's marker). */
  readText: () => string;
  setText: (text: string) => void;
  fetch: (url: string) => Promise<FetchedImage>;
  /** An SVG or AVIF as a PNG (`rasterize`); absent, such an image is lost
   *  with its type named. */
  convert?: (img: FetchedImage) => Promise<FetchedImage>;
  /** A fetch in flight, so Send waits for it. */
  track: (id: number, job: Promise<void>) => void;
  /** An image chip with its data in hand (for the clipboard ring). */
  record: (chip: Attachment) => void;
  /** The base64 cap for an image. */
  cap: number;
  toast: (msg: string) => void;
  /** How long a fetch may wait before it counts as lost (FETCH_LIMIT_MS). */
  limitMs?: number;
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
    const convertible = "image" in img && CONVERTIBLE_TYPES.has(img.image.media_type);
    if ("image" in img && !convertible) {
      const chip: Attachment = { id: fx.nextId(), kind: "image", name, media_type: img.image.media_type, data: img.image.data };
      fx.add(chip);
      fx.record(chip);
      continue;
    }
    const id = fx.nextId();
    fx.add({ id, kind: "image", name, media_type: "image/png", data: "", label: convertible ? "converting" : "fetching", pending: true });
    let settled = false;
    const fail = (why?: string) => {
      if (settled) return;
      settled = true;
      lost.push(img.n);
      // Its number now (an earlier loss may have moved it down); a chip he
      // removed meanwhile is his own edit and is left as he made it.
      const chip = fx.chips().find((c) => c.id === id);
      const n = chip ? chipNumber(chip.name) : null;
      fx.remove(id);
      if (n === null) return;
      let text = replaceMarker(fx.readText(), n, failedMarker(why));
      text = shiftMarkersAfter(text, n);
      fx.setText(text);
      for (const c of fx.chips()) {
        const m = c.kind === "image" ? chipNumber(c.name) : null;
        if (m !== null && m > n) fx.update(c.id, { name: `image ${m - 1}` });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new Error("timed out")), fx.limitMs ?? FETCH_LIMIT_MS);
    });
    const untyped = (t: string) => `could not be attached (${t})`;
    // Item 385: an SVG or AVIF is drawn as a PNG; one WebKit cannot draw is
    // lost with its type named.
    const toModel = (got: FetchedImage): Promise<FetchedImage> =>
      !CONVERTIBLE_TYPES.has(got.media_type)
        ? Promise.resolve(got)
        : fx.convert
          ? fx.convert(got).catch(() => Promise.reject(untyped(got.media_type)))
          : Promise.reject(untyped(got.media_type));
    const source = "image" in img ? Promise.resolve(img.image) : fx.fetch(img.url).catch((e: unknown) => Promise.reject(fetchFailure(e)));
    const job = Promise.race([source.then(toModel), limit])
      .finally(() => clearTimeout(timer))
      .then(
        (got) => {
          if (settled) return;
          if (!IMAGE_TYPES.has(got.media_type)) return fail(untyped(got.media_type));
          if (got.data.length > fx.cap) return fail(TOO_BIG);
          settled = true;
          const now = fx.chips().find((c) => c.id === id)?.name ?? name;
          fx.update(id, { media_type: got.media_type, data: got.data, label: undefined, pending: false });
          fx.record({ id, kind: "image", name: now, media_type: got.media_type, data: got.data });
        },
        (e: unknown) => fail(typeof e === "string" ? e : fetchFailure(e)),
      );
    fx.track(id, job);
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => {
    if (lost.length === 0) return;
    fx.toast(
      lost.length === 1
        ? "An image from the paste could not be attached; its place in the text says so"
        : `${lost.length} images from the paste could not be attached; their places in the text say so`,
    );
  });
}
