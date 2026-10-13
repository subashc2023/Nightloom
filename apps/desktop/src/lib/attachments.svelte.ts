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

export function closeAttachment(): void {
  tabs.closeFloating(app.tabs);
  opening.from = null;
  opening.natural = null;
}

/** The attachment's bytes from the open chat's log, or null when the tab
 *  is another chat's, the turn is not a user message, or the index is
 *  past its attachments (a rewound log, say). */
export function attachmentBytes(
  content: AttachmentContent,
): { media_type: string; data: string; name: string } | null {
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
