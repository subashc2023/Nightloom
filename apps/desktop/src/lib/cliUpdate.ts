/**
 * Claude Code's version and its update, as data (nightshift backlog 182):
 * the switch, the check's cadence, the notice's words, and the cold-moment
 * rule. `cliUpdate.svelte.ts` runs the checks and the update;
 * `CliUpdateActions.svelte` draws the buttons in the bell and in Settings.
 * Nothing here touches the store, so every rule is pinned by
 * `cliUpdate.test.ts`.
 *
 * Why a cold moment (backlog 174's rule): a new CLI changes the prefix
 * every chat sends, so each chat's next message rewrites its whole cache.
 * A chat whose cache has already expired pays that write anyway; a warm
 * one pays it only because of the update. So the default waits until no
 * turn runs and every open chat's cache is cold, and "now" says first how
 * many tokens the warm ones would rewrite.
 */
import type { CliNewModel, CliStatus, CliUpdateResult } from "./types";

// ---- the switch and the cadence ----

export const CLI_PREFS_KEY = "nightloom.cliUpdate";
/** How often the version is checked while the app is open. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** The first check after launch waits this long, off the start-up path. */
export const FIRST_CHECK_MS = 20_000;
/** How often a waiting update (or the automatic switch) looks for a cold moment. */
export const COLD_TICK_MS = 60_000;

export interface CliPrefs {
  /** Settings → "Keep Claude Code up to date": update by itself at the
   *  first cold moment after a release. Off by default — he never chose to
   *  turn the CLI's own updater back on. */
  auto: boolean;
  /** When the last check answered, ms epoch. */
  lastCheck: number | null;
  /** The release an automatic update already failed on: not retried by
   *  itself (Update still tries), so a broken download is not re-run every
   *  minute. */
  autoFailedFor: string | null;
}

export function parseCliPrefs(raw: string | null): CliPrefs {
  const d: CliPrefs = { auto: false, lastCheck: null, autoFailedFor: null };
  if (!raw) return d;
  try {
    const v = JSON.parse(raw);
    return {
      auto: v?.auto === true,
      lastCheck: typeof v?.lastCheck === "number" && Number.isFinite(v.lastCheck) ? v.lastCheck : null,
      autoFailedFor: typeof v?.autoFailedFor === "string" ? v.autoFailedFor : null,
    };
  } catch {
    return d;
  }
}

export function loadCliPrefs(): CliPrefs {
  try {
    return parseCliPrefs(localStorage.getItem(CLI_PREFS_KEY));
  } catch {
    return parseCliPrefs(null);
  }
}

export function saveCliPrefs(p: CliPrefs): void {
  try {
    localStorage.setItem(CLI_PREFS_KEY, JSON.stringify(p));
  } catch {
    // A full or blocked store costs the remembered switch, nothing else.
  }
}

/** A check is due: never checked, or the last one is six hours old. */
export function checkDue(lastCheck: number | null, now: number): boolean {
  return lastCheck === null || now - lastCheck >= CHECK_EVERY_MS;
}

// ---- the notice ----

/** A status that offers an update: behind, and the updater not switched off. */
export function offersUpdate(s: CliStatus | null): boolean {
  return !!s && s.behind && !!s.installed && !!s.latest && !s.updates_disabled;
}

/** Stable while the two versions are: a dismissed notice returns only for
 *  a newer release. */
export function cliNoticeId(s: CliStatus): string {
  return `cli:${s.installed ?? "?"}->${s.latest ?? "?"}`;
}

/** "Claude Code 2.1.263 → 2.1.280 · new model: Opus 5.5". */
export function cliNoticeTitle(s: CliStatus): string {
  const head = `Claude Code ${s.installed ?? "?"} → ${s.latest ?? "?"}`;
  const names = s.new_models.map((m) => m.name);
  if (names.length === 0) return head;
  return `${head} · new model${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}

/**
 * What Nightloom lacks for a new model, or null when it has everything:
 * "no price or context window in Nightloom yet", "not in the Anthropic
 * model list". The price and window are the backend's table rows (an
 * id's own row, not its family's); the list is the provider engine's
 * curated ids. The Claude Code engine's pickers name aliases, which follow
 * the CLI, so nothing is missing there.
 */
export function modelGap(m: CliNewModel, curated: string[]): string | null {
  const tables: string[] = [];
  if (!m.has_price) tables.push("price");
  if (!m.has_window) tables.push("context window");
  const parts: string[] = [];
  if (tables.length) parts.push(`no ${tables.join(" or ")} in Nightloom yet`);
  if (!curated.includes(m.id)) parts.push("not in the Anthropic model list");
  return parts.length ? parts.join("; ") : null;
}

/** The notice's second line: each new model's gap, or that the notes
 *  could not be read. */
export function cliNoticeDetail(s: CliStatus, curated: string[]): string {
  const lines: string[] = [];
  for (const m of s.new_models) {
    const gap = modelGap(m, curated);
    lines.push(gap ? `${m.name} (${m.id}) — ${gap}.` : `${m.name} (${m.id}) — Nightloom's tables already know it.`);
  }
  if (!s.notes_read) lines.push("The release notes could not be read, so no new model is named.");
  if (lines.length === 0) lines.push("No new model in the release notes.");
  return lines.join(" ");
}

