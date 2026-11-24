/**
 * Item 930 (his "this should happen for all the times that Nightloom has chats running, has his subagents
 * running, has anything that is actively running"): one named power hold, "running" (item 912's `power_hold`,
 * the same `caffeinate` child and Settings switches as a turn's hold — no second power path), taken while
 * anything the running list shows runs (a chat's turn, an aside, a subagent, a dream, a note edit, a
 * Nightshift run, a scheduled message's turn) and let go once nothing has run for `RELEASE_MS`, so
 * back-to-back turns do not flap the assertion. The 912 hand-off hold ("handoff") is separate. Quitting
 * ends the child with the app (power.rs: `Drop`, and `caffeinate -w <pid>`).
 */
export const HOLD_NAME = "running";
export const RELEASE_MS = 30_000;

export class RunningHold {
  private held = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private hold: (name: string, on: boolean) => Promise<unknown>,
    private releaseMs: number = RELEASE_MS,
  ) {}

  /** Anything runs now (true) or nothing does (false); call on every change of the running list. */
  note(running: boolean): void {
    if (running) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (!this.held) {
        this.held = true;
        void this.hold(HOLD_NAME, true).catch(() => {});
      }
    } else if (this.held && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.held = false;
        void this.hold(HOLD_NAME, false).catch(() => {});
      }, this.releaseMs);
    }
  }

  /** Whether the hold is taken now. */
  get on(): boolean {
    return this.held;
  }
}
