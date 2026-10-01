/**
 * The model list's state on the Mac (nightshift item 272): read from
 * `~/.nightloom/model-list.json` at launch, written by Settings. The rules
 * are in `modelList.ts`. Until the read lands — and in tests, which have no
 * backend — the pickers offer the built-in list.
 */
import { invoke } from "@tauri-apps/api/core";
import { BUILT_IN_MODELS, normalizeModels, pickerModels, type ModelList } from "./modelList";

export const modelList = $state({
  models: [...BUILT_IN_MODELS] as string[],
  /** The away server's model when the phone's rail names none; null is
   *  the server's own `--model`. */
  awayDefault: null as string | null,
  /** The last save's failure, one line. */
  error: null as string | null,
});

/** The Claude Code picker's choices: "" (the CLI's default), then the list. */
export function agentModels(): string[] {
  return pickerModels(modelList.models);
}

function take(l: ModelList) {
  modelList.models = normalizeModels(l.models ?? []);
  modelList.awayDefault = l.away_default?.trim() || null;
}

export async function loadModelList(): Promise<void> {
  try {
    take(await invoke<ModelList>("model_list_get"));
  } catch {
    // No backend (a test, the phone page): the built-in list stands.
  }
}

/** Write the list and the away default; the state follows what was saved. */
export async function saveModelList(models: string[], awayDefault: string | null): Promise<void> {
  try {
    take(await invoke<ModelList>("model_list_set", { list: { models, away_default: awayDefault } }));
    modelList.error = null;
  } catch (e) {
    modelList.error = String(e);
  }
}
