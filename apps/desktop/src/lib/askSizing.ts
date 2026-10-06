// How tall an interruption card on the Claude Code engine may be
// (nightshift backlog 084 pass 2; the question card changed by backlog 314).
//
// - The question card sizes to its content up to `QUESTION_CAP` of the
//   window, then the whole card scrolls as one — no inner scroll box, and no
//   dragged height. Before 314 it was capped at a third of the transcript
//   (~200 px in a 780-px window) with only its question area giving way, so
//   a two-line question showed one line and no options ("i cant even read the
//   question").
// - The plan card keeps pass 2's rule: two thirds of the transcript, or the
//   height he dragged, with its body scrolling inside.
// - The permission prompt has no cap and no drag.

export type AskKind = "question" | "plan" | "call";

/** The question card's cap, as a share of the window's height. */
export const QUESTION_CAP = 0.6;
/** The plan card's cap, as a share of the transcript viewport. */
export const PLAN_CAP = 2 / 3;
/** The least a cap or a dragged height may be. */
export const MIN_HEIGHT = 160;

export interface CardBox {
  /** A fixed height (a dragged plan card), or null. */
  height: number | null;
  /** The cap, or null for none. */
  maxHeight: number | null;
  /** Whether the card itself scrolls (true) or a body inside it (false). */
  scrollsWhole: boolean;
  /** Whether the card offers the drag edge and keeps a dragged height. */
  draggable: boolean;
}

/**
 * The card's box. `viewportH` is the transcript's scroll region and
 * `windowH` the window, both in CSS px (0 = not measured yet: no cap).
 */
export function cardBox(
  kind: AskKind,
  folded: boolean,
  dragged: number | null,
  viewportH: number,
  windowH: number,
): CardBox {
  if (kind === "call") return { height: null, maxHeight: null, scrollsWhole: false, draggable: false };
  if (kind === "question") {
    if (folded || windowH <= 0) return { height: null, maxHeight: null, scrollsWhole: true, draggable: false };
    let cap = Math.round(windowH * QUESTION_CAP);
    // Never taller than the transcript it sits in, so its foot (the
    // buttons) can always be scrolled to; never squeezed below the floor.
    if (viewportH > 0) cap = Math.min(cap, viewportH - 24);
    return { height: null, maxHeight: Math.max(MIN_HEIGHT, cap), scrollsWhole: true, draggable: false };
  }
  if (folded) return { height: null, maxHeight: null, scrollsWhole: false, draggable: true };
  if (dragged !== null) return { height: dragged, maxHeight: null, scrollsWhole: false, draggable: true };
  const maxHeight = viewportH > 0 ? Math.round(viewportH * PLAN_CAP) : null;
  return { height: null, maxHeight, scrollsWhole: false, draggable: true };
}
