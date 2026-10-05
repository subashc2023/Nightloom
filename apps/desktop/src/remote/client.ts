/**
 * The phone page's pure half (nightshift backlog 091, Shape B): the token
 * from the QR's link, the API calls, the event stream's parser, the fold of
 * a live turn, the transcript's rows, and the queue for messages typed
 * while the Mac is unreachable. Nothing here touches the DOM, so all of it
 * is under `client.test.ts`; `Remote.svelte` is the screen over it.
 */
import type { ApprovalRequest, DocumentInput, ImageInput, SessionEvent, TurnEvent } from "../lib/types";
import type { SubagentLimits } from "../lib/catalog";
import type { WireView } from "../lib/types";
import type { ContextReply, LayerChange } from "./ContextSheet.svelte";
import { isCouncilBlock } from "../lib/council";
import { parseSubagentBlock } from "../lib/subagent";
// Pure over the log (only a type import inside): the desktop's per-reply
// sizes, so the phone's line under a reply says the Mac's number.
import { fmtTokens, turnSizes, type TurnSize } from "../lib/tokens";

export const TOKEN_KEY = "nightloom.remote.token";
export const QUEUE_KEY = "nightloom.remote.queue";
export const DRAFTS_KEY = "nightloom.remote.drafts";

// ---- the token ----------------------------------------------------------

/**
 * The token the QR carries: `#token=<hex>` on the page's URL. A fragment
 * never leaves the browser — not in the request, not in Safari's history
 * sync, not in a referer — which is why it rides there and not in a query.
 */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|[#&])token=([0-9a-fA-F]{16,128})(?:&|$)/.exec(hash);
  return m ? m[1].toLowerCase() : null;
}

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode, or storage off: the token lives for this page load only.
  }
}

// ---- the API ------------------------------------------------------------

/** What `/api/state` answers — `RemoteState` in the service crate. */
export interface RemoteState {
  project: string | null;
  active_chat: string | null;
  busy: boolean;
  connected: boolean;
  engine: string | null;
  pending: ApprovalRequest[];
  /** What this host serves beyond pass 1 (item 246 wave 1, design §4):
   *  the `Host` method names — `act`, `rail`, `running`, `usage`, … A
   *  listener from before wave 1 sends none, and the page greys out what
   *  is missing. */
  features?: string[];
  /** This host's voice (item 246 wave 3), or null when its programs are
   *  not set up — the page then offers keyboard dictation instead. */
  voice?: import("./voice/socket").VoiceInfo | null;
  /** Which kind of host this is (wave 3, item 246 wave 4B): the Mac's
   *  listener or the away server (`nightloom serve`). Absent: a Mac from
   *  before the field — the only host "older than the phone page" is true
   *  of (`missingSentence` in `hosts.ts`). */
  host?: "mac" | "serve";
  /** The desktop's chosen palette id (wave 3 B1, blocker 577): "A"–"D";
   *  absent or null on serve and on a Mac from before the field. */
  palette?: string | null;
  /** A turn the plan's usage limit paused (wave 3 B1, item 164): the
   *  chat, when the window resets and which window. Absent or null when
   *  nothing is paused. */
  limit_pause?: LimitPauseWire | null;
}

/** `/api/state.limit_pause` (B1's `{ chat, resets_at, window, text,
 *  subagents, resume_at }`, times unix seconds). The reset is read in
 *  whichever form the host sends: unix seconds (the CLI's), unix ms (the
 *  window's `resetsAtMs`) or an ISO time. */
export interface LimitPauseWire {
  chat: string | null;
  resets_at: number | string | null;
  window?: string | null;
  /** The host's own sentence for the pause. */
  text?: string;
  /** Subagents the pause stopped. */
  subagents?: string[];
  /** Set while the host has a resume scheduled (reset + 30 s). */
  resume_at?: number | string | null;
}

/** Whether the host serves `name` (design §4's `features`). */
export function hasFeature(state: RemoteState, name: string): boolean {
  return Array.isArray(state.features) && state.features.includes(name);
}

// ---- wave 1: the chat's actions, the rail, running tasks, usage -----------
// The wire shapes of design §4 (`remote/api.rs` in the service crate, serde
// `rename_all = "snake_case"`, `ChatAction` tagged by `op`).

export type EditMode = "save" | "send";

export type ChatAction =
  | { op: "edit"; index: number; text: string; mode: EditMode; block: number | null }
  | { op: "remove"; index: number }
  | { op: "restore"; index: number }
  | { op: "remove_block"; index: number; block: number }
  | { op: "restore_block"; index: number; block: number }
  | { op: "rewind"; to: number }
  | { op: "unrewind"; of: number }
  | { op: "fork"; upto: number }
  | { op: "continue" }
  | { op: "compact" }
  | { op: "delete" }
  | { op: "undelete" }
  | { op: "kind"; kind: "build" | "chat" }
  | { op: "resume_limit" }
  | { op: "budget"; decision: string; text: string | null }
  | { op: "checkpoint"; index: number };

/** `ActReply`: the chat now showing (a fork's new id) and its log. */
export interface ActReply {
  chat: string;
  events: SessionEvent[];
}

/** A council seat on the rail (`RailCouncil` in `api.rs`). */
export interface CouncilSeat {
  model: string;
  engine?: "subscription" | "api";
}

/** The rail's engine settings (`GET /api/rail`, `Rail` in the service
 *  crate's `remote/api.rs` — 1A's patch note of 2026-09-30). Every field
 *  optional on the way in: a host that lacks one leaves its control out. */
export interface Rail {
  engine?: string;
  provider?: string;
  model?: string;
  /** The models the picker offers (item 272, the host's `model-list.json`);
   *  absent from an older host, which leaves the built-in aliases. */
  models?: string[];
  effort?: string;
  fallback?: string;
  thinking?: string;
  limits?: SubagentLimits;
  approval?: boolean;
  ask?: boolean;
  plan?: boolean;
  subagents_auto?: boolean;
  fork_mode?: boolean;
  council?: { seats: CouncilSeat[]; mode: "answer" | "disproof" } | null;
  /** Read-only: the Mac's connection after the change. */
  connected?: boolean;
  connecting?: boolean;
  /** The change waits for the running turn and connects after it. */
  deferred?: boolean;
  error?: string | null;
}
/** `POST /api/rail`: merged into the Mac's rail, which then reconnects.
 *  `limits` is partial — only the named limits change. An empty patch is
 *  a 400. */
export type RailPatch = Partial<
  Pick<Rail, "engine" | "model" | "effort" | "fallback" | "thinking" | "ask" | "plan" | "subagents_auto" | "fork_mode" | "council">
> & { limits?: Partial<SubagentLimits> };

/** One row of `GET /api/running` (`RunningChat` in `api.rs`). */
export interface RunningChat {
  /** Null for a new chat not yet on disk. */
  chat: string | null;
  project?: string | null;
  title: string;
  /** When its turn started, unix milliseconds. */
  since: number | null;
  /** The chat on the Mac's screen. */
  on_screen?: boolean;
  /** Its unanswered approval prompts. */
  waiting?: number;
}
export interface Running {
  chats: RunningChat[];
  /** The host's own shapes, passed through; the Mac sends none of the
   *  last three yet. */
  subagents?: unknown;
  budget?: unknown;
  asides?: unknown[];
  dream?: unknown | null;
  capture?: unknown | null;
}

/** The plan's windows (`PlanUsage` in the service crate): percent used. */
export interface PlanUsage {
  five_hour: number | null;
  seven_day: number | null;
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
  /** Read from an old sample: the line greys out. */
  stale?: boolean;
  source?: string;
}
/** `GET /api/usage`. */
export interface Usage {
  plan: PlanUsage;
  ledger?: unknown;
}

