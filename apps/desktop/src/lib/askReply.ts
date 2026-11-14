// A message he sends while a prompt waits on him (nightshift item 522, 2026-11-09).
//
// On the Claude Code engine a prompt is a call the CLI *deferred*: its process has exited and nothing runs
// until he answers (agent/ask.rs). A message typed then used to queue "until this turn ends" with no way to
// send it, while the turn could only end by answering — he was trapped. Now the message **is** an answer: the
// call is refused with his words as the reason, the model reads them in the call's result and carries on —
// what Claude's own desktop app does. The pure parts live here; the send is `replyToPending` (state.svelte.ts).
//
// Every Ask-position kind is covered, since each is the same deferred call and the same refusal:
// the model's question (`AskUserQuestion`), the plan card (`ExitPlanMode` — his words are why it keeps
// planning), a permission prompt (his words are the deny reason) and Playwright's card. Not covered: the
// provider (API key) engine's prompt, whose turn holds its process open and has no way in for a message.
import type { ApprovalRequest, Attachment } from "./types";

export type AskKind = "question" | "plan" | "browser" | "call";

/** Which card a deferred call draws. */
export function askKind(name: string): AskKind {
  if (name === "AskUserQuestion") return "question";
  if (name === "ExitPlanMode") return "plan";
  if (name.startsWith("mcp__playwright__")) return "browser";
  return "call";
}

/**
 * The prompt a message would answer: the oldest one waiting in the chat on screen, on the Claude Code engine
 * only. `null` — nothing waits, or the engine has no deferred calls.
 */
export function pendingFor(approvals: readonly ApprovalRequest[], engine: string | null | undefined): ApprovalRequest | null {
  if (engine !== "claude-code") return null;
  return approvals[0] ?? null;
}

/**
 * Whether the message can ride with the refusal itself: words only. A refusal's reason is text, so a message
 * with files goes the other way — the call is refused saying a message follows, and the message is handed to
 * the resumed process whole (`FOLLOWS`), its files with it.
 */
export function carriesAlone(q: { text: string; attachments: readonly Attachment[] }): boolean {
  return q.text.trim() !== "" && q.attachments.length === 0;
}

/** The refusal's reason when the message follows separately (it has files). */
export const FOLLOWS =
  "The user did not answer this; they sent a message with files instead. It follows as their next message — wait for it and go by it before doing anything else.";

/** What became of a reply. */
export type ReplyResult =
  /** His words went as the refusal's reason. */
  | "sent"
  /** The call was refused and his message (with files) is handed to the resumed turn. */
  | "follows"
  /** Nothing was waiting on him: the caller carries on as before. */
  | "none"
  /** The answer could not be given; the row is still queued and the card is back. */
  | "failed";
