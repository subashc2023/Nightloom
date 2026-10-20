/**
 * The composer's Stop (item 398, 2026-10-19): an icon button that takes
 * Send's place and Send's size while a turn runs. Being where Send was, a
 * double-click on Send would land its second click on Stop and end the
 * turn it had just started; so a Stop ignores clicks for its first
 * `STOP_ARM_MS` on screen. Longer than a double-click's two clicks
 * (typically 100–250 ms apart), short enough that a deliberate Stop is
 * never refused.
 */
export const STOP_ARM_MS = 400;

/** Whether a click `now` counts, for a Stop shown at `shownAt` (ms). */
export function stopArmed(shownAt: number, now: number, armMs: number = STOP_ARM_MS): boolean {
  return now - shownAt >= armMs;
}

/**
 * `use:armStop` on the button: a click before it is armed stops at the
 * button, so the component's own onclick (delegated, at the root) never
 * sees it.
 */
export function armStop(node: HTMLElement, armMs: number = STOP_ARM_MS): { destroy(): void } {
  const shownAt = performance.now();
  const guard = (e: MouseEvent) => {
    if (stopArmed(shownAt, performance.now(), armMs)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  node.addEventListener("click", guard, true);
  return { destroy: () => node.removeEventListener("click", guard, true) };
}

/**
 * ⌘. stops (item 398, blocker 1506 — his yes, 2026-10-19): the macOS
 * menu's View → Stop carries ⌘. as a `stop_turn` menu event; elsewhere
 * `App.svelte` binds Ctrl+. to the same id. What it stops is what the
 * Stop button on screen would: an aside thread's answer when that
 * thread's box has the keyboard, else the chat's turn; nothing when
 * neither runs. An aside box with the keyboard and no answer coming
 * stops nothing — never the chat's turn behind it, whose Stop is not the
 * one in front of him.
 */
export function stopChordTarget(s: { asideFocused: boolean; asideBusy: boolean; turnBusy: boolean }): "aside" | "turn" | null {
  if (s.asideFocused) return s.asideBusy ? "aside" : null;
  return s.turnBusy ? "turn" : null;
}

/** The chord as the tooltip names it, per platform. */
export function stopChordLabel(mac: boolean): string {
  return mac ? "⌘." : "Ctrl+.";
}
