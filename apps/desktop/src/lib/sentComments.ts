/*
 * A sent message's passage comments, kept so they come back as comments
 * (item 892, his report 2026-11-19: "if u rewind a msg that u had sent with
 * comments the comments don't rewind, tehy jus appear in the chat msg
 * directly").
 *
 * Send flattens the comment chips into the message's text
 * (`commentsMessage`, item 754): each passage as a `> ` quote, his note
 * under it, then what he typed. The log keeps only that text, and a quote
 * he typed or put in with *Reply* (backlog 215) reads the same, so the text
 * alone cannot be parsed back safely. Instead each send that carried
 * comments is recorded here — the sent text, what he typed, the comments —
 * and a message that comes back (a rewind, item 724's offer, a failed send,
 * a held row taken back) whose text is exactly one recorded is split back
 * into his text and its chips. A text with no record (sent before this, or
 * edited since) comes back as it reads, as before.
 *
 * Kept in localStorage, newest first, at most `SENT_MAX` entries and
 * `SENT_CHARS` characters in all, so a rewind after a relaunch still finds it.
 */
import { commentsMessage, copyComments, readComments, type PassageComment } from "./passageComments";

export interface SentComments {
  /** The text as it went (`commentsMessage(comments, typed)`). */
  text: string;
  /** What he typed in the box itself. */
  typed: string;
  comments: PassageComment[];
}

export const SENT_KEY = "nightloom.sentComments.v1";
export const SENT_MAX = 60;
export const SENT_CHARS = 400 * 1024;

type Store = Pick<Storage, "getItem" | "setItem">;

function store(): Store | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** The records read back; a malformed one costs only itself. Pure. */
export function readSent(raw: string | null): SentComments[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SentComments[] = [];
  for (const r of v) {
    if (r === null || typeof r !== "object") continue;
    const m = r as Record<string, unknown>;
    if (typeof m.text !== "string" || typeof m.typed !== "string") continue;
    const comments = readComments(m.comments);
    if (comments.length === 0) continue;
    out.push({ text: m.text, typed: m.typed, comments });
  }
  return out;
}

/** `list` with `rec` at its head (an older copy of the same text gone),
 *  cut to the caps. Pure. */
export function withSent(list: readonly SentComments[], rec: SentComments): SentComments[] {
  const out = [rec, ...list.filter((r) => r.text.trim() !== rec.text.trim())];
  let chars = 0;
  const kept: SentComments[] = [];
  for (const r of out) {
    chars += r.text.length + r.typed.length + r.comments.reduce((n, c) => n + c.quote.length + c.note.length, 0);
    if (kept.length >= SENT_MAX || (kept.length > 0 && chars > SENT_CHARS)) break;
    kept.push(r);
  }
  return kept;
}

/**
 * The text Send sends for `comments` and `typed` (`commentsMessage`), and,
 * when it carries comments, the record that lets it come back as them.
 */
export function sendWithComments(comments: readonly PassageComment[] | undefined, typed: string, s: Store | null = store()): string {
  const text = commentsMessage(comments, typed);
  const list = (comments ?? []).filter((c) => c.quote.trim() !== "");
  if (list.length === 0 || !s) return text;
  try {
    const next = withSent(readSent(s.getItem(SENT_KEY)), { text, typed, comments: copyComments(list) });
    s.setItem(SENT_KEY, JSON.stringify(next));
  } catch {
    // Storage full or refused: the message still goes; it comes back as text.
  }
  return text;
}

/** The record whose sent text is `text` (as sent, trimmed or not), checked
 *  against `commentsMessage` so a stale or altered one is never used. Pure. */
export function findSent(list: readonly SentComments[], text: string): SentComments | null {
  const t = text.trim();
  if (!t) return null;
  for (const r of list) {
    if (r.text.trim() !== t) continue;
    if (commentsMessage(r.comments, r.typed).trim() !== t) continue;
    return { text: r.text, typed: r.typed, comments: copyComments(r.comments) };
  }
  return null;
}

/** A message coming back: his typed text and its comments, when it was
 *  sent with some; null otherwise (it comes back as it reads). */
export function sentComments(text: string, s: Store | null = store()): { typed: string; comments: PassageComment[] } | null {
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(SENT_KEY);
  } catch {
    return null;
  }
  const r = findSent(readSent(raw), text);
  return r ? { typed: r.typed, comments: r.comments } : null;
}
