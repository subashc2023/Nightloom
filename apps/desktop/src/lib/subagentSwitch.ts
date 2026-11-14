/**
 * Blocker 1757 (nightshift item 540; his answer, 2026-11-10: "Yes, switch
 * them"): the helper-model rule (Opus by default, Fable only with a written
 * reason, never below Opus unless he asks) is enforced under "Choose", and
 * 136 of his 145 chats were on "Same as the chat". Once, at the app's start:
 *
 * - the window's own setting (`agentLimits.model`, the one every chat's
 *   `subagent-limits.json` is rewritten from at each turn) goes from `same`
 *   to `choose` — without this the files would go back to Same at the next
 *   turn;
 * - every chat's file on disk that says `same` is switched too (the backend,
 *   `brief::switch_same_to_choose`; no other field touched).
 *
 * The marker is written before the backend is asked, so it never runs
 * twice — a chat or a setting he puts back to Same stays Same. A failed
 * file rewrite is not retried: each chat's next turn writes its file from
 * the (now Choose) setting anyway.
 */
import type { ConnectionDraft } from "./catalog";

export const SWITCH_1757_KEY = "nightloom.switched-1757";

/** Run the switch if it has never run. `true` when it ran now. */
export function switchSameToChoose(
  draft: Pick<ConnectionDraft, "agentLimits">,
  storage: Pick<Storage, "getItem" | "setItem">,
  save: () => void,
  switchFiles: () => Promise<unknown>,
): boolean {
  try {
    if (storage.getItem(SWITCH_1757_KEY)) return false;
    storage.setItem(SWITCH_1757_KEY, new Date().toISOString());
  } catch {
    // No storage: no marker could be kept, so it is not run at all.
    return false;
  }
  if (draft.agentLimits.model === "same") {
    draft.agentLimits.model = "choose";
    save();
  }
  void switchFiles().catch(() => {});
  return true;
}
