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
  // ~~thinkingToggle / toolsToggle: "an aside's answer streams its text
  // only"~~ — item 403 gave an aside's answer the chat's thinking and tool
  // rows, so since item 605 (2026-11-11) the two toggles are in its row.
  // ~~cacheChip: "the chip times the chat's cache; the aside's head says
  // what it read from it"~~ — item 786 (2026-11-17, his "we have none of
  // the cash information on this"): the aside reads the chat's cache, so
  // its box draws the chat's chip and keep-warm switch (ASIDE_KEPT).
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
  // Item 605: the transcript toggles, now an aside's answer has both.
  "thinkingToggle",
  "toolsToggle",
  // Item 786: the cache chip and the keep-warm switch beside it.
  "cacheChip",
  "keepWarm",
  "copy",
  "edit",
  "rewind",
] as const;

/** Whether a composer draws `control`: everything in the chat's; in an
 *  aside's, all but `ASIDE_HIDDEN`. */
export function composerShows(control: ChatOnlyControl, inAside: boolean): boolean {
  return !inAside || !(control in ASIDE_HIDDEN);
}

/*
 * Item 853 (2026-11-18, his "for the fucking trillionth time i ask you to
 * make their functionality same in all the ways that matter"): the
 * *behaviours* of the chat's box, beside the controls above — each one's
 * state in an aside tab's box and an aside card's (floating, at the foot,
 * or the side panel's). `same`: the shared `Composer` does it, or the
 * window's routing (`composerTarget`, typeToCompose.ts) sends it to the box
 * meant. `fixed-853`: it was the chat's alone until item 853. `n/a`: it has
 * no meaning in an aside, with why. One table, so the report, the suite and
 * the code cannot disagree (`aside853parity.test.ts`).
 */
export type Parity = "same" | "fixed-853" | `n/a: ${string}`;

export const ASIDE_BEHAVIOURS: Record<string, { tab: Parity; card: Parity; where: string }> = {
  typeToFocus: { tab: "fixed-853", card: "fixed-853", where: "typeToCompose.ts composerTarget / composerSummon.svelte.ts boxMounted" },
  enterSendsFromAnywhere: { tab: "fixed-853", card: "fixed-853", where: "typeToCompose.ts typeToComposeKeydown (item 387)" },
  pasteFromOutside: { tab: "fixed-853", card: "fixed-853", where: "pasteToCompose.ts target, Composer registerPasteHandler (item 351)" },
  cmdL: { tab: "fixed-853", card: "fixed-853", where: "Composer summon effect, isSummonTarget (item 290)" },
  stopChord: { tab: "fixed-853", card: "fixed-853", where: "Composer ⌘. interceptor (item 398)" },
  escapeInBox: { tab: "same", card: "fixed-853", where: "AsideCard cardKeys honours an Escape the box took" },
  enterSend: { tab: "same", card: "same", where: "Composer onkeydown" },
  shiftEnterNewline: { tab: "same", card: "same", where: "Composer onkeydown" },
  pasteInBox: { tab: "same", card: "same", where: "Composer onpaste (images, math, code, long paste)" },
  pasteAsAttachment: { tab: "same", card: "same", where: "Composer pasteAsAttachment (⌥⌘V)" },
  clipRing: { tab: "same", card: "same", where: "Composer onkeydown ⌘⇧V" },
  dropFiles: { tab: "same", card: "same", where: "Composer ondrop + DropOverlay region (item 674)" },
  drafts: { tab: "same", card: "same", where: "asideDraftKey: kept per thread, survives a switch and a relaunch" },
  caretKept: { tab: "same", card: "same", where: "Composer CaretKeeper per key" },
  focusOnArrival: { tab: "same", card: "n/a: a floating card is placed beside the chat's box; AsideLayer focuses its box once placed", where: "Composer wantsFocus / AsideLayer" },
  queueUpArrow: { tab: "same", card: "same", where: "Composer onkeydown ↑ in an empty box edits the last queued row" },
  queue: { tab: "same", card: "same", where: "Composer asideDrain" },
  boxUndo: { tab: "same", card: "same", where: "Composer boxHistoryKey + menuInterceptors" },
  sizingAndReset: { tab: "same", card: "same", where: "Composer boxGrow / ⌥⌘↑↓ stepHeight (card: compact cap)" },
  slash: { tab: "same", card: "same", where: "Composer slash menu" },
  typedMath: { tab: "same", card: "same", where: "Composer mathShown" },
  replyQuote: { tab: "same", card: "same", where: "Composer takeReply(key) (item 481)" },
  rewindEditFocus: { tab: "same", card: "same", where: "Composer composerFocus.key (item 674)" },
  lockFocusBack: { tab: "same", card: "same", where: "Composer FocusThroughLock" },
  sendLater: { tab: "n/a: ASIDE_HIDDEN.schedule", card: "n/a: ASIDE_HIDDEN.schedule", where: "asideControls ASIDE_HIDDEN" },
  palette: { tab: "same", card: "same", where: "App.svelte ⌘K/⌘P: the window's, not a box's" },
  ghost: { tab: "n/a: ASIDE_HIDDEN.ghost", card: "n/a: ASIDE_HIDDEN.ghost", where: "asideControls ASIDE_HIDDEN" },
  heldPassage: { tab: "n/a: the held passage is taken by Ask aside, which an aside's box is", card: "n/a: as tab", where: "Composer held (item 694)" },
  passageComments: { tab: "n/a: comments go with a chat message; an aside's question travels as text", card: "n/a: as tab", where: "Composer comments (item 754)" },
  prewarm: { tab: "n/a: prewarms the chat's next CLI process; an aside answers off the chat's cache", card: "n/a: as tab", where: "prewarm.ts wantsWarm" },
};

