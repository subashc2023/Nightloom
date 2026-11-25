/**
 * Item 972: after a launch (or a project's tabs coming back) every restored
 * tab's chat is offered to keep-warm from its last reply, not only the shown
 * one — a chat in a background tab had no run after a restart and was never
 * pinged. The backend answers how many chats still lack a connection to
 * ping on (the rail connects a moment after the tabs return); those are
 * offered again a few times, then left to `keep_warm_status` when shown.
 */
import * as api from "./api";
import type { Workspace } from "./tabs";
import { allTabs } from "./tabs";

/** Seconds between tries after the first. */
export const OFFER_RETRY_MS = [4000, 12000, 40000];

/** The chats the workspace's tabs show, once each. */
export function restoredChats(ws: Workspace): string[] {
  const out: string[] = [];
  for (const t of allTabs(ws)) if (t.content.kind === "chat" && t.content.session && !out.includes(t.content.session)) out.push(t.content.session);
  return out;
}

export async function offerRestoredKeepWarm(chats: string[], retry: readonly number[] = OFFER_RETRY_MS): Promise<void> {
  if (chats.length === 0) return;
  let waiting = 0;
  try {
    waiting = await api.keepWarmOfferRestored(chats);
  } catch {
    return;
  }
  if (waiting > 0 && retry.length > 0) setTimeout(() => void offerRestoredKeepWarm(chats, retry.slice(1)), retry[0]);
}
