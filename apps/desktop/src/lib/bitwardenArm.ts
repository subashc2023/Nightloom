/**
 * The pre-arm card's words and times (nightshift item 826). His follow-up
 * (2026-11-17): "a button at the start of all overnight or asynchronous
 * chats that allows me to like unlock Bitwarden for that entire session".
 * The card lists the Always rules (only those can answer without him, so
 * only they can be armed), all ticked, and an end time; one Touch ID fetches
 * just those values and the vault locks again at once (`bitwarden_unlock::arm`).
 */

/** The end a card starts with: 8:00 AM, the next one at least an hour away. */
export const DEFAULT_END = "08:00";

/** The next moment the clock reads `hhmm` ("08:00"), at least `minAheadMs` after `now`; null if unreadable. */
export function nextClock(now: Date, hhmm: string, minAheadMs = 0): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  while (d.getTime() - now.getTime() < Math.max(minAheadMs, 1)) d.setDate(d.getDate() + 1);
  return d;
}

/** 12-hour time, "8:00 AM" (his rule). */
export function clock12(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** "until 8:00 AM" today, or "until 8:00 AM tomorrow". */
export function untilWords(end: Date, now: Date): string {
  const sameDay = end.toDateString() === now.toDateString();
  return `until ${clock12(end)}${sameDay ? "" : " tomorrow"}`;
}

/** The line a running pre-arm shows: names and its end; null when none or ended. */
export function armedLine(armed: { names: string[]; until: string } | null, now: Date): string | null {
  if (!armed) return null;
  const end = new Date(armed.until);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return null;
  const n = armed.names.length;
  return `Pre-armed: ${armed.names.join(", ")} (${n} secret${n === 1 ? "" : "s"}) ${untilWords(end, now)}. The vault itself is locked.`;
}

/** Why the Pre-arm button is off, or null. */
export function armBlocked(picked: number, end: Date | null, stored: boolean): string | null {
  if (!stored) return "Set up Touch ID unlock first (above).";
  if (picked === 0) return "Tick at least one secret.";
  if (!end) return "Type an end time, like 08:00.";
  return null;
}

/** The two-line tip on Pre-arm (memory tooltips-two-short-lines). */
export const ARM_TIP = "One Touch ID fetches only the ticked secrets.\nThe vault locks again at once.";
