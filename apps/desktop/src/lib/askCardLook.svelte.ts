/**
 * Item 884b (his words, 2026-11-20: "jus make both of htem options in settings"; "you can have this one be
 * the default and that one be the alternative choice"): the question cards' two Jarvis looks, Settings →
 * Appearance → Question cards.
 *
 * - Rows (the default; option B, Console rows): a number key, the answer, hairline rules.
 * - Buttons (option A, Control row): the composer's buttons side by side, all stacked full width once any
 *   answer passes 40 characters (`askStacks`, askSettled.ts).
 *
 * It covers every question card: the reply's `<ask>` box (src/askLook.css), the live turn-end card
 * (TurnAsk.svelte) and the closed AskUserQuestion card (AskAnswered.svelte). Buttons stamps
 * `data-askcard="buttons"` on <html>; Rows stamps nothing. Applied at once, no relaunch; remembered in
 * localStorage (none stored for the default). Classic is untouched: every rule is Jarvis-only.
 */
export type AskCardLook = "rows" | "buttons";

export const ASK_CARD_LOOKS: { id: AskCardLook; name: string; note: string }[] = [
  { id: "rows", name: "Rows", note: "The default. One answer per row with its number key; pick one, then Send ↵." },
  { id: "buttons", name: "Buttons", note: "Answers as buttons side by side, a click sends; any long answer stacks them all." },
];

const KEY = "nightloom.askCard";

/** A stored value read back; anything unknown is the default. */
export function parseAskCardLook(v: string | null): AskCardLook {
  return v === "buttons" ? "buttons" : "rows";
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const askCardLook = $state<{ value: AskCardLook }>({ value: parseAskCardLook(read()) });

/** Stamp the look on <html>. Safe where there is no document. */
export function applyAskCardLook(v: AskCardLook = askCardLook.value): void {
  if (typeof document === "undefined") return;
  if (v === "buttons") document.documentElement.dataset.askcard = "buttons";
  else delete document.documentElement.dataset.askcard;
}

export function setAskCardLook(v: AskCardLook): void {
  askCardLook.value = v;
  applyAskCardLook(v);
  try {
    if (v === "rows") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
}

applyAskCardLook();
