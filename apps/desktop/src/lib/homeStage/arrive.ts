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

/** What Watching draws (pure): a section only once it has something; the one calm line while nothing needs him. */
export function watchShape(o: { sources: number; reading: boolean; needs: number; steps: number; busy: boolean }): { sources: boolean; needs: boolean; steps: boolean; calm: string | null; bare: boolean } {
  const sources = o.sources > 0 || o.reading;
  const needs = o.needs > 0;
  const steps = o.steps > 0 || o.busy;
  const bare = !sources && !needs && !steps;
  const calm = needs
    ? null
    : bare
      ? "Nothing needs you. Home is watching — what needs you, what it handled and its steps show up here as they happen. Connect what it may read in Settings → Home."
      : "Nothing needs you — Home is watching.";
  return { sources, needs, steps, calm, bare };
}