/** A council turn's request (the desktop's `CouncilRequest`, council.ts). */
export interface CouncilSend {
  seats: CouncilSeat[];
  mode: "answer" | "disproof";
  /** Empty: the backend reads the last council turn's areas itself. */
  areas?: string[];
}

/** What a send carries besides its text (design §4 `SendRequest`). */
export interface SendExtras {
  project?: string | null;
  images?: ImageInput[];
  /** Item 277: a PDF, a text file as `text/plain`, or an office file as
   *  it was — the server puts its text in its place. */
  documents?: DocumentInput[];
  spoken?: boolean;
  /** Wave 2C: the message goes to a council of seats, not one model. */
  council?: CouncilSend | null;
  /** Wave 4 C1: the same on every try of one message, so a try after a
   *  lost reply is answered, not run again ([`nonceFor`]). */
  nonce?: string;
}

/** A fresh nonce: 32 hex digits. `crypto.getRandomValues`, not
 *  `randomUUID` — the page is plain HTTP over the tailnet, where
 *  `randomUUID` (secure contexts only) is absent. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One message's tries (wave 4 C1): `key` names the message (its chat or
 *  project and its text), `nonce` rides on every try of it. */
export interface Try {
  key: string;
  nonce: string;
}

/** The try for `key`: the last one again when it was this message (a try
 *  after a failure that may have been a lost reply), else a fresh one. */
export function nonceFor(last: Try | null, key: string): Try {
  return last && last.key === key ? last : { key, nonce: newNonce() };
}

/** The body of a send: absent fields are left out, so a pass-1 listener
 *  that knows only `text` reads it as before. */
export function sendBody(text: string, extras: SendExtras = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { text };
  if (extras.project) body.project = extras.project;
  if (extras.images && extras.images.length > 0) body.images = extras.images;
  if (extras.documents && extras.documents.length > 0) body.documents = extras.documents;
  if (extras.spoken) body.spoken = true;
  if (extras.council) body.council = { seats: extras.council.seats, mode: extras.council.mode, areas: extras.council.areas ?? [] };
  if (extras.nonce) body.nonce = extras.nonce;
  return body;
}

// ---- wave 2C: notes, search, projects, asides, council ----------------------------

/** The note scopes the Mac's editor reaches (`NOTE_SCOPES` in `api.rs`). */
export type NoteScope = "project" | "knowledge" | "instructions" | "memory" | "models" | "chat";

/** The fixed-file scopes: one file each, read and written, never listed or
 *  deleted (the desktop's `NoteScope::fixed_name`). */
export const FIXED_NOTES: Partial<Record<NoteScope, string>> = {
  instructions: "AGENTS.md",
  memory: "AGENTS.md",
  chat: "CHAT.md",
};

/** One row of `GET /api/notes?scope=` (`project::Note`). */
export interface NoteRow {
  /** The path under the scope, `/`-separated. */
  name: string;
  bytes: number;
  modified: string;
  /** First heading or line; null for a file that is not text. */
  summary: string | null;
}

/** A note's address in the route: each path segment escaped, the `/`
 *  between them kept (the listener's `{*name}`). */
