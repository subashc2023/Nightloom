// The backfill of older outside Claude Code sessions (nightshift item 779):
// its cap default and the one sentence Settings shows under its switch.
// Pure, so it is tested.
import type { BackfillStatus } from "./types";

/** The backfill's default daily cap, in model calls (the backend's
 *  `BACKFILL_DAILY_CAP`, blocker 2259). */
export const DEFAULT_BACKFILL_CAP = 30;

/** A stored or typed cap: a whole number 1–500, else the default. */
export function parseBackfillCap(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 500 ? n : DEFAULT_BACKFILL_CAP;
}

/** "312 of 590 older sessions read, 278 left · 12 of 30 calls today". */
export function backfillSentence(
  s: BackfillStatus | null,
  on: boolean,
  running: boolean,
): string {
  if (!s) return "Older sessions: not counted yet — the count comes with the next sync.";
  if (s.total === 0) {
    return "No older Claude Code sessions to read: every one is newer than the mirror and read with each capture.";
  }
  const read = s.total - s.pending;
  const head =
    s.pending === 0
      ? `All ${s.total} older session${s.total === 1 ? "" : "s"} read`
      : `${read} of ${s.total} older sessions read, ${s.pending} left`;
  const day = `${s.today} of ${s.cap} calls today`;
  const tail = !on
    ? " · off"
    : running
      ? " · reading now"
      : s.pending > 0 && s.today >= s.cap
        ? " · resumes tomorrow"
        : "";
  return `${head} · ${day}${tail}`;
}
