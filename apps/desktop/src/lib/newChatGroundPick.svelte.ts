/**
 * Item 632: which background the new-chat page draws (Settings → Animations
 * → New-chat background). Weft is the default (agent pick, blocker 1882);
 * today's still dots stay as a choice. Remembered in localStorage; Welcome
 * reads it live, so a pick shows the next time the page is on screen (or at
 * once, if it is).
 */
import type { GroundStyle } from "./newChatGround";

// Item 640: Horizon is the default now (his "horizon blows everything out of
// the water"). The default is not stored, so a page that never picked moves
// to Horizon; Default (Weft) is stored as "weft" from now on. A stored look
// Settings no longer offers (dots, ripple, drift, aurora) still reads back and
// draws as before; Settings shows it as the earlier pick until another is chosen.
export const DEFAULT_GROUND: GroundStyle = "horizon";
const ALL: GroundStyle[] = ["horizon", "radar", "weft", "dots", "ripple", "drift", "aurora"];
const KEY = "nightloom.newChatGround";

/** A stored value read back; anything unknown is the default. */
export function parseGround(v: string | null): GroundStyle {
  return (ALL as (string | null)[]).includes(v) ? (v as GroundStyle) : DEFAULT_GROUND;
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const groundPick = $state<{ value: GroundStyle }>({ value: parseGround(read()) });

export function setGroundPick(g: GroundStyle): void {
  groundPick.value = g;
  try {
    if (g === DEFAULT_GROUND) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, g);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
}
