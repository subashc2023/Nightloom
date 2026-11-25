/**
 * Item 904 (blocker 2283, default: split): what the box's draft adds to the
 * next send — its text and its attachments, as tokens — so every next-send
 * figure (the cache chip, the cold and warm hand-off banners, the "cache will
 * be lost" bar, the right column's cache row, the cold toast, the model
 * menu's switch price, an aside's chip, the phone's chip) prices what will
 * actually go. Those tokens are new: written to the cache whether it is warm
 * or cold. Pure, no app state, so the phone page imports it too.
 *
 * Left for later (the item's second half): the Tools and Format toggles,
 * which change the size of the tool block — not known in the app until
 * it is measured per chat.
 *
 * The figures are estimates, said as `~`:
 * - text: characters ÷ 4 (`estimateTokens`, the figure beside Send);
 * - an image: width × height ÷ 750 once scaled to the 1568-px long edge and
 *   ~1.15 megapixels, so at most ~1.6k (external: Anthropic's vision
 *   guide claims that formula and cap; not re-checked tonight); a size the
 *   header does not give counts the cap;
 * - a PDF inline: ~1.7k a page (the 489 report, `attachKinds.ts`); one by
 *   path (long, on Claude Code) or a `file` chip goes as a path, so only
 *   the line naming it counts — what the model reads of it is its own turn;
 * - a text document: its bytes ÷ 4;
 * - a chip still converting: nothing yet (its size is not known).
 */
import { estimateTokens } from "./tokens";
import { pdfRoute, type Engine } from "./attachKinds";

/** What the estimate needs of an attachment (the desktop's `Attachment`,
 *  the phone's image and document inputs). */
export interface DraftFile {
  kind?: "image" | "document" | "file";
  media_type: string;
  data: string;
  pages?: number;
  whole?: boolean;
  pending?: boolean;
}

/** One page of a PDF inline (the 489 report). */
export const PDF_PAGE_TOKENS = 1_700;
/** An image the API scales to its most (external, Anthropic's vision guide). */
export const IMAGE_MAX_TOKENS = 1_600;
const IMAGE_LONG_EDGE = 1_568;
const IMAGE_MAX_PIXELS = 1_150_000;
/** A chip sent as a path: the line that names it. */
const PATH_LINE_TOKENS = 40;

/** Bytes a base64 string holds. */
function base64Bytes(b64: string): number {
  const s = b64.replace(/\s/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/** The first `n` bytes of a base64 string (no whole decode of a big image). */
function headBytes(b64: string, n: number): Uint8Array {
  const chars = Math.ceil(n / 3) * 4;
  let bin = "";
  try {
    bin = atob(b64.replace(/\s/g, "").slice(0, chars));
  } catch {
    return new Uint8Array();
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An image's pixel size from its header — PNG, GIF and JPEG; null else. */
export function imageSize(media_type: string, b64: string): { w: number; h: number } | null {
  if (media_type === "image/png") {
    const b = headBytes(b64, 24);
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
    const w = ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0;
    const h = ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (media_type === "image/gif") {
    const b = headBytes(b64, 10);
    if (b.length < 10 || b[0] !== 0x47) return null;
    const w = b[6]! | (b[7]! << 8);
    const h = b[8]! | (b[9]! << 8);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (media_type === "image/jpeg") {
    // The frame header (SOF0–SOF15 bar DHT/JPG/DAC) carries the size; it
    // sits after the app segments, well inside the first 64 KB.
    const b = headBytes(b64, 65_536);
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (b[i + 5]! << 8) | b[i + 6]!;
        const w = (b[i + 7]! << 8) | b[i + 8]!;
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** An image's tokens once the API has scaled it. */
export function imageTokens(size: { w: number; h: number } | null): number {
  if (!size) return IMAGE_MAX_TOKENS;
  const { w, h } = size;
  const s = Math.min(1, IMAGE_LONG_EDGE / Math.max(w, h), Math.sqrt(IMAGE_MAX_PIXELS / (w * h)));
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil((w * s * (h * s)) / 750));
}

/** One attachment's tokens on the next send. */
export function fileTokens(a: DraftFile, engine: Engine): number {
  if (a.pending || !a.data) return 0;
  const kind = a.kind ?? (a.media_type.startsWith("image/") ? "image" : "document");
  if (kind === "file") return PATH_LINE_TOKENS;
  if (kind === "image") return imageTokens(imageSize(a.media_type, a.data));
  if (a.media_type === "application/pdf") {
    const route = pdfRoute({ kind: "document", media_type: a.media_type, pages: a.pages, whole: a.whole }, engine);
    if (route === "path") return PATH_LINE_TOKENS;
    return Math.max(1, a.pages ?? 1) * PDF_PAGE_TOKENS;
  }
  return Math.ceil(base64Bytes(a.data) / 4);
}

/** The draft's tokens on the next send: its text and its attachments. */
export function draftSendTokens(text: string, files: readonly DraftFile[], engine: Engine): number {
  let n = text.trim() ? estimateTokens(text) : 0;
  for (const f of files) n += fileTokens(f, engine);
  return n;
}

/** The tooltip's line that says the figure counts the draft; "" with none. */
export function draftCostNote(tokens: number): string {
  if (tokens <= 0) return "";
  const k = tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : `${tokens}`;
  return `Includes this draft's ~${k} tokens`;
}
