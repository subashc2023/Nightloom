/**
 * Item 618b (his pick, blocker 1845, 2026-11-11): the look of the rest of
 * the composer's row under Filament IV — Attach, the model and effort
 * pickers, Ask aside and Council's frames, the bottom row's switches and
 * cache chip, and the box itself. Settings → Appearance → Composer row.
 *
 * - Glass rail (the default): Rail made slightly glassier.
 * - Glass: smoked glass, every control a glass capsule.
 * - Rail: every control a dark bulb like Send, a filament underline.
 * - Strip: the controls fused into segmented strips.
 *
 * Remembered in localStorage (none stored for the default). Composer stamps
 * the choice on its own root as `data-composer-row` (as AssistantMessage
 * stamps 610's `data-motion`), so a Settings preview can carry its own
 * choice; the rules are in `src/composerRow.css`, all behind
 * `html:not([data-layout="classic"])`, so Classic is untouched.
 */
export type ComposerRow = "glass-rail" | "glass" | "rail" | "strip";

export const COMPOSER_ROWS: { id: ComposerRow; name: string; note: string }[] = [
  { id: "glass-rail", name: "Glass rail", note: "The default. Rail's dark bulbs and lit underline, on a smoked-glass box with a lit top edge." },
  { id: "glass", name: "Glass", note: "Smoked glass; every control a glass capsule that warms amber on hover." },
  { id: "rail", name: "Rail", note: "Every control a dark bulb like Send; a filament underline lights on hover." },
  { id: "strip", name: "Strip", note: "The controls fused into segmented strips, one console. Breaks up when the row folds." },
];

const KEY = "nightloom.composerRow";

/** A stored value read back; anything unknown is the default. */
export function parseComposerRow(v: string | null): ComposerRow {
  return v === "glass" || v === "rail" || v === "strip" ? v : "glass-rail";
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const composerRow = $state<{ value: ComposerRow }>({ value: parseComposerRow(read()) });

export function setComposerRow(r: ComposerRow): void {
  composerRow.value = r;
  try {
    if (r === "glass-rail") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, r);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
}
