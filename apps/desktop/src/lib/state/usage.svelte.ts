// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { inOtherProject } from "../browse";
import type { AgentTurnResult, PlanUsage } from "../types";
import { app, notePresence, bgTurns, addToast } from "../state.svelte";

/**
 * Re-read the plan's percentages (nightshift backlog 073). Two small file
 * reads on the backend; called on connect to the Claude Code engine and at
 * the end of every agent turn, which is as often as the figure can have
 * moved on Nightloom's account of it.
 */
export async function refreshPlanUsage(live = false): Promise<void> {
  planReadsInFlight++;
  try {
    // A turn that brought its own rate-limit figure is the account's
    // number at that moment (source `turn`); a live `/usage` within the
    // minute would only repeat it. Past that, ask the CLI.
    const held0 = app.planUsage;
    if (
      live &&
      held0?.source === "turn" &&
      held0.sampled_at_ms != null &&
      Date.now() - held0.sampled_at_ms < 60_000
    ) {
      return;
    }
    const fresh = await (live ? api.planUsageRefresh() : api.planUsage());
    // A file older than the turn-sourced reading already held is not an
    // update: the turn's figure was the account's at that moment.
    const held = app.planUsage;
    if (
      held?.source === "turn" &&
      held.sampled_at_ms != null &&
      fresh.sampled_at_ms != null &&
      fresh.sampled_at_ms < held.sampled_at_ms
    ) {
      return;
    }
    app.planUsage = fresh;
  } catch {
    // A failed read keeps the last reading, whose age the chip shows.
  } finally {
    planReadsInFlight--;
  }
}

/** Plan readings under way (`refreshPlanUsage`, `readPlanAtReplyEnd`). */
let planReadsInFlight = 0;

/**
 * The plan reading at a reply's end (item 323 review; his answer on
 * blocker 1270, 2026-10-08): taken at once, so the reply's usage line
 * closes now rather than at the next reading. Unlike `refreshPlanUsage(true)`
 * it does not stand on the turn's own figure (that is the reply's start),
 * and it asks the backend for a sample from after `endedAtMs`, which runs
 * the CLI's `/usage` (zero tokens; the backend's once-a-minute gap still
 * holds). Skipped while another reading is in flight; that one, or the
 * next, closes the line. Resolves to whether it ran.
 */
export async function readPlanAtReplyEnd(endedAtMs: number = Date.now()): Promise<boolean> {
  if (planReadsInFlight > 0) return false;
  planReadsInFlight++;
  try {
    const fresh = await api.planUsageRefresh(endedAtMs);
    const held = app.planUsage;
    if (
      held?.sampled_at_ms != null &&
      fresh.sampled_at_ms != null &&
      fresh.sampled_at_ms < held.sampled_at_ms
    ) {
      return true;
    }
    app.planUsage = fresh;
  } catch {
    // A failed read keeps the last reading; the next one closes the line.
  } finally {
    planReadsInFlight--;
  }
  return true;
}

/**
 * The plan chip from the turn itself (nightshift backlog 073). On CLI
 * 2.1.263 the `rate_limit_event` carries both windows' share used
 * (`unifiedWindows`, measured 2026-09-16); that is the account's figure at
 * the moment the turn ran, fresher than the Claude app's sample or the
 * CLI's `/usage` cache, so it wins and the files are the fallback for a
 * build that does not send it. Pure over its inputs so the suite can pin it.
 */
export function planUsageFromTurn(
  plan: AgentTurnResult["plan"],
  nowMs: number = Date.now(),
): PlanUsage | null {
  const w = plan?.unifiedWindows;
  const fh = w?.five_hour?.utilization;
  if (fh == null) return null;
  const pct = (u: number | null | undefined) =>
    u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  const iso = (secs: number | null | undefined) =>
    secs == null ? null : new Date(secs * 1000).toISOString();
  return {
    five_hour: pct(fh),
    seven_day: pct(w?.seven_day?.utilization),
    sampled_at_ms: nowMs,
    age_seconds: 0,
    stale: false,
    five_hour_resets_at: iso(w?.five_hour?.resetsAt),
    seven_day_resets_at: iso(w?.seven_day?.resetsAt),
    source: "turn",
  };
}

