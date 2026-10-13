/**
 * ⌘V with nothing to type in goes into the message box (nightshift backlog
 * 351, 2026-10-12 — his "even if textbar is not selected, command v should
 * automatically paste into the textbar").
 *
 * With the focus outside every text field — the transcript after a click
 * on its text, a button, the sidebar, nothing at all — ⌘V (and ⌥⌘V, item
 * 284's paste as an attachment) pastes into the open chat's box exactly as
 * it would with the box focused. Nothing here reads or inserts the
 * clipboard itself: the box takes the focus (its kept caret back, as ⌘L
 * does — blocker 980, his "where i left it"), then the paste is the box's
 * own. Two routes reach it:
 *
 * - **The key.** The window's keydown (capture) sees ⌘V, prevents it — so
 *   Edit ▸ Paste's key equivalent does not fire on the old focus, where
 *   WebKit has nothing to paste into — and asks the chat's composer, which
 *   focuses its box and sends AppKit's `paste:` down the responder chain
 *   (`pasteIntoFocus`, the same call ⌥⌘V makes, Composer.svelte): the box
 *   gets a real paste event and its `onpaste` does what it always does —
 *   images to chips, 348's math, 315's code fence, the long-paste offer,
 *   the clipboard ring. ⌥⌘V asks for the composer's `pasteAsAttachment`.
 * - **The event.** A `paste` event that still reaches the window with the
 *   focus outside a text field (Edit ▸ Paste clicked in the menu, if WebKit
 *   sends one) is handed, during its dispatch while its clipboard is
 *   readable, to the same composer's `onpaste`; plain text, which that
 *   leaves to the browser, the composer then puts in at its caret.
 *
 * Left alone: any focused text field (search, a note, a rename, an aside's
 * box, the message-edit box, the terminal) keeps its own paste; a floating
 * aside card's controls (its own box is the one meant); a modal, menu,
 * popover, the palette or the find bar open; no chat composer drawn; with
 * two panes, the chat not in the focused one (316's `inFocusedPane`); ⌘⇧V
 * (the clipboard history) and a held key's repeats. The rule is
 * `pastesToComposer`, pure; the DOM side is `pasteToComposeKeydown` and
 * `pasteToComposeEvent`, wired by `composerSummon.svelte.ts`.
 */
import { isEditable } from "./composerCaret";
import { isPasteAsAttachmentKey } from "./pasteAttach";
import { ASIDE_SELECTOR, TYPE_BLOCKERS, chatComposerBox, inFocusedPane, type FocusEl } from "./typeToCompose";

/** Which paste a key asks for. */
export type PasteKind = "plain" | "attach";

/** The slice of a keydown the rule reads. */
export interface PasteKeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

/** ⌘V / ⌥⌘V (Ctrl+V / Ctrl+Alt+V off the Mac), or null for any other key. */
export function pasteChord(e: PasteKeyLike, mac: boolean): PasteKind | null {
  if (e.repeat) return null;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.shiftKey) return null;
  if (e.altKey) return isPasteAsAttachmentKey(e) ? "attach" : null;
  return e.key.toLowerCase() === "v" || e.code === "KeyV" ? "plain" : null;
}

/** Where the focus is, as the paste rule reads it. */
export type PasteFocus =
  /** A text field of any kind: its paste is its own. */
  | "editable"
  /** Inside a floating aside card: its own box is the one meant. */
  | "aside"
  /** Anything else — the body, the transcript, a button, the sidebar. */
  | "outside";

export interface PasteContext {
  focus: PasteFocus;
  /** A modal, menu, popover, scrim, the palette or the find bar is open. */
  blocked: boolean;
  /** A chat composer's box is drawn and enabled, in the focused pane. */
  composer: boolean;
}

/** Whether a paste (by key or event) goes to the chat's box. */
export function pastesToComposer(ctx: PasteContext): boolean {
  return ctx.composer && !ctx.blocked && ctx.focus === "outside";
}

/** The focused element's kind for the rule; `isRoot` says it is the body or the document element. */
export function pasteFocusOf(active: FocusEl | null, isRoot: boolean): PasteFocus {
  if (!active || isRoot) return "outside";
  if (isEditable(active)) return "editable";
  if (active.closest(ASIDE_SELECTOR)) return "aside";
  return "outside";
}

/** What the composer is asked to do: paste by key, or take this paste event. */
export type PasteRequest = { kind: PasteKind } | { event: ClipboardEvent };

/** A chat composer's answer to a paste from outside, registered by its root (`.composer`). */
export type PasteHandler = (req: PasteRequest) => void;

const handlers = new Map<Element, PasteHandler>();

/** A chat composer listening; the returned function is its unmount. */
export function registerPasteHandler(root: Element, h: PasteHandler): () => void {
  handlers.set(root, h);
  return () => {
    if (handlers.get(root) === h) handlers.delete(root);
  };
}

/** The open chat's composer's handler, when the rule says yes. */
function target(): PasteHandler | null {
  if (typeof document === "undefined") return null;
  const doc = document;
  const found = chatComposerBox(doc);
  const active = doc.activeElement as (HTMLElement & FocusEl) | null;
  const ctx: PasteContext = {
    composer: found !== null && inFocusedPane(found.root, doc.querySelector("section.pane.focused")),
    blocked: !!doc.querySelector(TYPE_BLOCKERS),
    focus: pasteFocusOf(active, active === doc.body || active === doc.documentElement),
  };
  if (!found || !pastesToComposer(ctx)) return null;
  return handlers.get(found.root) ?? null;
}

/** The keydown listener (window, capture phase). */
export function pasteToComposeKeydown(e: KeyboardEvent, mac: boolean): void {
  if (e.defaultPrevented) return;
  const kind = pasteChord(e, mac);
  if (!kind) return;
  const h = target();
  if (!h) return;
  e.preventDefault();
  h({ kind });
}

/** The paste listener (window, capture phase): a paste with nothing to paste into. */
export function pasteToComposeEvent(e: ClipboardEvent): void {
  if (e.defaultPrevented) return;
  const h = target();
  if (!h) return;
  h({ event: e });
}
