import type { CacheKey, CacheTtl, ChatKind, SessionEvent } from "./types";
import { declaredKind, liveFlags } from "./state.svelte";

/**
 * The prompt-cache timer (nightshift backlog 063, 2026-09-15): when the
 * last turn's cache entry expires, projected from the log.
 *
 * Every turn records when its request was *sent* and how long the cache it
 * left lives (`sent_at`, `cache_ttl` on `assistant_message` — the backend
 * reads the lifetime off the reply's `cache_creation` split, or falls back
 * to what the engine writes with). The clock runs from the send, not the
 * reply: the API measures the lifetime from the start of the request that
 * wrote or last read the entry, and a turn that streamed for four minutes
 * leaves one on a five-minute entry. Every read refreshes the entry, so
 * the newest turn is the one that matters.
 *
 * Projected from the log rather than held in memory so that reopening a
 * chat — or relaunching the app — shows the same countdown the chat had.
 * Nothing here knows which engine ran the turn; the top bar pairs the
 * result with the connection's engine for its caveat, since that is the
 * engine the *next* request goes to.
 */
export interface CacheState {
  /** When the request that wrote or last read the entry was sent, ms epoch. */
  sentAt: number;
  ttl: CacheTtl;
  /** When the entry expires, ms epoch: `sentAt` plus the lifetime. */
  warmUntil: number;
  /** `warmUntil - now`; at or below zero the cache is cold. */
  remainingMs: number;
  warm: boolean;
  /** Item 677: set when an aside's read is what keeps the entry — the
   *  share of the reply's context it read from cache (0.53 for his). */
  asideShare?: number;
}

/**
 * An answered aside's read of the chat's cache (item 677): when its
 * request went out (ms epoch) and what its newest round read from cache.
 */
export interface AsideRead {
  at: number;
  read: number;
}

/**
 * Whether an aside's read refreshed the reply's entry (item 677): sent
 * after the reply, and a read of at least half the reply's context — the
 * keep-warm ping's own hit rule (`keep_warm::aside_refreshes`), so the bar
 * and the next ping agree. Under half, the aside matched only the head of
 * the prefix, and the rest still runs out on the reply's hour.
 */
export function asideRefreshes(r: AsideRead, replySentAt: number, context: number): boolean {
  return r.at > replySentAt && r.read * 2 >= context;
}

const TTL_MS: Record<CacheTtl, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

/**
 * The newest *live* turn's cache, or null before the first turn that
 * recorded one — which includes every chat logged before the fields
 * existed, since a countdown invented from `at` would be the wrong clock.
 *
 * Live, after the rewind flags, on purpose: a rewound turn's entry is still
 * real on the server, but the next request will not share its prefix — the
 * conversation now ends earlier — so the entry that matters is the newest
 * one the next request can actually hit.
 *
 * `keptUntil` (backlog 582): when the chat's keep-warm has pinged since
 * that reply, the moment the last ping's hour ends (`touchedUntil`); the
 * later of the two is when the cache goes cold.
 *
 * `asides` (item 677, his "it doesn't update in the aside that cache bar
 * still stays where it was"): the chat's answered asides' reads. An aside
 * is a fork of the chat on its cache, so one that read at least half the
 * context (`asideRefreshes`) restarts the entry's lifetime from its send.
 * Only the share it read is refreshed; at half or more the bar counts from
 * it — a whole countdown it can honour for most of the history — and
 * `asideShare` lets the tooltip say how much.
 */
export function cacheState(
  events: SessionEvent[],
  now: number,
  keptUntil?: number | null,
  asides?: readonly AsideRead[],
): CacheState | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    if (!e.sent_at || !e.cache_ttl) return null;
    const sentAt = Date.parse(e.sent_at);
    if (!Number.isFinite(sentAt)) return null;
    const ttl = TTL_MS[e.cache_ttl];
    const own = sentAt + ttl;
    // A keep-warm ping read the entry after the reply did (backlog 582):
    // its hour runs from that read. `keptUntil` is when that one ends.
    const kept = keptUntil != null && keptUntil > own;
    let warmUntil = kept ? keptUntil : own;
    // An aside read it later still (item 677): its lifetime runs from that.
    const context = e.usage.input_tokens + e.usage.output_tokens;
    let side: AsideRead | null = null;
    for (const r of asides ?? []) if (asideRefreshes(r, sentAt, context) && (!side || r.at > side.at)) side = r;
    const byAside = side !== null && side.at + ttl >= warmUntil;
    if (byAside) warmUntil = side!.at + ttl;
    const remainingMs = warmUntil - now;
    const out: CacheState = { sentAt: kept || byAside ? warmUntil - ttl : sentAt, ttl: e.cache_ttl, warmUntil, remainingMs, warm: remainingMs > 0 };
    if (byAside && context > 0) out.asideShare = Math.min(1, side!.read / context);
    return out;
  }
  return null;
}

