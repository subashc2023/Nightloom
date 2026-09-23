/**
 * The notification centre and the daily pass (nightshift backlog 069), as
 * data: the daily switch's preference and its "is it due" rule, and the
 * notices — five kinds, every one *derived* from something the app already
 * reads (the proposal stores, the dream's commits, the Nightshift rows,
 * the build stamp) and filtered by a dismissed set that is the only thing
 * stored. `state.svelte.ts` reads and writes the preferences and runs the
 * pass; `NotificationCentre.svelte` draws the list. Nothing here touches
 * the store, so every rule below is pinned by `centre.test.ts`.
 */
import type { BuildStamp, CliStatus, DreamCommit, NightshiftRow, ProjectRef, ProposalNotice } from "./types";
import { cliNoticeDetail, cliNoticeId, cliNoticeTitle, offersUpdate } from "./cliUpdate";

// ---- the daily switch ----

export const DAILY_KEY = "nightloom.daily";
export const DAILY_LAST_KEY = "nightloom.daily.last";
export const DISMISSED_KEY = "nightloom.centre.dismissed";
export const BUILD_KEY = "nightloom.centre.build";

export interface DailyPrefs {
  /** Capture and dream once a day. Off until he says otherwise: the pass
   *  runs unattended and bills whatever engine runs it. */
  on: boolean;
  /** The hour, 0–23, local time. */
  hour: number;
  /** A macOS banner when the bell gains something. Off by default (the
   *  item's plan; blocker 106 keeps the plugin). */
  notifyMac: boolean;
}

export const DEFAULT_HOUR = 4;

export function parseDailyPrefs(raw: string | null): DailyPrefs {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<DailyPrefs>;
      const hour = typeof p.hour === "number" && p.hour >= 0 && p.hour <= 23 ? Math.floor(p.hour) : DEFAULT_HOUR;
      return { on: !!p.on, hour, notifyMac: !!p.notifyMac };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { on: false, hour: DEFAULT_HOUR, notifyMac: false };
}

export function loadDailyPrefs(): DailyPrefs {
  try {
    return parseDailyPrefs(localStorage.getItem(DAILY_KEY));
  } catch {
    return parseDailyPrefs(null);
  }
}

export function saveDailyPrefs(p: DailyPrefs): void {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(p));
  } catch {
    // best-effort
  }
}

