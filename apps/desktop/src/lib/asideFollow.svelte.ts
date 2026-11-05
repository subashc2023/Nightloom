import { tick, untrack } from "svelte";
import type { Aside } from "./state.svelte";
import { asideSendJumps } from "./sendScroll";

/**
 * Item 485: the aside tab follows its thread as the card does (item 468's
 * rule, which was wired into `AsideCard.svelte` only — "the thing about it
 * auto scrolling to the bottom … wasn't built", his words on edb9156). A
 * follow-up sent from within one screen of the thread's foot lands at the
 * bottom and follows the answer as it streams; from further up the place
 * is kept; at the foot it stays at the foot as the answer grows; any
 * scroll of his own up releases it, back at the foot holds it again.
 *
 * `ThreadFollow` is the decisions, plain (tested in `asideFollow.test.ts`);
 * `followThread` drives it from a component's effects.
 */
export class ThreadFollow {
  pinned = true;
  private id: number | null | undefined = undefined;
  private turns = -1;
  private distance = 0;
  private height = 0;

  /** The box was scrolled (by him or by us): held only at the foot. */
  scrolled(gap: number): void {
    this.pinned = gap < 4;
  }
  /** Before the thread's turns change is drawn: the reader's place. */
  before(gap: number, height: number): void {
    this.distance = gap;
    this.height = height;
  }
  /**
   * The thread (`id`) now has `n` turns, the last still being asked or
   * not. Returns whether this is the first look at the thread — the view's
   * own restore places it then, and nothing follows.
   */
  turnsNow(id: number | null, n: number, asking: boolean): boolean {
    if (id !== this.id) {
      this.id = id;
      this.turns = n;
      return true;
    }
    if (this.turns >= 0 && asideSendJumps(this.pinned, this.turns, n, asking, this.distance, this.height)) this.pinned = true;
    this.turns = n;
    return false;
  }
}

const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * Call during a component's init (it makes effects). `box` is the scroll
 * container, `thread` the aside drawn; returns the handler for the box's
 * scroll event.
 */
export function followThread(box: () => HTMLElement | null, thread: () => Aside | null): { scrolled: () => void } {
  const f = new ThreadFollow();
  // The reader's distance from the foot, read before the new turn is drawn.
  $effect.pre(() => {
    void thread()?.turns.length;
    untrack(() => {
      const el = box();
      if (el) f.before(gapOf(el), el.clientHeight);
    });
  });
  $effect(() => {
    const a = thread();
    const last = a?.turns[a.turns.length - 1];
    const n = a?.turns.length ?? 0;
    void last?.partial;
    void last?.answer;
    // The first look is taken once the box is there to read.
    if (!box()) return;
    const first = untrack(() =>
      f.turnsNow(a?.id ?? null, n, !!last && last.answer === null && !last.error && !last.cancelled),
    );
    void tick().then(() => {
      const now = box();
      if (!now) return;
      // First look: held only if the restored view is at the foot.
      if (first) f.scrolled(gapOf(now));
      else if (f.pinned) now.scrollTop = now.scrollHeight;
    });
  });
  return {
    scrolled() {
      const el = box();
      if (el) f.scrolled(gapOf(el));
    },
  };
}