export function notePath(scope: NoteScope, name: string): string {
  return `/notes/${encodeURIComponent(scope)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** Why a new note's name will not do, or null. The listener refuses an
 *  empty or `..` segment; a name without an extension gets `.md`. */
export function noteNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "A note needs a name.";
  if (n.split("/").some((s) => !s.trim() || s === "..")) return "A name cannot have an empty or “..” part.";
  return null;
}

export function noteFileName(name: string): string {
  const n = name.trim().replace(/\s*\/\s*/g, "/");
  return /\.[a-z0-9]+$/i.test(n) ? n : `${n}.md`;
}

/** The last part of a note's path, without `.md`, for a row's title. */
export function noteTitle(name: string): string {
  const leaf = name.split("/").pop() ?? name;
  return leaf.replace(/\.md$/i, "");
}

/** `GET /api/search`'s answer (`store::search::SearchResult`). */
export interface SearchHit {
  index: number;
  who: string;
  at: string;
  before: string;
  matched: string;
  after: string;
  matches: number;
}
export interface SearchChatGroup {
  id: string;
  /** `SessionSummary`, flattened: his name for it, else his first line. */
  title?: string | null;
  first_user?: string | null;
  project?: { id: string; name: string } | null;
  hits: number;
  rows: SearchHit[];
}
export interface SearchNoteGroup {
  scope: string;
  name: string;
  modified: string;
  hits: number;
  rows: { line: number; before: string; matched: string; after: string; matches: number }[];
}
export interface SearchResult {
  matches: number;
  messages: number;
  chats: number;
  shown: number;
  elapsed_ms: number;
  groups: SearchChatGroup[];
  notes: SearchNoteGroup[];
}
export type SearchScope = "this" | "all" | "notes";

/** A group's name as the drawer shows it: the chat's label, else its id. */
export function searchGroupLabel(g: SearchChatGroup): string {
  for (const t of [g.title, g.first_user]) if (typeof t === "string" && t.trim()) return t.trim().replace(/\s+/g, " ");
  return "Untitled chat";
}

/** The count line under the search box: "14 matches in 4 chats · 2 notes". */
export function searchSummary(r: SearchResult | null): string {
  if (!r) return "";
  if (r.matches === 0) return "No matches.";
  const parts = [`${r.matches} match${r.matches === 1 ? "" : "es"}`];
  if (r.groups.length > 0) parts.push(`in ${r.groups.length} chat${r.groups.length === 1 ? "" : "s"}`);
  if (r.notes.length > 0) parts.push(`${r.notes.length} note${r.notes.length === 1 ? "" : "s"}`);
  return parts.join(" · ").replace(" · in ", " in ");
}

// ---- asides -------------------------------------------------------------------
// The Mac's shapes, from 2A's patch note (`246w2-patch-p2a-to-p2c.md`, current version ~4:25 AM:
// 2C's first proposal with 2A's differences). The first version's `op` / threads shapes are
// still read, so either host build works.

/** One aside exchange as the page holds it: the question, the answer so
 *  far, and whether it has ended (well, stopped, or failed). */
export interface Aside {
  chat: string;
  /** The exchange's number (the 202's), which its `aside-event`s carry. */
  seq: number;
  /** The Mac's card it is on (for Stop). */
  thread: number | null;
  question: string;
  answer: string;
  state: "asking" | "done" | "failed";
  error?: string;
}

/** `POST /api/chats/{id}/aside`'s 202. */
export interface AsideStarted {
  chat: string;
  thread: number | null;
  seq: number | null;
}

/** An `aside-event` from the stream: a piece of an answer (sent for every
 *  aside on the Mac, his own included), or the end of one asked from a
 *  phone. The desktop's bare `aside-delta` (`{seq, text}`) reads as a
 *  delta. Null for a payload the page cannot read. */
export type AsideEvent =
  | { kind: "delta"; seq: number; text: string }
  | { kind: "done"; seq: number; answer: string | null; error: string | null; cancelled: boolean };
// (An `error` event — `{kind: "error", seq, error, answer, cancelled}` — is
// read as a `done` with its `error` set.)

export function parseAsideEvent(data: string): AsideEvent | null {
  let v: Record<string, unknown>;
  try {
    const o: unknown = JSON.parse(data);
    if (!o || typeof o !== "object") return null;
    v = o as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v.seq !== "number") return null;
  const seq = v.seq;
  const kind = typeof v.kind === "string" ? v.kind : "delta";
  if (kind === "delta" && typeof v.text === "string") return { kind, seq, text: v.text };
  if (kind === "done" || kind === "error")
    return {
      kind: "done",
      seq,
      answer: typeof v.answer === "string" ? v.answer : null,
      error: typeof v.error === "string" && v.error.trim() ? v.error : kind === "error" ? "The aside failed." : null,
      cancelled: v.cancelled === true,
    };
  return null;
}

/** Fold one event into the exchange with its `seq`; any other leaves it
 *  as it was. The end's whole `answer` replaces the deltas (a lost delta
 *  is healed); a stop keeps what had arrived. */
export function foldAside(a: Aside, ev: AsideEvent): Aside {
  if (ev.seq !== a.seq) return a;
  if (ev.kind === "delta") return a.state === "asking" ? { ...a, answer: a.answer + ev.text } : a;
  const answer = ev.answer && ev.answer.trim() ? ev.answer : a.answer;
  if (ev.cancelled) return { ...a, answer, state: "failed", error: "Stopped — what had arrived is kept." };
  if (ev.error) return { ...a, answer, state: "failed", error: ev.error };
  return { ...a, answer, state: "done" };
}

/** One thread of `GET /api/chats/{id}/asides` (oldest first; open threads,
 *  then closed ones). */
export interface AsideThread {
  id: number | null;
  key?: string | null;
  open: boolean;
  name?: string | null;
  quote?: string | null;
  turns: { seq: number | null; question: string; answer: string; error?: string | null; cancelled?: boolean; asking?: boolean }[];
}

/** An earlier exchange, for the sheet's list. */
export interface PastAside {
  seq: number | null;
  question: string;
  answer: string;
  thread: string;
}

/** One row of the flat list 2A serves (current version): Past threads
 *  first (oldest closed first), then the open cards' exchanges. */
export interface AsideRow {
  seq?: number | null;
  question: string;
  answer: string;
  at?: string | null;
  thread?: number | null;
  key?: string | null;
  open?: boolean;
  name?: string | null;
  error?: string | null;
  cancelled?: boolean;
  asking?: boolean;
}

/** The exchanges, newest first, without `skip` (the one on the sheet's
 *  card) and without any still asking. Reads 2A's flat rows or its first
 *  version's threads. */
export function pastAsides(list: (AsideThread | AsideRow)[], skip: number | null = null): PastAside[] {
  if (!Array.isArray(list)) return [];
  const threads: AsideThread[] = list.map((x) =>
    "turns" in x && Array.isArray(x.turns)
      ? x
      : {
          id: (x as AsideRow).thread ?? null,
          open: (x as AsideRow).open ?? (x as AsideRow).thread != null,
          name: (x as AsideRow).name ?? null,
          turns: [
            {
              seq: (x as AsideRow).seq ?? null,
              question: (x as AsideRow).question,
              answer: (x as AsideRow).answer,
              error: (x as AsideRow).error ?? null,
              asking: (x as AsideRow).asking,
            },
          ],
        },
  );
  const out: PastAside[] = [];
  threads.forEach((t, i) => {
    const label = t.name?.trim() || (t.open ? "Open card" : "Closed thread");
    void i;
    for (const turn of t.turns) {
      if (turn.asking || (skip !== null && turn.seq === skip)) continue;
      out.push({ seq: turn.seq, question: turn.question, answer: turn.answer || turn.error || "", thread: label });
    }
  });
  return out.reverse();
}

// ---- council ------------------------------------------------------------------

export const COUNCIL_MODELS = ["fable", "opus", "sonnet", "haiku"];
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

/** Whether `seats` make a council the listener takes. */
export function councilProblem(seats: CouncilSeat[]): string | null {
  if (seats.length < MIN_SEATS) return `A council needs at least ${MIN_SEATS} seats.`;
  if (seats.length > MAX_SEATS) return `A council has at most ${MAX_SEATS} seats.`;
  if (seats.some((s) => s.engine === "api")) return "An API-engine seat cannot sit on a council yet.";
  return null;
}

// ---- gestures (pass 1's leftovers: swipe and pull) -------------------------------

/** How far a pull or a drag must go, in CSS px, before letting go acts. */
export const PULL_AT = 70;
export const DISMISS_AT = 110;
/** A touch this close to the left edge may open the drawer. */
export const EDGE = 24;

/** A drag's shown distance: the finger's, damped past `at` so it slows. */
export function damp(d: number, at = PULL_AT): number {
  if (d <= 0) return 0;
  return d <= at ? d : at + (d - at) * 0.35;
}

/** Whether a horizontal drag from `x0` that moved (`dx`, `dy`) opens the
 *  drawer (from the edge, rightward, more across than down) or closes it. */
export function swipeVerdict(x0: number, dx: number, dy: number, open: boolean): "open" | "close" | null {
  if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.7) return null;
  if (!open && x0 <= EDGE && dx > 0) return "open";
  if (open && dx < 0) return "close";
  return null;
}

/** Whether a sheet let go after a `dy` drag down in `ms` dismisses it: past
 *  `DISMISS_AT`, or a flick (fast and more than 30 px). */
export function dismissVerdict(dy: number, ms: number): boolean {
  if (dy >= DISMISS_AT) return true;
  return dy > 30 && ms > 0 && dy / ms > 0.6;
}

// ---- drafts for the sheets' editors (practices §7) -----------------------------------

export const NOTE_DRAFTS_KEY = "nightloom.remote.notedrafts";

/** A note being edited on the phone: his text, and the note's text when he
 *  began (so a reopen can say the Mac's copy changed since). For a new
 *  note `name` is what he typed as its name. */
export interface NoteDraft {
  text: string;
  base: string;
  name?: string;
}

/** The key of a note's draft: `<scope>/<name>`, or `new:<scope>`. */
export function noteDraftKey(scope: NoteScope, name: string | null): string {
  return name === null ? `new:${scope}` : `${scope}/${name}`;
}

function readNoteDrafts(): Record<string, NoteDraft> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NOTE_DRAFTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, NoteDraft>) : {};
  } catch {
    return {};
  }
}

export function loadNoteDraft(key: string): NoteDraft | null {
  const d = readNoteDrafts()[key];
  return d && typeof d === "object" && typeof d.text === "string" ? { text: d.text, base: typeof d.base === "string" ? d.base : "", ...(typeof d.name === "string" ? { name: d.name } : {}) } : null;
}

/** `null` drops the draft (Save, or a confirmed Discard); so does a draft
 *  that says nothing new (its text is the note's and no name was typed). */
export function saveNoteDraft(key: string, draft: NoteDraft | null): void {
  const all = readNoteDrafts();
  if (draft && (draft.text !== draft.base || (draft.name ?? "").trim())) all[key] = draft;
  else delete all[key];
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(NOTE_DRAFTS_KEY);
    else localStorage.setItem(NOTE_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // Storage off: the draft lives in the sheet's state only.
  }
}

/** The keys with a kept draft, for the list's "draft kept" marks. */
export function noteDraftKeys(): string[] {
  return Object.keys(readNoteDrafts());
}

/** One row of `/api/chats` — `ChatRow` in the service crate. */
export interface ChatRow {
  id: string;
  label: string;
  modified: string;
  user_turns: number;
  kind: string;
  mode: string;
}

/** One row of `/api/projects` — `ProjectRow` in the service crate. */
export interface ProjectRow {
  id: string;
  name: string;
  /** The project open on the Mac. */
  active: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The host that answered (`Client.base`). */
    public base = "",
  ) {
    super(message);
  }
}

/** Thrown when the host could not be reached at all — the queue's cue.
 *  `base` says which host (wave 3: the page knows two). */
export class Unreachable extends Error {
  constructor(
    message: string,
    public base = "",
  ) {
    super(message);
  }
}

export class Client {
  /** `base`: the host's origin (`hosts.ts`); empty is the page's own. */
  constructor(
    public token: string,
    public base = "",
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/api${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        cache: "no-store",
      });
    } catch (e) {
      throw new Unreachable(String(e), this.base);
    }
    if (!r.ok) throw new ApiError(r.status, (await r.text()) || r.statusText, this.base);
    return r;
  }

  /** `signal`: the host choice's 1.5 s deadline (`hosts.ts`). */
  async state(signal?: AbortSignal): Promise<RemoteState> {
    return (await this.call("/state", signal ? { signal } : {})).json();
  }

  /** The open project's chats, or `project`'s (item 246's drawer). */
  async chats(project: string | null = null): Promise<ChatRow[]> {
    return (await this.call(project ? `/projects/${encodeURIComponent(project)}/chats` : "/chats")).json();
  }

  async projects(): Promise<ProjectRow[]> {
    return (await this.call("/projects")).json();
  }

  /** A new chat on the Mac, in `project` or the open one (item 246). */
  async newChat(
    project: string | null,
    text: string,
    images: ImageInput[] = [],
    nonce?: string,
    documents: DocumentInput[] = [],
  ): Promise<"sent" | "queued"> {
    const r = await this.call("/new", {
      method: "POST",
      body: JSON.stringify({ ...sendBody(text, { images, nonce, documents }), project }),
    });
    return parseSendReply(await r.text());
  }

  /** One of the Mac's actions on a chat (design §4 `act`). `project` is
   *  the chat's project when the Mac has another open (blocker 665: the
   *  Mac opens it first); the query is ignored by a host that finds chats
   *  by id alone. A 409 is the host's sentence for refusing. */
  async act(chat: string, action: ChatAction, project: string | null = null): Promise<ActReply> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const r = await this.call(`/chats/${encodeURIComponent(chat)}/act${q}`, { method: "POST", body: JSON.stringify(action) });
    return r.json();
  }

  async rail(): Promise<Rail> {
    return (await this.call("/rail")).json();
  }

  /** Merge `patch` into the Mac's rail; the reply is the rail after. */
  async setRail(patch: RailPatch): Promise<Rail> {
    const r = await this.call("/rail", { method: "POST", body: JSON.stringify(patch) });
    const body = await r.text();
    try {
      return JSON.parse(body) as Rail;
    } catch {
      // A bare 2xx: read the rail as it now stands.
      return this.rail();
    }
  }

  async running(): Promise<Running> {
    return (await this.call("/running")).json();
  }

  async usage(): Promise<Usage> {
    return (await this.call("/usage")).json();
  }

  // ---- wave 2B's patch note (246w2-patch-p2b-to-p2c, ~4:15 AM) ----

  /** A chat's Context page (design §4 `context`): the view, its layers,
   *  any held layer change. `project` as `act`'s. */
  async context(chat: string, project: string | null = null): Promise<ContextReply> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    return (await this.call(`/chats/${encodeURIComponent(chat)}/context${q}`)).json();
  }

  /** Remove (`remove: true`) or restore the items at these log indexes;
   *  the reply is the view after. */
  async editContext(chat: string, targets: number[], remove: boolean, project: string | null = null): Promise<WireView> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const r = await this.call(`/chats/${encodeURIComponent(chat)}/context${q}`, { method: "POST", body: JSON.stringify({ targets, remove }) });
    return r.json();
  }

  /** A layer switch, a layer's own text (`null`: the file again), or a
   *  held change's choice; the reply is the context after. */
  async layers(chat: string, change: LayerChange, project: string | null = null): Promise<ContextReply> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const r = await this.call(`/chats/${encodeURIComponent(chat)}/layers${q}`, { method: "POST", body: JSON.stringify(change) });
    return r.json();
  }

  // ---- wave 2C ----

  async notes(scope: NoteScope): Promise<NoteRow[]> {
    return (await this.call(`/notes?scope=${encodeURIComponent(scope)}`)).json();
  }

  async readNote(scope: NoteScope, name: string): Promise<string> {
    const v = (await (await this.call(notePath(scope, name))).json()) as { text?: unknown };
    return typeof v?.text === "string" ? v.text : "";
  }

  async writeNote(scope: NoteScope, name: string, text: string): Promise<void> {
    await this.call(notePath(scope, name), { method: "PUT", body: JSON.stringify({ text }) });
  }

  /** To the Mac's trash, never gone (the listener's `note_delete`). */
  async deleteNote(scope: NoteScope, name: string): Promise<void> {
    await this.call(notePath(scope, name), { method: "DELETE" });
  }

  async search(q: string, scope: SearchScope, signal?: AbortSignal): Promise<SearchResult> {
    return (await this.call(`/search?q=${encodeURIComponent(q)}&scope=${scope}`, { signal })).json();
  }

  /** Start the Mac's dream or capture pass (wave 5): 202 `{status:"started"}`; a 409 is why not
   *  ("a dream is already running"); a 501 is a host without it (the away server). */
  async pass(kind: "dream" | "capture"): Promise<void> {
    await this.call(`/${kind}`, { method: "POST" });
  }

  /** A new project by name in the Mac's projects folder (no folder
   *  picker from the phone, blocker 666). */
  async newProject(name: string, instructions: string | null): Promise<ProjectRow> {
    const body: Record<string, unknown> = { name };
    if (instructions && instructions.trim()) body.instructions = instructions;
    return (await this.call("/projects", { method: "POST", body: JSON.stringify(body) })).json();
  }

  /** Ask an aside on `chat` (no `thread`: as the Mac's composer does, the
   *  newest answered card continues, else a new one opens). 202 with the
   *  exchange's number; the answer streams as `aside-event`s. */
  async aside(chat: string, text: string, project: string | null = null, thread: number | null = null): Promise<AsideStarted> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const body: Record<string, unknown> = { text };
    if (thread !== null) body.thread = thread;
    const r = await this.call(`/chats/${encodeURIComponent(chat)}/aside${q}`, { method: "POST", body: JSON.stringify(body) });
    const v = (await r.json()) as Partial<AsideStarted>;
    return { chat: typeof v.chat === "string" ? v.chat : chat, thread: typeof v.thread === "number" ? v.thread : null, seq: typeof v.seq === "number" ? v.seq : null };
  }

  /** Stop a running exchange (the Mac's × on its card); 409 when it is
   *  no longer answering. */
  async stopAside(chat: string, seq: number): Promise<void> {
    await this.call(`/chats/${encodeURIComponent(chat)}/aside/cancel`, { method: "POST", body: JSON.stringify({ seq }) });
  }

  async asides(chat: string): Promise<(AsideThread | AsideRow)[]> {
    return (await this.call(`/chats/${encodeURIComponent(chat)}/asides`)).json();
  }

  async rename(chat: string, title: string): Promise<void> {
    await this.call(`/chats/${encodeURIComponent(chat)}/rename`, { method: "POST", body: JSON.stringify({ title }) });
  }

  /** Open `chat` in the Mac's window. */
  async open(chat: string): Promise<void> {
    await this.call(`/chats/${encodeURIComponent(chat)}/open`, { method: "POST" });
  }

  /** A chat's log — in `project` when it is not the one open on the Mac. */
  async transcript(id: string, project: string | null = null): Promise<SessionEvent[]> {
    const base = project ? `/projects/${encodeURIComponent(project)}` : "";
    return (await this.call(`${base}/chats/${encodeURIComponent(id)}/transcript`)).json();
  }

  /** 202: the turn runs on the Mac — or, `"queued"`, waits behind the one
   *  running in that chat and goes when it ends (backlog 132). A 409 is
   *  the desktop's sentence for not taking it, and the text is ours to
   *  keep. */
  async send(chat: string | null, text: string, extras: SendExtras = {}): Promise<"sent" | "queued"> {
    const path = chat ? `/chats/${encodeURIComponent(chat)}/send` : "/send";
    const r = await this.call(path, { method: "POST", body: JSON.stringify(sendBody(text, extras)) });
    return parseSendReply(await r.text());
  }

  async approve(req: {
    id: string;
    name: string;
    decision: "allow" | "always" | "deny";
    reason?: string;
    answer?: unknown;
    then?: "ask" | "auto";
  }): Promise<void> {
    await this.call("/approve", { method: "POST", body: JSON.stringify(req) });
  }

  /** Stop `chat`'s turn — the chat this page shows, which need not be the
   *  one on the Mac's screen (backlog 159, A3) — or the Mac's open chat's
   *  when `null`. */
  async cancel(chat: string | null = null): Promise<void> {
    const path = chat ? `/chats/${encodeURIComponent(chat)}/cancel` : "/cancel";
    await this.call(path, { method: "POST" });
  }

  /**
   * The event stream, read with `fetch` rather than `EventSource` because
   * the latter cannot send a header and the token must not go in the URL.
   * Resolves when the stream ends (the listener went off, or the network
   * dropped); the caller reconnects.
   */
  async events(onEvent: (name: string, data: string) => void, signal?: AbortSignal): Promise<void> {
    const r = await this.call("/events", { headers: { Accept: "text/event-stream" }, signal });
    if (!r.body) throw new Unreachable("no stream body", this.base);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev.name, ev.data);
    }
  }
}

// ---- the stream's parser -------------------------------------------------

export interface SseEvent {
  name: string;
  data: string;
}

/**
 * Server-sent events, the wire format only: `event:` and `data:` lines,
 * a blank line ends one event, `:` lines are comments (the keep-alive).
 * Several `data:` lines join with newlines, as the spec says.
 */
export class SseParser {
  private buf = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const at = this.buf.search(/\r?\n\r?\n/);
      if (at < 0) break;
      const block = this.buf.slice(0, at);
      this.buf = this.buf.slice(at).replace(/^\r?\n\r?\n/, "");
      let name = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0 || name !== "message") out.push({ name, data: data.join("\n") });
    }
    return out;
  }
}

// ---- the live turn --------------------------------------------------------

export interface ToolRow {
  id: string;
  name: string;
  /** One line of the call's input: a command, a path, a query. */
  summary: string;
  /** `null` while running; then whether it succeeded. */
  ok: boolean | null;
  /** Rows of a subagent's own turn, under the `Agent` call that spawned it. */
  children: ToolRow[];
  /** Where the call lives in the log (a transcript row's, not a live
   *  turn's): the reply event and its block, for the per-block menu. */
  index?: number;
  block?: number;
  /** Out of the context (`elide` with this block, or the whole reply). */
  removed?: boolean;
  /** A subagent's recorded narrative under its `Agent` call (300 A1): the
   *  `<subagent parent=…>` block's body, one line per call and result. */
  steps?: string;
  /** A live turn's call: how much of the reply's text came before it, so
   *  the card sits between the words around it (300 A2). */
  textAt?: number;
}

/** The reply as it streams: text so far and the calls made, in order. */
export interface LiveTurn {
  text: string;
  tools: ToolRow[];
  /** The model compacted mid-turn; the transcript re-reads at the end. */
  compacted: boolean;
}

export function emptyTurn(): LiveTurn {
  return { text: "", tools: [], compacted: false };
}

/** One line of a tool call's input, the way the desktop's row reads it. */
export function toolSummary(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  let s = "";
  switch (name) {
    case "Bash":
      s = pick("command");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s = pick("file_path", "path", "notebook_path");
      break;
    case "Grep":
    case "Glob":
      s = pick("pattern");
      break;
    case "WebFetch":
      s = pick("url");
      break;
    case "WebSearch":
      s = pick("query");
      break;
    case "Agent":
    case "Task":
      s = pick("description", "prompt");
      break;
    default:
      s = pick("command", "path", "file_path", "pattern", "query", "url", "description", "prompt");
  }
  s = s.replace(/\s+/g, " ");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

function findTool(rows: ToolRow[], id: string): ToolRow | null {
  for (const r of rows) {
    if (r.id === id) return r;
    const c = findTool(r.children, id);
    if (c) return c;
  }
  return null;
}

/**
 * Fold one `turn-event` into the live turn. Returns a new object so a
 * Svelte state assignment sees the change. Events the phone does not draw
 * (thinking, usage, the CLI's init line, the prompt suggestion) leave it
 * as it was.
 */
export function foldTurnEvent(live: LiveTurn, ev: TurnEvent): LiveTurn {
  switch (ev.type) {
    case "text_delta":
      return { ...live, text: live.text + ev.text };
    case "tool_call":
      return {
        ...live,
        tools: [...live.tools, { id: ev.id, name: ev.name, summary: toolSummary(ev.name, ev.input), ok: null, children: [], textAt: live.text.length }],
      };
    case "tool_result": {
      const tools = structuredClone(live.tools);
      const row = findTool(tools, ev.tool_use_id);
      if (row) row.ok = !ev.is_error;
      return { ...live, tools };
    }
    case "tool_denied": {
      const tools = structuredClone(live.tools);
      const row = findTool(tools, ev.tool_use_id);
      if (row) row.ok = false;
      return { ...live, tools };
    }
    case "compacted":
      return { ...live, compacted: true };
    case "subagent": {
      const tools = structuredClone(live.tools);
      const parent = findTool(tools, ev.parent_tool_use_id);
      if (!parent) return live;
      const inner = foldTurnEvent({ text: "", tools: parent.children, compacted: false }, ev.event);
      parent.children = inner.tools;
      return { ...live, tools };
    }
    default:
      return live;
  }
}

// ---- the transcript ---------------------------------------------------------

/** One text block of a reply as the phone draws it: where it lives in the
 *  log (the event and its block, which the per-block menu acts on), what
 *  it says now, and whether it is out of the context. */
export interface TextPart {
  index: number;
  block: number;
  text: string;
  removed: boolean;
  edited: boolean;
}

/** One piece of a reply in the order it happened (300 A2): its words and
 *  its calls interleave as the Mac draws them, a run of calls one box. */
export type Seg = { kind: "text"; part: TextPart } | { kind: "tools"; tools: ToolRow[] };

/** Append `seg` to `seq`, a run of calls joining the run before it. */
function pushSeg(seq: Seg[], seg: Seg): void {
  const last = seq[seq.length - 1];
  if (seg.kind === "tools" && last?.kind === "tools") last.tools.push(...seg.tools);
  else seq.push(seg.kind === "tools" ? { kind: "tools", tools: [...seg.tools] } : seg);
}

/** The live turn in order (300 A2): text up to each call, the call, the
 *  rest — each call's `textAt` says where it came. */
export function liveSegments(live: LiveTurn): ({ kind: "text"; text: string } | { kind: "tools"; tools: ToolRow[] })[] {
  const out: ({ kind: "text"; text: string } | { kind: "tools"; tools: ToolRow[] })[] = [];
  let at = 0;
  for (const t of live.tools) {
    const cut = Math.min(Math.max(t.textAt ?? at, at), live.text.length);
    const words = live.text.slice(at, cut);
    if (words.trim()) out.push({ kind: "text", text: words });
    at = cut;
    const last = out[out.length - 1];
    if (last?.kind === "tools") last.tools.push(t);
    else out.push({ kind: "tools", tools: [t] });
  }
  const rest = live.text.slice(at);
  if (rest.trim()) out.push({ kind: "text", text: rest });
  return out;
}

export type Row =
  | {
      kind: "user";
      text: string;
      at: string;
      /** The event's index in the log — what an action names. */
      index: number;
      removed: boolean;
      edited: boolean;
      /** Photos sent with it. */
      images: number;
    }
  | {
      kind: "assistant";
      model: string;
      /** The text still in the context, joined. */
      text: string;
      tools: ToolRow[];
      at: string;
      /** Every reply event this row joins, in order. */
      indexes: number[];
      parts: TextPart[];
      /** Every event of the row is out of the context. */
      removed: boolean;
      /** Its words and calls in the order they happened (300 A2). */
      seq: Seg[];
    }
  | { kind: "note"; text: string; at: string };

/**
 * The edit and removal markers over the live events — the desktop's
 * `editTexts`, `blockEdits`, `elideFlags` and `blockElisions` (edit.ts),
 * restated here because edit.ts pulls in the desktop's state module,
 * which the phone's bundle must not carry. Same rules: live markers only,
 * the last word on an index wins; an `edit` of a reply with no `block`
 * names its first text block (or one past the last when it has none).
 */
export interface Markers {
  userText: Map<number, string>;
  blockText: Map<number, Map<number, string>>;
  removed: Set<number>;
  blocksGone: Map<number, Set<number>>;
}

export function markers(events: SessionEvent[], live = liveFlags(events)): Markers {
  const m: Markers = { userText: new Map(), blockText: new Map(), removed: new Set(), blocksGone: new Map() };
  events.forEach((e, i) => {
    if (!live[i]) return;
    if (e.event === "edit") {
      const t = events[e.target];
      if (t?.event === "user_message") m.userText.set(e.target, e.text);
      else if (t?.event === "assistant_message") {
        let block = e.block;
        if (block == null) {
          const first = t.blocks.findIndex((b) => b.type === "text");
          block = first >= 0 ? first : t.blocks.length;
        }
        const map = m.blockText.get(e.target) ?? new Map<number, string>();
        map.set(block, e.text);
        m.blockText.set(e.target, map);
      }
    } else if (e.event === "elide" || e.event === "unelide") {
      const on = e.event === "elide";
      if (e.block != null) {
        const t = e.targets[0];
        if (t == null) return;
        const set = m.blocksGone.get(t) ?? new Set<number>();
        if (on) set.add(e.block);
        else set.delete(e.block);
        m.blocksGone.set(t, set);
      } else {
        for (const t of e.targets) {
          if (on) m.removed.add(t);
          else m.removed.delete(t);
        }
      }
    }
  });
  return m;
}

/**
 * Which events are live after the log's rewind markers: a `rewind` at
 * index `i` with `to` supersedes `[to, i)`; an `unrewind` of `i` lifts it.
 * The desktop's `liveFlags` in full; this is its shape without the elide
 * and edit markers, which the phone draws through.
 */
export function liveFlags(events: SessionEvent[]): boolean[] {
  const live = events.map(() => true);
  const rewinds: { at: number; to: number }[] = [];
  events.forEach((e, i) => {
    if (e.event === "rewind") {
      rewinds.push({ at: i, to: e.to });
      for (let k = e.to; k < i; k++) live[k] = false;
      live[i] = false;
    } else if (e.event === "unrewind") {
      const r = rewinds.find((x) => x.at === e.of);
      if (r) for (let k = r.to; k < r.at; k++) live[k] = true;
      live[i] = false;
    }
  });
  return live;
}

/** The transcript as the phone draws it: one row per turn, tool calls as
 *  lines under the reply that made them, results matched by id. */
export function transcriptRows(events: SessionEvent[]): Row[] {
  const live = liveFlags(events);
  const mk = markers(events, live);
  const rows: Row[] = [];
  const byTool = new Map<string, ToolRow>();
  events.forEach((e, i) => {
    if (!live[i]) return;
    switch (e.event) {
      case "user_message": {
        const edit = mk.userText.get(i);
        rows.push({
          kind: "user",
          text: edit ?? e.text,
          at: e.at,
          index: i,
          removed: mk.removed.has(i),
          edited: edit !== undefined,
          images: e.images?.length ?? 0,
        });
        break;
      }
      case "assistant_message": {
        const parts: TextPart[] = [];
        const tools: ToolRow[] = [];
        const seq: Seg[] = [];
        const edits = mk.blockText.get(i);
        const gone = mk.blocksGone.get(i);
        const whole = mk.removed.has(i);
        // A council turn's seat answers and record (`<council-seat …>`,
        // `<council>`) fold on the Mac; the phone drew them as raw text and
        // JSON (246 wave 2 page walk). They leave the reply; a note row
        // after it says how many seats answered.
        let seats = 0;
        e.blocks.forEach((b, n) => {
          const sub = b.type === "text" && !whole ? parseSubagentBlock(b.text) : null;
          if (b.type === "text" && isCouncilBlock(b.text)) {
            if (b.text.startsWith("<council-seat ")) seats += 1;
          } else if (sub) {
            // A subagent's steps fold under the Agent call that spawned it
            // (300 A1; the desktop's Transcript does the same): never prose.
            const parent = byTool.get(sub.parent);
            if (parent) parent.steps = parent.steps ? `${parent.steps}\n${sub.body}` : sub.body;
            else {
              const row: ToolRow = { id: `sub:${i}.${n}`, name: "Agent", summary: "a subagent's steps", ok: true, children: [], index: i, block: n, removed: !!gone?.has(n), steps: sub.body };
              tools.push(row);
              pushSeg(seq, { kind: "tools", tools: [row] });
            }
          } else if (b.type === "text") {
            const edit = edits?.get(n);
            const part: TextPart = { index: i, block: n, text: edit ?? b.text, removed: whole || !!gone?.has(n), edited: edit !== undefined };
            parts.push(part);
            pushSeg(seq, { kind: "text", part });
          } else if (b.type === "tool_use") {
            const row: ToolRow = {
              id: b.id,
              name: b.name,
              summary: toolSummary(b.name, b.input),
              ok: null,
              children: [],
              index: i,
              block: n,
              removed: whole || !!gone?.has(n),
            };
            tools.push(row);
            pushSeg(seq, { kind: "tools", tools: [row] });
            byTool.set(b.id, row);
          }
        });
        // An edit that names one past the last block adds text to a reply
        // that had none (`blockEdits`' rule).
        const extra = edits?.get(e.blocks.length);
        if (extra !== undefined) {
          const part: TextPart = { index: i, block: e.blocks.length, text: extra, removed: whole, edited: true };
          parts.push(part);
          pushSeg(seq, { kind: "text", part });
        }
        const said = parts.filter((p) => !p.removed && p.text).map((p) => p.text);
        // Consecutive replies with no user turn between draw as one (the
        // desktop's backlog 121): the blocks join the row above.
        const last = rows[rows.length - 1];
        if (last && last.kind === "assistant") {
          last.text = [last.text, ...said].filter(Boolean).join("\n\n");
          last.tools.push(...tools);
          last.parts.push(...parts);
          for (const s of seq) pushSeg(last.seq, s);
          last.indexes.push(i);
          last.removed = last.removed && whole;
          last.at = e.at;
        } else {
          rows.push({ kind: "assistant", model: e.model, text: said.join("\n\n"), tools, at: e.at, indexes: [i], parts, removed: whole, seq });
        }
        if (seats > 0) rows.push({ kind: "note", text: `council — ${seats} ${seats === 1 ? "seat" : "seats"} answered; their answers fold on the Mac`, at: e.at });
        break;
      }
      case "tool_result": {
        const row = byTool.get(e.tool_use_id);
        if (row) row.ok = !e.is_error;
        break;
      }
      case "compaction":
        rows.push({ kind: "note", text: "compacted — earlier turns are summarised for the model", at: e.at });
        break;
      default:
        break;
    }
  });
  return rows;
}

// ---- the message menu (wave 1) ------------------------------------------------

/** The next live user message after `index`, or the log's length — where
 *  a rewind or a fork "after this reply" lands. */
export function nextUserIndex(events: SessionEvent[], index: number): number {
  const live = liveFlags(events);
  for (let i = index + 1; i < events.length; i++) if (live[i] && events[i].event === "user_message") return i;
  return events.length;
}

/**
 * Where "Rewind here" and "Fork here" point for a row, on the desktop's
 * terms (`rewind_to` and `fork_session` both take a user turn's index):
 * on his message, that message — a rewind drops it and everything after,
 * back into the box; a fork starts a chat that ends just before it. On a
 * reply, the next message of his — the reply is kept, what follows goes.
 * `null` where there is nothing after to drop (the last reply).
 */
export function rowTarget(events: SessionEvent[], row: Row): { rewind: number | null; fork: number | null } {
  if (row.kind === "user") return { rewind: row.index, fork: row.index };
  if (row.kind === "assistant") {
    const after = nextUserIndex(events, row.indexes[row.indexes.length - 1]);
    return { rewind: after < events.length ? after : null, fork: after };
  }
  return { rewind: null, fork: null };
}

/** The actions a whole row's Remove or Restore sends: one per event the
 *  row joins — a joined reply is several events. */
export function rowRemoval(row: Row, restore: boolean): ChatAction[] {
  const op = restore ? "restore" : "remove";
  if (row.kind === "user") return [{ op, index: row.index }];
  if (row.kind === "assistant") return row.indexes.map((index) => ({ op, index }));
  return [];
}

/** The edit a menu's Save or Send makes; `block` for a reply's text block. */
export function editAction(index: number, text: string, mode: EditMode, block: number | null = null): ChatAction {
  return { op: "edit", index, text, mode, block };
}

// ---- photos (wave 1) -----------------------------------------------------------

/** The long edge a photo is scaled to before it is sent: the size the
 *  model reads at full detail, and a body the listener takes (an iPhone
 *  photo is 3–5 MB, base64 a third more). */
export const PHOTO_EDGE = 1568;

/** The size a `w` × `h` photo is drawn at: at most `edge` on the long side,
 *  never scaled up, whole pixels. */
export function fitSize(w: number, h: number, edge = PHOTO_EDGE): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const k = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** `data:image/jpeg;base64,AAAA` → the wire's `ImageInput`. */
export function imageFromDataUrl(url: string): ImageInput | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  return m ? { media_type: m[1].toLowerCase(), data: m[2] } : null;
}

// ---- usage (wave 1) -------------------------------------------------------------

/** The drawer's plan line: "5-hour 42% · resets 4:10 AM · week 61%". */
export function usageLine(u: Usage | null): string {
  const p = u?.plan;
  if (!p) return "";
  const parts: string[] = [];
  if (p.five_hour != null) {
    parts.push(`5-hour ${Math.round(p.five_hour)}%`);
    const at = p.five_hour_resets_at ? new Date(p.five_hour_resets_at) : null;
    if (at && !Number.isNaN(at.getTime())) parts.push(`resets ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
  }
  if (p.seven_day != null) parts.push(`week ${Math.round(p.seven_day)}%`);
  if (parts.length > 0 && p.stale) parts.push("an old reading");
  return parts.join(" · ");
}

