import { DEFAULT_MIN_TOKENS, DEFAULT_MODE, isMode, type WarmWrapMode } from "./warmWrap";

/**
 * Item 768's preferences and memory, kept in localStorage so they survive
 * a restart (practices §7: every view keeps its state):
 * - `mode` and `minTokens`, the Settings pair;
 * - `kept[chat]`: the cache end (ms) that had lapsed when he chose *Keep*
 *   on the cold chip — the chip stays away until a newer reply moves it;
 * - `acted[chat]`: the cache end (ms) the warm moment already acted on, so
 *   a dismissed offer or a sent wrap-up is not repeated for the same hour.
 */
const KEY = "nightloom.warmWrap";

export interface WarmStored {
  mode: WarmWrapMode;
  minTokens: number;
  kept: Record<string, number>;
  acted: Record<string, number>;
}

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  return out;
}

export function parseWarmStored(raw: string | null): WarmStored {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<WarmStored>;
      return {
        mode: isMode(p.mode) ? p.mode : DEFAULT_MODE,
        minTokens: typeof p.minTokens === "number" && Number.isFinite(p.minTokens) && p.minTokens >= 0 ? Math.round(p.minTokens) : DEFAULT_MIN_TOKENS,
        kept: numbers(p.kept),
        acted: numbers(p.acted),
      };
    }
  } catch {
    // Unreadable: the defaults.
  }
  return { mode: DEFAULT_MODE, minTokens: DEFAULT_MIN_TOKENS, kept: {}, acted: {} };
}

function load(): WarmStored {
  try {
    return parseWarmStored(localStorage.getItem(KEY));
  } catch {
    return parseWarmStored(null);
  }
}

export const warmWrap = $state<WarmStored>(load());

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(warmWrap));
  } catch {
    // Storage refused; holds for this launch.
  }
}

export function setWarmMode(m: WarmWrapMode): void {
  if (!isMode(m)) return;
  warmWrap.mode = m;
  save();
}

export function setWarmMinTokens(n: number): void {
  if (!Number.isFinite(n) || n < 0) return;
  warmWrap.minTokens = Math.round(n);
  save();
}

/** *Keep* on the cold chip, for the cache end that lapsed. */
export function keepCold(chat: string | null, warmUntil: number | null): void {
  if (!chat || warmUntil == null) return;
  warmWrap.kept[chat] = warmUntil;
  save();
}

export function keptCold(chat: string | null, warmUntil: number | null): boolean {
  return !!chat && warmUntil != null && warmWrap.kept[chat] === warmUntil;
}

/** The warm moment acted on (offer dismissed, or the wrap-up sent) for this cache end. */
export function markActed(chat: string | null, warmUntil: number | null): void {
  if (!chat || warmUntil == null) return;
  warmWrap.acted[chat] = warmUntil;
  save();
}

export function actedOn(chat: string | null, warmUntil: number | null): boolean {
  return !!chat && warmUntil != null && warmWrap.acted[chat] === warmUntil;
}
