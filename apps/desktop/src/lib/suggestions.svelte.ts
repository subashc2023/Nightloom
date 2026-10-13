/**
 * Prompt suggestions (nightshift backlog 083, 2026-09-16; survey row D10,
 * low): the Claude Code CLI can predict the next prompt after each turn
 * (`--prompt-suggestions true`, a `prompt_suggestion` line after `result`),
 * and the composer shows it as a ghost line — dimmed, in the empty box —
 * that Tab accepts and typing dismisses.
 *
 * **Off by default**, and the switch says why: the CLI waits for the
 * prediction before its process exits, about six seconds on every turn
 * (measured on Haiku, 2.1.263), during which the chat is still busy; and
 * the prediction is one more request against the plan, whose cost the
 * CLI does not report. The preference is app-wide (localStorage, like the
 * transcript prefs) and read at connect, so a change reconnects.
 */

const KEY = "nightloom.promptSuggestions";

function load(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export const suggestions = $state<{ enabled: boolean }>({ enabled: load() });

export function setPromptSuggestions(on: boolean): void {
  suggestions.enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage refused; the value holds for this launch only.
  }
}

/** What the composer shows: the ghost line only over an empty box, and
 *  only the suggestion this chat's last turn produced. */
export function ghostFor(suggestion: string | null, text: string): string | null {
  if (!suggestion || text !== "") return null;
  return suggestion;
}
