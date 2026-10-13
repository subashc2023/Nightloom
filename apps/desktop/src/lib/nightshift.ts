/**
 * Small presentation helpers for the Nightshift screens. Nothing here decides
 * what a field means — the Rust projection did that — only how a value reads
 * on screen.
 */
import type { Item, NoteEntry, ShiftSummary } from "./types";

/** `HH:MM` of an RFC 3339 timestamp, in local time; "" when absent. */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 5);
}

/** `HH:MM:SS`, for the timeline's tick labels. */
export function hhmmss(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

/** "24 min 43 s" between two timestamps; "" when either is missing. */
export function duration(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  if (!a || !b) return "";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

export function usd(n: number | null | undefined): string {
  if (n == null) return "";
  return `$${n.toFixed(2)}`;
}

export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** `64 KiB` for a byte count. */
export function kib(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const k = bytes / 1024;
  if (k < 1024) return `${k < 10 ? k.toFixed(1) : Math.round(k)} KiB`;
  return `${(k / 1024).toFixed(1)} MiB`;
}

/**
 * The one word the shift list shows beside an id. The projection already
 * says `live`, `interrupted` and `unknown`; the rest is the phase the runner
 * last wrote, with a non-zero exit shown as `failed`.
 */
export function shiftWord(s: ShiftSummary): string {
  if (s.live) return "live";
  if (s.interrupted) return "interrupted";
  if (s.unknown) return "unknown";
  const st = s.status;
  if (!st) return s.status_error ? "failed" : "no status";
  if (st.exit != null && st.exit !== 0) return "failed";
  return st.phase || "done";
}

/** The pill class for a shift word or a unit outcome. */
export function pillClass(word: string): string {
  switch (word) {
    case "done":
    case "live":
    case "failed":
    case "partial":
    case "interrupted":
    case "unknown":
    case "wip":
    case "open":
    case "answered":
    case "applied":
    case "withdrawn":
      return word;
    default:
      return "grey";
  }
}

/** Summed unit cost, or null when no unit reported one. */
export function shiftCost(s: ShiftSummary): number | null {
  const units = s.status?.units ?? [];
  let sum = 0;
  let any = false;
  for (const u of units) {
    if (u.cost_usd != null) {
      sum += u.cost_usd;
      any = true;
    }
  }
  return any ? sum : null;
}

/** The second line of a shift row: units, cost, start → end. */
export function shiftMeta(s: ShiftSummary): string {
  const st = s.status;
  if (!st) return s.status_error ? "status.json did not parse" : "no status.json";
  const parts: string[] = [];
  const n = st.units.length;
  parts.push(`${n} unit${n === 1 ? "" : "s"}`);
  const cost = shiftCost(s);
  if (cost != null) parts.push(usd(cost));
  const a = hhmm(st.started);
  const b = hhmm(st.exit != null ? st.updated : null);
  if (a) parts.push(b ? `${a} → ${b}` : `from ${a}`);
  return parts.join(" · ");
}

/** `2026-09-11.md` and `2026-09-11` name the same page. */
export function sameMorning(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const strip = (s: string) => (s.endsWith(".md") ? s.slice(0, -3) : s);
  return strip(a) === strip(b);
}

/**
 * The `## ` sections of a markdown page, by heading — what the Morning
 * screen's side column pulls "Left unfinished", "Open blockers" and "Next"
 * from. The body under each heading is returned verbatim, trimmed, up to
 * the next `## `. Case-insensitive on the title; the runner writes them in
 * one case and a human may not.
 */
export function mdSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let title: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (title !== null) out.set(title.toLowerCase(), buf.join("\n").trim());
  };
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      title = m[1];
      buf = [];
    } else if (title !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Markdown as one line of plain text — for a card or a row that shows a
 * question, where backticks and asterisks are noise. Not a renderer.
 */
export function plain(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** One entry in the tree the Notes screen's left column draws. */
export interface NoteNode {
  name: string;
  /** Root-relative with forward slashes, same shape as `NoteEntry.path`. */
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
  children: NoteNode[];
}

/**
 * The flat `NoteEntry[]` `nightshift_notes` returns, folded into a tree for
 * the Notes screen's left column. Ancestor directories are synthesized when
 * the backend's listing does not name them explicitly (size 0, modified "");
 * an entry that does name a directory fills in its real size/modified
 * instead, in whichever order the entries arrive. Pure — no component state,
 * no fetch — so the tree shape can be unit-tested without a project.
 * Directories sort before files at each level, both alphabetically.
 */
export function notesTree(entries: NoteEntry[]): NoteNode[] {
  const root: NoteNode = {
    name: "",
    path: "",
    is_dir: true,
    size: 0,
    modified: "",
    children: [],
  };
  const byPath = new Map<string, NoteNode>([["", root]]);

  function ensureDir(path: string): NoteNode {
    const existing = byPath.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const parentPath = idx === -1 ? "" : path.slice(0, idx);
    const name = idx === -1 ? path : path.slice(idx + 1);
    const parent = ensureDir(parentPath);
    const node: NoteNode = { name, path, is_dir: true, size: 0, modified: "", children: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  }

  for (const e of entries) {
    if (e.is_dir) {
      const node = ensureDir(e.path);
      node.size = e.size;
      node.modified = e.modified;
    } else {
      const idx = e.path.lastIndexOf("/");
      const parentPath = idx === -1 ? "" : e.path.slice(0, idx);
      const parent = ensureDir(parentPath);
      // A file entry read twice (should not happen) overwrites in place.
      const already = parent.children.find((c) => c.path === e.path);
      if (already) {
        already.size = e.size;
        already.modified = e.modified;
      } else {
        parent.children.push({
          name: e.name,
          path: e.path,
          is_dir: false,
          size: e.size,
          modified: e.modified,
          children: [],
        });
      }
    }
  }

  const sortChildren = (n: NoteNode) => {
    n.children.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) if (c.is_dir) sortChildren(c);
  };
  sortChildren(root);

  return root.children;
}

/** One row of the Start screens' backlog list. */
export interface BacklogRow {
  item: Item;
  /** 1-based position in `order`; null for an unlisted item. */
  order: number | null;
  unlisted: boolean;
}

/**
 * The backlog the way the Start screens show it (3.6, 3.7): items named in
 * `order` first, in that order, then any item `order` does not name —
 * unlisted, appended in the order `items` lists them. An id in `order` with
 * no matching item (a stale `order.json` entry) is silently skipped; the
 * caller sees that mismatch in `ItemList.errors` instead of here. Pure — no
 * component state — so the merge is unit-testable without a project.
 */
export function orderedBacklog(items: Item[], order: string[]): BacklogRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const rows: BacklogRow[] = [];
  order.forEach((id, idx) => {
    const item = byId.get(id);
    if (!item) return;
    seen.add(id);
    rows.push({ item, order: idx + 1, unlisted: false });
  });
  for (const item of items) {
    if (!seen.has(item.id)) rows.push({ item, order: null, unlisted: true });
  }
  return rows;
}

/**
 * The pill class for an item's `status` (`todo | in-progress | done | killed
 * | deferred`, or "" when unset) — distinct from `pillClass` above, whose
 * words are shift/blocker vocabulary, not the backlog's.
 */
export function itemStatusPill(status: string): string {
  switch (status) {
    case "done":
      return "done";
    case "in-progress":
      return "live";
    case "killed":
      return "failed";
    default:
      return "grey";
  }
}

/**
 * `until` for the plan form: the contract's `until` is a full local
 * timestamp, `YYYY-MM-DDTHH:MM:SS` (SHIFT-CONTRACT.md §6's `plan.json`
 * example), but the form only asks for a time of day — the mock-up's field
 * always reads "10:00 tomorrow". `time` is an `<input type=time>` value
 * (`HH:MM`); "" (or anything else unparseable) means no bound. `now` is
 * injectable for tests.
 */
/**
 * A clock time typed by a person: `7am`, `7 am`, `7:30pm`, `07:30`, `0930`,
 * `930`, `19`, `noon`, `midnight`. Returns hours and minutes, or null when
 * it is not a time. Lenient on purpose: the segmented `<input type=time>`
 * was the clunky thing (2026-09-11 review).
 */
export function parseClockTime(text: string): { hh: number; mm: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  if (t === "noon") return { hh: 12, mm: 0 };
  if (t === "midnight") return { hh: 0, mm: 0 };
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] != null ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === "a" && hh === 12) hh = 0;
    if (ap === "p" && hh !== 12) hh += 12;
  } else if (hh > 23) {
    return null;
  }
  return { hh, mm };
}

/** `HH:MM` for a parsed time, the shape the summary shows. */
export function clockLabel(t: { hh: number; mm: number }): string {
  const h12 = t.hh % 12 === 0 ? 12 : t.hh % 12;
  return `${h12}${t.mm ? ":" + String(t.mm).padStart(2, "0") : ""}${t.hh < 12 ? "am" : "pm"}`;
}

/**
 * The plan's `until` for a typed time: the NEXT occurrence of that clock
 * time — later today if it is still ahead, else tomorrow. (Was "always
 * tomorrow", a flagged guess; a plan made at 22:00 for 23:30 meant the day
 * after.) Accepts `HH:MM` or anything `parseClockTime` reads.
 */
export function untilFromTime(time: string, now: Date = new Date()): string | null {
  const t = parseClockTime(time);
  if (!t) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hh, t.mm, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