/** How long since `at` (unix ms or an ISO time), for the running sheet:
 *  "just now", "4 min", "2 h 5 min"; "" when unknown. */
export function sinceText(at: number | string | null, now = new Date()): string {
  if (at == null) return "";
  const t = typeof at === "number" ? at : new Date(at).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now.getTime() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

// ---- the queue ------------------------------------------------------------

/** A message typed while the Mac was unreachable or busy, waiting. */
export interface Queued {
  id: string;
  chat: string | null;
  text: string;
  at: string;
  /** The chat's project when the Mac had another open (blocker 665). */
  project?: string | null;
  /** The host whose chat it is (wave 3); absent (held before wave 3) is
   *  the Mac's. It is only ever sent to that host. */
  host?: "mac" | "away";
  /** The nonce its first try carried (wave 4 C1), so the held copy's
   *  send is recognised if that try reached the host after all. Absent
   *  (held before wave 4): the id stands in. */
  nonce?: string;
}

export function loadQueue(): Queued[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (q): q is Queued =>
        q !== null &&
        typeof q === "object" &&
        typeof (q as Queued).id === "string" &&
        typeof (q as Queued).text === "string" &&
        (q as Queued).text.trim() !== "",
    );
  } catch {
    return [];
  }
}

export function saveQueue(queue: Queued[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage off: the queue lives for this page load only.
  }
}

