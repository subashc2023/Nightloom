/**
 * What a reply's footer says about how it ended (backlog 332).
 *
 * A reply whose stream ended before Claude Code's `result` line has no usage
 * (the log records 0 in / 0 out) — the footer used to read "0 out" under a
 * reply cut off mid-word. Now: no figure without usage, and the stop reason
 * the service records for such a reply (`cut off: <why>`) is said out loud.
 */
import type { Usage } from "./types";

/** True when the reply has a usage figure worth showing. */
export function hasUsage(u: Usage | null | undefined): boolean {
  return !!u && (u.input_tokens > 0 || u.output_tokens > 0);
}

/** The footer's note on how the reply stopped, or null for a normal end. */
export function stopNote(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  // The API error the CLI ended the reply with (backlog 202).
  if (stopReason.startsWith("error: ")) return `stopped · ${stopReason.slice(7)}`;
  if (stopReason.startsWith("cut off: ")) return `cut off · ${stopReason.slice(9)}`;
  return null;
}
