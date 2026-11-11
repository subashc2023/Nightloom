// Item 633: a running Bash command's latest output lines, by call id — the
// trace's passing text (Combo and Reticle). Fed by the backend's live-only
// `tool_output` event (read from the CLI's own spool of the command's
// output, ~3 updates a second at most); dropped at the call's result, so
// nothing here outlives the command or is ever saved.

/** Lines a row keeps (the backend sends at most this many). */
export const PASSING_LINES = 6;

const live = $state<Record<string, string[]>>({});

/** The command's latest lines, or none. */
export function passingLines(toolUseId: string): string[] {
  return live[toolUseId] ?? [];
}

/** A `tool_output` event: the call's lines, whole. */
export function setPassing(toolUseId: string, lines: string[]): void {
  if (!toolUseId) return;
  live[toolUseId] = lines.slice(-PASSING_LINES);
}

/** The call ended (its result or refusal): its passing text goes. */
export function endPassing(toolUseId: string): void {
  if (toolUseId in live) delete live[toolUseId];
}
