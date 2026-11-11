/**
 * Item 632: which background the new-chat page draws (Settings → Animations
 * → New-chat background). Weft is the default (agent pick, blocker 1882);
 * today's still dots stay as a choice. Remembered in localStorage; Welcome
 * reads it live, so a pick shows the next time the page is on screen (or at
 * once, if it is).
 */
import type { GroundStyle } from "./newChatGround";

export const DEFAULT_GROUND: GroundStyle = "weft";
const KEY = "nightloom.newChatGround";

/** A stored value read back; anything unknown is the default. */
export function parseGround(v: string | null): GroundStyle {
  return v === "dots" || v === "ripple" || v === "weft" || v === "drift" || v === "aurora" ? v : DEFAULT_GROUND;
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
