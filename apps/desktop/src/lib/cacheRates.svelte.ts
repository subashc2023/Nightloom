/**
 * The rates the composer's `next ≈ $…` estimate uses (item 699), per
 * model, as the backend's `cache_rates` reads them: `usage-rates.json`'s
 * row, else a fit to the project's keep-warm pings. Read once per model
 * and again after ten minutes (a new ping may sharpen the fit); a failed
 * read is no figure, never a guess.
 */
import * as api from "./api";
import { cacheEstimate, lastReply, ratesFromPrice, ratesFromWire, type ChipRates } from "./cacheCost";
import type { SessionEvent } from "./types";

const byModel = $state<Record<string, ChipRates | null>>({});
const readAt: Record<string, number> = {};
const AGAIN_MS = 10 * 60_000;

export function cacheRatesOf(model: string | null | undefined): ChipRates | null {
  return (model && byModel[model]) || null;
}

export async function loadCacheRates(model: string | null | undefined): Promise<void> {
  if (!model) return;
  const now = Date.now();
  if (readAt[model] && now - readAt[model] < AGAIN_MS) return;
  readAt[model] = now;
  try {
    byModel[model] = ratesFromWire(await api.cacheRates(model));
  } catch {
    // Not in the app (a harness), or the read failed: no figure.
  }
}

/**
 * The rates for the open chat's newest reply (item 699's price fix,
 * 2026-11-16): Claude Code's per-model store, else the API engine's
 * connection price — one rule for the composer's chip, the rail's cache
 * row and the top bars' cold toast. Starts a read when the model's rates
 * are not in yet; the figure appears when it lands.
 */
export function ratesForChat(
  model: string | null | undefined,
  connection: { engine?: string | null; price?: Parameters<typeof ratesFromPrice>[0] } | null | undefined,
): ChipRates | null {
  if (connection?.engine === "claude-code") {
    if (model) void loadCacheRates(model);
    return cacheRatesOf(model);
  }
  return ratesFromPrice(connection?.price);
}

/** Item 776: what the next send costs once cold (the whole history
 *  written), for the edit line's price; null with no reply or no rates. */
export function coldUsdFor(
  events: SessionEvent[],
  connection: Parameters<typeof ratesForChat>[1],
): number | null {
  return cacheEstimate(events, ratesForChat(lastReply(events)?.model, connection), true)?.cold ?? null;
}
