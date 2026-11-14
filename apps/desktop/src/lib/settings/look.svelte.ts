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
  // Item 629: the notes name everything the light changes, and nothing else does.
  { id: "calm", name: "Calm (IV)", note: "No light: nothing glows, no brackets on the message box, no dot ground, the dial's motion softer." },
  { id: "lit", name: "Lit (IV+)", note: "A soft light on live things and Send, brackets on the message box, the dot ground, the dial's motion at full strength." },
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

// ---- Item 629/630 (his "category error", 2026-11-11 1:49 AM): each control
// changes only what its name says. Two choices that used to ride on the
// palette and the light are their own now:
//
// - **New-chat page** (`nightloom.newchat`): "wheel" — the readings on leader
//   lines around the dial, when the pane is wide enough — or "row", the
//   stationary row under it. Was: Calm, or palette B/C/D, meant the row.
//   Stamped `data-newchat="row"` (wheel stamps nothing).
// - **Motion colour** (`nightloom.motionInk`): "live" — the palette's live
//   colour (`--signal`) — or "accent". Was: palette A drew motion in
//   `--signal`, B/C/D in their accent. Stamped `data-motion-ink="accent"`.
//
// And the light no longer depends on the palette: B/C/D under Filament IV
// wore no light whatever Instrument light said; now Lit lights them too.
//
// `migrateLook` runs once (marker `nightloom.lookSplit`) and writes the
// choices that reproduce what the saved palette and light drew, so the
// first launch looks exactly as before (B/C/D + Lit becomes Calm, since it
// showed no light).

export type NewChat = "wheel" | "row";
export type MotionInk = "live" | "accent";

export const NEW_CHATS: { id: NewChat; name: string; note: string }[] = [
  { id: "wheel", name: "Wheel", note: "Engine, folder, memory, model, plan and Nightshift on leader lines around the dial, when the window is wide enough; the row otherwise." },
  { id: "row", name: "Row", note: "The same readings in one stationary row under the dial, at every width." },
];
export const MOTION_INKS: { id: MotionInk; name: string; note: string }[] = [
  { id: "live", name: "Live colour", note: "The palette's colour for live work (Jarvis's cyan, the others' blue)." },
  { id: "accent", name: "Accent", note: "The palette's accent, the colour of what you press." },
];

const NEWCHAT_KEY = "nightloom.newchat";
const MOTION_KEY = "nightloom.motionInk";
const SPLIT_KEY = "nightloom.lookSplit";
const PALETTE_KEY = "nightloom.palette";

export function parseNewChat(v: string | null): NewChat {
  return v === "row" ? "row" : "wheel";
}
export function parseMotionInk(v: string | null): MotionInk {
  return v === "accent" ? "accent" : "live";
}

/** The storage `migrateLook` needs: localStorage, or a map in a test. */
export type LookStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/**
 * Once: write the new-chat layout, the motion colour and the light that
 * reproduce what the saved palette and light drew before item 629.
 * A palette other than A ("B" | "C" | "D") meant the row, motion in the
 * accent, and no light. Returns true when it ran.
 */
export function migrateLook(s: LookStore): boolean {
  if (s.getItem(SPLIT_KEY) !== null) return false;
  const p = s.getItem(PALETTE_KEY);
  const classicPalette = p === "B" || p === "C" || p === "D";
  const calm = s.getItem(LIGHT_KEY) === "calm";
  if (s.getItem(NEWCHAT_KEY) === null && (calm || classicPalette)) s.setItem(NEWCHAT_KEY, "row");
  if (s.getItem(MOTION_KEY) === null && classicPalette) s.setItem(MOTION_KEY, "accent");
  if (classicPalette && !calm) s.setItem(LIGHT_KEY, "calm");
  s.setItem(SPLIT_KEY, "1");
  return true;
}

try {
  migrateLook(localStorage);
} catch {
  // No storage (a harness, a private window): the defaults stand.
}

export const look = $state<{ accent: Accent; light: Light; newChat: NewChat; motionInk: MotionInk }>({
  accent: parseAccent(read(ACCENT_KEY)),
  light: parseLight(read(LIGHT_KEY)),
  newChat: parseNewChat(read(NEWCHAT_KEY)),
  motionInk: parseMotionInk(read(MOTION_KEY)),
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
  if (look.newChat === "row") root.dataset.newchat = "row";
  else delete root.dataset.newchat;
  if (look.motionInk === "accent") root.dataset.motionInk = "accent";
  else delete root.dataset.motionInk;
}

export function setNewChat(v: NewChat): void {
  look.newChat = v;
  write(NEWCHAT_KEY, v === "row" ? "row" : null);
  applyLook();
}

export function setMotionInk(v: MotionInk): void {
  look.motionInk = v;
  write(MOTION_KEY, v === "accent" ? "accent" : null);
  applyLook();
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
