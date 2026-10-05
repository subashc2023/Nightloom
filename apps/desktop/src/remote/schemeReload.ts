/**
 * Item 302: Safari's bars follow a live switch to dark (or light).
 *
 * This Safari reads its bar colour (`theme-color`) once, at load, and
 * ignores a live change (300 B6, two tries). So on a change of the phone's
 * light/dark the page reloads itself — invisibly: before the reload it
 * keeps what a reload would drop (the transcript's scroll, the sheet or
 * page open, the Notes tab and note), and after it puts them back. The
 * chat, its project and every draft are already kept (A21, the drafts).
 *
 * It never reloads while something would be lost: a photo in the composer
 * (too big to keep, blocker 691), a text field whose words are not in
 * storage (a rename, an approval's note), a call still on its way to the
 * host (a send), or the voice orb. Then it waits for the next time the
 * page is hidden and shown.
 */

export type Scheme = "light" | "dark";

/** The page's one-shot note to itself across the reload (this tab only). */
export const RESUME_KEY = "nightloom.remote.resume";
/** A note older than this is from another visit, not this reload. */
export const RESUME_TTL_MS = 60_000;

export type Verdict = "none" | "now" | "later";

/**
 * Whether to reload for the phone's scheme. `loaded`: the scheme the page
 * loaded in, which is the one Safari's bars show; `now`: the phone's now.
 * - The same: nothing (a switch and back while hidden needs no reload).
 * - Hidden: when it is next shown (`later`).
 * - Shown and nothing at risk: `now`. Something at risk: `later` — the
 *   next hide and show asks again.
 */
export function schemeVerdict(s: { loaded: Scheme; now: Scheme; visible: boolean; atRisk: boolean }): Verdict {
  if (s.now === s.loaded) return "none";
  if (!s.visible) return "later";
  return s.atRisk ? "later" : "now";
}

/** A text field as the risk check sees it. */
export interface Field {
  /** `textarea`, or an input's `type` (`""` for none). */
  type: string;
  value: string;
  /** Its words are kept in storage as he types (`data-kept`). */
  kept: boolean;
}

const TEXT_TYPES = new Set(["textarea", "", "text", "url", "email", "tel", "number", "password"]);

/** Whether any field holds words a reload would drop: typed text, not in
 *  storage. A search box is not his writing; an empty field holds none. */
export function unkeptText(fields: Field[]): boolean {
  return fields.some((f) => TEXT_TYPES.has(f.type.toLowerCase()) && !f.kept && f.value.trim() !== "");
}

/** What would be lost by a reload now. */
export interface Risk {
  /** Photos or files in the composer (blocker 691: not kept). */
  attachments: number;
  /** Calls that change something on the host, still on their way. */
  writes: number;
  /** A field with words not in storage (`unkeptText`). */
  unkept: boolean;
  /** Something that holds the page live (the voice orb). */
  held: boolean;
}

export function atRisk(r: Risk): boolean {
  return r.attachments > 0 || r.writes > 0 || r.unkept || r.held;
}

// ---- what a reload keeps ------------------------------------------------------

/** The sheets put back as they were. The message menu (it needs the row it
 *  was opened on), rename (at risk while open) and the delete and compact
 *  confirmations come back as the chat menu they were opened from. */
export const RESUMABLE_SHEETS = [
  "chat",
  "project",
  "rail",
  "running",
  "notes",
  "aside",
  "council",
  "newproject",
  "hosts",
  "nightshift",
] as const;
export type ResumableSheet = (typeof RESUMABLE_SHEETS)[number];

/** A sheet as it is kept: itself, its chat menu, or none. */
export function keptSheet(sheet: string | null): ResumableSheet | null {
  if (sheet === null) return null;
  if ((RESUMABLE_SHEETS as readonly string[]).includes(sheet)) return sheet as ResumableSheet;
  if (sheet === "message" || sheet === "rename" || sheet === "delete" || sheet === "compact") return "chat";
  return null;
}

export type NoteScopeName = "project" | "knowledge" | "instructions" | "memory" | "chat" | "models";

