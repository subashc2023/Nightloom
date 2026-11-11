/**
 * Item 598: a project switch in flight. `useProject` (state.svelte.ts) clears
 * the open chat at once and re-opens the project's own one only after its
 * lists are read — the gap drew the new-chat page for about a second, which
 * looked like a bug. While `on`, the new-chat page (`Welcome.svelte`) is
 * covered: plain ground first, then, if the gap lasts past
 * `SWITCH_GEAR_AFTER_MS`, the dial's gears turning as the loading state. A
 * project with no chat to re-open lands on its new-chat page as before.
 */

/** A gap shorter than this shows only the ground: a gear that flashes is a flash too. */
export const SWITCH_GEAR_AFTER_MS = 150;

export const projectSwitch = $state({ on: false });
