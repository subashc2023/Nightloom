/**
 * The context-full hand-off on the Claude Code engine (nightshift backlog
 * 086, 2026-09-16; blocker 073's row A8; pass 2 the same day per blocker
 * 120, which also answers blocker 092: the new chat is never opened or
 * sent by Nightloom).
 *
 * He does not compact — a compaction boundary in 2 of 610 sessions — and
 * the nightshift contract's answer to a full window is a hand-off written
 * to disk. So the CLI's auto-compact is off for a chat (the Rust side,
 * `AgentSpec::auto_compact`, set by `connect_agent`; ~~on every path~~ —
 * a dream or a capture keeps the CLI's compaction since 2026-09-16, review
 * F4), and this is what happens instead. It is his own hand-run practice:
 * ask the model for a wrap-up and a start prompt, then paste that prompt
 * into a fresh session.
 *
 * 1. **The fill** — the last usage the CLI reported, `input + output`
 *    over its context window, the gauge's own pair — is compared to the
 *    chat's threshold: the Settings default (70%) unless the chat has its
 *    own. Read mid-turn from each usage event and again at the turn's
 *    end. Crossing it once arms the hand-off (`due`).
 * 2. **The notice**, in the composer: the fill and the mark, a field that
 *    raises the mark for this chat, the wrap-up message editable for this
 *    chat, **Wrap up now** and **Stay here**. Nothing is sent by itself
 *    while a notice he has seen is open — his refinement: "I don't want
 *    it such that the second I leave the chat for more than 60 seconds,
 *    it suddenly sends this thing, even though I'm mid-work."
 * 3. **Away** — no send and no keystroke in the composer for 60 s, and
 *    the window not in front (or the chat not the open one) — at the
 *    crossing puts the wrap-up in the composer's queue (backlog 089), so
 *    it goes when the turn ends and can be taken back with the queue's
 *    own ×. Only at the crossing, only when away, never after a *Stay
 *    here* (nightshift blocker 121's default).
 * 4. **The wrap-up** is its own message (~~appended under a rule to his
 *    next message~~ — pass 1; superseded by blocker 120: "if I click
 *    wrap up now, it just sends that"): finish what is half-done, write
 *    `HANDOFF.md` at the top of the project, and end with a start prompt
 *    for the new chat in a fenced block tagged `start-prompt`. The
 *    default text is editable in Settings → Subscription; the copy sent is
 *    editable per chat on the notice.
 * 5. **Wrapped.** When that turn ends the last `start-prompt` block of the
 *    reply is kept, and the composer offers *Continue in a new chat ·
 *    Stay here*. Continue opens a fresh chat in the same folder, linked to
 *    this one (`forked_from` with `reason: "handoff"`), with the model's
 *    start prompt in its box — never sent. No block found: the box is
 *    left empty and the composer says so. Staying past 85% asks the
 *    wrap-up again. ~~The composer's offer~~ — superseded by item 506
 *    (2026-11-05, "why are there both?"): the reply's next-chat card is the
 *    one surface, its *Continue with this prompt* (`handoffButton.ts`) starts
 *    the linked chat and sends read order + prompt; the send here is why the
 *    wrapped stage now only holds the queue (`queueHold`, `sentHere`). A reply
 *    with no prompt gets one line in the composer, whose *Continue in a new
 *    chat* is this unsent path.
 * 6. **The read order** (backlog 193, 2026-09-25): the continued chat's
 *    box holds a fixed prompt — the read order, a Settings default with a
 *    per-chat override, practices §5's by default (blocker 366, question
 *    11, default A) — and under it the model's start prompt, which now
 *    says only what the read order does not: what changed, what to do
 *    first. Both visible and editable in the box; nothing is sent. The
 *    wrap-up adds a new `## STATE AS OF` section at the top of
 *    `HANDOFF.md` ~~overwrites HANDOFF.md~~ (superseded 2026-09-25: an
 *    overwrite lost every earlier hand-off). Item 506: the card's folded line
 *    shows this text, read-only, so all that is sent is visible (blocker 1659).
 *
 * 7. **Code chats** (backlog 431, 2026-10-27; blockers 1567, 1568): a
 *    chat is a code chat when it is unbound, or bound to a thread in a
 *    project whose folder holds a `HANDOFF.md` or a `backlog/` (the shell
 *    probes both and notes the answer, `noteCodeProject`). Its wrap-up runs
 *    practices §2's close: the STATE section, a commit by path, the backlog
 *    index, a push only where the project says so (`CODE_CLOSE`). A thread
 *    chat in a code project keeps the thread wrap-up and adds a short STATE
 *    section and the same close, so the project's next session sees what
 *    changed in its files; a thread chat in any other project is unchanged.
 * 8. **The mark** (backlog 436, blocker 1569): the hand-off is asked at the
 *    Settings percent of the window or at `DEFAULT_CAP_TOKENS` (300k, his
 *    practices §2 stop point), whichever comes first — 140k on a 200k
 *    window, 300k on a 1M one (`mark`). A chat's own percent is his explicit
 *    choice and is not capped.
 *
 * The stage machine is pure (`nextStage`, `autoQueues`, `isAway`,
 * `extractStartPrompt`) so it can be tested without a window: the running
 * app could not be driven the day it was built.
 */
import type { SessionEvent } from "./types";
import { dropQueued, enqueueMessage } from "./drafts.svelte";
import { windowFocused } from "./notify";
import { extractHandoff, HANDOFF_ASK } from "./handoffTag";

export type HandoffStage = "idle" | "due" | "wrapping" | "wrapped";

export const DEFAULT_THRESHOLD = 0.7;
/**
 * The token count past which the hand-off is asked whatever the percent
 * (backlog 436, blocker 1569): his own stop point in practices §2 ("Once it
 * passes ~300k", his call 2026-09-24). The 70% above was the orchestrator's
 * default for backlog 086 when every window was 200k; on a 1M window it
 * would ask at 700k, far past where he stops. 0 in Settings: no cap.
 */
