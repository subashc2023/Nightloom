/**
 * Whole-app zoom (nightshift backlog 108): ⌘+ / ⌘− / ⌘0, the way Chrome
 * and the Claude app do it.
 *
 * The steps are Chrome's. The factor goes to Rust's `set_zoom` — Tauri's
 * `WebviewWindow::set_zoom`, which on macOS is `WKWebView.pageZoom`: every
 * CSS pixel scaled, the transcript's own font setting (backlog 051) left
 * as a separate knob on top. The webview forgets the factor between
 * launches, so it is kept in localStorage like the transcript prefs and
 * re-applied at start-up. Should the command fail (a platform without
 * page zoom), the same factor goes on as CSS `zoom` on the root element,
 * which WebKit and Chromium both honour — the fallback, and the report
 * says which one ran.
 *
 * On macOS the three chords are View-menu items, so they arrive as `menu`
 * events; elsewhere `App.svelte`'s `onShortcut` binds them. ⌘⇧= (the
 * literal ⌘+ on a US layout) is bound in `onShortcut` on every platform,
 * since it is not a menu item and cannot double-fire. The pure parts —
 * the steps, the label, the parse — are what the suite pins.
 *
 * Item 619 (2026-11-11, his words: "make 110% the real 100%"): the ladder
 * is re-based. What the steps, the label and the store hold is the *level*
 * — 1 reads "100%" — and the webview gets level × `ZOOM_BASE`, so today's
 * 100 % draws exactly what 110 % drew before (the same `pageZoom` factor,
 * so every literal px in every component follows, Classic included).
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { addToast } from "./state.svelte";
import { keepPlacesAcross } from "./zoomAnchor";

/** Chrome's presets as labels, ascending; 1 is Actual Size ("100%"). */
export const ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
] as const;
/** The page-zoom factor the label "100%" stands for (item 619). */
export const ZOOM_BASE = 1.1;
/** Before item 619: the real page-zoom factor. Still written (the factor), so an older build opens at the same size. */
export const ZOOM_KEY = "nightloom.zoom";
/** Since item 619: the level (the label ÷ 100). */
export const ZOOM_LEVEL_KEY = "nightloom.zoom.level";

/** The page-zoom factor a level draws at. */
export function zoomFactor(level: number): number {
  return Math.round(level * ZOOM_BASE * 10000) / 10000;
}

const LO = Math.floor((ZOOM_STEPS[0] / ZOOM_BASE) * 10000) / 10000; // an old 50 % migrated (0.4545)
const HI = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * The stored level read back, or 1 when absent, malformed or off the scale.
 * A preset, or a level between the ends — the migration's 91 % (an old 100 %
 * kept where it was) is one; the next ⌘+ / ⌘− moves it onto a preset.
 */
export function parseZoom(raw: string | null): number {
  if (raw == null || raw.trim() === "") return 1;
  const f = Number(raw);
  if (!Number.isFinite(f)) return 1;
  if ((ZOOM_STEPS as readonly number[]).includes(f)) return f;
  return f >= LO && f <= HI ? f : 1;
}

/**
 * Item 619's one-time migration, pure. `level` is the new key, `old` the
 * pre-619 factor, `anyPrefs` whether this install has stored anything else.
 * The level wins once it exists. Else the old factor ÷ 1.1 — 1.1 → 1, 1.25
 * → 1.136 — snapped onto a preset within 0.5 %, so nothing moves on screen.
 * No old factor: an install that has run before sat at the old 100 % and
 * keeps it (≈ 91 %); a fresh one starts at the new 100 %.
 */
export function migrateZoom(
  level: string | null,
  old: string | null,
  anyPrefs: boolean,
): number {
  if (level != null) return parseZoom(level);
  let f: number;
  if (old != null && old.trim() !== "" && Number.isFinite(Number(old)) && Number(old) > 0) f = Number(old);
  else if (anyPrefs) f = 1;
  else return 1;
  const raw = f / ZOOM_BASE;
  for (const s of ZOOM_STEPS) if (Math.abs(s - raw) / s < 0.005) return s;
  return parseZoom(String(Math.round(raw * 10000) / 10000));
}

