// A popover that must paint above everything — the top bar's Model · Tasks
// card (nightshift backlog 163, 2026-09-18). The bar is a CSS container
// and so a stacking context at z-index 1; nothing inside it, whatever its
// own z-index, can rise above a later sibling's context — and on the
// Welcome page the composer is a floating card in its own context, so the
// card opened behind it and, positioned against a bar laid out
// differently there, off its chip. The fix is the usual one: the node is
// moved to `document.body` (`portal`) and placed by the chip's rectangle
// in viewport coordinates (`anchorBelow`), clamped inside the window.

/** Svelte action: reparent the node under `document.body` for its life. */
export function portal(node: HTMLElement): { destroy(): void } {
  document.body.appendChild(node);
  return {
    destroy() {
      node.parentNode?.removeChild(node);
    },
  };
}

export interface Rect {
  left: number;
  right: number;
  bottom: number;
}

/** Where a card of `width` goes under an anchor: right-aligned with the
 *  anchor's right edge (the chip sits at the bar's right end), never past
 *  either viewport edge with a `margin`, `gap` px below the anchor. */
export function anchorBelow(
  anchor: Rect,
  width: number,
  viewportWidth: number,
  gap = 4,
  margin = 8,
): { top: number; left: number } {
  let left = anchor.right - width;
  const max = viewportWidth - width - margin;
  if (left > max) left = max;
  if (left < margin) left = margin;
  return { top: anchor.bottom + gap, left };
}
