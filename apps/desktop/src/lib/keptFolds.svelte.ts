/**
 * The chat view's folds, kept past the view (item 495 part 2, his rule of
 * 2026-11-02: "this should just be a standing rule everywhere").
 *
 * The transcript draws every reply afresh when he goes to another chat and
 * comes back (and the live reply is replaced by the recorded one when a
 * turn ends), so a fold that was a component's own `$state` — a thinking
 * block opened, a tool call collapsed, a subagent's group, a diff's Show
 * all — went back to its default. Here they live in `viewState`, session
 * only (a fold opened yesterday is not what he expects at launch), keyed by
 * the chat and what the fold is about:
 *
 * - a tool call by its id alone (`<chat>|tool:<id>`): the API's ids are
 *   unique in a chat, so the live reply and the recorded one share it;
 * - anything else by the turn too (`<chat>|<turn>|thinking:0`).
 *
 * Two forms: `keptGet`/`keptSet`, reactive (a `$derived` reading one is
 * re-run when any is set), for folds a button flips; and the `keptOpen`
 * action for a native `<details>`, which reads its key when drawn (and when
 * the key changes, a reused element under another chat) and writes on
 * every toggle.
 */
import { viewGet, viewSet, type ViewValue, type Widen } from "./viewState";

/** Bumped on every set, so a `$derived` reading a kept fold sees it. */
const version = $state({ n: 0 });

export function keptGet<T extends ViewValue>(key: string, fallback: T): Widen<T> {
  void version.n;
  return viewGet(key, fallback);
}

export function keptSet<T extends ViewValue>(key: string, value: Widen<T>, fallback: T): void {
  viewSet(key, value, fallback, { session: true });
  version.n++;
}

/** Where a reply's folds are kept: its chat, and its turn in that chat. */
export interface FoldScope {
  chat: string;
  turn: string;
}

/**
 * The key of a reply's fold `id` (`segmentIds`'s `tool:<id>`,
 * `thinking:<n>`, a block's `block:<first row's id>`, or a name of the
 * caller's own). A tool call's (or a block led by one) is the chat's alone.
 */
export function foldKey(scope: FoldScope, id: string): string {
  const own = id.startsWith("tool:") || id.startsWith("block:tool:");
  return own ? `fold:${scope.chat}|${id}` : `fold:${scope.chat}|${scope.turn}|${id}`;
}

/** A click's override (`transcriptPrefs`'s `Override`) as one kept value. */
export function encodeOverride(o: { open: boolean; rev: number }): string {
  return `${o.open ? 1 : 0}:${o.rev}`;
}
export function decodeOverride(s: string): { open: boolean; rev: number } | undefined {
  const m = /^([01]):(\d+)$/.exec(s);
  return m ? { open: m[1] === "1", rev: Number(m[2]) } : undefined;
}

export interface KeptOpen {
  /** Null: the element is left to itself (a view with nowhere to keep it). */
  key: string | null;
  /** Its open state when nothing is kept. */
  fallback?: boolean;
}

/** `<details use:keptOpen={{ key }}>`: its open state kept under `key`. */
export function keptOpen(el: HTMLDetailsElement, params: KeptOpen) {
  let p = params;
  const read = () => {
    if (p.key === null) return;
    const open = viewGet(p.key, p.fallback ?? false);
    if (el.open !== open) el.open = open;
  };
  const onToggle = () => {
    if (p.key === null) return;
    viewSet(p.key, el.open, p.fallback ?? false, { session: true });
  };
  read();
  el.addEventListener("toggle", onToggle);
  return {
    update(next: KeptOpen) {
      const moved = next.key !== p.key || next.fallback !== p.fallback;
      p = next;
      if (moved) read();
    },
    destroy() {
      el.removeEventListener("toggle", onToggle);
    },
  };
}
