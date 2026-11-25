/**
 * The phone's first screen, Home (nightshift item 763 H8; item 741's
 * screen): the header's words, the Needs-you rows, "Done since you
 * looked", the scan card's fold, the Jobs row and the screen's kept place
 * (scroll and folds). Pure apart from `loadHomeKept`/`saveHomeKept`, so
 * all of it is under `homeFirst.test.ts`.
 *
 * Item 945: Nightshift's held blockers are not Needs-you rows (he answers
 * those where he runs Nightshift): they are one folded line under the
 * list, not counted in the header, each still answerable when opened.
 *
 * Order (design §7, the default until he picks a layout — blocker 2084):
 * header, Needs you, today's scan, Done since you looked, Running, the
 * Tell Home box and the Jobs row, Home on this Mac.
 */
import type { HeldBlockerWire, HomeFeedRowWire, HomeScanWire, HomeTodayWire, PushFeedWire, RunningChat } from "./client";
import type { Job } from "./jobs";

// ---- the header ---------------------------------------------------------------

/** "0.3%" under ten, "12%" above; never "0%" for a little spend. */
export function percentWords(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  if (p < 0.1) return "under 0.1%";
  if (p < 10) return `${(Math.round(p * 10) / 10).toString()}%`;
  return `${Math.round(p)}%`;
}

/** "Home · 3 need you · today 0.3% of the week". With no `/home/today`
 *  the percent is left off; with nothing waiting, "nothing needs you". */
export function headerWords(needs: number, today: HomeTodayWire | null): string {
  const parts = ["Home", needs <= 0 ? "nothing needs you" : needs === 1 ? "1 needs you" : `${needs} need you`];
  if (today && Number.isFinite(today.points)) parts.push(`today ${percentWords(today.points)} of the week`);
  return parts.join(" · ");
}

/** The line under the header when Home's own runs are stopped. */
export function stopWords(today: HomeTodayWire | null): string | null {
  const why = today?.stop?.trim();
  return why ? `Home's own runs are paused: ${why}` : null;
}

/** "as of 11:40 PM" when the rows came from the away server because the
 *  Mac did not answer; null when they are the Mac's own (live). */
export function asOfWords(fromAway: boolean, asOf: number | null, clock: (ms: number) => string): string | null {
  if (!fromAway) return null;
  return asOf ? `The Mac is not answering · as of ${clock(asOf)}` : "The Mac is not answering · the away server's copy";
}

// ---- Needs you ----------------------------------------------------------------

export type NeedKind = "approval" | "question" | "stuck" | "job" | "blocker";

export interface NeedRow {
  /** Stable across reads, for the fold and the keyed list. */
  key: string;
  kind: NeedKind;
  /** The chat's (or job's, or blocker's project's) name. */
  title: string;
  /** One line in plain words. */
  line: string;
  chat: string | null;
  project: string | null;
  at: number | null;
  /** A job that wants changes (its approval card). */
  job?: Job;
  /** Item 812: the job's Run anyway card instead (its Run now was refused). */
  confirm?: boolean;
  /** A held blocker (its answer box). */
  blocker?: HeldBlockerWire;
}

const PUSH_NEED: Record<string, { kind: NeedKind; line: string }> = {
  approval: { kind: "approval", line: "Waiting for your approval" },
  reminder: { kind: "approval", line: "Still waiting for your approval" },
  set_aside: { kind: "approval", line: "Set aside — it asks again at the end" },
  unattended: { kind: "approval", line: "Needed you while you were away — set aside" },
  question: { kind: "question", line: "Has a question for you" },
  stuck: { kind: "stuck", line: "Looks stuck — Continue or Stop?" },
};

/** Every row that waits on him, newest chat first, then jobs, then held
 *  blockers. The open chat's own approvals (`pending`) count only when
 *  the feed has no row for that chat (one row per chat). */
export function needRows(
  feed: PushFeedWire[],
  jobs: Job[],
  held: HeldBlockerWire[],
  open: { chat: string | null; label: string | null; pending: number },
): NeedRow[] {
  const out: NeedRow[] = [];
  for (const r of [...feed].sort((a, b) => b.at - a.at)) {
    const n = PUSH_NEED[r.what];
    if (!n) continue;
    out.push({ key: `chat:${r.chat}`, kind: n.kind, title: r.label?.trim() || "A new chat", line: n.line, chat: r.chat, project: r.project ?? null, at: r.at });
  }
  if (open.chat && open.pending > 0 && !feed.some((r) => r.chat === open.chat)) {
    out.unshift({
      key: `chat:${open.chat}`,
      kind: "approval",
      title: open.label?.trim() || "The open chat",
      line: open.pending === 1 ? "Waiting for your approval" : `${open.pending} approvals waiting`,
      chat: open.chat,
      project: null,
      at: null,
    });
  }
  for (const j of jobs) {
    // Item 812: his Run now the spend guard refused asks Run anyway / Cancel.
    if (j.confirm) {
      out.push({ key: `run:${j.id}`, kind: "job", title: j.title, line: "Your Run now was stopped by Home's spend guard", chat: j.chat ?? null, project: j.project ?? null, at: Date.parse(j.confirm.at) || null, job: j, confirm: true });
    }
    if (!j.wanted) continue;
    out.push({ key: `job:${j.id}`, kind: "job", title: j.title, line: "Its read-only run wanted to make changes", chat: j.chat ?? null, project: j.project ?? null, at: Date.parse(j.wanted.at) || null, job: j });
  }
  for (const b of held) {
    out.push({ key: `blocker:${b.project}:${b.id}`, kind: "blocker", title: b.project_name, line: b.question, chat: null, project: null, at: null, blocker: b });
  }
  return out;
}

