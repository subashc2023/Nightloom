/**
 * A tab grows in when it opens and shrinks out when it closes (item 443):
 * its width from nothing to its own (and back), its padding with it, a
 * short fade over the last part. Svelte's transitions are local, so the
 * strip drawn at launch or a pane coming up does not play it — only a tab
 * added to or taken from a strip already on screen. Off under reduced
 * motion (Settings has no animation switch beyond the thinking block's,
 * item 395, so the system setting is the one that applies).
 */
import { cubicOut } from "svelte/easing";
import { reducedMotion } from "./sendMotion";

/** Opening, and closing a little quicker: both inside his 150 ms. */
export const TAB_IN_MS = 140;
export const TAB_OUT_MS = 110;

export interface TabMotion {
  duration: number;
  easing: (t: number) => number;
  css: (t: number) => string;
}

/**
 * The frames, pure (for the tests): at `t` (0 closed, 1 open) the tab is
 * `t` of its width and padding; it shows from a third of the way; at 1
 * it is left to its own rules.
 */
export function tabFrame(t: number, width: number, padL: number, padR: number): string {
  // At rest, nothing: the tab's own rules, so the last frame cannot differ
  // from the tab that stays (no jump when the animation lets go).
  if (t >= 1) return "";
  const o = Math.min(1, Math.max(0, (t - 0.3) / 0.7));
  // The flex basis, not max-width: a max-width equal to the tab's own width
  // still shrank it 8 px in WebKit (measured, item 443), so the last frame
  // jumped. Border-box, so the width measured (padding in) is the one drawn.
  return (
    `box-sizing:border-box;flex:0 0 ${(t * width).toFixed(2)}px;max-width:none;min-width:0;` +
    `padding-left:${(t * padL).toFixed(2)}px;padding-right:${(t * padR).toFixed(2)}px;` +
    `opacity:${o.toFixed(3)};overflow:hidden;`
  );
}

function motion(node: HTMLElement, duration: number, out: boolean): TabMotion {
  if (reducedMotion()) return { duration: 0, easing: cubicOut, css: () => "" };
  const style = getComputedStyle(node);
  const width = node.getBoundingClientRect().width;
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  // A closing tab takes no clicks while it goes: a click meant for the
  // tab sliding in under the pointer lands there instead.
  if (out) node.style.pointerEvents = "none";
  return { duration, easing: cubicOut, css: (t) => tabFrame(t, width, padL, padR) };
}

export function tabIn(node: HTMLElement): TabMotion {
  return motion(node, TAB_IN_MS, false);
}

export function tabOut(node: HTMLElement): TabMotion {
  return motion(node, TAB_OUT_MS, true);
}
