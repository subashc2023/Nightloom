/**
 * Edit a note by prompt (nightshift backlog 151) — the pure part: which
 * lines an edit changed, and the threads' storage. `noteEdit.svelte.ts`
 * holds the live state and runs the turn; `NoteEditPanel.svelte` is the
 * small chat beside the note.
 *
 * Pass 2 (blocker 414): the model edits the note's file with the Edit tool,
 * on that one path, and the note updates as each Edit lands
 * (`note-edit-landed`). Pass 1's whole rewrite streamed as text — its end
 * marker and `splitReply` — was removed 2026-09-25, replaced by this.
 */
import { lineDiff } from "./diff";

/** The new text's changed lines, 0-based — what the marks light up. */
export function changedLines(before: string, after: string): number[] {
  const out: number[] = [];
  let line = 0;
  for (const row of lineDiff(before, after)) {
    if (row.kind === "del") continue;
    if (row.kind === "add") out.push(line);
    line++;
  }
  return out;
}

/** How many lines went and came, for the exchange's one-line summary. */
export function editTotals(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of lineDiff(before, after)) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}

/** Today, local, as `YYYY-MM-DD` — the date a struck line carries. */
export function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ---- the threads ----------------------------------------------------------

/**
 * `applied`: the model's edits are in the file (all of them, or those that
 * landed before a stop or a failure — `error` says which). `stopped` and
 * `failed` changed nothing. `kept` is no exchange but a copy of his text
 * taken before something overwrote it: an Undo over text that differs from
 * what the model left, or the saved file his unsaved draft replaced when
 * he sent a request. `draft` is pass 1's (a reply put in the editor
 * unsaved); pass 2 makes none, but stored threads may hold one.
 */
export type EditStatus =
  | "running"
  | "applied"
  | "draft"
  | "unchanged"
  | "failed"
  | "stopped"
  | "undone"
  | "kept";

/** One exchange: his request, and the note on either side of it. */
export interface NoteEditTurn {
  id: number;
  request: string;
  strike: boolean;
  at: string;
  status: EditStatus;
  /** The note before this turn — the copy Undo restores. */
  before: string;
  /** The note as the model left it. */
  after?: string;
  summary?: string;
  error?: string;
  /** Edits that landed. */
  edits?: number;
  /** The model's text so far, while it runs. Not stored. */
  partial?: string;
  /** The note as the last landed Edit left it, while it runs. Stored as
   *  `after` if the window goes mid-turn, so Undo still has both sides. */
  current?: string;
}

/** A note's side chat: the half-typed request, the switch, the exchanges. */
export interface NoteEditThread {
  draft: string;
  strike: boolean;
  turns: NoteEditTurn[];
  /** Last touched, for trimming the oldest threads. */
  touched: string;
}

export function emptyThread(): NoteEditThread {
  return { draft: "", strike: true, turns: [], touched: new Date(0).toISOString() };
}

export const STORE_KEY = "nightloom.noteEdits";
/** Exchanges kept per note, and notes kept: enough to undo a morning's
 *  work, small enough that localStorage never fills with note copies. */
export const MAX_TURNS = 12;
export const MAX_THREADS = 40;

/**
 * The threads as they are stored. A running exchange is stored as stopped
 * — the process does not outlive the window — with the edits that had
 * landed as its `after` (they are in the file) and its `before` kept, so
 * Undo can still put the note back. Its streamed text is dropped. Threads
 * with nothing in them are left out.
 */
export function serializeThreads(threads: Record<string, NoteEditThread>): string {
  const rows = Object.entries(threads)
    .filter(([, t]) => t.draft.trim() !== "" || t.turns.length > 0 || !t.strike)
    .sort(([, a], [, b]) => b.touched.localeCompare(a.touched))
    .slice(0, MAX_THREADS)
    .map(([key, t]) => [
      key,
      {
        draft: t.draft,
        strike: t.strike,
        touched: t.touched,
        turns: t.turns.slice(-MAX_TURNS).map((x) => {
          const { partial: _partial, current, ...kept } = x;
          if (x.status !== "running") return kept;
          return current !== undefined && current !== x.before
            ? { ...kept, status: "stopped" as const, after: current }
            : { ...kept, status: "stopped" as const };
        }),
      },
    ]);
  return JSON.stringify(Object.fromEntries(rows));
}

/** Read the stored threads; anything malformed reads as nothing. */
export function parseThreads(raw: string | null): Record<string, NoteEditThread> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    const out: Record<string, NoteEditThread> = {};
    for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
      const t = v as Partial<NoteEditThread> | null;
      if (!t || typeof t !== "object") continue;
      out[key] = {
        draft: typeof t.draft === "string" ? t.draft : "",
        strike: t.strike !== false,
        touched: typeof t.touched === "string" ? t.touched : new Date(0).toISOString(),
        turns: Array.isArray(t.turns)
          ? t.turns.filter(
              (x): x is NoteEditTurn =>
                !!x && typeof x.request === "string" && typeof x.before === "string" && typeof x.id === "number",
            )
          : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether an exchange left the note changed: what Undo can put back. */
function changedTheNote(t: NoteEditTurn): boolean {
  if (t.status === "applied") return true;
  // A turn cut off by the window going, with edits already in the file.
  return t.status === "stopped" && t.after !== undefined && t.after !== t.before;
}

/** The newest exchange Undo applies to: the last one that changed the
 *  note and is not undone yet — so Undo pressed again walks further back. */
export function undoable(turns: NoteEditTurn[]): NoteEditTurn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (changedTheNote(turns[i])) return turns[i];
  }
  return null;
}