let seq = 0;
export function newQueued(
  chat: string | null,
  text: string,
  now = new Date(),
  project: string | null = null,
  host: "mac" | "away" | null = null,
  nonce: string | null = null,
): Queued {
  seq += 1;
  const q: Queued = { id: `${now.getTime().toString(36)}-${seq}`, chat, text, at: now.toISOString() };
  if (project) q.project = project;
  if (host) q.host = host;
  q.nonce = nonce ?? newNonce();
  return q;
}

// ---- the cards --------------------------------------------------------------

/** The card a prompt draws, by the tool the CLI paused on. */
export function cardKind(req: ApprovalRequest): "question" | "plan" | "call" {
  if (req.name === "AskUserQuestion") return "question";
  if (req.name === "ExitPlanMode") return "plan";
  return "call";
}

/**
 * The question form's answer: the input plus `answers`, question text →
 * the chosen labels joined with ", " and "Other" as typed — the shape
 * `ApprovalPrompt.svelte`'s `answerQuestions` sends.
 */
export function questionAnswer(
  input: unknown,
  picks: Record<number, string[]>,
  others: Record<number, string>,
): unknown {
  const qs = (input as { questions?: { question: string }[] } | null)?.questions ?? [];
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => {
    const chosen = [...(picks[i] ?? [])];
    const other = (others[i] ?? "").trim();
    if (other) chosen.push(other);
    answers[q.question] = chosen.join(", ");
  });
  return { ...(input as object), answers };
}