export const DEFAULT_CAP_TOKENS = 300_000;
/** Past this a chat that chose *Stay here* is asked the wrap-up again. */
export const RE_ASK = 0.85;
/** No send and no keystroke for this long, and he counts as away (blocker 120). */
export const AWAY_MS = 60_000;
/** No keyboard or mouse input on the Mac for this long, and he counts as
 *  away even with the window in front on this chat (backlog 544, blocker
 *  1740): a Mac left overnight with Nightloom frontmost never lost focus,
 *  so nothing was ever queued or continued for it. */
export const IDLE_AWAY_MS = 10 * 60_000;
/** The info string of the fenced block the wrap-up asks for. */
export const START_PROMPT_TAG = "start-prompt";

/**
 * The close of a code chat's wrap-up (backlog 431): practices §2's wrap-up
 * and §5 — commit by path, refresh the backlog index, push only where the
 * project's own instructions say so. Each step is conditional, so a folder
 * with no git or no backlog/ skips it rather than failing.
 */
export const CODE_CLOSE =
  "If the project folder is a git repository, commit by path: name each file this chat changed, and " +
  "HANDOFF.md, in `git add` (never `git add -A` or `git add .`, never `git stash`), one commit per finished " +
  "piece of work, its message saying what landed, with no AI attribution line. If the project has a " +
  "backlog/ folder, refresh its index before that commit — the command the project's CLAUDE.md names, " +
  "else `python3 ~/.claude/practices/bin/backlogctl.py index` from the project folder when that file " +
  "exists — and commit the regenerated files by path too. Push only if the project's instructions say to push.";

/**
 * The default wrap-up, sent as a message of its own. The shape is his:
 * update the files, write the hand-off, and produce a brief start prompt
 * naming which files to read in which order. The `start-prompt` fence is
 * what Nightloom reads the new chat's first message out of.
 */
export const WRAP_UP =
  "This chat's context window is nearly full, so let's hand off to a new chat. Before anything else:\n" +
  "1. Finish or save whatever edit is half-done, so every file is in a coherent state.\n" +
  "2. Add a new section at the top of HANDOFF.md, the file at the top of the project folder (create the file " +
  "if there is none; never delete or rewrite the sections already in it), headed " +
  "`## STATE AS OF <date time> — <one line>`, for the chat that continues this one: what we were " +
  "doing, what is done, what is next, the decisions taken and why, and the files that matter — in " +
  "your own words, complete enough that a fresh session can carry on without this conversation — " +
  "ending with the queue of next steps in order as its last list. If ~/.claude/practices/bin/mdcheck.py " +
  "exists, run it in the project folder first and put each FLAG it prints at the top of that queue as " +
  "\"trim <file>\"; do not trim now.\n" +
  `3. ${CODE_CLOSE}\n` +
  // ~~"The new chat is already told to read the newest HANDOFF.md section, then backlog/INDEX.md,
  // then blockers/INDEX.md, so say only what that does not: …"~~ — item 520 (2026-11-09): the
  // prompt is sent alone, so it carries the read order itself.
  "4. End your reply with a short start prompt for the new chat. It is that chat's whole first message — " +
  "nothing is added above it — so open it with what to read, one file per command: the newest HANDOFF.md " +
  "section by its line range, then backlog/INDEX.md, then blockers/INDEX.md; then what changed since the " +
  "section was written, any other file to read, and " +
  // ~~"Put it in a fenced code block tagged `start-prompt` (a line of three
  // backticks followed by start-prompt, the prompt, then a line of three
  // backticks)."~~ — item 464 (2026-10-28): the tagged hand-off.
  `what to do first. ${HANDOFF_ASK}\n` +
  "Then stop; do not start the next step.";

/**
 * ~~The fixed prompt above the model's start prompt~~ — item 520
 * (2026-11-09): the box's text when the wrap-up reply wrote no prompt; with
 * a prompt the prompt goes alone. Was: the fixed prompt above it
 * (backlog 193): practices §5's session-start read order, blocker 366's
 * answer to question 11 (default A). Editable in Settings → Subscription,
 * and per chat on the hand-off card.
 */
export const READ_ORDER =
  "This chat continues an earlier one that handed off. Read these first, one file per command:\n" +
  "1. the newest `## STATE AS OF` section of HANDOFF.md, by its line range — not the whole file;\n" +
  "2. backlog/INDEX.md;\n" +
  "3. blockers/INDEX.md.\n" +
  "The queue is that section's last list.";

/**
 * The continued chat's first message, as its box opens with it: the read
 * order, then the model's start prompt, each only when there is one. Empty
 * when neither is. Nothing sends it.
 */
export function firstMessage(readOrderText: string, startPrompt: string | null): string {
  return [readOrderText.trim(), (startPrompt ?? "").trim()].filter((t) => t).join("\n\n");
}

/** ~~The first message of the continued chat, ready in its box.~~ Superseded
 *  2026-09-16 (pass 2): the box holds the model's own start prompt, or
 *  nothing. Kept for anything that still names it. */
export const CONTINUE_MESSAGE = "Read HANDOFF.md and continue.";

export interface HandoffState {
  /** The chat the state is about; a different open chat reads as idle. */
  chat: string | null;
  stage: HandoffStage;
  /** The fill at the last reading, 0..1, and the pair it came from. */
  fill: number;
  used: number;
  limit: number;
  /** The fill at which *Stay here* was chosen, 0 when it was not. */
  dismissedAt: number;
  /** The queue row holding the wrap-up Nightloom put there while he was away; 0 when none. */
  queuedId: number;
  /** The start prompt found in the wrap-up reply; null until then, or when none was found. */
  startPrompt: string | null;
  /** The continued chat whose box was left empty because the reply had no start prompt. */
  noStartPromptChat: string | null;
}

export const handoff = $state<HandoffState>({
  chat: null,
  stage: "idle",
  fill: 0,
  used: 0,
  limit: 0,
  dismissedAt: 0,
  queuedId: 0,
  startPrompt: null,
  noStartPromptChat: null,
});

/** The stage of every chat that is not the one `handoff` shows (backlog
 *  137): `handoff` is the projection of one chat, as the composer and the
 *  notice read it; a reading for another chat swaps the projection
 *  through here. The fill is not kept — the next reading brings it. */
const stages = new Map<string, Pick<HandoffState, "stage" | "dismissedAt" | "queuedId" | "startPrompt">>();

