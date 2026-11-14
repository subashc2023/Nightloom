/**
 * Compact relative time: "just now", "5m ago", "2h ago", "yesterday", or a
 * date. `now` is the clock to measure from (ms since epoch); a caller that
 * wants the text to refresh while it is on screen passes a ticking value,
 * since nothing re-runs on `Date.now()` by itself (nightshift backlog 123).
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  return relative(iso, now, false);
}

/**
 * The same in words — "37 minutes ago", "2 hours ago" — the way Claude
 * Code's message footer reads (backlog 123). For the foot of a message,
 * where there is room; the compact form stays on the sidebar and the notes.
 */
export function relativeTimeLong(iso: string, now: number = Date.now()): string {
  return relative(iso, now, true);
}

function relative(iso: string, now: number, long: boolean): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const ms = now - then.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return long ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const today = new Date(now);
  if (hours < 24 && then.toDateString() === today.toDateString()) {
    return long ? `${hours} ${hours === 1 ? "hour" : "hours"} ago` : `${hours}h ago`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return "yesterday";
  if (hours < 24) return long ? `${hours} ${hours === 1 ? "hour" : "hours"} ago` : `${hours}h ago`;
  return then.toLocaleDateString();
}

/**
 * The exact moment for a hover — `Sep 16, 2026, 3:40 PM` (backlog 123),
 * always the 12-hour clock whatever the locale (item 611b; was the locale's
 * own, 24-hour under most). Takes an ISO string, epoch ms or a Date. Empty
 * for a time that could not be parsed.
 */
export function exactTime(at: string | number | Date): string {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", hour12: true });
}
