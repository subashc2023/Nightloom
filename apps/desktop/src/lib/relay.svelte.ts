/**
 * Messages the main model passed on to a running subagent (nightshift
 * backlog 339). A message he sends mid-turn while subagents run carries a
 * note naming them by agent id (`agent/inbox.rs`); when the main model
 * then calls SendMessage, the turn's `relayed` event lands here, keyed by
 * the agent's `task_id`, and the agent's box shows it — "relayed", then
 * "arrived" once the agent has taken a step after it. The CLI delivers a
 * SendMessage to a running agent "at its next tool round" (its own tool
 * description, `external`), so a finished call of the agent's after the
 * relay is the sign it has it.
 *
 * Window memory only: a relay is a fact of the running turn, and the
 * chat's log keeps the main model's SendMessage call itself.
 */
import type { Segment } from "./state.svelte";

export interface Relay {
  text: string;
  /** When the CLI answered the call (ms). */
  at: number;
  ok: boolean;
  /** The CLI's answer, as the tool result said it. */
  detail: string;
  /** How many of the agent's segments there were at the relay. */
  segAt: number;
}

export const relays = $state<Record<string, Relay[]>>({});

export function recordRelay(agentId: string, r: Relay): void {
  (relays[agentId] ??= []).push(r);
}

/** Whether the agent has taken a step since the relay: a call of its own
 *  that finished after it, or words of its own that quote it. */
export function relayArrived(r: Relay, segments: readonly Segment[]): boolean {
  if (!r.ok) return false;
  const after = segments.slice(r.segAt);
  const probe = r.text.trim().slice(0, 40);
  return after.some(
    (s) => (s.kind === "tool" && s.call.result !== null) || (s.kind === "text" && probe !== "" && s.text.includes(probe)),
  );
}
