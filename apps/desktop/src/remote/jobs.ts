/**
 * Recurring jobs on the phone (nightshift item 746): the pure half — the
 * wire's shapes, reading "repeat every …" out of a typed or dictated
 * message, and the list's words. The schedule itself is parsed by the
 * host (`crates/nightloom-service/src/jobs`): the page sends his words.
 */

export interface JobLast {
  started: string;
  ended: string;
  outcome: "done" | "failed" | "unfinished";
  summary: string;
  week_points: number | null;
  week_after: number | null;
}

export interface Job {
  id: string;
  title: string;
  text: string;
  every_words: string;
  read_only: boolean;
  project: string | null;
  chat: string | null;
  paused: boolean;
  next_run: string;
  running: { started: string } | null;
  last: JobLast | null;
  week: { points: number; runs: number };
  note: string | null;
  runs: number;
  /** Item 780: the zone its times are read on (null: a job saved before zones were kept). */
  tz?: string | null;
  offset_min?: number;
  /** "ask" (read-only), "once" (the next run may make changes), "always". */
  approval?: Approval;
  /** The last read-only run was stopped from making changes: the card asks. */
  wanted?: { at: string; what: string[] } | null;
  run_now?: boolean;
}

export type Approval = "ask" | "once" | "always";
/** An answer on the approval card. */
export type Answer = "once" | "always" | "keep";

export interface JobsReply {
  jobs: Job[];
  now: string;
}

export interface NewJob {
  every: string;
  text: string;
  title?: string;
  project?: string | null;
  from_chat?: string | null;
  offset_min: number;
  tz?: string | null;
}

export interface JobPatch {
  paused?: boolean;
  every?: string;
  text?: string;
  title?: string;
  approve_plan?: boolean;
  approve?: Approval;
  dismiss_wanted?: boolean;
  tz?: string;
}

/** What the sheet needs of the client. */
export interface JobsApi {
  jobs(): Promise<JobsReply>;
  jobNew(req: NewJob): Promise<Job>;
  jobPatch(id: string, patch: JobPatch): Promise<Job>;
  jobRun(id: string): Promise<Job>;
  jobDelete(id: string): Promise<void>;
}

// ---- item 780: approve once / always, and real time zones ----

