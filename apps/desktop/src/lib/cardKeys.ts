/**
 * Answering a waiting card from the keyboard (nightshift item 974, from 762's survey: Agentbox answers its
 * inbox rows with number keys).
 *
 * A card that takes keys carries `data-keycard`. While the focus is in it — on its box, a button, a radio,
 * but never in a field he types in — the digits 1–9 and Enter are the card's:
 *
 * - the window's type-to-compose rule (`typeToCompose.ts`, capture phase) leaves them alone (`cardOwnsKey`),
 *   so a digit no longer jumps into the message box and Enter no longer sends the composer's draft;
 * - a question card maps the digit to its option (`keyPick` in `askQuestions.ts`);
 * - a button card (`keyPicks` below: a permission card, a Needs-you row) only *focuses* button n; Enter then
 *   presses it as any focused button. Two deliberate keys: nothing is one stray key from granting a permission.
 *
 * Every other key (letters, Space on text) keeps the type-to-compose behaviour.
 */
import { isEditable, type ElLike } from "./composerCaret";

export const KEYCARD = "[data-keycard]";
const PICK = "[data-pick]";

export interface KeyPickOpts {
  /** Which element's buttons a key reaches: the nearest ancestor of the focus matching this (a Needs-you row). */
  scope?: string;
  /** Which buttons are numbered: default `[data-pick]` (a component that takes no attributes: a class). */
  pick?: string;
}

export interface CardKeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  keyCode?: number;
}

/** A plain 1–9 (no chord, no IME, not held): its 0-based index; else null. */
export function cardDigit(e: CardKeyLike): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.isComposing || e.keyCode === 229 || e.repeat) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  return Number(e.key) - 1;
}

/** Whether this key belongs to the card the focus is in, not to the message box. */
export function cardOwnsKey(e: CardKeyLike, active: ElLike | null | undefined): boolean {
  if (!active || typeof active.closest !== "function") return false;
  if (isEditable(active)) return false;
  if (!active.closest(KEYCARD)) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key === "Enter" || cardDigit(e) !== null;
}

/** The buttons a digit can reach in `node`: in order, matching `pick` (`[data-pick]`), not disabled, not hidden. */
export function pickButtons(node: ParentNode, pick = PICK): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(pick)].filter(
    (b) => !(b as HTMLButtonElement).disabled && !b.closest("[hidden]"),
  );
}

/** Number the reachable buttons (`data-kh`, drawn as a small hint while the card has the focus). */
function numberButtons(card: ParentNode, node: ParentNode, pick = PICK): HTMLElement[] {
  for (const b of card.querySelectorAll<HTMLElement>("[data-kh]")) delete b.dataset.kh;
  const live = pickButtons(node, pick).slice(0, 9);
  live.forEach((b, i) => (b.dataset.kh = String(i + 1)));
  return live;
}

/**
 * Svelte action for a button card: marks it a key card and, on a digit with the focus in it (not in a
 * field), focuses the n-th `[data-pick]` button. `scope`, when given, narrows which buttons a key in a
 * given element reaches (a Needs-you row's own answers, not the whole list's).
 */
export function keyPicks(node: HTMLElement, opts: KeyPickOpts = {}) {
  let { scope, pick } = opts;
  node.setAttribute("data-keycard", "");
  const within = (t: HTMLElement): ParentNode => (scope ? (t.closest<HTMLElement>(scope) ?? node) : node);
  const onFocus = (e: FocusEvent) => numberButtons(node, within(e.target as HTMLElement), pick);
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    // A key the card's own question already took (AskQuestions picks an option with it).
    if (e.defaultPrevented || isEditable(t)) return;
    const n = cardDigit(e);
    if (n === null) return;
    const live = numberButtons(node, within(t), pick);
    const b = live[n];
    if (!b) return;
    e.preventDefault();
    b.focus();
  };
  node.addEventListener("focusin", onFocus);
  node.addEventListener("keydown", onKey);
  return {
    update(next: KeyPickOpts = {}) {
      ({ scope, pick } = next);
    },
    destroy() {
      node.removeEventListener("focusin", onFocus);
      node.removeEventListener("keydown", onKey);
    },
  };
}