// ---- the cold moment ----

/** One open chat's cache, as the cache timer reads it. */
export interface OpenChatCache {
  session: string;
  title: string;
  /** When its cache entry expires, ms epoch; null when the log has no timer. */
  warmUntil: number | null;
  /** The prefix its next message sends (the gauge's figure), or null. */
  tokens: number | null;
}

export interface ColdReading {
  /** No turn running and no open chat warm: the update is free now. */
  cold: boolean;
  /** What is running ("a turn", "a Nightshift run in X"), nothing to update under. */
  running: string[];
  /** The open chats still warm, soonest to go cold first. */
  warm: { session: string; title: string; remainingMs: number; tokens: number | null }[];
  /** The warm chats' prefixes summed: what "now" makes them rewrite. */
  rewriteTokens: number;
  /** When the last warm cache expires, ms epoch; null when none is warm. */
  coldAt: number | null;
}

export function coldReading(running: string[], chats: OpenChatCache[], now: number): ColdReading {
  const warm = chats
    .filter((c) => c.warmUntil !== null && c.warmUntil > now)
    .map((c) => ({ session: c.session, title: c.title, remainingMs: (c.warmUntil as number) - now, tokens: c.tokens }))
    .sort((a, b) => a.remainingMs - b.remainingMs);
  const rewriteTokens = warm.reduce((n, c) => n + (c.tokens ?? 0), 0);
  const coldAt = warm.length ? now + warm[warm.length - 1].remainingMs : null;
  return { cold: running.length === 0 && warm.length === 0, running, warm, rewriteTokens, coldAt };
}

/** 57400 → "57k", 1_240_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** "3 min", "45 s". */
function inWords(ms: number): string {
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

/**
 * What an update waiting for a cold moment is waiting on: "a turn is
 * running", or "2 chats' caches are warm — cold in 4 min".
 */
export function waitLine(r: ColdReading): string {
  if (r.running.length) return `Waiting: ${r.running.join(", ")} ${r.running.length === 1 ? "is" : "are"} running.`;
  if (r.warm.length) {
    const n = r.warm.length;
    const last = r.warm[n - 1].remainingMs;
    return `Waiting for a cold moment: ${n} open chat${n === 1 ? "'s cache is" : "s' caches are"} warm — cold in ${inWords(last)}.`;
  }
  return "Cold now: no turn running, every open chat's cache expired.";
}

/**
 * What "now" costs, said before it runs: each warm chat pays a full cache
 * write on its next message, which the cold moment would have cost
 * nothing extra.
 */
export function costLine(r: ColdReading): string {
  if (r.warm.length === 0) return "Every open chat's cache is already cold: updating now rewrites nothing extra.";
  const n = r.warm.length;
  const each = r.warm
    .map((c) => `${c.title} ${c.tokens !== null ? `~${formatTokens(c.tokens)}` : "(size unknown)"}`)
    .join(", ");
  return `Updating now makes ${n} warm chat${n === 1 ? "" : "s"} rewrite ~${formatTokens(r.rewriteTokens)} tokens of cache on the next message (${each}); waiting ${inWords(r.warm[n - 1].remainingMs)} costs nothing extra.`;
}

/** The result, one line: "Updated Claude Code 2.1.263 → 2.1.280 (34 s)". */
export function resultLine(r: CliUpdateResult): string {
  if (r.ok && r.before && r.after && r.before !== r.after)
    return `Updated Claude Code ${r.before} → ${r.after} (${Math.round(r.seconds)} s).`;
  // Measured 2026-09-22 on a copied 2.1.263: the updater installs into
  // ~/.local/share/claude and repoints ~/.local/bin/claude, whichever copy
  // runs it — so a CLI elsewhere reports success and stays as it was.
  if (r.ok && r.before && r.before === r.after)
    return `claude update reported success, but this CLI still answers ${r.after} — the updater installs into ~/.local/bin/claude, and the CLI Nightloom runs may be another install.`;
  if (r.ok) return `claude update ran; Claude Code is ${r.after ?? "at an unknown version"}.`;
  const last = r.output.trim().split("\n").filter(Boolean).pop() ?? "no output";
  return `claude update did not finish (still ${r.after ?? r.before ?? "unknown"}): ${last}`;
}
