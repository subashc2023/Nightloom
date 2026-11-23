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
import { nextSendModel } from "./changeCost";
import type { SeenModels } from "./modelSeen";

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

/** Item 902: the next send's pick, for the rates of the model it goes to. */
export interface NextPick {
  draftModel: string;
  seen: SeenModels;
}

/** Item 902: the rates of the model the next send goes to — on Claude Code
 *  the composer's pick (`nextSendModel`), not the newest reply's; the API
 *  engine's connection already carries the picked model's price. Without a
 *  pick, the newest reply's model (the old rule). */
export function nextSendRates(
  events: SessionEvent[],
  connection: Parameters<typeof ratesForChat>[1],
  pick?: NextPick | null,
): ChipRates | null {
  if (pick && connection?.engine === "claude-code") return ratesForChat(nextSendModel(events, pick.draftModel, pick.seen), connection);
  return ratesForChat(lastReply(events)?.model, connection);
}

/** Item 776: what the next send costs once cold (the whole history
 *  written), for the edit line's price; null with no reply or no rates.
 *  Item 902: at the picked model's rates when `pick` is given. */
export function coldUsdFor(
  events: SessionEvent[],
  connection: Parameters<typeof ratesForChat>[1],
  pick?: NextPick | null,
): number | null {
  return cacheEstimate(events, nextSendRates(events, connection, pick), true)?.cold ?? null;
}
