/**
 * Each model's default effort, per engine (nightshift backlog 100,
 * 2026-09-16) — the fact the rail's *default* effort segment names, as in
 * `default · high`.
 *
 * Data, not behaviour: nothing here is sent to the CLI or the API. The rail
 * sends no `--effort` (and the provider loop no `output_config.effort`) in
 * the *default* position, so what actually runs is whatever the engine's
 * own resolution lands on; this table is what the docs say that is, so the
 * segment can say it too. Two engines, because the answer is per engine
 * even where it agrees:
 *
 * - `claude-code`: the CLI resolves a session's effort in order — an
 *   explicit choice (`CLAUDE_CODE_EFFORT_LEVEL`, `--effort`, `/effort`),
 *   then the user's settings (`modelSettings` per model, or `effortLevel`),
 *   then "the model's default effort: `high` on every model that supports
 *   effort, except that Opus 4.7 defaults to `xhigh`" (`external`,
 *   code.claude.com/docs/en/model-config, "Adjust effort level", fetched
 *   2026-09-16). The user's `~/.claude/settings.json` can move the answer
 *   off this table; Nightloom does not read that file, so the label says
 *   "the model's own" and the `?` says where a saved level would override
 *   it.
 * - `provider` (the Anthropic API): "Setting `effort` to `"high"` produces
 *   exactly the same behavior as omitting the `effort` parameter entirely"
 *   (`external`, platform.claude.com/docs/en/build-with-claude/effort,
 *   fetched 2026-09-16), on every model the page lists as supporting it.
 *
 * So the two engines do **not** differ on the four core models: `high` on
 * both, for Fable 5.1, Opus 5 and Sonnet 5; and Haiku 4.5 has no effort on
 * either (the API page does not list it, the CLI page says unlisted models
 * "do not support effort"). The one place they differ is Opus 4.7, where the
 * CLI's default is `xhigh` and the API's `high`.
 *
 * Keys are model *families* (`opus-5`), matched against whatever the rail
 * holds — a CLI alias (`opus`), a full id (`claude-opus-5`) or a dated
 * snapshot (`claude-opus-5-2026-01-15`) — by {@link effortDefault}. An
 * alias names the family's newest entry, which is what the CLI says an alias
 * is ("an alias for the latest model", `claude --help`); which release that
 * is on a given day is the CLI's, and `haiku` → Haiku 4.5 is the only alias
 * measured (backlog 100, `m100/base.jsonl`, `model:
 * claude-haiku-4-5-20251001`).
 */

import type { Engine } from "./catalog";

/** The CLI's five levels, as `claude --help` 2.1.263 lists them. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortFacts {
  /** What runs when nothing is sent. `null` = the model has no effort
   *  control on this engine, so there is no default to name. */
  default: EffortLevel | null;
  /** The levels this engine accepts for the model, in order. Empty when
   *  the model has no effort control. On the CLI a level the model lacks
   *  "falls back to the highest supported level at or below the one you
   *  set" (`external`, model-config); on the API it is a 400. */
  levels: EffortLevel[];
  /** Where the row comes from — a URL, or `measured` with the command. */
  source: string;
}

const ALL: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: EffortLevel[] = ["low", "medium", "high", "max"];
const NONE: EffortLevel[] = [];

const CLI_DOC = "https://code.claude.com/docs/en/model-config#adjust-effort-level";
const API_DOC = "https://platform.claude.com/docs/en/build-with-claude/effort";

/**
 * Model families the rail can name, newest first within a family so an
 * alias resolves to the first match. Every row is `external` — the two doc
 * pages above, read 2026-09-16 — except where the source says `measured`.
 */
export const EFFORT_DEFAULTS: Record<Engine, Record<string, EffortFacts>> = {
  "claude-code": {
    "fable-5-1": { default: "high", levels: ALL, source: CLI_DOC },
    "fable-5": { default: "high", levels: ALL, source: CLI_DOC },
    "opus-5": { default: "high", levels: ALL, source: CLI_DOC },
    "opus-4-8": { default: "high", levels: ALL, source: CLI_DOC },
    "opus-4-7": { default: "xhigh", levels: ALL, source: CLI_DOC },
    "opus-4-6": { default: "high", levels: NO_XHIGH, source: CLI_DOC },
    "sonnet-5": { default: "high", levels: ALL, source: CLI_DOC },
    "sonnet-4-6": { default: "high", levels: NO_XHIGH, source: CLI_DOC },
    // Not in the CLI's levels table: "Models not listed here do not
    // support effort". The flag is still accepted without a warning on a
    // Haiku turn (measured, `m100/low.jsonl`); what it does there is not
    // documented.
    "haiku-4-5": { default: null, levels: NONE, source: CLI_DOC },
  },
  provider: {
    "fable-5-1": { default: "high", levels: ALL, source: API_DOC },
    "fable-5": { default: "high", levels: ALL, source: API_DOC },
    "opus-5": { default: "high", levels: ALL, source: API_DOC },
    "opus-4-8": { default: "high", levels: ALL, source: API_DOC },
    "opus-4-7": { default: "high", levels: ALL, source: API_DOC },
    "opus-4-6": { default: "high", levels: NO_XHIGH, source: API_DOC },
    "sonnet-5": { default: "high", levels: ALL, source: API_DOC },
    "sonnet-4-6": { default: "high", levels: NO_XHIGH, source: API_DOC },
    // Absent from the API page's supported-models list; the provider
    // adapter sends Haiku a thinking budget, never an effort.
    "haiku-4-5": { default: null, levels: NONE, source: API_DOC },
  },
};

/**
 * The family key for what the rail holds, or `null` when it names nothing
 * in the table. `claude-opus-5-2026-01-15` → `opus-5`; `opus` (an alias)
 * → the family's newest key, `opus-5`; `""` (the CLI's own default model)
 * and an id from another vendor → `null`.
 */
export function effortFamily(engine: Engine, model: string): string | null {
  const table = EFFORT_DEFAULTS[engine];
  const m = model.trim().toLowerCase().replace(/^claude-/, "");
  if (!m) return null;
  // A full id or a dated snapshot: the longest family key it starts with,
  // so `fable-5-1` is not read as `fable-5`.
  const exact = Object.keys(table)
    .filter((k) => m === k || m.startsWith(k + "-"))
    .sort((a, b) => b.length - a.length)[0];
  if (exact) return exact;
  // A bare alias: the first (newest) key of that family.
  return Object.keys(table).find((k) => k.split("-")[0] === m) ?? null;
}

/** The facts for a model on an engine, or `null` when unknown — the
 *  rail's `default · ?` case. */
export function effortDefault(engine: Engine, model: string): EffortFacts | null {
  const key = effortFamily(engine, model);
  return key ? EFFORT_DEFAULTS[engine][key] : null;
}

/**
 * The text beside *default* on the segment: `· high`, `· none` for a model
 * with no effort control, `· ?` when the model is not in the table.
 */
export function effortDefaultLabel(engine: Engine, model: string): string {
  const f = effortDefault(engine, model);
  if (!f) return "?";
  return f.default ?? "none";
}