/** The plan card's "keep planning" reason, the desktop's own words. */
export const KEEP_PLANNING = "keep planning: the user wants changes to the plan";

/** The reconnect wait after `n` failures: 1 s, 2 s, 4 s, … capped at 15 s. */
export function backoffMs(n: number): number {
  return Math.min(15000, 1000 * 2 ** Math.max(0, Math.min(n, 4)));
}

/** The 202's body: `{"status":"queued"}` or `{"status":"sent"}`; a bare or
 *  unreadable body (a listener from before backlog 132) reads as sent. */
export function parseSendReply(body: string): "sent" | "queued" {
  try {
    const v = JSON.parse(body) as { status?: unknown };
    return v && v.status === "queued" ? "queued" : "sent";
  } catch {
    return "sent";
  }
}

// ---- drafts (item 246; practices §7) ----------------------------------------

/**
 * The composer's text per chat, kept in localStorage as he types, so a
 * reload, a tab the phone evicted, or a switch to another chat never loses
 * it, and a draft typed for one chat is never sent to another. The key is
 * the chat's id, or `new:<project>` for a chat not yet started.
 */
export function draftKey(chat: string | null, project: string | null): string {
  return chat ?? `new:${project ?? ""}`;
}

function readDrafts(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadDraft(key: string): string {
  const v = readDrafts()[key];
  return typeof v === "string" ? v : "";
}

/** An empty text removes the key rather than keeping a blank. */
export function saveDraft(key: string, text: string): void {
  const all = readDrafts();
  if (text.trim()) all[key] = text;
  else delete all[key];
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(DRAFTS_KEY);
    else localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // Storage off: the draft lives in the page's state only.
  }
}

