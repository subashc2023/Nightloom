/**
 * The turn-end banner (nightshift backlog 079): a native notification when
 * a turn finishes, or when a call is waiting on his answer, while Nightloom
 * is not the window in front.
 *
 * In the terminal his own Stop hook tells him a turn finished; under
 * Nightloom nothing did. The app knows both halves itself — the turn
 * boundary is the send promise resolving in `state.svelte.ts`, the
 * needs-you moment is the `tool-approval` event — and whether its window is
 * focused, so it posts the banner itself through the `notify` command (the
 * Tauri notification plugin, from Rust). Nothing is sent anywhere else.
 *
 * Two rules, both his (`Notify.dc.html`): **never for a focused window**,
 * and a Settings switch for each kind. The decision is made here; the
 * backend only posts. Everything below `windowFocused` is pure so the suite
 * can pin the copy.
 */
import type { Segment } from "./state.svelte";
import type { ApprovalRequest, PlanUsage, UsageSummary } from "./types";
import { toolInputSummary } from "./transcriptPrefs.svelte";
import { fmtTokens } from "./tokens";
import * as api from "./api";

export interface NotifyPrefs {
  /** A turn finished while the window was in the background. */
  turnEnd: boolean;
  /** A call is waiting on an answer while the window was in the background. */
  needsYou: boolean;
  /** Settings → Usage → Refresh now finished (backlog 116). Never the
   *  periodic refresh, and posted whether or not the window is in front:
   *  he pressed the button. */
  usageRefresh: boolean;
}

export const NOTIFY_PREFS_KEY = "nightloom.notify";

/** The stored preference read back, or both on when absent or malformed. */
export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<NotifyPrefs>;
      return {
        turnEnd: typeof p.turnEnd === "boolean" ? p.turnEnd : true,
        needsYou: typeof p.needsYou === "boolean" ? p.needsYou : true,
        usageRefresh: typeof p.usageRefresh === "boolean" ? p.usageRefresh : true,
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { turnEnd: true, needsYou: true, usageRefresh: true };
}

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    return parseNotifyPrefs(localStorage.getItem(NOTIFY_PREFS_KEY));
  } catch {
    return parseNotifyPrefs(null);
  }
}

export function saveNotifyPrefs(p: NotifyPrefs): void {
  try {
    localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(p));
  } catch {
    // best-effort
  }
}

/** The one gate that is never a setting: a window in front is not notified. */
export function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/** Calls that change a file on either engine, and the input key that names it. */
const WRITERS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  write_file: "path",
  edit_file: "path",
};

/** How many distinct files the turn's calls wrote or edited. A denied or
 *  failed call changed nothing and is not counted. */
export function filesChanged(segs: Segment[]): number {
  const paths = new Set<string>();
  for (const s of segs) {
    if (s.kind !== "tool") continue;
    const key = WRITERS[s.call.name];
    if (!key || s.call.denied || s.call.result?.is_error) continue;
    const input = s.call.input;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const p = (input as Record<string, unknown>)[key];
      if (typeof p === "string" && p) paths.add(p);
    }
  }
  return paths.size;
}

/** `41 s`, `2 min 10 s`, `1 h 4 min`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** The chat as the banner names it: its title, else its first message, else "New chat". */
export function chatName(title: string | null | undefined, firstUser: string | null | undefined): string {
  const t = (title ?? firstUser ?? "").trim().split("\n")[0];
  return t ? (t.length > 60 ? `${t.slice(0, 57)}…` : t) : "New chat";
}

/** `<chat> — turn finished`, or `— turn failed`. */
export function turnEndTitle(chat: string, failed: boolean): string {
  return `${chat} — ${failed ? "turn failed" : "turn finished"}`;
}

/**
 * `3 files changed · 1.2k out · 2 min 10 s` — what the design's banner
 * carries, each part only when there is one; `done` when there is nothing
 * to say. A failed turn's body is the error's first line.
 */
export function turnEndBody(
  segs: Segment[],
  outTokens: number | null,
  elapsedMs: number | null,
  error: string | null,
): string {
  if (error) return error.split("\n")[0].slice(0, 120);
  const parts: string[] = [];
  const files = filesChanged(segs);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"} changed`);
  if (outTokens != null && outTokens > 0) parts.push(`${fmtTokens(outTokens)} out`);
  if (elapsedMs != null && elapsedMs >= 1000) parts.push(fmtElapsed(elapsedMs));
  return parts.length > 0 ? parts.join(" · ") : "done";
}

