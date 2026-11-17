import type { SessionEvent, Usage } from "./types";
import { cacheBuiltWith, cacheLoss, kindAtCache, type CacheChange, type PendingSettings } from "./cache";
import type { ChipRates } from "./cacheCost";
import { lastReply, ratesFromPrice, tokensShort, usd } from "./cacheCost";
import { declaredKind } from "./state/threads.svelte";
import { liveFlags } from "./state.svelte";
import { promptLayerEdits, promptLayersOff, sameEdits, sameLayers } from "./state/layers.svelte";
import { isFullId, type SeenModels } from "./modelSeen";

/**
 * What the pending change set costs on the next send (item 777, his ask
 * 2026-11-16: "why ... doesnt it tell me how much itll cost now that ive
 * made this change"): the next send's estimate **with** the change against
 * **without** it, from the cache's order — tools, then system, then
 * messages. Everything from the first changed block on is written at the
 * target model's write rate; what comes before it is read at its read rate.
 *
 * Where the change starts, by kind (inferred from the measurements cited):
 * - **whole** (`CacheChange.whole`: model, engine, tools, kind, thinking on
 *   the API engine, Plan on Haiku): nothing is read back; a model switch is
 *   priced at the new model's rates (a cache entry is per model);
 * - **safe mode**: 408 measured everything after the first ~31k re-sent;
 * - **a prompt layer** (notes, practices, memory, a layer's own text):
 *   from the system block that holds Nightloom's appended prompt — 727
 *   measured the head before it at 12,779 tokens (tools plus the CLI's
 *   first two system blocks) on the Claude Code engine. On the API engine
 *   the system prompt follows only the tools, whose size is not known
 *   here, so nothing is counted as read (which overstates, never under).
 * The head is a measured constant, not this chat's: its error is the head
 * itself at the read-write difference (12.8k × ~$10/MTok ≈ $0.12 on Opus),
 * small beside the re-write of the history it sits in front of.
 *
 * Not changes (measured to keep the cache, 408's table): effort on Claude
 * Code, Chrome, claude.ai connectors, fork mode. A keep-warm ping runs on
 * the settings the cache was built with (its `fork-spec.json`, 727), so a
 * pending change never reaches the cache before he sends.
 */

/** Tokens before the system block that holds Nightloom's prompt (727). */
export const LAYER_HEAD = 12_779;
/** Tokens before the first block a safe-mode switch changes (408). */
export const SAFE_MODE_HEAD = 31_000;
/** Characters per token for text whose count is not known (spec, 777). */
export const CHARS_PER_TOKEN = 4;

/** A prompt-layer change logged since the reply the cache was built by,
 *  set against what built it — a switch turned off and on again, or an
 *  edit taken back, is no change. `addedTokens` is the change in size of
 *  the layers' own texts where both sides are known (an override's text),
 *  else 0 (a switched layer's file text is not read here). */
export interface LayerChange {
  text: string;
  addedTokens: number;
}

export function layerChangeSinceCache(events: SessionEvent[]): LayerChange | null {
  const live = liveFlags(events);
  let at = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (live[i] && e.event === "assistant_message") {
      if (e.cache_key) at = i;
      break;
    }
  }
  if (at < 0) return null;
  const before = events.slice(0, at + 1);
  const offWas = promptLayersOff(before);
  const offNow = promptLayersOff(events);
  const editsWas = promptLayerEdits(before);
  const editsNow = promptLayerEdits(events);
  const sameOff = sameLayers(offWas, offNow);
  if (sameOff && sameEdits(editsWas, editsNow)) return null;
  const words: string[] = [];
  const offed = offNow.filter((l) => !offWas.includes(l));
  const oned = offWas.filter((l) => !offNow.includes(l));
  if (offed.length) words.push(`${offed.map(layerName).join(", ")} off`);
  if (oned.length) words.push(`${oned.map(layerName).join(", ")} on`);
  let added = 0;
  const kinds = new Set([...Object.keys(editsWas), ...Object.keys(editsNow)]);
  const edited: string[] = [];
  for (const k of kinds) {
    const a = (editsWas as Record<string, string | undefined>)[k];
    const b = (editsNow as Record<string, string | undefined>)[k];
    if (a === b) continue;
    edited.push(layerName(k));
    if (a != null && b != null) added += Math.round((b.length - a.length) / CHARS_PER_TOKEN);
  }
  if (edited.length) words.push(`${edited.join(", ")} edited`);
  return { text: words.join(", ") || "prompt layers changed", addedTokens: added };
}

