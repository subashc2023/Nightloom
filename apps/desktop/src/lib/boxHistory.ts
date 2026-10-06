/**
 * The message box's own undo history (blocker 1210, 2026-10-06). Pure, so
 * the rules are pinned by a test; `Composer.svelte` wires it to the
 * textarea.
 *
 * Why the box needs one: WebKit's textarea history is only coherent while
 * every change to the box is a keystroke. The page sets the box's text
 * itself all the time — a chat switch, a send, item 315's code fence,
 * item 284's "Make this an attachment", Reply's quote, a clip pick — and
 * after any of those WebKit keeps stale entries: ⌘Z steps that do nothing
 * and a ⌘⇧Z that appends text he typed long ago ("hello hello " after a
 * code block; measured in `harness/undo1210.html`). Guarding Redo alone
 * would strand an undone keystroke (⌘Z took his "X" away and ⌘⇧Z could not
 * bring it back), so the box keeps its own history and WebKit's is never
 * used: every undo and redo lands on a text the box really held.
 *
 * Shaped like WebKit's own so ⌘Z feels the same: a run of typing is one
 * step until the caret moves, a run of deleting another; a paste, a cut,
 * a drop and every script-set change are a step each.
 */

/** The box at one moment: its text and selection. */
export interface Snap {
  text: string;
  start: number;
  end: number;
}

interface Step {
  before: Snap;
  after: Snap;
  /** What the composer did beside the text, for it to undo and redo too
   *  (284's conversion: the chip). Opaque here. */
  tag?: unknown;
}

/** An undo's or redo's result: the box to show, and the step's tag. */
export interface Moved extends Snap {
  tag?: unknown;
}

/** What kind of edit an `input` event was, for coalescing. */
export type EditKind = "type" | "delete" | "other";

/** By the event's `inputType`: typing (and composing an accent or IME
 *  text) and deleting coalesce into runs; everything else stands alone. */
export function editKind(inputType: string): EditKind {
  if (inputType === "insertText" || inputType === "insertLineBreak" || inputType === "insertParagraph") return "type";
  if (inputType === "insertCompositionText" || inputType === "insertFromComposition") return "type";
  if (inputType.startsWith("delete") && inputType !== "deleteByCut" && inputType !== "deleteByDrag") return "delete";
  return "other";
}

/** Whether an `inputType` is the browser's own undo or redo. */
export function historyInput(inputType: string): "undo" | "redo" | null {
  if (inputType === "historyUndo") return "undo";
  if (inputType === "historyRedo") return "redo";
  return null;
}

/** Steps kept, and characters across them, before the oldest go. */
export const MAX_STEPS = 300;
export const MAX_CHARS = 8_000_000;

/** Where the caret goes after a script-set change: the end of what
 *  changed, found by the common prefix and suffix. */
export function caretAfterChange(before: string, after: string): number {
  let p = 0;
  const n = Math.min(before.length, after.length);
  while (p < n && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return after.length - s;
}

const at = (text: string, caret: number): Snap => ({ text, start: caret, end: caret });

export class BoxHistory {
  private past: Step[] = [];
  private future: Step[] = [];
  /** The box as the history last knew it. */
  private cur: Snap;
  /** The box just before the edit now landing (from `beforeinput`). */
  private pending: Snap | null = null;
  /** The kind of the top step while it may still grow; null once closed. */
  private open: EditKind | null = null;

  constructor(text = "") {
    this.cur = at(text, text.length);
  }

  get current(): Snap {
    return this.cur;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** A new chat's draft, or the box after a send: nothing to undo. */
  reset(text: string, caret = text.length): void {
    this.past = [];
    this.future = [];
    this.pending = null;
    this.open = null;
    this.cur = at(text, caret);
  }

  /** The box as it is just before an edit of his (`beforeinput`). */
  before(s: Snap): void {
    this.pending = s;
  }

  /** The selection moved without an edit: the next keystroke starts a
   *  new step, as in WebKit. Cheap to call on every caret move. */
  select(start: number, end: number): void {
    if (start === this.cur.start && end === this.cur.end) return;
    this.cur = { ...this.cur, start, end };
    this.open = null;
  }

  /** An edit of his landed (`input`): `after` is the box now. */
  input(kind: EditKind, after: Snap): void {
    const before = this.pending && this.pending.text === this.cur.text ? this.pending : this.cur;
    this.pending = null;
    if (after.text === before.text) {
      this.cur = after;
      return;
    }
    const top = this.past[this.past.length - 1];
    const runs =
      kind !== "other" &&
      this.open === kind &&
      top !== undefined &&
      top.after.text === before.text &&
      before.start === before.end &&
      before.start === top.after.end;
    if (runs) top.after = after;
    else this.push({ before, after });
    this.open = kind === "other" ? null : kind;
    this.future = [];
    this.cur = after;
  }

  /**
   * The page set the box's text itself. A step of its own (⌘Z puts back
   * the text before it), never merged with typing. Returns false when the
   * text is what the history already holds — the box's own echo of an
   * edit it recorded.
   */
  external(text: string, caret?: number, tag?: unknown): boolean {
    if (text === this.cur.text) return false;
    const after = at(text, caret ?? caretAfterChange(this.cur.text, text));
    this.push(tag === undefined ? { before: this.cur, after } : { before: this.cur, after, tag });
    this.future = [];
    this.open = null;
    this.pending = null;
    this.cur = after;
    return true;
  }

  /** ⌘Z: the box as it was before the top step, or null with nothing to
   *  undo. The caller puts it in the box. */
  undo(): Moved | null {
    const s = this.past.pop();
    if (!s) return null;
    this.future.push(s);
    this.open = null;
    this.pending = null;
    this.cur = s.before;
    return { ...s.before, tag: s.tag };
  }

  /** The tag of the step ⌘Z would undo next. */
  get undoTag(): unknown {
    return this.past[this.past.length - 1]?.tag;
  }

  /** ⌘⇧Z / ⌘Y: the box after the step last undone, or null. */
  redo(): Moved | null {
    const s = this.future.pop();
    if (!s) return null;
    this.past.push(s);
    this.open = null;
    this.pending = null;
    this.cur = s.after;
    return { ...s.after, tag: s.tag };
  }

  private push(s: Step): void {
    this.past.push(s);
    if (this.past.length > MAX_STEPS) this.past.shift();
    let chars = this.past.reduce((n, x) => n + x.after.text.length, 0);
    while (chars > MAX_CHARS && this.past.length > 1) chars -= this.past.shift()!.after.text.length;
  }
}
