/**
 * Watch's source rows (item 845), pure: his connectors from the last reach check (item 804) and what macOS keeps
 * on this Mac (item 808), one row each, with what the row means now and what it shows when opened.
 */
import type { HomeReach, ReachAccount, ReachStatus } from "../home";
import type { HomeSource } from "../homeSources";
import type { IconName } from "../icons";
import { connectorLook, macLook } from "./sourceLook";

/** Item 873: a row's status light — read by the scan (ok), there but not read (idle), off for Home (off), needs a
 *  sign-in or a look (warn), not answering or turned down (bad). */
export type SourceLight = "ok" | "idle" | "off" | "warn" | "bad";

export interface SourceRow {
  id: string;
  name: string;
  /** Item 873: the service it belongs to (rows of one service are drawn as one group), and the row's name inside
   *  that group ("first account", the address) — the service's own name when it is alone. */
  service: string;
  short: string;
  icon: IconName;
  /** Item 873: the service's tint (`sourceLook.ts`). */
  tint: string;
  light: SourceLight;
  /** The light's hover: what it means, then what to do — two short lines. */
  why: string;
  /** What it means now, a few words. */
  state: string;
  /** It needs him (sign in again, a permission he turned down). */
  hot: boolean;
  detail: [string, string][];
}

/** Item 873: rows of one service together, in the order the first of each came. */
export interface SourceGroup {
  service: string;
  icon: IconName;
  tint: string;
  rows: SourceRow[];
}

export function sourceGroups(rows: readonly SourceRow[]): SourceGroup[] {
  const out: SourceGroup[] = [];
  const at = new Map<string, SourceGroup>();
  for (const r of rows) {
    let g = at.get(r.service);
    if (!g) {
      g = { service: r.service, icon: r.icon, tint: r.tint, rows: [] };
      at.set(r.service, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

function connectorLight(a: ReachAccount): [SourceLight, string] {
  if (!a.on) return ["off", "Off for Home\nTurn it on in Settings → Home"];
  if (a.status === "needs_sign_in") return ["warn", "Needs sign-in\nSign in at claude.ai → Settings → Connectors"];
  if (a.status === "failed") return ["bad", "Not answering\nIt did not answer the last check"];
  if (a.in_scan) return ["ok", "Connected · read by the scan\nHome's chat can read it too"];
  return ["idle", "Connected · not in the scan\nHome's chat can read it"];
}

export function sourceRows(
  reach: HomeReach | null,
  mac: readonly HomeSource[] | null,
  name: (a: ReachAccount) => string,
  words: (s: ReachStatus) => string,
  /** Item 845: a time in words, for a row checked on its own since the full check. */
  when: (iso: string) => string = (iso) => iso,
): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const a of reach?.accounts ?? []) {
    const state = !a.on ? "off for Home" : a.status !== "connected" ? words(a.status) : a.in_scan ? "connected · read by the scan" : "connected";
    const full = name(a);
    const look = connectorLook(a.service, a.kind);
    const [light, why] = connectorLight(a);
    rows.push({
      id: `c:${a.connector}`,
      name: full,
      service: a.service,
      short: full.startsWith(`${a.service} · `) ? full.slice(a.service.length + 3) : full,
      icon: look.icon,
      tint: look.tint,
      light,
      why,
      state,
      hot: a.on && a.status !== "connected",
      detail: [
        ["Service", a.service],
        ["Status", words(a.status)],
        ["For Home", a.on ? "On — Home may read it; it never writes through it" : "Off — turn it on in Settings → Home"],
        ["Morning scan", a.in_scan ? "Reads it" : "Does not read it"],
        ...(a.checked_at ? ([["Checked", `${when(a.checked_at)}, on its own`]] as [string, string][]) : []),
      ],
    });
  }
  for (const s of mac ?? []) {
    if (s.status === "not_on_this_mac") continue;
    const allowed = s.status === "allowed";
    const look = macLook(s.id);
    const light: SourceLight = allowed ? (s.on ? "ok" : "off") : s.status === "denied" ? "bad" : s.status === "write_only" ? "warn" : "off"; // ~~"idle"~~ (2026-11-19 review: a dim green read as half-connected on a source never asked; the ring says "not reading")
    const why = allowed
      ? s.on
        ? "Allowed · on for Home\nIt reads it; it never writes"
        : "Allowed · off for Home\nTurn it on in Settings → Home"
      : s.status === "denied"
        ? "Not allowed\nAllow it in Settings → Home"
        : s.status === "write_only"
          ? "Add-only access\nHome cannot read it yet"
          : "Not asked yet\nAsk in Settings → Home";
    rows.push({
      id: `m:${s.id}`,
      name: `${s.name} · this Mac`,
      service: `${s.name} · this Mac`,
      short: `${s.name} · this Mac`,
      icon: look.icon,
      tint: look.tint,
      light,
      why,
      state: allowed ? (s.on ? "allowed · on" : "allowed · off for Home") : s.status === "denied" ? "not allowed" : s.status === "write_only" ? "add-only access" : "not asked yet",
      hot: s.status === "denied",
      detail: [["Now", s.why], ["Change it", "Settings → Home"]],
    });
  }
  return rows;
}

/** Item 896: a key per Handled row, unique even when two feed rows share their time and words (Svelte throws on a
 *  repeated key in a keyed each, in production too, which stops the window drawing — item 847's P2). The second and
 *  later copies get "#n", so the first keeps its key (and an open row stays open) as rows arrive. */
export function feedKeys(rows: readonly { at: string; line: string }[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = r.at + r.line;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}
