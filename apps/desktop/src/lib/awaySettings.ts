/**
 * Settings → "Away server" (nightshift item 268 step 3) and the Remote
 * card's "Test from this Mac" (backlog 154's Mac half): the commands the
 * cards call, and the pure helpers that turn their answers into the lines
 * he reads. The sync itself is Rust (`away.rs`, `nightloom_service::sync`);
 * the token never reaches this side — only whether it was found.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AwayProject {
  id: string;
  name: string;
  available: boolean;
}

export interface AwayStatus {
  /** Empty = sync off. */
  url: string;
  /** Whether ~/.nightloom/remote/away-token holds a token. Never its value. */
  token_found: boolean;
  token_path: string;
  running: boolean;
  /** RFC 3339, or null when it never ran. */
  last_push: string | null;
  last_pull: string | null;
  last_error: string | null;
  last_summary: string | null;
  interval_minutes: number;
  projects: AwayProject[];
}

export interface SelfTest {
  ok: boolean;
  ms: number | null;
  message: string;
}

export function awayStatus(): Promise<AwayStatus> {
  return invoke("away_status");
}
export function awaySetUrl(url: string): Promise<AwayStatus> {
  return invoke("away_set_url", { url });
}
export function awaySyncNow(): Promise<AwayStatus> {
  return invoke("away_sync_now");
}
export function awaySetProject(id: string, on: boolean): Promise<AwayStatus> {
  return invoke("away_set_project", { id, on });
}
export function remoteSelfTest(): Promise<SelfTest> {
  return invoke("remote_self_test");
}

/**
 * A time in 12-hour form with AM/PM, as he reads every time ("2:58 PM";
 * "Sep 29, 11:04 PM" when it is not today). `null` is "never".
 */
export function clock12(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "never";
  let h = t.getHours();
  const m = t.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const time = `${h}:${String(m).padStart(2, "0")} ${ampm}`;
  const sameDay =
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  if (sameDay) return time;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[t.getMonth()]} ${t.getDate()}, ${time}`;
}

/** The card's one-line state: off, missing a token, failing, or working. */
export function awayHeadline(s: AwayStatus | null): string {
  if (!s) return "…";
  if (!s.url.trim()) return "off — paste the away server's address to start";
  if (!s.token_found) return "no token — the sync waits for it";
  if (s.running) return "syncing now…";
  if (s.last_error) return "the last sync failed";
  if (!s.last_push) return "not synced yet";
  return `synced at ${clock12(s.last_push)}`;
}

/** The token line: found or not, never the value. */
export function tokenLine(s: AwayStatus | null): string {
  if (!s) return "";
  return s.token_found ? `token found (${s.token_path})` : `no token at ${s.token_path}`;
}

/** Whether `url` is one the Rust side takes: empty (off) or http(s)://… */
export function urlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (!/^https?:\/\/[^\s/]+/.test(u)) return "the address must start with https://";
  return null;
}

/** How many projects are marked, as the card's sub-heading says it. */
export function markedLine(projects: AwayProject[]): string {
  const n = projects.filter((p) => p.available).length;
  if (n === 0) return "No project is available away; only memory and the vault go up.";
  return `${n} of ${projects.length} project${projects.length === 1 ? "" : "s"} available away.`;
}

/**
 * The projects in the card's order: marked first, then by name — so the
 * ones that go up are at the top of a long list. `filter` narrows by name.
 */
export function orderedProjects(projects: AwayProject[], filter = ""): AwayProject[] {
  const f = filter.trim().toLowerCase();
  return projects
    .filter((p) => !f || p.name.toLowerCase().includes(f))
    .slice()
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

/** The self-test's line for the Remote card. */
export function selfTestLine(t: SelfTest | null): string {
  if (!t) return "";
  return t.ok && t.ms != null ? `Answers in ${t.ms} ms.` : `Does not answer: ${t.message}`;
}