/** `<chat> — Run Bash?`; a question and a plan by what they are. */
export function needsYouTitle(chat: string, req: Pick<ApprovalRequest, "name">): string {
  const what =
    req.name === "AskUserQuestion"
      ? "Claude asks a question"
      : req.name === "ExitPlanMode"
        ? "Approve the plan?"
        : `Run ${req.name}?`;
  return `${chat} — ${what}`;
}

/** `<the argument> · waits until you answer`. */
export function needsYouBody(req: Pick<ApprovalRequest, "name" | "input">): string {
  const arg = req.name === "AskUserQuestion" || req.name === "ExitPlanMode" ? "" : toolInputSummary(req.input);
  return arg ? `${arg.slice(0, 100)} · waits until you answer` : "waits until you answer";
}

/**
 * Post the turn-end banner, unless the window is in front or the switch is
 * off. Errors from the notification centre are swallowed: a banner that
 * could not be shown is not worth a toast in a window nobody is looking at.
 */
export async function notifyTurnEnd(args: {
  chat: string;
  segs: Segment[];
  outTokens: number | null;
  elapsedMs: number | null;
  error: string | null;
  prefs?: NotifyPrefs;
}): Promise<void> {
  const prefs = args.prefs ?? loadNotifyPrefs();
  if (!prefs.turnEnd || windowFocused()) return;
  try {
    await api.notify(
      turnEndTitle(args.chat, args.error !== null),
      turnEndBody(args.segs, args.outTokens, args.elapsedMs, args.error),
    );
  } catch {
    // See above.
  }
}

/** Post the needs-you banner, on the same terms. */
export async function notifyNeedsYou(chat: string, req: ApprovalRequest, prefs?: NotifyPrefs): Promise<void> {
  const p = prefs ?? loadNotifyPrefs();
  if (!p.needsYou || windowFocused()) return;
  try {
    await api.notify(needsYouTitle(chat, req), needsYouBody(req));
  } catch {
    // See above.
  }
}

/** `Usage refreshed`, or `Usage refresh failed`. */
export function usageRefreshTitle(failed: boolean): string {
  return failed ? "Usage refresh failed" : "Usage refreshed";
}

/**
 * The headline figures the pane shows, on one line: `$12.34 in 7 days ·
 * 5h 41% · week 23%` — each part only when the ledger or the plan has it,
 * `the ledger is current` when neither does. A failed run's body is the
 * error's first line, as the turn-end banner does it.
 */
export function usageRefreshBody(
  usage: Pick<UsageSummary, "available" | "week"> | null,
  plan: Pick<PlanUsage, "five_hour" | "seven_day"> | null,
  error: string | null,
): string {
  if (error) return error.split("\n")[0].slice(0, 120);
  const parts: string[] = [];
  if (usage?.available && usage.week) {
    const usd =
      "$" + usage.week.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    parts.push(`${usd} in 7 days`);
  }
  if (plan?.five_hour != null) parts.push(`5h ${Math.round(plan.five_hour)}%`);
  if (plan?.seven_day != null) parts.push(`week ${Math.round(plan.seven_day)}%`);
  return parts.length > 0 ? parts.join(" · ") : "the ledger is current";
}

/**
 * Post the Refresh-now banner (backlog 116) — through its own command, so
 * the click comes back and opens Settings → Usage. Only the switch gates
 * it: he asked for this one by pressing the button, so a focused window
 * is notified too. The periodic refresh never calls this.
 */
export async function notifyUsageRefreshed(
  usage: Pick<UsageSummary, "available" | "week"> | null,
  plan: Pick<PlanUsage, "five_hour" | "seven_day"> | null,
  error: string | null,
  prefs?: NotifyPrefs,
): Promise<void> {
  const p = prefs ?? loadNotifyPrefs();
  if (!p.usageRefresh) return;
  try {
    await api.notifyUsageRefreshed(usageRefreshTitle(error !== null), usageRefreshBody(usage, plan, error));
  } catch {
    // As above: a banner that could not be shown is not worth a toast.
  }
}
