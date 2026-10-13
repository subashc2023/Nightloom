/**
 * The composer's caret and focus (nightshift backlog 290, 2026-10-02 — his
 * "save where my cursor and stuff is within the textbox … when i go into a
 * new chat or a diff chat the cursor should by default be on my textbox …
 * command L … should put focus on the textbox").
 *
 * Three things, kept here as plain logic so the suite (node, no DOM) can
 * drive them with a fake box and a fake document:
 *
 * - **The caret is kept per draft key** — a chat's id, a pending chat's
 *   `new:…` key, an aside's `aside:<uid>` — in the drafts store beside the
 *   text (`Draft.sel`), so it outlives a switch, a reload and a quit with
 *   the draft. `CaretKeeper.record` writes it while the box shows that
 *   key's text; `restore` puts it back, clamped to the text's length. Only
 *   offsets are ever written: the text is never touched.
 * - **A key arriving focuses the box** (a new chat, a chat switch from the
 *   sidebar or a tab, Ctrl+Tab, Continue — each of them changes the key or
 *   mounts the box) unless that would take focus from something else:
 *   `mayAutoFocus` says no while another text field has the focus or a
 *   modal, menu, popover or the find bar is open. If it says no, the caret
 *   still waits for the box: the next keyboard or script focus puts it
 *   back, and a click places it where he clicked, as a click should.
 * - **⌘L** (Ctrl+L elsewhere) focuses the open chat's box from anywhere
 *   but a modal or the terminal (whose shell owns Ctrl+L): the kept caret,
 *   else the end of the draft. Unbound before this: no menu accelerator in
 *   `main.rs`, nothing in `App.svelte`, and CodeMirror's selectLine is
 *   Alt-l / Ctrl-l on macOS, not ⌘L (checked in 4f13c81).
 */
import type { ComposerBox } from "./composerEditor";
import type { DraftSel } from "./drafts.svelte";

/** A kept caret inside a text of `len` characters; null when none. */
export function clampSel(sel: DraftSel | null | undefined, len: number): DraftSel | null {
  if (!sel) return null;
  const n = Math.max(0, len);
  const a = Math.max(0, Math.min(sel.start, sel.end, n));
  const b = Math.max(a, Math.min(Math.max(sel.start, sel.end), n));
  return { start: a, end: b };
}

/** The slice of an element the checks read. */
export interface ElLike {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  closest(selector: string): unknown;
}

/** The slice of `document` the checks read. */
export interface DocLike {
  activeElement: ElLike | null;
  querySelector(selector: string): unknown;
}

/**
 * What is open when automatic focus would be a steal: a modal (Settings,
 * Context, Running tasks, Prompts, a confirm), the palette, any popover or
 * menu (their scrims), and the find bar (⌘F, backlog 287) while it is up.
 */
export const AUTO_FOCUS_BLOCKERS = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  ".settings-overlay",
  ".find-bar",
  ".scrim",
  ".tab-scrim",
  ".tab-chooser-scrim",
  ".attach-scrim",
].join(", ");

/** What ⌘L will not reach past: a modal over the app. */
export const CMD_L_BLOCKERS = ['[aria-modal="true"]', ".settings-overlay", ".pal"].join(", ");

const NOT_TYPED = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/** A field he types in: a text input, a textarea, a select, an editor. */
export function isEditable(el: ElLike | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TYPED.has((el.type ?? "text").toLowerCase());
  return el.isContentEditable === true;
}

/**
 * May a key arriving put the focus in this composer? `own` is the
 * composer's root (`.composer`). Yes when the focus is already in it, or
 * on nothing he types in — and nothing modal, no menu and no find bar is
 * open.
 */
export function mayAutoFocus(doc: DocLike, own: unknown): boolean {
  const a = doc.activeElement;
  const inOwn = !!a && own != null && a.closest(".composer") === own;
  if (inOwn) return true;
  if (isEditable(a)) return false;
  return !doc.querySelector(AUTO_FOCUS_BLOCKERS);
}

/** May ⌘L focus the composer now? Not under a modal, not from the terminal. */
export function mayCmdL(doc: DocLike): boolean {
  if (doc.querySelector(CMD_L_BLOCKERS)) return false;
  const a = doc.activeElement;
  return !(a && a.closest(".xterm"));
}

/** ⌘L on macOS, Ctrl+L elsewhere, no other modifier; the physical key. */
export function isFocusChord(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): boolean {
  if (e.code !== "KeyL" || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Where the keeper reads and writes kept carets: the drafts store. */
export interface SelStore {
  get(key: string): DraftSel | null;
  set(key: string, start: number, end: number): void;
}

/**
 * One composer's caret bookkeeping. The component calls `record` as he
 * moves the caret and just before its key changes, `arrive` when a key
 * comes in (mount or switch), `focus` to take the focus, and `focusIn`
 * from the box's own focus event.
 */
export class CaretKeeper {
  /** The key whose kept caret still waits to go back into the box. */
  private pending: string | null = null;
  /** Set while `focus` runs, so its own focus event is not handled twice. */
  private focusing = false;

  constructor(private readonly store: SelStore) {}

  /**
   * Keep the box's caret under `key` — only while the box shows that key's
   * text, and not while that key's own caret still waits to go back (the
   * box's caret then is where the browser put it, not where he did).
   */
  record(key: string, box: ComposerBox | null, text: string): void {
    if (!box || box.value !== text || this.pending === key) return;
    this.store.set(key, box.selectionStart, box.selectionEnd);
  }

  /** A key came in: its caret is due back in the box. */
  arrive(key: string): void {
    this.pending = key;
  }

  /**
   * Nothing to put back: the box already shows `key` with his caret in it
   * (a pending chat's draft moving to the chat its first send made, the
   * same words while he types on).
   */
  settle(key: string): void {
    if (this.pending === key) this.pending = null;
  }

  /** Whether `key`'s caret still waits to be put back. For the tests. */
  isPending(key: string): boolean {
    return this.pending === key;
  }

  /** Put `key`'s kept caret in the box, clamped; the end of the text when none and `endIfNone`. */
  restore(key: string, box: ComposerBox, endIfNone: boolean): void {
    const len = box.value.length;
    const s = clampSel(this.store.get(key), len) ?? (endIfNone ? { start: len, end: len } : null);
    if (this.pending === key) this.pending = null;
    if (!s) return;
    if (box.selectionStart === s.start && box.selectionEnd === s.end) return;
    box.selectionStart = s.start;
    box.selectionEnd = s.end;
  }

  /**
   * Focus the box. `hadFocus` says whether it was focused already (a
   * Ctrl+Tab from inside it): then only a pending caret goes back. With
   * nothing kept, the caret lands at the end of the draft. An explicit ask
   * (⌘L) into a box that was not focused puts the kept caret back even
   * when nothing is pending (the box lost the focus, the caret stayed kept).
   */
  focus(key: string, box: ComposerBox, hadFocus: boolean, explicit: boolean): void {
    if (!hadFocus) {
      this.focusing = true;
      try {
        box.focus();
      } finally {
        this.focusing = false;
      }
    }
    if (this.pending === key || (explicit && !hadFocus)) this.restore(key, box, true);
  }

  /**
   * The box took the focus on its own (Tab, a click). A pending caret goes
   * back on a keyboard focus; a click places the caret itself, and the
   * pending one is dropped.
   */
  focusIn(key: string, box: ComposerBox, pointer: boolean): void {
    if (this.focusing || this.pending !== key) return;
    if (pointer) {
      this.pending = null;
      return;
    }
    this.restore(key, box, true);
  }
}
