/**
 * Item 1026 (his pick, B): the bell and the Needs-you pill are one button with two modes inside — "Needs you
 * now" (what waits on him, answerable in place) and "What happened" (969's daily digest). Pure: what the face
 * shows, which mode a click opens, and the two remembered values.
 */
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode or full: kept for this run only */
  }
}

export type CentreMode = "needs" | "digest";

/** The badge's words (`badgeWords` in needsYou.ts). */
export type BadgeWords = { n: number; word: string; waiting: boolean } | null;

/**
 * The one face: the amber number whenever anything needs him (it always wins); else the bell, with its dot
 * while a digest row is new; "to review" rides beside the bell when only reviews are left (968: no number).
 */
export type Face = { kind: "needs"; n: number; word: string } | { kind: "bell"; fresh: boolean; review: boolean };

export function faceOf(badge: BadgeWords, fresh: boolean): Face {
  if (badge && badge.waiting && badge.n > 0) return { kind: "needs", n: badge.n, word: badge.word };
  return { kind: "bell", fresh, review: !!badge && !badge.waiting };
}

/** A click opens the mode he last used, unless the number grew since he last looked at Needs you now. */
export function openingMode(last: CentreMode, n: number, seen: number): CentreMode {
  return n > seen ? "needs" : last;
}

const MODE_KEY = "nightloom.centreMode";
const SEEN_KEY = "nightloom.needsSeen";

export function loadCentreMode(): CentreMode {
  return safeGet(MODE_KEY) === "digest" ? "digest" : "needs";
}
export function saveCentreMode(m: CentreMode): void {
  safeSet(MODE_KEY, m);
}
export function loadNeedsSeen(): number {
  const n = Number(safeGet(SEEN_KEY) ?? "0");
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
export function saveNeedsSeen(n: number): void {
  safeSet(SEEN_KEY, String(n));
}