/**
 * What a reading does to the stage. `wrapping` (the wrap-up went as this
 * turn) becomes `wrapped`; `idle` becomes `due` when the fill is past
 * the threshold — and, after a *Stay here*, only past the re-ask mark and
 * higher than where it was dismissed, so the same fill does not nag.
 */
export function nextStage(
  stage: HandoffStage,
  fill: number,
  threshold: number,
  dismissedAt: number,
): HandoffStage {
  if (stage === "wrapping") return "wrapped";
  // Item 390 (his bug, 2026-10-18): a fill back under the mark — a rewind
  // took turns off — puts the notice away; it was kept up whatever the
  // fill did after.
  if ((stage === "due" || stage === "wrapped") && fill < threshold) return "idle";
  if (stage === "due" || stage === "wrapped") return stage;
  if (fill < threshold) return "idle";
  if (dismissedAt > 0 && (fill < RE_ASK || fill <= dismissedAt)) return "idle";
  return "due";
}

/**
 * Away: nothing sent and nothing typed in the composer for `AWAY_MS`, and
 * either the window is not in front or the chat is not the open one. Both
 * halves, so reading a long reply with the window in front is present,
 * and so is typing in a background window.
 */
export function isAway(
  now: number,
  lastActivity: number,
  focused: boolean,
  chatActive: boolean,
  /** How long the Mac has had no input, when known (544). */
  idleMs = 0,
): boolean {
  if (idleMs >= IDLE_AWAY_MS && now - lastActivity >= AWAY_MS) return true;
  return now - lastActivity >= AWAY_MS && (!focused || !chatActive);
}

/**
 * 544: whether a turn's end queues the wrap-up of a chat that is already
 * past its mark — `autoQueues` covers only the crossing itself, so a chat
 * he was watching at the crossing and then left never wrapped up. Only for
 * a chat that is running unattended (Nightloom sent its last message: a
 * limit resume, a continuation it asked for, a hand-off made while he was
 * away), only when he is away, never after a *Stay here*, never twice.
 * A notice he has seen in a chat he is driving still queues nothing.
 */
export function queuesAtTurnEnd(
  stage: HandoffStage,
  away: boolean,
  dismissedAt: number,
  queuedId: number,
  unattended: boolean,
): boolean {
  return stage === "due" && away && unattended && dismissedAt === 0 && queuedId === 0;
}

/**
 * Whether this reading puts the wrap-up in the queue: only the crossing
 * itself (idle → due), only when he is away, and never once a *Stay here*
 * has been chosen in this chat — the re-ask past 85% shows the notice and
 * nothing more (blocker 121's default). A notice he has seen never queues.
 */
export function autoQueues(before: HandoffStage, after: HandoffStage, away: boolean, dismissedAt: number): boolean {
  return before === "idle" && after === "due" && away && dismissedAt === 0;
}

/**
 * The last `<handoff>` block of the reply (item 464, `extractHandoff`), else
 * the last fenced block tagged `start-prompt` in the reply, trimmed; null
 * when there is none or it is blank. The tag may share the fence line
 * with other words (` ```md start-prompt `), and the closing fence may
 * follow the text without a newline.
 */
