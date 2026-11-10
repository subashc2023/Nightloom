/**
 * Filament IV's two look choices in Settings → Appearance (item 571, stage 7;
 * 521 report §2, `f4-settings-appearance.png`):
 *
 * - **Accent**: amber (the default), weld or madder. app.css already holds
 *   the two variants as `[data-accent="weld" | "madder"]`; this stamps the
 *   attribute. Under the Classic layout no accent is stamped, so a Classic
 *   palette keeps its own accent (item 542: Classic must not change).
 * - **Instrument light**: lit (IV+, the default, blocker 1689) or calm (IV).
 *   main.ts already reads `nightloom.light` before the first paint and
 *   stamps `data-light="calm"`; this is its switch.
 *
 * Remembered in localStorage beside the palette and the layout. Applied at
 * once, no relaunch. `applyLook()` runs when this module is first imported
 * (Settings is imported by App, so before the first paint); main.ts calling
 * it before mount is a patch note for the parent.
 */
import { layout } from "../layout.svelte";

export type Accent = "amber" | "weld" | "madder";
export type Light = "lit" | "calm";

export const ACCENTS: { id: Accent; name: string; note: string; swatch: string }[] = [
  { id: "amber", name: "Amber", note: "The default. Warm; the colour of what you can press.", swatch: "#ffb454" },
  { id: "weld", name: "Weld", note: "Yellow-green; the highest contrast.", swatch: "#dcef4e" },
  { id: "madder", name: "Madder", note: "Orange-red; closest to the error colour.", swatch: "#ff6a3d" },
];

export const LIGHTS: { id: Light; name: string; note: string }[] = [
  { id: "calm", name: "Calm (IV)", note: "Precise and flat. Colour only where something is live or pressable; nothing glows." },
  { id: "lit", name: "Lit (IV+)", note: "The same, plus a soft light on live things, brackets on the message box and the dot ground." },
];

const ACCENT_KEY = "nightloom.accent";
const LIGHT_KEY = "nightloom.light";

/** A stored value read back; anything unknown is the default. */
export function parseAccent(v: string | null): Accent {
  return v === "weld" || v === "madder" ? v : "amber";
}
export function parseLight(v: string | null): Light {
  return v === "calm" ? "calm" : "lit";
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
}

export const look = $state<{ accent: Accent; light: Light }>({
  accent: parseAccent(read(ACCENT_KEY)),
  light: parseLight(read(LIGHT_KEY)),
});

/** The `data-accent` value to stamp, or null for none: amber and Classic stamp none. */
export function accentAttr(accent: Accent, isClassic: boolean): string | null {
  return isClassic || accent === "amber" ? null : accent;
}

/** Stamp the accent and the light on <html>. Safe where there is no document. */
export function applyLook(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const a = accentAttr(look.accent, layout.value === "classic");
  if (a) root.dataset.accent = a;
  else delete root.dataset.accent;
  if (look.light === "calm") root.dataset.light = "calm";
  else delete root.dataset.light;
}

export function setAccent(a: Accent): void {
  look.accent = a;
  write(ACCENT_KEY, a === "amber" ? null : a);
  applyLook();
}

export function setLight(l: Light): void {
  look.light = l;
  write(LIGHT_KEY, l === "calm" ? "calm" : null);
  applyLook();
}

/** Hand-off line choices, in thousands of tokens; 0 is no line (the cap off). */
export const HANDOFF_LINES_K = [0, 150, 200, 250, 300, 400, 500, 750];

/** The choices to offer, with the current value added in order when it is not one of them. */
export function handoffChoices(currentK: number): number[] {
  const s = new Set(HANDOFF_LINES_K);
  if (currentK >= 0) s.add(currentK);
  return [...s].sort((x, y) => x - y);
}

applyLook();
