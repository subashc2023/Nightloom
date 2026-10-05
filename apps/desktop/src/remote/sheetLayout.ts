/**
 * The phone page's bottom sheets (item 300, fix wave 8B, F4): their header
 * text and how they fit the part of the screen the phone actually shows.
 */

/** "1 message", "2 messages" (A11). `n` is his messages in the chat. */
export function messagesLabel(n: number): string {
  return `${n} message${n === 1 ? "" : "s"}`;
}

/** The chat sheet's subtitle: project · message count · when (A11). */
export function chatSheetSub(project: string, turns: number | null, when: string | null): string {
  return turns === null ? project : `${project} · ${messagesLabel(turns)}${when ? ` · ${when}` : ""}`;
}

/** Where a bottom sheet sits once the keyboard (or Safari's bars) shrink
 *  the visible part of the page (A22). iOS Safari keeps `position: fixed;
 *  bottom: 0` on the layout viewport, which the keyboard covers, so the
 *  sheet is lifted by the hidden strip and capped at the visible height. */
export interface SheetFit {
  /** px to lift the sheet's bottom edge off the layout viewport's. */
  lift: number;
  /** The visible height in px: the sheet's cap before its own margins. */
  visible: number;
  /** The keyboard is up (the visible part is much shorter than the page). */
  keyboard: boolean;
}

/** `layout` is `innerHeight`; `vvHeight`/`vvTop` the visual viewport's
 *  height and offsetTop. A gap under 120px is Safari's bars, not a keyboard. */
export function sheetFit(layout: number, vvHeight: number, vvTop: number): SheetFit {
  const visible = Math.max(0, Math.round(vvHeight));
  const lift = Math.max(0, Math.round(layout - vvHeight - vvTop));
  return { lift, visible, keyboard: layout - vvHeight > 120 };
}

/** Room kept under a sheet's last row while the keyboard is up: Safari's
 *  floating URL pill sits there (A22, `inferred` from the audit shot). */
export const KEYBOARD_PILL = 52;

/** A Svelte action: keep `--sheet-lift`, `--sheet-vh` and `--sheet-kb`
 *  (the pill's room, 0 without a keyboard) on the sheet in step with the
 *  visual viewport. */
export function fitVisual(node: HTMLElement) {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return {};
  const apply = () => {
    const f = sheetFit(window.innerHeight, vv.height, vv.offsetTop);
    node.style.setProperty("--sheet-lift", `${f.lift}px`);
    node.style.setProperty("--sheet-vh", `${f.visible}px`);
    node.style.setProperty("--sheet-kb", `${f.keyboard ? KEYBOARD_PILL : 0}px`);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return {
    destroy() {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    },
  };
}
