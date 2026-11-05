/**
 * Item 458: attaching or removing a chip in the composer is a step of the
 * box's own undo history (`boxHistory.ts`), so ⌘Z takes back an attach or
 * a remove, and ⌘⇧Z redoes it, in order with the text's own steps — the
 * typed-maths accept (item 456) and the long-paste conversion (item 284)
 * included. The step's text is unchanged; its tag says what moved.
 */
import type { Attachment } from "./types";

export interface ChipTag {
  chipStep: "add" | "remove";
  /** The chip as it was when it last left the box (so a finished
   *  conversion comes back finished). */
  chip: Attachment;
  /** Where it sat among the chips, so an undone remove puts it back there. */
  index: number;
}

export function isChipTag(t: unknown): t is ChipTag {
  return typeof t === "object" && t !== null && "chipStep" in t;
}

/**
 * The chips after undoing (`dir` "undo") or redoing a chip step, and the
 * tag refreshed with the chip as it left. A step whose chip is already
 * where the step would put it changes nothing.
 */
export function chipStep(tag: ChipTag, dir: "undo" | "redo", chips: readonly Attachment[]): { chips: Attachment[]; removed: number | null } {
  // Undoing an add or redoing a remove takes the chip out; the other two put it back.
  const out = (tag.chipStep === "add") === (dir === "undo");
  const i = chips.findIndex((c) => c.id === tag.chip.id);
  if (out) {
    if (i < 0) return { chips: [...chips], removed: null };
    tag.chip = chips[i];
    tag.index = i;
    return { chips: chips.filter((_, k) => k !== i), removed: tag.chip.id };
  }
  if (i >= 0) return { chips: [...chips], removed: null };
  const at = Math.max(0, Math.min(tag.index, chips.length));
  return { chips: [...chips.slice(0, at), tag.chip, ...chips.slice(at)], removed: null };
}
