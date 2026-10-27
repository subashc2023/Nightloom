/**
 * ⌘Z and ⌘⇧Z in whichever text box has the keyboard walk THAT box's own
 * history (item 421, his words: "if I'm highlighted into that text box,
 * the command Z and stuff should be for that specific text box's edit").
 *
 * Why the plain fields need this: WebKit keeps ONE undo stack for the whole
 * page, not one per field. Measured (421 harness, before): with "alpha
 * beta gamma" typed in a plain field and "one two three" in the message
 * box, ⌘Z in the field emptied the message box; a second ⌘Z emptied the
 * field. So every plain `<input>` / `<textarea>` gets a `BoxHistory` of its
 * own here (the message box and the edit box keep theirs, marked
 * `data-own-undo`), recorded from the page-wide `beforeinput` / `input`
 * events, and the Edit menu's Undo / Redo step it instead of WebKit's
 * shared stack.
 *
 * A CodeMirror editor (the formatted message box, item 276; the note
 * editor) has its own history: the menu's Undo runs CodeMirror's `undo`
 * on it. Before, the menu ran `execCommand("undo")` there, which WebKit
 * answered from its shared stack: one step, then nothing (measured: 30
 * words typed, one ⌘Z, the box left at 26 of them).
 */
import { redo as cmRedo, undo as cmUndo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { BoxHistory, editKind, historyInput, type Snap } from "./boxHistory";

/** Set on a text box that keeps its own history (the message box, the edit box). */
export const OWN_UNDO = "data-own-undo";

/** `<input>` types whose text and selection the history can read and set.
 *  Not `password` (no history of a secret kept in memory), not `email` or
 *  `number` (no selection API in WebKit). */
const TEXT_TYPES = new Set(["text", "search", "url", "tel"]);

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The plain text field `el` is, or null: an enabled, editable `<textarea>`
 *  or text `<input>` without a history of its own. */
export function plainField(el: EventTarget | Element | null): Field | null {
  if (typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return null;
  if (el.hasAttribute(OWN_UNDO)) return null;
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) return el.readOnly || el.disabled ? null : el;
  return null;
}

const histories = new WeakMap<Field, BoxHistory>();
/** An undo or redo is being put in a field: its own `input` is not an edit. */
let applying = false;

function snap(f: Field): Snap {
  const n = f.value.length;
  return { text: f.value, start: f.selectionStart ?? n, end: f.selectionEnd ?? n };
}

/** The field's history, caught up with a text the page set since (a
 *  rename field filled with the old name, a Svelte binding): that is a
 *  step of its own, as in the message box. */
function historyOf(f: Field): BoxHistory {
  let h = histories.get(f);
  if (!h) {
    h = new BoxHistory(f.value);
    histories.set(f, h);
  } else if (h.current.text !== f.value) h.external(f.value);
  return h;
}

/**
 * One undo or redo in the focused text box, when it is one this module
 * answers for: a CodeMirror editor or a plain field. False otherwise (the
 * message box and edit box answer through their own menu interceptors
 * first; anything else is left to the caller).
 */
export function stepFocusedField(dir: "undo" | "redo"): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  const cm = el instanceof HTMLElement ? el.closest<HTMLElement>(".cm-editor") : null;
  if (cm) {
    const view = EditorView.findFromDOM(cm);
    if (view) {
      (dir === "undo" ? cmUndo : cmRedo)(view);
      return true;
    }
  }
  const f = plainField(el);
  if (!f) return false;
  const h = histories.get(f);
  // Nothing typed here yet: nothing to undo, and never another box's step.
  if (!h) return true;
  if (h.current.text !== f.value) h.external(f.value);
  const s = dir === "undo" ? h.undo() : h.redo();
  if (!s) return true;
  applying = true;
  try {
    f.value = s.text;
    f.setSelectionRange(s.start, s.end);
    // Bindings (`bind:value`) and the field's own handlers see the change.
    f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: dir === "undo" ? "historyUndo" : "historyRedo" }));
  } finally {
    applying = false;
  }
  return true;
}

let stepped = false;

function onBeforeInput(e: InputEvent): void {
  const h = historyInput(e.inputType);
  if (h) {
    // WebKit's own undo (the context menu's): its stack is the page's, so
    // it may name another box. With a plain field focused, the field's
    // own history answers, once per native command.
    const f = plainField(document.activeElement);
    if (!f) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (stepped) return;
    stepped = true;
    queueMicrotask(() => (stepped = false));
    stepFocusedField(h);
    return;
  }
  if (applying) return;
  const f = plainField(e.target);
  if (f) historyOf(f).before(snap(f));
}

function onInput(e: Event): void {
  if (applying) return;
  const f = plainField(e.target);
  if (!f) return;
  const h = histories.get(f);
  if (!h) {
    // No `beforeinput` seen (a script's synthetic input): start from here.
    histories.set(f, new BoxHistory(f.value));
    return;
  }
  h.input(editKind((e as InputEvent).inputType ?? ""), snap(f));
}

/** A caret move ends a run of typing, as in the message box. */
function onCaret(e: Event): void {
  const f = plainField(e.target);
  const h = f ? histories.get(f) : undefined;
  if (f && h && h.current.text === f.value) h.select(f.selectionStart ?? 0, f.selectionEnd ?? 0);
}

function onCompositionEnd(e: Event): void {
  const f = plainField(e.target);
  if (f) histories.get(f)?.close();
}

/** Listen on the whole page, in the capture phase (main.ts, once). */
export function installFieldUndo(target: Window = window): () => void {
  const opts = { capture: true };
  target.addEventListener("beforeinput", onBeforeInput, opts);
  target.addEventListener("input", onInput, opts);
  target.addEventListener("keyup", onCaret, opts);
  target.addEventListener("mouseup", onCaret, opts);
  target.addEventListener("compositionend", onCompositionEnd, opts);
  return () => {
    target.removeEventListener("beforeinput", onBeforeInput, opts);
    target.removeEventListener("input", onInput, opts);
    target.removeEventListener("keyup", onCaret, opts);
    target.removeEventListener("mouseup", onCaret, opts);
    target.removeEventListener("compositionend", onCompositionEnd, opts);
  };
}
