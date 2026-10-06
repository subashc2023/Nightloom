import { EditorView } from "@codemirror/view";
import { typeToComposeKeydown } from "./typeToCompose";

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

/** A chat composer mounting; the returned function is its unmount. */
export function chatBoxMounted(): () => void {
  chatBoxes += 1;
  if (chatBoxes === 1) listenForTyping(true);
  return () => {
    chatBoxes -= 1;
    if (chatBoxes === 0) listenForTyping(false);
  };
}

/**
 * Typing anywhere in a chat goes into its box (backlog 316): the window's
 * keydown, capture phase, while a chat composer is mounted. It only moves
 * the focus; the key goes on to wherever it was going (`typeToCompose.ts`).
 */
function onTyping(e: KeyboardEvent): void {
  typeToComposeKeydown(e, endOfEditor);
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
  if (on) window.addEventListener("keydown", onTyping, true);
  else window.removeEventListener("keydown", onTyping, true);
}

export function chatBoxCount(): number {
  return chatBoxes;
}