/**
 * The plan gauge refreshed through the CLI's print-mode `/usage` every five
 * minutes while the Claude Code engine is connected (backlog 166, blocker
 * 264, his yes 2026-09-18): the exact figure for zero tokens, so the chip
 * and the subagent limits (165) never act on a stale file. Started with the
 * daily clock; a provider connection makes each tick a no-op.
 */
export const PLAN_USAGE_LIVE_EVERY_MS = 5 * 60_000;

/**
 * The message's budget meter (nightshift backlog 165, pass 2): the ledger
 * the hook writes on every tool call, read every five seconds while a
 * Claude Code turn runs (a file read, no `/usage`), and once as the turn
 * ends so the final figure stays on the chip.
 */
export const TURN_BUDGET_EVERY_MS = 5_000;
let budgetPoll: ReturnType<typeof setInterval> | null = null;
export async function readTurnBudget(session: string | null): Promise<void> {
  if (!session || app.connection?.engine !== "claude-code") return;
  try {
    const got = await api.turnBudget(session);
    // A chat running off screen keeps its own ledger (backlog 159, A4);
    // the meter on screen is the screen's running chat's, or the open
    // chat's — never another chat's read that came back late.
    const b = app.background[session];
    if (b) {
      b.budget = got;
      return;
    }
    if (app.budgetSession === session || app.activeSessionId === session) app.turnBudget = got;
  } catch {
    // A failed read keeps the last ledger.
  }
}
/** The chat's checkpoint (backlog 104), for the transcript's marker. */
export async function readCheckpoint(session: string | null): Promise<void> {
  if (!session || app.connection?.engine !== "claude-code") {
    app.checkpoint = null;
    return;
  }
  try {
    app.checkpoint = await api.checkpoint(session);
  } catch {
    app.checkpoint = null;
  }
}
/** "Fork from here" (backlog 104): helpers fork from the end of the
 *  exchange the message at `index` belongs to. */
export async function setCheckpoint(index: number): Promise<void> {
  const session = app.activeSessionId;
  if (!session) return;
  try {
    app.checkpoint = await api.setCheckpoint(session, index);
    addToast("helpers now fork from here");
  } catch (e) {
    addToast(String(e));
  }
}
export function startBudgetPoll(session: string | null, typed = false): void {
  app.turnBudget = null;
  app.budgetSession = session;
  if (!session || app.connection?.engine !== "claude-code") return;
  notePresence(session, typed);
  void readTurnBudget(session);
  ensureBudgetPoll();
}
/** One clock for every running chat's meter (backlog 159, A4): the
 *  screen's running chat, with his presence, and each chat running off
 *  screen, into its own record. It stops once none runs. */
export function ensureBudgetPoll(): void {
  if (budgetPoll) return;
  budgetPoll = setInterval(budgetTick, TURN_BUDGET_EVERY_MS);
}
function budgetTick(): void {
  const onScreen = app.busy ? app.budgetSession : null;
  if (!onScreen && bgTurns.size === 0) {
    if (budgetPoll) clearInterval(budgetPoll);
    budgetPoll = null;
    return;
  }
  if (onScreen) {
    notePresence(onScreen, false);
    void readTurnBudget(onScreen);
  }
  // A chat in another project (blocker 630): its ledger is under that
  // project's logs, which the backend does not read from here — its last
  // reading stands until it is back on screen.
  for (const id of bgTurns.keys()) {
    const b = app.background[id];
    if (!b || !inOtherProject(b, app.project?.id ?? null)) void readTurnBudget(id);
  }
}

let planUsageClock: ReturnType<typeof setInterval> | null = null;
export function startPlanUsageClock(): void {
  if (planUsageClock) return;
  planUsageClock = setInterval(() => {
    if (app.connection?.engine === "claude-code" && !app.busy) void refreshPlanUsage(true);
  }, PLAN_USAGE_LIVE_EVERY_MS);
}
