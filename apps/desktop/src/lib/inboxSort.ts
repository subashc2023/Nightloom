// The notes Inbox's "Sort inbox" (nightshift backlog 488): the bridge to
// `inbox_sort.rs` and the pure rules the sheet draws with. A cheap model
// (Haiku, in its own throwaway CLI turn) proposes where each inbox entry
// goes; he unticks or edits a destination; Apply moves only the ticked
// ones. Nothing here deletes or writes over anything.

import { invoke } from "@tauri-apps/api/core";

export const INBOX = "Inbox";

export type InboxScope = "project" | "knowledge";

export interface InboxItem {
  path: string;
  folder: boolean;
  bytes: number;
  kind: string;
  head: string;
}

export interface InboxDigest {
  items: InboxItem[];
  folders: string[];
  left_out: number;
}

export interface Proposal {
  item: string;
  folder: boolean;
  /** Notes-relative folder; "" is the top of the notes; "Inbox" stays. */
  to: string;
  reason: string;
  new_folder: boolean;
  tick: boolean;
}

export interface SortUsage {
  input_tokens: number;
  output_tokens: number;
  /** A subset of input_tokens. */
  cache_read_tokens?: number | null;
}

export interface SortPlan {
  proposals: Proposal[];
  folders: string[];
  left_out: number;
  model: string | null;
  usage: SortUsage;
  cost_usd: number | null;
  interrupted: boolean;
}

export interface Move {
  item: string;
  to: string;
}

export interface Moved {
  item: string;
  landed?: string;
  renamed: boolean;
  error?: string;
}

/** The inbox's entries and the folders around it (makes `Inbox/`). */
export function listInbox(scope: InboxScope): Promise<InboxDigest> {
  return invoke("inbox_sort_list", { scope });
}

/** One throwaway Haiku turn; nothing moves. */
export function planSort(args: {
  scope: InboxScope;
  instruction?: string;
  binary?: string;
  safeMode?: boolean;
}): Promise<SortPlan> {
  return invoke("inbox_sort_plan", args);
}

export function cancelSort(): Promise<null> {
  return invoke("inbox_sort_cancel");
}

export function applySort(scope: InboxScope, moves: Move[]): Promise<Moved[]> {
  return invoke("inbox_sort_apply", { scope, moves });
}

/** A destination as he typed it, checked as the backend checks it. */
export type DestCheck =
  | { ok: true; rel: string; isNew: boolean }
  | { ok: false; why: string };

export function checkDest(to: string, folders: string[]): DestCheck {
  const t = to.trim().replace(/^\/+|\/+$/g, "").trim();
  const lower = t.toLowerCase();
  if (lower === INBOX.toLowerCase() || lower.startsWith(INBOX.toLowerCase() + "/")) {
    return { ok: false, why: "that is the inbox — untick it to leave it there" };
  }
  if (t === "") return { ok: true, rel: "", isNew: false };
  if (/^[a-zA-Z]:/.test(t) || t.includes("\\")) return { ok: false, why: "not a folder in these notes" };
  const parts = t.split("/").map((p) => p.trim());
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || p.includes(":"))) {
    return { ok: false, why: "not a folder in these notes" };
  }
  const rel = parts.join("/");
  const have = folders.find((f) => f.toLowerCase() === rel.toLowerCase());
  if (have !== undefined) return { ok: true, rel: have, isNew: false };
  return { ok: true, rel, isNew: true };
}

/** The ticked rows with a usable destination, as moves. */
export function movesOf(rows: Proposal[], folders: string[]): Move[] {
  const out: Move[] = [];
  for (const r of rows) {
    if (!r.tick) continue;
    const c = checkDest(r.to, folders);
    if (c.ok) out.push({ item: r.item, to: c.rel });
  }
  return out;
}

/** The leaf of an inbox path. */
export function leafOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function destLabel(to: string): string {
  return to === "" ? "top of the notes" : to + "/";
}

/** "Haiku · 2,140 in, 380 out · about $0.004". The figure is the CLI's
 *  estimate of the API price — not a bill on a subscription. */
export function costWords(plan: Pick<SortPlan, "model" | "usage" | "cost_usd">): string {
  const u = plan.usage;
  const input = u.input_tokens ?? 0;
  const model = plan.model && /haiku/i.test(plan.model) ? "Haiku" : (plan.model ?? "the sorter");
  const parts = [model, `${input.toLocaleString("en-US")} in, ${(u.output_tokens ?? 0).toLocaleString("en-US")} out`];
  if (plan.cost_usd != null) {
    const c = plan.cost_usd;
    parts.push(`about $${c < 0.01 ? c.toFixed(4) : c.toFixed(2)} at API prices`);
  }
  return parts.join(" · ");
}

/** What Apply did, in a line. */
export function appliedWords(results: Moved[]): string {
  const moved = results.filter((r) => r.landed);
  const renamed = moved.filter((r) => r.renamed).length;
  const failed = results.length - moved.length;
  const bits = [`Moved ${moved.length} ${moved.length === 1 ? "entry" : "entries"}`];
  if (renamed) bits.push(`${renamed} numbered because the name was taken (Keep both)`);
  if (failed) bits.push(`${failed} could not move`);
  return bits.join("; ") + ".";
}

// ---- the unapplied plan survives a quit (practices §7) ----
//
// Kept in localStorage the way the drafts and the note side chats are: his
// instruction and his edits to a proposed plan come back after a relaunch.
// A sort or an Apply that was running when the app quit comes back as the
// plan it started from (nothing moved that was not reported).

export const SAVED_KEY = "nightloom.inboxSort.v1";

export interface SavedSort {
  scope: InboxScope;
  instruction: string;
  rows: Proposal[];
  folders: string[];
  cost: string;
  /** When the plan was proposed (ISO), for "kept from 6:50 PM". */
  savedAt: string;
}

export function serializeSort(s: SavedSort): string {
  return JSON.stringify(s);
}

const str = (v: unknown): v is string => typeof v === "string";

/** A stored sort, checked field by field; null when there is nothing worth offering back. */
export function parseSort(raw: string | null): SavedSort | null {
  if (!raw) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const scope: InboxScope = v.scope === "knowledge" ? "knowledge" : "project";
  const rows = Array.isArray(v.rows)
    ? (v.rows as Record<string, unknown>[])
        .filter((r) => r && str(r.item) && r.item.startsWith(INBOX + "/") && str(r.to))
        .map((r) => ({
          item: r.item as string,
          folder: r.folder === true,
          to: r.to as string,
          reason: str(r.reason) ? r.reason : "",
          new_folder: r.new_folder === true,
          tick: r.tick === true,
        }))
    : [];
  const out: SavedSort = {
    scope,
    instruction: str(v.instruction) ? v.instruction : "",
    rows,
    folders: Array.isArray(v.folders) ? (v.folders as unknown[]).filter(str) : [],
    cost: str(v.cost) ? v.cost : "",
    savedAt: str(v.savedAt) ? v.savedAt : "",
  };
  return out.rows.length || out.instruction.trim() ? out : null;
}

/** "6:50 PM" (his clock is 12-hour). */
export function keptAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
