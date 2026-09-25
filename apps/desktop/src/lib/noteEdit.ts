/**
 * Edit a note by prompt (nightshift backlog 151) — the pure part: reading
 * the model's reply as it streams, which lines an edit changed, and the
 * threads' storage. `noteEdit.svelte.ts` holds the live state and runs the
 * rewrite; `NoteEditPanel.svelte` is the small chat beside the note.
 *
 * The reply is the whole new note, then a line holding only `END_MARKER`,
 * then a sentence on what changed (`nightloom_service::note_edit`, where
 * the prompt is). The marker must never flash into the note while it
 * streams, so a tail that could be its start is held back.
 */
import { lineDiff } from "./diff";

/** Keep in step with `nightloom_service::note_edit::END_MARKER`. */
export const END_MARKER = "<<<END OF NOTE>>>";

export interface SplitReply {
  /** The note as far as it has arrived (all of it, once `complete`). */
  note: string;
  /** The model's sentence after the marker; empty before it. */
  summary: string;
  /** The marker has arrived: `note` is whole. */
  complete: boolean;
}

const FENCE_OPEN = /^```[\w-]*[ \t]*\r?\n/;

/**
 * Split a reply, whole or partial, into the note and the sentence.
 *
 * `before` is the note as it was: a reply that opens with a code fence the
 * note did not have is wrapped (the prompt says not to, and models do it
 * anyway), so that fence and its closer come off; a note that itself opens
 * with a fence keeps it. The note's last line ending follows `before`'s —
 * one newline if it had one, none if it had none — since the line before
 * the marker says nothing about it.
 */
export function splitReply(raw: string, before: string): SplitReply {
  let body = raw.replace(/^\s*\n/, "");
  let fenced = false;
  if (!before.startsWith("```")) {
    if (FENCE_OPEN.test(body)) {
      body = body.replace(FENCE_OPEN, "");
      fenced = true;
    } else if (/^`{1,3}[\w-]*$/.test(body)) {
      // The start of a fence line, not yet whole: nothing to show.
      return { note: "", summary: "", complete: false };
    }
  }
  const at = body.indexOf(END_MARKER);
  if (at < 0) {
    return { note: holdBack(body), summary: "", complete: false };
  }
  let note = body.slice(0, at);
  if (fenced) note = note.replace(/\n?```[ \t]*\n?$/, "\n");
  const summary = body
    .slice(at + END_MARKER.length)
    .replace(/^\s*```[ \t]*\n/, "")
    .trim();
  return { note: endLike(note, before), summary, complete: true };
}

/** Drop a tail that could be the marker's start, so it never shows. */
function holdBack(text: string): string {
  for (let n = Math.min(END_MARKER.length - 1, text.length); n > 0; n--) {
    if (END_MARKER.startsWith(text.slice(text.length - n))) return text.slice(0, text.length - n);
  }
  return text;
}

/** The note's ending as `before` had it: one newline, or none. */
function endLike(note: string, before: string): string {
  const trimmed = note.replace(/(\r?\n)+$/, "");
  if (trimmed === "") return "";
  return before === "" || /\n$/.test(before) ? `${trimmed}\n` : trimmed;
}

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
 * `applied` saved to the file; `draft` put in the editor unsaved (a reply
 * with no end marker may be cut off, or the note's project changed while
 * it ran); `kept` is no exchange but a copy of his text taken before an
 * Undo overwrote something that differed from what the model left.
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
  /** The note before this edit — the kept copy Undo restores. */
  before: string;
  /** The note as the model left it, once whole. */
  after?: string;
  summary?: string;
  error?: string;
  /** The reply so far, while it streams. Not stored. */
  partial?: string;
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
 * — the process does not outlive the window — and its partial reply is
 * dropped; its `before` (the note's text, which was never overwritten) is
 * kept. Threads with nothing in them are left out.
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
          const { partial: _partial, ...kept } = x;
          return x.status === "running" ? { ...kept, status: "stopped" as const } : kept;
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

/** The newest exchange Undo applies to: the last one that changed the
 *  note and is not undone yet — so Undo pressed again walks further back. */
export function undoable(turns: NoteEditTurn[]): NoteEditTurn | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].status === "applied") return turns[i];
  }
  return null;
}
