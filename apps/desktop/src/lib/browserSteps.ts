/**
 * The step log under Claude's browser (item 567, Filament IV stage 10;
 * `f4-browser.png`): the browser calls of the chat's running turn, in
 * order, each as its action in words and what it acts on, the newest
 * last. Read from the turn's own segments — the same calls the reply's
 * activity rows draw — so it is never out of step with them. The calls
 * carry no clock, so a step is numbered, not timed.
 */
import { isPlaywright, playwrightAction } from "./playwright";

export interface BrowserStep {
  id: string;
  /** Its number in the turn's browser calls, from 1. */
  n: number;
  tool: string;
  target: string | null;
  state: "running" | "done" | "failed";
}

interface ToolLike {
  kind: string;
  call?: { id: string; name: string; input: unknown; result: { is_error: boolean } | null; denied?: boolean };
}

/** The turn's browser calls, the last `max` of them, and how many there
 *  were in all. Calls inside a subagent's own turn are not walked: the
 *  browser is the chat's, and a subagent's calls show under its row. */
export function browserSteps(segments: readonly ToolLike[] | null | undefined, max = 3): { steps: BrowserStep[]; total: number } {
  const all: BrowserStep[] = [];
  for (const s of segments ?? []) {
    if (s.kind !== "tool" || !s.call || !isPlaywright(s.call.name)) continue;
    const { tool, target } = playwrightAction(s.call.name, s.call.input);
    const r = s.call.result;
    all.push({
      id: s.call.id,
      n: all.length + 1,
      tool,
      target,
      state: r === null ? "running" : r.is_error || s.call.denied ? "failed" : "done",
    });
  }
  return { steps: all.slice(Math.max(0, all.length - max)), total: all.length };
}

/** Whether a running turn's chat key names `chat`: the chat id itself,
 *  or a longer key that starts with it — `backgroundTurnOf`'s rule. */
export function sameChat(turnKey: string | null | undefined, chat: string | null | undefined): boolean {
  if (!turnKey || !chat) return false;
  return turnKey === chat || turnKey.startsWith(chat);
}