// ---- Done since you looked ------------------------------------------------------

/** Feed kinds that are "done" news, not something waiting. */
const DONE_KINDS = new Set(["done", "failed", "limit", "job_done", "job_failed", "scan", "hand_off", "changes"]);

/** The feed rows newer than his last look that are news, newest first. */
export function doneRows(rows: HomeFeedRowWire[], seenAt: string | null): HomeFeedRowWire[] {
  const seen = seenAt ? Date.parse(seenAt) : NaN;
  return rows
    .filter((r) => DONE_KINDS.has(r.kind) && (Number.isNaN(seen) || Date.parse(r.at) > seen))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A done row's mark, in words a screen reader says too. */
export function doneMark(kind: string): { mark: string; tone: "ok" | "bad" | "plain" } {
  if (kind === "failed" || kind === "job_failed") return { mark: "Failed", tone: "bad" };
  if (kind === "limit") return { mark: "Paused", tone: "bad" };
  if (kind === "scan") return { mark: "Scan", tone: "plain" };
  if (kind === "hand_off") return { mark: "Handed off", tone: "plain" };
  if (kind === "changes") return { mark: "Wants changes", tone: "plain" };
  return { mark: "Done", tone: "ok" };
}

// ---- the scan card ----------------------------------------------------------------

/** "ran 8:00 AM" today; "Yesterday's scan · ran 8:00 AM" for an older page. */
export function scanWhen(s: HomeScanWire, clock: (ms: number) => string): string {
  const ran = s.ran_at ? `ran ${clock(s.ran_at)}` : "";
  if (s.today) return s.skipped ? `skipped${ran ? ` · ${ran}` : ""}` : ran;
  return [`from ${s.date}`, ran].filter(Boolean).join(" · ");
}

/** At most `max` words of the page (the scan is ≤ 200 by its prompt; a
 *  longer one is cut and says so). */
export function scanText(text: string, max = 200): { text: string; cut: boolean } {
  const words = text.split(/(\s+)/);
  let n = 0;
  let out = "";
  for (const w of words) {
    if (/\S/.test(w)) n += 1;
    if (n > max) return { text: `${out.trimEnd()} …`, cut: true };
    out += w;
  }
  return { text, cut: false };
}

// ---- running ----------------------------------------------------------------------

/** "212k", "8.4k", "900" — the context in the Home list. */
export function tokensShort(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString()}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toString()}k`;
  return String(Math.round(n));
}

/** "4 min in · 212k context" for a running row; `context` from
 *  `Running.contexts`. */
export function runningLine(c: RunningChat, nowMs: number, context: number | null = null): string {
  const parts: string[] = [];
  if (c.since) {
    const min = Math.max(0, Math.floor((nowMs - c.since) / 60_000));
    parts.push(min === 0 ? "just started" : min < 60 ? `${min} min in` : `${Math.floor(min / 60)} h ${min % 60} min in`);
  }
  if (typeof context === "number" && context > 0) parts.push(`${tokensShort(context)} context`);
  if (c.waiting) parts.push(c.waiting === 1 ? "1 approval waiting" : `${c.waiting} approvals waiting`);
  return parts.join(" · ") || "running";
}

// ---- the Jobs row ------------------------------------------------------------------

/** "4 jobs · next Home — Morning scan at 8:00 AM"; "No jobs yet". */
export function jobsWords(jobs: Job[], clock: (ms: number) => string): string {
  const live = jobs.filter((j) => !j.paused);
  if (jobs.length === 0) return "No jobs yet";
  const next = [...live].sort((a, b) => Date.parse(a.next_run) - Date.parse(b.next_run))[0];
  const count = jobs.length === 1 ? "1 job" : `${jobs.length} jobs`;
  if (!next) return `${count} · all paused`;
  const at = Date.parse(next.next_run);
  return Number.isNaN(at) ? count : `${count} · next ${next.title} at ${clock(at)}`;
}

// ---- the place kept ----------------------------------------------------------------

export const HOME_KEPT_KEY = "nightloom.remote.home";

/** The sections he can fold. */
/** `held` (item 945): Nightshift's held blockers under Needs you — one line, folded unless he opens it. */
export type HomeSection = "needs" | "scan" | "done" | "running" | "sources" | "held";

export interface HomeKept {
  /** His scroll, in CSS pixels from the top. */
  scroll: number;
  /** Folds he set by hand; a section absent here takes its default. */
  folds: Partial<Record<HomeSection, boolean>>;
  /** The date of the scan page he has read (it folds after that). */
  scanRead: string | null;
  /** The scan date his hand-set fold on the scan card was for: a new day's
   *  page opens again even when he folded yesterday's. */
  scanFoldFor: string | null;
}

export function emptyHomeKept(): HomeKept {
  return { scroll: 0, folds: {}, scanRead: null, scanFoldFor: null };
}

const SECTIONS: HomeSection[] = ["needs", "scan", "done", "running", "sources", "held"];

/** A kept place read back, field by field. */
export function readHomeKept(v: unknown): HomeKept {
  const out = emptyHomeKept();
  if (!v || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (typeof o.scroll === "number" && Number.isFinite(o.scroll) && o.scroll >= 0) out.scroll = Math.round(o.scroll);
  if (o.folds && typeof o.folds === "object") {
    const f = o.folds as Record<string, unknown>;
    for (const s of SECTIONS) if (typeof f[s] === "boolean") out.folds[s] = f[s] as boolean;
  }
  if (typeof o.scanRead === "string" && o.scanRead) out.scanRead = o.scanRead;
  if (typeof o.scanFoldFor === "string" && o.scanFoldFor) out.scanFoldFor = o.scanFoldFor;
  return out;
}

/** Whether `section` shows folded. The scan card folds once its page has
 *  been read; a fold he set on it holds for that page only. Everything
 *  else is open unless he folded it. */
export function isFolded(k: HomeKept, section: HomeSection, scanDate: string | null): boolean {
  if (section === "scan") {
    if (k.folds.scan !== undefined && k.scanFoldFor === scanDate) return k.folds.scan;
    return scanDate !== null && k.scanRead === scanDate;
  }
  return k.folds[section] ?? section === "held";
}

/** Item 945: the folded line's words — "Nightshift · 3 held blockers". */
export function heldWords(n: number): string {
  return `Nightshift · ${n === 1 ? "1 held blocker" : `${n} held blockers`}`;
}

/** His tap on a section's head. */
export function toggleFold(k: HomeKept, section: HomeSection, scanDate: string | null): HomeKept {
  const now = isFolded(k, section, scanDate);
  const folds = { ...k.folds, [section]: !now };
  return section === "scan" ? { ...k, folds, scanFoldFor: scanDate } : { ...k, folds };
}

/** Set `section` folded or open by his hand (the scan's for this page). */
export function setFold(k: HomeKept, section: HomeSection, value: boolean, scanDate: string | null): HomeKept {
  const folds = { ...k.folds, [section]: value };
  return section === "scan" ? { ...k, folds, scanFoldFor: scanDate } : { ...k, folds };
}

/** The scan page shown open: read, so the next visit shows it folded. */
export function markScanRead(k: HomeKept, scanDate: string | null): HomeKept {
  return scanDate && k.scanRead !== scanDate ? { ...k, scanRead: scanDate } : k;
}

export function withScroll(k: HomeKept, scroll: number): HomeKept {
  const s = Math.max(0, Math.round(scroll));
  return s === k.scroll ? k : { ...k, scroll: s };
}

export function loadHomeKept(store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): HomeKept {
  try {
    const raw = store?.getItem(HOME_KEPT_KEY);
    return raw ? readHomeKept(JSON.parse(raw)) : emptyHomeKept();
  } catch {
    return emptyHomeKept();
  }
}

export function saveHomeKept(k: HomeKept, store: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    store?.setItem(HOME_KEPT_KEY, JSON.stringify(k));
  } catch {
    // Storage off: the place lives for this page load.
  }
}

// ---- Tell Home -----------------------------------------------------------------------

/** Where the Tell Home box sends: today's Home chat when the host names
 *  one, else a new chat in Home's project; null when neither is known. */
export function homeTarget(home: { project: string | null; chat: string | null } | null): { chat: string } | { project: string } | null {
  if (home?.chat) return { chat: home.chat };
  if (home?.project) return { project: home.project };
  return null;
}

/** The Tell Home box's draft key: the Home chat's own composer key, so a
 *  draft typed on Home is the one its chat shows (and back). */
export function homeDraftKey(home: { project: string | null; chat: string | null } | null): string {
  if (home?.chat) return home.chat;
  return `new:${home?.project ?? "home"}`;
}
