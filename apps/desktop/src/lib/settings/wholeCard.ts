// Item 719 (his words, 2026-11-15: "clicking on the image or anywere in the
// box should switch to this one"): one behaviour for every option card in
// Settings — a click anywhere on the card (name, blurb, stage, preview
// image, canvas, foot) picks it. Backlog 412 did this with the pick
// button's ::after stretched over the card, but any positioned preview
// drawn later (GroundPreview's canvas, a mini view) paints above that
// overlay and swallows the click — a fix per preview that kept coming back.
// This listens on the card itself, so nothing inside can hide it.
//
// A click on the card's own pick (the [role=radio]) is left to it; a click
// on any other control inside (Preview, a link, a field) does only that.

/** The minimum of an element the decision reads, so it tests without a DOM. */
export interface CardNode {
  closest(selector: string): CardNode | null;
  getAttribute(name: string): string | null;
}

const CONTROL = "button, a[href], input, select, textarea, label, [role='radio'], [role='button']";

/**
 * Whether a click that landed on `target` inside an option card should pick
 * the card: true unless it hit a control (the pick itself included, which
 * handles its own click).
 */
export function clickPicksCard(target: CardNode | null): boolean {
  if (!target) return false;
  return target.closest(CONTROL) === null;
}

/** `use:wholeCardPicks` on an option card: a click anywhere on it clicks its [role=radio]. */
export function wholeCardPicks(card: HTMLElement) {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !card.contains(t) || !clickPicksCard(t)) return;
    const pick = card.querySelector<HTMLElement>("[role='radio']");
    if (!pick || (pick as HTMLButtonElement).disabled) return;
    pick.click();
  };
  card.addEventListener("click", onClick);
  card.classList.add("whole-card");
  return {
    destroy() {
      card.removeEventListener("click", onClick);
    },
  };
}
