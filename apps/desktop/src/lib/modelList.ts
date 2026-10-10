/**
 * The Claude Code models the pickers offer, and the away server's default
 * (nightshift item 272) — the rules; `modelList.svelte.ts` holds the state.
 *
 * The list lives in `~/.nightloom/model-list.json` (the service crate's
 * `model_list`), which Settings → Subscription → Models edits, so a model
 * released after this build is a choice without a new build. Entries are
 * the CLI's aliases or full ids — `--model` takes either. No file is the
 * built-in list, `AGENT_MODELS` without its "" (the CLI's default, which
 * every picker offers on its own).
 */
import { AGENT_MODELS } from "./catalog";

/** What the file holds (`ModelList` in `model_list.rs`). */
export interface ModelList {
  models: string[];
  away_default?: string | null;
}

export const BUILT_IN_MODELS: string[] = AGENT_MODELS.filter(Boolean);

/** Trimmed, de-duplicated, empties dropped; an empty list is the built-in
 *  one (the backend's `normalized`). */
export function normalizeModels(models: string[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    const t = m.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length ? out : [...BUILT_IN_MODELS];
}

/** A list a host sent (the phone's rail, the file), or the built-in one. */
export function modelsOr(models: string[] | null | undefined): string[] {
  return Array.isArray(models) && models.length ? normalizeModels(models) : [...BUILT_IN_MODELS];
}

/** The picker's choices: the CLI's default ("") first, then the list. */
export function pickerModels(models: string[]): string[] {
  return ["", ...models];
}

/** `id` added at the end, unless blank or already there. */
export function addModel(models: string[], id: string): string[] {
  const t = id.trim();
  return !t || models.includes(t) ? models : [...models, t];
}

/** `id` removed; the last one cannot go (the list is never empty). */
export function removeModel(models: string[], id: string): string[] {
  const next = models.filter((m) => m !== id);
  return next.length ? next : models;
}

/** `id` moved one place up (`-1`) or down (`+1`); at an end, unchanged. */
export function moveModel(models: string[], id: string, by: -1 | 1): string[] {
  const i = models.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= models.length) return models;
  const next = [...models];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
