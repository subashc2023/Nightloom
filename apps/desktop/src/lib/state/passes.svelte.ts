// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { clockText } from "../schedule";
import { CURATED, thinkingString, type ConnectionDraft } from "../catalog";
import { refreshWithin } from "../afterWrite";
import { cli } from "../cliUpdate.svelte";
import { deferredRecheckAt, handoffPassDue, nightlyReady, usageGate } from "../autoPass";
import { buildNotices, dailyDue, saveDailyPrefs, saveDismissed, saveLastDaily, saveSeenStamp, type DailyPrefs, type Notice } from "../centre";
import type { NightshiftRow } from "../types";
import { showNightshift } from "./nightshift.svelte";
import { showNote, AGENTS_MD, reviewProposal } from "./notes.svelte";
import { DREAM_ENGINE, type DreamPrefs, app, refreshNotes, refreshProposals, refreshPlanUsage, PLAN_USAGE_LIVE_EVERY_MS, useProject, addToast } from "../state.svelte";

/** Re-count the memory inbox. Cheap: one file read on the backend. */
export async function refreshDreamStatus(): Promise<void> {
  try {
    app.dreamPending = await api.dreamStatus();
  } catch {
    // No config dir reads as zero on the backend; anything else is not
    // worth a toast for a badge.
  }
}

/** Re-count the session logs with something new. Directory scans only. */
export async function refreshCaptureStatus(): Promise<void> {
  try {
    app.capturePending = await api.captureStatus();
  } catch {
    // No config dir reads as zero on the backend; anything else is not
    // worth a toast for a count.
  }
}

/**
 * Which connection a background pass runs on: the engine set in Settings,
 * or the rail's. One knob answers "which model dreams" for the button and
 * the auto-trigger alike — and the capture pass uses the same one, being
 * the front half of the same pipeline. Since 2026-09-16 (nightshift
 * backlog 070) the Claude Code engine is a real answer: chosen in Settings
 * it runs with the rail's binary and safe mode and the Settings alias;
 * left on the rail's connection while the rail is on Claude Code, it runs
 * with the rail's alias too, billed to the subscription either way. Pure,
 * so a test can pin the routing; `passTarget` reads the live state.
 */
export function passTargetFor(prefs: DreamPrefs, d: ConnectionDraft): api.PassArgs {
  if (prefs.provider === DREAM_ENGINE) {
    return {
      provider: DREAM_ENGINE,
      model: prefs.model.trim() || undefined,
      binary: d.agentBinary.trim() || undefined,
      safeMode: d.agentSafeMode,
    };
  }
  if (prefs.provider) {
    return { provider: prefs.provider, model: prefs.model.trim() || undefined };
  }
  if (d.engine === "claude-code") {
    return {
      provider: DREAM_ENGINE,
      model: d.agentModel.trim() || undefined,
      binary: d.agentBinary.trim() || undefined,
      safeMode: d.agentSafeMode,
    };
  }
  return {
    provider: d.provider,
    model: d.model || undefined,
    baseUrl: d.baseUrl.trim() || undefined,
    thinking: thinkingString(d),
  };
}

function passTarget(): api.PassArgs {
  return passTargetFor(app.dreamPrefs, app.draft);
}

/**
 * Run one capture pass with the dream's connection: read every session log
 * since its watermark and extract observations into the inbox. Its own job
 * on the backend, sharing the dream's one-at-a-time lock, since the two are
 * one pipeline.
 */
