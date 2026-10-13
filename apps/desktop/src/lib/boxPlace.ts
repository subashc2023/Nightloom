/**
 * A text box's place — how far it is scrolled and where its caret is — kept
 * across a chat switch (nightshift backlog 355, 2026-10-13 — his "if i'm
 * like at the bottom of the long message that I'm typing up, and then I
 * switch to another chat and then switch back, it puts me back at the top
 * view of the scroll within that message, even though my cursor is at the
 * latest point … the same for Asides and anything else that fits the same
 * like text box format").
 *
 * The composer (the chat's box and an aside's) keeps its scroll in the
 * drafts store beside its caret (`Draft.scroll`, `Draft.sel`) and puts it
 * back through `ScrollHold`. The message-edit box (a textarea per block in
 * `Transcript.svelte`) keeps both with its stashed edit (`EditStash.boxes`),
 * recorded as he scrolls and moves by `trackPlace` and put back by
 * `putPlace` once the editor is drawn again.
 */

/** A box's scroll and selection. */
export interface BoxPlace {
  scroll: number;
  start: number;
  end: number;
}

/** The slice of a textarea read and written here. */
export interface PlaceBox {
  scrollTop: number;
  selectionStart: number;
  selectionEnd: number;
  readonly value: string;
}

export function placeOf(box: PlaceBox | null | undefined): BoxPlace | null {
  if (!box) return null;
  return { scroll: box.scrollTop, start: box.selectionStart, end: box.selectionEnd };
}

/**
 * Put a kept place back: the selection clamped to the text (never a reason
 * to change the text), then the scroll — after the selection, which may
 * move the scroll itself.
 */
export function putPlace(box: PlaceBox | null | undefined, p: BoxPlace | null | undefined): void {
  if (!box || !p) return;
  const len = box.value.length;
  const s = Math.max(0, Math.min(p.start, len));
  const e = Math.max(s, Math.min(p.end, len));
  if (box.selectionStart !== s || box.selectionEnd !== e) {
    box.selectionStart = s;
    box.selectionEnd = e;
  }
  box.scrollTop = Math.max(0, p.scroll);
}

/**
 * An action for a textarea: report its place as he scrolls, types, clicks
 * and moves the caret. The report goes wherever the owner keeps it (the
 * transcript's per-block list, stashed with the edit).
 */
export function trackPlace(node: HTMLTextAreaElement, report: (p: BoxPlace | null) => void) {
  let cb = report;
  const on = () => cb(placeOf(node));
  const kinds = ["scroll", "input", "keyup", "pointerup", "select", "focus"] as const;
  for (const k of kinds) node.addEventListener(k, on, { passive: true });
  return {
    update(next: (p: BoxPlace | null) => void) {
      cb = next;
    },
    destroy() {
      for (const k of kinds) node.removeEventListener(k, on);
    },
  };
}

/**
 * The composer's hold on a switched-to key's place: from the moment a key
 * arrives until the box has settled (its height measured, the formatted
 * box's layout done), the kept scroll is put back after every re-measure and
 * no scroll event is recorded — the browser's own scrolls in that window
 * (the new text set, the old height) are not his. His own input (a key, a
 * typed or pasted character, the wheel, a press) or `ms` passing ends it;
 * 1.5 s covers a switch whose transcript takes long to draw.
 */
export class ScrollHold {
  private key: string | null = null;
  private until = 0;
  constructor(private readonly ms = 1500) {}

  /** A key arrived at `now`. */
  start(key: string, now: number): void {
    this.key = key;
    this.until = now + this.ms;
  }

  /** He did something in the box: the place is his again. */
  release(): void {
    this.key = null;
  }

  /** Whether `key`'s place is still being put back at `now`. */
  holds(key: string, now: number): boolean {
    if (this.key === null) return false;
    if (now > this.until) {
      this.key = null;
      return false;
    }
    return this.key === key;
  }
}