/** A time for a row or a message, 12-hour: "4:05 PM" today, "Yesterday",
 *  a weekday within the week, else "Sep 21". */
export function shortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const days = (now.getTime() - d.getTime()) / 86400000;
  if (days < 7 && days > 0) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---- wave 3 B2: the missing buttons, the limit card, speak the reply --------

/** A clock time for him, 12-hour (practices §4): "3:10 AM"; another day's
 *  gets its date ("Oct 1, 3:10 AM"). */
export function clock12(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(nowMs).toDateString() ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${hm}`;
}

/** `limit_pause.resets_at` as unix ms, whatever form it came in; null
 *  when unknown or unreadable. Under 10^12 is seconds (the CLI's number). */
export function resetMs(at: number | string | null | undefined): number | null {
  if (at == null || at === "") return null;
  if (typeof at === "number") return Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : null;
  const n = Number(at);
  if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(at.trim())) return resetMs(n);
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/** The margin after the reset before a resume may go — the desktop's
 *  `RESUME_MARGIN_MS` (limit.ts): the clocks are two. */
export const RESUME_MARGIN_MS = 30_000;

/** The limit card on the phone (item 164): what it says and what its
 *  button says. `early`: the window has not reset yet, so Resume asks
 *  the host to schedule the continue for the reset — the page never
 *  sends anything sooner itself. */
export interface LimitCard {
  label: string;
  button: string;
  early: boolean;
  /** When the resume will go (the reset), ms; null when unknown. */
  at: number | null;
}

export function limitCard(p: LimitPauseWire, nowMs: number = Date.now()): LimitCard {
  const which = p.window === "seven_day" ? "weekly" : p.window === "five_hour" ? "5-hour" : "usage";
  const at = resetMs(p.resets_at);
  if (at == null) return { label: `Paused by the ${which} limit`, button: "Resume", early: false, at: null };
  const early = at + RESUME_MARGIN_MS > nowMs;
  const when = clock12(at, nowMs);
  return early
    ? { label: `Paused by the ${which} limit · resumes at ${when}`, button: `Resume at ${when}`, early, at }
    : { label: `Paused by the ${which} limit · the window has reset`, button: "Resume", early, at };
}

/** What Resume sends: always the host's own resume, which schedules it
 *  for the reset when early (never a plain message from the page). */
export function resumeAction(): ChatAction {
  return { op: "resume_limit" };
}

/** The chat actions wave B adds buttons for. On the Mac `act` carries
 *  every op; serve names each op it serves in `features` (B1: "truthfully
 *  absent" until it does), so a missing name there greys the button. */
export type ExtraOp = "compact" | "checkpoint" | "budget" | "resume_limit";

export function canOp(state: RemoteState, op: ExtraOp): boolean {
  if (!hasFeature(state, "act")) return false;
  return state.host !== "serve" || hasFeature(state, op);
}

/** The budget hook's ledger as `/api/running.budget` carries it (the
 *  desktop's `TurnBudget`); only the fields the phone reads. */
export interface BudgetLedger {
  budget_pct: number;
  stop_at: number;
  start_pct: number | null;
  latest_pct: number | null;
  resets_at: number | null;
  pending_since_ms?: number | null;
  holds?: number[];
}

/** A call is held at the stop line for his answer — the desktop's
 *  `heldNow` (budget.ts): the pending mark, and a hold not yet past. */
export function budgetHeld(b: unknown, nowMs: number = Date.now()): BudgetLedger | null {
  if (!b || typeof b !== "object") return null;
  const l = b as BudgetLedger;
  if (!l.pending_since_ms) return null;
  const holds = Array.isArray(l.holds) ? l.holds : [];
  return holds.length === 0 || holds.some((d) => d > nowMs) ? l : null;
}

/** The Mac's stop card in words, 12-hour (backlog 189). */
export function budgetCard(l: BudgetLedger, nowMs: number = Date.now()): { title: string; detail: string } {
  const spent = l.start_pct != null && l.latest_pct != null ? Math.max(0, l.latest_pct - l.start_pct) : null;
  const detail = [
    l.latest_pct == null ? "" : `the window is at ${l.latest_pct}%`,
    spent == null ? "" : `this message has spent ${spent}% of its ${l.budget_pct}%`,
    l.resets_at ? `it resets at ${clock12(l.resets_at * 1000, nowMs)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { title: `Stopped at ${l.stop_at}% of the 5-hour window`, detail };
}

/** The budget card's three answers, as the Mac's card sends them. */
export function budgetAction(decision: "continue" | "wrap" | "stop"): ChatAction {
  return { op: "budget", decision, text: null };
}

export function checkpointAction(index: number): ChatAction {
  return { op: "checkpoint", index };
}

/** What a code block becomes when spoken — `split.rs`'s `CODE_ON_SCREEN`. */
export const CODE_ON_SCREEN = "I've put the code on screen.";

/** The text "Speak it" reads aloud: the last reply's prose as it stands in
 *  the context (removed parts left out, edits in), every fenced code block
 *  replaced by `CODE_ON_SCREEN` — once per reply, as `split.rs` does.
 *  Null when the chat ends without a reply to speak (his message last). */
export function speakText(events: SessionEvent[]): string | null {
  const rows = transcriptRows(events);
  let last: Row | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === "note") continue;
    last = r;
    break;
  }
  if (!last || last.kind !== "assistant") return null;
  const raw = last.parts
    .filter((p) => !p.removed && p.text)
    .map((p) => p.text)
    .join("\n\n");
  const out: string[] = [];
  let fence = false;
  let saidCode = false;
  for (const line of raw.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence && !saidCode) {
        out.push(CODE_ON_SCREEN);
        saidCode = true;
      }
      fence = !fence;
      continue;
    }
    if (!fence) out.push(line);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text ? text : null;
}

