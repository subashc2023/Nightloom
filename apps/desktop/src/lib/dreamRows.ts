/**
 * The dream row in Settings → Knowledge (nightshift backlog 071), as data:
 * which engines can dream, what each bills, which models each offers, and
 * the one sentence that says what will run. `SettingsModal.svelte` draws
 * these; nothing here reads or writes the preference.
 *
 * The preference itself (`DreamPrefs` in `state.svelte.ts`) is unchanged
 * by this: `provider` is a provider kind, `DREAM_ENGINE`, or "" for the
 * rail's connection; `model` is "" for the engine's default. Capture uses
 * the same knob (blocker 054).
 */
import { AGENT_MODELS, modelsFor, providerLabel, type CatalogPrefs, type ConnectionDraft } from "./catalog";
import type { ProviderInfo } from "./types";

/** The `provider` value that means the Claude Code engine — the same string
 *  `state.svelte.ts` exports as `DREAM_ENGINE`, repeated here so this module
 *  does not import the store. */
export const CLAUDE_CODE = "claude-code";

/** One engine row: the value stored, the name, what it bills, one line under. */
export interface DreamEngineRow {
  value: string;
  name: string;
  bills: string;
  sub: string;
  /** A provider with no key: the row still picks; the pill says why a dream would fail. */
  warn: boolean;
}

/** One model pill: the value stored ("" for the default) and its label. */
export interface DreamModelPill {
  value: string;
  label: string;
}

/** What the rail is on right now, in one clause, for the first row. */
export function railNow(d: ConnectionDraft): string {
  return d.engine === "claude-code"
    ? `Subscription · ${d.agentModel.trim() || "the CLI's default"} · your plan`
    : `${providerLabel(d.provider)} · ${d.model || "its default"} · its API key`;
}

/** The rows: the rail's connection, the subscription engine, then each
 *  provider. His naming (2026-09-16, backlog 102): the engine that runs
 *  on the plan is the subscription engine; Claude Code names its build
 *  kind. */
export function dreamEngineRows(providers: ProviderInfo[], draft: ConnectionDraft): DreamEngineRow[] {
  return [
    {
      value: "",
      name: "The rail's connection",
      bills: "bills as the chat does",
      sub: `right now: ${railNow(draft)}`,
      warn: false,
    },
    {
      value: CLAUDE_CODE,
      name: "Subscription",
      bills: "your Claude plan",
      sub: "the signed-in claude CLI; no API key",
      warn: false,
    },
    ...providers.map((p) => ({
      value: p.kind,
      name: providerLabel(p.kind),
      bills: p.available ? "its API key" : "no key set",
      sub: p.default_model ? `default model ${p.default_model}` : "",
      warn: !p.available,
    })),
  ];
}

/**
 * The model pills under the chosen engine: "" for the engine's default,
 * then the CLI's aliases on Claude Code, or the provider's picker list
 * (`modelsFor`, the popover's own). A stored id in neither — typed into
 * the text box this row replaced — is kept as one more pill so nothing
 * is lost. Empty for the rail's connection, which brings its own model.
 */
export function dreamModelPills(
  provider: string,
  current: string,
  providers: ProviderInfo[],
  prefs: CatalogPrefs,
): DreamModelPill[] {
  if (!provider) return [];
  let list: DreamModelPill[];
  if (provider === CLAUDE_CODE) {
    list = AGENT_MODELS.map((m) => ({ value: m, label: m || "the CLI's default" }));
  } else {
    const info = providers.find((p) => p.kind === provider);
    const ids = modelsFor(provider, prefs, info?.default_model ?? null);
    list = [
      { value: "", label: info?.default_model ? `default (${info.default_model})` : "default" },
      ...ids.map((m) => ({ value: m, label: m })),
    ];
  }
  if (current && !list.some((m) => m.value === current)) list.push({ value: current, label: current });
  return list;
}

/** The sentence at the top of the card: what will run, on what, billed to what. */
export function dreamSentence(rows: DreamEngineRow[], provider: string, model: string, draft: ConnectionDraft): string {
  const row = rows.find((e) => e.value === provider);
  if (!row || !row.value) return `Dreams and captures run on the rail's connection — ${railNow(draft)}.`;
  const m = model || (row.value === CLAUDE_CODE ? "the CLI's default" : "its default model");
  return `Dreams and captures run on ${row.name} · ${m}, billed to ${row.bills}.`;
}
