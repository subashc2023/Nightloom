/**
 * Item 300 (wave 8B, F3): where the phone is, kept by the page itself, and
 * errors in words he can act on.
 *
 * - **The place** (A21, A37): the chat (or new chat) on screen, its project
 *   and its host, in the URL's hash and the history, so Back returns to the
 *   chat before and a reload reopens the one he was on — and in
 *   localStorage, so a home-screen launch (which opens the start URL, hash
 *   and all gone) does too. The token's `#token=` hash is read and removed
 *   before any place is written, and a place never carries it.
 * - **Plain errors** (A14): the host's sentence without internal paths, one
 *   line, with the full text kept as the details.
 */
import type { HostRole } from "./hosts";

export const PLACE_KEY = "nightloom.remote.place";

export interface Place {
  /** The chat on screen; `null` is a new chat. */
  chat: string | null;
  /** The chat's project (or the new chat's), named explicitly; `null` when
   *  the host lists no id for it (the Mac's unfiled chats). */
  project: string | null;
  host: HostRole | null;
}

const isRole = (v: unknown): v is HostRole => v === "mac" || v === "away";

/** `#chat=<id>&project=<pid>&host=<role>`, or `#new` (and its project). */
export function placeHash(p: Place): string {
  const parts: string[] = [p.chat ? `chat=${encodeURIComponent(p.chat)}` : "new"];
  if (p.project) parts.push(`project=${encodeURIComponent(p.project)}`);
  if (p.host) parts.push(`host=${p.host}`);
  return `#${parts.join("&")}`;
}

/** The place in `hash`, or `null` when it names none (a token, nothing). */
export function placeFromHash(hash: string): Place | null {
  const body = hash.replace(/^#/, "");
  if (!body) return null;
  let chat: string | null = null;
  let project: string | null = null;
  let host: HostRole | null = null;
  let isNew = false;
  for (const part of body.split("&")) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    let value = "";
    try {
      value = at < 0 ? "" : decodeURIComponent(part.slice(at + 1));
    } catch {
      return null;
    }
    if (key === "new") isNew = true;
    else if (key === "chat" && value) chat = value;
    else if (key === "project" && value) project = value;
    else if (key === "host" && isRole(value)) host = value;
  }
  if (!chat && !isNew) return null;
  return { chat, project, host };
}

export function samePlace(a: Place | null, b: Place | null): boolean {
  if (!a || !b) return a === b;
  return a.chat === b.chat && a.project === b.project && a.host === b.host;
}

/** A place read back from storage, checked field by field. */
export function readPlace(v: unknown): Place | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { chat: str(o.chat), project: str(o.project), host: isRole(o.host) ? o.host : null };
}

export function loadPlace(): Place | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY);
    return raw ? readPlace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function savePlace(p: Place): void {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(p));
  } catch {
    // Storage off: the hash still holds it for a reload.
  }
}

// ---- plain errors (A14) -------------------------------------------------------

export interface PlainError {
  /** One short line for the banner. */
  text: string;
  /** The host's full sentence, when it says more than `text` (shown on
   *  a tap); `null` when nothing was cut. */
  detail: string | null;
}

const MAX = 140;

/**
 * The host's refusal as one line he can act on. `doing` names what failed
 * ("rename the chat") and leads the line. A chat that was not found says
 * so in words rather than with the folder it was looked for in; any other
 * sentence keeps its words with paths cut out, to its first line.
 */
export function plainError(message: string, doing: string | null = null): PlainError {
  const raw = message.trim();
  let reason: string;
  if (/no session matching|^no chat\b/i.test(raw)) {
    reason = "the chat could not be found — pull down to refresh, then try again";
  } else if (/^</.test(raw)) {
    reason = "the host gave an answer the page cannot read — try again";
  } else if (!raw) {
    reason = "something went wrong — try again";
  } else {
    reason = (raw.split(/\r?\n/)[0] ?? raw)
      // " in /a/b/c", " at …/x/y": the path and the word that led to it.
      .replace(/\s+(?:in|at|from|under|to)\s+(?:~|…|\.\.\.)?\/\S+/g, "")
      // Any other path left.
      .replace(/(?:^|\s)(?:~|…|\.\.\.)?\/[^\s,;:]+/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .trim();
    if (!reason) reason = "something went wrong — try again";
  }
  let text = doing ? `Couldn't ${doing}: ${reason}` : reason.charAt(0).toUpperCase() + reason.slice(1);
  if (text.length > MAX) text = `${text.slice(0, MAX - 1).trimEnd()}…`;
  return { text, detail: raw && raw !== text ? raw : null };
}

// ---- held messages (A30, A36) ---------------------------------------------------

/**
 * The held row's ✕ (A36): a message held for the chat on screen goes back
 * into its composer (`take`); one held for another chat asks first
 * (`ask`: Edit in its chat, or Discard) — never into this chat's box, where
 * one tap on Send would post it in the wrong chat.
 */
export function heldTap(q: { chat: string | null }, chatId: string | null): "take" | "ask" {
  return q.chat === chatId ? "take" : "ask";
}

/** The held messages the queue may still try: one that was refused waits
 *  for his Retry rather than being tried, and refused, at every turn's end. */
export function triable<Q extends { failed?: string | null }>(queue: Q[]): Q[] {
  return queue.filter((q) => !q.failed);
}

/** `text` joined to what a composer already holds, so taking a held
 *  message back never overwrites a draft (practices §7). */
export function joinDraft(existing: string, text: string): string {
  return existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n${text}` : text;
}
