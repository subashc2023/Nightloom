/**
 * Recurring jobs on the phone (nightshift item 746): the pure half — the
 * wire's shapes, reading "repeat every …" out of a typed or dictated
 * message, and the list's words. The schedule itself is parsed by the
 * host (`crates/nightloom-service/src/jobs`): the page sends his words.
 */

export interface JobLast {
  started: string;
  ended: string;
  /** "skipped": Home's spend guard did not start it (item 763 H6); the summary says why. */
  outcome: "done" | "failed" | "unfinished" | "stopped" | "skipped";
  summary: string;
  week_points: number | null;
  week_after: number | null;
  /** Tool calls the run made (item 784). */
  calls?: number | null;
  /** Item 812: he pressed Run anyway past Home's spend guard. */
  forced?: boolean;
  five_points?: number | null;
  /** Item 951: the plan reading the guard used; `source: "none"` is no reading at all. */
  reading?: { source: string } | null;
}

/** Item 812: his Run now that Home's spend guard refused — the Run anyway card. */
export interface RunConfirm {
  at: string;
  /** The guard's reason, in his words. */
  why: string;
  /** Mean percent of the week of its last runs; null: no estimate yet. */
  est_week: number | null;
  est_five: number | null;
  est_runs: number;
  five_hour: number | null;
  week: number | null;
  /** The usage reading was old or missing at the press. */
  stale: boolean;
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
  /** Item 812: the spend guard refused his Run now; the card asks. */
  confirm?: RunConfirm | null;
  /** Item 812: Run anyway pressed; its run has not started yet. */
  force_once?: boolean;
  /** Item 794: a research watch — each run appends what changed to `watch.note`. */
  watch?: Watch | null;
}

/** Item 794: what a research watch keeps current. */
export interface Watch {
  topic: string;
  /** Pages he named, checked every run. */
  sources: string[];
  /** The note's file name in the project's notes (`watch-<slug>.md`), set by the host. */
  note: string;
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
  /** Item 794: a research watch's topic and pages. */
  watch?: { topic: string; sources: string[] } | null;
}

export interface JobPatch {
  paused?: boolean;
  every?: string;
  text?: string;
  title?: string;
  approve_plan?: boolean;
  approve?: Approval;
  dismiss_wanted?: boolean;
  /** Item 812: Run anyway on the spend guard's card. */
  run_anyway?: boolean;
  /** Item 812: Cancel on that card. */
  dismiss_confirm?: boolean;
  tz?: string;
  /** Item 794: a watch's new topic and pages. */
  watch?: { topic: string; sources: string[] };
}

/** What the sheet needs of the client. */
export interface JobsApi {
  jobs(): Promise<JobsReply>;
  /** Item 763 H6: Home's spend today; `null` from a host without it. */
  homeToday?(): Promise<{ points: number; cap: number; stop: string | null } | null>;
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

// ---- item 812: Run now past Home's spend guard ----

/** "~2%", "~0.5%", "under 1%" for a mean under half a percent. */
function about(p: number): string {
  if (p < 0.5) return "under 1%";
  const r = Math.round(p * 10) / 10;
  return `~${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}%`;
}

/** The guard's reason as the card's last line: "Stopped because the weekly window is at 91%." (a name keeps its capital). */
function reasonLine(why: string): string {
  const w = /^Home\b/.test(why) ? why : `${why.charAt(0).toLowerCase()}${why.slice(1)}`;
  return `Stopped because ${w}.`;
}

/** The Run anyway card's words (same shape as the approval card's): title, the estimate and where he is, the guard's reason. */
export function confirmAsk(j: Job): { title: string; body: string; reason: string } | null {
  const c = j.confirm;
  if (!c) return null;
  const pct = (n: number | null) => (n == null ? "?" : `${n}%`);
  const at = c.stale || (c.five_hour == null && c.week == null) ? "your usage reading is out of date" : `you're at ${pct(c.five_hour)} / ${pct(c.week)}`;
  let est: string;
  if (c.est_week == null) est = "No estimate yet — first run";
  else if (c.est_five == null) est = `Home estimates ${about(c.est_week)} of the week`;
  else est = `Home estimates ${about(c.est_five)} of your 5h window (${about(c.est_week)} of the week)`;
  return { title: `Run ${j.title} anyway?`, body: `${est}; ${at}.`, reason: reasonLine(c.why) };
}

/** The patch each button on the Run anyway card sends. */
export function confirmPatch(run: boolean): JobPatch {
  return run ? { run_anyway: true } : { dismiss_confirm: true };
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
  // Item 784: "stopped" is his Stop on a run that looked stuck.
  // Item 763 H6: a run the spend guard did not start says why, no cost.
  if (l.outcome === "skipped") return `Skipped ${whenText(l.ended, now)} — ${l.summary.replace(/^skipped — /, "")}`;
  const how =
    l.outcome === "done" ? "finished" : l.outcome === "failed" ? "failed" : l.outcome === "stopped" ? "stopped, looked stuck" : "did not finish";
  // Item 812: a run he forced past the spend guard says so.
  // Item 947: a run that started with no usage reading says its 80% stop was not checked (the row's note went with the run).
  const unread = l.reading?.source === "none" ? " · usage not read, 80% stop not checked" : "";
  return `Last run ${whenText(l.ended, now)} — ${how}${l.forced ? " (run anyway)" : ""} · ${costText(l.week_points)}${unread}`;
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
  /** Item 794: the form was making a research watch: its topic and pages (one per line). */
  watch?: { topic: string; sources: string } | null;
}

function emptyDraft(d: Partial<JobDraft>): boolean {
  return !d.every && !d.text && !d.title && !d.watch;
}

export function readJobDraft(store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): JobDraft | null {
  try {
    const d = JSON.parse(store?.getItem(DRAFT_KEY) ?? "null") as Partial<JobDraft> | null;
    if (!d || emptyDraft(d)) return null;
    const w = d.watch && typeof d.watch === "object" ? { topic: String(d.watch.topic ?? ""), sources: String(d.watch.sources ?? "") } : null;
    return { every: d.every ?? "", text: d.text ?? "", title: d.title ?? "", ...(w ? { watch: w } : {}) };
  } catch {
    return null;
  }
}

export function writeJobDraft(d: JobDraft | null, store: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    if (!d || emptyDraft(d)) store?.removeItem(DRAFT_KEY);
    else store?.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // Private mode: the draft lives for this page only.
  }
}

