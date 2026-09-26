/**
 * A text box that grows with its text up to a cap and is resized by a drag
 * on its edge (nightshift backlog 226, 2026-09-26) — the main composer's
 * behaviour (backlogs 039, 111), pulled out of `Composer.svelte` so the
 * aside boxes use the same code rather than a second copy. The composer
 * keeps its own policy (the 40% line, a per-chat floor, the cap a drag may
 * lower); what is shared is the arithmetic of one grow step, the pointer
 * drag, and the handle (`ResizeHandle.svelte`).
 */

/** One grow step: the height the text asks for, no less than `floor` and
 *  no more than `cap` (a cap under the floor reads as the floor). Pure. */
export function growHeight(need: number, floor: number, cap: number): number {
  return Math.max(floor, Math.min(need, Math.max(cap, floor)));
}

/** The box's height for `lines` lines of text: the lines plus the box's
 *  own padding and border (`chrome`), for a border-box textarea. Pure. */
export function linesHeight(lineHeight: number, lines: number, chrome: number): number {
  return Math.ceil(lineHeight * lines + chrome);
}

/** Whether the text overflows the box at `height` — the only time a
 *  scroll bar may show (backlog 226: none on an empty or short box). A
 *  pixel of rounding is not overflow. Pure. */
export function overflows(need: number, height: number): boolean {
  return need > height + 1;
}

/**
 * Follow a drag on a resize handle: `onMove` gets the box's new height —
 * the height it had when the drag began plus the pointer's travel, up for
 * a handle on the box's top edge (`edge: "top"`, the composer's), down for
 * one on its bottom edge — and `onEnd` runs once on release or cancel, the
 * place to save. The pointer is captured by the handle.
 */
export function dragHeight(
  e: PointerEvent,
  startHeight: number,
  edge: "top" | "bottom",
  onMove: (height: number) => void,
  onEnd: () => void,
): void {
  const startY = e.clientY;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const sign = edge === "top" ? -1 : 1;
  const move = (ev: PointerEvent) => onMove(startHeight + sign * (ev.clientY - startY));
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

/** A height kept per machine under `key` (the composer keeps its floor per
 *  chat the same way); null when unset, unreadable or under `min`. */
export function loadBoxHeight(key: string, min: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= min ? n : null;
  } catch {
    return null;
  }
}

export function saveBoxHeight(key: string, n: number | null): void {
  try {
    if (n === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(n)));
  } catch {
    // best-effort
  }
}
