import { EditorView } from "@codemirror/view";
import { pasteToComposeEvent, pasteToComposeKeydown } from "./pasteToCompose";
import { isMac } from "./platform";
import { composerTarget, noteCardPress, typeToComposeKeydown } from "./typeToCompose";

/**
 * ⌘L's ask (nightshift backlog 290): the open chat's composer takes the
 * focus, its kept caret back, else the end of the draft. A counter, like
 * the rewind's `composerFocus`: the composer that is mounted when it
 * moves answers it, and one mounted later does not.
 */
export const composerSummon = $state<{ seq: number }>({ seq: 0 });

export function summonComposer(): void {
  composerSummon.seq += 1;
}

/**
 * How many chat composers (not an aside's) are mounted. ⌘L goes to the
 * chat's box; an aside tab's box answers only when no chat box is drawn —
 * the aside tab is then what the pane shows.
 */
let chatBoxes = 0;

/** Every box mounted, the chat's and the asides' (item 853): the window
 *  listens while there is one. */
let allBoxes = 0;

/** A chat composer mounting; the returned function is its unmount. */
export function chatBoxMounted(): () => void {
  chatBoxes += 1;
  const done = boxMounted();
  return () => {
    chatBoxes -= 1;
    done();
  };
}

/**
 * Any box mounting — an aside tab's or card's too (item 853, his "Asides
 * dont automatically start typing … the way main chat does"): typing,
 * Enter, ⌘V from outside go to the box `composerTarget` picks, so the
 * listener runs while any box is drawn, not only the chat's.
 */
export function boxMounted(): () => void {
  allBoxes += 1;
  if (allBoxes === 1) listenForTyping(true);
  return () => {
    allBoxes -= 1;
    if (allBoxes === 0) listenForTyping(false);
  };
}

/**
 * ⌘L's box (item 853): the box `composerTarget` picks — an aside card he
 * is in or last pressed on, else the focused pane's box (an aside tab's
 * when it is in front), else the chat's. ~~The chat's box, or an aside
 * tab's only with no chat box drawn~~ (290).
 */
export function isSummonTarget(root: Element | null): boolean {
  if (!root || typeof document === "undefined") return false;
  return composerTarget(document)?.root === root;
}

/**
 * Typing anywhere in a chat goes into its box (backlog 316): the window's
 * keydown, capture phase, while a chat composer is mounted. It only moves
 * the focus; the key goes on to wherever it was going (`typeToCompose.ts`).
 */
function onTyping(e: KeyboardEvent): void {
  // ⌘V with nothing to type in (backlog 351, `pasteToCompose.ts`).
  pasteToComposeKeydown(e, isMac);
  typeToComposeKeydown(e, endOfEditor, boxText);
}

/** The box's draft text: the formatted box's from its state (its DOM holds
 *  a placeholder and only the rows in view), else the textarea's. */
function boxText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement) return el.value;
  return EditorView.findFromDOM(el)?.state.doc.toString() ?? "";
}

/** The formatted box (item 276) is CodeMirror's: its caret is its state's. */
function endOfEditor(el: HTMLElement): boolean {
  const view = EditorView.findFromDOM(el);
  if (!view) return false;
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  return true;
}

function listenForTyping(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) {
    window.addEventListener("keydown", onTyping, true);
    window.addEventListener("paste", pasteToComposeEvent, true);
    window.addEventListener("pointerdown", noteCardPress, true);
  } else {
    window.removeEventListener("keydown", onTyping, true);
    window.removeEventListener("paste", pasteToComposeEvent, true);
    window.removeEventListener("pointerdown", noteCardPress, true);
  }
}

export function chatBoxCount(): number {
  return chatBoxes;
}
