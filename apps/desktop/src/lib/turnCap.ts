/**
 * The cap chip above the message box (nightshift item 538, part 2; his
 * answer to blocker 1784: "that's perfect. as long as it looks visually
 * great too"). A message can work under a usage cap — a percent of the
 * plan's 5-hour window — that the model declares with `set_budget`, that
 * his message states ("use up to 50%", the backstop), or that he sets
 * here. The chip shows it while the message runs; a click opens a small
 * popover to change the percent, flip the mode or remove the cap, through
 * the `set_turn_cap` command. Absent a cap, no chip (nothing moves).
 *
 * This file is the arithmetic and the call; `TurnCapChip.svelte` draws it.
 */
import { setTurnCap } from "./api";
import { addToast, app } from "./state.svelte";
import type { CapMode, TurnBudget } from "./types";

/** The backend's `budget::WAKE_MARGIN`: the model is woken this many points
 *  below the cap, so the chip turns "near" there too. */
export const NEAR_MARGIN = 5;

/** The popover's − / + step, in points. */
export const CAP_STEP = 5;

export type CapPhase = "set" | "near" | "at";

export interface CapView {
  phase: CapPhase;
  percent: number;
  mode: CapMode;
  /** The mode in a few words, for the chip. */
  modeShort: string;
  /** The mode in full, for the popover and the tip. */
  modeLong: string;
  source: "model" | "message" | "user";
  /** Who set it, in his terms: Claude, his message, or him. */
  sourceWords: string;
  /** He corrected it this message: Claude's later calls change nothing. */
  locked: boolean;
  /** The latest 5-hour reading, when one is on hand. */
  latest: number | null;
  /** Points this message has spent (latest − start), when both are known. */
  spent: number | null;
  /** Points the cap allowed from the message's start (cap − start). */
  allowance: number | null;
  /** How far through its allowance the message is, 0..1. */
  fill: number;
  reason: string;
  /** The chip's tip: everything above, in sentences. */
  tip: string;
}

const MODE_SHORT: Record<CapMode, string> = {
  finish_within: "finish within",
  work_to_cap_then_continue: "then continue",
};

const MODE_LONG: Record<CapMode, string> = {
  finish_within: "Finish within the cap — the work is trimmed to fit",
  work_to_cap_then_continue: "Work to the cap, then continue after the reset",
};

/** The other mode: what one click on the mode switch sets. */
export function otherMode(mode: CapMode): CapMode {
  return mode === "finish_within" ? "work_to_cap_then_continue" : "finish_within";
}

/** The mode in full words (the popover's switch). */
export function modeLong(mode: CapMode): string {
  return MODE_LONG[mode];
}

function sourceWords(source: string, locked: boolean): string {
  if (source === "user" || locked) return "you set it";
  if (source === "message") return "from your message";
  return "set by Claude";
}

/** What the chip shows for this ledger, or null for no chip (no cap). */
export function capView(b: TurnBudget | null | undefined): CapView | null {
  const cap = b?.cap;
  if (!b || !cap) return null;
  const latest = b.latest_pct ?? null;
  const start = b.start_pct ?? null;
  const spent = latest !== null && start !== null ? Math.max(0, latest - start) : null;
  const allowance = start !== null ? Math.max(0, cap.percent - start) : null;
  const fill =
    spent !== null && allowance !== null
      ? allowance === 0
        ? 1
        : Math.min(1, spent / allowance)
      : latest !== null
        ? Math.min(1, latest / cap.percent)
        : 0;
  const phase: CapPhase = latest === null ? "set" : latest >= cap.percent ? "at" : latest >= cap.percent - NEAR_MARGIN ? "near" : "set";
  const locked = !!b.cap_locked;
  const who = sourceWords(cap.source, locked);
  const where =
    latest === null
      ? "No usage reading yet."
      : spent !== null && allowance !== null
        ? `The 5-hour window is at ${latest}%: this message has spent ${spent} of the ${allowance} points it had.`
        : `The 5-hour window is at ${latest}%.`;
  const lead =
    phase === "at"
      ? "Reached: Claude is wrapping up. "
      : phase === "near"
        ? "Near the cap: Claude has been woken to wrap up. "
        : "";
  const why = cap.source === "model" && cap.reason ? ` Claude's reason: ${cap.reason}.` : "";
  const lockNote = locked ? " You corrected it, so Claude's own calls no longer change it." : "";
  return {
    phase,
    percent: cap.percent,
    mode: cap.mode,
    modeShort: MODE_SHORT[cap.mode],
    modeLong: MODE_LONG[cap.mode],
    source: cap.source,
    sourceWords: who,
    locked,
    latest,
    spent,
    allowance,
    fill,
    reason: cap.reason,
    tip: `${lead}This message's cap: ${cap.percent}% of the 5-hour window, ${MODE_LONG[cap.mode].toLowerCase()} (${who}). ${where}${why}${lockNote} Click to change it.`,
  };
}

/** Whether the chip has a ledger to show: the chat on screen is the one
 *  whose turn runs (not parked), on the Claude Code engine. */
export function capChipChat(): string | null {
  if (app.connection?.engine !== "claude-code") return null;
  if (!app.busy || app.parked) return null;
  const s = app.activeSessionId;
  return s && app.budgetSession === s ? s : null;
}

/** A percent the popover may send: whole, 1–100. */
export function clampCap(p: number): number {
  if (!Number.isFinite(p)) return 1;
  return Math.min(100, Math.max(1, Math.round(p)));
}

/**
 * His correction, through `set_turn_cap`: a new percent (mode kept), a
 * new mode (percent kept), or both null — no cap for this message. The
 * ledger it returns is the meter's from here. An error is a toast; it
 * returns whether it took.
 */
export async function correctCap(session: string, percent: number | null, mode: CapMode | null): Promise<boolean> {
  try {
    const b = await setTurnCap(session, percent === null ? null : clampCap(percent), mode);
    if (app.budgetSession === session || app.activeSessionId === session) app.turnBudget = b;
    return true;
  } catch (e) {
    addToast(`The cap was not changed: ${String(e)}`);
    return false;
  }
}

export { wakeNotice } from "./capWake";