/** `claude-opus-5-5` → `opus 5.5` (the desktop's `shortModel`). */
export function shortModel(m: string | undefined | null): string {
  if (!m) return "";
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return x ? `${x[1]} ${x[2]}.${x[3]}` : m;
}

/** The line under a reply (as the Mac's model header and footer say it):
 *  "opus 5.5 · 1.2k tokens · $0.04". The figure is what the reply added
 *  to the context (`turnSizes`), else its output; the cost when recorded.
 *  "" for a reply with nothing recorded. */
export function replyLine(events: SessionEvent[], row: Row, sizes: (TurnSize | null)[]): string {
  if (row.kind !== "assistant") return "";
  let tokens = 0;
  let sized = false;
  let out = 0;
  let cost: number | null = null;
  for (const i of row.indexes) {
    const e = events[i];
    if (!e || e.event !== "assistant_message") continue;
    const s = sizes[i];
    if (s) {
      tokens += s.tokens;
      sized = true;
    }
    out += e.usage?.output_tokens ?? 0;
    if (typeof e.cost === "number") cost = (cost ?? 0) + e.cost;
  }
  const parts = [shortModel(row.model)];
  if (sized) parts.push(`${fmtTokens(tokens)} tokens`);
  else if (out > 0) parts.push(`${out.toLocaleString("en-US")} out`);
  if (cost != null) parts.push(cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);
  return parts.filter(Boolean).join(" · ");
}

/** Every event's size (`tokens.ts`), for `replyLine`. */
export function replySizes(events: SessionEvent[]): (TurnSize | null)[] {
  return turnSizes(events, liveFlags(events));
}

/** The log index "Checkpoint here" names for a message (the Mac's
 *  `setCheckpoint(index)`: a fork starts after the exchange it belongs
 *  to): his message's own index, a reply's last event. Null on a note. */
export function rowCheckpoint(row: Row): number | null {
  if (row.kind === "user") return row.index;
  if (row.kind === "assistant") return row.indexes.length > 0 ? row.indexes[row.indexes.length - 1] : null;
  return null;
}