function layerName(l: string): string {
  return l.replace(/_/g, " ");
}

/** A draft model as a full id for its rates: a full id is itself, an
 *  alias what it last resolved to on this CLI (`modelSeen`), else null —
 *  no rates, never a guess. */
export function modelIdFor(model: string, seen: SeenModels): string | null {
  const m = model.trim();
  if (isFullId(m)) return m;
  return seen[m]?.id ?? null;
}

/** The next send, priced both ways. */
export interface ChangePrice {
  /** Tokens written afresh with the change. */
  rewrite: number;
  /** Tokens still read back with it. */
  read: number;
  /** USD with the change, null without rates for the model it goes to. */
  with: number | null;
  /** USD without it (the cache read back), null without the built model's rates. */
  without: number | null;
  /** The cache is already cold: the change costs nothing extra. */
  cold: boolean;
}

export interface PriceIn {
  usage: Usage;
  /** The draft changes (`cacheLoss`), [] when none. */
  changes: CacheChange[];
  /** A logged prompt-layer change, or null. */
  layers: LayerChange | null;
  /** The rates of the model the cache was built on. */
  built: ChipRates | null;
  /** The rates of the model the next send goes to (the same when no
   *  model change is pending). */
  target: ChipRates | null;
  warm: boolean;
  engine: "claude-code" | "api";
}

/** Where the re-write starts, in tokens from the head; 0 is everything. */
function headOf(p: PriceIn, prompt: number): number {
  if (p.changes.some((c) => c.whole)) return 0;
  let head = prompt;
  if (p.changes.some((c) => c.what === "safe mode")) head = Math.min(head, SAFE_MODE_HEAD);
  if (p.layers) head = Math.min(head, p.engine === "claude-code" ? LAYER_HEAD : 0);
  return Math.max(0, Math.min(head, prompt));
}

export function changePrice(p: PriceIn): ChangePrice {
  const prompt = p.usage.input_tokens;
  const out = p.usage.output_tokens;
  const added = p.layers?.addedTokens ?? 0;
  const ctx = Math.max(0, prompt + out + added);
  if (!p.warm) {
    // Cold: everything is written either way, at the model it goes to.
    const c = p.target ? (ctx * p.target.write) / 1e6 : null;
    return { rewrite: ctx, read: 0, with: c, without: c, cold: true };
  }
  const head = headOf(p, prompt);
  const rewrite = ctx - head;
  const withUsd = p.target ? (head * p.target.read + rewrite * p.target.write) / 1e6 : null;
  const withoutUsd = p.built ? (prompt * p.built.read + out * p.built.write) / 1e6 : null;
  return { rewrite, read: head, with: withUsd, without: withoutUsd, cold: false };
}

/** The bar's price, numbers first: `next ≈ $2.10 (vs $0.02 warm)`;
 *  without rates the tokens: `re-writes 180k`; cold: `cold, no extra ·
 *  next ≈ $2.10`. */
export function priceLine(c: ChangePrice): string {
  if (c.cold) return c.with != null ? `no extra, cache cold · next ≈ ${usd(c.with)}` : "no extra, cache cold";
  if (c.with == null) return `re-writes ${tokensShort(c.rewrite)} · no price for the new model`;
  const vs = c.without != null ? ` (vs ${usd(c.without)} warm)` : "";
  return `next ≈ ${usd(c.with)}${vs}`;
}

/** One short tooltip line, numbers first: `180k written at $10/MTok, 13k
 *  read at $0.50 — rates from …` (his rule: two short lines at most). */
