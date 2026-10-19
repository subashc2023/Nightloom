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
