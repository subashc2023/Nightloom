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
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { addToast } from "./state.svelte";

/** Chrome's presets, ascending; 1 is Actual Size. */
export const ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
] as const;
export const ZOOM_KEY = "nightloom.zoom";

/** The stored factor read back, or 1 when absent, malformed or off the scale. */
export function parseZoom(raw: string | null): number {
  if (raw == null) return 1;
  const f = Number(raw);
  return (ZOOM_STEPS as readonly number[]).includes(f) ? f : 1;
}

export function loadZoom(): number {
  try {
    return parseZoom(localStorage.getItem(ZOOM_KEY));
  } catch {
    return 1;
  }
}

export function saveZoom(f: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(f));
  } catch {
    // best-effort
  }
}

/**
 * The next step up or down from `current` — the nearest preset first, so a
 * factor between two steps (never stored, but cheap to be right about)
 * moves to a preset rather than past one. Clamped at the ends.
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

let current = 1;
/** Which path the last apply took — for the report and the checklist. */
let mechanism: "webview" | "css" | null = null;
export function zoomMechanism(): "webview" | "css" | null {
  return mechanism;
}
export function currentZoom(): number {
  return current;
}

/** Scale the window to `f`: the webview's page zoom, else CSS `zoom`. */
async function apply(f: number): Promise<void> {
  current = f;
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
  await apply(next);
  saveZoom(next);
  addToast(zoomLabel(next));
}

/**
 * At start-up: the stored factor back on the window (silently — the toast
 * is for a change), and the View menu's three ids listened for. Anything
 * else on the `menu` channel is `runMenuCommand`'s and ignored here.
 */
export async function initZoom(): Promise<void> {
  const stored = loadZoom();
  if (stored !== 1) await apply(stored);
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
