/*
 * Item 362 — the look of dropping files on a message box, his mix (blocker
 * 1445, 2026-10-15): held over the chat, B (a veil over the chat and a
 * dashed zone above the box, "Drop anywhere in the chat"; the whole chat
 * takes the drop); held over the box, B's first frame (the zone and the
 * box's edge turn accent); the drop, A (the dragged files shrink into the
 * box and a ripple spreads from the drop point); the chip, A (the chip row
 * opens, the chip scales in with a slight overshoot, an accent ring fades
 * off it). Reduced motion: no ripple, no shrink, no scale or ring — the
 * chip fades in; the veil and zone come and go without moving.
 *
 * The pure parts — which box a drag is over, the zone's place, the chip's
 * motion — live here so they are testable without a window;
 * `dropLook.svelte.ts` wires them to the window's drag events.
 *
 * No count while dragging (measured 2026-10-15, `wave9-362-report.md`):
 * during `dragover` WebKit's `dataTransfer` says only "Files"; `items`
 * holds the first file's type when it is an image and nothing otherwise,
 * so three files would read "1 image". The names and the count are known
 * only at the drop.
 */

/** Where a file drag is: over the chat (the live transcript or the empty
 *  chat's page), over the chat's own message box, over another box (an
 *  aside's box, a message's edit box), or over something that takes no
 *  files. */
export type DropKind = "chat" | "main" | "box" | "none";

/** The attribute a message box carries: `main` for the chat's composer,
 *  anything else for the other boxes. */
export const BOX_ATTR = "data-drop-box";
/** The attribute the region that takes a drop for the chat's box carries. */
export const CHAT_ATTR = "data-drop-chat";

type Hit = { closest(selector: string): Hit | null; getAttribute(name: string): string | null };

export function dropKind(target: unknown): { kind: DropKind; box: Hit | null } {
  const t = target as Hit | null;
  if (!t || typeof t.closest !== "function") return { kind: "none", box: null };
  const box = t.closest(`[${BOX_ATTR}]`);
  if (box) return { kind: box.getAttribute(BOX_ATTR) === "main" ? "main" : "box", box };
  if (t.closest(`[${CHAT_ATTR}]`)) return { kind: "chat", box: null };
  return { kind: "none", box: null };
}

/** A drag carries files (not text, not a tab or a chat being moved). */
export function carriesFiles(dt: { types?: ArrayLike<string> | readonly string[] } | null | undefined): boolean {
  return !!dt?.types && Array.from(dt.types).includes("Files");
}

/** The zone's words: its title by where the file is held, and one line. */
export function zoneTitle(kind: DropKind): string {
  return kind === "main" ? "Drop to attach" : "Drop anywhere in the chat";
}
export const ZONE_LINE = "goes with your next message";

export type Rect = { left: number; top: number; width: number; height: number };

const ZONE_H = 170;
const ZONE_GAP = 14;
const ZONE_MIN = 56;

/** The dashed zone: as wide as the box's card, up to 170 px tall, its foot
 *  14 px above the composer (chips and queue included) and inside the
 *  chat; null when the chat is too short to hold one. */
export function zoneRect(chat: Rect, card: Rect, composerTop: number): Rect | null {
  const foot = Math.min(composerTop, chat.top + chat.height) - ZONE_GAP;
  const room = foot - chat.top - ZONE_GAP;
  const height = Math.min(ZONE_H, room);
  if (height < ZONE_MIN) return null;
  return { left: card.left, top: foot - height, width: card.width, height };
}

/** The veil covers the chat but never the box the file goes to: when the
 *  composer sits inside the chat (the empty chat's page), the veil gets a
 *  hole where the composer is. An even-odd path for `clip-path`, in the
 *  veil's own coordinates; null when nothing needs cutting. */
export function veilClip(chat: Rect, hole: Rect): string | null {
  const l = Math.max(chat.left, hole.left);
  const t = Math.max(chat.top, hole.top);
  const r = Math.min(chat.left + chat.width, hole.left + hole.width);
  const b = Math.min(chat.top + chat.height, hole.top + hole.height);
  if (r <= l || b <= t) return null;
  const x0 = l - chat.left;
  const y0 = t - chat.top;
  const x1 = r - chat.left;
  const y1 = b - chat.top;
  const W = chat.width;
  const H = chat.height;
  return `path(evenodd, "M0 0H${W}V${H}H0Z M${x0} ${y0}H${x1}V${y1}H${x0}Z")`;
}