export function extractStartPrompt(reply: string): string | null {
  // Item 464: the tagged hand-off first; the fence below is read only for a
  // wrap-up sent before the change (or a chat's own edited wrap-up text).
  const tagged = extractHandoff(reply);
  if (tagged) return tagged;
  const re = /```[^\n`]*\bstart-prompt\b[^\n`]*\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (const m of reply.matchAll(re)) last = m[1];
  const text = last?.trim() ?? "";
  return text ? text : null;
}

/** The text of the last assistant message in the log, blocks joined. */
export function lastReplyText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    return e.blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter((t) => t)
      .join("\n");
  }
  return "";
}

// ---- activity, for the away rule ----

let lastActivity = 0;

/** A keystroke in the composer or a send: he is here. */
export function noteActivity(now = Date.now()): void {
  lastActivity = now;
}

/** The Mac's last idle reading (544): how long without input, and when
 *  it was read. Trusted for a minute; the shell reads it while turns run. */
let systemIdle: { ms: number; at: number } | null = null;

/** The backend's reading of the Mac's idle time, in seconds (null: unknown). */
export function noteSystemIdle(secs: number | null, now = Date.now()): void {
  systemIdle = secs === null || !Number.isFinite(secs) ? null : { ms: Math.max(0, secs * 1000), at: now };
}

/** Away right now, for the open chat (`chatActive` false when the reading is for another). */
export function awayNow(chatActive = true, now = Date.now()): boolean {
  const idle = systemIdle && now - systemIdle.at <= 60_000 ? systemIdle.ms : 0;
  return isAway(now, lastActivity, windowFocused(), chatActive, idle);
}

// ---- unattended chats (544) ----

const UNATTENDED_KEY = "nightloom.unattended";
function loadUnattended(): Record<string, true> {
  try {
    const v = JSON.parse(localStorage.getItem(UNATTENDED_KEY) ?? "{}") as unknown;
    const out: Record<string, true> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) out[k] = true;
    return out;
  } catch {
    return {};
  }
}
/** The chats running unattended: Nightloom sent their last message, not he. */
const unattended = $state<Record<string, true>>(loadUnattended());
function saveUnattended(): void {
  try {
    localStorage.setItem(UNATTENDED_KEY, JSON.stringify(unattended));
  } catch {
    // This launch only.
  }
}
/** Nightloom sent `chat` a message by itself: it runs unattended until he
 *  sends one there. */
export function markUnattended(chat: string | null): void {
  if (!chat || unattended[chat]) return;
  unattended[chat] = true;
  saveUnattended();
}
/** He sent a message in `chat`: he is driving it again. */
export function markAttended(chat: string | null): void {
  if (!chat || !unattended[chat]) return;
  delete unattended[chat];
  saveUnattended();
}
export function isUnattended(chat: string | null): boolean {
  return !!chat && unattended[chat] === true;
}

// ---- readings ----

/**
 * One reading of the fill for a chat — a usage event mid-turn, or the
 * turn's end — with whether he is away at that moment. Moves the stage
 * and, at a crossing with him away, puts the wrap-up in the chat's queue.
 * `events` is the log after the turn, given only at a turn's end: when the
 * wrap-up's own turn ends, the start prompt is read out of its reply. A
 * mid-turn reading never moves `wrapping` on — the wrap-up's reply is not
 * in yet, whatever the fill says.
 */
export function noteFill(
  chat: string | null,
  used: number | null,
  limit: number | null,
  away: boolean,
  events: SessionEvent[] | null = null,
  /** This reading is a turn's end (544); a log is given only at one. */
  atEnd: boolean = events !== null,
): void {
  if (handoff.chat !== chat) {
    // Another chat's reading: this one's stage goes under its id and the
    // other's comes back (backlog 137, review E's FE9 — a switch used to
    // reset the stage, so a chat wrapped up and left for a moment was
    // asked to wrap up again, and its found start prompt was gone).
    if (handoff.chat !== null) {
      stages.set(handoff.chat, {
        stage: handoff.stage,
        dismissedAt: handoff.dismissedAt,
        queuedId: handoff.queuedId,
        startPrompt: handoff.startPrompt,
      });
    }
    const back = chat === null ? undefined : stages.get(chat);
    handoff.chat = chat;
    handoff.stage = back?.stage ?? "idle";
    handoff.dismissedAt = back?.dismissedAt ?? 0;
    handoff.queuedId = back?.queuedId ?? 0;
    handoff.startPrompt = back?.startPrompt ?? null;
    handoff.noStartPromptChat = null;
  }
  handoff.used = used ?? 0;
  handoff.limit = limit ?? 0;
  const fill = used != null && limit ? Math.min(used / limit, 1) : 0;
  handoff.fill = fill;
  const before = handoff.stage;
  if (before === "wrapping" && !events) return;
  // Item 390: under the mark, a *Stay here* is forgotten, so the next
  // crossing asks afresh; a wrap-up queued for the crossing goes.
  const at = markDue(chat, limit);
  if (fill < at) {
    handoff.dismissedAt = 0;
    if (before === "due") dropAutoQueued();
  }
  const after = nextStage(before, fill, at, handoff.dismissedAt);
  handoff.stage = after;
  if (before === "wrapping" && after === "wrapped") {
    handoff.startPrompt = events ? extractStartPrompt(lastReplyText(events)) : null;
  }
  // 545: a chat whose mark is "never" is not wrapped up by Nightloom.
  if (!chat || neverHandsOff(chat)) return;
  const crossing = autoQueues(before, after, away, handoff.dismissedAt);
  if (
    crossing ||
    (atEnd && before === "due" && queuesAtTurnEnd(after, away, handoff.dismissedAt, handoff.queuedId, isUnattended(chat)))
  ) {
    const text = message(chat);
    if (text.trim()) {
      handoff.queuedId = enqueueMessage(chat, text, []).id;
      // What follows — the wrap-up, the next chat — runs without him (544).
      markUnattended(chat);
    }
  }
}

/** Item 390: after a rewind (or its undo or redo) the fill is read again —
 *  no turn ran, so nothing else would — never as away, so a redo past the
 *  mark does not queue the wrap-up. */
export function noteRewound(chat: string | null, used: number | null, limit: number | null): void {
  if (handoff.chat !== chat || handoff.stage === "wrapping") return;
  noteFill(chat, used, limit, false);
}

/** Called at the end of every agent turn with the gauge's pair and the log. */
export function noteAgentTurnEnd(
  chat: string | null,
  used: number | null,
  limit: number | null,
  events: SessionEvent[] | null = null,
  onScreen = true,
): void {
  // ~~`awayNow()`~~ — 544: the chat may not be the open one (a turn that
  // ended off screen), and this is always a turn's end.
  noteFill(chat, used, limit, awayNow(onScreen), events, true);
}

/** ~~The text a message goes out with: the wrap-up appended when it is due.~~
 *  Superseded 2026-09-16 (pass 2): the wrap-up is its own message and rides
 *  nothing. Returns the text unchanged; kept so an old call site cannot
 *  break. */
export function withWrapUp(_chat: string | null, text: string): string {
  return text;
}

/** The wrap-up is going as this message: `due` → `wrapping`, once. */
export function beginWrapUp(chat: string | null): void {
  if (handoff.chat !== chat || handoff.stage !== "due") return;
  handoff.stage = "wrapping";
  handoff.queuedId = 0;
}

/** The wrap-up's turn failed: back to the notice. The failed turn's end
 *  has already moved `wrapping` on to `wrapped`, so both read as the
 *  wrap-up not having happened. */
export function abortWrapUp(chat: string | null): void {
  if (handoff.chat !== chat) return;
  if (handoff.stage === "wrapping" || handoff.stage === "wrapped") {
    handoff.stage = "due";
    handoff.startPrompt = null;
  }
}

/** Take the wrap-up Nightloom queued back out of the queue, if it is still there. */
function dropAutoQueued(): void {
  if (handoff.chat && handoff.queuedId) dropQueued(handoff.chat, handoff.queuedId);
  handoff.queuedId = 0;
}

/**
 * The composer's queue (nightshift backlog 089) at a turn's end: why it
 * waits for *Send next* instead of sending the next held message itself,
 * or null when it may go. ~~Two reasons (the whole-project review of
 * 2026-09-16, F11, F12): the hand-off is due — a message sent now would
 * leave with the wrap-up under it, unasked~~ — superseded the same day by
 * pass 2: the wrap-up rides no message, so a notice on screen holds
 * nothing, and the wrap-up Nightloom queued while he was away goes through
 * this same queue. What holds: the turn that just ended was one he stopped
 * (F12 — a new turn on its heels leaves no moment to take the message
 * back), or the wrap-up's own turn just ended (`wrapped`) — the model has
 * written HANDOFF.md and stopped, and the next thing is the card's *Continue
 * with this prompt* (item 506), not more work in the full one. *Send next* is
 * the explicit choice either way, and any send in the chat ends the hold
 * (`sentHere`): with *Stay here* gone, sending here is how he stays.
 */
export function queueHold(stage: HandoffStage, stopped: boolean): "wrapped" | "stopped" | null {
  if (stage === "wrapped") return "wrapped";
  if (stopped) return "stopped";
  return null;
}

/** *Stay here*: back to idle, remembering the fill so only a higher one
 *  asks again; a wrap-up Nightloom queued is taken back. */
export function stayHere(): void {
  dropAutoQueued();
  handoff.dismissedAt = handoff.fill;
  handoff.stage = "idle";
}

/** Item 506: a message sent in a wrapped chat is *Stay here* — the wrapped
 *  card and its button are gone, so this is what releases the queue's hold
 *  and arms the re-ask, remembering the fill as the button did. */
export function sentHere(chat: string | null): void {
  if (handoff.chat === chat && handoff.stage === "wrapped") stayHere();
}

/** The *Hand off* button after a *Stay here* (backlog 383): the notice comes
 *  back before the re-ask mark. ~~"HANDOFF.md written" again if the wrap-up
 *  had already run~~ — item 506: that card is gone, and the chat has moved on
 *  from that wrap-up. Where it was dismissed stays, so a second *Stay here*
 *  is no different from the first. */
export function reopenHandoff(): void {
  handoff.stage = "due";
}

/** After the mark was raised on the notice: a fill now under it goes quiet
 *  without counting as a *Stay here*, so the new mark asks afresh. */
export function reconsider(chat: string | null): void {
  if (handoff.chat !== chat || handoff.stage !== "due") return;
  if (handoff.fill < markDue(chat, handoff.limit)) {
    dropAutoQueued();
    handoff.stage = "idle";
  }
}

/** After *Continue*: the new chat starts clean, and the chat that was
 *  wrapped up is forgotten here — its hand-off is done. */
export function resetHandoff(): void {
  // Item 506: the button can leave a chat with the wrap-up still queued.
  dropAutoQueued();
  if (handoff.chat !== null) stages.delete(handoff.chat);
  handoff.chat = null;
  handoff.stage = "idle";
  handoff.fill = 0;
  handoff.used = 0;
  handoff.limit = 0;
  handoff.dismissedAt = 0;
  handoff.queuedId = 0;
  handoff.startPrompt = null;
  handoff.noStartPromptChat = null;
}

/** Item 506: leaving `chat` by the card's button, whichever chat `handoff`
 *  shows; the card works from any stage, and for a chat it is not showing
 *  only the kept stage goes. */
export function leaveHandoff(chat: string | null): void {
  if (handoff.chat === null || handoff.chat === chat) return resetHandoff();
  const kept = chat === null ? undefined : stages.get(chat);
  if (chat && kept?.queuedId) dropQueued(chat, kept.queuedId);
  if (chat) stages.delete(chat);
}

// ---- the preferences: the threshold and the message, global and per chat ----

const KEY = "nightloom.handoff";

export interface Stored {
  /** The Settings threshold, 0..1. */
  default: number;
  /** A chat's own threshold, when it has one. */
  perChat: Record<string, number>;
  /** The Settings wrap-up message; null means the built-in `WRAP_UP`. */
  message: string | null;
  /** A chat's own wrap-up message, when it has one. */
  messages: Record<string, string>;
  /** The Settings read order (backlog 193); null means the built-in
   *  `READ_ORDER`. A blank is kept: no read order at all. */
  readOrder: string | null;
  /** A chat's own read order, blank included, when it has one. */
  readOrders: Record<string, string>;
  /** The token cap on the default mark (backlog 436); 0 means none. */
  cap: number;
  /** A research thread's own mark (backlog 545), by `threadKey`. */
  perThread: Record<string, number>;
  /** A project's own mark (545), by project id (`UNFILED` for none). */
  perProject: Record<string, number>;
}

/**
 * A mark of a chat's, a thread's or a project's own (backlog 545), one
 * number: a share of the window in (0, 1]; `NEVER` — Nightloom never asks
 * for, queues or sends the hand-off there; or a token count (above
 * `MIN_TOKENS`), turned into a share of the window it is read against.
 * Precedence: the chat's, else its thread's, else its project's, else the
 * Settings default with its token cap. A layer's own mark is his explicit
 * choice and is not capped (436's rule for the chat's).
 */
export const NEVER = 2;
export const MIN_TOKENS = 1000;
export const UNFILED = "unfiled";
export type MarkScope = "chat" | "thread" | "project";

export function isMark(v: unknown): v is number {
  return isRatio(v) || v === NEVER || (typeof v === "number" && Number.isFinite(v) && v >= MIN_TOKENS);
}

/** The key a thread's mark is kept under: threads are per project. */
export function threadKey(project: string | null, slug: string): string {
  return `${project ?? UNFILED}/${slug}`;
}

/**
 * What he typed for a mark: `never` / `off`; a percent (`60`, `60%`,
 * `0.6`); or tokens (`300k`, `250000`, `1.2m`). Blank clears the layer
 * (`null`); anything else is `undefined` — not a mark, nothing changes.
 */
export function parseMark(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replace(/,/g, "");
  if (!t) return null;
  if (t === "never" || t === "off" || t === "none") return NEVER;
  const m = /^(\d+(?:\.\d+)?)\s*(%|k|m|tokens?)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  if (unit === "k") return n * 1000 >= MIN_TOKENS ? Math.round(n * 1000) : undefined;
  if (unit === "m") return Math.round(n * 1_000_000);
  if (unit.startsWith("token")) return n >= MIN_TOKENS ? Math.round(n) : undefined;
  if (unit === "%") return n > 0 && n <= 100 ? n / 100 : undefined;
  if (n > 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return n / 100;
  return n >= MIN_TOKENS ? Math.round(n) : undefined;
}

/** A mark as the field shows it: `never`, `60%`, `300k`. */
export function markText(v: number): string {
  if (v === NEVER) return "never";
  if (v <= 1) return `${Math.round(v * 100)}%`;
  return v % 1000 === 0 ? `${v / 1000}k` : `${v} tokens`;
}

/** The share of a `limit`-token window a layer's mark stands for. */
export function markShare(v: number, limit: number | null): number {
  if (v === NEVER || v <= 1) return v;
  return limit && limit > 0 ? Math.min(1, v / limit) : 1;
}

/** The pure precedence: the first layer that has a mark. */
export function pickMark(
  chat: number | undefined,
  thread: number | undefined,
  project: number | undefined,
): { scope: MarkScope; value: number } | null {
  if (isMark(chat)) return { scope: "chat", value: chat };
  if (isMark(thread)) return { scope: "thread", value: thread };
  if (isMark(project)) return { scope: "project", value: project };
  return null;
}

function isRatio(v: unknown): v is number {
  return typeof v === "number" && v > 0 && v <= 1;
}

function readMap<T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (keep(x)) out[k] = x;
  }
  return out;
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** The stored preference read back; the defaults when absent or malformed. */
export function parseStored(raw: string | null): Stored {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      return {
        default: isRatio(p.default) ? p.default : DEFAULT_THRESHOLD,
        perChat: readMap(p.perChat, isMark),
        perThread: readMap(p.perThread, isMark),
        perProject: readMap(p.perProject, isMark),
        message: isText(p.message) ? p.message : null,
        messages: readMap(p.messages, isText),
        readOrder: isString(p.readOrder) ? p.readOrder : null,
        readOrders: readMap(p.readOrders, isString),
        cap: typeof p.cap === "number" && Number.isFinite(p.cap) && p.cap >= 0 ? p.cap : DEFAULT_CAP_TOKENS,
      };
    }
  } catch {
    // Unreadable storage: the defaults.
  }
  return {
    default: DEFAULT_THRESHOLD,
    perChat: {},
    perThread: {},
    perProject: {},
    message: null,
    messages: {},
    readOrder: null,
    readOrders: {},
    cap: DEFAULT_CAP_TOKENS,
  };
}

function load(): Stored {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    return parseStored(null);
  }
}

/** Reactive, so the notice, the Context page and Settings agree at once;
 *  written through to localStorage on each change, best-effort. */
const stored = $state<Stored>(load());

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage refused; the value holds for this launch only.
  }
}

// ---- research threads (nightshift backlog 271, step 1) ----
//
// A chat bound to a thread (`<project>/.agents/threads/<slug>/`, the
// session's `thread` event) wraps up into the thread's files instead of
// HANDOFF.md, and its continuation opens with the thread's read order.
// Order of choice, for the wrap-up and the read order alike: the chat's
// own text, else the thread's, else the Settings default (`pickText`).
// The binding is noted here by the shell (`noteThread`) from the chat's
// log; the upkeep flags (`noteThreadFlags`) from a dry-run upkeep.

/** The folder a thread's files live in, as the model types it. */
export function threadDir(slug: string): string {
  return `.agents/threads/${slug}`;
}

/**
 * The research wrap-up for a bound chat: step 0's TEMPLATE.md message
 * (Value-Generalization), plus the practices mirrors — a dated "As of"
 * line on Start here, condensing claim by claim, a start prompt with no
 * placeholders — and the upkeep flags Nightloom found, when there are any.
 */
export function threadWrapUp(slug: string, flags: readonly string[] = [], code = false): string {
  const dir = threadDir(slug);
  const lines = [
    `This chat's context is filling, so let's hand off to a new chat. This chat works from the thread ${dir}/. Before anything else:`,
    "1. Finish or save any half-done edit, so every file is coherent. Long outputs (literature scans, code, results) go under .agents/notes/ or another durable path in the project folder, never /tmp.",
    `2. Update ${dir}/thread.md by small edits, never a rewrite. Move each Queue item to its current status (live, parked, rejected with my reason quoted, conceded and by whom, done). Add new claims with an id, a provenance tag (user_stated, inferred, or external written as "source X claims Y" with its verification state) and a pointer (chat id + event index, plus a file path when there is one; find them with search_chats / read_chat if you do not know them). Strike superseded claims with today's date and the replacement's id beside them; never delete. In "## His view" add only my words, verbatim, at most about three sentences per quote, each with its chat-event pointer; your paraphrase of my view goes in "## The model's reading of his view". Add terms I coined to "## Vocabulary". Rewrite only "## Start here": at most 600 words, opening with a line "As of <date, time AM/PM> — <one line>", then the question, the front of the queue and what changed in this chat; condense it claim by claim, each claim keeping its pointer, and move detail down into Claims or Queue rather than deleting it.`,
    // Backlog 282: an aside's *Fold into thread* appends its summary to
    // log.md (the app writes it; thread.md keeps this chat as its one
    // writer), and this wrap-up is where it reaches thread.md.
    `3. Fold any log.md entries from asides since the last wrap-up into thread.md: the entries in ${dir}/log.md between "<!-- aside fold" and "<!-- /aside fold -->" lines, headed "— aside '<name>' from chat '<title>'", that come after this thread's last wrap-up paragraph. By the same small edits: their "His words" into "## His view" verbatim with their pointers, "Inferred" lines into Claims tagged inferred, "External" lines into Claims as written, "New queue rows" into the Queue with the next ids, open questions into the Queue. Leave the entries in log.md as they are.`,
    `4. Append one dated paragraph to ${dir}/log.md: this chat's id, what was asked, which ids changed in thread.md, which aside entries you folded in, where the long outputs are. Never edit earlier entries.`,
    // Backlog 431 (blocker 1568): in a code project the thread is the
    // chat's memory and HANDOFF.md stays the project's, so the chat adds a
    // short STATE section pointing at the thread and closes as a code chat.
    code
      ? `5. This project keeps a HANDOFF.md or a backlog/, so this chat's work lands there too. Add a short new section at the top of HANDOFF.md (create the file if there is none; never delete or rewrite the sections already in it), headed \`## STATE AS OF <date time AM/PM> — <one line>\`: what this chat changed in the project's files, that its reasoning is in ${dir}/, and the queue of next steps in order as its last list. Then: ${CODE_CLOSE} Commit the thread's files the same way.`
      : "5. Do not write HANDOFF.md for this chat.",
    // ~~"…ready to paste as is — no [brackets] or placeholders — in a fenced
    // code block tagged start-prompt…"~~ — item 464 (2026-10-28): the tagged
    // hand-off, which the thread's + opens the next chat with, alone.
    // ~~"With the read order Nightloom puts above it, it is all that chat's first message will say"~~ —
    // item 520 (2026-11-09): the prompt is sent alone, so it names the reads itself.
    `6. End your reply with a short prompt for the next chat in this thread. It is that chat's whole first message — nothing is added above it; the thread's Start here is already in its context — so open it with what to read, one file per command and by line range rather than whole (the ${dir}/thread.md Queue rows it needs, the newest ${dir}/log.md entry, any note), then what to do first. ${HANDOFF_ASK}`,
  ];
  if (flags.length > 0) {
    lines.push("Upkeep Nightloom found in the thread files (fix these in the same small edits):");
    for (const f of flags) lines.push(`- ${f}`);
  }
  lines.push("Then stop; do not start the next step.");
  return lines.join("\n");
}

