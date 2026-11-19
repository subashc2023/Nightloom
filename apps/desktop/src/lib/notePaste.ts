/**
 * Item 860 (his ask, 2026-11-18, for exam prep): copied text with images
 * pasted into a note keeps every image — saved as a file beside the note
 * and linked inline where it stood. It is the composer's paste (item 382,
 * `pasteImages.ts`) with the note's ending: the same HTML walk (math as
 * TeX, tables as Markdown, here headings as `#` lines too), the same image
 * rules (`classify`, `resolveSrc`, `decodeDataUrl`, the backend's
 * `fetch_paste_image`, `rasterize` for SVG/AVIF), but each image becomes
 * `![alt](attachments/<name>)` in the text instead of a chip.
 *
 * The links go in at once, with the names the files will have, so the text
 * is final the moment he pastes and a slow fetch never holds his typing;
 * the files land behind it, a few at a time. A file that lands under
 * another name (Keep both found one already there, or the image's real type
 * differs from its address) has its link moved; one that cannot be had has
 * its link replaced by `[image: could not be fetched (why)]` — never a
 * silent loss.
 *
 * Names are for a model to choose by (his rule, 2026-11-18: a chat reading
 * the note gets text and paths only, and opens the image it wants): the
 * note's own name, the image's place in the paste, and the image's alt
 * text, else its caption, else the heading above it —
 * `lecture-3-03-alu-truth-table.png`, never only a hash.
 */
import { classify, CONVERTIBLE_TYPES, decodeDataUrl, failedMarker, fetchFailure, resolveSrc, type FetchedImage } from "./pasteImages";
import { htmlNoteText, type El } from "./mathPaste";
import { attachmentsFolder, linkPath, relativeToNote } from "./noteFormat";

export interface NotePasteImage {
  /** 1-based place in the paste. */
  n: number;
  src: string;
  /** The file name it is saved under, in `folder`. */
  file: string;
  alt: string;
  /** What stands in the text now: `![alt](path)`. */
  link: string;
}

export interface NotePastePlan {
  text: string;
  /** Store-relative folder the images go in (`attachments/` beside the note). */
  folder: string;
  images: NotePasteImage[];
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Lower-case words joined by `-`, at most `max` characters, cut at a word. */
export function slugWords(s: string, max = 40): string {
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] ?? "").slice(0, max);
}

function textOf(e: El | string): string {
  if (typeof e === "string") return e;
  return e.children.map(textOf).join(" ");
}

const HEADING = /^h[1-6]$/;

/** The last heading inside `e`, or null. */
function lastHeading(e: El): El | null {
  for (let i = e.children.length - 1; i >= 0; i--) {
    const c = e.children[i];
    if (typeof c === "string") continue;
    if (HEADING.test(c.tag)) return c;
    const inner = lastHeading(c);
    if (inner) return inner;
  }
  return null;
}

/** Words that say what an image is: its caption (`<figure>`'s
 *  `<figcaption>`), else the nearest heading above it. */
export function nearbyWords(img: El): string {
  for (let p = img.parent; p; p = p.parent) {
    if (p.tag === "figure") {
      const cap = p.children.find((c): c is El => typeof c !== "string" && c.tag === "figcaption");
      if (cap) {
        const t = textOf(cap).replace(/\s+/g, " ").trim();
        if (t) return t;
      }
    }
  }
  let node: El = img;
  for (let steps = 0; node.parent && steps < 400; steps++) {
    const parent: El = node.parent;
    const at = parent.children.indexOf(node);
    for (let i = at - 1; i >= 0; i--) {
      const c = parent.children[i];
      if (typeof c === "string") continue;
      const h = HEADING.test(c.tag) ? c : lastHeading(c);
      if (h) return textOf(h).replace(/\s+/g, " ").trim();
    }
    node = parent;
  }
  return "";
}

/** The extension an image's address suggests (`png` when it says none). */
export function extFor(src: string): string {
  const d = /^data:([^;,]+)/i.exec(src);
  if (d) return EXT[d[1].toLowerCase()] ?? "png";
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(src.replace(/^[a-z]+:\/\/[^/]+/i, ""));
  const e = m?.[1].toLowerCase();
  if (e === "jpeg") return "jpg";
  return e && Object.values(EXT).includes(e) ? e : "png";
}

/** The note's name as a file-name stem: `Exams/Lecture 3.md` → `lecture-3`. */
export function noteStem(noteName: string): string {
  const leaf = noteName.split("/").pop() ?? noteName;
  const dot = leaf.lastIndexOf(".");
  return slugWords(dot > 0 ? leaf.slice(0, dot) : leaf, 30) || "note";
}

