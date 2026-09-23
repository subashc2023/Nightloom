/**
 * Claude Code's version check and update, run (nightshift backlog 182).
 * The rules are in `cliUpdate.ts`; this holds the state the bell and
 * Settings draw, and the clock:
 *
 * - **Check** at launch (after `FIRST_CHECK_MS`) and every six hours —
 *   `claude --version` against the release feed, zero tokens — never while
 *   anything runs (it waits for the next tick).
 * - **Update** (the notice's default) waits for a cold moment: nothing
 *   running and every open chat's cache expired, looked at once a minute.
 *   **Now** skips the cache wait after its cost is shown, never the
 *   running-turn one.
 * - **Keep Claude Code up to date** (Settings, on by default since blocker 291) does the
 *   same wait by itself whenever a check finds a newer release.
 *
 * "Running" is everything that drives the CLI or a model: a turn (the
 * running chat, parked or not), a connect, a dream, a capture, the daily
 * pass, an aside, the intake interview, and a Nightshift run in any
 * project — the runner pins its own CLI, and an update under it would
 * swap the binary between its passes.
 */
import * as api from "./api";
import { cacheState } from "./cache";
import { CURATED } from "./catalog";
import { chatName } from "./notify";
import { addToast, app, liveFlags, refreshCentre } from "./state.svelte";
import type { CliStatus, CliUpdateResult, SessionEvent } from "./types";
import {
  COLD_TICK_MS,
  FIRST_CHECK_MS,
  checkDue,
  coldReading,
  loadCliPrefs,
  offersUpdate,
  resultLine,
  saveCliPrefs,
  type ColdReading,
  type OpenChatCache,
} from "./cliUpdate";

export const cli = $state({
  status: null as CliStatus | null,
  checking: false,
  updating: false,
  /** An Update is waiting for a cold moment. */
  waiting: false,
  /** The newest look at the cold rule, for the waiting line and "now"'s cost. */
  reading: null as ColdReading | null,
  result: null as CliUpdateResult | null,
  /** A check or update that threw, one line. */
  error: null as string | null,
  prefs: loadCliPrefs(),
});

/** The CLI in question: the connected Claude Code chat's resolved binary,
 *  else `claude` resolved by the backend. */
function binary(): string | null {
  return app.connection?.engine === "claude-code" ? (app.connection.agent?.binary ?? null) : null;
}

/** What is running now, in words; empty when nothing is. */
export function runningNow(): string[] {
  const out: string[] = [];
  if (app.busy) out.push("a turn");
  if (app.connecting) out.push("a connect");
  if (app.dreaming) out.push("a dream");
  if (app.capturing) out.push("a capture");
  if (app.centre.dailyRunning) out.push("the daily pass");
  // Every open card's thread (backlog 176), not only the front one.
  if (app.asides.some((a) => a.turns.some((t) => t.answer === null && t.error === null && !t.cancelled))) out.push("an aside");
  if (app.nightshift.interview?.busy) out.push("an interview");
  for (const r of app.centre.rows) if (r.nightshift?.live) out.push(`a Nightshift run in ${r.name}`);
  return out;
}

/** The open chats' session ids: every chat tab in every pane, the floating
 *  tab, and the chat on screen. */
function openChatIds(): string[] {
  const ids = new Set<string>();
  for (const p of app.tabs.panes) for (const t of p.tabs) if (t.content.kind === "chat" && t.content.session) ids.add(t.content.session);
  const f = app.tabs.floating;
  if (f?.content.kind === "chat" && f.content.session) ids.add(f.content.session);
  if (app.activeSessionId) ids.add(app.activeSessionId);
  return [...ids];
}

/** The newest live turn's prefix size: input plus output, the gauge's figure. */
export function prefixTokens(events: SessionEvent[]): number | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!live[i] || e.event !== "assistant_message") continue;
    return e.usage ? e.usage.input_tokens + e.usage.output_tokens : null;
  }
  return null;
}

/** Each open chat's cache, from its log — the chat on screen from memory,
 *  the rest peeked (read, not opened). A chat whose log cannot be read
 *  counts as cold: it has no timer to wait on. */
async function openChatCaches(now: number): Promise<OpenChatCache[]> {
  const out: OpenChatCache[] = [];
  for (const id of openChatIds()) {
    let events: SessionEvent[] = [];
    try {
      events = id === app.activeSessionId ? app.events : await api.peekSession(id);
    } catch {
      events = [];
    }
    const s = app.sessions.find((x) => x.id === id);
    const cache = cacheState(events ?? [], now);
    out.push({
      session: id,
      title: chatName(s?.title, s?.first_user),
      warmUntil: cache ? cache.warmUntil : null,
      tokens: prefixTokens(events ?? []),
    });
  }
  return out;
}