export function priceTitle(c: ChangePrice, target: ChipRates | null): string {
  if (c.cold) return "The cache is cold: the next send writes it all whether or not you change anything.";
  const read = c.read > 0 ? `, ${tokensShort(c.read)} still read` : "";
  const at = target ? ` at $${target.write.toFixed(2)}/MTok` : "";
  return `${tokensShort(c.rewrite)} re-written${at}${read} — an API-price estimate, not a bill.`;
}

/** A model menu row's price for switching, put first in the row's detail
 *  so a narrow menu's ellipsis never eats it — numbers first, to `rowModel` while the cache is
 *  warm (777: the picker says it before he commits), or "" — the row of
 *  the model the cache is on, a cold cache, or no rates. */
export function switchDetail(
  usage: Usage | null,
  builtModelId: string | null,
  rowModelId: string | null,
  rates: ChipRates | null,
  warm: boolean,
): string {
  if (!usage || !warm || !rowModelId || !builtModelId || rowModelId === builtModelId) return "";
  const ctx = usage.input_tokens + usage.output_tokens;
  if (!rates) return `re-writes ${tokensShort(ctx)}`;
  return `next ≈ ${usd((ctx * rates.write) / 1e6)}`;
}

/**
 * The whole rule in one place (item 777), for the composer's bar and the
 * rail's *Next send* row alike: the draft changes against what built the
 * warm cache (`cacheLoss`), a logged prompt-layer change, and the rates of
 * the model each side runs on. Null with no change, a cold cache, no
 * reply, or no recorded key. `rates(model)` reads the per-model store
 * (starting a read when it is not in yet).
 */
export function pendingChangeCost(a: {
  events: SessionEvent[];
  draft: PendingSettings;
  connection: { engine?: string | null; model?: string | null; price?: Parameters<typeof ratesFromPrice>[0] } | null | undefined;
  seen: SeenModels;
  warm: boolean;
  rates: (model: string | null) => ChipRates | null;
}): { price: ChangePrice; line: string; title: string; changes: CacheChange[]; layers: LayerChange | null } | null {
  if (!a.warm) return null;
  const built = cacheBuiltWith(a.events);
  const last = lastReply(a.events);
  if (!built || !last) return null;
  const cc = a.connection?.engine === "claude-code";
  const changes = cacheLoss(built.key, a.draft, {
    kind: declaredKind(a.events),
    builtKind: kindAtCache(a.events),
    apiModel: a.connection && !cc ? (a.connection.model ?? undefined) : undefined,
  });
  const layers = layerChangeSinceCache(a.events);
  if (changes.length === 0 && !layers) return null;
  const modelPending = built.key.engine === "claude-code" && (built.key.model ?? "") !== a.draft.agentModel.trim();
  const engineChange = changes.some((c) => c.what === "engine");
  const targetModel = modelPending ? modelIdFor(a.draft.agentModel, a.seen) : last.model;
  const target = engineChange ? null : cc ? a.rates(targetModel) : ratesFromPrice(a.connection?.price);
  const builtRates = cc ? a.rates(last.model) : changes.some((c) => c.what === "model" || engineChange) ? null : target;
  const price = changePrice({
    usage: last.usage,
    changes,
    layers,
    built: builtRates,
    target,
    warm: true,
    engine: cc ? "claude-code" : "api",
  });
  return { price, line: priceLine(price), title: priceTitle(price, target), changes, layers };
}

/** The model the next send goes to on Claude Code (item 777): the draft's,
 *  resolved, when it differs from what built the cache; else the newest
 *  reply's. The composer's chip and the rail price the cold send by it. */
export function nextSendModel(events: SessionEvent[], draftModel: string, seen: SeenModels): string | null {
  const last = lastReply(events);
  const built = cacheBuiltWith(events);
  if (built && built.key.engine === "claude-code" && (built.key.model ?? "") !== draftModel.trim()) return modelIdFor(draftModel, seen);
  return last?.model ?? null;
}
