/**
 * What each Claude Code alias resolves to, learned from use (nightshift
 * item 511) — the rules; `modelSeen.svelte.ts` holds the state.
 *
 * Every Claude Code turn reports the full model id the CLI resolved its
 * `--model` to (`AgentTurnResult.model`, from the init line). A turn run on
 * an alias (`fable`, `opus`, …, or "" for the CLI's default) records
 * `alias → id` with the CLI version it ran on, so the model menu can say
 * `fable · Fable 5.1` for free. A record from another CLI version is not
 * trusted for the current one: a CLI release can move an alias.
 *
 * The menu also offers each family's newest model by full id (`NEWEST`, a
 * table shipped with the app), so a model newer than the CLI's alias is a
 * pick without waiting for a Claude Code release. When the Anthropic API's
 * own list was already fetched (Settings, on a stored key), its ids replace
 * the table; nothing here makes a network call.
 */

/** One learned resolution. */
export interface SeenModel {
  /** The full id the CLI reported, e.g. `claude-fable-5-1`. */
  id: string;
  /** The CLI's version when it was seen (`2.1.321`), or null if unknown. */
  cliVersion: string | null;
  /** ISO time it was seen. */
  seenAt: string;
}

/** Alias ("" is the CLI's default) → its newest record. */
export type SeenModels = Record<string, SeenModel>;

export const MODEL_SEEN_KEY = "nightloom.model-seen";

/** Each family's newest model, by full id, as of this build. */
export const NEWEST: readonly string[] = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** A full id rather than an alias: `--model` was given the model itself, so
 *  there is nothing to learn about what it resolves to. */
export function isFullId(model: string): boolean {
  return /^claude-/i.test(model.trim());
}

/** The version in what `--version` printed (`2.1.321 (Claude Code)`). */
export function cliVersionOf(text: string | null | undefined): string | null {
  const m = text?.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** The CLI's version now: the version check's installed one, else what the
 *  connected binary printed at connect; null when neither is known. */
export function currentCliVersion(installed: string | null | undefined, atConnect: string | null | undefined): string | null {
  return cliVersionOf(installed) ?? cliVersionOf(atConnect);
}

interface Parsed {
  family: string;
  version: number[];
  /** `[1m]` and the like, kept for the name. */
  tag: string;
}

function parse(id: string): Parsed | null {
  let s = id.trim().toLowerCase();
  if (!s.startsWith("claude-")) return null;
  let tag = "";
  const br = s.match(/(\[[^\]]*\])$/);
  if (br) {
    tag = br[1];
    s = s.slice(0, -tag.length);
  }
  const parts = s.slice("claude-".length).split("-");
  // A snapshot date (`-20251001`) is not part of the version.
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
  const words = parts.filter((p) => /^[a-z]+$/.test(p));
  const nums = parts.filter((p) => /^\d{1,3}$/.test(p));
  if (words.length !== 1 || nums.length === 0 || words.length + nums.length !== parts.length) return null;
  return { family: words[0], version: nums.map(Number), tag };
}

/** `claude-fable-5-1` → `Fable 5.1`; an id it cannot read → the id. */
export function displayName(id: string): string {
  const p = parse(id);
  if (!p) return id.trim();
  const name = `${p.family[0].toUpperCase()}${p.family.slice(1)} ${p.version.join(".")}`;
  return p.tag ? `${name} ${p.tag}` : name;
}