/** Look at the cold rule now; kept on `cli.reading` for the lines. */
export async function readCold(): Promise<ColdReading> {
  const now = Date.now();
  const r = coldReading(runningNow(), await openChatCaches(now), now);
  cli.reading = r;
  return r;
}

/** Check the version. Skipped while anything runs unless `force` (the
 *  Check now button; the check itself costs nothing and touches no chat). */
export async function checkCli(force = false): Promise<void> {
  if (cli.checking || cli.updating) return;
  if (!force && runningNow().length) return;
  cli.checking = true;
  try {
    const s = await api.cliVersionCheck(binary());
    if (!s) return;
    cli.status = s;
    cli.error = null;
    cli.prefs.lastCheck = Date.now();
    saveCliPrefs(cli.prefs);
    if (!offersUpdate(s)) cli.waiting = false;
  } catch (e) {
    cli.error = String(e);
  } finally {
    cli.checking = false;
  }
  void refreshCentre();
}

/** The notice's Update: wait for the next cold moment, or go now if it is one. */
export async function updateWhenCold(): Promise<void> {
  if (!offersUpdate(cli.status)) return;
  cli.waiting = true;
  await tickCli();
}

export function cancelWait(): void {
  cli.waiting = false;
}

/** "Now": skip the cache wait (its cost was shown first) — never a
 *  running turn's. */
export async function updateNow(): Promise<void> {
  if (!offersUpdate(cli.status) || cli.updating) return;
  const r = await readCold();
  if (r.running.length) {
    addToast(`Claude Code is not updated while ${r.running.join(", ")} ${r.running.length === 1 ? "runs" : "run"}.`);
    return;
  }
  await runUpdate(false);
}

async function runUpdate(automatic: boolean): Promise<void> {
  if (cli.updating) return;
  // Looked at again, synchronously: the cold reading peeked logs, and a
  // turn may have started meanwhile. A waiting update stays waiting.
  if (runningNow().length) return;
  cli.updating = true;
  cli.waiting = false;
  const target = cli.status?.latest ?? null;
  try {
    const r = await api.cliUpdate(binary());
    cli.result = r;
    addToast(resultLine(r));
    // A run that failed, or "succeeded" without moving this CLI (it
    // updated another install), is not retried by itself.
    if (automatic && (!r.ok || r.before === r.after)) {
      cli.prefs.autoFailedFor = target;
      saveCliPrefs(cli.prefs);
    }
  } catch (e) {
    cli.error = String(e);
    addToast(`claude update: ${e}`);
    if (automatic) {
      cli.prefs.autoFailedFor = target;
      saveCliPrefs(cli.prefs);
    }
  } finally {
    cli.updating = false;
  }
  // The notice clears when the check agrees.
  await checkCli(true);
}

/** Once a minute: a due check, then a waiting (or automatic) update at the
 *  first cold moment. */
export async function tickCli(): Promise<void> {
  if (cli.updating || cli.checking) return;
  // A launch checks whatever the last check's age (the status is not kept
  // across launches); after that, every six hours.
  const due = cli.status === null || checkDue(cli.prefs.lastCheck, Date.now());
  if (due && runningNow().length === 0) await checkCli();
  const s = cli.status;
  if (!offersUpdate(s)) {
    cli.waiting = false;
    return;
  }
  const automatic = cli.prefs.auto && !cli.waiting && cli.prefs.autoFailedFor !== s!.latest;
  if (!cli.waiting && !automatic) return;
  const r = await readCold();
  if (r.cold) await runUpdate(automatic);
}

export function setAutoUpdate(on: boolean): void {
  cli.prefs.auto = on;
  cli.prefs.autoFailedFor = null;
  saveCliPrefs(cli.prefs);
  if (on) void tickCli();
}

/** The curated Anthropic ids, for naming what the picker lacks. */
export function curatedAnthropic(): string[] {
  return CURATED.anthropic ?? [];
}

let clock: ReturnType<typeof setInterval> | null = null;
/** From `init`: the first check shortly after launch, then the minute tick. */
export function startCliClock(): void {
  if (clock) return;
  setTimeout(() => void tickCli(), FIRST_CHECK_MS);
  clock = setInterval(() => void tickCli(), COLD_TICK_MS);
}