/**
 * Every place `Composer.svelte` gates a behaviour on `aside` (`if (aside`,
 * `aside ? undefined`, `(aside ||`), found by the suite in the gate line
 * and the two after it. A new gate with no row here fails the suite: a
 * behaviour wired to the chat's box alone must say why here first.
 */
export const COMPOSER_ASIDE_GATES: { match: string; behaviour: string; why: string }[] = [
  { match: "return () => dropHeld(k);", behaviour: "heldPassage", why: "chat-only: ASIDE_BEHAVIOURS.heldPassage" },
  { match: "untrack(() => dropHeld(key));", behaviour: "heldPassage", why: "chat-only: ASIDE_BEHAVIOURS.heldPassage" },
  { match: "takeCommentFocus(key)", behaviour: "passageComments", why: "chat-only: ASIDE_BEHAVIOURS.passageComments" },
  { match: "noteThread(chat, slug)", behaviour: "handoff", why: "chat-only: ASIDE_HIDDEN.handoff" },
  { match: "refreshThreadFlags(boundThread)", behaviour: "handoff", why: "chat-only: ASIDE_HIDDEN.handoff" },
  { match: "probeCodeProject(chat, root)", behaviour: "handoff", why: "chat-only: ASIDE_HIDDEN.handoff" },
  { match: 'if (handoff.stage === "due") untrack(() => probeCodeProject', behaviour: "handoff", why: "chat-only: ASIDE_HIDDEN.handoff" },
  { match: "const used = contextUsed();", behaviour: "handoff", why: "chat-only: the context fill is the chat's" },
  { match: "const fams = familyRows(AGENT_PILLS, newestIds, modelSeen.byAlias, cliNow, \"\")", behaviour: "handoff", why: "chat-only: ASIDE_HIDDEN.handoff — the next chat's model rows (item 705)" },
  { match: "return asideDrain();", behaviour: "queue", why: "the aside's own drain: same behaviour" },
  { match: "stopSendFor(key)", behaviour: "queue", why: "chat-only: Send now interrupts a chat turn (item 536)" },
  { match: "registerScheduleDrain", behaviour: "sendLater", why: "chat-only: ASIDE_HIDDEN.schedule" },
  { match: "registerProviderDrain", behaviour: "queue", why: "chat-only: a provider turn off screen holds the chat's engine" },
  { match: "registerRunDrain", behaviour: "queue", why: "chat-only: a ran block's output is the chat's next turn (item 503)" },
  { match: "registerSendHeld", behaviour: "queue", why: "chat-only: Send now on a transcript bubble is the chat's (item 548)" },
  { match: "afterSend(key);", behaviour: "queue", why: "the aside's queue waits for its answer: same behaviour" },
  { match: "void asideDrain()", behaviour: "queue", why: "the aside's own drain: same behaviour" },
  { match: "return asideSubmit();", behaviour: "enterSend", why: "the aside's own send: same behaviour" },
  { match: '"claude-code" : "api"', behaviour: "attach", why: "an aside runs on Claude Code only (081)" },
];
