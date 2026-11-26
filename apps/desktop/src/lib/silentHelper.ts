/**
 * A helper gone silent (nightshift item 752, blocker 2345, 2026-11-26; his
 * "sure if 2345 is backed by resaerch or wtv go for it").
 *
 * A subagent whose stream has said nothing for 15 min is drawn with
 * "No output for 15 min" and a Restart: stop it (the CLI's `stop_task`, that
 * one alone) and ask the main agent to launch it again from the same prompt
 * — Nightloom cannot spawn a subagent itself. It never restarts on its own.
 *
 * Why 15 min: Claude Code's own stall timeout for a background agent
 * (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`) is what the nights set to 900000
 * (blocker 2018). How often helpers stall in his chats is unmeasured; the
 * button only offers.
 *
 * "Output" is what the row hears: the CLI's status for it (after each of its
 * tool calls) or a message of its own (`heardAt`). A long single tool call
 * (a 20-minute build) is silence too — the notice says what it sees, and
 * the restart is his to choose.
 *
 * Pure, for the suite; `SilentHelper.svelte` draws it.
 */

/** Silence past this is drawn (15 min, blocker 2345). */
export const SILENT_MS = 15 * 60_000;

/** The row fields this reads. */
export interface SilentRow {
  status: string;
  restored?: boolean;
  startedAt: number;
  updatedAt: number;
  heardAt?: number;
}

/** How long the helper has been silent, when that is past `SILENT_MS` and it
 *  still runs live; else null (done, from the log, or talking). */
export function silentFor(r: SilentRow, now: number, limit = SILENT_MS): number | null {
  if (r.status !== "running" || r.restored) return null;
  const from = r.heardAt ?? r.updatedAt ?? r.startedAt;
  const quiet = now - from;
  return quiet >= limit ? quiet : null;
}

/** "No output for 15 min", "No output for 1 h 5 min". */
export function silentLabel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `No output for ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `No output for ${h} h${r ? ` ${r} min` : ""}`;
}

/** What the note names. */
export interface NoteHelper {
  tool_use_id: string;
  task_id: string;
  description: string;
  subagent_type: string;
  model?: string;
}

/**
 * Nightloom's note to the main agent on his Restart: which helper, that it
 * was stopped for its silence, and to launch it again with the same Agent
 * call — the prompt whole when the window has it.
 */
export function restartNote(r: NoteHelper, prompt: string | null, quietMs: number): string {
  const name = r.description || r.subagent_type || "subagent";
  const mins = Math.floor(quietMs / 60_000);
  const same = [
    r.subagent_type ? `subagent_type "${r.subagent_type}"` : "",
    r.model ? `model "${r.model}"` : "",
    r.description ? `description "${r.description}"` : "",
  ].filter(Boolean);
  const lines = [
    `[Nightloom: Swaraag restarted your subagent “${name}” (agent ${r.task_id}, your Agent call ${r.tool_use_id}). It had sent no output for ${mins} min, so it was stopped; any report it sends now is from the stopped run.`,
    `Launch it again now with the Agent tool, as that call was${same.length ? ` (${same.join(", ")})` : ""}, with exactly the same prompt, and carry on as you were. Do not do its work yourself instead.]`,
  ];
  if (prompt) lines.push("", "The prompt, as that call gave it:", "", prompt);
  return lines.join("\n");
}
