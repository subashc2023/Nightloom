/** Compact relative time: "just now", "5m ago", "2h ago", "yesterday", or a date. */
export function relativeTime(iso: string): string {
  const then = new Date(iso);
  const ms = Date.now() - then.getTime();
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && then.toDateString() === new Date().toDateString()) {
    return `${hours}h ago`;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return "yesterday";
  if (hours < 24) return `${hours}h ago`;
  return then.toLocaleDateString();
}
