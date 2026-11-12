/**
 * Every feature of the chat screen's transcript, said once: whether an
 * aside has it too (item 674, 2026-11-12; his rule, blocker 1981: "if they
 * exist for main they should exist for asides, and which shouldn't …
 * shared ones shared and the non shared ones separated").
 *
 * Since 674 an aside is drawn by `Transcript.svelte` itself, so a feature
 * added there reaches an aside with no port. What can still differ is only
 * what the transcript guards by the kind of its source — and every such
 * guard is counted here (`KIND_GUARDS`) and every piece it mounts is
 * classified (`TRANSCRIPT_PIECES`); `transcriptFeatures.test.ts` fails
 * when a guard or a piece is added without being classified. `asideControls.ts`
 * is the same list for the composer.
 */

export type Where =
  | { in: "shared" }
  /** Drawn in the chat only, with why an aside has no use for it. */
  | { in: "mainOnly"; why: string }
  /** The aside's own, added by `AsideTranscript.svelte` / its frame. */
  | { in: "asideOnly" }
  /** Should be shared and is not yet: what is missing. */
  | { in: "pending"; why: string };

const shared: Where = { in: "shared" };
const mainOnly = (why: string): Where => ({ in: "mainOnly", why });
const asideOnly: Where = { in: "asideOnly" };
const pending = (why: string): Where => ({ in: "pending", why });

/** The feature table (the 674 map's §1, as built). */
export const TRANSCRIPT_FEATURES: Record<string, Where> = {
  "reply rendering: markdown, maths, code, Run on shell blocks": shared,
  "thinking and tool rows, activity trace, step motion": shared,
  "thinking / tools toggles and their keys": shared,
  "folds kept across a switch": shared,
  "his bubble with images and file chips": shared,
  "copy his message": shared,
  "copy reply, reply footer (model, time, tokens)": shared,
  "edit his message in the chat's edit box (chips, paste, code keys, undo)": shared,
  "an open edit kept across a tab switch": shared,
  "rewind to here, with the rewind motion": shared,
  "redo under his last message / retry under the last reply": shared,
  "reply pill on a selection": shared,
  "dot ground and pointer push": shared,
  "navigator ribs, option-arrow steps": shared,
  "jump-down button with the speaking dots": shared,
  "reading place kept per view, render window": shared,
  "send near the foot follows the answer": shared,
  "reply stays drawn across its completion (ghost), turn-done nudge": shared,
  "presence: stops following while away": shared,
  "waiting moon before the first event": shared,
  "send arrive motion": shared,
  "turn size estimate under his message": shared,
  "narrow-gutter tool placement": shared,
  "per-turn context share bar": pending("an aside's usage sums rounds that each resend the chat's prefix; the per-turn figure is asideFigures' (item 675) and is not wired to the footer yet"),
  "per-reply plan use": pending("the plan-use lines are recorded per chat turn by the service; an aside's turn writes none"),
  "pending bubbles (a message held mid-answer)": pending("PendingBubbles reads the open chat's queue; the aside's held message stays in its composer"),
  "usage-limit pause card": pending("an aside's limit hit arrives as its turn's error text; a pause scoped to the aside needs state in runAside (item 677's file)"),
  "drop files on the transcript": pending("the drop target adds to the open chat's composer; the aside's composer takes drops itself"),
  "versions of an edited message": mainOnly("versions are session forks; an aside's edit replaces in place"),
  "edit a reply's text, remove a block or a turn, restore": mainOnly("an aside keeps no context of its own to edit"),
  "save an edit in place": mainOnly("an aside's exchanges travel as text; Ask again replaces them"),
  "fork helpers from here, checkpoint line": mainOnly("an aside has no session of its own"),
  "ask aside on a selection, aside cards": mainOnly("an aside of an aside has no context to fork from"),
  "approval prompts, answer hand-back": mainOnly("an aside runs without prompts"),
  "budget stop card": mainOnly("the 85% hold is on the chat's turn"),
  "rewound-writes card": mainOnly("an aside writes nothing"),
  "subagent groups, council chip, next-chat hand-off": mainOnly("chat-turn features"),
  "tool-result images, attachments opened as tabs": mainOnly("no session file to read them from"),
  "keep-warm notice": mainOnly("the chat's cache; the aside rides it"),
  "connect error card, error banner": mainOnly("the chat's connection; an aside's error is a note under its exchange, in the same look"),
  "continued-from line": mainOnly("a chat's lineage"),
  "queued / stalled notice, one aside at a time": asideOnly,
  "stopped-here mark, error under an exchange": asideOnly,
  "quoted passage at the head, Fold into thread at the end": asideOnly,
  "header strip (item 673), tint and edge": asideOnly,
};

/** The pieces `Transcript.svelte` mounts: each classified. */
export const TRANSCRIPT_PIECES: Record<string, Where> = {
  BoxLayer: shared,
  LiveBox: shared,
  PasteOfferRow: shared,
  EditAttachments: shared,
  ConfirmDialog: shared,
  AssistantMessage: shared,
  WaitingMoon: shared,
  UserBubble: shared,
  Icon: shared,
  Navigator: shared,
  PendingBubbles: TRANSCRIPT_FEATURES["pending bubbles (a message held mid-answer)"]!,
  KeepWarmNotice: TRANSCRIPT_FEATURES["keep-warm notice"]!,
  AsideLayer: TRANSCRIPT_FEATURES["ask aside on a selection, aside cards"]!,
  ApprovalPrompt: TRANSCRIPT_FEATURES["approval prompts, answer hand-back"]!,
  AskHandBack: TRANSCRIPT_FEATURES["approval prompts, answer hand-back"]!,
  BudgetStopCard: TRANSCRIPT_FEATURES["budget stop card"]!,
};

/**
 * How many times `Transcript.svelte` branches on what it draws. A new
 * branch is a feature the chat and an aside may no longer share: classify
 * it in `TRANSCRIPT_FEATURES`, then update the count.
 */
export const KIND_GUARDS = {
  isChat: 18,
  inPane: 8,
  inAside: 9,
  "src.chatActions": 10,
} as const;

/** The table as markdown rows, for a report. */
export function featureTable(): string {
  const say = (w: Where) =>
    w.in === "shared" ? "main and aside" : w.in === "asideOnly" ? "aside only" : w.in === "mainOnly" ? `main only — ${w.why}` : `not yet in asides — ${w.why}`;
  return Object.entries(TRANSCRIPT_FEATURES)
    .map(([name, w]) => `| ${name} | ${say(w)} |`)
    .join("\n");
}
