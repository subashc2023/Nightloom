/**
 * Item 591 (2026-11-10): the brief in front of a subagent's task, in its
 * tab, under Filament IV — open by default, a section that scrolls inside
 * itself, starting at about a third of the height the open brief took
 * before (it ran the whole page), with a drag handle on its bottom edge.
 *
 * One setting for every agent tab, kept across a relaunch (`viewState`,
 * persisted): whether the brief is open, and the height he dragged it to
 * (0 = never dragged: the default). The arithmetic is here, pure, so it is
 * tested without a DOM; the reactive reads are `agentBrief.svelte.ts`.
 */

export const BRIEF_OPEN_KEY = "agentTab.brief.open";
export const BRIEF_HEIGHT_KEY = "agentTab.brief.height";

/** The default height: ~240 px, about a third of the old open brief at 1440 × 900. */
export const BRIEF_DEFAULT = 240;
/** Never smaller than this: three lines and the edge. */
export const BRIEF_MIN = 72;
/** The default never takes more than this share of the pane. */
export const BRIEF_DEFAULT_SHARE = 0.35;
/** A drag never takes more than this share of the pane (the composer stays in view). */
export const BRIEF_MAX_SHARE = 0.8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The largest height a drag may reach in a pane `pane` px tall (0: unmeasured). */
export function briefMax(pane: number): number {
  return pane > 0 ? Math.max(BRIEF_MIN, Math.round(pane * BRIEF_MAX_SHARE)) : Number.POSITIVE_INFINITY;
}

/**
 * The height the brief is drawn at (its `max-height`: a short brief takes
 * only its own height). `stored` is the dragged height, 0 when he never
 * dragged; `pane` is the tab's height, 0 before it is measured.
 */
export function briefHeight(stored: number, pane: number): number {
  if (!(stored > 0)) {
    const share = pane > 0 ? pane * BRIEF_DEFAULT_SHARE : BRIEF_DEFAULT;
    return Math.round(Math.max(BRIEF_MIN, Math.min(BRIEF_DEFAULT, share)));
  }
  return Math.round(clamp(stored, BRIEF_MIN, briefMax(pane)));
}

/**
 * A drag's height: where it started (the box's drawn height), how far the
 * pointer moved down (`dy`, negative up), the pane, and the brief's own
 * full height (`content`, 0 if unknown) — dragging past the end of a short
 * brief would only store a height nothing shows.
 */
export function briefDrag(start: number, dy: number, pane: number, content = 0): number {
  const hi = Math.max(BRIEF_MIN, Math.min(briefMax(pane), content > 0 ? content : Number.POSITIVE_INFINITY));
  return Math.round(clamp(start + dy, BRIEF_MIN, hi));
}

/** A key on the drag handle: ↑/↓ by 24 px (Shift: 96), Home/End to the ends; null for any other key. */
export function briefKeyStep(key: string, shift: boolean, now: number, pane: number, content = 0): number | null {
  const step = shift ? 96 : 24;
  if (key === "ArrowUp") return briefDrag(now, -step, pane, content);
  if (key === "ArrowDown") return briefDrag(now, step, pane, content);
  if (key === "Home") return briefDrag(BRIEF_MIN, 0, pane, content);
  if (key === "End") return briefDrag(Number.MAX_SAFE_INTEGER / 2, 0, pane, content);
  return null;
}
