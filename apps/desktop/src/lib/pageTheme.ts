/**
 * The app's colours, for a page drawn inside it (item 770): read from where the page is shown (the Mac's
 * Jarvis and Classic palettes and the phone's all name them the same), handed to the kit libraries'
 * setup (`pageKit.ts`) and written into a reply page as CSS variables (`replyPage.ts`).
 */
import { FALLBACK_THEME, type KitTheme } from "./pageKit";
import type { Scheme } from "./htmlPage";

const LIGHT: Partial<KitTheme> = { ink: "#1b1d21", dim: "#5d6673", line: "#d9dde3", paper: "#ffffff", raised: "#f3f4f6" };

/** The theme at `el` (anywhere under the app's root), or the fallback where there is no document. */
export function readKitTheme(el: Element | null, scheme: Scheme): KitTheme {
  const base: KitTheme = scheme === "light" ? { ...FALLBACK_THEME, ...LIGHT, dark: false } : { ...FALLBACK_THEME };
  if (typeof getComputedStyle === "undefined" || typeof document === "undefined") return base;
  const cs = getComputedStyle(el ?? document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = v("--accent", base.accent);
  const signal = v("--signal", base.signal);
  return {
    dark: scheme !== "light",
    ink: v("--ink", base.ink),
    dim: v("--dim", base.dim),
    line: v("--line", base.line),
    paper: v("--paper", base.paper),
    raised: v("--raised", base.raised),
    accent,
    signal,
    series: [accent, signal, v("--done", "#7cd69a"), v("--failed", "#f07f7f"), "#c9a0ff", v("--partial", "#e8c063"), v("--hot", "#ff7d4f"), v("--dim", base.dim)],
  };
}
