/**
 * The context-full hand-off on the Claude Code engine (nightshift backlog
 * 086, 2026-09-16; blocker 073's row A8, and blocker 092's default: ask).
 *
 * He does not compact — a compaction boundary in 2 of 610 sessions — and
 * the nightshift contract's answer to a full window is a hand-off written
 * to disk. So the CLI's auto-compact is off on every path (the Rust side,
 * `AgentSpec::auto_compact`), and this is what happens instead:
 *
 * 1. At the end of each agent turn the window's fill — the last reply's
 *    `input + output` over the CLI's context window, the gauge's own pair
 *    — is compared to the chat's threshold (70% by default, per chat).
 *    Crossing it once arms the hand-off: the composer says so.
 * 2. His next message carries the wrap-up under a dashed rule: write
 *    `HANDOFF.md` in the project — doing, done, next, the files that
 *    matter — then stop. The same shape as the nightshift run's own
 *    HANDOFF.md, and in the model's words, never Nightloom's. Visible in
 *    the transcript as part of his message.
 * 3. When that turn ends the composer offers *Continue in a new chat ·
 *    Stay here*. Continue opens a fresh chat in the same folder, linked to
 *    this one (`forked_from` with `reason: "handoff"`), with "Read
 *    HANDOFF.md and continue" ready in its box. Staying past 85% asks the
 *    wrap-up again.
 *
 * The stage machine is a pure function (`nextStage`) so it can be tested
 * without a window: the running app could not be driven tonight.
 */

export type HandoffStage = "idle" | "due" | "wrapping" | "wrapped";

export const DEFAULT_THRESHOLD = 0.7;
/** Past this a chat that chose *Stay here* is asked the wrap-up again. */
export const RE_ASK = 0.85;

/** The wrap-up appended to his message, under a rule so the transcript
 *  shows where his words end and the app's begin. */
export const WRAP_UP =
  "---\n" +
  "[Added by Nightloom: this chat's context window is nearly full.] " +
  "Before anything else, write a file named HANDOFF.md at the top of the project folder " +
  "(overwrite it if one exists) for the chat that continues this one: what we were doing, " +
  "what is done, what is next, the decisions taken and why, and the files that matter — " +
  "in your own words, complete enough that a fresh session can carry on without this " +
  "conversation. Then stop; do not start the next step.";

/** The first message of the continued chat, ready in its box. */
export const CONTINUE_MESSAGE = "Read HANDOFF.md and continue.";

export interface HandoffState {
  /** The chat the state is about; a different open chat reads as idle. */
  chat: string | null;
  stage: HandoffStage;
  /** The fill at the last turn's end, 0..1. */
  fill: number;
  /** The fill at which *Stay here* was chosen, 0 when it was not. */
  dismissedAt: number;
}

export const handoff = $state<HandoffState>({ chat: null, stage: "idle", fill: 0, dismissedAt: 0 });

/**
 * What a turn's end does to the stage. `wrapping` (the wrap-up went with
 * this turn) becomes `wrapped`; `idle` becomes `due` when the fill is past
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

/** Called at the end of every agent turn with the gauge's pair. */
export function noteAgentTurnEnd(chat: string | null, used: number | null, limit: number | null): void {
  if (handoff.chat !== chat) {
    handoff.chat = chat;
    handoff.stage = "idle";
    handoff.dismissedAt = 0;
  }
  const fill = used != null && limit ? Math.min(used / limit, 1) : 0;
  handoff.fill = fill;
  handoff.stage = nextStage(handoff.stage, fill, threshold(chat), handoff.dismissedAt);
}

/** The text a message goes out with: the wrap-up appended when it is due. */
export function withWrapUp(chat: string | null, text: string): string {
  if (handoff.chat !== chat || handoff.stage !== "due") return text;
  handoff.stage = "wrapping";
  const body = text.trim();
  return body ? `${body}\n\n${WRAP_UP}` : WRAP_UP;
}

/** *Stay here*: back to idle, remembering the fill so only a higher one asks again. */
export function stayHere(): void {
  handoff.dismissedAt = handoff.fill;
  handoff.stage = "idle";
}

/** After *Continue*: the new chat starts clean. */
export function resetHandoff(): void {
  handoff.chat = null;
  handoff.stage = "idle";
  handoff.fill = 0;
  handoff.dismissedAt = 0;
}

// ---- the threshold, per chat, in localStorage ----

const KEY = "nightloom.handoff";

interface Stored {
  default: number;
  perChat: Record<string, number>;
}

function load(storage: Pick<Storage, "getItem"> = localStorage): Stored {
  try {
    const raw = storage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>;
      return {
        default: isRatio(p.default) ? p.default : DEFAULT_THRESHOLD,
        perChat: p.perChat && typeof p.perChat === "object" ? p.perChat : {},
      };
    }
  } catch {
    // Unreadable storage: the defaults.
  }
  return { default: DEFAULT_THRESHOLD, perChat: {} };
}

function isRatio(v: unknown): v is number {
  return typeof v === "number" && v > 0 && v <= 1;
}

/** The chat's threshold, 0..1: its own if set, else the default. */
export function threshold(chat: string | null): number {
  const s = load();
  if (chat && isRatio(s.perChat[chat])) return s.perChat[chat];
  return s.default;
}

/** Set the threshold for one chat, or (chat null) the default for every
 *  chat without its own. A ratio outside (0, 1] clears the chat's own. */
export function setThreshold(chat: string | null, ratio: number): void {
  const s = load();
  if (chat) {
    if (isRatio(ratio)) s.perChat[chat] = ratio;
    else delete s.perChat[chat];
  } else if (isRatio(ratio)) {
    s.default = ratio;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage refused; the value holds for this launch only.
  }
}