// ---- motion --------------------------------------------------------------

/** The drop: the dragged files shrink and fade, the ripple spreads. */
export const LAND_MS = 420;
/** The chip: the row opens and the chip scales in; each further file of
 *  the same drop starts this much later. */
export const CHIP_MS = 520;
export const CHIP_STAGGER_MS = 70;
/** Reduced motion: the chip only fades in. */
export const CHIP_FADE_RM_MS = 160;
export const RIPPLE_FROM = 40;
export const RIPPLE_TO = 300;

export function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
/** Ease-out with a small overshoot (about 4 % past the end, then back). */
export function overshoot(x: number): number {
  return 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
}

export type ChipIn = { delay?: number; duration: number; css?: (t: number) => string };

/** A dropped file's chip arriving (A): `i` is its place in the drop, `w`
 *  its laid-out width. The row opens (the width grows from 0), the chip
 *  rises 8 px and scales from 0.82 with a slight overshoot, and an accent
 *  ring fades off it (`--drop-ring`, drawn by the chip's face). */
export function chipDropIn(i: number, w: number, reduced: boolean): ChipIn {
  if (reduced) return { duration: CHIP_FADE_RM_MS, css: (t) => `opacity: ${t}` };
  return {
    delay: i * CHIP_STAGGER_MS,
    duration: CHIP_MS,
    css: (k) => {
      const width = w * easeOut(Math.min(1, k * 1.6));
      const lift = 8 * (1 - easeOut(k));
      const scale = 0.82 + 0.18 * overshoot(k);
      const ring = Math.round(70 * (1 - k));
      return (
        `width: ${width.toFixed(2)}px; opacity: ${Math.min(1, k * 2)}; ` +
        `transform: translateY(${lift.toFixed(2)}px) scale(${scale.toFixed(4)}); transform-origin: 50% 100%; ` +
        `--drop-ring: 0 0 0 2px color-mix(in srgb, var(--accent) ${ring}%, transparent);`
      );
    },
  };
}

/** The chip row's first chip opens the row: its height from 0. */
export function rowDropOpen(h: number, reduced: boolean): ChipIn {
  if (reduced) return { duration: 0 };
  return { duration: 220, css: (k) => `height: ${(h * easeOut(k)).toFixed(2)}px; overflow: visible;` };
}

/** The face drawn for each dropped file at the drop (at most three, the
 *  rest counted): an image's picture, or a document's extension. */
export type LandTile = { kind: "image"; file: File } | { kind: "doc"; ext: string };
export function landTiles(files: readonly File[]): { tiles: LandTile[]; more: number } {
  const tiles = files.slice(0, 3).map((f): LandTile => {
    if (f.type.startsWith("image/")) return { kind: "image", file: f };
    const dot = f.name.lastIndexOf(".");
    const ext = dot > 0 ? f.name.slice(dot + 1).toUpperCase().slice(0, 4) : "FILE";
    return { kind: "doc", ext };
  });
  return { tiles, more: Math.max(0, files.length - 3) };
}

/** One-shot marks for dropped files' chips, by name, each with its place
 *  in its drop. A mark that no chip took (a file too large, a type the box
 *  refuses) lapses after `ttl` ms so a later chip of that name is not
 *  animated by mistake. */
export class DropMarks {
  private marks = new Map<string, { i: number; at: number }>();
  private last = -Infinity;
  constructor(private ttl = 8000) {}
  mark(names: readonly string[], now: number): void {
    this.last = now;
    names.forEach((n, i) => this.marks.set(n, { i, at: now }));
  }
  /** The chip's place in its drop, or null when it was not dropped. */
  take(name: string, now: number): number | null {
    const m = this.marks.get(name);
    if (!m) return null;
    this.marks.delete(name);
    return now - m.at <= this.ttl ? m.i : null;
  }
  /** Whether a drop was marked within `within` ms: the chip row that
   *  appears now opens for it (its chips may have taken their marks
   *  already — the row and its first chip mount together). */
  recent(now: number, within = 3000): boolean {
    return now - this.last <= within;
  }
}
