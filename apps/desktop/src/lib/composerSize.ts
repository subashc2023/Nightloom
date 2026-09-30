/**
 * Whether a chat's dragged composer height (backlog 111's floor) still
 * holds the box open, or has become a ceiling only (nightshift backlog
 * 254, 2026-09-29): "the custom size of the text box should fit back into
 * the normal size once you've sent the chat … the next time I start
 * filling it up, it still maxes out at the previous max, but it should
 * still reset in between."
 *
 * A drag (or ⌥⌘↑/↓) makes the height the box's size even when empty; a
 * send from that chat turns it into the most the text may grow the box
 * to, and the box goes back to one line. The next drag makes it a floor
 * again. Kept in memory for the app's run: after a restart the dragged
 * height opens the empty box again, as before this item.
 */
export class SentSinceDrag {
  private keys = new Set<string>();

  /** A message left this chat's box: its floor becomes a ceiling. */
  sent(key: string): void {
    this.keys.add(key);
  }

  /** The box was sized by hand (or reset): the floor holds it open again. */
  sized(key: string): void {
    this.keys.delete(key);
  }

  /** The floor that holds the empty box open for `key`: `floor` until a
   *  send, null after it. The ceiling is not this function's — the caller
   *  keeps the dragged height in its cap either way. */
  floor(key: string, floor: number | null): number | null {
    return this.keys.has(key) ? null : floor;
  }
}

/** The app's one record: the composer is unmounted on the blank page, and
 *  a remount must not forget which chats have sent since their drag. */
export const sentSinceDrag = new SentSinceDrag();