/** When the last daily pass started, ms since the epoch, or null. */
export function loadLastDaily(): number | null {
  try {
    const raw = localStorage.getItem(DAILY_LAST_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function saveLastDaily(ms: number): void {
  try {
    localStorage.setItem(DAILY_LAST_KEY, String(ms));
  } catch {
    // best-effort
  }
}

/** Today's firing time — `hour` o'clock local — for the day `now` is in. */
export function fireTimeOf(hour: number, now: Date): Date {
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  return t;
}

/**
 * Whether the daily pass is due: the switch is on, the day's hour has come,
 * and no pass has run since that hour. One rule serves every trigger — the
 * minute clock while the app is open fires at the hour; a launch or a wake
 * after the hour fires at once, which is how a pass missed while the app
 * was closed or the Mac asleep happens on the next launch rather than
 * never; and an app opened before the hour waits for it, so "every day at
 * 4" means 4, not "whenever". A pass that ran two days ago counts as
 * before today's hour, so it is due the moment the hour is reached.
 */
export function dailyDue(prefs: DailyPrefs, lastMs: number | null, now: Date): boolean {
  if (!prefs.on) return false;
  const fire = fireTimeOf(prefs.hour, now).getTime();
  if (now.getTime() < fire) return false;
  if (lastMs == null) return true;
  // A pass within the last `RECENT_PASS_MS` is today's — a *Run now* at
  // 03:50 with the hour at 04:00 used to be followed by a second full
  // pass ten minutes later (backlog 133, review B's FB9).
  if (now.getTime() - lastMs < RECENT_PASS_MS) return false;
  return lastMs < fire;
}

/** How recent a pass must be to count as today's whatever the hour. */
export const RECENT_PASS_MS = 12 * 60 * 60 * 1000;

// ---- the notices ----

export type NoticeKind = "proposal" | "dream" | "morning" | "blocker" | "release" | "cli";

/** One row of the panel. `id` is stable for as long as the thing it names
 *  is unchanged, which is what "dismissed" is keyed on. */
export interface Notice {
  kind: NoticeKind;
  id: string;
  title: string;
  detail: string;
  /** RFC 3339 when the source carries one. */
  at: string | null;
  project: ProjectRef | null;
  /** The proposal, for a `proposal` notice. */
  proposal?: ProposalNotice;
  /** The commit, for a `dream` notice. */
  commit?: DreamCommit;
  /** The version check, for a `cli` notice (nightshift backlog 182). */
  cli?: CliStatus;
}

export const KIND_LABEL: Record<NoticeKind, string> = {
  proposal: "Proposals",
  dream: "Notes changed by a dream",
  morning: "Morning pages",
  blocker: "Blockers",
  release: "Releases",
  cli: "Claude Code",
};

export const KIND_ORDER: NoticeKind[] = ["proposal", "dream", "morning", "blocker", "release", "cli"];

export interface NoticeSources {
  proposals: ProposalNotice[];
  commits: DreamCommit[];
  /** Every registered project's row; those without a contract contribute nothing. */
  rows: NightshiftRow[];
  /** Morning pages opened, by project id (the Nightshift `read` map). */
  read: Record<string, string[]>;
  stamp: BuildStamp | null;
  /** The stamp last seen by this window, or null on a first run. */
  seenStamp: string | null;
  dismissed: string[];
  /** The newest Claude Code version check (backlog 182); a notice while it
   *  offers an update. */
  cli?: CliStatus | null;
  /** The Anthropic ids the provider engine's picker lists, for naming a
   *  new model it lacks. */
  curated?: string[];
}

export function proposalNoticeId(p: ProposalNotice): string {
  return `proposal:${p.project?.id ?? "user"}:${p.entry.id}`;
}

/**
 * Build the panel's list from its sources, newest first within a kind and
 * the kinds in `KIND_ORDER`. A dismissed id is left out; a blocker notice's
 * id carries the open count, so a dismissed "3 open" comes back as "4 open"
 * when one more is raised, and a morning page's id its file name, so a new
 * page is a new notice. The release notice exists only when a stamp is
 * known and differs from the one seen — a first run seen nothing and says
 * nothing.
 */
export function buildNotices(s: NoticeSources): Notice[] {
  const dismissed = new Set(s.dismissed);
  const out: Notice[] = [];
  for (const p of s.proposals) {
    const who = p.project ? `${p.project.name}'s instructions` : "your memory";
    out.push({
      kind: "proposal",
      id: proposalNoticeId(p),
      title: `A change to ${who}`,
      detail: p.entry.proposal.why,
      at: p.entry.proposal.at,
      project: p.project,
      proposal: p,
    });
  }
  for (const c of s.commits) {
    const where = c.project ? `${c.project.name}'s memory` : "the vault";
    const n = c.files.length;
    out.push({
      kind: "dream",
      id: `dream:${c.hash}`,
      title: `A dream changed ${n} note${n === 1 ? "" : "s"} in ${where}`,
      detail: c.files.map((f) => f.path).join(", "),
      at: c.at,
      project: c.project,
      commit: c,
    });
  }
  for (const r of s.rows) {
    const info = r.nightshift;
    if (!info) continue;
    const ref = { id: r.id, name: r.name };
    if (info.newest_morning && !(s.read[r.id] ?? []).includes(info.newest_morning)) {
      out.push({
        kind: "morning",
        id: `morning:${r.id}:${info.newest_morning}`,
        title: `A morning page to read in ${r.name}`,
        detail: info.newest_morning,
        at: null,
        project: ref,
      });
    }
    if (info.open_blockers > 0) {
      out.push({
        kind: "blocker",
        id: `blocker:${r.id}:${info.open_blockers}`,
        title: `${info.open_blockers} blocker${info.open_blockers === 1 ? "" : "s"} open in ${r.name}`,
        detail: "Nightshift is waiting on an answer",
        at: null,
        project: ref,
      });
    }
  }
  if (s.stamp?.exe_modified && s.seenStamp && s.stamp.exe_modified !== s.seenStamp) {
    out.push({
      kind: "release",
      id: `release:${s.stamp.exe_modified}`,
      title: `A release was installed (${s.stamp.version})`,
      detail: `built ${s.stamp.exe_modified.slice(0, 16).replace("T", " ")}`,
      at: s.stamp.exe_modified,
      project: null,
    });
  }
  if (s.cli && offersUpdate(s.cli)) {
    out.push({
      kind: "cli",
      id: cliNoticeId(s.cli),
      title: cliNoticeTitle(s.cli),
      detail: cliNoticeDetail(s.cli, s.curated ?? []),
      at: s.cli.checked_at,
      project: null,
      cli: s.cli,
    });
  }
  const rank = new Map(KIND_ORDER.map((k, i) => [k, i]));
  return out
    .filter((n) => !dismissed.has(n.id))
    .sort((a, b) => (rank.get(a.kind) ?? 9) - (rank.get(b.kind) ?? 9) || (b.at ?? "").localeCompare(a.at ?? ""));
}

/** How many of each kind, for the panel's headings and the bell's count. */
export function countsOf(notices: Notice[]): Record<NoticeKind, number> {
  const c: Record<NoticeKind, number> = { proposal: 0, dream: 0, morning: 0, blocker: 0, release: 0, cli: 0 };
  for (const n of notices) c[n.kind]++;
  return c;
}

export function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Keep the set from growing without bound: a dismissed id for a thing that
 *  no longer exists (a proposal applied, a page read) is dropped once the
 *  list is over `cap` — the newest kept, since the ids are appended in order. */
export function saveDismissed(ids: string[], cap = 500): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-cap)));
  } catch {
    // best-effort
  }
}

export function loadSeenStamp(): string | null {
  try {
    return localStorage.getItem(BUILD_KEY);
  } catch {
    return null;
  }
}

export function saveSeenStamp(stamp: string): void {
  try {
    localStorage.setItem(BUILD_KEY, stamp);
  } catch {
    // best-effort
  }
}
