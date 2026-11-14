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

/** `a` is a newer version of the same family as `b` (both full ids). */
export function newerId(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  return !!x && !!y && x.family === y.family && newer(x.version, y.version);
}

/** One row of a model list, one per family (nightshift item 518). */
export interface FamilyRow {
  /** Stable key for the row. */
  key: string;
  /** What choosing it sends as `--model`. */
  pick: string;
  /** `Fable 5.2`; an alias outside the families, as it is. */
  label: string;
  /** The label split for a pill: `Fable` and `5.2`. */
  name: string;
  version: string;
  /** The alias whose ⌘⇧ chord picks this same model, or null. */
  capAlias: string | null;
  /** The alias's note on a family row (`fable alias = 5.1`), or "". */
  note: string;
  /** The dim clause after the label. */
  detail: string;
  title: string;
  on: boolean;
  /**
   * `family`: the family's newest, merged with its alias; `lagging`: the
   * alias's own row, shown only while the chat is on it and it resolves to
   * an older model than the newest; `alias`: a list entry that is no
   * family's alias (`opusplan`); `full`: a full id the list holds;
   * `newest`: a family's newest that no list entry covers (511's rows).
   */
  kind: "family" | "lagging" | "alias" | "full" | "newest";
}

function split(label: string): { name: string; version: string } {
  const i = label.indexOf(" ");
  return i < 0 ? { name: label, version: "" } : { name: label.slice(0, i), version: label.slice(i + 1) };
}

/** `Fable 5.1` → `5.1` when `id` is of `family`, else the whole name. */
function numberIn(id: string, family: string): string {
  return familyOf(id) === family ? split(displayName(id)).version : displayName(id);
}

/**
 * The model list as one row per family (nightshift item 518, blocker 1684:
 * "sure yeah" to merging): each list entry that is a family's alias
 * (`fable`) becomes that family's newest model by full id, labelled
 * `Fable 5.2`, picking the full id, with the alias noted when it resolves
 * elsewhere on the CLI now (`fable alias = 5.1`). The alias gets a second
 * row only when it lags the newest *and* the chat is on it (`cur`), so a
 * chat set to an alias is shown on the right row (blocker 1692's default).
 * A full id the list holds that a family row already picks is not listed
 * twice; other entries keep their rows; each family's newest that no
 * entry covers follows (item 511's rows), unless an alias row (the CLI's
 * default "" included) already resolves to it.
 */
export function familyRows(entries: readonly string[], newest: readonly string[], seen: SeenModels, cliNow: string | null, cur: string): FamilyRow[] {
  const c = cur.trim();
  const byFamily = new Map<string, string>();
  for (const id of newest) {
    const f = familyOf(id);
    if (f && !byFamily.has(f)) byFamily.set(f, id);
  }
  const familyAliases = new Set(entries.map((e) => e.trim().toLowerCase()).filter((e) => byFamily.has(e)));
  const rows: FamilyRow[] = [];
  const covered = new Set<string>();
  const curSuffix = (on: boolean) => (on ? " · current" : "");
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const fam = e.toLowerCase();
    if (!isFullId(e) && byFamily.has(fam)) {
      if (covered.has(`alias:${fam}`)) continue;
      covered.add(`alias:${fam}`);
      const v = aliasView(seen, e, cliNow);
      const resolved = v.current?.id ?? null;
      // The CLI's alias may already be newer than the table shipped here.
      const top = resolved && newerId(resolved, byFamily.get(fam)!) ? resolved : byFamily.get(fam)!;
      covered.add(top);
      const lags = !!resolved && resolved !== top;
      const label = displayName(top);
      const note = resolved
        ? lags
          ? `${e} alias = ${numberIn(resolved, fam)}`
          : `the ${e} alias too`
        : `${e} alias not seen yet`; // the CLI's version is in the hover (`v.title`)
      const onAlias = c === e;
      const on = c === top || (onAlias && !lags);
      rows.push({
        key: `family:${fam}`,
        pick: top,
        label,
        ...split(label),
        capAlias: lags ? null : e,
        note,
        detail: `${top} · ${note}${on ? (onAlias ? ` · current, as ${e}` : " · current") : ""}`,
        title: `${top} by its full id — the newest ${split(label).name}. ${v.title}${lags ? `, an older model than ${label}` : ""}`,
        on,
        kind: "family",
      });
      if (lags && onAlias) {
        const old = displayName(resolved!);
        rows.push({
          key: `lagging:${fam}`,
          pick: e,
          label: e,
          name: e,
          version: numberIn(resolved!, fam),
          capAlias: e,
          note: "",
          detail: `· ${old}, older than ${label}${curSuffix(true)}`,
          title: `The ${e} alias, which the chat is set to — ${v.title}. ${label} is the row above.`,
          on: true,
          kind: "lagging",
        });
      }
      continue;
    }
    if (isFullId(e)) {
      const f = familyOf(e);
      // The family row above (or below) already picks it.
      if (covered.has(e) || (f && familyAliases.has(f) && byFamily.get(f) === e)) continue;
      covered.add(e);
      const label = displayName(e);
      rows.push({ key: `full:${e}`, pick: e, label, ...split(label), capAlias: null, note: "", detail: `${e}${curSuffix(c === e)}`, title: `${e} — a full id, which the CLI takes as it is`, on: c === e, kind: "full" });
      continue;
    }
    if (covered.has(`alias:${e}`)) continue;
    covered.add(`alias:${e}`);
    const v = aliasView(seen, e, cliNow);
    const num = v.current ? displayName(v.current.id) : "";
    rows.push({ key: `alias:${e}`, pick: e, label: e, name: e, version: num, capAlias: e, note: "", detail: `${v.detail}${curSuffix(c === e)}`, title: v.title, on: c === e, kind: "alias" });
  }
  const all = ["", ...entries];
  for (const id of newest) {
    const f = familyOf(id);
    if (covered.has(id) || (f && familyAliases.has(f)) || entries.includes(id) || shownByAlias(seen, all, cliNow, id)) continue;
    covered.add(id);
    const label = displayName(id);
    rows.push({
      key: `newest:${id}`,
      pick: id,
      label,
      ...split(label),
      capAlias: null,
      note: "",
      detail: `${id}${curSuffix(id === c)}`,
      title: `${id} by its full id — picked as other… would take it`,
      on: id === c,
      kind: "newest",
    });
  }
  return rows;
}

/** No row is on and the chat names a model: the *other…* row is. */
export function otherOnRows(cur: string, rows: readonly FamilyRow[]): boolean {
  return cur.trim() !== "" && !rows.some((r) => r.on);
}
