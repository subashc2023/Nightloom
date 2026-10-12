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

// ---- why Send is off (backlog 325; 345) ----------------------------------

/**
 * Why the panel cannot send, when it cannot: the note is still being read,
 * it could not be read, or no note's text is in the editor. `null` when
 * nothing blocks.
 *
 * A dream's proposed change open on the note no longer blocks (backlog 345,
 * his "why the fuck does it still have the send button blurred out"): the
 * edit lands on the file as it would without one, the proposal stays
 * pending and untouched, and its card shows the diff against the file as
 * edited. The pane shows the edit streaming in over the card while it runs.
 */
export type EditBlock = "loading" | "error" | "no-note";

export function editBlock(s: {
  loading: boolean;
  error: boolean;
  hasBuffer: boolean;
}): EditBlock | null {
  if (s.loading) return "loading";
  if (s.error) return "error";
  if (!s.hasBuffer) return "no-note";
  return null;
}

/** The one line the panel shows for each reason. */
export function blockWords(b: EditBlock): string {
  switch (b) {
    case "loading":
      return "The note is still being read — Send turns on when it opens.";
    case "error":
      return "This note could not be read, so it cannot be edited — the message is in the note's pane.";
    case "no-note":
      return "No note's text is in the editor, so there is nothing to edit.";
  }
}

/** The line the panel shows, without turning anything off, while a dream's
 *  proposed change is open on the note (backlog 345). */
export const PROPOSAL_OPEN_WORDS =
  "A dream's proposed change is open on this note. An edit here lands on the file; the proposal stays pending.";

// ---- the earlier exchanges (backlog 326) ----------------------------------

/**
 * One earlier exchange as the next request carries it: what he asked, what
 * the model said, and what its edits changed (a compact line diff). The
 * service bounds the whole history again, so a long thread cannot blow the
 * prompt whatever the window sends.
 */
export interface PriorExchange {
  request: string;
  reply: string;
  /** `- old` / `+ new` lines, capped; empty when nothing changed. */
  changes: string;
  /** edited | undone | no edit | stopped | failed */
  outcome: string;
}

/** Exchanges carried, newest kept; the service trims further by size. */
export const HISTORY_TURNS = 8;
/** Changed lines carried per exchange, and characters. */
export const HISTORY_CHANGE_LINES = 40;
export const HISTORY_CHANGE_CHARS = 3000;

/** The changed lines between two texts, `- `/`+ ` prefixed, capped. */
export function changeDigest(before: string, after: string): string {
  const out: string[] = [];
  let more = 0;
  let chars = 0;
  for (const row of lineDiff(before, after)) {
    if (row.kind === "ctx") continue;
    const line = `${row.kind === "del" ? "-" : "+"} ${row.text}`;
    if (out.length >= HISTORY_CHANGE_LINES || chars + line.length > HISTORY_CHANGE_CHARS) {
      more++;
      continue;
    }
    out.push(line);
    chars += line.length + 1;
  }
  if (more > 0) out.push(`… ${more} more changed line${more === 1 ? "" : "s"}`);
  return out.join("\n");
}

/** Whether a turn counts as an earlier exchange: not a `kept` copy, not
 *  running, and with a request. */
function isPrior(t: NoteEditTurn): boolean {
  return t.status !== "kept" && t.status !== "running" && !!t.request.trim();
}

/** How many earlier exchanges the thread holds in all — sent beside the
 *  newest `HISTORY_TURNS` so the prompt's "N older left out" is right
 *  (w3 review finding 4, 2026-10-08). */
export function priorExchangeCount(turns: NoteEditTurn[]): number {
  return turns.filter(isPrior).length;
}

/** The thread's earlier exchanges for the next request, oldest first: no
 *  `kept` copies, nothing running, at most `HISTORY_TURNS`. */
export function priorExchanges(turns: NoteEditTurn[]): PriorExchange[] {
  const out: PriorExchange[] = [];
  for (const t of turns) {
    if (!isPrior(t)) continue;
    const changed = t.after !== undefined && t.after !== t.before;
    const outcome =
      t.status === "applied"
        ? "edited"
        : t.status === "undone"
          ? "undone"
          : t.status === "failed"
            ? "failed"
            : t.status === "stopped"
              ? "stopped"
              : "no edit";
    out.push({
      request: t.request,
      // `||`: a failed turn lands with summary "" (the service always sends
      // one), and its error is then the reply.
      reply: (t.summary || t.error || "").trim(),
      changes: changed ? changeDigest(t.before, t.after as string) : "",
      outcome,
    });
  }
  return out.slice(-HISTORY_TURNS);
}