/** Below this much left the display counts seconds rather than minutes. */
const SECONDS_BELOW_MS = 2 * 60_000;

/**
 * What is left, as the chip shows it: whole minutes floored (`41 min` at
 * 41:59 — never a minute the cache does not have), `m:ss` at two minutes
 * and under, and null once it is gone. Floors throughout, so the number
 * shown is always one the cache can still honour.
 */
export function remainingText(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  if (remainingMs > SECONDS_BELOW_MS) return `${Math.floor(remainingMs / 60_000)} min`;
  const s = Math.floor(remainingMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The top bar's line: `cache · 41 min`, `cache · 1:59`, `cache cold`. */
export function cacheLine(state: CacheState): string {
  const left = remainingText(state.remainingMs);
  return left ? `cache · ${left}` : "cache cold";
}

/**
 * The same fact as a clause for the edit controls (nightshift backlog 062):
 * "the cache is warm for 41 min" or "the cache is cold".
 */
export function cacheClause(state: CacheState | null): string {
  const left = state ? remainingText(state.remainingMs) : null;
  return left ? `the cache is warm for ${left}` : "the cache is cold";
}

/**
 * How long until `remainingText` would read differently: just past the
 * next whole minute while it counts minutes (or past the two-minute mark,
 * whichever comes first), just past the next whole second under that, and
 * null once it is cold. "Just past" because a floored value changes the
 * millisecond *after* the boundary, not on it. A timer aligned to these
 * wakes once a minute and then once a second, and never shows a value a
 * second stale.
 */
export function nextTickMs(remainingMs: number): number | null {
  if (remainingMs <= 0) return null;
  if (remainingMs <= SECONDS_BELOW_MS) return (remainingMs % 1000) + 1;
  return Math.min((remainingMs % 60_000) + 1, remainingMs - SECONDS_BELOW_MS + 1);
}

/**
 * What the cache was built with (nightshift backlog 408, 2026-10-24): the
 * newest live reply's recorded settings, and how many tokens its request
 * left in the cache (read plus written — the prefix the next request would
 * otherwise read back). The same reply `cacheState` times. Null when that
 * reply recorded no settings: every log before the field, the API engine,
 * and a stand-in reply — and then nothing is warned, never a guess.
 */
export interface CacheBuilt {
  key: CacheKey;
  cachedTokens: number;
}

export function cacheBuiltWith(events: SessionEvent[]): CacheBuilt | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    if (!e.cache_key) return null;
    const cachedTokens = (e.usage.cache_read_tokens ?? 0) + (e.usage.cache_write_tokens ?? 0);
    return { key: e.cache_key, cachedTokens };
  }
  return null;
}

/** The settings the next turn goes out with — the rail's draft fields. */
export interface PendingSettings {
  engine: string;
  agentModel: string;
  /** The API engine's model pick (item 601); "" is the provider's default. */
  model?: string;
  tools: boolean;
  agentSafeMode: boolean;
  approval: boolean;
  agentAsk: boolean;
  agentPlan: boolean;
  /** The API engine's thinking pick (item 635): "default" | "effort-LEVEL" |
   *  "budget" with `budget` — the connection draft's fields. Absent, the
   *  thinking setting is not compared. */
  thinkingMode?: string;
  budget?: number;
}

/**
 * What else the next turn goes out with that is not a draft field (item
 * 601): the chat's declared kind now (`declaredKind`, which a kind switch
 * moves) and when the cache was built (`kindAtCache`), and, on the API engine, the model the connection resolved — the
 * draft's may be empty for "the provider's default", which is not what
 * the reply recorded.
 */
export interface PendingContext {
  kind?: ChatKind;
  builtKind?: ChatKind | null;
  apiModel?: string;
}

/** One setting that differs from what built the cache. `whole` is false
 *  where the measured change re-sent only the conversation after the
 *  system head, so the tooltip says "up to". */
export interface CacheChange {
  what: "model" | "tools" | "safe mode" | "plan" | "engine" | "kind" | "thinking";
  text: string;
  whole: boolean;
  /** False where a click cannot put it back (item 601: a Chat switched to
   *  Claude Code has declared its tools for good — `declaredKind`). */
  restorable?: boolean;
}

/** The engine a recorded key names, as the draft's `engine` spells it. */
const draftEngine = (keyEngine: string): string => (keyEngine === "claude-code" ? "claude-code" : "provider");
const engineName = (draft: string): string => (draft === "claude-code" ? "Claude Code" : "API");

