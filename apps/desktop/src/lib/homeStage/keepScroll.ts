/**
 * Item 947: every view keeps its place (his rule, practices §7). A view on Home's stage is drawn afresh at each tab
 * switch, each return to Home and each start of the app, and its state lives in its bag (stageState) — but where he
 * had scrolled each of its panels did not: Sources, Needs you, the to-do list, the piles, a research page all came
 * back at their tops. This action, on the box a view is drawn in, keeps the scroll of every scrolling box inside it
 * under the view's id and puts it back when the view is drawn again.
 *
 * - A box is named by its first class and its place among the view's boxes of that class (`h9-pb#1`).
 * - A box he left at its end (a log, Home's steps) goes back to its end, so new lines still show; any other box goes
 *   back to the same distance from its top.
 * - The view's content may arrive late (tasks are read, panels arrive), so each box is put back as soon as its content allows, over the
 *   first 3 s — and no more once he scrolls or touches the view himself.
 */
import { bag } from "./stageState.svelte";

export type Place = Record<string, { top: number; end: boolean }>;

const END = 28;
// Tried at once, then every 100 ms for 3 s (a view's data is read again when it is drawn).
const EVERY = 100;
const FOR = 3000;

export const scrolls = (el: Element): boolean => /(auto|scroll)/.test(getComputedStyle(el).overflowY);

/** The scrolling boxes inside `root`, each with its name. */
export function named(root: HTMLElement): [string, HTMLElement][] {
  const seen: Record<string, number> = {};
  const out: [string, HTMLElement][] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (!scrolls(el)) continue;
    const c = (el.getAttribute("class") ?? el.tagName).split(" ")[0];
    const n = (seen[c] = (seen[c] ?? -1) + 1);
    out.push([`${c}#${n}`, el]);
  }
  return out;
}

/** Where a box is: its top, and whether it sits at its end (scrolled, and within a line of it). */
export function placeOf(el: HTMLElement): { top: number; end: boolean } {
  const room = el.scrollHeight - el.clientHeight;
  return { top: Math.round(el.scrollTop), end: el.scrollTop > 0 && room - el.scrollTop < END };
}

/** Put a box back where it was; false when it cannot be yet (its content is not there). */
export function putBack(el: HTMLElement, p: { top: number; end: boolean }): boolean {
  const room = el.scrollHeight - el.clientHeight;
  if (p.end) {
    if (room <= 0) return false;
    el.scrollTop = room;
    return true;
  }
  if (room < p.top) return false;
  el.scrollTop = p.top;
  return true;
}

/** `use:keepScroll={id}` — the place is kept in the bag `scroll:<id>` (stageState), saved with the stage. An empty id
 *  keeps nothing (the Chat view: the app's transcript keeps its own place). */
export function keepScroll(node: HTMLElement, id: string) {
  if (!id) return {};
  return keepPlace(node, bag<Place>(`scroll:${id}`, {}));
}

/** The same on a record of the caller's own (tests). */
export function keepPlace(node: HTMLElement, place: Place) {
  const mine = place;
  // Putting the place back: over the view's first 3 s, each box once it can be, until he scrolls or touches it himself.
  let restoring = true;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let save: ReturnType<typeof setTimeout> | null = null;
  const restore = () => {
    if (!restoring) return;
    // Every tick, not once: a panel that is read again shrinks for a moment (its loading lines) and the box is cut back.
    for (const [k, el] of named(node)) if (mine[k]) putBack(el, mine[k]);
  };
  const stop = () => {
    restoring = false;
    for (const t of timers) clearTimeout(t);
  };
  // Only a box that is drawn is read: a box already taken out of the page reads as scrolled to its top.
  const record = () => {
    if (!node.isConnected) return;
    for (const [k, el] of named(node)) {
      if (!el.clientHeight) continue;
      const p = placeOf(el);
      if (p.top > 0 || mine[k]) mine[k] = p;
    }
  };
  const onScroll = () => {
    // While the place is put back the scroll events are its own; his wheel, key or press ends that first.
    if (restoring) return;
    if (save) clearTimeout(save);
    save = setTimeout(() => {
      save = null;
      record();
    }, 120);
  };
  for (let ms = 0; ms <= FOR; ms += EVERY) timers.push(setTimeout(restore, ms));
  timers.push(setTimeout(stop, FOR + 50));
  const touched = () => stop();
  node.addEventListener("scroll", onScroll, { capture: true, passive: true });
  for (const e of ["wheel", "pointerdown", "touchstart", "keydown"]) node.addEventListener(e, touched, { capture: true, passive: true });
  return {
    destroy() {
      // Read once more on the way out (a scroll he made just before leaving) — not while the place is still being put
      // back, when the boxes may not be where he left them yet.
      const settled = !restoring;
      stop();
      if (save) clearTimeout(save);
      if (settled) record();
      node.removeEventListener("scroll", onScroll, { capture: true });
      for (const e of ["wheel", "pointerdown", "touchstart", "keydown"]) node.removeEventListener(e, touched, { capture: true });
    },
  };
}
