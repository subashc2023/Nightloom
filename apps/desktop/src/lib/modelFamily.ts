/**
 * Item 644 (his ask, 2026-11-11: "giving the main textbox area a slightly
 * different tint … depending on model used"; his picks: Fable keeps round
 * 1's "Lilac glass", Opus takes round 3's "Copper", every other model keeps
 * today's box). The composer stamps the family of the chat's current model
 * on its root as `data-model-family`; the looks are in `src/modelFamily.css`,
 * all behind `html:not([data-layout="classic"])`.
 */
export type ModelFamily = "opus" | "fable" | "other";

/**
 * The family a model id belongs to: a CLI alias (`opus`, `opus[1m]`,
 * `opusplan`), a full id (`claude-opus-5-5`, `claude-fable-5-2-20261101`),
 * a provider's id (`anthropic/claude-opus-4.1`,
 * `us.anthropic.claude-opus-4-1-20250805-v1:0`, `claude-opus-4-1@20250805`)
 * or a display name (`Opus 5.5`). Matched by word, so a name that merely
 * contains the letters (`magnum-opusx`) is not Opus. Anything else — Sonnet,
 * Haiku, another vendor's model, `default`, empty — is "other".
 */
export function modelFamily(id: string | null | undefined): ModelFamily {
  const words = (id ?? "").toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    // `opusplan`: the CLI's alias for Opus while planning, Sonnet after.
    if (w === "opus" || w === "opusplan") return "opus";
    if (w === "fable") return "fable";
  }
  return "other";
}

/**
 * The model id a composer's box follows — the same choice its model chip
 * names (`modelChipLabel`): on Claude Code the alias or id picked (an
 * aside's own pick, else the chat's), on the provider engine the
 * connection's model, else the draft's. `default` (the CLI's own choice) is
 * not resolved: the last turn's model is not reset when another chat opens,
 * so it could name the wrong chat's — the box stays today's.
 */
export function composerModelId(a: {
  agentMode: boolean;
  agentModel: string;
  model: string;
  connected: string | null | undefined;
  /** An aside's own pick; null or empty is the chat's. */
  asideModel?: string | null;
}): string {
  if (a.asideModel && a.asideModel.trim()) return a.asideModel.trim();
  if (a.agentMode) return a.agentModel.trim();
  return (a.connected || a.model).trim();
}
