/**
 * The seconds between his answer to a prompt and the turn showing it (nightshift item 522, 2026-11-09).
 *
 * An answer on the Claude Code engine starts a new CLI process that resumes the deferred call
 * (agent/ask.rs); until that process prints the call's result the window had nothing to show — the card
 * was gone, the call's row still read "running", and on 2026-11-09 that lasted about 25 seconds, which he
 * read as a freeze. This is the line shown in the card's place meanwhile, and what it says when the resume
 * is slow. It never decides anything: the turn's own end or error is what ends the wait.
 */
import { askKind, type AskKind } from "./askReply";

export type Handed = "answered" | "skipped" | "replied" | "allowed" | "denied" | "approved" | "kept-planning";

export interface HandBack {
  /** The call's id. */
  id: string;
  /** The chat it was asked in (`null`: a new chat's first turn). */
  chat: string | null;
  how: Handed;
  /** When he answered, ms. */
  at: number;
}

/** After this long with nothing back, the line says so and offers Stop. */
export const SLOW_MS = 20_000;

export const handBack = $state<{ current: HandBack | null }>({ current: null });

/** What his answer was, in one word, from the card's kind and decision. */
export function handedHow(name: string, decision: "allow" | "always" | "deny", reply: boolean): Handed {
  const kind: AskKind = askKind(name);
  if (reply) return "replied";
  if (kind === "question") return decision === "deny" ? "skipped" : "answered";
  if (kind === "plan") return decision === "deny" ? "kept-planning" : "approved";
  return decision === "deny" ? "denied" : "allowed";
}

/** He answered `id`: the line shows until the turn reports it. */
export function noteAnswered(id: string, chat: string | null, how: Handed, now = Date.now()): void {
  handBack.current = { id, chat, how, at: now };
}

/** The call's result arrived (or its refusal): the wait is over. */
export function answerLanded(id: string): void {
  if (handBack.current?.id === id) handBack.current = null;
}

/** The turn in `chat` ended, or another card came up: nothing is being handed back. */
export function clearHandBack(chat?: string | null): void {
  if (chat === undefined || handBack.current?.chat === chat) handBack.current = null;
}

const SAID: Record<Handed, string> = {
  answered: "Answers sent",
  skipped: "Skipped",
  replied: "Your message was sent in place of an answer",
  allowed: "Allowed",
  denied: "Denied",
  approved: "Plan approved",
  "kept-planning": "Sent back to planning",
};

/** The line, and whether it has been long enough to say so. */
export function handBackLine(h: HandBack, now: number): { text: string; slow: boolean; seconds: number } {
  const ms = Math.max(0, now - h.at);
  const seconds = Math.floor(ms / 1000);
  const slow = ms >= SLOW_MS;
  const text = slow
    ? `${SAID[h.how]} ${seconds} s ago — Claude Code has not picked the turn back up yet. Your answer is saved; it is still starting.`
    : `${SAID[h.how]} — handing the turn back to Claude…`;
  return { text, slow, seconds };
}