/** The Notes sheet's place: its tab, and the note open (read, edited or new). */
export interface NotesPlace {
  tab: "project" | "knowledge";
  view: { v: "list" } | { v: "read" | "edit"; scope: NoteScopeName; name: string } | { v: "new"; scope: NoteScopeName };
}

/** Where the transcript was read: the row at the top of the view and how
 *  far its top sat from the view's, or the end. */
export type ScrollPlace = { atEnd: true } | { atEnd: false; row: number; offset: number };

export interface Resume {
  /** When it was written (ms), so a stale one is dropped. */
  at: number;
  /** The chat it was for; the scroll applies only to it. */
  chat: string | null;
  scroll: ScrollPlace | null;
  drawer: boolean;
  sheet: ResumableSheet | null;
  /** The Projects list (`page: null`) or a project's page. */
  projects: { page: string | null } | null;
  context: boolean;
  /** The Notes sheet's project and place, when it was open. */
  notesPid: string | null;
  notes: NotesPlace | null;
}

const SCOPES = new Set<string>(["project", "knowledge", "instructions", "memory", "chat", "models"]);

function readNotes(v: unknown): NotesPlace | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const tab = o.tab === "knowledge" ? "knowledge" : "project";
  const w = (o.view ?? {}) as Record<string, unknown>;
  const scope = typeof w.scope === "string" && SCOPES.has(w.scope) ? (w.scope as NoteScopeName) : null;
  const name = typeof w.name === "string" && w.name ? w.name : null;
  if ((w.v === "read" || w.v === "edit") && scope && name) return { tab, view: { v: w.v, scope, name } };
  if (w.v === "new" && scope) return { tab, view: { v: "new", scope } };
  return { tab, view: { v: "list" } };
}

function readScroll(v: unknown): ScrollPlace | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.atEnd === true) return { atEnd: true };
  if (typeof o.row === "number" && Number.isInteger(o.row) && o.row >= 0 && typeof o.offset === "number" && Number.isFinite(o.offset))
    return { atEnd: false, row: o.row, offset: o.offset };
  return null;
}

/** A resume note read back, checked field by field; `null` when it is not
 *  one or is older than `RESUME_TTL_MS`. */
export function readResume(v: unknown, now: number): Resume | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "number" || now - o.at > RESUME_TTL_MS || o.at - now > RESUME_TTL_MS) return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  const p = o.projects as Record<string, unknown> | null | undefined;
  return {
    at: o.at,
    chat: str(o.chat),
    scroll: readScroll(o.scroll),
    drawer: o.drawer === true,
    sheet: keptSheet(str(o.sheet)),
    projects: p && typeof p === "object" ? { page: str(p.page) } : null,
    context: o.context === true,
    notesPid: str(o.notesPid),
    notes: readNotes(o.notes),
  };
}

export function saveResume(r: Resume): boolean {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

/** The note, read once: it is removed as it is read, so a later reload
 *  (his own pull, a crash) never replays it. */
export function takeResume(now: number): Resume | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return raw ? readResume(JSON.parse(raw), now) : null;
  } catch {
    return null;
  }
}

// ---- the transcript's scroll ------------------------------------------------------

/** A row's index and where its box sits, relative to the view's top. */
export interface RowBox {
  row: number;
  top: number;
  bottom: number;
}

/** Where he was reading: the first row still in view (its bottom below the
 *  view's top), and its top's offset from the view's; the end when he was
 *  at it (`atEnd`) or no row is known. */
export function scrollPlace(rows: RowBox[], atEnd: boolean): ScrollPlace {
  if (atEnd) return { atEnd: true };
  const first = rows.find((r) => r.bottom > 0);
  return first ? { atEnd: false, row: first.row, offset: first.top } : { atEnd: true };
}

/** How far to scroll so the kept row's top is back at its offset: its top
 *  now minus where it was. */
export function scrollBy(place: ScrollPlace, rowTopNow: number | null): number {
  if (place.atEnd || rowTopNow === null) return 0;
  return rowTopNow - place.offset;
}