/** The read order a bound chat's continuation opens with. */
export function threadReadOrder(slug: string, then: string = THEN_START_PROMPT): string {
  const dir = threadDir(slug);
  return (
    `This chat continues the research thread ${dir}/. Its "## Start here" is in your context as the thread layer (if it is not, read that section of ${dir}/thread.md first). Then read, one per command and by line range rather than whole:\n` +
    `1. the "## Queue" section of ${dir}/thread.md;\n` +
    `2. the newest entry of ${dir}/log.md.\n` +
    `Read the rest of thread.md, the notes it points at, and source chats (read_chat at the cited event) only when a task needs them. ${then}`
  );
}

/** The read order's last sentence after a wrap-up: a start prompt follows. */
export const THEN_START_PROMPT = "Then do what the start prompt below says.";
/** Its last sentence for *New chat in this thread* (backlog 288): no wrap-up
 *  ran, so there is no start prompt — he types what to do under it. */
export const THEN_HIS_ASK = "Then do what I ask below.";

/** The choice, pure: the chat's own text (blank included), else the
 *  thread's, else the default. */
export function pickText(own: string | undefined, thread: string | null, fallback: string): string {
  if (own !== undefined) return own;
  return thread ?? fallback;
}

/** Each chat's bound thread, as the shell last read it from the log. */
const threadOf = $state<Record<string, string>>({});
/** Each chat's code-project answer (backlog 431), as the shell last probed it. */
const codeOf = $state<Record<string, boolean>>({});