/** Item 763 H6: the Jobs list's Home line — "Home today: 0.3% of the week
 *  of its 1% a day", and why its runs are paused when they are. */
export function homeTodayText(t: { points: number; cap: number; stop: string | null } | null): string {
  if (!t) return "";
  const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
  const line = `Home today: ${pct(t.points)} of the week, of its ${pct(t.cap)} a day`;
  return t.stop ? `${line} · paused: ${t.stop}` : line;
}

// ---- item 794: research watch ----

/** What "keep this current: …" read from the composer gives the form. */
export interface WatchPrefill {
  topic: string;
  sources: string[];
}

/** The schedules a watch is offered: daily or weekly (anything else is typed). */
export const WATCH_PRESETS = ["every morning", "every Monday at 9am"] as const;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** The links in `text`, trailing punctuation off, each once. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    const u = m.replace(/[.,;:]+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * "keep this current: sparse autoencoders, and https://x.org" → the topic
 * and the pages he named; null when the text does not start with "keep
 * this current", "keep it current", "keep current" or "keep me current on".
 */
export function parseWatch(text: string): WatchPrefill | null {
  const m = /^\s*keep\s+(?:(?:this|it)\s+)?current\s*(?::|on\b|about\b|[—–-])\s*([\s\S]+)$/i.exec(text) ?? /^\s*keep\s+me\s+(?:current|posted|updated)\s+(?:on|about)\s*:?\s*([\s\S]+)$/i.exec(text);
  if (!m) return null;
  const sources = linksIn(m[1]);
  let topic = m[1];
  for (const u of sources) topic = topic.split(u).join(" ");
  const edge = /^[\s,.:;—–-]+|[\s,.:;—–-]+$/g;
  topic = topic.replace(/\s+/g, " ").replace(edge, "");
  topic = topic.replace(/[\s,]+(?:and|plus|also|check|see)$/i, "").replace(edge, "").trim();
  return topic ? { topic, sources } : null;
}

/** The proposal the form opens with — instructions, schedule and name — all editable before Save. */
export function proposeWatch(p: WatchPrefill): { every: string; text: string; title: string; sources: string } {
  return {
    every: "every morning",
    text:
      `Keep my research note on “${p.topic}” current. Check the literature, the pages listed and the news for anything new ` +
      `since the note's last entry — new papers, results, releases, corrections — and record only what is new, ` +
      `each claim with the page you opened for it.`,
    title: "",
    sources: p.sources.join("\n"),
  };
}

/** The pages box's lines, blank ones off. */
export function sourceLines(box: string): string[] {
  return box
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The row's watch line: the note it keeps, and how many pages beside the literature. */
export function watchLine(j: Job): string {
  const w = j.watch;
  if (!w) return "";
  const pages = w.sources.length === 0 ? "the literature and news" : `the literature, news and ${w.sources.length} page${w.sources.length === 1 ? "" : "s"}`;
  return `Keeps ${w.note} current · checks ${pages}`;
}
