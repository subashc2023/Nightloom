/**
 * A plan window's reset time, as the gauge card and the top bar's
 * 5-hour hover (item 595) show it: `resets 9:40 PM` today, `resets Thu
 * 9:00 AM` on another day. Always the 12-hour clock (blocker 1812, his
 * "yeah use am/pm situation instead of 24h", 2026-11-10), whatever the
 * locale — it was `21:40` from `hour12: false` before.
 */
import { clock12 } from "./chatList";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function resetText(iso: string | null, nowMs: number): string {
  if (!iso) return "reset time unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "reset time unknown";
  const time = clock12(d.getTime());
  return d.toDateString() === new Date(nowMs).toDateString() ? `resets ${time}` : `resets ${DAYS[d.getDay()]} ${time}`;
}

/** The long form for the plan chip's tooltip: `resets Tue, Nov 10, 9:40 PM`. */
export function resetLong(iso: string | null): string {
  if (!iso) return "reset time unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "reset time unknown";
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `resets ${date}, ${clock12(d.getTime())}`;
}
