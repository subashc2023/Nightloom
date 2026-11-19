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
 * - the focus outside the box's pane (the sidebar, the other pane), or in
 *   an aside card that is not the box's; with two panes, the box's pane
 *   not the focused one (`inFocusedPane`);
 * - a modal, menu, popover, scrim, the palette or the find bar open;
 * - no chat composer drawn (Settings over it, a note or web tab).
 *
 * Space counts as a character (Claude's box takes it too), except on a
 * focused control — a button, a link, a tab, a checkbox — where Space
 * presses it, as it always has. ⇧ and ⌥ characters count (A, ?, π, é from
 * ⌥e e's second press). The rule is `sendsToComposer`, pure; the DOM side
 * is `focusKindOf`, `chatComposerBox` and `focusBoxAtEnd`, wired by
 * `composerSummon.svelte.ts` while a chat composer is mounted.
 *
 * **Enter sends the draft from anywhere in the chat (item 387, his ask
 * 2026-10-18: "Clicking enter should also … send the msg that is in a
 * draft … even if the cursor is actively not on the textbox the same way
 * that like typing does").** A plain Enter (no ⇧ ⌥ ⌘ ⌃, not held, no IME)
 * with the focus on nothing or on the chat's transcript, and a draft in the
 * box (text or an attachment), moves the focus to the box and hands it the
 * Enter, so the box's own Enter decides (send, queue during a turn, wait
 * for a pasted image). The same blocks as typing apply, and on a focused
 * control (a button, a link, a tab) Enter stays the control's. The rule is
 * `enterSends`, pure.
 *
 * **Which box (item 853, 2026-11-18, his "Asides dont automatically start
 * typing … the way main chat does").** Every box takes the keys the chat's
 * box takes, as the chat's does — `composerTarget` picks the one meant:
 * an aside card (floating, at the foot, or the side panel's) the focus is
 * in or he last pressed on → its box; else the box in the focused pane —
 * the chat's, or an aside tab's when that tab is in front; else the chat's
 * box anywhere, as before (which `inFocusedPane` then refuses). Typing,
 * Enter, ⌘V from outside (`pasteToCompose.ts`) and ⌘L all ask it.
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
  /** Outside the box's pane, or in an aside card that is not the box's. */
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

/** Whether this keydown is an Enter that should send the box's draft
 *  (item 387). `draft`: the box holds text or an attachment. */
export function enterSends(e: KeyLike, ctx: ComposeContext, draft: boolean): boolean {
  if (e.key !== "Enter" || !draft) return false;
  if (!ctx.composer || ctx.blocked) return false;
  if (ctx.focus !== "none" && ctx.focus !== "content") return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.repeat) return false;
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

/** An aside card — floating, at the composer's foot, or the side panel's.
 *  ~~`.aside-card, .composer.aside`~~ (item 853): an aside tab's box is a
 *  box like the chat's, not "elsewhere"; only a card that is not the box's
 *  own refuses the keys. */
export const ASIDE_SELECTOR = ".aside-card";

/** The slice of an element `focusKindOf` reads. */
export interface FocusEl extends ElLike {
  matches(selector: string): boolean;
}

/**
 * The focused element's kind. `region` is the box's region: the pane (the
 * composer's `section.pane`, or the composer's parent when it has none),
 * or, for an aside card's box, the card itself; `isRoot` says the element
 * is the body or the document element.
 */
export function focusKindOf(
  active: FocusEl | null,
  isRoot: boolean,
  region: { contains(el: unknown): boolean } | null,
): FocusKind {
  if (!active || isRoot) return "none";
  if (isEditable(active)) return "editable";
  if (!region || !region.contains(active)) return "elsewhere";
  // A card inside the region that is not the region (a floating card over
  // the chat's transcript, when the chat's box is the one asked).
  const card = active.closest(ASIDE_SELECTOR);
  if (card && card !== region) return "elsewhere";
  if (active.matches(CONTROL_SELECTOR)) return "control";
  return "content";
}

/**
 * Whether the chat's composer is in the focused pane. With two panes, a
 * click on plain text in the other pane (a note, a project page) focuses
 * that pane but leaves the focus on the body; the keystroke is that pane's,
 * not the chat box's in the pane beside it (316 review). No pane marked
 * focused (none drawn yet) reads as yes.
 */
export function inFocusedPane(
  composer: unknown,
  focusedPane: { contains(el: unknown): boolean } | null,
): boolean {
  if (!focusedPane) return true;
  return focusedPane.contains(composer);
}

/** What blocks the rule: everything that blocks the composer's own auto-focus, and the palette. */
export const TYPE_BLOCKERS = `${AUTO_FOCUS_BLOCKERS}, ${CMD_L_BLOCKERS}`;

/** Which kind of box: the chat's, an aside tab's, or an aside card's. */
export type BoxKind = "chat" | "tab" | "card";

/** A box that could take the keys, as `pickTarget` reads it. */
export interface Candidate<R = unknown, B = unknown, C = unknown> {
  root: R;
  box: B;
  kind: BoxKind;
  /** The card it sits in (`kind === "card"`), else null. */
  card: C | null;
  /** In the focused pane (true with no pane marked focused). */
  inPane: boolean;
}

/**
 * The box meant (item 853), pure: a card the focus is in or he last
 * pressed on, when it still draws a box → that box; else the chat's or an
 * aside tab's box in the focused pane; else the chat's box anywhere, then
 * any tab's. `inPane` on the answer says whether the keys may go to it
 * (a card he pressed on always may).
 */
export function pickTarget<R, B, C>(
  cands: Candidate<R, B, C>[],
  focusCard: C | null,
  lastCard: C | null,
): Candidate<R, B, C> | null {
  for (const card of [focusCard, lastCard]) {
    if (card == null) continue;
    const hit = cands.find((c) => c.kind === "card" && c.card === card);
    if (hit) return { ...hit, inPane: true };
  }
  const docked = cands.filter((c) => c.kind !== "card");
  return docked.find((c) => c.inPane) ?? docked.find((c) => c.kind === "chat") ?? docked[0] ?? null;
}

/** The card he last pressed on (a pointerdown anywhere else clears it). */
let pressedCard: Element | null = null;

/** Where he last pressed (item 853, fix 2): the card, else the pane
 *  (`section.pane`), else null (the sidebar, the title bar, the rail). */
let pressedRegion: Element | null = null;

/** A press is under way: the focus it moves (or the ancestor it lands on)
 *  is its own, not a move away from it. */
let pressing = false;

/**
 * Whether the focus was left behind by his last press (item 853, fix 2 —
 * his "typing while in an aside if im not focused on the bar doesnt do
 * shit", and the same in the main chat). A press that WebKit gives no
 * focus — the card's head and grip (their mousedown starts a move and is
 * prevented), a button (never focused on the Mac) — leaves the focus where
 * it was: the chat's transcript, a tab, the other box. The box meant is the
 * pressed region's, so that old focus is stale and reads as nothing
 * focused. Pure: `pressed` the region pressed (null: none, or outside any
 * pane or card), `region` the target box's region (`composerTarget`).
 */
export function isStaleFocus(
  pressed: { contains(el: unknown): boolean } | null,
  region: unknown,
  active: unknown,
  isRoot: boolean,
): boolean {
  if (!pressed || isRoot || !active) return false;
  return pressed === region && !pressed.contains(active);
}

/** The window's pointerdown (capture), wired with the keys. */
export function noteCardPress(e: Event): void {
  const t = e.target as Element | null;
  const ok = !!t && typeof t.closest === "function";
  pressedCard = ok ? t.closest(ASIDE_SELECTOR) : null;
  pressedRegion = ok ? (pressedCard ?? t.closest("section.pane")) : null;
  pressing = true;
  setTimeout(() => (pressing = false), 0);
}

/** The window's focusin (capture): a focus that moves out of the pressed
 *  region by itself — Tab, a field that takes it — ends the press's claim;
 *  the press's own focus move (pressing) and ours into its box do not. */
export function noteFocusMove(e: Event): void {
  if (pressing || !pressedRegion) return;
  const t = e.target as Node | null;
  if (t && pressedRegion.contains(t)) return;
  pressedRegion = null;
  pressedCard = null;
}

/** The pressed region, for `pasteToCompose.ts`. */
export function pressedRegionNow(): Element | null {
  return pressedRegion && pressedRegion.isConnected ? pressedRegion : null;
}

/** The box meant, from the document (item 853; `pickTarget` decides). */
export function composerTarget(doc: Document): (Candidate<HTMLElement, HTMLElement, Element> & { region: HTMLElement | null }) | null {
  const focusedPane = doc.querySelector("section.pane.focused");
  const cands: Candidate<HTMLElement, HTMLElement, Element>[] = [];
  for (const root of Array.from(doc.querySelectorAll<HTMLElement>(".composer"))) {
    if (root.closest("[inert]")) continue;
    const box = root.querySelector<HTMLElement>(".ta-wrap textarea, .ta-wrap .cm-content");
    if (!box) continue;
    if (box instanceof HTMLTextAreaElement && box.disabled) continue;
    if (box.getAttribute("contenteditable") === "false") continue;
    const card = root.closest(ASIDE_SELECTOR);
    const kind: BoxKind = card ? "card" : root.classList.contains("aside") ? "tab" : "chat";
    cands.push({ root, box, kind, card, inPane: inFocusedPane(root, focusedPane) });
  }
  const active = doc.activeElement;
  const focusCard = active && active !== doc.body ? active.closest(ASIDE_SELECTOR) : null;
  const card = pressedCard && pressedCard.isConnected ? pressedCard : null;
  const hit = pickTarget(cands, focusCard, card);
  if (!hit) return null;
  const region = hit.kind === "card" ? (hit.card as HTMLElement) : (hit.root.closest<HTMLElement>("section.pane") ?? hit.root.parentElement);
  return { ...hit, region };
}

/** ~~The open chat's composer and its box~~ — the box meant (item 853),
 *  kept by this name for its callers. */
export function chatComposerBox(doc: Document): { root: HTMLElement; box: HTMLElement } | null {
  const t = composerTarget(doc);
  return t ? { root: t.root, box: t.box } : null;
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
export function typeToComposeKeydown(
  e: KeyboardEvent,
  endOfEditor?: (el: HTMLElement) => boolean,
  boxText?: (el: HTMLElement) => string,
): void {
  if (e.defaultPrevented) return;
  // Cheap rejections first: most keys he presses are in the box already.
  if (e.metaKey || e.ctrlKey || e.repeat) return;
  const enter = e.key === "Enter";
  if (!enter && !isPrintable(e.key)) return;
  const doc = document;
  const found = composerTarget(doc);
  const active = doc.activeElement as (HTMLElement & FocusEl) | null;
  const isRoot = active === doc.body || active === doc.documentElement;
  const ctx: ComposeContext = {
    composer: found !== null && found.inPane,
    blocked: !!doc.querySelector(TYPE_BLOCKERS),
    focus: isStaleFocus(pressedRegionNow(), found?.region ?? null, active, isRoot) ? "none" : focusKindOf(active, isRoot, found?.region ?? null),
  };
  if (!found) return;
  if (enter) {
    const text = boxText?.(found.box) ?? (found.box instanceof HTMLTextAreaElement ? found.box.value : "");
    const draft = text.trim() !== "" || found.root.querySelector(".attachments .attachment") !== null;
    if (!enterSends(e, ctx, draft)) return;
    // Item 387: the Enter is the box's — its own handler sends — and not
    // the transcript's or the window's.
    e.preventDefault();
    e.stopPropagation();
    focusBoxAtEnd(found.box, endOfEditor);
    found.box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return;
  }
  if (!sendsToComposer(e, ctx)) return;
  focusBoxAtEnd(found.box, endOfEditor);
}
