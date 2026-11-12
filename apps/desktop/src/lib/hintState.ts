// The `?` mark's open rule (item 638, 2026-11-11), kept free of the DOM so a
// node test can drive it. Swaraag: hovering or clicking the Model tab's `?`
// marks "does nothing". Hover opened the tip and the click then toggled it
// shut; now hover and keyboard focus show it while they last, and a click
// pins it open until a second click, Escape or a press elsewhere.

export interface HintState {
  hover: boolean;
  focus: boolean;
  pinned: boolean;
}

export type HintEvent = "enter" | "leave" | "focus" | "blur" | "click" | "escape" | "outside";

export const HINT_CLOSED: HintState = { hover: false, focus: false, pinned: false };

export function hintOpen(s: HintState): boolean {
  return s.hover || s.focus || s.pinned;
}

export function hintStep(s: HintState, e: HintEvent): HintState {
  switch (e) {
    case "enter":
      return { ...s, hover: true };
    case "leave":
      return { ...s, hover: false };
    case "focus":
      return { ...s, focus: true };
    case "blur":
      return { ...s, focus: false, pinned: false };
    case "click":
      // A click on a pinned tip closes it, hover or not; any other click
      // pins it, so the tip a hover opened stays when clicked.
      return s.pinned ? HINT_CLOSED : { ...s, pinned: true };
    case "escape":
    case "outside":
      return HINT_CLOSED;
  }
}
