/**
 * The undo stack for chat operations (nightshift backlog 064, 2026-09-15):
 * his "Command Y, which does redo … in all of the chat related or editing
 * related stuff of Nightloom".
 *
 * A stack of *inverse commands*, never of snapshots: each entry carries a
 * closure that reverses the operation and one that does it again, and
 * both call the same backend command the operation itself used — so the
 * log sees an ordinary event (an `unrewind`, an `unelide`, an `edit` back
 * to the old text, a rename, a restore from the trash), and a redo is a
 * fresh operation rather than a resurrection. Nothing here knows what the
 * closures do; that is what keeps it testable without a backend.
 *
 * Scoped, not global. Operations on a chat's log (a rewind, a removal, an
 * edit, a layer) live under that chat's id — the pending New chat under
 * its own key — so ⌘Z in chat B never lifts a rewind made in chat A that
 * is not on screen. Operations on the *list* (a rename, a delete, a
 * restore) live under `LIST_SCOPE`, since the chat they name may not be
 * the open one — or may no longer be open at all, which is what a delete
 * does. An undo looks at both the open chat's stack and the list's and
 * takes whichever was pushed more recently; a redo takes whichever was
 * undone more recently. Sequence numbers stamped on push and on undo are
 * what "more recently" means.
 *
 * Every entry is applied through the closures in order, so the inverses
 * are exact only in order: undoing an older operation under a newer one
 * is never offered. A sent turn is not on the stack (the model has
 * answered) and clears the chat's stack, because a rewind lifted from
 * under a reply the model has already given would put the model in a
 * conversation it never had — on Claude Code, one whose file it never
 * wrote.
 */

export interface UndoEntry {
  /** The operation, as the menu, the palette and the toast name it:
   *  "rewind", "remove", "rename". Short and lowercase; the callers
   *  prepend "Undo" / "Undid". */
  label: string;
  /** Reverse the operation. Rejecting leaves the cursor where it was. */
  undo: () => Promise<void> | void;
  /** Do it again. Same terms. */
  redo: () => Promise<void> | void;
}

/** The scope list operations are pushed under. Not a chat id. */
export const LIST_SCOPE = "*";

/** The scope of the New chat that has no log yet. */
export const NEW_CHAT_SCOPE = "new";

interface Stamped extends UndoEntry {
  /** When it was pushed — the order undo takes across scopes. */
  seq: number;
  /** When it was last undone — the order redo takes across scopes. */
  undoneSeq: number;
}

interface Stack {
  entries: Stamped[];
  /** `entries[..cursor]` can be undone (newest last), `entries[cursor..]`
   *  redone (next first). */
  cursor: number;
}

/** What an undo or a redo did: the operation's label, or nothing. */
export type Step = { label: string } | null;

export class UndoHistory {
  private stacks = new Map<string, Stack>();
  private seq = 0;
  /** Whether a turn is in flight: both undo and redo are no-ops then, on
   *  `rewindTo`'s reasoning — the running turn holds the session and would
   *  record its reply after the change landed. */
  private busy: () => boolean;

  constructor(busy: () => boolean = () => false) {
    this.busy = busy;
  }

  private stack(scope: string): Stack {
    let s = this.stacks.get(scope);
    if (!s) {
      s = { entries: [], cursor: 0 };
      this.stacks.set(scope, s);
    }
    return s;
  }

  /** Record an operation that has just succeeded. Anything undone and not
   *  redone in this scope is forgotten, as everywhere. Returns the entry's
   *  handle, which `undoIf` takes (backlog 066's Undo toast). */
  push(scope: string, entry: UndoEntry): number {
    const s = this.stack(scope);
    s.entries.length = s.cursor;
    const seq = ++this.seq;
    s.entries.push({ ...entry, seq, undoneSeq: 0 });
    s.cursor = s.entries.length;
    return seq;
  }

  /** Forget a scope's whole history — what a sent turn does to its chat's. */
  clear(scope: string): void {
    this.stacks.delete(scope);
  }

  /** The entry an undo over `scopes` would reverse: the most recently
   *  pushed of each scope's newest undoable entry. */
  private nextUndo(scopes: string[]): { stack: Stack; entry: Stamped } | null {
    let best: { stack: Stack; entry: Stamped } | null = null;
    for (const scope of scopes) {
      const stack = this.stacks.get(scope);
      if (!stack || stack.cursor === 0) continue;
      const entry = stack.entries[stack.cursor - 1];
      if (!best || entry.seq > best.entry.seq) best = { stack, entry };
    }
    return best;
  }

  /** The entry a redo over `scopes` would repeat: the most recently
   *  undone of each scope's next redoable entry. */
  private nextRedo(scopes: string[]): { stack: Stack; entry: Stamped } | null {
    let best: { stack: Stack; entry: Stamped } | null = null;
    for (const scope of scopes) {
      const stack = this.stacks.get(scope);
      if (!stack || stack.cursor >= stack.entries.length) continue;
      const entry = stack.entries[stack.cursor];
      if (!best || entry.undoneSeq > best.entry.undoneSeq) best = { stack, entry };
    }
    return best;
  }

  /** What "Undo …" would say over `scopes`, or null when nothing can be. */
  undoLabel(scopes: string[]): string | null {
    return this.nextUndo(scopes)?.entry.label ?? null;
  }

  redoLabel(scopes: string[]): string | null {
    return this.nextRedo(scopes)?.entry.label ?? null;
  }

  /** Reverse the newest operation over `scopes`. Null when there was
   *  nothing to reverse or a turn is running; the cursor moves only once
   *  the closure has resolved, so a refusal changes nothing. */
  async undo(scopes: string[]): Promise<Step> {
    if (this.busy()) return null;
    const next = this.nextUndo(scopes);
    if (!next) return null;
    await next.entry.undo();
    next.entry.undoneSeq = ++this.seq;
    next.stack.cursor -= 1;
    return { label: next.entry.label };
  }

  /** Reverse the entry `push` returned `handle` for — but only while it
   *  is still what an undo over `scopes` would take, since an Undo on a
   *  toast is a promise about one operation and not about whatever was
   *  done after it (backlog 066). Null when it is not, or nothing to do. */
  async undoIf(scopes: string[], handle: number): Promise<Step> {
    const next = this.nextUndo(scopes);
    if (!next || next.entry.seq !== handle) return null;
    return this.undo(scopes);
  }

  /** Repeat the most recently undone operation over `scopes`. Same terms. */
  async redo(scopes: string[]): Promise<Step> {
    if (this.busy()) return null;
    const next = this.nextRedo(scopes);
    if (!next) return null;
    await next.entry.redo();
    next.entry.seq = ++this.seq;
    next.stack.cursor += 1;
    return { label: next.entry.label };
  }
}
