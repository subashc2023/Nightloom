/**
 * The rates the composer's `next ≈ $…` estimate uses (item 699), per
 * model, as the backend's `cache_rates` reads them: `usage-rates.json`'s
 * row, else a fit to the project's keep-warm pings. Read once per model
 * and again after ten minutes (a new ping may sharpen the fit); a failed
 * read is no figure, never a guess.
 */
import * as api from "./api";
import { ratesFromWire, type ChipRates } from "./cacheCost";

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
