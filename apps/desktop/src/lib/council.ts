/**
 * The council (nightshift backlog 149, 2026-09-17): the front end's half.
 *
 * A council turn is one message of a chat on the Claude Code engine sent
 * through the composer's *Council* button: N seats (member processes,
 * each its own model) answer in parallel, then the chat's own model chairs
 * — its reply is the turn's reply, in four sections. The log keeps the
 * seats' answers as text blocks of the chair's message,
 * `<council-seat label="B" model="fable" …>…</council-seat>`, and one
 * `<council>{json}</council>` block with the record — the seat map, the
 * source overlap, the areas for next time (`nightloom-service/src/council.rs`).
 * This module reads those blocks, keeps the roster he set (the Settings
 * default, remembered per chat), and names the request the backend takes.
 */

import type { SessionEvent, Usage } from "./types";

export type SeatEngine = "subscription" | "api";
export type CouncilMode = "answer" | "disproof";

export interface Seat {
  model: string;
  engine: SeatEngine;
}

/** What `send_agent`'s `council` argument carries. */
export interface CouncilRequest {
  seats: Seat[];
  mode: CouncilMode;
  /** Areas to assign this turn; empty lets the backend read the last
   *  record's `areas_next` when its rule fired. */
  areas: string[];
}

/** The roster and mode as Settings → Council holds them and a chat
 *  remembers them. */
export interface CouncilPrefs {
  seats: Seat[];
  mode: CouncilMode;
}

/** The design's default (§1c, blocker 239): Opus + Fable + Opus. */
export const DEFAULT_COUNCIL: CouncilPrefs = {
  seats: [
    { model: "opus", engine: "subscription" },
    { model: "fable", engine: "subscription" },
    { model: "opus", engine: "subscription" },
  ],
  mode: "answer",
};

export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

const PREFS_KEY = "nightloom.council";

export function parseCouncilPrefs(raw: string | null): CouncilPrefs {
  if (!raw) return structuredClone(DEFAULT_COUNCIL);
  try {
    const p = JSON.parse(raw) as Partial<CouncilPrefs>;
    const seats = Array.isArray(p.seats)
      ? p.seats
          .filter((s): s is Seat => !!s && typeof s.model === "string" && s.model.length > 0)
          .map((s) => ({ model: s.model, engine: s.engine === "api" ? "api" : ("subscription" as SeatEngine) }))
      : [];
    return {
      seats: seats.length >= MIN_SEATS ? seats.slice(0, MAX_SEATS) : structuredClone(DEFAULT_COUNCIL.seats),
      mode: p.mode === "disproof" ? "disproof" : "answer",
    };
  } catch {
    return structuredClone(DEFAULT_COUNCIL);
  }
}

export function loadCouncilPrefs(): CouncilPrefs {
  try {
    return parseCouncilPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return structuredClone(DEFAULT_COUNCIL);
  }
}

export function saveCouncilPrefs(p: CouncilPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage may be unavailable; the default stands for the session.
  }
}

/** A roster line for a chip or a table: `opus + fable + opus`. */
export function rosterLabel(seats: readonly Seat[]): string {
  return seats.map((s) => s.model || "default").join(" + ");
}

// ---- the recorded blocks ------------------------------------------------

const SEAT_OPEN = "<council-seat ";
const SEAT_CLOSE = "</council-seat>";
const COUNCIL_OPEN = "<council>";
const COUNCIL_CLOSE = "</council>";

export interface CouncilSeatBlock {
  label: string;
  model: string;
  forked: boolean;
  searches: number;
  tokens: number;
  angle: string | null;
  area: string | null;
  error: string | null;
  /** The seat's answer, markdown. */
  body: string;
}

