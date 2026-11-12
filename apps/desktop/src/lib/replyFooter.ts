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
  // Signed out (backlog 409): the notice above says so and offers Sign in.
  if (isSignedOut(stopReason)) return "stopped · Claude Code is signed out";
  if (stopReason.startsWith("error: ")) return `stopped · ${stopReason.slice(7)}`;
  if (stopReason.startsWith("cut off: ")) return `cut off · ${stopReason.slice(9)}`;
  // Stopped before a word arrived (backlog 361): the reply the service
  // records so his message is not left with nothing under it.
  if (stopReason === "stopped") return "stopped before a reply";
  return null;
}

/** The footer's stop note for a reply that may be Nightloom's stand-in
 *  (item 665): none when it is, since the stand-in's notice already says
 *  the same reason in full — "No reply: API Error …" drew twice, the notice
 *  and a red "stopped · API Error …" under it. The notice is the clearer of
 *  the two (whole sentence, wrapped, under the "Nightloom" header), so it
 *  is the one kept, for every stand-in: an error, a stop before a reply,
 *  and signed out (its own notice with Sign in). */
export function footerStopNote(stopReason: string | null | undefined, standIn: boolean): string | null {
  return standIn ? null : stopNote(stopReason);
}

/** The service's words for a turn that ended before the model said
 *  anything (backlog 361; `nightloom_core::STOPPED_BEFORE_REPLY` and
 *  `NO_REPLY_PREFIX`) — Nightloom's, not the model's. */
export const STOPPED_BEFORE_REPLY = "Stopped before any reply arrived.";
export const NO_REPLY_PREFIX = "No reply: ";

/** Whether a reply is that stand-in (backlog 407): one text block reading
 *  so, ended stopped or by an error. Drawn as Nightloom's notice, never as
 *  model prose. Mirrors `is_unanswered_stand_in` in nightloom-core. */
export function isStandIn(texts: string[], stopReason: string | null | undefined): boolean {
  if (texts.length !== 1) return false;
  const t = texts[0];
  const says = t === STOPPED_BEFORE_REPLY || t.startsWith(NO_REPLY_PREFIX);
  const ended = stopReason === "stopped" || !!stopReason?.startsWith("error: ");
  return says && ended;
}

/** The stop reason the service writes for a turn Claude Code refused
 *  because it is signed out (backlog 409; `nightloom_core::SIGNED_OUT_REASON`),
 *  before the CLI's own sentence. */
export const SIGNED_OUT_REASON = "error: signed out: ";

/** Whether a reply's turn ended on Claude Code's sign-in (backlog 409) —
 *  the service's mark, read from its stop reason, never the CLI's words. */
export function isSignedOut(stopReason: string | null | undefined): boolean {
  return !!stopReason?.startsWith(SIGNED_OUT_REASON);
}

/** The CLI's own sentence behind a signed-out stop, for the notice's detail. */
export function signedOutDetail(stopReason: string | null | undefined): string {
  return isSignedOut(stopReason) ? stopReason!.slice(SIGNED_OUT_REASON.length) : "";
}
