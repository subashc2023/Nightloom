/**
 * Item 934 (his bug, repeated: "if i make a change in a chat then switch to
 * another chat and then go back, command z does nothing"): a CodeMirror
 * box's undo history is its draft's, not the editor's.
 *
 * Why 886 did not fix it: `boxHistoryFor` (boxHistory.ts) keeps the PLAIN
 * textarea's history per draft. With the Format switch on — his setting —
 * the message box is a CodeMirror editor (`LiveBox`), whose history lives
 * in its `EditorState`. A chat switch hands the box the other chat's text
 * as a fresh state (`composerState`), and a tab switch unmounts the box;
 * each dropped the history, so ⌘Z after A → B → A had nothing to undo.
 *
 * Kept here per key — the same draft keys `boxHistoryFor` uses for a
 * message box, `edit:…` for an edit box, a note's buffer key — as
 * CodeMirror's own serialised history (`historyField`), written when the
 * box leaves a key or unmounts and read when a box arrives at one. Memory
 * only, the last `KEPT_EDITORS` keys, as the plain boxes'.
 */
import { historyField } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";

export const KEPT_EDITORS = 64;
const kept = new Map<string, { doc: string; json: unknown }>();
const fields = { history: historyField };

/** Keep `state`'s history (and selection) as draft `key`'s. */
export function keepEditorHistory(key: string, state: EditorState): void {
  kept.delete(key);
  kept.set(key, { doc: state.doc.toString(), json: state.toJSON(fields) });
  while (kept.size > KEPT_EDITORS) kept.delete(kept.keys().next().value as string);
}

/**
 * Draft `key`'s kept state, built with `extensions`, when its text is
 * still `doc` (as the editor would hold it: line breaks as `\n`); null
 * with nothing kept or a draft that changed while its box was away — the
 * caller starts a fresh state, since CodeMirror's history only applies to
 * the text it was recorded on.
 */
export function keptEditorState(key: string, doc: string, extensions: Extension): EditorState | null {
  const k = kept.get(key);
  if (!k || k.doc !== doc) return null;
  try {
    const state = EditorState.fromJSON(k.json, { extensions }, fields);
    return state.doc.toString() === doc ? state : null;
  } catch {
    return null;
  }
}

/** Forget draft `key`'s kept history: an editor opened afresh (item 934's
 *  review — reopening a sent or cancelled edit must not bring back its
 *  steps). */
export function forgetEditorHistory(key: string): void {
  kept.delete(key);
}

/** Tests: forget every kept history. */
export function forgetEditorHistories(): void {
  kept.clear();
}
