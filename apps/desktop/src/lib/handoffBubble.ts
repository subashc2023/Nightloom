/**
 * Item 706 (2026-11-18): the wrap-up *Wrap up now* sends — or the queue,
 * the budget stop, the phone — is drawn on his side as a folded Nightloom
 * hand-off card, not a wall of his own text ("clearly a nightloom message
 * but it comes from like my side"). The message's text is what the model
 * read; this is only how his side of the chat draws it.
 *
 * Read from the text, as the ran-block card is (item 503): every wrap-up
 * Nightloom sends carries the addendum's first line (`SECTIONS_MARK`,
 * `wrapUpWithSections`), so a wrap-up from before this build, a queued one
 * and one sent from the phone all draw the same. Once he edits it — in
 * place (Save) or as a fork (Send, a later version) — the transcript
 * passes `plain` and it is his ordinary message again ("if I do edit it …
 * it becomes back to being like a text message by me").
 */
import { GOAL_ASK, SECTIONS_MARK } from "./handoffCarry";

export interface HandoffMessage {
  /** The one line the folded card shows: his goal, else the message's first line. */
  headline: string;
  /** Whether the headline is his goal (`Goal for the next chat (my words):`). */
  goal: boolean;
  /** The whole text as sent, for the unfolded card. */
  text: string;
  /** Its line count, for the fold's label. */
  lines: number;
}

const HEADLINE_MAX = 140;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > HEADLINE_MAX ? `${t.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : t;
}

/** The wrap-up back, for the card; null for anything else he sent. */
export function parseHandoffMessage(text: string): HandoffMessage | null {
  if (!text || !text.includes(SECTIONS_MARK)) return null;
  const body = text.trim();
  const goalLine = body.split("\n").find((l) => l.startsWith(GOAL_ASK));
  const goal = goalLine ? clip(goalLine.slice(GOAL_ASK.length)) : "";
  const first = body.split("\n").find((l) => l.trim() && !l.startsWith(SECTIONS_MARK)) ?? "";
  return {
    headline: goal || clip(first.replace(/^[#>*\-\s]+/, "")) || "Wrap up this chat",
    goal: !!goal,
    text: body,
    lines: body.split("\n").length,
  };
}

/**
 * Whether a wrap-up turn draws as his plain message: edited in place
 * (`original` is the text before the edit), or a fork's edited first
 * message (its place among the versions is past the first, the original).
 */
export function handoffIsPlain(original: string | null, versionN: number | null): boolean {
  return original !== null || (versionN !== null && versionN > 1);
}
