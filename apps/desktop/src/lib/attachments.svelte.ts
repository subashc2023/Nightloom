/**
 * The floating attachment tab's view state (nightshift backlog 145,
 * 2026-09-17): the tab itself lives in the workspace's floating slot
 * (`app.tabs.floating`, `tabs.ts`); what lives here is the moment of
 * opening — the thumbnail's rect the entrance zooms from, and the
 * image's natural size so the card is sized before its bytes decode
 * again — and the one resolver that turns an attachment's address into
 * its bytes, read from the open chat's log. Nothing is copied: the log
 * holds the base64 already, and the tab points at it.
 */
import { app } from "./state.svelte";
import * as tabs from "./tabs";
import type { Rect } from "./attachmentView";
import { findChip } from "./drafts.svelte";

export type AttachmentContent = Extract<tabs.TabContent, { kind: "attachment" }>;

export interface Opening {
  /** The thumbnail's rect at the click; null when opened another way. */
  from: Rect | null;
  /** The image's natural size, from the thumbnail that had decoded it. */
  natural: { width: number; height: number } | null;
}

export const opening = $state<Opening>({ from: null, natural: null });

/** Open `content` in the floating slot, replacing whatever floats. */
export function openAttachment(content: AttachmentContent, from: Rect | null, natural: Opening["natural"] = null): void {
  opening.from = from;
  opening.natural = natural;
  tabs.openFloating(app.tabs, content);
}

/** The address of image chip `chip` in the box whose draft is `key`
 *  (item 467). */
export function draftImageContent(key: string, chip: number, name: string): AttachmentContent {
  return { kind: "attachment", session: "", turn: -1, index: -1, media: "image", name, draft: { key, chip } };
}

export function closeAttachment(): void {
  tabs.closeFloating(app.tabs);
  opening.from = null;
  opening.natural = null;
}

/** The attachment's bytes from the open chat's log, or null when the tab
 *  is another chat's, the turn is not a user message, or the index is
 *  past its attachments (a rewound log, say). A draft chip's address
 *  (item 467) reads the box's draft instead. */
export function attachmentBytes(
  content: AttachmentContent,
): { media_type: string; data: string; name: string } | null {
  // Item 467: a chip in a message box, read from its draft — whichever
  // chat is open; null once the chip is removed or sent.
  if (content.draft) {
    const c = findChip(content.draft.key, content.draft.chip);
    if (!c || c.kind !== "image" || c.pending || !c.data) return null;
    return { media_type: c.media_type, data: c.data, name: c.name };
  }
  if (content.session !== app.activeSessionId) return null;
  const e = app.events[content.turn];
  if (!e || e.event !== "user_message") return null;
  if (content.media === "image") {
    const img = e.images?.[content.index];
    return img ? { media_type: img.media_type, data: img.data, name: content.name } : null;
  }
  const doc = e.documents?.[content.index];
  return doc ? { media_type: doc.media_type, data: doc.data, name: doc.name } : null;
}
