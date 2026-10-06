/**
 * Typing anywhere in a chat goes into the message box (nightshift backlog
 * 316, 2026-10-05 — his "if I'm within the chat but … the box at the bottom
 * is not actively selected … if I start typing it should automatically
 * start typing in the messages box. That's how Claude works").
 *
 * A keydown with the focus outside the box — after a click on transcript
 * text, on a button, on nothing — that would type one character moves the
 * focus into the open chat's box, the caret at the **end** of the draft,
 * *during* the keydown and without `preventDefault`: the browser then
 * delivers the character to the newly focused box, so it lands as if typed
 * there (undo, the composer's input handlers and the draft store all see
 * an ordinary keystroke). Everything else is left alone:
 *
 * - any ⌘ or ⌃ chord (⌘C on a transcript selection copies, as before);
 * - a key that types nothing — Escape, Tab, the arrows, Enter, Backspace,
 *   F-keys, a dead key starting an accent — and a key held down (its
 *   first press already moved the focus, the repeats follow it);
 * - an IME composing (the composition stays where it started);
 * - the focus in anything he types in (search, the find bar, a note, a
 *   rename, the question card's Other field, the terminal, an aside's box);
 * - the focus outside the chat's pane (the sidebar, the other pane), or in
 *   a floating aside card (its own box is the one he means);
 * - a modal, menu, popover, scrim, the palette or the find bar open;
 * - no chat composer drawn (Settings over it, a note or web tab).
 *
 * Space counts as a character (Claude's box takes it too), except on a
 * focused control — a button, a link, a tab, a checkbox — where Space
 * presses it, as it always has. ⇧ and ⌥ characters count (A, ?, π, é from
 * ⌥e e's second press). The rule is `sendsToComposer`, pure; the DOM side
 * is `focusKindOf`, `chatComposerBox` and `focusBoxAtEnd`, wired by
 * `composerSummon.svelte.ts` while a chat composer is mounted.
 */
import { AUTO_FOCUS_BLOCKERS, CMD_L_BLOCKERS, isEditable, type ElLike } from "./composerCaret";

/** Where the focus is, as the rule reads it. */
export type FocusKind =
  /** Nothing focused (the body): a click on plain text leaves this. */
  | "none"
  /** Non-editable content of the chat's pane (the transcript, its scroll box). */
  | "content"
  /** A button, link, tab or checkbox in the chat's pane: Space is its own. */
  | "control"
  /** Something he types in. */
  | "editable"
  /** Outside the chat's pane, or in a floating aside card. */
  | "elsewhere";

/** The slice of a keydown the rule reads. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  /** 229 while an IME holds the key (WebKit sets it before `isComposing`). */
  keyCode?: number;
}

export interface ComposeContext {
  focus: FocusKind;
  /** A modal, menu, popover, scrim, the palette or the find bar is open. */
  blocked: boolean;
  /** A chat composer's box is drawn and enabled. */
  composer: boolean;
}

/** One character that a keystroke types: `key` is a single code point, not a control character. */
export function isPrintable(key: string): boolean {
  const chars = Array.from(key);
  if (chars.length !== 1) return false;
  const c = chars[0].codePointAt(0) ?? 0;
  return c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0);
}

/** Whether this keydown should move the focus to the chat's box. */
export function sendsToComposer(e: KeyLike, ctx: ComposeContext): boolean {
  if (!ctx.composer || ctx.blocked) return false;
  if (ctx.focus === "editable" || ctx.focus === "elsewhere") return false;
  if (e.metaKey || e.ctrlKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.repeat) return false;
  if (!isPrintable(e.key)) return false;
  if (e.key === " " && ctx.focus === "control") return false;
  return true;
}

/** What a focused element is, for Space. */
export const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "input",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="menuitem"]',
].join(", ");

/** Where the floating aside cards are: their own box is the one meant. */
const ASIDE_SELECTOR = ".aside-card, .composer.aside";

/** The slice of an element `focusKindOf` reads. */
export interface FocusEl extends ElLike {
  matches(selector: string): boolean;
}

/**
 * The focused element's kind. `region` is the chat's pane (the composer's
 * `section.pane`, or the composer's parent when it has none); `isRoot`
 * says the element is the body or the document element.
 */
export function focusKindOf(
  active: FocusEl | null,
  isRoot: boolean,
  region: { contains(el: unknown): boolean } | null,
): FocusKind {
  if (!active || isRoot) return "none";
  if (isEditable(active)) return "editable";
  if (!region || !region.contains(active)) return "elsewhere";
  if (active.closest(ASIDE_SELECTOR)) return "elsewhere";
  if (active.matches(CONTROL_SELECTOR)) return "control";
  return "content";
}

/** What blocks the rule: everything that blocks the composer's own auto-focus, and the palette. */
export const TYPE_BLOCKERS = `${AUTO_FOCUS_BLOCKERS}, ${CMD_L_BLOCKERS}`;

/** The open chat's composer and its box (the textarea, or the formatted editor's content). */
export function chatComposerBox(doc: Document): { root: HTMLElement; box: HTMLElement } | null {
  for (const root of Array.from(doc.querySelectorAll<HTMLElement>(".composer:not(.aside)"))) {
    if (root.closest("[inert]")) continue;
    const box = root.querySelector<HTMLElement>(".ta-wrap textarea, .ta-wrap .cm-content");
    if (!box) continue;
    if (box instanceof HTMLTextAreaElement && box.disabled) continue;
    if (box.getAttribute("contenteditable") === "false") continue;
    return { root, box };
  }
  return null;
}

/** Focus the box with the caret at the end of its text. */
export function focusBoxAtEnd(box: HTMLElement, endOfEditor?: (el: HTMLElement) => boolean): void {
  if (box instanceof HTMLTextAreaElement) {
    box.focus({ preventScroll: true });
    const n = box.value.length;
    box.setSelectionRange(n, n);
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (endOfEditor?.(box)) return;
  box.focus({ preventScroll: true });
}

/**
 * The keydown listener (window, capture phase): decides, moves the focus
 * when the answer is yes, and never stops, prevents or swallows the key.
 */
export function typeToComposeKeydown(e: KeyboardEvent, endOfEditor?: (el: HTMLElement) => boolean): void {
  if (e.defaultPrevented) return;
  // Cheap rejections first: most keys he presses are in the box already.
  if (e.metaKey || e.ctrlKey || e.repeat || !isPrintable(e.key)) return;
  const doc = document;
  const found = chatComposerBox(doc);
  const active = doc.activeElement as (HTMLElement & FocusEl) | null;
  const region = found ? (found.root.closest<HTMLElement>("section.pane") ?? found.root.parentElement) : null;
  const ctx: ComposeContext = {
    composer: found !== null,
    blocked: !!doc.querySelector(TYPE_BLOCKERS),
    focus: focusKindOf(active, active === doc.body || active === doc.documentElement, region),
  };
  if (!found || !sendsToComposer(e, ctx)) return;
  focusBoxAtEnd(found.box, endOfEditor);
}
