/**
 * The composer's draft, per chat (nightshift backlog 065, 2026-09-15).
 *
 * Until today the text and the attachments were state inside
 * `Composer.svelte`, and the component outlives a chat switch — so a draft
 * typed in one chat was still in the box after clicking another, which is
 * the bug he reported ("chat drafts seem to be universal"). Now the draft
 * lives here, keyed by the chat it belongs to: the open chat's id, or
 * `"new"` while no chat is open (the pending chat, backlog 061). The
 * composer binds to the entry for the current key and nothing else; the
 * key changing is what swaps the box.
 *
 * The pending chat's draft follows the chat it creates: the first send
 * lands a `session_created` line, `send` picks the id off it, and the one
 * line there calls `moveDraft("new", id)` — so anything typed *during* the
 * first turn (the box is not locked while a reply streams) is under the new
 * id when the key changes to it, rather than left behind under "new".
 *
 * Persisted to localStorage, best-effort, the way the transcript prefs
 * are: one key, written debounced, read at load, every access in
 * try/catch. Text always; an attachment only when it is small enough to be
 * worth the storage — the store as a whole has a few megabytes and a pasted
 * screenshot is often most of one, so an attachment over
 * `PERSIST_ATTACHMENT_MAX` base64 chars (or past `PERSIST_TOTAL_MAX` for
 * the whole store) stays in memory only, and a relaunch keeps the text and
 * drops that chip. Said here because it is the one place a draft is not
 * whole across a relaunch.
 *
 * Clearing: sending clears that chat's entry. Nothing else does — not a
 * switch, not Escape, not a delete of the chat (the entry outlives the
 * row, harmlessly). The never-lose-work rule.
 */
import type { Attachment } from "./types";

export interface Draft {
  text: string;
  attachments: Attachment[];
}

/** The key of the pending chat: no chat open, the next message makes one. */
export const NEW_DRAFT_KEY = "new";

const KEY = "nightloom.drafts";
const SAVE_DELAY_MS = 400;
/** Base64 chars; ~384 KB of file. */
export const PERSIST_ATTACHMENT_MAX = 512 * 1024;
/** Base64 chars across every persisted attachment. */
export const PERSIST_TOTAL_MAX = 3 * 1024 * 1024;

/** What the composer binds to while a chat has no entry yet. Frozen: a
 *  write goes through `draftFor`, which makes the entry. */
const EMPTY: Draft = Object.freeze({ text: "", attachments: Object.freeze([]) as unknown as Attachment[] });

export function draftKey(activeSessionId: string | null): string {
  return activeSessionId ?? NEW_DRAFT_KEY;
}

function isAttachment(v: unknown): v is Attachment {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "number" &&
    (a.kind === "image" || a.kind === "document") &&
    typeof a.media_type === "string" &&
    typeof a.name === "string" &&
    typeof a.data === "string"
  );
}

/** Read the store. A malformed entry costs that entry, not the store. */
export function loadDrafts(storage: Pick<Storage, "getItem"> = localStorage): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      const text = typeof d.text === "string" ? d.text : "";
      const attachments = Array.isArray(d.attachments) ? d.attachments.filter(isAttachment) : [];
      if (text || attachments.length > 0) out[k] = { text, attachments };
    }
  } catch {
    // A broken store reads as no drafts; the next save rewrites it.
  }
  return out;
}

/**
 * The store as it is written: empty entries dropped, attachments kept
 * only under the caps above. Pure, so the test can pin what a big paste
 * does to the file without a storage at all.
 */
export function serializeDrafts(map: Record<string, Draft>): string {
  let budget = PERSIST_TOTAL_MAX;
  const out: Record<string, Draft> = {};
  for (const [k, d] of Object.entries(map)) {
    if (!d.text && d.attachments.length === 0) continue;
    const kept: Attachment[] = [];
    for (const a of d.attachments) {
      if (a.data.length > PERSIST_ATTACHMENT_MAX || a.data.length > budget) continue;
      budget -= a.data.length;
      kept.push({ id: a.id, kind: a.kind, media_type: a.media_type, name: a.name, data: a.data });
    }
    out[k] = { text: d.text, attachments: kept };
  }
  return JSON.stringify(out);
}

export function saveDrafts(
  map: Record<string, Draft>,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(KEY, serializeDrafts(map));
  } catch {
    // Over quota, most likely. Try once more with the text alone: the text
    // is the part that cannot be re-pasted.
    try {
      const bare: Record<string, Draft> = {};
      for (const [k, d] of Object.entries(map)) bare[k] = { text: d.text, attachments: [] };
      storage.setItem(KEY, serializeDrafts(bare));
    } catch {
      // best-effort
    }
  }
}

function readInitial(): Record<string, Draft> {
  return typeof localStorage === "undefined" ? {} : loadDrafts();
}

export const drafts: Record<string, Draft> = $state(readInitial());

// Attachment ids are per launch and only have to be unique among the
// chips on screen; restored ones are counted so a new paste cannot reuse
// one of theirs.
let attachSeq = 0;
for (const d of Object.values(drafts)) for (const a of d.attachments) attachSeq = Math.max(attachSeq, a.id);

export function nextAttachmentId(): number {
  return ++attachSeq;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Write soon. Debounced: a keystroke is not worth a synchronous write. */
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushDrafts, SAVE_DELAY_MS);
}

/** Write now. Called on the debounce and when the page is going away. */
export function flushDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  saveDrafts(drafts);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
}

/** The entry for a key, or the frozen empty draft. Never inserts. */
export function readDraft(key: string): Draft {
  return drafts[key] ?? EMPTY;
}

/** The entry for a key, made if missing. For writes. */
export function draftFor(key: string): Draft {
  let d = drafts[key];
  if (!d) {
    d = { text: "", attachments: [] };
    drafts[key] = d;
    d = drafts[key]!;
  }
  return d;
}

/** Non-empty text or at least one chip: what earns the row its mark. */
export function hasDraft(key: string): boolean {
  const d = drafts[key];
  return d !== undefined && (d.text.trim().length > 0 || d.attachments.length > 0);
}

export function setDraftText(key: string, text: string): void {
  if (!drafts[key] && !text) return;
  draftFor(key).text = text;
  schedule();
}

export function addAttachment(key: string, a: Attachment): void {
  draftFor(key).attachments.push(a);
  schedule();
}

export function removeAttachment(key: string, id: number): void {
  const d = drafts[key];
  if (!d) return;
  const i = d.attachments.findIndex((a) => a.id === id);
  if (i >= 0) d.attachments.splice(i, 1);
  schedule();
}

export function setDraftAttachments(key: string, attachments: Attachment[]): void {
  if (!drafts[key] && attachments.length === 0) return;
  draftFor(key).attachments = attachments;
  schedule();
}

/** Sending is the one thing that clears a draft. */
export function clearDraft(key: string): void {
  if (!drafts[key]) return;
  delete drafts[key];
  schedule();
}

/**
 * The pending chat's draft becomes the created chat's. Anything already
 * under `to` (a fork's key, say) is kept and the moved text appended
 * after it, so neither side's words are lost.
 */
export function moveDraft(from: string, to: string): void {
  if (from === to) return;
  const src = drafts[from];
  if (!src) return;
  const dst = drafts[to];
  if (!dst) {
    drafts[to] = { text: src.text, attachments: src.attachments.slice() };
  } else {
    dst.text = dst.text ? (src.text ? `${dst.text}\n${src.text}` : dst.text) : src.text;
    dst.attachments.push(...src.attachments);
  }
  delete drafts[from];
  schedule();
}
