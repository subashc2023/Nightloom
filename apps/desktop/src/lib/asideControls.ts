/**
 * Which of the chat's composer and message controls an aside draws
 * (nightshift backlog 283, 2026-10-02). The aside's box is the chat's
 * `Composer` and its exchanges the chat's message pieces, so every control
 * reaches an aside unless it is listed here as the chat's alone — and a
 * control added to the chat later reaches the asides with no extra work.
 * One list, so the report, the suite and the markup cannot disagree.
 */

/** Drawn in the chat's composer and not in an aside's, each with why. */
export const ASIDE_HIDDEN = {
  handoff: "the hand-off notice is about the chat's context filling; an aside adds nothing to it",
  schedule: "a scheduled send waits under a chat's id for a turn; an aside answers now, from the open chat",
  council: "a council turn is a chat turn the chat's model chairs; an aside is one answer off the cache",
  askAside: "the box is already an aside's: its Send asks",
  ghost: "the CLI's predicted next prompt is the chat's",
  thinkingToggle: "an aside's answer streams its text only; it has no thinking blocks to fold",
  toolsToggle: "an aside's answer streams its text only; it has no tool calls to fold",
  cacheChip: "the chip times the chat's cache; the aside's head says what it read from it",
  fork: "Fork helpers from here checkpoints the chat's session; an aside has no session of its own",
  removeFromContext: "an aside keeps no context to remove from: its exchanges travel as text, and Rewind drops them",
} as const;

export type ChatOnlyControl = keyof typeof ASIDE_HIDDEN;

/** The chat's controls an aside keeps, for the report and the suite. */
export const ASIDE_KEPT = [
  "attach",
  "pasteAsAttachment",
  "dropFiles",
  "model",
  "effort",
  "earlierDrafts",
  "slash",
  "clipRing",
  "format",
  "queue",
  "stop",
  "send",
  "tokens",
  "resize",
  "copy",
  "edit",
  "rewind",
] as const;

/** Whether a composer draws `control`: everything in the chat's; in an
 *  aside's, all but `ASIDE_HIDDEN`. */
export function composerShows(control: ChatOnlyControl, inAside: boolean): boolean {
  return !inAside || !(control in ASIDE_HIDDEN);
}
