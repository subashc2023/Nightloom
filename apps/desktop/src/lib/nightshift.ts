/**
 * Small presentation helpers for the Nightshift screens. Nothing here decides
 * what a field means — the Rust projection did that — only how a value reads
 * on screen.
 */
import type { ShiftSummary } from "./types";

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
