import type { CacheState } from "./cache";

/**
 * Item 596 (his idea, 2026-11-10: "a slightly diff visual output on the
 * textbox when the cache is warm vs cold"): the message box shows the
 * chat's prompt cache on its own frame, read from the same `cacheState`
 * the bottom row's cache chip reads. Settings → Appearance → Cache on the
 * box. Four looks were mocked side by side (nightshift-code
 * `notes/runner-design/596-loop.html`); the agent's pick is the default
 * (blocker 1898 holds his pick):
 *
 * - Tint (the default): the frame's edge and a faint inner glow, in the
 *   lit accent while the cache is fresh, cooling toward the signal blue
 *   as it ages, and a quiet blue once it is cold.
 * - Edge: a 2px line along the top that burns down as the cache ages.
 * - Ember: a soft glow in the box's top-right corner that shrinks and
 *   cools to a small blue point.
 * - Haze: a faint warm wash up from the foot of the box that cools.
 * - Off: nothing drawn.
 *
 * Remembered in localStorage (none stored for the default). The rules are
 * in `src/cacheLook.css`, all behind `html:not([data-layout="classic"])`.
 */
export type CacheLook = "tint" | "edge" | "ember" | "haze" | "off";

export const CACHE_LOOKS: { id: CacheLook; name: string; note: string }[] = [
  { id: "tint", name: "Tint", note: "The default. The box's edge glows the accent while the cache is fresh and cools to blue as it ages; quiet blue once cold." },
  { id: "edge", name: "Edge", note: "A thin line along the box's top that burns down as the hour runs out; a blue hairline once cold." },
  { id: "ember", name: "Ember", note: "A soft glow in the box's top-right corner that shrinks and cools to a small blue point." },
  { id: "haze", name: "Haze", note: "A faint warm wash rising from the foot of the box that cools to blue." },
  { id: "off", name: "Off", note: "Nothing on the box; the cache chip under it still counts down." },
];

const KEY = "nightloom.cacheLook";

/** A stored value read back; anything unknown is the default. */
export function parseCacheLook(v: string | null): CacheLook {
  return v === "edge" || v === "ember" || v === "haze" || v === "off" ? v : "tint";
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const cacheLook = $state<{ value: CacheLook }>({ value: parseCacheLook(read()) });

export function setCacheLook(l: CacheLook): void {
  cacheLook.value = l;
  try {
    if (l === "tint") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, l);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
}

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;

/**
 * How warm the cache is, 1 the moment its request was sent and 0 when it
 * expires (and after): the share of its lifetime left. A keep-warm ping
 * restarts the lifetime (`cacheState` already moves `sentAt`), so a kept
 * cache reads fresh again.
 */
export function warmth(state: CacheState): number {
  if (!state.warm) return 0;
  const w = state.remainingMs / TTL_MS[state.ttl];
  return Math.max(0, Math.min(1, w));
}

/**
 * What the box's frame carries: `data-cache` (`warm` / `cold`, or absent
 * when the chat has no timer — a new chat, a log from before the fields)
 * and the warmth as a CSS percentage and a plain number, rounded so the
 * style only changes when the drawing would.
 */
export function cacheFrame(state: CacheState | null): { cache: "warm" | "cold"; style: string } | null {
  if (!state) return null;
  const w = Math.round(warmth(state) * 100) / 100;
  return { cache: state.warm ? "warm" : "cold", style: `--cache-w: ${Math.round(w * 100)}%; --cache-wn: ${w};` };
}
