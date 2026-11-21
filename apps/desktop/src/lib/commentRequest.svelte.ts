/*
 * The transcript → composer channel for a new comment on a passage
 * (item 754): the selection pill's *Comment* adds the chip to the box's
 * draft (`addComment`) and names it here; the composer whose key it is
 * opens that chip's comment line and puts the caret in it, then clears
 * the request. Shared `$state`, as `replyQuote.svelte.ts`'s `replyRequest`.
 */
export const commentRequest = $state<{ key: string | null; id: number }>({ key: null, id: 0 });

export function requestCommentFocus(key: string, id: number): void {
  commentRequest.key = key;
  commentRequest.id = id;
}

/** The comment to open for box `key`, once; 0 when none is asked for. */
export function takeCommentFocus(key: string): number {
  if (commentRequest.key !== key || commentRequest.id === 0) return 0;
  const id = commentRequest.id;
  commentRequest.key = null;
  commentRequest.id = 0;
  return id;
}
