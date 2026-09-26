/**
 * A changed prompt layer reaches a running chat at its first cold moment,
 * never by breaking a warm one (nightshift backlog 174). The backend holds
 * the texts (`prompt_hold.rs`); this is the shell's half, as data: when a
 * chat counts as cold, which marks are taken then, when the engine must be
 * reconnected before a turn, and the words the Context page's marks say.
 * Pinned by `promptVersions.test.ts`.
 *
 * "Cold" is the one notion `cliUpdate` uses (backlog 182): the chat's cache
 * timer (`cacheState`, backlog 063) has expired, or there is no cached turn
 * to keep warm.
 */
import { cacheState } from "./cache";
import { formatTokens } from "./cliUpdate";
import type { LayerChoice, PendingLayer, PendingView, PromptLayer, SessionEvent } from "./types";

/** The chat's cache is cold now: expired, or never written. */
export function chatIsCold(events: SessionEvent[], now: number): boolean {
  const c = cacheState(events, now);
  return c === null || !c.warm;
}

/** Whether a mark is taken at the next cold moment. Keep never is. */
export function takenAtCold(layer: PendingLayer, auto: boolean): boolean {
  return layer.choice === "cold" || (layer.choice === "auto" && auto);
}

/**
 * Reconnect before the turn? When the connection was built for another
 * chat than the one sending (its holds are not this chat's), and when the
 * chat is cold ~~and a mark is waiting for exactly that~~ (2026-09-26: any
 * cold turn — see the body).
 *
 * "Another chat" includes New chat on a connection built for an existing
 * one: that connection carries the old chat's held texts, which the CLI
 * would record as the new chat's own for good (batch review 2026-09-23,
 * finding 2). Connecting with no chat takes the fresh prompt whole.
 */
export function reconnectBeforeTurn(
  view: PendingView | null,
  activeSessionId: string | null,
  cold: boolean,
  _auto: boolean,
): boolean {
  if (!view) return false;
  if (view.session !== activeSessionId) return true;
  // ~~`cold && view.layers.some((l) => takenAtCold(l, auto))`~~ — superseded
  // 2026-09-26 (night batch F, measured): the view is only as new as the
  // last connect, so a file edited on disk since (his editor, the model's
  // `remember`, another chat's save) had no mark and was never taken at
  // cold. A cold chat now reconnects once before its turn whatever the
  // marks say; the connect lays the files against the hold and takes what
  // the choices allow (a kept layer stays kept). Cold is the one moment a
  // reconnect cannot cost a cache rewrite, and after the turn it is warm.
  return cold && activeSessionId !== null;
}

/**
 * The pending entry for one layer, if its file is newer — only while the
 * connection is the open chat's: the marks of the chat it was built for
 * are not this chat's (batch review 2026-09-23, finding 3).
 */
export function pendingFor(
  view: PendingView | null,
  kind: PromptLayer,
  activeSessionId: string | null,
): PendingLayer | null {
  if (!view || activeSessionId === null || view.session !== activeSessionId) return null;
  return view.layers.find((l) => l.kind === kind) ?? null;
}

// ---- the Settings default ----

export const LAYER_PREFS_KEY = "nightloom.layerUpdates";

export interface LayerPrefs {
  /** Take every changed layer at the chat's next cold moment by itself;
   *  off waits for *Update at the next cold moment* on each mark. */
  autoAtCold: boolean;
}

export function loadLayerPrefs(): LayerPrefs {
  try {
    const raw = localStorage.getItem(LAYER_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<LayerPrefs>;
      return { autoAtCold: p.autoAtCold !== false };
    }
  } catch {
    // Storage refused or unreadable: the default.
  }
  return { autoAtCold: true };
}

export function saveLayerPrefs(p: LayerPrefs): void {
  try {
    localStorage.setItem(LAYER_PREFS_KEY, JSON.stringify(p));
  } catch {
    // Not kept; the switch still applies for this run.
  }
}

// ---- the words ----

/** The mark's state line. */
export function markLine(layer: PendingLayer, auto: boolean, cold: boolean): string {
  if (layer.choice === "keep") return "Keeping this chat's version — the file has a newer one.";
  const gone = layer.newer === "" ? "The file is gone" : "Newer version exists";
  if (takenAtCold(layer, auto))
    return cold
      ? `${gone}: taken with this chat's next message (its cache is cold, so it costs nothing extra).`
      : `${gone}: taken at this chat's next cold moment — its cache stays warm until then.`;
  return `${gone}: this chat still reads the version it started with.`;
}

/** *Update now*'s price, said on the button's title and beside it. */
export function updateNowCost(tokens: number | null, cold: boolean): string {
  if (cold) return "The cache is cold: updating now rewrites nothing extra.";
  if (tokens === null) return "Rewrites this chat's whole cache on the next message (size unknown).";
  return `Rewrites ~${formatTokens(tokens)} tokens of cache on the next message.`;
}

/** The choices a mark offers besides *Update now*, in order. */
export function choicesFor(layer: PendingLayer, auto: boolean): { choice: LayerChoice; label: string }[] {
  const out: { choice: LayerChoice; label: string }[] = [];
  if (layer.choice === "keep") out.push({ choice: auto ? "auto" : "cold", label: "Update at the next cold moment" });
  else {
    if (!takenAtCold(layer, auto)) out.push({ choice: "cold", label: "Update at the next cold moment" });
    out.push({ choice: "keep", label: "Keep this version" });
  }
  return out;
}
