/**
 * Item 904: a box's draft in tokens, read from the drafts store — for the
 * next-send figures shown away from the box itself (the right column's
 * cache row, the cold toast). The composer counts its own box the same way
 * (`draftSendTokens`), debounced with the estimate beside Send.
 */
import { readDraft } from "./drafts.svelte";
import { commentsMessage } from "./passageComments";
import { draftSendTokens } from "./draftCost";

/** The draft under `key` as the next send would carry it, in tokens. */
export function boxDraftTokens(key: string | null | undefined, engine: string | null | undefined): number {
  if (!key) return 0;
  const d = readDraft(key);
  const text = d.comments && d.comments.length > 0 ? commentsMessage(d.comments, d.text) : d.text;
  return draftSendTokens(text, d.attachments, engine === "claude-code" ? "claude-code" : "api");
}