/** The files whose presence makes a project a code project (blocker 1567):
 *  HANDOFF.md, or a backlog/ — seen through its INDEX.md or order.json,
 *  as the probe answers for regular files only. */
export function codeProbePaths(root: string): string[] {
  const base = root.replace(/\/+$/, "");
  return [`${base}/HANDOFF.md`, `${base}/backlog/INDEX.md`, `${base}/backlog/order.json`];
}

/** Note whether the chat's project is a code project (null: unknown, as false). */
export function noteCodeProject(chat: string | null, code: boolean): void {
  if (!chat) return;
  if (code) codeOf[chat] = true;
  else delete codeOf[chat];
}

/** Whether the chat's project was found to be a code project. */
export function codeProjectFor(chat: string | null): boolean {
  return !!chat && codeOf[chat] === true;
}

/** Each thread's upkeep flags from the last dry run. */
const threadFlags = $state<Record<string, string[]>>({});

/** Note the chat's thread (null: none), read from its log by the shell. */
export function noteThread(chat: string | null, slug: string | null): void {
  if (!chat) return;
  if (slug) threadOf[chat] = slug;
  else delete threadOf[chat];
}

/** The chat's thread, as noted; null when none. */
export function threadFor(chat: string | null): string | null {
  return (chat && threadOf[chat]) || null;
}

