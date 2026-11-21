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
 * again. ~~Kept in memory for the app's run: after a restart the dragged
 * height opens the empty box again, as before this item.~~
 *
 * Since item 849 (2026-11-18, his "I feel like this should reset" of the
 * box left half the window tall after a hand-off) the floor holds the empty
 * box open only for the visit the drag was made in: leaving the chat (a
 * chat switch, a hand-off to the next chat, the box closing) and a relaunch
 * end it as a send does, and the dragged height is a ceiling only from then
 * on. The record is of the boxes held open, so an unknown key — every key
 * after a relaunch — holds nothing.
 */
export class SentSinceDrag {
  /** The boxes a drag holds open now (item 849: was the keys sent from). */
  private held = new Set<string>();

  /** A message left this chat's box: its floor becomes a ceiling. */
  sent(key: string): void {
    this.held.delete(key);
  }

  /** The box was sized by hand (or reset): the floor holds it open again. */
  sized(key: string): void {
    this.held.add(key);
  }

  /** The box stopped showing this chat (item 849): a switch, a hand-off,
   *  the box unmounted. The floor becomes a ceiling, as after a send. */
  left(key: string): void {
    this.held.delete(key);
  }

  /** The floor that holds the empty box open for `key`: `floor` from a
   *  drag until a send or leaving, null otherwise. The ceiling is not this
   *  function's — the caller keeps the dragged height in its cap either way. */
  floor(key: string, floor: number | null): number | null {
    return this.held.has(key) ? floor : null;
  }
}

/** The app's one record: the composer is unmounted on the blank page, and
 *  a remount must not forget which chats have sent since their drag. */
export const sentSinceDrag = new SentSinceDrag();