export async function runCapture(quiet = false): Promise<void> {
  if (app.capturing || app.dreaming) return;
  const target = passTarget();
  app.capturing = true;
  try {
    const r = await api.capture(target);
    // An automatic pass that read nothing (every chat deferred) says
    // nothing (item 278: "skip silently when nothing is pending").
    if (quiet && r.logs_read === 0 && r.observations === 0 && !r.interrupted) return;
    // "3 from Lanternfish, 1 unfiled": the split by source.
    const split = r.per_project
      .map((p) =>
        p.project === "unfiled" ? `${p.observations} unfiled` : `${p.observations} from ${p.project}`,
      )
      .join(", ");
    addToast(
      (r.interrupted ? "capture interrupted — " : "capture: ") +
        `captured ${r.observations} observation${r.observations === 1 ? "" : "s"}` +
        ` from ${r.logs_read} chat${r.logs_read === 1 ? "" : "s"}` +
        (r.skipped > 0 ? ` (${r.skipped} line${r.skipped === 1 ? "" : "s"} skipped)` : "") +
        (r.refused > 0 ? ` (${r.refused} refused)` : "") +
        (split ? ` — ${split}` : "") +
        (r.deferred > 0 ? `; ${r.deferred} waiting for more turns` : "") +
        (r.incognito > 0 ? `; ${r.incognito} incognito, not read` : "") +
        (r.remaining > 0 ? `; ${r.remaining} left for the next run` : "") +
        (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    // Another Nightloom's pass holding the lock is not news on an
    // automatic run; anything else is.
    if (!(quiet && String(e).includes("already running"))) addToast(`capture failed: ${String(e)}`);
  } finally {
    app.capturing = false;
  }
  // The pass fills the inbox and moves the watermarks; both counts follow.
  await refreshCaptureStatus();
  await refreshDreamStatus();
}

/**
 * "Save memory from this chat" (backlog 371): the capture pass over that one
 * chat — an imported one too, whatever the cutoff — then the toast offers
 * the Dream that files what it found into the project's memory or the vault.
 */
export async function saveMemoryFromChat(id: string): Promise<void> {
  if (app.capturing || app.dreaming) {
    addToast("a dream or a capture is already running");
    return;
  }
  const target = passTarget();
  app.capturing = true;
  let found = 0;
  try {
    const r = await api.capture(target, id);
    found = r.observations;
    addToast(
      (r.interrupted ? "save interrupted — " : "") +
        `saved ${r.observations} observation${r.observations === 1 ? "" : "s"} from this chat` +
        (r.refused > 0 ? ` (${r.refused} refused)` : "") +
        (r.remaining > 0 ? "; the rest of it is left for the next save" : "") +
        (r.observations > 0 ? " — Dream files them into memory" : ""),
      r.observations > 0 ? { label: "Dream", run: () => void runDream() } : undefined,
    );
  } catch (e) {
    addToast(`save memory failed: ${String(e)}`);
  } finally {
    app.capturing = false;
  }
  await refreshCaptureStatus();
  if (found > 0) await refreshDreamStatus();
}

/** Interrupt the in-flight capture. The chat it stopped in is re-read next time. */
export async function stopCapture(): Promise<void> {
  try {
    await api.cancelCapture();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Run one dream with the rail's current provider settings.
 *
 * The connection travels as arguments rather than reusing the window's chat:
 * a dream is its own job with its own prompt and tool set, and it works the
 * same whichever engine the window is on — the Claude Code engine included,
 * since 2026-09-16 (`passTargetFor`).
 */
export async function runDream(): Promise<void> {
  if (app.dreaming || app.capturing) return;
  const target = passTarget();
  app.dreaming = true;
  app.dreamActivity = "";
  try {
    const r = await api.dream(target);
    // "3 into Lanternfish, 2 into the vault": the split by target, which is
    // how the user learns a project's memory folder exists at all.
    const split = r.filed
      .map((f) => `${f.consolidated} into ${f.project ?? "the vault"}`)
      .join(", ");
    addToast(
      r.interrupted
        ? "dream interrupted — nothing consumed; the same batch is offered next time"
        : `dream: consolidated ${r.consolidated} observation${r.consolidated === 1 ? "" : "s"}` +
            (split ? ` — ${split}` : "") +
            (r.remaining > 0 ? `, ${r.remaining} left for the next run` : "") +
            ` — ${r.git}` +
            // "… and proposed a change to Lanternfish's instructions": the
            // one thing a dream leaves that is not yet in effect.
            (r.proposed ? ` — and ${r.proposed}` : "") +
            // Item 280: lines that named what his messages do not contain.
            (r.refused > 0 ? ` — ${r.refused} refused` : "") +
            (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    addToast(`dream failed: ${String(e)}`);
  } finally {
    app.dreaming = false;
    app.dreamActivity = "";
  }
  // The pass writes notes and consumes the inbox; both surfaces follow —
  // and the bell, which lists what the dream proposed and changed.
  await refreshNotes();
  await refreshDreamStatus();
  void refreshCentre();
}

/**
 * The automatic pass, from every trigger (since nightshift item 278, a
 * hand-off as well — `maybeHandoffPass` — and on by default; the rest of
 * this comment is the compaction trigger it started as).
 *
 * The auto-dream trigger: a compaction just landed, which is the moment the
 * evidence supports — the conversation's detail is already being traded for
 * a summary, so a background consolidation interrupts nothing the user was
 * still watching. Opt-in (Settings → Knowledge) because it spends a
 * provider turn unattended; an empty inbox spends nothing and says nothing.
 *
 * Capture runs first, since 2026-09-14: the inbox only fills when a pass
 * reads the logs, so a dream without one would consolidate an inbox that is
 * empty on this machine. The compacted chat is among the logs read — up to
 * its watermark, which is fine.
 */
export async function maybeAutoDream(kind: AutoPassKind = "compaction"): Promise<boolean> {
  if (!app.dreamPrefs.auto || app.dreaming || app.capturing || app.centre.dailyRunning) return false;
  await refreshCaptureStatus();
  await refreshDreamStatus();
  // Nothing to read and nothing to dream: no pass, so nothing to defer.
  if (app.capturePending === 0 && app.dreamPending === 0) return false;
  // Usage headroom (item 279): over a limit, the pass waits for the next
  // trigger, or the reset of the window that holds it.
  if (!(await autoPassMayRun(kind))) {
    autoPassDeferred = true;
    return true;
  }
  autoPassDeferred = false;
  // Quiet (item 278): a capture that reads nothing — the open chat has one
  // new turn, too little to be worth one — spends nothing and says nothing.
  if (app.capturePending > 0) await runCapture(true);
  await refreshDreamStatus();
  if (app.dreamPending === 0) return false;
  addToast("auto-dream: consolidating the memory inbox");
  await runDream();
  return false;
}

/*
 * The usage gate's wiring (nightshift item 279); the rules are pure in
 * `autoPass.ts` (`usageGate`, `deferredRecheckAt`).
 */
export type AutoPassKind = "hand-off" | "compaction" | "nightly" | "reset";

/** A hand-off or compaction pass the gate held, still owed. */
let autoPassDeferred = false;
/** When the gate first held the pass now owed, for the Settings line. */
let deferredSince: number | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

/** "2:05 PM" — 12-hour whatever the locale (item 611b; was the locale's own). */
const clockTime = clockText;

/**
 * May an automatic pass start? Reads the plan's figure the way the top
 * bar's chip does (`refreshPlanUsage`; a live `/usage` only when the held
 * reading is older than the chip's own five-minute tick), then asks
 * `usageGate`. Held: the Settings line says why, and a timer re-checks at
 * the reset of the window that holds it. Let through without a check: the
 * line and the console say why.
 */
async function autoPassMayRun(kind: AutoPassKind): Promise<boolean> {
  const limits = { fiveHour: app.dreamPrefs.limitFiveHour, week: app.dreamPrefs.limitWeek };
  const onPlan = passTarget().provider === DREAM_ENGINE;
  if (onPlan) {
    const u = app.planUsage;
    if (!u || u.sampled_at_ms == null || Date.now() - u.sampled_at_ms > PLAN_USAGE_LIVE_EVERY_MS) {
      await refreshPlanUsage(true);
    }
  }
  const now = Date.now();
  const v = usageGate(app.planUsage, limits, onPlan, now);
  if (!v.run) {
    deferredSince ??= now;
    app.autoPassNote =
      `automatic pass deferred ${clockTime(deferredSince)} — ${v.why}; ` +
      "it runs at the next trigger under the limits";
    scheduleRecheck(deferredRecheckAt(app.planUsage, limits));
    return false;
  }
  if (v.why) {
    console.info(`automatic ${kind} pass ran without a usage check: ${v.why}`);
    app.autoPassNote = `${kind} pass ${clockTime(now)} ran without a usage check — ${v.why}`;
  } else if (deferredSince !== null) {
    app.autoPassNote = `${kind} pass ran ${clockTime(now)}, usage under the limits (deferred since ${clockTime(deferredSince)})`;
  }
  deferredSince = null;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  return true;
}

/** Look again at `at` (a window's reset): the owed hand-off pass, and the
 *  nightly one if its day has come. */
function scheduleRecheck(at: number | null): void {
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  if (at === null) return;
  const delay = Math.min(Math.max(60_000, at - Date.now()), 2 ** 31 - 1);
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    if (autoPassDeferred) void maybeAutoDream("reset");
    else void maybeDailyPass();
  }, delay);
}

/**
 * The hand-off trigger (nightshift item 278): a turn that wrote
 * `HANDOFF.md`, or *Continue in a new chat*. The two land minutes apart
 * for one hand-off, so `handoffPassDue` makes them one pass. Runs on the
 * same connection and switch as every automatic pass (`passTargetFor`,
 * Settings → Knowledge).
 */
let lastHandoffPass: number | null = null;
export function maybeHandoffPass(): void {
  if (!app.dreamPrefs.auto) return;
  const now = Date.now();
  if (!handoffPassDue(lastHandoffPass, now)) return;
  lastHandoffPass = now;
  // A pass the usage gate held does not count against the spacing: the
  // Continue that follows the wrap-up minutes later asks again (item 279).
  void maybeAutoDream("hand-off").then((deferred) => {
    if (deferred && lastHandoffPass === now) lastHandoffPass = null;
  });
}

/** Interrupt the in-flight dream. Nothing is consumed; the batch returns. */
export async function stopDream(): Promise<void> {
  try {
    await api.cancelDream();
  } catch (e) {
    addToast(String(e));
  }
}

// ---- the notification centre and the daily pass (nightshift backlog 069) ----

/**
 * Re-derive the bell's list from its sources: every project's proposals,
 * the dream's commits, the Nightshift rows, the build stamp. Four cheap
 * reads (directories and `git log`), so it runs after every pass, on the
 * panel opening, and on a Nightshift change. With the macOS banner on, a
 * notice that was not there at the previous refresh posts one — never on
 * the first refresh of a window, which would announce the whole backlog.
 */
let centreSeen: Set<string> | null = null;
export async function refreshCentre(): Promise<void> {
  const [proposals, commits, applied, rows, stamp] = await Promise.all([
    api.centreProposals().catch(() => []),
    api.centreDreamCommits(10).catch(() => []),
    api.centreApplied(10).catch(() => []),
    api.nightshiftProjects().catch(() => [] as NightshiftRow[]),
    api.buildStamp().catch(() => null),
  ]);
  app.centre.rows = rows;
  app.centre.notices = buildNotices({
    proposals,
    commits,
    applied,
    rows,
    read: app.nightshift.read,
    stamp,
    seenStamp: app.centre.seenStamp,
    dismissed: app.centre.dismissed,
    cli: cli.status,
    curated: CURATED.anthropic ?? [],
  });
  // A first run has no stamp on record: the one seen now becomes it, so
  // the next roll is the first release the bell announces.
  if (stamp?.exe_modified && !app.centre.seenStamp) {
    app.centre.seenStamp = stamp.exe_modified;
    saveSeenStamp(stamp.exe_modified);
  }
  const ids = new Set(app.centre.notices.map((n) => n.id));
  if (centreSeen && app.centre.daily.notifyMac) {
    const fresh = app.centre.notices.filter((n) => !centreSeen!.has(n.id));
    if (fresh.length > 0) {
      const body =
        fresh.length === 1 ? fresh[0].title : `${fresh[0].title} — and ${fresh.length - 1} more`;
      api.notify("Nightloom — to review", body).catch(() => {});
    }
  }
  centreSeen = ids;
}

/** The bell's count: everything listed. */
export function centreCount(): number {
  return app.centre.notices.length;
}

/** Take a notice off the list. The thing it names is untouched — a
 *  dismissed proposal is still pending under Notes, a dismissed blocker
 *  still open — and comes back only as a different notice (a new page, a
 *  changed count). */
export function dismissNotice(id: string): void {
  if (!app.centre.dismissed.includes(id)) app.centre.dismissed = [...app.centre.dismissed, id];
  saveDismissed(app.centre.dismissed);
  app.centre.notices = app.centre.notices.filter((n) => n.id !== id);
  // A release notice is dismissed by recording the stamp as seen.
  if (id.startsWith("release:")) {
    const stamp = id.slice("release:".length);
    app.centre.seenStamp = stamp;
    saveSeenStamp(stamp);
  }
}

/**
 * Open a notice's review — always the existing flow, reached from the
 * panel: a proposal opens `NoteView` in proposal mode (switching to the
 * project first when it is not the open one), a morning page or the
 * blockers open the Nightshift Review tab on that project. A dream's notes
 * are reviewed in the panel itself (`NotificationCentre.svelte` shows the
 * diff and the per-file Revert), and a release has nothing to open.
 */
export async function openNotice(n: Notice): Promise<void> {
  app.centre.open = false;
  if (n.project && app.project?.id !== n.project.id) {
    await useProject(n.project.id);
  }
  if (n.kind === "proposal" && n.proposal) {
    await refreshProposals();
    reviewProposal(n.proposal.project ? "instructions" : "memory", n.proposal.entry.id);
    return;
  }
  if (n.kind === "morning" || n.kind === "blocker") {
    showNightshift();
    app.nightshift.tab = "review";
    app.nightshift.reviewTab = n.kind === "morning" ? "morning" : "blockers";
  }
}

/** Put one file a dream changed back as it was before that dream, as a
 *  commit; the notice stays until dismissed, so the other files can follow. */
export async function revertDreamFile(n: Notice, file: string): Promise<boolean> {
  if (!n.commit) return false;
  try {
    addToast(await api.centreRevertFile(n.commit.repo, n.commit.hash, file));
  } catch (e) {
    addToast(`revert failed: ${String(e)}`);
    return false;
  }
  // In the background (backlog 211): the revert is done when it returns.
  void refreshWithin("reverting " + file, [refreshNotes]);
  return true;
}

/** Revert a dream's write to an `AGENTS.md` no commit carries (backlog
 *  344), from the copy kept before it; the row goes once it is done. */
export async function revertApplied(n: Notice): Promise<boolean> {
  if (!n.applied) return false;
  try {
    addToast(await api.centreRevertApplied(n.applied.project?.id ?? null, n.applied.entry.id));
  } catch (e) {
    addToast(`revert failed: ${String(e)}`);
    return false;
  }
  void refreshWithin("reverting AGENTS.md", [refreshNotes, refreshCentre]);
  return true;
}

/** Open the always-loaded file a dream changed (backlog 344) in the app's
 *  editor: the project's instructions, or the user's memory. */
export async function openInstructions(n: Notice): Promise<void> {
  app.centre.open = false;
  if (n.project && app.project?.id !== n.project.id) {
    await useProject(n.project.id);
  }
  showNote(n.project ? "instructions" : "memory", AGENTS_MD);
}

export function setDailyPrefs(p: DailyPrefs): void {
  app.centre.daily = p;
  saveDailyPrefs(p);
}

/**
 * The daily pass: capture → dream → tidy, on the connection `passTargetFor`
 * chooses (so it runs on either engine), under the same one-at-a-time lock
 * as the buttons. Nothing is spent when there is nothing to read: an empty
 * set of logs skips the capture, an empty inbox skips the dream, and the
 * tidy is directory work. The run is stamped as it starts, not as it ends,
 * so a pass that fails is not retried every minute until the hour comes
 * round — the next day's hour, or the *Run now* button, is the retry.
 */
export async function runDailyPass(): Promise<void> {
  if (app.centre.dailyRunning || app.dreaming || app.capturing) return;
  app.centre.dailyRunning = true;
  const started = Date.now();
  app.centre.lastDaily = started;
  saveLastDaily(started);
  const said: string[] = [];
  try {
    await refreshCaptureStatus();
    if (app.capturePending > 0) {
      await runCapture();
      said.push(`captured from ${app.capturePending} chat${app.capturePending === 1 ? "" : "s"}`);
    } else {
      said.push("nothing new to capture");
    }
    await refreshDreamStatus();
    if (app.dreamPending > 0) {
      const pending = app.dreamPending;
      await runDream();
      said.push(`dreamed ${pending} observation${pending === 1 ? "" : "s"}`);
    } else {
      said.push("nothing to dream");
    }
    try {
      const tidy = await api.tidyMemory(true);
      const moved = tidy.reduce((n, t) => n + t.report.movable, 0);
      said.push(
        moved > 0
          ? `archived ${moved} struck line${moved === 1 ? "" : "s"} older than 30 days`
          : "nothing old enough to archive",
      );
    } catch (e) {
      said.push(`tidy failed: ${String(e)}`);
    }
    // Research threads (backlog 271): struck lines from earlier rounds to
    // each thread's archive.md, duplicate queue rows merged, the index
    // rewritten. Mechanical; what needs a model is flagged for the next
    // bound chat's wrap-up.
    try {
      const tidied = await api.tidyThreads(true);
      const ups = tidied.flatMap((t) => t.threads);
      if (ups.length > 0) {
        const moved = ups.reduce((n, u) => n + u.struck_moved + u.merged.length, 0);
        const flagged = ups.reduce((n, u) => n + u.flags.length, 0);
        said.push(
          `threads: ${moved} line${moved === 1 ? "" : "s"} archived or merged` +
            (flagged > 0 ? `, ${flagged} flag${flagged === 1 ? "" : "s"} for the next wrap-up` : ""),
        );
      }
    } catch (e) {
      said.push(`thread upkeep failed: ${String(e)}`);
    }
  } catch (e) {
    // A capture or a dream that failed — the pass lock held by another
    // Nightloom, a provider without a key — used to leave through here
    // with no line and no toast, and Settings read "last ran 04:00" as
    // if it had (backlog 133, review B's FB9). Now the failure is the
    // line and the toast; the day was stamped as run at the start, as
    // before, so the minute clock does not retry the same failure.
    said.push(`failed: ${String(e)}`);
  } finally {
    app.centre.dailyRunning = false;
  }
  const when = new Date(started);
  // 12-hour whatever the locale (item 611b; was the locale's "02:05 PM" / "14:05").
  app.centre.dailyLast = `${when.toLocaleDateString()} ${clockText(started)} — ${said.join(", ")}`;
  addToast(`daily pass: ${said.join(", ")}`);
  await refreshCentre();
}

/** Run the daily pass if its hour has come and it has not run since. */
export async function maybeDailyPass(): Promise<void> {
  if (!dailyDue(app.centre.daily, app.centre.lastDaily, new Date())) return;
  // Once a night when the Mac is idle (item 278): the hour decides the
  // day, and the pass then waits for an idle Mac unless the last one is
  // stale. The minute clock asks again until it is.
  const idle = await api.macIdleMs().catch(() => null);
  if (!nightlyReady(idle, app.centre.lastDaily, Date.now())) return;
  // Usage headroom (item 279): over a limit, the minute clock asks again;
  // the day is not stamped, so the pass is owed until it runs.
  if (app.centre.dailyRunning || app.dreaming || app.capturing) return;
  if (!(await autoPassMayRun("nightly"))) return;
  await runDailyPass();
}

let dailyClock: ReturnType<typeof setInterval> | null = null;
export function startDailyClock(): void {
  if (dailyClock) return;
  dailyClock = setInterval(() => void maybeDailyPass(), 60_000);
}