/** Note a thread's upkeep flags, for its wrap-up. */
export function noteThreadFlags(slug: string, flags: string[]): void {
  threadFlags[slug] = flags;
}

/** The wrap-up a chat starts from before its own edit: the thread's, else Settings'. */
function baseMessage(chat: string | null): string {
  return pickText(undefined, threadMessage(chat), defaultMessage());
}

/** The chat's thread's research wrap-up, flags included; null when unbound. */
function threadMessage(chat: string | null): string | null {
  const t = threadFor(chat);
  return t ? threadWrapUp(t, threadFlags[t] ?? [], codeProjectFor(chat)) : null;
}

/** The read order a chat starts from before its own edit. */
function baseReadOrder(chat: string | null): string {
  const t = threadFor(chat);
  return pickText(undefined, t ? threadReadOrder(t) : null, defaultReadOrder());
}

/** The chat's threshold, 0..1: its own if set, else the default. */
export function threshold(chat: string | null): number {
  if (chat && isRatio(stored.perChat[chat])) return stored.perChat[chat];
  return stored.default;
}

/** `reconsider` for any layer's change (545): the chat `handoff` shows goes
 *  quiet when its fill is now under its mark, and a wrap-up queued for it
 *  is taken back. */
export function reconsiderShown(): void {
  reconsider(handoff.chat);
}

/**
 * The fill at which the chat's hand-off is asked, 0..1 (backlog 436): its
 * own percent when it has one — his explicit choice, uncapped — else the
 * Settings percent or the token cap over the window, whichever is lower.
 * With no window known the percent alone.
 */
export function mark(chat: string | null, limit: number | null): number {
  // 545: what a gauge draws — a "never" sits at the end of the window
  // (the rail and the top bar's dial place a line at this share).
  return Math.min(1, markDue(chat, limit));
}

/** The fill past which the hand-off is due (545): as `mark`, but `NEVER`
 *  (2) for a chat that is never handed off — past any fill. */
export function markDue(chat: string | null, limit: number | null): number {
  // ~~`hasOwnThreshold(chat)`~~ — 545: the chat's, its thread's or its
  // project's own mark, in that order.
  const own = ownMark(chat);
  if (own) return markShare(own.value, limit);
  return cappedMark(stored.default, cap(), limit);
}

/** Where each chat lives, told by the shell (545): its project's id, null
 *  for an unfiled chat. A chat never told reads no project layer. */
const projectOf = $state<Record<string, string | null>>({});
export function noteChatProject(chat: string | null, project: string | null): void {
  if (chat && projectOf[chat] !== project) projectOf[chat] = project;
}
export function projectFor(chat: string | null): string | null | undefined {
  return chat && chat in projectOf ? projectOf[chat] : undefined;
}

