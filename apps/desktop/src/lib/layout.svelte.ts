/**
 * The layout (item 542): Filament IV, the default since item 525, or Classic
 * — every surface as it was at 1d4ca17, the commit before 525, kept as a
 * fallback "so a Filament IV bug never blocks his work" (his words,
 * 2026-11-09; blocker 1734: Filament IV default, Classic the backup).
 *
 * Settings → Appearance → Layout. Applied at once, no relaunch, remembered
 * in localStorage beside the palette (`nightloom.palette`). Classic stamps
 * `data-layout="classic"` on <html>: app.css's classic block and each
 * restyled component's `:global([data-layout="classic"])` rules read it,
 * and the parents of the restyled components mount their `…Classic.svelte`
 * copies (1d4ca17's files, kept verbatim) while it is on. Under Classic the
 * palette "A" is 1d4ca17's A, charcoal & amber (`data-palette="classic-A"`,
 * `applyPalette` in state.svelte.ts).
 */
import { app, applyPalette } from "./state.svelte";

export type Layout = "filament" | "classic";
export const LAYOUTS: { id: Layout; name: string; note: string }[] = [
  { id: "filament", name: "Jarvis", note: "The new look: lit controls, the right column, the dated chat list." },
  { id: "classic", name: "Classic", note: "The look before Jarvis, every screen as it was, with its palettes." },
];
// Its own key: `nightloom.layout` is the window's sizes (`state.svelte.ts`),
// and sharing it meant picking Classic wiped his sidebar and pane sizes and
// the next divider drag turned Classic off again (item 568). The old key's
// bare "classic" is read once and moved here.
const LAYOUT_KEY = "nightloom.look";
const SHARED_KEY = "nightloom.layout";

function loadLayout(): Layout {
  try {
    const mine = localStorage.getItem(LAYOUT_KEY);
    if (mine !== null) return mine === "classic" ? "classic" : "filament";
    if (localStorage.getItem(SHARED_KEY) === "classic") {
      localStorage.setItem(LAYOUT_KEY, "classic");
      localStorage.removeItem(SHARED_KEY);
      return "classic";
    }
  } catch {
    // No storage (a harness, a private window): the default stands.
  }
  return "filament";
}

export const layout = $state<{ value: Layout }>({ value: loadLayout() });

/** True while Classic is on: what a parent reads to pick a component. */
export function classic(): boolean {
  return layout.value === "classic";
}

/** Stamp the layout on the document, and the palette again (A reads as
 *  Classic A under Classic). Safe where there is no document. */
export function applyLayout(l: Layout = layout.value): void {
  if (typeof document === "undefined") return;
  if (l === "classic") document.documentElement.dataset.layout = "classic";
  else delete document.documentElement.dataset.layout;
  applyPalette(app.palette);
}

export function setLayout(l: Layout): void {
  layout.value = l;
  applyLayout(l);
  try {
    localStorage.setItem(LAYOUT_KEY, l);
  } catch {
    // best-effort
  }
}
