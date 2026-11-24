/**
 * An aside's approval cards (nightshift item 919, his bug 2026-11-23): a
 * call an aside makes that the chat would ask about waits in the aside's
 * hook, and the app says so with `aside-ask` (`{seq, call, reason}`, the
 * call `null` once it is answered or gone). The card is the chat's own
 * (`ApprovalPrompt`, `PlaywrightCard`), drawn in the aside's transcript;
 * its answer goes to the aside alone (`answer_aside_ask`), so approving in
 * the aside approves nothing in the chat.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { ApprovalDecision, ApprovalRequest } from "./types";

interface AsideAskEvent {
  seq: number;
  call: { id: string; name: string; input?: unknown } | null;
  reason?: string | null;
}

/** The card each asking aside waits on, by its `seq`. */
export const asideAsks = $state({ bySeq: {} as Record<number, ApprovalRequest> });

const NONE: ApprovalRequest[] = [];

/** The cards for the aside exchange `seq` (none, or one). */
export function asideApprovals(seq: number | undefined): ApprovalRequest[] {
  if (seq === undefined) return NONE;
  const r = asideAsks.bySeq[seq];
  return r ? [r] : NONE;
}

/** An `aside-ask` taken in. */
export function applyAsideAsk(e: AsideAskEvent): void {
  const next = { ...asideAsks.bySeq };
  if (e.call) {
    next[e.seq] = {
      id: e.call.id,
      name: e.call.name,
      input: e.call.input ?? {},
      effect: "mutating",
      aside: e.seq,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  } else delete next[e.seq];
  asideAsks.bySeq = next;
}

/**
 * His answer on an aside's card; `false` when `id` is no aside's card (the
 * chat's own then answers it). "Allow for this chat" and "Not now" are not
 * offered on an aside's card; were one sent, it is an Allow once / a Deny.
 */
export async function resolveAsideApproval(id: string, decision: ApprovalDecision, reason?: string): Promise<boolean> {
  const req = Object.values(asideAsks.bySeq).find((r) => r.id === id);
  if (!req || req.aside === undefined) return false;
  const seq = req.aside;
  const next = { ...asideAsks.bySeq };
  delete next[seq];
  asideAsks.bySeq = next;
  const word = decision === "allow" || decision === "always" ? "allow" : "deny";
  try {
    await api.answerAsideAsk(seq, id, word, word === "deny" ? reason : undefined);
  } catch {
    // The aside ended under the card: its hook was answered with a refusal.
  }
  return true;
}

let started = false;

/** Listen to `aside-ask`; every caller after the first is a no-op. */
export async function startAsideAsks(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await listen<AsideAskEvent>("aside-ask", (e) => applyAsideAsk(e.payload));
  } catch {
    // Outside the app (the suite): no events.
  }
}
