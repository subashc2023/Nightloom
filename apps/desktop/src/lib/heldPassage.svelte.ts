/*
 * The message box's held passage (item 694).
 *
 * He highlights a passage in a reply — the selection pill shows — then
 * clicks into the message box (or types, and the box takes the keys) to
 * write his question, and clicks the box's Ask aside. Before this the
 * pill went the moment the selection left the transcript, and the box's
 * Ask aside asked with no passage at all: the aside was about nothing he
 * had highlighted (his report, 2026-11-15).
 *
 * Now the transcript, when a qualifying selection gives way because the
 * focus went into that chat's box, holds it here: the quote and its
 * anchor (where the card opens), keyed by the box's draft key. The box
 * shows it as a chip ("About: “…”", × drops it) and its Ask aside asks
 * about it, anchored, as the pill's Ask aside would; then it is gone.
 * Send, a new selection, ×, Escape in an empty box, a chat switch and the
 * chat's turn starting drop it too. One at a time; never another chat's.
 *
 * The transcript → composer channel follows `replyQuote.svelte.ts`'s
 * `replyRequest` (the pill's Reply): shared `$state`, the composer reads.
 */
import type { AsideQuote } from "./asideQuote";
import type { AsideAnchor } from "./asideCard";

export interface HeldPassage {
  /** The box it is for: the chat's draft key (`draftKey`). */
  key: string;
  quote: AsideQuote;
  anchor: AsideAnchor | null;
}

export const heldPassage = $state<{ value: HeldPassage | null }>({ value: null });

/** Hold a passage for the box `key`; replaces whatever was held. */
export function holdPassage(key: string, quote: AsideQuote, anchor: AsideAnchor | null): void {
  heldPassage.value = { key, quote: { ...quote }, anchor: anchor ? { ...anchor } : null };
}

/** The passage held for `key`, or null (another box's is not this one's). */
export function heldFor(key: string | null | undefined): HeldPassage | null {
  const h = heldPassage.value;
  return h && key != null && h.key === key ? h : null;
}

/** Drop the held passage — only `key`'s when a key is given. */
export function dropHeld(key?: string | null): void {
  const h = heldPassage.value;
  if (!h) return;
  if (key !== undefined && h.key !== key) return;
  heldPassage.value = null;
}

/** The held passage for `key`, once: taken out as it is returned. */
export function takeHeld(key: string): HeldPassage | null {
  const h = heldFor(key);
  if (h) heldPassage.value = null;
  return h;
}

/** The chip's words: the passage's first ~60 characters on one line. */
export const HELD_CHARS = 60;
export function heldLabel(q: AsideQuote, max = HELD_CHARS): string {
  const one = q.text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
}

/** What `askAside` takes from the box (its quote and the anchor ridden in
 *  `AsideAsk`), the box's held passage taken out as it is read: with one,
 *  the aside is about it, as the pill's Ask aside; without, as before. */
export function boxAsideArgs(key: string): { quote: AsideQuote | null; anchor: AsideAnchor | null } {
  const h = takeHeld(key);
  return h ? { quote: h.quote, anchor: h.anchor } : { quote: null, anchor: null };
}

/**
 * Whether a selection that just gave way did so into the chat's message
 * box: the focused element is inside the main composer's (`data-drop-box=
 * "main"`) box, `.ta-wrap` — the plain textarea, the formatted box
 * (`LiveBox`, a contenteditable) or a table cell of the grid box; not
 * the hand-off card's wrap-up text, which lives in the composer too.
 */
export function focusIsMainBox(active: Element | null): boolean {
  if (!active) return false;
  return active.closest('[data-drop-box="main"] .ta-wrap') !== null;
}
