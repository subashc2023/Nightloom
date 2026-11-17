import type { Usage } from "./types";

/**
 * The cache chip's prices (items 699, 776), pure: no app state, so the phone
 * page imports them too (wave O, 2026-11-17, the phone's cache price). Moved
 * verbatim from `cacheCost.ts`, which re-exports them.
 */

/** Dollars as the toast and the chip say them: `$4.32`, `$0.40`, `<$0.01`, `$12`. */
export function usd(n: number): string {
  if (n < 0.005) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

export interface ChipRates {
  read: number;
  write: number;
  /** For the tooltip: "usage-rates.json", "37 keep-warm pings' CLI costs", … */
  from: string;
}

/** The backend's `usage::CacheRates`. */
export interface CacheRatesWire {
  model: string;
  read: number;
  write_1h: number;
  write_5m: number;
  source: "rates" | "pings" | "pings_ratio";
  pings: number;
  /** `pings_ratio` only: the row whose read : write ratio the fit held. */
  ratio_from?: string | null;
}

/** Claude Code writes the 1-hour kind. */
export function ratesFromWire(r: CacheRatesWire | null | undefined): ChipRates | null {
  if (!r) return null;
  const pings = `${r.pings} keep-warm ping${r.pings === 1 ? "" : "s"} on ${r.model}`;
  const from =
    r.source === "rates"
      ? `usage-rates.json's row for ${r.model}`
      : r.source === "pings_ratio"
        ? `a fit to the CLI's reported cost of ${pings}, across your projects, with the read : write ratio of ${r.ratio_from ?? "the API's standard shape"} (usage-rates.json has no row for ${r.model}, and its pings are all hits or all misses)`
        : `a fit to the CLI's reported cost of ${pings}, across your projects (usage-rates.json has no row for it)`;
  return { read: r.read, write: r.write_1h, from };
}

/** The next send's two prices from the newest reply's usage. */
export function nextSendCost(usage: Usage, r: ChipRates): { warm: number; cold: number } {
  const prompt = usage.input_tokens;
  const out = usage.output_tokens;
  return {
    warm: (prompt * r.read + out * r.write) / 1e6,
    cold: ((prompt + out) * r.write) / 1e6,
  };
}

/** The chip's addition: `next ≈ $0.40`. */
export function nextLine(usdNext: number): string {
  return `next ≈ ${usd(usdNext)}`;
}

/** The chip's estimate while warm, both prices on its face (item 776, his
 *  "im tryna figure out how much itll cost if i left the cache go cold.
 *  why isnt that information readily available"): `next ≈ $0.37 · cold ≈
 *  $4.32`; cold, the one price: `next ≈ $4.32`. */
export function chipNextLine(c: { warm: number; cold: number }, warm: boolean): string {
  return warm ? `${nextLine(c.warm)} · cold ≈ ${usd(c.cold)}` : nextLine(c.cold);
}

/** The estimate's tooltip line (item 776, his "biggest yapfest ever"): one
 *  short line, numbers first. ~~The context size, both rates per MTok,
 *  where the rates came from and the plan caveat~~ (cut 2026-11-16; the
 *  rates' source stays in `ChipRates.from` for whoever needs it). */
export function nextTitle(usage: Usage, r: ChipRates, warm: boolean): string {
  const c = nextSendCost(usage, r);
  return warm
    ? `Next send ≈ ${usd(c.warm)} · cold ≈ ${usd(c.cold)} (API price)`
    : `Cache cold · next send ≈ ${usd(c.cold)} (API price)`;
}
