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
 *    wrap-up again.
 *
 * The stage machine is pure (`nextStage`, `autoQueues`, `isAway`,
 * `extractStartPrompt`) so it can be tested without a window: the running
 * app could not be driven the day it was built.
 */
import type { SessionEvent } from "./types";
import { dropQueued, enqueueMessage } from "./drafts.svelte";
import { windowFocused } from "./notify";

export type HandoffStage = "idle" | "due" | "wrapping" | "wrapped";

export const DEFAULT_THRESHOLD = 0.7;
/** Past this a chat that chose *Stay here* is asked the wrap-up again. */
export const RE_ASK = 0.85;
/** No send and no keystroke for this long, and he counts as away (blocker 120). */
export const AWAY_MS = 60_000;
/** The info string of the fenced block the wrap-up asks for. */
export const START_PROMPT_TAG = "start-prompt";

/**
 * The default wrap-up, sent as a message of its own. The shape is his:
 * update the files, write the hand-off, and produce a brief start prompt
 * naming which files to read in which order. The `start-prompt` fence is
 * what Nightloom reads the new chat's first message out of.
 */
export const WRAP_UP =
  "This chat's context window is nearly full, so let's hand off to a new chat. Before anything else:\n" +
  "1. Finish or save whatever edit is half-done, so every file is in a coherent state.\n" +
  "2. Write a file named HANDOFF.md at the top of the project folder (overwrite it if one exists) " +
  "for the chat that continues this one: what we were doing, what is done, what is next, " +
  "the decisions taken and why, and the files that matter — in your own words, complete enough " +
  "that a fresh session can carry on without this conversation.\n" +
  "3. End your reply with a short start prompt for the new chat — which files to read, in which " +
  "order, and what to do first — in a fenced code block tagged `start-prompt` " +
  "(a line of three backticks followed by start-prompt, the prompt, then a line of three backticks).\n" +
  "Then stop; do not start the next step.";

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
export function isAway(now: number, lastActivity: number, focused: boolean, chatActive: boolean): boolean {
  return now - lastActivity >= AWAY_MS && (!focused || !chatActive);
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
 * The last fenced block tagged `start-prompt` in the reply, trimmed; null
 * when there is none or it is blank. The tag may share the fence line
 * with other words (` ```md start-prompt `), and the closing fence may
 * follow the text without a newline.
 */
export function extractStartPrompt(reply: string): string | null {
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

/** Away right now, for the open chat (`chatActive` false when the reading is for another). */
export function awayNow(chatActive = true, now = Date.now()): boolean {
  return isAway(now, lastActivity, windowFocused(), chatActive);
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
  const after = nextStage(before, fill, threshold(chat), handoff.dismissedAt);
  handoff.stage = after;
  if (before === "wrapping" && after === "wrapped") {
    handoff.startPrompt = events ? extractStartPrompt(lastReplyText(events)) : null;
  }
  if (chat && autoQueues(before, after, away, handoff.dismissedAt)) {
    const text = message(chat);
    if (text.trim()) handoff.queuedId = enqueueMessage(chat, text, []).id;
  }
}

/** Called at the end of every agent turn with the gauge's pair and the log. */
export function noteAgentTurnEnd(
  chat: string | null,
  used: number | null,
  limit: number | null,
  events: SessionEvent[] | null = null,
): void {
  noteFill(chat, used, limit, awayNow(), events);
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
 * written HANDOFF.md and stopped, and the next thing is *Continue in a new
 * chat*, not more work in the full one. *Send next* is the explicit choice
 * either way.
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

/** After the mark was raised on the notice: a fill now under it goes quiet
 *  without counting as a *Stay here*, so the new mark asks afresh. */
export function reconsider(chat: string | null): void {
  if (handoff.chat !== chat || handoff.stage !== "due") return;
  if (handoff.fill < threshold(chat)) {
    dropAutoQueued();
    handoff.stage = "idle";
  }
}

/** After *Continue*: the new chat starts clean, and the chat that was
 *  wrapped up is forgotten here — its hand-off is done. */
export function resetHandoff(): void {
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

/** The stored preference read back; the defaults when absent or malformed. */
export function parseStored(raw: string | null): Stored {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      return {
        default: isRatio(p.default) ? p.default : DEFAULT_THRESHOLD,
        perChat: readMap(p.perChat, isRatio),
        message: isText(p.message) ? p.message : null,
        messages: readMap(p.messages, isText),
      };
    }
  } catch {
    // Unreadable storage: the defaults.
  }
  return { default: DEFAULT_THRESHOLD, perChat: {}, message: null, messages: {} };
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

/** The chat's threshold, 0..1: its own if set, else the default. */
export function threshold(chat: string | null): number {
  if (chat && isRatio(stored.perChat[chat])) return stored.perChat[chat];
  return stored.default;
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

/** The wrap-up this chat sends: its own if edited, else the Settings default. */
export function message(chat: string | null): string {
  if (chat && chat in stored.messages) return stored.messages[chat];
  return defaultMessage();
}

/** Whether the chat has a wrap-up of its own. */
export function hasOwnMessage(chat: string | null): boolean {
  return !!chat && chat in stored.messages;
}

/** Set the wrap-up for one chat; the default's own text (or Reset) clears
 *  it. A blank is kept for this launch, as in Settings. */
export function setMessage(chat: string | null, text: string): void {
  if (!chat) return;
  if (text !== defaultMessage()) stored.messages[chat] = text;
  else delete stored.messages[chat];
  save();
}
