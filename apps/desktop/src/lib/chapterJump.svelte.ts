/**
 * A jump to a chapter of a chat not yet open (item 799): the contents list
 * of a chat that continues another by hand-off links the earlier chat's
 * chapters; a click asks for the jump here and opens that chat, and its
 * transcript takes the request once its log is drawn.
 */
const pending = $state<{ chat: string | null; key: string | null; at: number }>({ chat: null, key: null, at: 0 });

/** A request older than this is dropped (the chat never opened). */
export const JUMP_TTL_MS = 15_000;

export function requestChapterJump(chat: string, key: string): void {
  pending.chat = chat;
  pending.key = key;
  pending.at = Date.now();
}

/** The chapter key to jump to in `chat`, taken (cleared) — null when none is asked. Reactive on the request. */
export function peekChapterJump(chat: string | null): string | null {
  if (!chat || pending.chat !== chat || !pending.key) return null;
  if (Date.now() - pending.at > JUMP_TTL_MS) return null;
  return pending.key;
}

export function takeChapterJump(): void {
  pending.chat = null;
  pending.key = null;
}