function cleanAlt(s: string): string {
  return s.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

/** `![alt](path)` for a file in the note's attachments folder. */
export function noteImageLink(noteName: string, folder: string, file: string, alt: string): string {
  return `![${alt}](${linkPath(relativeToNote(noteName, `${folder}/${file}`))})`;
}

/**
 * The paste as the note's text with a link per image, and the images to
 * save. Null when the HTML holds no image to save, so every other paste
 * goes in as it always did.
 */
export function planNotePaste(html: string, noteName: string): NotePastePlan | null {
  if (!html || !/<img\b/i.test(html)) return null;
  const base = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const folder = attachmentsFolder(noteName);
  const stem = noteStem(noteName);
  const found: { src: string; words: string; alt: string }[] = [];
  // The walk gives each image a token; the names need the total count (the
  // index's width), so the links go in after.
  const token = (i: number) => `\u0000nlimg${i}\u0000`;
  const text = htmlNoteText(html, (img) => {
    const c = classify(img);
    if (c.kind === "none") return null;
    if (c.kind === "text") return c.text;
    const alt = cleanAlt(img.attrs.alt ?? "");
    const words = alt || cleanAlt(img.attrs.title ?? "") || cleanAlt(nearbyWords(img));
    found.push({ src: resolveSrc(c.src, base), words, alt });
    return token(found.length - 1);
  });
  if (text === null || found.length === 0) return null;
  const width = Math.max(2, String(found.length).length);
  const images: NotePasteImage[] = found.map((f, i) => {
    const n = i + 1;
    const idx = String(n).padStart(width, "0");
    const slug = slugWords(f.words);
    const file = `${stem}-${idx}${slug ? `-${slug}` : ""}.${extFor(f.src)}`;
    const alt = f.alt || (f.words ? f.words.slice(0, 80) : `image ${n}`);
    return { n, src: f.src, file, alt, link: noteImageLink(noteName, folder, file, alt) };
  });
  let out = text;
  images.forEach((img, i) => {
    out = out.replace(token(i), img.link);
  });
  return { text: out, folder, images };
}

/** What landing one image needs from the app. */
export interface NoteImageEffects {
  fetch: (url: string) => Promise<FetchedImage>;
  /** SVG/AVIF drawn as PNG (`rasterize`), so a model can open it. */
  convert?: (img: FetchedImage) => Promise<FetchedImage>;
  /** Write the file; resolves to the store-relative path it landed at. */
  keep: (folder: string, file: string, mediaType: string, data: string) => Promise<string>;
  /** Replace the first `from` in the note's text with `to`. */
  relink: (from: string, to: string) => void;
  /** Saved so far, of all, failed so far. */
  progress?: (done: number, total: number, failed: number) => void;
  /** How many land at once. */
  parallel?: number;
  /** One image settled, saved or lost (the editor draws it now). */
  settled?: (img: NotePasteImage) => void;
}

/** One image's bytes, as a model can open them. */
async function bytesOf(src: string, fx: NoteImageEffects): Promise<FetchedImage> {
  let got: FetchedImage;
  if (/^data:/i.test(src)) {
    const d = decodeDataUrl(src);
    if ("error" in d) throw d.error;
    got = d;
  } else if (/^https?:\/\//i.test(src)) {
    got = await fx.fetch(src).catch((e: unknown) => Promise.reject(fetchFailure(e)));
  } else if (/^blob:/i.test(src)) {
    throw "could not be fetched (the page kept it to itself; drag the image in)";
  } else {
    throw "could not be fetched (only part of its address came with the copy)";
  }
  if (CONVERTIBLE_TYPES.has(got.media_type) && fx.convert) {
    got = await fx.convert(got).catch(() => got);
  }
  return got;
}

/**
 * Save every image of `plan`, a few at a time, moving or failing links as
 * they land. Resolves with how many were saved and how many lost.
 */
export async function saveNotePasteImages(
  plan: NotePastePlan,
  noteName: string,
  fx: NoteImageEffects,
): Promise<{ saved: number; failed: number }> {
  const total = plan.images.length;
  let saved = 0;
  let failed = 0;
  let next = 0;
  fx.progress?.(0, total, 0);
  const one = async (img: NotePasteImage) => {
    try {
      const got = await bytesOf(img.src, fx);
      const ext = EXT[got.media_type] ?? img.file.split(".").pop() ?? "png";
      const file = img.file.replace(/\.[a-z0-9]+$/i, `.${ext}`);
      const rel = await fx.keep(plan.folder, file, got.media_type, got.data);
      const landed = rel.slice(rel.lastIndexOf("/") + 1);
      if (landed !== img.file) fx.relink(img.link, noteImageLink(noteName, plan.folder, landed, img.alt));
      saved++;
    } catch (e) {
      failed++;
      const why = typeof e === "string" ? e : e instanceof Error ? `could not be saved (${e.message})` : undefined;
      fx.relink(img.link, failedMarker(why));
    }
    fx.settled?.(img);
    fx.progress?.(saved + failed, total, failed);
  };
  const worker = async () => {
    while (next < total) await one(plan.images[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(fx.parallel ?? 4, total) }, worker));
  return { saved, failed };
}

/** Image files pasted bare (a screenshot copied, a file copied in Finder):
 *  the same naming, the bytes in hand. */
export function planFilePaste(files: { name: string; src: string }[], noteName: string, at = 1): NotePastePlan {
  const folder = attachmentsFolder(noteName);
  const stem = noteStem(noteName);
  const images = files.map(({ name, src }, i) => {
    const n = at + i;
    const dot = name.lastIndexOf(".");
    const words = slugWords(dot > 0 ? name.slice(0, dot) : name);
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "png";
    const file = `${stem}-${String(n).padStart(2, "0")}${words ? `-${words}` : ""}.${ext}`;
    const alt = cleanAlt(dot > 0 ? name.slice(0, dot) : name) || `image ${n}`;
    return { n, src, file, alt, link: noteImageLink(noteName, folder, file, alt) };
  });
  return { text: images.map((i) => i.link).join("\n\n"), folder, images };
}
