/**
 * Item 461 (his ask, 2026-10-28: drag a file in "and am hovering over the
 * chats section, it sh automatically switch to the notes section and then
 * have the orange box"): a file from Finder held over the sidebar while it
 * shows Chats switches it to Notes after `delayMs`, where the Project
 * section's drop box (item 391) takes it; a drag that leaves the sidebar
 * without dropping there puts Chats back. Pure: events and the clock in,
 * which tab to show out. `Sidebar.svelte` feeds it only drags that carry
 * real files (`carriesFiles`), so a chat, tab or note dragged inside the
 * app never switches anything.
 */
import { Hold } from "./notesDrop";

export const SWITCH_MS = 300;

export class DragToNotes {
  /** Whether a file drag is over the sidebar: entered and not left, and
   *  seen recently — a list swapped out under the pointer never sends its
   *  leave, so staleness ends a hold the counting cannot. */
  private hold = new Hold(1500);
  private since: number | null = null;
  /** The switch to Notes was this drag's doing, so leaving undoes it. */
  private switched = false;

  constructor(readonly delayMs = SWITCH_MS) {}

  enter(now: number): void {
    this.hold.enter(now);
    this.since ??= now;
  }

  over(now: number): void {
    this.hold.over(now);
    this.since ??= now;
  }

  leave(): void {
    this.hold.leave();
  }

  /** The drag ended: dropped in the sidebar (`inside`: Notes stays, the
   *  file is kept there) or anywhere else, or cancelled (Chats comes back
   *  if this drag switched away from it). */
  end(inside: boolean): void {
    this.hold.end();
    if (inside) this.switched = false;
  }

  /** What to show now, given the tab showing: `"notes"` once a file has
   *  been held over Chats for `delayMs`, `"chats"` once a drag that
   *  switched has gone, else null (leave it). */
  tick(now: number, tab: string): "notes" | "chats" | null {
    if (!this.hold.held(now)) {
      this.since = null;
      if (this.switched) {
        this.switched = false;
        return tab === "notes" ? "chats" : null;
      }
      return null;
    }
    if (!this.switched && tab === "chats" && this.since !== null && now - this.since >= this.delayMs) {
      this.switched = true;
      // The list under the pointer is about to be replaced, and the rows
      // that go never send their leave: count afresh from the sidebar
      // itself, which the pointer is over.
      this.hold.end();
      this.hold.enter(now);
      return "notes";
    }
    return null;
  }
}
