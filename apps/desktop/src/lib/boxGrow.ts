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

/**
 * Measure what a box's text asks for without moving anything around it
 * (nightshift item 469, 2026-10-29). The measure sets the box's height to
 * `auto` and reads its `scrollHeight`; for that moment the box is one line
 * tall, and a layout forced by the read shrinks everything it sits in. The
 * composer under the transcript gave the transcript that room: a chat at
 * its foot had its scroll clamped up by the box's height less a line (294
 * px in the harness for a full box) and stayed there, so every key typed
 * or deleted in a full box "slightly scrolled the chat up". `hold` (the
 * composer's outer element) keeps its height through the measure, so the
 * collapse stays inside it. The box's own scroll is put back too: the
 * one-line moment clamps it, and a caret on an empty last line was left
 * a line below the box's edge (23 px in the harness). `apply` gives the
 * height the box ends at. Returns the height the text asked for.
 */
export function measureHeld(
  box: { readonly style: { height: string }; readonly scrollHeight: number; scrollTop: number },
  hold: { readonly style: { height: string }; readonly offsetHeight: number } | null,
  apply: (need: number) => string,
): number {
  const held = hold ? hold.style.height : "";
  const top = box.scrollTop;
  if (hold) hold.style.height = `${hold.offsetHeight}px`;
  box.style.height = "auto";
  const need = box.scrollHeight;
  box.style.height = apply(need);
  if (hold) hold.style.height = held;
  if (box.scrollTop !== top) box.scrollTop = top;
  return need;
}

/** A collapsed caret after the last character (item 469): the box's foot
 *  is where he is typing. Pure. */
export function caretAtEnd(start: number, end: number, length: number): boolean {
  return start === end && end === length;
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

/**
 * The most a box may take inside a card that has a height limit, so what
 * sits under it — the aside card's Ask aside and Cancel — always shows
 * (nightshift backlog 233, 2026-09-26: the box grew to four lines, or to
 * a dragged height, and pushed the buttons out of a card held at its
 * `max-height`). `limit` is the card's most height; `frame` what the card
 * spends outside its scrolling body (the head row, the borders); `above`
 * what in the body must stay above the box (its top padding — earlier
 * answers may scroll away and are not counted); `below` everything under
 * the box to the body's end (the gap, the button row, the bottom
 * padding). Never under `min`, one line of the box: past that the body
 * scrolls, as it did before. Pure.
 */
export function roomForBox(limit: number, frame: number, above: number, below: number, min: number): number {
  return Math.max(min, Math.floor(limit - frame - above - below));
}
