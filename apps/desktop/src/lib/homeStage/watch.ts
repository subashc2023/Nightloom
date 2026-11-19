/**
 * Watch's source rows (item 845), pure: his connectors from the last reach check (item 804) and what macOS keeps
 * on this Mac (item 808), one row each, with what the row means now and what it shows when opened.
 */
import type { HomeReach, ReachAccount, ReachStatus } from "../home";
import type { HomeSource } from "../homeSources";

export interface SourceRow {
  id: string;
  name: string;
  icon: string;
  /** What it means now, a few words. */
  state: string;
  /** It needs him (sign in again, a permission he turned down). */
  hot: boolean;
  detail: [string, string][];
}
const KIND_ICON: Record<string, string> = { mail: "read", calendar: "updown", files: "note", other: "grep" };
const MAC_ICON: Record<string, string> = { messages: "chat", reminders: "checklist", calendar: "updown", contacts: "read" };

export function sourceRows(
  reach: HomeReach | null,
  mac: readonly HomeSource[] | null,
  name: (a: ReachAccount) => string,
  words: (s: ReachStatus) => string,
): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const a of reach?.accounts ?? []) {
    const state = !a.on ? "off for Home" : a.status !== "connected" ? words(a.status) : a.in_scan ? "connected · read by the scan" : "connected";
    rows.push({
      id: `c:${a.connector}`,
      name: name(a),
      icon: KIND_ICON[a.kind] ?? "grep",
      state,
      hot: a.on && a.status !== "connected",
      detail: [
        ["Service", a.service],
        ["Status", words(a.status)],
        ["For Home", a.on ? "On — Home may read it; it never writes through it" : "Off — turn it on in Settings → Home"],
        ["Morning scan", a.in_scan ? "Reads it" : "Does not read it"],
      ],
    });
  }
  for (const s of mac ?? []) {
    if (s.status === "not_on_this_mac") continue;
    const allowed = s.status === "allowed";
    rows.push({
      id: `m:${s.id}`,
      name: `${s.name} · this Mac`,
      icon: MAC_ICON[s.id] ?? "read",
      state: allowed ? (s.on ? "allowed · on" : "allowed · off for Home") : s.status === "denied" ? "not allowed" : s.status === "write_only" ? "add-only access" : "not asked yet",
      hot: s.status === "denied",
      detail: [["Now", s.why], ["Change it", "Settings → Home"]],
    });
  }
  return rows;
}
