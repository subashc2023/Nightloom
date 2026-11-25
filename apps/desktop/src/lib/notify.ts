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
import { nameLine } from "./chatLabel";
import { extractAsk } from "./askTag";
import { isStuck } from "./stuck";
import { allowBannerBody, bannerAllows } from "./bannerAnswer";

/** A chat's turn ended (item 753): what the Needs-you view keeps of it. */
export interface TurnEnded {
  chat: string | null;
  name: string;
  project: string | null;
  /** The turn's words, for the question it may have ended on. */
  text: string;
  failed: boolean;
  stopped: boolean;
}
/** Who hears of a turn's end (the Needs-you store registers itself; a set,
 *  so this file needs nothing of the app's state). */
export const turnEndListeners = new Set<(e: TurnEnded) => void>();

/** The words of a turn's segments, in order. */
export function turnText(segs: Segment[]): string {
  return segs
    .map((s) => (s.kind === "text" ? s.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

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
  return nameLine(title ?? firstUser ?? "") || "New chat";
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

/** What the phone's push says of a turn's end (item 739): paused by the
 *  plan's limit before failed, failed before finished. */
export function pushWhatForEnd(t: { error: string | null; cliError?: boolean; limit?: boolean; ask?: boolean }): api.PushWhat {
  // Item 753: a turn that ended on a question for him is a question, not a finish.
  return t.limit ? "limit" : t.error || t.cliError ? "failed" : t.ask ? "question" : "done";
}

/** What it says of a waiting call: a question form and a plan are answers
 *  he writes; the rest an Allow or a Deny. */
export function pushWhatForCall(req: Pick<ApprovalRequest, "name">): api.PushWhat {
  // Item 784: the runaway guard paused a run.
  if (isStuck(req.name)) return "stuck";
  return req.name === "AskUserQuestion" || req.name === "ExitPlanMode" ? "question" : "approval";
}

/** Hand the phone's push to the backend (item 739). Apart from the banner's
 *  two rules — the window's focus and the Settings switches are about the
 *  Mac's own banner; whether he is at the Mac is the backend's to judge. */
function pushToPhone(what: api.PushWhat, chat: string | null, label: string, project: string | null, detail: string | null = null): void {
  try {
    void api.pushNote(what, chat, label, project, detail).catch(() => {});
  } catch {
    // Outside the app (a test, a harness): nothing to tell.
  }
}

/** `<chat> — Run Bash?`; a question and a plan by what they are. */
export function needsYouTitle(chat: string, req: Pick<ApprovalRequest, "name">): string {
  const what =
    isStuck(req.name)
      ? "Looks stuck — Continue or Stop?"
      : req.name === "AskUserQuestion"
      ? "Claude asks a question"
      : req.name === "ExitPlanMode"
        ? "Approve the plan?"
        : `Run ${req.name}?`;
  return `${chat} — ${what}`;
}

/** `<the argument> · waits until you answer`. */
export function needsYouBody(req: Pick<ApprovalRequest, "name" | "input">): string {
  // Item 784: what it ran, and that it waits.
  if (isStuck(req.name)) {
    const r = (req as Pick<ApprovalRequest, "reason">).reason;
    return r ? `${r} · waits for Continue or Stop` : "waits for Continue or Stop";
  }
  const arg = req.name === "AskUserQuestion" || req.name === "ExitPlanMode" ? "" : toolInputSummary(req.input);
  return arg ? `${arg.slice(0, 100)} · waits until you answer` : "waits until you answer";
}

/** `<chat> — handoff written`: board 5c's third variant (backlog 079, built
 *  2026-09-25 with 193 per blocker 366, question 13). */
export function handoffWrittenTitle(chat: string): string {
  return `${chat} — handoff written`;
}

/** `72% · Continue with the next chat's prompt, or stay` — the window's fill, 0..1. */
export function handoffWrittenBody(fill: number): string {
  return `${Math.round(Math.min(Math.max(fill, 0), 1) * 100)}% · Continue with the next chat's prompt, or stay`;
}

/**
 * The two lines the turn-end banner carries. The wrap-up's own turn
 * (`handoffFill` set: the hand-off was `wrapping` in the chat the turn ran
 * in) ends as *handoff written* instead of *turn finished* — one banner,
 * not two; a failed wrap-up reads as any failed turn.
 */
export function turnEndBanner(args: {
  chat: string;
  segs: Segment[];
  outTokens: number | null;
  elapsedMs: number | null;
  error: string | null;
  handoffFill?: number | null;
}): [string, string] {
  if (args.handoffFill != null && args.error === null) {
    return [handoffWrittenTitle(args.chat), handoffWrittenBody(args.handoffFill)];
  }
  return [
    turnEndTitle(args.chat, args.error !== null),
    turnEndBody(args.segs, args.outTokens, args.elapsedMs, args.error),
  ];
}

/**
 * Post the turn-end banner, unless the window is in front or the switch is
 * off. Errors from the notification centre are swallowed: a banner that
 * could not be shown is not worth a toast in a window nobody is looking at.
 * The hand-off's *handoff written* rides the same switch: it is that
 * turn's end.
 */
export async function notifyTurnEnd(args: {
  chat: string;
  segs: Segment[];
  outTokens: number | null;
  elapsedMs: number | null;
  error: string | null;
  handoffFill?: number | null;
  prefs?: NotifyPrefs;
  /** Item 739: the chat the turn ran in, for the phone's push; absent
   *  (a caller that is not a chat's turn) and no push is sent. */
  phone?: { chat: string | null; project: string | null; limit: boolean; cliError: boolean; stopped?: boolean };
}): Promise<void> {
  // 739 review L5: a turn he stopped himself is not news to him (the away
  // server skips a cancelled turn the same way).
  const text = args.phone ? turnText(args.segs) : "";
  const failed = !!args.error || !!args.phone?.cliError;
  if (args.phone) {
    const ended: TurnEnded = { chat: args.phone.chat, name: args.chat, project: args.phone.project, text, failed, stopped: !!args.phone.stopped };
    for (const hear of turnEndListeners) {
      try {
        hear(ended);
      } catch {
        // A listener's trouble is not the turn's.
      }
    }
  }
  if (args.phone && !args.phone.stopped) pushToPhone(pushWhatForEnd({ error: args.error, cliError: args.phone.cliError, limit: args.phone.limit, ask: !failed && extractAsk(text) !== null }), args.phone.chat, args.chat, args.phone.project);
  const prefs = args.prefs ?? loadNotifyPrefs();
  if (!prefs.turnEnd || windowFocused()) return;
  try {
    const [title, body] = turnEndBanner(args);
    await api.notify(title, body);
  } catch {
    // See above.
  }
}

/**
 * Calls that arrived while the window was in front (nightshift backlog
 * 373): no banner then, but if he leaves while the call still waits — he
 * watched the question card land, then switched apps — it posts on the way
 * out. Keyed by the call's id; at most `HELD_MAX`, oldest dropped.
 */
const held = new Map<string, { chat: string; req: ApprovalRequest }>();
const HELD_MAX = 32;

/** Post the needs-you banner, on the same terms — except that a call the
 *  focused window received is held for `postHeldNeedsYou`. */
export async function notifyNeedsYou(chat: string, req: ApprovalRequest, prefs?: NotifyPrefs): Promise<void> {
  // Item 739: the phone hears of every waiting call (unless he is at the Mac).
  pushToPhone(pushWhatForCall(req), req.chat ?? null, chat, null, isStuck(req.name) ? (req.reason ?? null) : null);
  const p = prefs ?? loadNotifyPrefs();
  if (!p.needsYou) return;
  if (windowFocused()) {
    held.delete(req.id);
    held.set(req.id, { chat, req });
    if (held.size > HELD_MAX) held.delete(held.keys().next().value as string);
    return;
  }
  await postNeedsYou(chat, req);
}

/**
 * The banners posted for waiting calls (item 973), by the call's id: what a
 * press on one names when it says what it did. At most `HELD_MAX`.
 */
const posted = new Map<string, { chat: string; name: string }>();

/** The chat and the call a posted banner named, if it was posted here. */
export function postedBanner(id: string): { chat: string; name: string } | null {
  return posted.get(id) ?? null;
}

/**
 * The banner's two lines and its one button (item 973): a plain tool call
 * gets Allow when the banner shows the whole call (`bannerAllows`), else
 * Deny; a question, a plan or the guard no button. Close answers nothing.
 */
export function needsYouBanner(chat: string, req: ApprovalRequest): { title: string; body: string; buttons: boolean; allow: boolean } {
  const title = needsYouTitle(chat, req);
  if (pushWhatForCall(req) !== "approval" || req.aside !== undefined) return { title, body: needsYouBody(req), buttons: false, allow: false };
  const shown = bannerAllows(req);
  return shown !== null
    ? { title, body: allowBannerBody(shown), buttons: true, allow: true }
    : { title, body: needsYouBody(req), buttons: true, allow: false };
}

/** Post one waiting call's banner: with its buttons through
 *  `notify_approval`, else the plain one. Errors as above. */
async function postNeedsYou(chat: string, req: ApprovalRequest): Promise<void> {
  try {
    const b = needsYouBanner(chat, req);
    if (b.buttons) {
      posted.delete(req.id);
      posted.set(req.id, { chat, name: req.name });
      if (posted.size > HELD_MAX) posted.delete(posted.keys().next().value as string);
      await api.notifyApproval(req.id, b.title, b.body, b.allow);
    } else {
      await api.notify(b.title, b.body);
    }
  } catch {
    // See above.
  }
}

/** Item 783: an unanswered card's second push (2:30) and its set-aside
 *  (3:30), to the phone — whether he is at the Mac is the backend's to judge. */
export function notifyNudge(chat: string, n: { chat?: string; stage: "remind" | "set_aside" | "unattended" }): void {
  pushToPhone(n.stage === "remind" ? "reminder" : n.stage, n.chat ?? null, chat, null);
}

/**
 * The window just went behind (`away.svelte.ts`'s `onAway`): post the held
 * banner of each call that still waits — `stillWaiting` asks the state, so
 * a card answered while he looked posts nothing. The hold empties either way.
 */
export async function postHeldNeedsYou(stillWaiting: (id: string) => boolean, prefs?: NotifyPrefs): Promise<void> {
  const calls = [...held.values()];
  held.clear();
  const p = prefs ?? loadNotifyPrefs();
  if (!p.needsYou) return;
  for (const { chat, req } of calls) {
    if (!stillWaiting(req.id)) continue;
    await postNeedsYou(chat, req);
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