export function loadZoom(): number {
  try {
    let anyPrefs = false;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("nightloom.") && k !== ZOOM_KEY && k !== ZOOM_LEVEL_KEY) {
        anyPrefs = true;
        break;
      }
    }
    const had = localStorage.getItem(ZOOM_LEVEL_KEY);
    const level = migrateZoom(had, localStorage.getItem(ZOOM_KEY), anyPrefs);
    if (had == null) saveZoom(level); // once: the level from now on
    return level;
  } catch {
    return 1;
  }
}

/** The level, and the factor under the old key for an older build. */
export function saveZoom(level: number): void {
  try {
    localStorage.setItem(ZOOM_LEVEL_KEY, String(level));
    localStorage.setItem(ZOOM_KEY, String(zoomFactor(level)));
  } catch {
    // best-effort
  }
}

/**
 * The next step up or down from `current` — the nearest preset first, so a
 * level between two steps (since item 619 a migrated one can be stored:
 * an old 125 % is 114 %) moves to a preset rather than past one. Clamped
 * at the ends.
 */
export function stepZoom(current: number, dir: 1 | -1): number {
  const steps = ZOOM_STEPS as readonly number[];
  let i = 0;
  for (let k = 1; k < steps.length; k++) {
    if (Math.abs(steps[k] - current) < Math.abs(steps[i] - current)) i = k;
  }
  const next = Math.min(steps.length - 1, Math.max(0, i + dir));
  return steps[next];
}

/** `110%`, `67%` — Chrome's bubble. */
export function zoomLabel(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** The level (the label); the webview runs at `zoomFactor(current)`. */
let current = 1;
/** Which path the last apply took — for the report and the checklist. */
let mechanism: "webview" | "css" | null = null;
export function zoomMechanism(): "webview" | "css" | null {
  return mechanism;
}
/** The page-zoom factor the window runs at (level × 1.1) — what CSS px are scaled by. */
export function currentZoom(): number {
  return zoomFactor(current);
}

/** Scale the window to level `level`: the webview's page zoom, else CSS `zoom`. */
async function apply(level: number): Promise<void> {
  current = level;
  const f = zoomFactor(level);
  try {
    await api.setZoom(f);
    mechanism = "webview";
    // A fallback applied earlier must not stack on the real thing.
    if (typeof document !== "undefined")
      document.documentElement.style.zoom = "";
  } catch {
    mechanism = "css";
    if (typeof document !== "undefined")
      document.documentElement.style.zoom = String(f);
  }
}

/** `zoom_in`, `zoom_out`, `zoom_reset` — the menu ids and the key handler's. */
export async function runZoom(
  id: "zoom_in" | "zoom_out" | "zoom_reset",
): Promise<void> {
  const next =
    id === "zoom_reset" ? 1 : stepZoom(current, id === "zoom_in" ? 1 : -1);
  if (next === current) return;
  // Item 672: every scrolled view keeps the line it was on.
  await keepPlacesAcross(() => apply(next));
  saveZoom(next);
  addToast(zoomLabel(next));
}

/**
 * At start-up: the stored factor back on the window (silently — the toast
 * is for a change), and the View menu's three ids listened for. Anything
 * else on the `menu` channel is `runMenuCommand`'s and ignored here.
 */
export async function initZoom(): Promise<void> {
  // Every level applies now, 100 % too: its factor is 1.1, not the webview's 1.
  await apply(loadZoom());
  await listen<string>("menu", (e) => {
    const id = e.payload;
    if (id === "zoom_in" || id === "zoom_out" || id === "zoom_reset")
      void runZoom(id);
  });
}

/**
 * The key half, for `onShortcut`: the chord's zoom id, or null. `Equal`
 * with or without Shift is in (⌘= and ⌘+ are one key on a US layout),
 * `Minus` out, `Digit0` reset; the numpad's + and − too. On macOS only the
 * shifted `Equal` is taken here — the rest are menu items and would
 * double-fire.
 */
export function zoomChord(
  e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey">,
  primary: boolean,
  mac: boolean,
): "zoom_in" | "zoom_out" | "zoom_reset" | null {
  if (!primary || e.altKey) return null;
  if (e.code === "Equal" && e.shiftKey) return "zoom_in";
  if (mac) return null;
  if (e.code === "Equal" || e.code === "NumpadAdd") return "zoom_in";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "zoom_out";
  if (e.code === "Digit0" && !e.shiftKey) return "zoom_reset";
  return null;
}
