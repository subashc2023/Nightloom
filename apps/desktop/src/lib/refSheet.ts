/*
 * The phone's sheet motion for the typed link's card (nightshift item 993f; the plan's "Phone page" row): the sheet
 * rises from the bottom in 300 ms (its bracket ticks spring out at its top corners, RefCard.svelte) and goes down
 * in 200 ms; the shade behind it fades in 220 ms (RefCardHost.svelte). Under reduced motion it only fades, quickly;
 * Classic does not move, as the Mac's Classic menu card does not (`hudMenu.ts`).
 */
import { cubicOut, cubicIn } from "svelte/easing";

const classic = () => typeof document !== "undefined" && document.documentElement.dataset.layout === "classic";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const SHEET_IN_MS = 300;
export const SHEET_OUT_MS = 200;

export function sheetIn(_node: HTMLElement) {
  if (classic()) return { duration: 0 };
  if (reduced()) return { duration: 120, css: (t: number) => `opacity: ${t}` };
  return { duration: SHEET_IN_MS, easing: cubicOut, css: (t: number) => `transform: translateY(${(1 - t) * 100}%)` };
}

export function sheetOut(_node: HTMLElement) {
  if (classic()) return { duration: 0 };
  if (reduced()) return { duration: 100, css: (t: number) => `opacity: ${t}` };
  return { duration: SHEET_OUT_MS, easing: cubicIn, css: (t: number) => `transform: translateY(${(1 - t) * 100}%)` };
}

/** The shade behind the sheet: 220 ms (none in Classic, a quick one under reduced motion). */
export function shade(_node: HTMLElement) {
  if (classic()) return { duration: 0 };
  return { duration: reduced() ? 100 : 220, css: (t: number) => `opacity: ${t}` };
}