/** The family of a full id (`fable`), or null. */
export function familyOf(id: string): string | null {
  return parse(id)?.family ?? null;
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newest-by-full-id rows' ids: from the API's list when there is one
 * (each family's newest, a tagged or dated id losing a tie to a plain one),
 * else the shipped table. Ordered as the table orders families, then any
 * other family the API names.
 */
export function newestModels(apiList: readonly string[] | null | undefined): string[] {
  const ids = (apiList ?? []).filter((m) => parse(m) && !parse(m)!.tag);
  if (ids.length === 0) return [...NEWEST];
  const best = new Map<string, { id: string; v: number[] }>();
  for (const id of ids) {
    const p = parse(id)!;
    const had = best.get(p.family);
    if (!had || newer(p.version, had.v) || (!newer(had.v, p.version) && id.length < had.id.length)) {
      best.set(p.family, { id, v: p.version });
    }
  }
  const order = NEWEST.map((m) => familyOf(m) as string);
  const fams = [...best.keys()].sort((a, b) => {
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    return (i < 0 ? order.length : i) - (j < 0 ? order.length : j) || a.localeCompare(b);
  });
  return fams.map((f) => best.get(f)!.id);
}

/** `seen` with `alias → id` recorded, or unchanged when the turn ran on a
 *  full id or reported none. */
export function recordSeen(seen: SeenModels, alias: string, id: string | null | undefined, cliVersion: string | null, now: Date): SeenModels {
  const a = alias.trim();
  const m = id?.trim();
  if (!m || isFullId(a)) return seen;
  const had = seen[a];
  if (had && had.id === m && had.cliVersion === cliVersion) return seen;
  return { ...seen, [a]: { id: m, cliVersion, seenAt: now.toISOString() } };
}

/** What an alias row says about the model behind it. */
export interface AliasView {
  /** The record, when it holds for the CLI now (or the version is unknown). */
  current: SeenModel | null;
  /** `· Fable 5.1`, or `· not seen on 2.1.321 yet`. */
  detail: string;
  /** The hover's longer form. */
  title: string;
}

/** The alias row's text for `alias` with the CLI on `cliNow`. */
export function aliasView(seen: SeenModels, alias: string, cliNow: string | null): AliasView {
  if (isFullId(alias)) {
    // A full id in the list (Settings → Models) names its model itself.
    const n = displayName(alias);
    return { current: null, detail: `· ${n === alias.trim() ? "a full id" : n}`, title: `${alias.trim()} — a full id, which the CLI takes as it is` };
  }
  const r = seen[alias.trim()];
  const name = alias.trim() || "default";
  const what = alias.trim() ? `${name}` : "the CLI's default";
  const fresh = r && (cliNow === null || r.cliVersion === cliNow) ? r : null;
  if (fresh) {
    const on = fresh.cliVersion ? ` on Claude Code ${fresh.cliVersion}` : "";
    const unknown = cliNow === null ? " (the CLI's version now is unknown)" : "";
    return {
      current: fresh,
      detail: `· ${displayName(fresh.id)}`,
      title: `${what} resolved to ${fresh.id}${on}, seen ${fresh.seenAt.slice(0, 10)}${unknown}`,
    };
  }
  const notSeen = cliNow ? `not seen on ${cliNow} yet` : "not seen yet";
  const before = r
    ? ` — it was ${r.id} on ${r.cliVersion ? `Claude Code ${r.cliVersion}` : "an earlier CLI"}; a CLI update can move an alias`
    : "";
  return {
    current: null,
    detail: `· ${notSeen}`,
    title: `${what}: no turn has run on it ${cliNow ? `on Claude Code ${cliNow}` : "yet"}, so its model number is not known${before}. The first turn on it tells.`,
  };
}

/** A newest row's id that some alias row already shows, now: no separate row. */
export function shownByAlias(seen: SeenModels, aliases: readonly string[], cliNow: string | null, id: string): string | null {
  for (const a of aliases) {
    if (aliasView(seen, a, cliNow).current?.id === id) return a;
  }
  return null;
}

/** A stored record set, strictly: anything malformed is dropped. */
export function parseSeen(raw: string | null): SeenModels {
  const out: SeenModels = {};
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") return out;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (!r || typeof r.id !== "string" || typeof r.seenAt !== "string") continue;
      if (r.cliVersion !== null && typeof r.cliVersion !== "string") continue;
      out[k] = { id: r.id, cliVersion: r.cliVersion as string | null, seenAt: r.seenAt };
    }
  } catch {
    // A corrupt record set is no records: the next turn writes it again.
  }
  return out;
}

/** One newest-by-full-id row of the model menu. */
export interface FullIdRow {
  /** The full id it picks — `--model` as other… would send it. */
  pick: string;
  label: string;
  detail: string;
  title: string;
  on: boolean;
}

/**
 * The menu's newest-by-full-id rows under `aliases` (the list's entries;
 * "" is added): one per id of `newest` that neither the list holds nor an
 * alias row already shows on this CLI. `cur` is the chat's `--model`.
 */
export function fullIdRows(newest: readonly string[], aliases: readonly string[], seen: SeenModels, cliNow: string | null, cur: string): FullIdRow[] {
  const c = cur.trim();
  const all = ["", ...aliases];
  return newest
    .filter((id) => !aliases.includes(id) && !shownByAlias(seen, all, cliNow, id))
    .map((id) => ({
      pick: id,
      label: displayName(id),
      detail: id === c ? `${id} · current` : id,
      title: `${id} by its full id — picked as other… would take it`,
      on: id === c,
    }));
}

/** The other… row is on: `cur` is a full id no row above names. */
export function otherOn(cur: string, aliases: readonly string[], rows: readonly FullIdRow[]): boolean {
  const c = cur.trim();
  return c !== "" && !aliases.includes(c) && !rows.some((r) => r.pick === c);
}
