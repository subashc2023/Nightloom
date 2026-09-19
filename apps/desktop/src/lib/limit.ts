/**
 * A turn paused by the plan's usage limit (nightshift backlog 164, pass 1,
 * 2026-09-18). Six subagent scans were running when the five-hour window
 * ran out: the CLI answered every request with a synthetic message
 * ("You've hit your session limit · resets 11:50pm"), the turn ended with
 * `stop_reason: error`, and on "continue" the parent relaunched the child
 * that had died and paid its whole search again. So: the backend reads
 * the limit off the stream (`agent::LimitHit` — the reset time, the
 * window, the sentence, the spawning calls of the children that died) and
 * the transcript marks the turn *paused by the usage limit · resumes at
 * HH:MM* with one Resume. Resume before the reset schedules the continue
 * for the reset (never into a window that is still exhausted — a 429
 * loop); after it, the continue goes at once. What it sends names the
 * children that died, so the parent continues them rather than starting
 * over (the engine note carries the same rule).
 *
 * Pure over its inputs, so the suite pins the message and the timing.
 */
import type { AgentTurnResult } from "./types";

export interface LimitPause {
  /** The chat the turn ran in; null for the pending chat. */
  session: string | null;
  /** When the window opens again, ms since the epoch; null when the CLI
   *  did not say. */
  resetsAtMs: number | null;
  /** `five_hour`, `seven_day`, when known. */
  window: string | null;
  /** The CLI's own sentence. */
  text: string;
  /** The `tool_use_id`s of the subagents that died on it. */
  subagents: string[];
  /** When the turn ended. */
  hitAtMs: number;
}

/** Margin after the reset before a scheduled resume goes: the clocks
 *  are two, and a resume one second early is the loop this guards. */
export const RESUME_MARGIN_MS = 30_000;

/** The pause a turn's result describes, or null when it ended otherwise. */
export function limitPauseFrom(
  res: Pick<AgentTurnResult, "limit">,
  session: string | null,
  nowMs: number = Date.now(),
): LimitPause | null {
  const l = res.limit;
  if (!l) return null;
  return {
    session,
    resetsAtMs: l.resets_at == null ? null : l.resets_at * 1000,
    window: l.window ?? null,
    text: l.text,
    subagents: l.subagents ?? [],
    hitAtMs: nowMs,
  };
}

/** `HH:MM` in the local zone, or "later" when the CLI gave no time. */
export function resetLabel(p: Pick<LimitPause, "resetsAtMs">, nowMs: number = Date.now()): string {
  if (p.resetsAtMs == null) return "later";
  const d = new Date(p.resetsAtMs);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(nowMs).toDateString()
    ? hm
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

/** How long a resume asked for now must wait: zero once the window has
 *  reset (plus the margin), the whole wait before. No reset known: zero —
 *  his click is the consent, and the CLI will say again if it is early. */
export function resumeDelayMs(p: Pick<LimitPause, "resetsAtMs">, nowMs: number = Date.now()): number {
  if (p.resetsAtMs == null) return 0;
  return Math.max(0, p.resetsAtMs + RESUME_MARGIN_MS - nowMs);
}

/** The line the transcript's card shows. */
export function pauseLabel(p: Pick<LimitPause, "resetsAtMs" | "window">, nowMs: number = Date.now()): string {
  const which = p.window === "seven_day" ? "weekly" : p.window === "five_hour" ? "5-hour" : "usage";
  const when = resetLabel(p, nowMs);
  return resumeDelayMs(p, nowMs) === 0 && p.resetsAtMs != null
    ? `paused by the ${which} limit · the window has reset`
    : `paused by the ${which} limit · resumes at ${when}`;
}

/**
 * What Resume sends: the model is told the turn was cut by the limit and
 * the window has opened, and which subagents died — by their spawning
 * call ids, which the transcript's `<subagent parent="…">` blocks carry —
 * with the rule: continue them, do not relaunch.
 */
export function resumeMessage(p: Pick<LimitPause, "subagents" | "text">): string {
  const head =
    "The last turn was paused by the plan's usage limit and the window has now reset. Continue exactly where it stopped; everything before the limit stands.";
  if (p.subagents.length === 0) return head;
  const ids = p.subagents.map((id) => `\`${id}\``).join(", ");
  return (
    `${head} ${p.subagents.length === 1 ? "One subagent" : `${p.subagents.length} subagents`} died on the limit ` +
    `(spawned by ${ids}): resume ${p.subagents.length === 1 ? "it" : "each"} with SendMessage by id or name rather than launching a new one; ` +
    "if that fails, read its transcript (this session's subagents folder under ~/.claude/projects, agent-<id>.jsonl, the .meta.json beside it names the spawning call) and take up from its last result instead of repeating the search."
  );
}
