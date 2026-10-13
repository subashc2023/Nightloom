/**
 * When the message box is locked, and what happens to its caret across a
 * lock (nightshift backlog 365, 2026-10-13 — his "why tf do i no longer
 * have a cursor in the textbox?? and now it's back … i didnt have a cursor
 * for a few seconsd").
 *
 * The box was `disabled` whenever there was no connection — including the
 * seconds a connect is running with none, as when a chat switch moves to a
 * chat on the other engine (`restoreChatChoice` drops the old engine's
 * connection, then the new one connects). Measured in WebKit (the engine
 * Nightloom's window uses): a focused textarea that is disabled loses the
 * focus to the page within 100 ms with no blur event, and enabling it again
 * does not give it back; the formatted box (CodeMirror, item 276) keeps the
 * focus but, made non-editable, draws no caret until the connection is back.
 *
 * Now: a connect in flight does not lock the box — he can type on while it
 * runs; Send already waits for it (`sendHeld`). The box locks only with no
 * connection and none coming (none configured, a connect that failed). And
 * if a lock does take the focus, the unlock gives it back with the kept
 * caret, unless the focus has gone somewhere of his choosing meanwhile.
 */

/** Whether the box is locked (`disabled`): no connection, and no connect running. */
export function boxLocked(connected: boolean, connecting: boolean): boolean {
  return !connected && !connecting;
}

/**
 * The focus across a lock. `locking` is told, just before the box locks,
 * whether the box held the focus; `unlocked` is asked, once it is unlocked,
 * whether to take the focus back — only when it had it and the focus is now
 * nowhere (the page itself), never from a field he moved to.
 */
export class FocusThroughLock {
  private had = false;

  locking(boxHadFocus: boolean): void {
    this.had = boxHadFocus;
  }

  unlocked(focusIsNowhere: boolean): boolean {
    const back = this.had && focusIsNowhere;
    this.had = false;
    return back;
  }
}
