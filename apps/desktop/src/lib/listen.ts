/*
 * Item 801 (793's decision §4 row 8): Listen — a reply, a note or a morning
 * page read aloud by the host's Piper voice, and Brief, which first has the
 * model rewrite it for the ear in under two minutes. The pure half: the
 * speeds, the time words, and where each thing's place and the speed are
 * kept (localStorage), so pausing, leaving and coming back resumes.
 */

export const SPEEDS = [1, 1.25, 1.5, 2] as const;
const RATE_KEY = "nightloom.listen.rate";
const PLACE_PREFIX = "nightloom.listen.at.";
/** Places kept at most; the oldest go first. */
export const MAX_PLACES = 200;

/** The next speed in the cycle. */
export function nextSpeed(rate: number): number {
  const i = SPEEDS.findIndex((s) => Math.abs(s - rate) < 0.01);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

export function speedWords(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, "")}×`;
}

/** `m:ss`. */
export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One thing's key: what it is, and whether it is the Brief. */
export function listenKey(kind: "reply" | "note" | "morning", id: string, brief: boolean): string {
  return `${kind}:${id}${brief ? ":brief" : ""}`;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function loadRate(store: Store | null): number {
  const v = Number(store?.getItem(RATE_KEY));
  return SPEEDS.some((s) => Math.abs(s - v) < 0.01) ? v : 1;
}
export function saveRate(store: Store | null, rate: number): void {
  try {
    store?.setItem(RATE_KEY, String(rate));
  } catch {
    // storage full or off: the speed is this session's only
  }
}

/** Where a thing was left, seconds; 0 when never played or finished. */
export function loadPlace(store: Store | null, key: string): number {
  try {
    const raw = store?.getItem(PLACE_PREFIX + key);
    const v = raw ? (JSON.parse(raw) as { t?: number }).t : 0;
    return typeof v === "number" && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Keep a place (`t` seconds of `duration`); a place in the last two
 *  seconds is the end, and the next Listen starts over. */
export function savePlace(store: Store | null, key: string, t: number, duration: number, now = Date.now()): void {
  if (!store) return;
  try {
    if (!(t > 0) || (duration > 0 && duration - t < 2)) {
      store.removeItem(PLACE_PREFIX + key);
      return;
    }
    store.setItem(PLACE_PREFIX + key, JSON.stringify({ t, at: now }));
    prunePlaces(store);
  } catch {
    // storage full: the place is not kept
  }
}

function prunePlaces(store: Store): void {
  const all: { k: string; at: number }[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k?.startsWith(PLACE_PREFIX)) continue;
    try {
      all.push({ k, at: (JSON.parse(store.getItem(k) ?? "{}") as { at?: number }).at ?? 0 });
    } catch {
      all.push({ k, at: 0 });
    }
  }
  if (all.length <= MAX_PLACES) return;
  all.sort((a, b) => a.at - b.at);
  for (const x of all.slice(0, all.length - MAX_PLACES)) store.removeItem(x.k);
}

/** The words for a failure, plain. */
export function failWords(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/^Error: /, "");
}

/** A short id for words with no id of their own (FNV-1a, hex). */
export function textId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
