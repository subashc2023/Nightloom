/**
 * The transcript's render window (item 482, 2026-10-29: "switching tabs is
 * still really slow"). Every switch mounted the chat's whole transcript —
 * a component tree per message, and for a maths chat thousands of KaTeX
 * boxes laid out — and a 300-turn maths chat took seconds to show, on a
 * revisit as on the first visit. Now the transcript draws only its last
 * messages first (what the view lands on), fills the screen before the
 * first paint, adds a couple of screens above it after the paint, and
 * more as he scrolls up, holding his place as each batch lands above.
 *
 * `from` is the index into the transcript's items of the first one drawn;
 * everything from there to the end is drawn, so a window only ever grows
 * upward and a reply streaming at the foot is untouched. A chat's scroll
 * entry (`scroll.svelte.ts`) records the `from` its `top` was measured
 * under, so a switch back draws the same messages and the same pixel
 * offset lands on the same line.
 *
 * Whatever needs the whole chat in the DOM asks for it: find in chat (the
 * bar searches the page's text) sets `windowWants.all`; a jump on the
 * message rail or to the top grows the window to the target first.
 */

/** Items drawn on a fresh open, before the screen-filling pass. */
export const FIRST_ITEMS = 4;
/** Items added per batch when the window grows. */
export const GROW_ITEMS = 4;
/** Before the first paint: grow until this much is drawn above the view's
 *  top (in screen heights), so the screen is full and a first flick up has
 *  text under it... */
export const FILL_SCREENS = 0.25;
/** ...and after it, until this much. */
export const BUFFER_SCREENS = 2;

/** Requests from outside the transcript; reactive, read by it. */
export const windowWants = $state({ all: false });

/**
 * The first window of a chat just opened or switched to. A chat left
 * scrolled up draws exactly what it drew then (its entry's `from`, so its
 * `top` means the same line); an entry from before windows existed, which
 * has no `from`, draws everything, as before. Otherwise the last
 * `FIRST_ITEMS`.
 */
export function firstWindow(count: number, entry: { pinned: boolean; from?: number } | null): number {
  if (count <= 0) return 0;
  if (entry && !entry.pinned) return entry.from === undefined ? 0 : Math.max(0, Math.min(entry.from, count - 1));
  return Math.max(0, count - FIRST_ITEMS);
}

/** The window after one batch more above. */
export function grown(from: number, step = GROW_ITEMS): number {
  return Math.max(0, from - Math.max(1, step));
}

/** Whether the window needs to grow: messages are left undrawn and less
 *  than `screens` screen heights of drawn content sit above the view. */
export function wantsMore(from: number, scrollTop: number, clientHeight: number, screens: number): boolean {
  return from > 0 && scrollTop < clientHeight * screens;
}

/** The window that draws the item at `target` with `margin` items above
 *  it; never shrinks the window. */
export function windowFor(from: number, target: number, margin = 2): number {
  if (target < 0) return from;
  return Math.min(from, Math.max(0, target - margin));
}