/** The layer whose mark `chat` hands off at (545), or null: the Settings default. */
export function ownMark(chat: string | null): { scope: MarkScope; value: number } | null {
  if (!chat) return null;
  const project = projectFor(chat);
  const slug = threadFor(chat);
  return pickMark(
    stored.perChat[chat],
    slug && project !== undefined ? stored.perThread[threadKey(project, slug)] : undefined,
    project !== undefined ? stored.perProject[project ?? UNFILED] : undefined,
  );
}

/** Whether Nightloom never hands this chat off by itself (545). */
export function neverHandsOff(chat: string | null): boolean {
  return ownMark(chat)?.value === NEVER;
}

/** One layer's own mark, or null. `key`: the chat id, `threadKey`, or the
 *  project id (`UNFILED`). */
export function markAt(scope: MarkScope, key: string): number | null {
  const v = (scope === "chat" ? stored.perChat : scope === "thread" ? stored.perThread : stored.perProject)[key];
  return isMark(v) ? v : null;
}

/** Set one layer's own mark; `null` clears it. Anything not a mark is ignored. */
export function setMarkAt(scope: MarkScope, key: string, value: number | null): void {
  const map = scope === "chat" ? stored.perChat : scope === "thread" ? stored.perThread : stored.perProject;
  if (value === null) delete map[key];
  else if (isMark(value)) map[key] = value;
  else return;
  save();
}

/** The pure rule: the percent, or `capTokens` over `limit` when lower. */
export function cappedMark(ratio: number, capTokens: number, limit: number | null): number {
  if (!limit || limit <= 0 || capTokens <= 0) return ratio;
  return Math.min(ratio, capTokens / limit);
}

/** The Settings token cap; 0 means none. */
export function cap(): number {
  return stored.cap;
}

/** Set the Settings token cap; a negative or non-number is ignored, 0 turns it off. */
export function setCap(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens < 0) return;
  stored.cap = Math.round(tokens);
  save();
}

/** Whether the chat has a threshold of its own. */
export function hasOwnThreshold(chat: string | null): boolean {
  return !!chat && isRatio(stored.perChat[chat]);
}

/** Set the threshold for one chat, or (chat null) the default for every
 *  chat without its own. A ratio outside (0, 1] clears the chat's own. */
export function setThreshold(chat: string | null, ratio: number): void {
  if (chat) {
    if (isRatio(ratio)) stored.perChat[chat] = ratio;
    else delete stored.perChat[chat];
  } else if (isRatio(ratio)) {
    stored.default = ratio;
  }
  save();
}

/** The Settings wrap-up: his own text, else the built-in. */
export function defaultMessage(): string {
  return stored.message ?? WRAP_UP;
}

/** Whether Settings holds a wrap-up of his own. */
export function hasOwnDefaultMessage(): boolean {
  return stored.message !== null;
}

/** Set the Settings wrap-up; the built-in text (or Reset to default) clears
 *  it. A blank is kept for this launch so the box can be emptied and
 *  retyped — nothing sends a blank — and reads back as the built-in. */
export function setDefaultMessage(text: string): void {
  stored.message = text === WRAP_UP ? null : text;
  save();
}

/** The wrap-up this chat sends: its own if edited, else its thread's
 *  research wrap-up (backlog 271), else the Settings default. */
export function message(chat: string | null): string {
  return pickText(chat ? stored.messages[chat] : undefined, threadMessage(chat), defaultMessage());
}

/** Whether the chat has a wrap-up of its own. */
export function hasOwnMessage(chat: string | null): boolean {
  return !!chat && chat in stored.messages;
}

/** Set the wrap-up for one chat; the default's own text (or Reset) clears
 *  it. A blank is kept for this launch, as in Settings. */
export function setMessage(chat: string | null, text: string): void {
  if (!chat) return;
  if (text !== baseMessage(chat)) stored.messages[chat] = text;
  else delete stored.messages[chat];
  save();
}

/** The notice's *Reset the message*: the chat's own wrap-up dropped, so it
 *  reads the Settings default again. (Found 2026-09-25, backlog 193: the
 *  button called `setMessage(chat, "")`, which kept a blank for the launch —
 *  an empty box and a disabled *Wrap up now* — rather than resetting.) */
export function clearMessage(chat: string | null): void {
  if (!chat) return;
  delete stored.messages[chat];
  save();
}

// ---- the read order above the model's start prompt (backlog 193) ----

/** The Settings read order: his own text (blank included), else the built-in. */
export function defaultReadOrder(): string {
  return stored.readOrder ?? READ_ORDER;
}

/** Whether Settings holds a read order of his own. */
export function hasOwnDefaultReadOrder(): boolean {
  return stored.readOrder !== null;
}

/** Set the Settings read order; the built-in text clears it. A blank is
 *  kept, across launches too: a project without HANDOFF.md may want none. */
export function setDefaultReadOrder(text: string): void {
  stored.readOrder = text === READ_ORDER ? null : text;
  save();
}

/** Settings' *Reset to default*: back to the built-in. */
export function clearDefaultReadOrder(): void {
  stored.readOrder = null;
  save();
}

/** The read order this chat's continuation opens with: its own if edited,
 *  else its thread's (backlog 271), else the Settings default. */
export function readOrder(chat: string | null): string {
  return pickText(chat ? stored.readOrders[chat] : undefined, null, baseReadOrder(chat));
}

/** Whether the chat has a read order of its own. */
export function hasOwnReadOrder(chat: string | null): boolean {
  return !!chat && chat in stored.readOrders;
}

/** Set the read order for one chat; the default's own text clears it. A
 *  blank is kept: this chat's continuation opens with the start prompt only. */
export function setReadOrder(chat: string | null, text: string): void {
  if (!chat) return;
  if (text !== baseReadOrder(chat)) stored.readOrders[chat] = text;
  else delete stored.readOrders[chat];
  save();
}

/** The hand-off card's *Reset*: the chat reads the Settings default again. */
export function clearReadOrder(chat: string | null): void {
  if (!chat) return;
  delete stored.readOrders[chat];
  save();
}

/** At *Continue*: a read order of the chat's own goes on to the chat that
 *  continues it, so the next hand-off in the line opens the same way. */
export function carryReadOrder(from: string | null, to: string): void {
  if (!from || !(from in stored.readOrders)) return;
  stored.readOrders[to] = stored.readOrders[from];
  save();
}
