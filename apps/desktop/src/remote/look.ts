/**
 * The phone page's look (item 572, Filament IV stage 11): Filament IV, the
 * default, or Classic — the page as it was before, kept so a Filament IV bug
 * never blocks his work (item 542's rule, his words 2026-11-09).
 *
 * The desktop's choice (`lib/layout.svelte.ts`, `nightloom.look`) lives in
 * the Mac's webview; the phone cannot read it (`/api/state` does not carry
 * it), so the page has its own, chosen in Model and settings and kept in the
 * phone's localStorage beside its other keys (`nightloom.remote.*`).
 * Classic stamps `data-layout="classic"` on <html>, the same attribute the
 * desktop uses, so every Filament IV rule sits behind
 * `:where(:root:not([data-layout="classic"]))`.
 *
 * Also here, pure so the suite pins them: the header's context line (the
 * newest reply's prompt size, the prompt cache's time left) — what the
 * Filament IV header reads from the chat's log.
 */
import type { SessionEvent } from "../lib/types";

export type Look = "filament" | "classic";
export const LOOK_KEY = "nightloom.remote.look";

export function loadLook(store: Pick<Storage, "getItem"> | null = safeStore()): Look {
  try {
    return store?.getItem(LOOK_KEY) === "classic" ? "classic" : "filament";
  } catch {
    return "filament";
  }
}

export function saveLook(l: Look, store: Pick<Storage, "setItem" | "removeItem"> | null = safeStore()): void {
  try {
    if (l === "classic") store?.setItem(LOOK_KEY, "classic");
    else store?.removeItem(LOOK_KEY);
  } catch {
    // No storage (a private window): the choice holds for this visit.
  }
}

/** Stamp the look on <html>, and the dark bar colour Safari draws with. */
export function applyLook(l: Look): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (l === "classic") root.dataset.layout = "classic";
  else delete root.dataset.layout;
  const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][media*="dark"]');
  if (bar) bar.content = l === "classic" ? "#1b1916" : "#0b0d10";
}

function safeStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The newest reply's figures: what the next request carries (input plus
 *  output, as the desktop's `contextUsed`), and the cache's expiry. */
export interface ContextLine {
  /** Tokens in context, or null before the first reply that reported usage. */
  used: number | null;
  /** When the prompt cache expires, ms epoch; null when the log has no clock. */
  warmUntil: number | null;
}

const TTL_MS: Record<string, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

export function contextLine(events: readonly SessionEvent[], live: readonly boolean[]): ContextLine {
  for (let i = events.length - 1; i >= 0; i--) {
    if (live[i] === false) continue;
    const e = events[i] as SessionEvent & {
      usage?: { input_tokens: number; output_tokens: number } | null;
      sent_at?: string;
      cache_ttl?: string;
    };
    if (e.event !== "assistant_message") continue;
    const u = e.usage;
    if (!u || (u.input_tokens <= 0 && u.output_tokens <= 0)) continue;
    const sent = e.sent_at ? Date.parse(e.sent_at) : NaN;
    const ttl = e.cache_ttl ? TTL_MS[e.cache_ttl] : undefined;
    return { used: u.input_tokens + u.output_tokens, warmUntil: Number.isFinite(sent) && ttl ? sent + ttl : null };
  }
  return { used: null, warmUntil: null };
}

/** 212400 → "212k", 1_000_000 → "1M", 950 → "950". */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** The cache's time left as m:ss (floored, never a second it lacks), or
 *  null once cold. An hour's cache over ten minutes reads in minutes. */
export function cacheLeft(warmUntil: number | null, now: number): string | null {
  if (warmUntil === null) return null;
  const ms = warmUntil - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  if (s >= 600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
