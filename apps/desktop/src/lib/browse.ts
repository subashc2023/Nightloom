/**
 * Browsing while a turn runs (nightshift backlog 159, pass 1, 2026-09-18).
 *
 * The turn runs in the service and needs nothing from the window; what
 * pinned him to the running chat was the front end's assumption that
 * `app.events`, `app.live` and the composer are the *open* chat's, and
 * the backend's one open session, which the turn holds for its whole
 * length (`send_agent` takes `state.session` from its first append to its
 * last — so `open_session` would wait a turn). Pass 1 keeps one live turn
 * and lets him look elsewhere meanwhile:
 *
 * - Opening another chat during a turn **parks** the running chat — its
 *   events, its live stream, its pending kind — and shows the other
 *   chat's log read straight from disk (`peek_session`, a reader that
 *   touches no lock). The stream keeps landing in the parked live state,
 *   so coming back shows the reply where it got to, still streaming.
 * - A message typed into the viewed chat queues *there* (the drafts are
 *   per chat already) with the toast naming the running chat; it goes
 *   when the turn ends, since the turn's end re-aligns the backend to
 *   the chat on screen before the composer drains.
 * - At the turn's end with a chat parked: the running chat's reply is
 *   on disk, the pending chat's draft follows the chat it made, and the
 *   backend is re-opened on the viewed chat (or told New chat). Nothing
 *   the running chat recorded is copied into the view.
 *
 * Not tonight: two live turns (pass 2, blocker 182) and the nine commands
 * that still wait on the lock (pass 3). One honest limit: while the
 * running turn is the *pending* chat's first, New chat is refused — the
 * pending key is one slot per project and kind, and a second pending
 * draft under it would be moved into the chat the running turn makes.
 *
 * The pure half here — what a parked state holds, where a stream event
 * lands, and what the turn's end does — is what the suite pins.
 */
import type { ChatKind, ChatMode, SessionEvent, Usage } from "./types";


/** The running chat, set aside while another is on screen. */
export interface Parked<Segment = unknown> {
  /** The chat the turn runs in; null for the pending chat's first turn. */
  session: string | null;
  pendingMode: ChatMode;
  pendingKind: ChatKind;
  events: SessionEvent[];
  live: { segments: Segment[] } | null;
  liveUsage: Usage | null;
}


/** Where a stream event lands: the parked chat's live state while one is
 *  parked, the open chat's otherwise. */
export function liveHost<L>(app: {
  parked: { live: L; liveUsage: Usage | null } | null;
  live: L;
  liveUsage: Usage | null;
}): { live: L; liveUsage: Usage | null } {
  return app.parked ?? app;
}

/** What the turn's end does to the view and the backend. */
export interface SettlePlan {
  /** Adopt the re-synced events as the view (the chat on screen is the
   *  one that ran). */
  adopt: boolean;
  /** The open chat's id after: the chat the turn made when it ran from
   *  the pending chat and is still on screen, else unchanged. */
  activeSessionId: string | null | undefined;
  /** The pending chat's draft moved to the chat it made. */
  moveDraft: [string, string] | null;
  /** Re-align the backend with what is on screen. */
  realign: { kind: "open"; id: string } | { kind: "new" } | null;
}

/**
 * The plan for a turn's end. `made` is the id off the re-synced log's
 * `session_created` line, `viewed` the chat on screen now, `parked` the
 * running chat if he browsed away, `pendingKey` the draft key the send
 * computed when it ran from the pending chat.
 */
export function settlePlan(args: {
  parked: Parked | null;
  viewed: string | null;
  made: string | null;
  pendingKey: string | null;
}): SettlePlan {
  const { parked, viewed, made, pendingKey } = args;
  if (!parked) {
    const fromPending = made !== null && pendingKey !== null && viewed === null;
    return {
      adopt: true,
      activeSessionId: made ?? undefined,
      moveDraft: fromPending ? [pendingKey, made] : null,
      realign: null,
    };
  }
  return {
    adopt: false,
    activeSessionId: undefined,
    moveDraft: parked.session === null && made !== null && pendingKey !== null ? [pendingKey, made] : null,
    realign: viewed !== null ? { kind: "open", id: viewed } : { kind: "new" },
  };
}

/** The toast for a message queued in a chat that is not the running one. */
export function queuedElsewhereToast(runningName: string): string {
  return `A turn is running in ${runningName} — this sends when that ends`;
}