/**
 * The declared kind (`declaredKind`) the cache's reply was built under:
 * the creation line and the kind switches logged before that reply (item
 * 601). Null when no live reply recorded settings, as `cacheBuiltWith`.
 */
export function kindAtCache(events: SessionEvent[]): ChatKind | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    if (!e.cache_key) return null;
    return declaredKind(events.slice(0, i + 1));
  }
  return null;
}

const isHaiku = (m: string): boolean => /haiku/i.test(m);

/** The draft's thinking as the backend sends it (`catalog.ts`
 *  `thinkingString`, on the draft fields this module has), or null when
 *  the draft carries none. */
function draftThinking(p: PendingSettings): string | null {
  const mode = p.thinkingMode;
  if (mode == null) return null;
  if (mode === "budget") return `budget=${Math.max(1, Math.floor(p.budget ?? 0))}`;
  if (mode.startsWith("effort-")) return `effort=${mode.slice(7)}`;
  return "default";
}

/** A recorded thinking setting in his words: `default`, `high effort`,
 *  `budget 8000`. */
function thinkingWords(t: string): string {
  if (t.startsWith("effort=")) return `${t.slice(7)} effort`;
  if (t.startsWith("budget=")) return `budget ${t.slice(7)}`;
  return t;
}

/**
 * The pending settings that would lose the cache (backlog 408) — only the
 * ones measured to (Claude Code 2.1.310, 2026-10-24; nightshift
 * `notes/runner-design/408-report-2026-10-24.md`):
 * - the model (Haiku → Opus read back only the 11k head every chat shares);
 * - tools on/off (tools off read back nothing);
 * - safe mode (everything after the first ~31k re-sent);
 * - the Plan position, **on Haiku only**: the CLI runs a Haiku chat's Plan
 *   turn on Sonnet, a model change; on Opus Plan kept the cache.
 * Effort, Chrome, connectors and fork mode were measured to keep it. The
 * API engine and a switch between engines were not measured (blocker
 * 1517), so either side off Claude Code warns of nothing.
 * ~~(that last sentence)~~ — superseded by item 601, 2026-11-10 (his "the
 * second something is changed to not aligned w it then that cache
 * restoration situation should show up"). Now also:
 * - an engine switch, either way (Claude Code ↔ API): the two send
 *   different system prompts and tool lists under different accounts'
 *   caches, so nothing can be read back (inferred from code; the API
 *   engine's replies carry a key since 601, engine `"api"`). Alone, since
 *   nothing else compares across engines;
 * - the kind, a Chat born as a Chat switched to Claude Code — the one
 *   switch that changes the declared tools (`kindSwitchCost`, backlog
 *   144); not restorable, the declaration stands once made;
 * - on the API engine, the model: a cache entry is per model (`external`:
 *   Anthropic's prompt-caching docs claim so). Not measured here.
 * - on the API engine, the Tools switch and the thinking setting (item
 *   635), where the reply's key recorded them (`tools_switch`, `thinking`).
 * Still not warned, each checked: effort, Chrome (the browser), claude.ai
 * connectors and fork mode were measured to keep it (408's table); a
 * changed prompt layer is held for the cold moment (backlog 174), so it
 * never reaches a warm cache unless he picks "update now".
 */
export function cacheLoss(key: CacheKey, p: PendingSettings, ctx: PendingContext = {}): CacheChange[] {
  const builtOn = draftEngine(key.engine);
  if (builtOn !== p.engine) {
    return [{ what: "engine", text: `engine ${engineName(builtOn)} → ${engineName(p.engine)}`, whole: true }];
  }
  if (key.engine !== "claude-code") {
    const was = key.model ?? "";
    const now = ctx.apiModel?.trim();
    if (now && was && was !== now) return [{ what: "model", text: `model ${was} → ${now}`, whole: true }];
    // Item 635: the Tools switch and the thinking setting, compared only
    // where the key recorded them — a key logged before then warns of
    // neither. Both lose it whole (`external`: Anthropic's prompt-caching
    // page claims a tool change invalidates the whole cache, and a thinking
    // change the messages always and the tools and system on some models).
    const out: CacheChange[] = [];
    if (key.tools_switch != null && key.tools_switch !== p.tools) {
      out.push({ what: "tools", text: p.tools ? "tools on" : "tools off", whole: true });
    }
    const thinkingNow = draftThinking(p);
    if (key.thinking != null && thinkingNow != null && key.thinking !== thinkingNow) {
      out.push({
        what: "thinking",
        text: `thinking ${thinkingWords(key.thinking)} → ${thinkingWords(thinkingNow)}`,
        whole: true,
      });
    }
    return out;
  }
  const out: CacheChange[] = [];
  const was = key.model ?? "";
  const now = p.agentModel.trim();
  if (was !== now) out.push({ what: "model", text: `model ${was || "default"} → ${now || "default"}`, whole: true });
  if (key.tools !== p.tools) out.push({ what: "tools", text: p.tools ? "tools on" : "tools off", whole: true });
  if (key.safe_mode !== p.agentSafeMode) {
    out.push({ what: "safe mode", text: p.agentSafeMode ? "safe mode on" : "safe mode off", whole: false });
  }
  const planNow = p.approval && p.agentPlan;
  if (key.plan !== planNow && (isHaiku(was) || isHaiku(now))) {
    out.push({ what: "plan", text: planNow ? "plan mode on" : "plan mode off", whole: true });
  }
  if (ctx.builtKind === "chat" && ctx.kind === "build") {
    out.push({ what: "kind", text: "Chat → Claude Code", whole: true, restorable: false });
  }
  return out;
}

