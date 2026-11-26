/*
 * What he has typed into a typed link's card and not sent (item 993c; practices §7: no UI mechanic may lose his
 * work): a reply, a forward and its recipient, the note on an RSVP — by the item (`refKey`). Kept in app state
 * and in the page's storage, so closing the card, opening another, switching chats or restarting loses nothing;
 * the card offers it back. Only a send, a save as a Gmail draft, or his confirmed Discard drops one.
 */
import type { MailMode } from "./refCard";

export interface RefDraft {
  /** Which mail action the body was typed for; null when only an RSVP note is kept. */
  mode: MailMode | null;
  body: string;
  /** A forward's recipient, as he typed it. */
  to: string;
  /** The optional note on an RSVP. */
  note: string;
}

export const REF_DRAFTS_KEY = "nightloom.refDrafts";

/** What storage holds, as drafts; never throws, and drops anything that is not one. */
export function readDrafts(raw: string | null): Record<string, RefDraft> {
  const out: Record<string, RefDraft> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return out;
    for (const [k, d] of Object.entries(v as Record<string, Partial<RefDraft>>)) {
      if (!d || typeof d !== "object") continue;
      const mode = d.mode === "reply" || d.mode === "replyAll" || d.mode === "forward" ? d.mode : null;
      const draft = { mode, body: typeof d.body === "string" ? d.body : "", to: typeof d.to === "string" ? d.to : "", note: typeof d.note === "string" ? d.note : "" };
      if (hasWords(draft)) out[k] = draft;
    }
  } catch {
    // Unreadable storage is no drafts, never an error on his screen.
  }
  return out;
}

const hasWords = (d: RefDraft) => !!(d.body.trim() || d.to.trim() || d.note.trim());

function load(): Record<string, RefDraft> {
  try {
    return readDrafts(localStorage.getItem(REF_DRAFTS_KEY));
  } catch {
    return {};
  }
}

export const refDrafts = $state<{ by: Record<string, RefDraft> }>({ by: load() });

function save(): void {
  try {
    localStorage.setItem(REF_DRAFTS_KEY, JSON.stringify(refDrafts.by));
  } catch {
    // best-effort; the draft is still in app state
  }
}

export function draftOf(key: string): RefDraft | null {
  return refDrafts.by[key] ?? null;
}

/** Keep what he typed, at every keystroke. A draft with no words left is not kept (nothing to offer back). */
export function keepDraft(key: string, patch: Partial<RefDraft>): void {
  const prev: RefDraft = refDrafts.by[key] ?? { mode: null, body: "", to: "", note: "" };
  const next: RefDraft = { ...prev, ...patch };
  if (hasWords(next)) refDrafts.by[key] = next;
  else delete refDrafts.by[key];
  save();
}

/** The mail part goes (sent, saved to Gmail, or his confirmed Discard); an RSVP note stays, and the reverse. */
export function dropDraft(key: string, part: "mail" | "note"): void {
  const d = refDrafts.by[key];
  if (!d) return;
  keepDraft(key, part === "mail" ? { mode: null, body: "", to: "" } : { note: "" });
}

/** Tests: start from nothing. */
export function resetDrafts(): void {
  refDrafts.by = {};
  save();
}
