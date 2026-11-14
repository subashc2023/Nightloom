/**
 * The aliases' learned models (nightshift item 511): the state, kept in
 * localStorage (`nightloom.model-seen`) as the CLI and chat-choice prefs
 * are, so a relaunch keeps them. The rules are in `modelSeen.ts`.
 */
import { MODEL_SEEN_KEY, parseSeen, recordSeen, type SeenModels } from "./modelSeen";

function load(): SeenModels {
  try {
    return parseSeen(localStorage.getItem(MODEL_SEEN_KEY));
  } catch {
    return {};
  }
}

export const modelSeen = $state({ byAlias: load() as SeenModels });

/** A Claude Code turn on `alias` reported `id`, on CLI `cliVersion`. */
export function noteResolved(alias: string, id: string | null | undefined, cliVersion: string | null): void {
  const next = recordSeen(modelSeen.byAlias, alias, id, cliVersion, new Date());
  if (next === modelSeen.byAlias) return;
  modelSeen.byAlias = next;
  try {
    localStorage.setItem(MODEL_SEEN_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store costs the record past a relaunch, nothing else.
  }
}