/** The chip's words while a change would lose a warm cache:
 *  `cache will be lost · model haiku → opus, tools off`. */
export function cacheLossLine(changes: CacheChange[]): string {
  return `cache will be lost · ${changes.map((c) => c.text).join(", ")}`;
}

/** Its tooltip: what changed, what the next turn would re-send, and what
 *  a click does. */
export function cacheLossTitle(changes: CacheChange[], cachedTokens: number, remainingMs: number): string {
  const n = cachedTokens.toLocaleString("en-US");
  const whole = changes.some((c) => c.whole);
  const left = remainingText(remainingMs);
  const resend = whole
    ? `the next turn re-sends the ${n} tokens this chat's cache holds at full price instead of reading them back`
    : `the next turn re-sends up to ${n} of the tokens this chat's cache holds (the conversation after the system prompt) at full price`;
  return (
    `Changed since this chat's cache was built: ${changes.map((c) => c.text).join(", ")} — ${resend}. ` +
    clickClause(changes, left)
  );
}

/** Whether a click on the chip puts anything back (item 601). */
export function canRestore(changes: CacheChange[]): boolean {
  return changes.some((c) => c.restorable !== false);
}

/** The engine a click switches back to, when an engine change is named. */
export function restoreEngine(key: CacheKey, changes: CacheChange[]): string | null {
  return changes.some((c) => c.what === "engine") ? draftEngine(key.engine) : null;
}

function clickClause(changes: CacheChange[], left: string | null): string {
  const warm = left ? ` (the cache is warm for ${left})` : "";
  const fixed = changes.filter((c) => c.restorable === false);
  const back = changes.length - fixed.length;
  const cannot = fixed.length
    ? ` ${fixed.map((c) => c.text).join(", ")} cannot be put back: a chat switched to Claude Code keeps its tools declared from then on.`
    : "";
  if (back === 0) return `Nothing to click${warm}.${cannot}`;
  return `Click to put ${back === 1 ? "it" : "them"} back${warm}.${cannot}`;
}

/**
 * Put back every changed setting (backlog 408): the draft fields named in
 * `changes`, to what built the cache. The caller reconnects. Plan restored
 * on brings approval and Ask with it (Plan implies both); Plan restored
 * off leaves the Ask position if the cache was built on Ask, else Auto.
 */
export function restoreCacheSettings(key: CacheKey, changes: CacheChange[], d: PendingSettings): void {
  for (const c of changes) {
    // Item 601: the engine is put back by the caller (`useEngine`, which
    // drops the other engine's connection), and the kind cannot be.
    if (c.what === "engine" || c.what === "kind") continue;
    if (c.what === "model") {
      if (key.engine === "claude-code") d.agentModel = key.model ?? "";
      else d.model = key.model ?? "";
    } else if (c.what === "tools") d.tools = key.engine === "claude-code" ? key.tools : (key.tools_switch ?? key.tools);
    else if (c.what === "thinking") restoreThinking(key.thinking ?? "default", d);
    else if (c.what === "safe mode") d.agentSafeMode = key.safe_mode;
    else if (key.plan) {
      d.approval = true;
      d.agentAsk = true;
      d.agentPlan = true;
    } else {
      d.agentPlan = false;
      d.agentAsk = key.ask ?? false;
    }
  }
}

/** Put a recorded thinking setting back on the draft (item 635), the
 *  inverse of `draftThinking`. */
function restoreThinking(t: string, d: PendingSettings): void {
  if (t.startsWith("effort=")) d.thinkingMode = `effort-${t.slice(7)}`;
  else if (t.startsWith("budget=")) {
    d.thinkingMode = "budget";
    d.budget = Number(t.slice(7));
  } else d.thinkingMode = "default";
}
