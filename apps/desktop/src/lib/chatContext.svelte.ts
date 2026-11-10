/**
 * The last context reading of each chat (item 534): what the chat list's
 * two-line rows show as `212k` and the small bar. The chat listing does not
 * carry a chat's context (`SessionMeta`), so the app keeps the last reading
 * it saw — the open chat's gauge (`contextUsed()` over the connection's
 * window) and each running chat's live usage — under the chat's id, in app
 * state and one localStorage key, every access in try/catch. A chat not
 * open or run since this was built shows no size; nothing is guessed.
 */

export interface CtxReading {
  used: number;
  /** The window it was read against; 0 when unknown. */
  limit: number;
}

const KEY = "nightloom.chatContext";
/** Enough for his largest project (~1,800 chats, item 454) with room. */
const MAX = 4000;
const SAVE_DELAY_MS = 800;

/** Pure: the stored map read back, malformed entries dropped. */
export function parseReadings(raw: string | null): Record<string, CtxReading> {
  const out: Record<string, CtxReading> = {};
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return out;
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const [used, limit] = v as unknown[];
      if (typeof used === "number" && used >= 0 && typeof limit === "number" && limit >= 0) out[k] = { used, limit };
    }
  } catch {
    // Unreadable: start empty.
  }
  return out;
}

/** Pure: the map written as `{id: [used, limit]}`, the newest `MAX` kept. */
export function writeReadings(map: Record<string, CtxReading>, max: number = MAX): string {
  const ids = Object.keys(map);
  const keep = ids.length > max ? ids.slice(ids.length - max) : ids;
  const o: Record<string, [number, number]> = {};
  for (const k of keep) o[k] = [map[k].used, map[k].limit];
  return JSON.stringify(o);
}

function readInitial(): Record<string, CtxReading> {
  try {
    if (typeof localStorage === "undefined") return {};
    return parseReadings(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export const chatContext: Record<string, CtxReading> = $state(readInitial());

let timer: ReturnType<typeof setTimeout> | null = null;
function save(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      localStorage.setItem(KEY, writeReadings(chatContext));
    } catch {
      // Storage refused: the readings hold for this launch.
    }
  }, SAVE_DELAY_MS);
}

/**
 * Note a reading for `chat`. A null or non-finite `used` is no reading. A
 * window of 0 keeps the one last known for the chat (a running chat off
 * screen brings its usage, not its model's window). Unchanged readings
 * write nothing.
 */
export function noteChatContext(chat: string | null | undefined, used: number | null | undefined, limit: number | null | undefined): void {
  if (!chat || used == null || !Number.isFinite(used) || used < 0) return;
  const prev = chatContext[chat];
  const lim = limit && limit > 0 ? limit : (prev?.limit ?? 0);
  if (prev && prev.used === used && prev.limit === lim) return;
  // Re-inserted last, so the cap drops the readings longest untouched.
  delete chatContext[chat];
  chatContext[chat] = { used, limit: lim };
  save();
}

/** The chat's last reading, or null. */
export function contextOf(chat: string): CtxReading | null {
  return chatContext[chat] ?? null;
}