// ---- the panel's look (backlog 345, his pick D2) --------------------------

/** The panel's width: 380 px from a 1408-px window up, 27 % of the window
 *  below that, never under the 320 px it was before (backlog 345). */
export const PANEL_WIDTH = "clamp(320px, 27vw, 380px)";
export const PANEL_MIN = 320;
export const PANEL_MAX = 380;
/** What `PANEL_WIDTH` comes to in a window `vw` px wide. */
export function panelWidthAt(vw: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, vw * 0.27));
}

/**
 * How a reply is drawn (his D2 note: "if the answer had no edits, then it
 * should be like the original version A as like a text thing, only when
 * there is edit it should be that fancy version"):
 * - `card` — the reply changed the note (or is changing it now): a card with
 *   the changed lines, a status chip and Undo;
 * - `plain` — no edit (an answer, a failure, a stop before any edit): text
 *   under his message and a quiet line;
 * - `thinking` — running with no edit landed yet: plain text with the needle.
 */
export type ReplyKind = "card" | "plain" | "thinking";

export function replyKind(t: NoteEditTurn): ReplyKind {
  if (t.status === "running") return (t.edits ?? 0) > 0 ? "card" : "thinking";
  if (t.status === "applied" || t.status === "undone" || t.status === "stopped")
    return t.after !== undefined && t.after !== t.before ? "card" : "plain";
  return "plain";
}

/** One changed line in a reply's card. `line` is where it stands in the
 *  note the turn left (0-based) — for a removed line, where it stood. */
export interface EditRow {
  kind: "add" | "del";
  text: string;
  line: number;
}

/** The changed lines between two texts, each with its place in `after`. */
export function editRows(before: string, after: string): EditRow[] {
  const out: EditRow[] = [];
  let line = 0;
  for (const row of lineDiff(before, after)) {
    if (row.kind === "ctx") {
      line++;
      continue;
    }
    out.push({ kind: row.kind, text: row.text, line });
    if (row.kind === "add") line++;
  }
  return out;
}

/** Changed lines a collapsed card shows; the rest are one click away. */
export const DIFF_ROWS_SHOWN = 4;

/**
 * Where a card's line is in the note as it reads now (0-based): an added
 * line by its text — the copy nearest its old place, since later edits may
 * have moved it — else its old place, kept inside the note.
 */
export function lineNow(row: EditRow, now: string): number {
  // Split as `lineDiff` splits (a CRLF note's `\r` dropped), so an added
  // line is found by its text there too (wave 7 review round 2).
  const lines = now
    .replace(/\r?\n$/, "")
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const last = Math.max(0, lines.length - 1);
  if (row.kind === "add") {
    let best = -1;
    lines.forEach((l, i) => {
      if (l === row.text && (best < 0 || Math.abs(i - row.line) < Math.abs(best - row.line))) best = i;
    });
    if (best >= 0) return best;
  }
  return Math.max(0, Math.min(row.line, last));
}

/** The rows a card shows: the first few, or all of them once expanded. */
export function shownRows(rows: EditRow[], open: boolean): EditRow[] {
  return open ? rows : rows.slice(0, DIFF_ROWS_SHOWN);
}

/** The card's expand control: what a click on it does next. */
export function expandWords(count: number, open: boolean): string {
  if (open) return "Collapse";
  return count > DIFF_ROWS_SHOWN ? `Show all ${count} lines, whole` : "Show the lines whole";
}

/**
 * Where a jump from the edit panel lands in `text` (wave 7 review round 2):
 * the note's lines (for the marks), the 0-based line kept inside the note,
 * and the caret's offset — the start of that same line. `NoteView` passed
 * the 0-based line to the 1-based `lineOffset`, so the caret sat one line
 * above the marked one.
 */
export function jumpTarget(text: string, line: number): { lines: string[]; at: number; offset: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  const at = Math.max(0, Math.min(line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < at; i++) offset += lines[i].length + 1;
  return { lines, at, offset };
}

/**
 * The request box after a suggestion is clicked (wave 7 review round 2):
 * the suggestion in an empty box, and after what he typed otherwise — a
 * click never replaces his half-typed text (practices §7).
 */
export function withSuggestion(draft: string, suggestion: string): string {
  if (!draft.trim()) return suggestion;
  return `${draft.replace(/\s+$/, "")}\n${suggestion}`;
}
