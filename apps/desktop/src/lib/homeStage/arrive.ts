/**
 * Item 944: Home starts simple and grows. A section of Watching with nothing in it is not drawn; the first time it
 * has something, it arrives — a short rise out of an amber glow in Jarvis; no motion in Classic or with Reduce
 * motion. It plays when the section appears while he is looking, never when the view opens.
 */
export const ARRIVE_CLASS = "h9-arrive";

/**
 * An action for a section that may appear late: when `late()` is true as the node is made (the view was already
 * drawn), the node wears `h9-arrive` — a CSS animation (stage.css), so a window that is hidden or cannot animate
 * simply shows the section (a script-driven transition can stay stuck at its first frame there: 845's "ghost").
 */
export function arriveWhen(late: () => boolean) {
  return (node: HTMLElement) => {
    if (late()) node.classList.add(ARRIVE_CLASS);
  };
}

/**
 * What Watching draws (pure): a section only once it has something; the one line while Home lists nothing.
 * `needs` is how many rows Home lists itself; `waiting` (item 995) is the one Needs-you number every badge shows
 * (`needCount`) — held blockers and proposals included, which Home counts but does not list (item 945). The line
 * says "Nothing needs you" only when that number is 0; otherwise it says the number (`waits` true: amber light).
 */
export function watchShape(o: { sources: number; reading: boolean; needs: number; steps: number; busy: boolean; waiting?: number }): {
  sources: boolean;
  needs: boolean;
  steps: boolean;
  calm: string | null;
  bare: boolean;
  waits: boolean;
} {
  const sources = o.sources > 0 || o.reading;
  const needs = o.needs > 0;
  const steps = o.steps > 0 || o.busy;
  const waiting = Math.max(0, o.waiting ?? 0);
  const waits = !needs && waiting > 0;
  const bare = !sources && !needs && !steps && !waits;
  const calm = needs
    ? null
    : waits
      ? `${waiting} ${waiting === 1 ? "needs" : "need"} you — none of it in your chats.`
      : bare
        ? "Nothing needs you. Home is watching — what needs you, what it handled and its steps show up here as they happen. Connect what it may read in Settings → Home."
        : "Nothing needs you — Home is watching.";
  return { sources, needs, steps, calm, bare, waits };
}
