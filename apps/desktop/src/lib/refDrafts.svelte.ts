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

/*
 * A mail that may have gone (993e review, finding 4; re-review N2): by the item, the words the card shows, kept
 * beside the draft and in the page's storage — so a reload or a restart keeps Send off with the warning, and only
 * his "I checked: not sent" lets that item send again.
 */
export const REF_MAYBE_KEY = "nightloom.refMaybeSent";

/** What storage holds, as may-have-gone notes; never throws, and drops anything that is not one. */
export function readMaybe(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, why] of Object.entries(v as Record<string, unknown>)) if (typeof why === "string" && why.trim()) out[k] = why;
  } catch {
    // Unreadable storage: nothing held (the Rust journal still warns of a quit mid-call).
  }
  return out;
}

export const refMaybe = $state<{ by: Record<string, string> }>({
  by: (() => {
    try {
      return readMaybe(localStorage.getItem(REF_MAYBE_KEY));
    } catch {
      return {};
    }
  })(),
});

function saveMaybe(): void {
  try {
    localStorage.setItem(REF_MAYBE_KEY, JSON.stringify(refMaybe.by));
  } catch {
    // best-effort; still held in app state this session
  }
}

/** It may have gone: Send stays off for the item, across reloads and restarts. */
export function markMaybeSent(key: string, why: string): void {
  refMaybe.by[key] = why;
  saveMaybe();
}

/** His "I checked: not sent": the item may send again. */
export function clearMaybeSent(key: string): void {
  delete refMaybe.by[key];
  saveMaybe();
}

/** Tests: start from nothing. */
export function resetDrafts(): void {
  refDrafts.by = {};
  save();
  refMaybe.by = {};
  saveMaybe();
}
