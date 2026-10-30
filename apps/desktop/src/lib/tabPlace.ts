/**
 * Where a tab's view was scrolled, by what the tab shows (item 487).
 *
 * `keptTabs.svelte.ts` keeps the read-only views and the note mounted while
 * their tab is open, so a switch keeps everything. This is for the rest:
 * a view drawn afresh — a singleton page (Nightshift, New project), a kept
 * view after it fell off the pane's kept list or its tab was closed and the
 * same file opened again, a tab moved to the other pane. The action on a
 * tab's content box records the `scrollTop`/`scrollLeft` of whichever of its
 * descendants scrolls (a capture listener: `scroll` does not bubble), by the
 * element's path of child indices under the box, and puts each back when a
 * box with the same key mounts — as soon as that element exists and is tall
 * enough, while the view loads and lays out, until he scrolls, clicks or
 * types in it himself, or a second and a half has gone.
 *
 * Keyed by the tab's content (`placeKey`), not the tab, so a closed and
 * reopened file comes back where it was. Not persisted, as 065's chat
 * positions are not: pixels of a layout a relaunch redoes.
 *
 * The chat and the aside are not keyed here — they have their own (065 and
 * 237's map, with the transcript's pinning and render window), and a note
 * is not either: opened from a search hit it must land on the hit.
 */
import type { TabContent } from "./tabs";

export interface Place {
  top: number;
  left: number;
}

/** The key a view's place is kept under, or null for a kind not kept here. */
export function placeKey(c: TabContent): string | null {
  switch (c.kind) {
    case "file":
      return `file:${c.path}`;
    case "attachment":
      return c.draft
        ? null
        : `attachment:${c.session}:${c.turn}:${c.media}:${c.index}`;
    case "thread":
      return `thread:${c.slug}`;
    case "subagent":
      return `subagent:${c.session}:${c.toolUseId}`;
    case "nightshift":
    case "new-project":
      return c.kind;
    default:
      return null;
  }
}

const MAX_KEYS = 200;
const places = new Map<string, Map<string, Place>>();

/** The path of child indices from `root` down to `el` ("" for `root`), or
 *  null when `el` is not inside it. */
export function pathOf(root: Element, el: Element): string | null {
  const steps: number[] = [];
  let at: Element | null = el;
  while (at && at !== root) {
    const parent: Element | null = at.parentElement;
    if (!parent) return null;
    steps.push(Array.prototype.indexOf.call(parent.children, at));
    at = parent;
  }
  return at === root ? steps.reverse().join("/") : null;
}

export function atPath(root: Element, path: string): Element | null {
  if (path === "") return root;
  let at: Element | null = root;
  for (const s of path.split("/")) {
    at = at?.children[Number(s)] ?? null;
    if (!at) return null;
  }
  return at;
}

export function rememberPlace(key: string, path: string, place: Place): void {
  let m = places.get(key);
  if (!m) {
    m = new Map();
    places.set(key, m);
    if (places.size > MAX_KEYS)
      places.delete(places.keys().next().value as string);
  }
  if (place.top <= 0 && place.left <= 0) m.delete(path);
  else
    m.set(path, { top: Math.max(0, place.top), left: Math.max(0, place.left) });
}

export function recallPlaces(key: string): ReadonlyMap<string, Place> {
  return places.get(key) ?? new Map();
}

/** For the suite. */
export function resetPlaces(): void {
  places.clear();
}

/** How long a mounting view is put back while it loads, in ms. */
export const RESTORE_MS = 1500;
const RETRY_MS = [0, 50, 150, 300, 600, 1000, RESTORE_MS];

/**
 * Put `root`'s descendants back where `key` says they were. Returns a cancel.
 * Each attempt sets every remembered element that exists and has the room;
 * attempts run at once, on every change under `root`, and on a few timers,
 * so content that arrives late (a file read, an image's height) is caught,
 * and a view's own mount-time scroll (a log opening at its end) is undone.
 */
function restore(root: HTMLElement, key: string | null): () => void {
  if (!key) return () => {};
  const want = [...recallPlaces(key)];
  if (want.length === 0) return () => {};
  let live = true;
  const attempt = () => {
    if (!live) return;
    for (const [path, p] of want) {
      const el = atPath(root, path);
      if (!el) continue;
      if (
        Math.abs(el.scrollTop - p.top) > 1 &&
        el.scrollHeight - el.clientHeight >= p.top - 1
      )
        el.scrollTop = p.top;
      if (
        Math.abs(el.scrollLeft - p.left) > 1 &&
        el.scrollWidth - el.clientWidth >= p.left - 1
      )
        el.scrollLeft = p.left;
    }
  };
  const mo = new MutationObserver(attempt);
  mo.observe(root, { childList: true, subtree: true });
  const timers = RETRY_MS.map((ms) =>
    setTimeout(ms === RESTORE_MS ? stop : attempt, ms),
  );
  const input = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
  function stop() {
    if (!live) return;
    live = false;
    mo.disconnect();
    for (const t of timers) clearTimeout(t);
    for (const ev of input) root.removeEventListener(ev, stop, true);
  }
  for (const ev of input) root.addEventListener(ev, stop, true);
  attempt();
  return stop;
}

/** The action: `<div use:tabPlace={placeKey(content)}>`. */
export function tabPlace(node: HTMLElement, key: string | null) {
  let current = key;
  let cancel = restore(node, current);
  const onScroll = (e: Event) => {
    if (!current || !(e.target instanceof Element)) return;
    const path = pathOf(node, e.target);
    if (path !== null)
      rememberPlace(current, path, {
        top: e.target.scrollTop,
        left: e.target.scrollLeft,
      });
  };
  node.addEventListener("scroll", onScroll, true);
  return {
    update(k: string | null) {
      if (k === current) return;
      cancel();
      current = k;
      cancel = restore(node, current);
    },
    destroy() {
      cancel();
      node.removeEventListener("scroll", onScroll, true);
    },
  };
}