/** The phone's IANA zone ("America/Los_Angeles"), when it names one. */
export function phoneTz(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "America/Los_Angeles" → "Los Angeles"; "UTC" stays. */
export function zoneWords(tz: string): string {
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

/** The schedule line: his words, plus whose clock when the phone is in another zone. */
export function everyText(j: Job, here: string | null = phoneTz()): string {
  return j.tz && here && j.tz !== here ? `${j.every_words}, ${zoneWords(j.tz)} time` : j.every_words;
}

function approvalOf(j: Job): Approval {
  return j.approval ?? (j.read_only ? "ask" : "always");
}

/** The job's badge: what its next runs may do. */
export function approvalBadge(j: Job): string {
  const a = approvalOf(j);
  return a === "always" ? "Always may make changes" : a === "once" ? "Next run may make changes" : "Read-only";
}

/** "run commands", "run commands and edit files", "a, b and c". */
function list(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "make changes";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The card's words: what it wanted and was stopped from, or what approving allows. */
export function approvalAsk(j: Job, where = "its project"): { title: string; body: string } {
  if (j.wanted) {
    return {
      title: "This job wants to make changes",
      body: `Its last run tried to ${list(j.wanted.what)} and was stopped, because it is read-only. Approving runs it again now.`,
    };
  }
  return {
    title: "Let this job make changes?",
    body: `It may edit files and run commands in ${where} while you are away, doing what its message says.`,
  };
}

/** The patch an answer on the card sends. */
export function answerPatch(how: Answer): JobPatch {
  return how === "keep" ? { dismiss_wanted: true } : { approve: how };
}

/** The schedules offered as taps; anything else is typed. */
export const EVERY_PRESETS = ["every hour", "every morning", "every evening", "every weekday at 9am", "every Monday at 9am"] as const;

/** The phone's clock, minutes east of UTC — the job runs "8:00 AM" on it. */
export function offsetMin(now = new Date()): number {
  return -now.getTimezoneOffset();
}

/**
 * "repeat every morning: check CI and tell me what failed" → the schedule
 * words and the message. The schedule ends at the first `:` (not one
 * inside a time, "9:30"), or else at a comma or dash after it; null when
 * the text does not start with "repeat every/each" or names no message.
 */
export function parseRepeat(text: string): { every: string; text: string } | null {
  const m = /^\s*repeat\s+((?:every|each)\b[\s\S]*)$/i.exec(text);
  if (!m) return null;
  const rest = m[1];
  const cut = /:(?!\d\d)\s*|\s+[—–-]\s+|,\s+(?!and\b)(?![a-z]{3,9}(?:day)?s?\b(?:,|\s+and\b|\s+at\b))/i.exec(rest);
  if (!cut) return null;
  const every = rest.slice(0, cut.index).trim();
  const body = rest.slice(cut.index + cut[0].length).trim();
  return every && body ? { every, text: body } : null;
}

/** 12-hour clock: "8:00 AM". */
function clock(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** "today 8:00 AM", "tomorrow 8:00 AM", "Mon 9:00 AM", "Nov 30, 9:00 AM". */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86400000);
  if (days === 0) return `today ${clock(d)}`;
  if (days === 1) return `tomorrow ${clock(d)}`;
  if (days === -1) return `yesterday ${clock(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock(d)}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clock(d)}`;
}

/** The row's "next" line. */
export function nextText(j: Job, now = new Date()): string {
  if (j.running) return "Running now";
  if (j.paused) return "Paused";
  if (j.note) return j.note.replace(/^waiting/, "Waiting");
  if (new Date(j.next_run).getTime() <= now.getTime()) return "Next run: due now";
  return `Next run: ${whenText(j.next_run, now)}`;
}

/** A run's cost of the weekly limit, as the plan's whole percents allow. */
export function costText(points: number | null): string {
  if (points == null) return "cost not read";
  return points === 0 ? "under 1% of the week" : `${points}% of the week`;
}

/** The row's "last" line: when, how it ended, what it cost. */
export function lastText(j: Job, now = new Date()): string {
  const l = j.last;
  if (!l) return "Has not run yet";
  const how = l.outcome === "done" ? "finished" : l.outcome === "failed" ? "failed" : "did not finish";
  return `Last run ${whenText(l.ended, now)} — ${how} · ${costText(l.week_points)}`;
}

/** What it has cost since the weekly window last reset. */
export function weekText(j: Job): string {
  if (j.week.runs === 0) return "";
  const runs = `${j.week.runs} run${j.week.runs === 1 ? "" : "s"}`;
  return j.week.points === 0 ? `This week: ${runs}, under 1% each` : `This week: ${runs}, ${j.week.points}% of the weekly limit`;
}

// ---- the new-job form's draft: kept until Save or Discard ----

const DRAFT_KEY = "nightloom.jobs.draft";

export interface JobDraft {
  every: string;
  text: string;
  title: string;
}

export function readJobDraft(store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): JobDraft | null {
  try {
    const d = JSON.parse(store?.getItem(DRAFT_KEY) ?? "null") as Partial<JobDraft> | null;
    if (!d || (!d.every && !d.text && !d.title)) return null;
    return { every: d.every ?? "", text: d.text ?? "", title: d.title ?? "" };
  } catch {
    return null;
  }
}

export function writeJobDraft(d: JobDraft | null, store: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    if (!d || (!d.every && !d.text && !d.title)) store?.removeItem(DRAFT_KEY);
    else store?.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // Private mode: the draft lives for this page only.
  }
}
