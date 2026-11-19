/**
 * The stage's focus rules (item 845 batch 4; 809 round 6's engine, `harness/home809/engine.ts` on design-809-r4), on
 * live tabs. Pure: Stage.svelte feeds it the tab row and the kept state, and it moves `focus` only by these rules.
 *
 *   rank:   needs you (3) > what he asked for (2) > Home's own work (1) > Watch and Chat (0).
 *   want:   a tab that is new, or whose needs-you count rose, asks for focus. He asked for it (his words pinned on the
 *           task) → it takes focus at once unless he is mid-typing in a view; otherwise it takes focus only when
 *           "Follow Home" is on and he has not touched the app for 10 s, and only over a lower rank. Else its tab
 *           pulses "<View> ready →" and waits.
 *   follow: every second, when Follow Home is on and he is idle, the best waiting tab takes focus over a lower rank.
 *   his pick: focus goes where he clicks; Follow Home stays as he set it (the "Stay here" on the switch note turns it off).
 *   fold:   the tab in focus went away (closed or gone from Home's list) → one switch to the best tab left, else Watch.
 *   split:  a second live task beside the one in focus (wide stages only): the newest task tab that is not in focus.
 */
import type { Tab } from "./tabs";

export const IDLE_MS = 10_000;

export interface FocusKept {
  focus: string;
  follow: boolean;
  split: boolean;
  /** Tabs waiting for him ("ready →"), oldest first. */
  ready: string[];
  /** Every task tab seen, with its last needs-you count — so a restart does not make old tabs new. */
  seen: Record<string, number>;
  /** The last switch the stage made by itself, for its note ("Switched to …" / Back / Stay here). */
  note: { from: string; to: string; at: number } | null;
}

export const freshFocus = (): FocusKept => ({ focus: "watch", follow: true, split: false, ready: [], seen: {}, note: null });

/** What the page's storage held, made safe. */
export function readFocus(v: unknown, focus: string): FocusKept {
  const o = (v && typeof v === "object" ? v : {}) as Partial<FocusKept>;
  const seen: Record<string, number> = {};
  if (o.seen && typeof o.seen === "object") for (const [k, n] of Object.entries(o.seen)) if (typeof n === "number") seen[k] = n;
  return {
    focus,
    follow: o.follow !== false,
    split: o.split === true,
    ready: Array.isArray(o.ready) ? o.ready.filter((x): x is string => typeof x === "string") : [],
    seen,
    note: null,
  };
}

/** A task tab's rank. `asked`: his words are pinned on it (the task's `why`). */
export function rank(t: Tab | undefined, asked: (id: string) => boolean): number {
  if (!t || t.view === "watch" || t.view === "chat") return 0;
  if (t.needs > 0) return 3;
  return asked(t.id) ? 2 : 1;
}

export interface Now {
  now: number;
  lastTouch: number;
  /** He is typing in a view's own field, or dragging a card: a switch would break it. */
  busy: boolean;
}
export const idle = (n: Now) => !n.busy && n.now - n.lastTouch >= IDLE_MS;

function setFocus(k: FocusKept, id: string, n: Now, by: "home" | "asked" | "fold") {
  if (k.focus === id) return;
  const from = k.focus;
  k.focus = id;
  k.ready = k.ready.filter((x) => x !== id);
  k.note = by === "home" ? { from, to: id, at: n.now } : null;
}

/**
 * One pass of the rules over the current tab row. Call it whenever the row changes and once a second. Returns true
 * when focus moved. `loaded`: the task list has been read at least once (until then a kept task tab may simply not be
 * there yet, and nothing folds).
 */
export function step(k: FocusKept, row: readonly Tab[], n: Now, asked: (id: string) => boolean, loaded: boolean): boolean {
  const before = k.focus;
  const ids = new Set(row.map((t) => t.id));
  const get = (id: string) => row.find((t) => t.id === id);
  const tasky = (t: Tab) => t.view !== "watch" && t.view !== "chat";
  if (loaded) {
    // Forget what is gone; a gone tab never waits.
    k.ready = k.ready.filter((id) => ids.has(id));
    for (const id of Object.keys(k.seen)) if (!ids.has(id)) delete k.seen[id];
    // Fold: the tab in focus went away.
    if (!ids.has(k.focus)) {
      const best = row.filter(tasky).sort((a, b) => rank(b, asked) - rank(a, asked))[0];
      setFocus(k, best?.id ?? "watch", n, "fold");
    }
    // Want: new tabs and risen needs.
    for (const t of row) {
      if (!tasky(t)) continue;
      const was = k.seen[t.id];
      k.seen[t.id] = t.needs;
      const isNew = was === undefined;
      if (!isNew && t.needs <= was) continue;
      if (t.id === k.focus) continue;
      const mine = isNew && asked(t.id);
      const may = mine ? !n.busy : k.follow && idle(n);
      if (may && rank(t, asked) > rank(get(k.focus), asked)) setFocus(k, t.id, n, mine ? "asked" : "home");
      else if (!k.ready.includes(t.id)) k.ready.push(t.id);
    }
  }
  // Follow: the best waiting tab, once he is idle.
  if (k.follow && idle(n) && k.ready.length) {
    const best = k.ready.map(get).filter((t): t is Tab => !!t).sort((a, b) => rank(b, asked) - rank(a, asked))[0];
    if (best && rank(best, asked) > rank(get(k.focus), asked)) setFocus(k, best.id, n, "home");
  }
  if (k.note && n.now - k.note.at > 4200) k.note = null;
  return k.focus !== before;
}

/** His click on a tab. */
export function pickTab(k: FocusKept, id: string) {
  k.focus = id;
  k.ready = k.ready.filter((x) => x !== id);
  k.note = null;
}

/** The second view when split is on: the newest task tab not in focus (never Watch or Chat). */
export function secondOf(k: FocusKept, row: readonly Tab[]): Tab | undefined {
  if (!k.split) return undefined;
  return [...row].reverse().find((t) => t.id !== k.focus && t.view !== "watch" && t.view !== "chat");
}