function unattr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/** The seat block a recorded text is, or null for ordinary prose. */
export function parseCouncilSeat(text: string): CouncilSeatBlock | null {
  if (!text.startsWith(SEAT_OPEN)) return null;
  const end = text.indexOf(">\n", SEAT_OPEN.length);
  const endAlt = end < 0 ? text.indexOf(">", SEAT_OPEN.length) : end;
  if (endAlt < 0) return null;
  const head = text.slice(SEAT_OPEN.length, endAlt);
  const attrs: Record<string, string> = {};
  for (const m of head.matchAll(/([a-z_]+)="([^"]*)"/g)) attrs[m[1]] = unattr(m[2]);
  if (!attrs.label) return null;
  let body = text.slice(endAlt + 1).replace(/^\n/, "");
  if (body.endsWith(SEAT_CLOSE)) body = body.slice(0, -SEAT_CLOSE.length);
  return {
    label: attrs.label,
    model: attrs.model ?? "",
    forked: attrs.forked === "true",
    searches: Number(attrs.searches ?? 0) || 0,
    tokens: Number(attrs.tokens ?? 0) || 0,
    angle: attrs.angle ?? null,
    area: attrs.area ?? null,
    error: attrs.error ?? null,
    body: body.replace(/\n$/, ""),
  };
}

export interface CouncilSeatRecord {
  label: string;
  model: string;
  engine: SeatEngine;
  resolved?: string;
  forked: boolean;
  searches: number;
  tool_uses: number;
  words: number;
  usage: Usage;
  cost_usd?: number;
  duration_ms: number;
  angle?: [number, number];
  area?: string;
  cited: string[];
  seen: number;
  error?: string;
}

export interface CouncilOverlap {
  pairwise: [number, number, number][];
  shared_by_all: number;
  union: number;
  shared: number;
}

export interface CouncilRecord {
  mode: CouncilMode;
  seats: CouncilSeatRecord[];
  overlap: CouncilOverlap;
  fired: boolean;
  areas_used: string[];
  areas_next: string[];
  at: string;
}

/** The record a recorded text is, or null for anything else. */
export function parseCouncilRecord(text: string): CouncilRecord | null {
  if (!text.startsWith(COUNCIL_OPEN)) return null;
  let body = text.slice(COUNCIL_OPEN.length).trimEnd();
  if (!body.endsWith(COUNCIL_CLOSE)) return null;
  body = body.slice(0, -COUNCIL_CLOSE.length);
  try {
    const r = JSON.parse(body) as CouncilRecord;
    if (!r || !Array.isArray(r.seats) || !r.overlap) return null;
    return r;
  } catch {
    return null;
  }
}

/** Whether a recorded text is one of the council's blocks. */
export function isCouncilBlock(text: string): boolean {
  return text.startsWith(SEAT_OPEN) || text.startsWith(COUNCIL_OPEN);
}

/**
 * The council record of the reply that answered the user message at
 * `index` in `events`, if that turn was a council turn — for the chip on
 * the sent bubble. The next assistant message after the user message is
 * the turn's reply; its last `<council>` block is the record.
 */
export function councilOfTurn(events: readonly SessionEvent[], index: number): CouncilRecord | null {
  for (let i = index + 1; i < events.length; i++) {
    const e = events[i];
    if (e.event === "user_message") return null;
    if (e.event === "assistant_message") {
      for (let b = e.blocks.length - 1; b >= 0; b--) {
        const blk = e.blocks[b];
        if (blk.type === "text") {
          const r = parseCouncilRecord(blk.text);
          if (r) return r;
        }
      }
      return null;
    }
  }
  return null;
}

/** The newest record on the chat, for the popover's areas line. */
export function lastCouncil(events: readonly SessionEvent[]): CouncilRecord | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    for (let b = e.blocks.length - 1; b >= 0; b--) {
      const blk = e.blocks[b];
      if (blk.type === "text") {
        const r = parseCouncilRecord(blk.text);
        if (r) return r;
      }
    }
  }
  return null;
}

/** `21%`, for the overlap figures. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** The seats' tokens summed, as the table of council turns shows them. */
export function recordTokens(r: CouncilRecord): number {
  return r.seats.reduce((n, s) => n + s.usage.input_tokens + s.usage.output_tokens, 0);
}

export function recordCost(r: CouncilRecord): number | null {
  const costs = r.seats.map((s) => s.cost_usd).filter((c): c is number => typeof c === "number");
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}
